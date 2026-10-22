import { errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';

/** Para que serve o texto: alguns provedores (Gemini) geram vetores melhores sabendo isso. */
export type EmbedPurpose = 'documento' | 'consulta';

export interface IEmbeddings {
  readonly name: string;
  readonly model: string;
  /** Lote máximo por chamada. */
  readonly batchSize: number;
  embed(texts: string[], purpose: EmbedPurpose): Promise<Float32Array[]>;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

/** Ollama local (`/api/embed`). Modelo padrão: embeddinggemma (multilíngue, ~600 MB). */
export class OllamaEmbeddings implements IEmbeddings {
  readonly name = 'ollama';
  readonly batchSize = 32;

  constructor(
    private readonly baseUrl: string,
    readonly model: string,
    private readonly timeoutMs = 120_000,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const data = (await postJson(`${this.baseUrl}/api/embed`, { model: this.model, input: texts }, {}, this.timeoutMs)) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('resposta do Ollama sem embeddings');
    return data.embeddings.map((v) => Float32Array.from(v));
  }

  /** O modelo está baixado? (não baixa nada: só consulta /api/tags). */
  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return false;
      const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
      return (data.models ?? []).some((m) => [m.name, m.model].includes(wanted) || [m.name, m.model].includes(this.model));
    } catch {
      return false;
    }
  }
}

/** Gemini (`batchEmbedContents`). A cota gratuita é pequena: lotes de até 100 e falha vira busca só por palavras. */
export class GeminiEmbeddings implements IEmbeddings {
  readonly name = 'gemini';
  readonly batchSize = 100;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly dimensions = 768,
    private readonly timeoutMs = 60_000,
  ) {}

  async embed(texts: string[], purpose: EmbedPurpose): Promise<Float32Array[]> {
    const model = `models/${this.model}`;
    const data = (await postJson(
      `https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents`,
      {
        requests: texts.map((text) => ({
          model,
          content: { parts: [{ text }] },
          taskType: purpose === 'consulta' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          outputDimensionality: this.dimensions,
        })),
      },
      { 'x-goog-api-key': this.apiKey },
      this.timeoutMs,
    )) as { embeddings?: Array<{ values?: number[] }> };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('resposta do Gemini sem embeddings');
    return data.embeddings.map((e) => Float32Array.from(e.values ?? []));
  }
}

export type EmbeddingsChoice = 'auto' | 'ollama' | 'gemini' | 'off';

export interface EmbeddingsSelection {
  choice: EmbeddingsChoice;
  ollama?: OllamaEmbeddings;
  gemini?: GeminiEmbeddings;
  /** "auto" só usa o Ollama com GPU NVIDIA (sem ela, embeddings na CPU deixam a indexação lenta). */
  hasGpu: () => Promise<boolean>;
}

const logger = new Logger('Conhecimento');

/**
 * Escolhe o provedor de embeddings (spec knowledge-base §5.3):
 * auto = Ollama local se houver GPU e o modelo estiver baixado → Gemini se houver chave → nenhum (só palavras).
 * Nada é baixado aqui; quando falta o modelo, o log diz o comando.
 */
export async function selectEmbeddings(selection: EmbeddingsSelection): Promise<IEmbeddings | undefined> {
  const { choice, ollama, gemini } = selection;
  if (choice === 'off') return undefined;
  if (choice === 'gemini') return gemini;
  if (ollama && (choice === 'ollama' || (await selection.hasGpu()))) {
    if (await ollama.available()) return ollama;
    logger.warn(`Modelo de embeddings "${ollama.model}" não está no Ollama (baixe com: ollama pull ${ollama.model})`);
    if (choice === 'ollama') return undefined;
  }
  return choice === 'auto' ? gemini : undefined;
}

export function describeEmbeddingsError(provider: IEmbeddings, error: unknown): string {
  const message = errorMessage(error);
  return /429|quota|RESOURCE_EXHAUSTED/i.test(message)
    ? `cota de embeddings do ${provider.name} esgotada; o restante fica só na busca por palavras`
    : `embeddings do ${provider.name} falharam (${message.slice(0, 160)})`;
}
