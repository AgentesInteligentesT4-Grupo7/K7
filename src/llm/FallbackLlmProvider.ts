import { AllProvidersFailedError, errorMessage } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';
import type { ILlmProvider, LlmRequest, LlmResponse } from './types.js';

/**
 * Encadeia providers: tenta o principal e, em caso de falha (503, 429, rede,
 * auth...), passa para o próximo. Se todos falharem, lança erro amigável
 * em vez de derrubar a engine (PRD — Fluxo Alternativo A).
 */
export class FallbackLlmProvider implements ILlmProvider {
  private readonly logger = new Logger('LLM');

  constructor(private readonly chain: ILlmProvider[]) {
    if (chain.length === 0) throw new Error('FallbackLlmProvider precisa de pelo menos um provider');
  }

  get name(): string {
    return this.chain[0]!.name;
  }

  get model(): string {
    return this.chain[0]!.model;
  }

  get providerNames(): string[] {
    return this.chain.map((provider) => provider.name);
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    let lastError: unknown;
    for (const [index, provider] of this.chain.entries()) {
      try {
        if (index > 0) this.logger.warn(`↪ Tentando fallback: ${provider.name} (${provider.model})`);
        return await provider.chat(request);
      } catch (error) {
        lastError = error;
        this.logger.error(`Provider ${provider.name} falhou: ${errorMessage(error)}`);
      }
    }
    throw new AllProvidersFailedError(this.providerNames, lastError);
  }

  async healthCheck(): Promise<void> {
    await this.chain[0]!.healthCheck();
  }

  /** Checa todos os providers da cadeia individualmente (usado no startup). */
  async healthCheckAll(): Promise<Array<{ name: string; ok: boolean; error?: unknown }>> {
    return Promise.all(
      this.chain.map(async (provider) => {
        try {
          await provider.healthCheck();
          return { name: provider.name, ok: true };
        } catch (error) {
          return { name: provider.name, ok: false, error };
        }
      }),
    );
  }
}
