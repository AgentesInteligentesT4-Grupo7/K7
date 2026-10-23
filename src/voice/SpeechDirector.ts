import { errorMessage } from '../errors/AppErrors.js';
import { TaskContext } from '../llm/orchestration/TaskContext.js';
import type { ILlmProvider } from '../llm/types.js';
import { Logger } from '../utils/Logger.js';
import { type VoiceParams, clampParam } from './VoiceParams.js';
import { EFFECT_TAGS, PAUSE_TAGS, TONE_TAGS, keepWrittenTones, parseDirection, stripDirection } from './SpeechDirection.js';

/**
 * Diretor de locução (VOICE_CLONE_DIRECTION=auto): o LLM local lê o texto (e o contexto de quem fala) e marca
 * onde acelerar, desacelerar, mudar o tom, pausar e, se a situação pedir, tossir ou rir. Ele só pode inserir
 * marcações: se mudar, tirar ou acrescentar qualquer palavra, o roteiro é descartado e a fala sai como foi escrita,
 * para a voz clonada nunca dizer o que não foi escrito. Tom escrito pela pessoa vence o do diretor.
 */

const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(' ');

const PROMPT = (text: string, context?: string) =>
  [
    'Você é diretor de locução. Marque o texto abaixo para ser lido em voz alta de forma natural, como uma pessoa de verdade falaria:',
    'acelera no que é empolgado ou corriqueiro, desacelera no que é sério ou importante, pausa antes de mudar de assunto ou depois de chamar alguém.',
    `Marcações, sempre entre parênteses. Tons: ${TONE_TAGS.join(' ')}, ou um tom descrito, como (voz de quem acabou de acordar).`,
    `Pausas: ${PAUSE_TAGS.join(' ')}. Efeitos: ${EFFECT_TAGS.join(' ')}.`,
    'Um tom vale até o próximo; para combinar, escreva junto: (rápido, animado). Use poucas marcações, só onde o jeito de falar muda.',
    'Efeitos só quando o contexto ou o texto pedirem (doente tosse, gripado espirra, quem conta piada ri), no máximo dois.',
    'Se o texto já tiver um tom escrito, mantenha-o no mesmo lugar e não acrescente outros tons: só pausas e efeitos.',
    'NÃO mude, não tire e não acrescente nenhuma palavra do texto: só insira as marcações. Responda só com o texto marcado, sem comentários.',
    '',
    'Exemplo:',
    'Texto: Que notícia boa, conseguimos. Pessoal! Agora falta resolver o contrato... a gente precisa ver isso hoje.',
    'Marcado: (rápido, animado) Que notícia boa, conseguimos. (pausa) Pessoal! (pausa) (sério) Agora falta resolver o contrato... (devagar) a gente precisa ver isso hoje.',
    '',
    'Exemplo com contexto (está gripado, de cama):',
    'Texto: Oi, tudo bem? Hoje eu não vou conseguir ir, acordei muito mal. Desculpa, viu.',
    'Marcado: (doente) Oi, tudo bem? (pausa curta) Hoje eu não vou conseguir ir... (tosse) acordei muito mal. (pausa) (devagar) Desculpa, viu.',
    '',
    ...(context ? [`Contexto de quem fala: ${context}. Deixe o jeito de falar coerente com essa situação.`] : []),
    `Texto: ${text}`,
    'Marcado:',
  ].join('\n');

const TONE_PROMPT = (description: string) =>
  [
    `Converta este jeito de falar em parâmetros de um sintetizador de voz: "${description}".`,
    'Responda só com JSON: {"emocao": 0.3 a 1.3 (0.5 neutro; alto = expressivo, empolgado, bravo),',
    '"velocidade": 0.8 a 1.25 (1 normal; alto = rápido, apressado, eufórico; baixo = cansado, triste, doente),',
    '"ritmo": 0.35 a 0.7 (0.5 normal; baixo = cadenciado), "variacao": 0.6 a 1.1 (0.8 normal)}.',
    'Exemplos: comemorando uma vitória {"emocao":1.2,"velocidade":1.15,"ritmo":0.45,"variacao":0.9};',
    'doente, sem energia {"emocao":0.3,"velocidade":0.9,"ritmo":0.45,"variacao":0.8};',
    'bravo, dando bronca {"emocao":1.1,"velocidade":1.05,"ritmo":0.5,"variacao":0.8};',
    'contando um segredo {"emocao":0.4,"velocidade":0.92,"ritmo":0.45,"variacao":0.7}.',
  ].join('\n');

