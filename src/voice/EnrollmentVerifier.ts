import { UserFacingError, errorMessage } from '../errors/AppErrors.js';
import { TaskContext } from '../llm/orchestration/TaskContext.js';
import type { ILlmProvider } from '../llm/types.js';
import { Logger } from '../utils/Logger.js';

/**
 * Prova de que a voz cadastrada é de quem está cadastrando (VOICE_CLONE_VERIFY_TEXT): o LLM local escreve um
 * texto novo a cada cadastro, a pessoa grava lendo esse texto e a transcrição precisa bater com ele. Um áudio
 * pronto de outra pessoa (encaminhado do WhatsApp, baixado da internet) não traz essas frases.
 */

const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const PROMPT =
  'Escreva um texto curto e inédito em português do Brasil para alguém ler em voz alta num teste de gravação: ' +
  'duas ou três frases simples sobre o dia a dia (natureza, comida, cidade, viagem), entre 35 e 50 palavras no total. ' +
  'Sem nomes próprios, números, siglas, palavras estrangeiras ou palavras difíceis de pronunciar. ' +
  'Responda só com o texto, sem aspas e sem comentários.';

export interface VerificationResult {
  ok: boolean;
  /** Parte do texto pedido que foi lida, na ordem (0–1). */
  match: number;
}

export class EnrollmentVerifier {
  private readonly logger = new Logger('VoiceClone');

  /**
   * @param minMatch parte mínima do texto que precisa ser lida (VOICE_CLONE_VERIFY_MIN, padrão 0,6):
   *                 falhas da transcrição e trechos pulados não reprovam quem leu de verdade.
   */
  constructor(
    private readonly llm: ILlmProvider,
    private readonly minMatch = 0.6,
  ) {}

  /** Texto novo para ler, escrito pelo LLM local (privacidade "local": nada sai da máquina). */
  async challenge(userId: string): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await TaskContext.run({ task: 'conversa', privacy: 'local', userId }, () =>
          this.llm.chat({ messages: [{ role: 'user', content: PROMPT }], temperature: 1 }),
        );
        const text = (response.content ?? '').trim().replace(/^["'«“]+|["'»”]+$/g, '').replace(/\s+/g, ' ');
        const count = words(text).length;
        if (count >= 20 && count <= 80) return text;
        this.logger.warn(`Texto de cadastro com ${count} palavras; pedindo outro`);
      } catch (error) {
        this.logger.warn(`Não consegui gerar o texto de cadastro: ${errorMessage(error).slice(0, 120)}`);
      }
    }
    throw new UserFacingError('Não consegui gerar o texto para você ler agora (o modelo local não respondeu). Tente /minhavoz de novo em instantes.');
  }

  /** Quanto do texto pedido aparece na transcrição, na mesma ordem (maior subsequência comum de palavras). */
  check(expected: string, transcript: string): VerificationResult {
    const want = words(expected);
    const got = words(transcript);
    if (!want.length || !got.length) return { ok: false, match: 0 };
    let previous = new Array<number>(got.length + 1).fill(0);
    for (const w of want) {
      const current = [0];
      for (let j = 1; j <= got.length; j++) current[j] = w === got[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
      previous = current;
    }
    const match = previous[got.length]! / want.length;
    return { ok: match >= this.minMatch, match };
  }
}
