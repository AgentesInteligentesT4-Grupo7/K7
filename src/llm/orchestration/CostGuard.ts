import { UserFacingError } from '../../errors/AppErrors.js';
import { type ModelCandidate, modelKey } from './types.js';

/** Provedores de assinatura que aparecem com "custo zero" no catálogo, mas são pagos (NG-01). */
const SUBSCRIPTION_PROVIDER = /(coding|token)-plan|gitlab/i;

export class CostPolicyError extends UserFacingError {
  constructor(model: string, reason: string) {
    super(`Bloqueado pela política free-only: ${model} (${reason}).`, `CostGuard bloqueou ${model}: ${reason}`);
  }
}

/**
 * Trava de custo (spec llm-orchestration RF-02): só passam modelos que o catálogo classificou
 * como gratuitos pelas regras das fontes permitidas. Verificada antes de toda chamada.
 */
export class CostGuard {
  constructor(private readonly allowedSources: ReadonlySet<string>) {}

  assertFree(candidate: ModelCandidate): void {
    const key = modelKey(candidate);
    if (!this.allowedSources.has(candidate.source)) throw new CostPolicyError(key, 'fonte fora da lista FREE_SOURCES');
    if (SUBSCRIPTION_PROVIDER.test(candidate.source)) throw new CostPolicyError(key, 'plano de assinatura');
    if (!candidate.freeRule) throw new CostPolicyError(key, 'sem regra de gratuidade');
  }
}