/** Faixa segura do tom descrito: fora dela o Chatterbox fica instável ou estica a fala. */
const TONE_LIMITS = { exaggeration: [0.3, 1.3], speedFactor: [0.8, 1.25], cfgWeight: [0.35, 0.7], temperature: [0.6, 1.1] } as const;

const MAX_CHARS = 1500;
const CACHE_SIZE = 20;

export class SpeechDirector {
  private readonly logger = new Logger('VoiceClone');
  /** O mesmo texto recebe a mesma direção (o /ajustar refaz sobre o mesmo roteiro). */
  private readonly cache = new Map<string, string>();
  private readonly tones = new Map<string, Omit<VoiceParams, 'seed'>>();

  constructor(private readonly llm: ILlmProvider) {}

  /** Texto com as marcações; devolve o próprio texto quando não há o que dirigir ou o LLM falha. */
  async direct(text: string, context?: string): Promise<string> {
    const key = `${context ?? ''}\n${text}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (text.length > MAX_CHARS || words(stripDirection(text)).split(' ').length < 4) return text;
    // Duas tentativas: de vez em quando o modelo troca uma palavra, e na seguinte acerta.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const started = Date.now();
        const response = await this.ask(PROMPT(text, context), 0.4);
        const script = response.trim().replace(/^marcado:\s*/i, '').replace(/^["'«“]+|["'»”]+$/g, '');
        if (!parseDirection(script).directed) return text;
        if (words(stripDirection(script)) !== words(stripDirection(text))) {
          this.logger.warn('Direção da fala descartada: o modelo mudou palavras do texto');
          continue;
        }
        const final = keepWrittenTones(text, script);
        this.logger.info(`🎬 Direção da fala pelo modelo local (${Date.now() - started}ms)`);
        this.remember(this.cache, key, final);
        return final;
      } catch (error) {
        this.logger.warn(`Sem direção da fala (modelo local não respondeu): ${errorMessage(error).slice(0, 120)}`);
        return text;
      }
    }
    return text;
  }

  /** Parâmetros de voz para um tom descrito à vontade ("voz de quem acabou de acordar"); `{}` se não der. */
  async tone(description: string): Promise<Omit<VoiceParams, 'seed'>> {
    const cached = this.tones.get(description);
    if (cached) return cached;
    try {
      const raw = await this.ask(TONE_PROMPT(description), 0.2);
      const json = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '{}') as Record<string, unknown>;
      const params: Omit<VoiceParams, 'seed'> = {};
      const set = (key: keyof typeof TONE_LIMITS, value: unknown) => {
        const n = Number(value);
        const [min, max] = TONE_LIMITS[key];
        if (value !== undefined && Number.isFinite(n)) params[key] = clampParam(key, Math.min(max, Math.max(min, n)));
      };
      set('exaggeration', json.emocao);
      set('speedFactor', json.velocidade);
      set('cfgWeight', json.ritmo);
      set('temperature', json.variacao);
      this.logger.info(`🎭 Tom "${description}" → ${JSON.stringify(params)}`);
      this.remember(this.tones, description, params);
      return params;
    } catch (error) {
      this.logger.warn(`Não consegui interpretar o tom "${description}": ${errorMessage(error).slice(0, 120)}`);
      return {};
    }
  }

  private async ask(content: string, temperature: number): Promise<string> {
    const userId = TaskContext.current()?.userId ?? 'voz-clonada';
    const response = await TaskContext.run({ task: 'conversa', privacy: 'local', userId }, () =>
      this.llm.chat({ messages: [{ role: 'user', content }], temperature }),
    );
    return response.content ?? '';
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.set(key, value);
    if (map.size > CACHE_SIZE) map.delete(map.keys().next().value!);
  }
}
