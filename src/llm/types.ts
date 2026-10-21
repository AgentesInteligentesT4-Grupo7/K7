export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Argumentos crus em JSON, exatamente como o LLM enviou (podem estar malformados). */
  arguments: string;
  /** Campos específicos do provider que precisam ser devolvidos (ex.: thought_signature do Gemini). */
  extraContent?: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Nome da ferramenta (mensagens role=tool). */
  name?: string;
}

/** JSON Schema simplificado aceito nas definições de ferramentas. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason?: string;
  providerName: string;
  model: string;
}

/** Contrato comum a todos os "cérebros" (Strategy). */
export interface ILlmProvider {
  readonly name: string;
  readonly model: string;
  chat(request: LlmRequest): Promise<LlmResponse>;
  /** Valida conectividade/credenciais. Lança `LlmProviderError` em falha. */
  healthCheck(): Promise<void>;
}
