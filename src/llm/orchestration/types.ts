/** Tipos de tarefa usados para escolher o modelo (spec llm-orchestration RF-04). */
export const TASKS = ['conversa', 'raciocinio', 'codigo', 'visao', 'pesquisa', 'resumo', 'roteamento'] as const;
export type Task = (typeof TASKS)[number];

/**
 * Nível de privacidade (RF-09):
 * - publico: pode usar modelos gratuitos que treinam com os dados;
 * - pessoal: só fontes sem treino declarado ou modelos locais;
 * - local: só modelos rodando nesta máquina.
 */
export type PrivacyLevel = 'publico' | 'pessoal' | 'local';

export type FreeSourceId = 'opencode' | 'openrouter' | 'nvidia' | 'gemini' | 'groq' | 'ollama' | 'ollama-cloud';

/** Um modelo gratuito candidato, com o que se sabe sobre ele. */
export interface ModelCandidate {
  source: FreeSourceId;
  modelId: string;
  name: string;
  /** Roda nesta máquina (Ollama local), sem cota e sem enviar dados para fora. */
  local: boolean;
  toolCall: boolean;
  vision: boolean;
  /** Janela de contexto em tokens (0 = desconhecida). */
  context: number;
  /** A fonte pode usar os dados para treino (planos gratuitos de terceiros). */
  trainsOnData: boolean;
  releaseDate?: string;
  reasoning?: boolean;
  /** Modelos locais: bilhões de parâmetros e se cabem inteiros na VRAM da GPU. */
  paramsB?: number;
  gpuFit?: boolean;
  /** Regra que classificou o modelo como gratuito (transparência). */
  freeRule: string;
}

export interface Requirements {
  tools: boolean;
  vision: boolean;
  /** Contexto mínimo estimado em tokens. */
  minContext: number;
}

export const modelKey = (candidate: Pick<ModelCandidate, 'source' | 'modelId'>): string =>
  `${candidate.source}/${candidate.modelId}`;
