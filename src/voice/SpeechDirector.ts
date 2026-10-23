import { errorMessage } from '../errors/AppErrors.js';
import { TaskContext } from '../llm/orchestration/TaskContext.js';
import type { ILlmProvider } from '../llm/types.js';
import { Logger } from '../utils/Logger.js';
import { DIRECTION_TAGS, parseDirection, stripDirection } from './SpeechDirection.js';

/**
 * Diretor de locução (VOICE_CLONE_DIRECTION=auto): o LLM local lê o texto e marca onde acelerar,
 * desacelerar, mudar o tom e pausar, como uma pessoa falaria aquilo. Ele só pode inserir marcações:
 * se mudar, tirar ou acrescentar qualquer palavra, o roteiro é descartado e a fala sai sem direção,
 * para a voz clonada nunca dizer o que não foi escrito.
 */

const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(' ');

const PROMPT = (text: string) =>
  [
    'Você é diretor de locução. Marque o texto abaixo para ser lido em voz alta de forma natural, como uma pessoa de verdade falaria:',
    'acelera no que é empolgado ou corriqueiro, desacelera no que é sério ou importante, pausa antes de mudar de assunto ou depois de chamar alguém.',
    `Use somente estas marcações, entre parênteses: ${DIRECTION_TAGS.join(' ')}.`,
    'Um tom vale até o próximo tom; para combinar, escreva junto: (rápido, animado). Use poucas marcações, só onde o jeito de falar muda.',
    'NÃO mude, não tire e não acrescente nenhuma palavra do texto: só insira as marcações. Responda só com o texto marcado, sem comentários.',
    '',
    'Exemplo:',
    'Texto: Que notícia boa, conseguimos. Pessoal! Agora falta resolver o contrato... a gente precisa ver isso hoje.',
    'Marcado: (rápido, animado) Que notícia boa, conseguimos. (pausa) Pessoal! (pausa) (sério) Agora falta resolver o contrato... (devagar) a gente precisa ver isso hoje.',
    '',
    `Texto: ${text}`,
    'Marcado:',
  ].join('\n');

const MAX_CHARS = 1500;
const CACHE_SIZE = 20;

export class SpeechDirector {
  private readonly logger = new Logger('VoiceClone');
  /** O mesmo texto recebe a mesma direção (o /ajustar refaz sobre o mesmo roteiro). */
  private readonly cache = new Map<string, string>();

  constructor(private readonly llm: ILlmProvider) {}

  /** Texto com as marcações; devolve o próprio texto quando não há o que dirigir ou o LLM falha. */
  async direct(text: string): Promise<string> {
    const cached = this.cache.get(text);
    if (cached) return cached;
    if (text.length > MAX_CHARS || words(text).split(' ').length < 4) return text;
    try {
      const started = Date.now();
      const userId = TaskContext.current()?.userId ?? 'voz-clonada';
      const response = await TaskContext.run({ task: 'conversa', privacy: 'local', userId }, () =>
        this.llm.chat({ messages: [{ role: 'user', content: PROMPT(text) }], temperature: 0.4 }),
      );
      const script = (response.content ?? '').trim().replace(/^marcado:\s*/i, '').replace(/^["'«“]+|["'»”]+$/g, '');
      if (!parseDirection(script).directed) return text;
      if (words(stripDirection(script)) !== words(text)) {
        this.logger.warn('Direção da fala descartada: o modelo mudou palavras do texto');
        return text;
      }
      this.logger.info(`🎬 Direção da fala pelo modelo local (${Date.now() - started}ms)`);
      this.cache.set(text, script);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      return script;
    } catch (error) {
      this.logger.warn(`Sem direção da fala (modelo local não respondeu): ${errorMessage(error).slice(0, 120)}`);
      return text;
    }
  }
}
