import type { CostGuard } from './CostGuard.js';
import type { ModelCatalog } from './ModelCatalog.js';
import type { ScoreStore } from './ScoreStore.js';
import { type ModelCandidate, type PrivacyLevel, type Requirements, type Task, modelKey } from './types.js';

export interface RankedModel {
  candidate: ModelCandidate;
  score: number;
  /** Nota de qualidade antes dos ajustes de uso (para exibição). */
  quality: number;
  measured: boolean;
  cooldownUntil?: number;
  latencyMs: number | null;
}

const MONTH = 30 * 24 * 3600_000;

/**
 * Ordena os modelos gratuitos para uma tarefa (RF-05, RF-06):
 * 1. filtra por requisitos (tools, visão, contexto), privacidade e trava de custo;
 * 2. nota = avaliação medida (npm run eval) quando houver, senão estimativa pelos metadados;
 * 3. ajusta pela taxa de sucesso real e pelo feedback 👍/👎;
 * 4. empate → modelo local primeiro (privado e sem cota). Ou seja: a GPU só é preferida
 *    quando o modelo local é tão bom quanto o melhor gratuito da nuvem.
 */
export class ModelRanker {
  constructor(
    private readonly catalog: ModelCatalog,
    private readonly scores: ScoreStore,
    private readonly guard: CostGuard,
  ) {}

  rank(task: Task, privacy: PrivacyLevel, requirements: Requirements, options: { includeCooling?: boolean } = {}): RankedModel[] {
    const ranked: RankedModel[] = [];
    for (const candidate of this.catalog.list()) {
      if (!ModelRanker.meets(candidate, requirements, privacy)) continue;
      try {
        this.guard.assertFree(candidate);
      } catch {
        continue;
      }
      const key = modelKey(candidate);
      const cooldown = this.scores.cooldown(key);
      if (cooldown && !options.includeCooling) continue;

      const stats = this.scores.get(task, key);
      const prior = ModelRanker.prior(candidate, task);
      const measured = stats.evalScore !== null && stats.evalSamples >= 3;
      // Medido vence estimado: com avaliação, a nota é só a medição (empate real → local, no sort).
      const quality = measured ? stats.evalScore! : prior;
      const attempts = stats.successes + stats.failures;
      const reliability = attempts >= 3 ? 0.6 + 0.4 * (stats.successes / attempts) : 1;
      let score = quality * reliability + Math.max(-0.2, Math.min(0.2, stats.feedback * 0.04));
      // No roteamento (passo zero), velocidade importa mais que profundidade.
      if (task === 'roteamento' && stats.latencyMs !== null) score -= Math.min(0.3, stats.latencyMs / 20_000);
      ranked.push({ candidate, score, quality, measured, cooldownUntil: cooldown?.until, latencyMs: stats.latencyMs });
    }

    return ranked.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.candidate.local) - Number(a.candidate.local) ||
        (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
    );
  }

  static meets(candidate: ModelCandidate, req: Requirements, privacy: PrivacyLevel): boolean {
    if (req.tools && !candidate.toolCall) return false;
    if (req.vision && !candidate.vision) return false;
    if (candidate.context > 0 && candidate.context < req.minContext) return false;
    if (privacy === 'local' && !candidate.local) return false;
    if (privacy === 'pessoal' && candidate.trainsOnData) return false;
    return true;
  }

  /**
   * Estimativa de qualidade (0–1) antes de qualquer medição. Deliberadamente simples:
   * serve só para a primeira ordenação; `npm run eval` e o uso real corrigem.
   */
  static prior(candidate: ModelCandidate, task: Task): number {
    const id = candidate.modelId.toLowerCase();
    let score: number;
    if (candidate.local) {
      // Modelos locais: escala com o tamanho (7B ≈ 0,45; 14B ≈ 0,55; 32B ≈ 0,66; 70B ≈ 0,75).
      const params = candidate.paramsB ?? 7;
      score = 0.45 + 0.1 * Math.log2(Math.max(params, 0.5) / 7);
      if (candidate.gpuFit === false) score -= 0.15; // não cabe na VRAM: roda lento na CPU
    } else {
      const params = candidate.paramsB ?? ModelRanker.paramsFromName(id);
      // Teto de 0,85: entre modelos grandes, quem decide a ordem é a medição, não o tamanho.
      score = params ? Math.min(0.85, 0.45 + 0.1 * Math.log2(Math.max(params, 0.5) / 7)) : 0.7;
      if (/(flash|mini|lite|tiny|nano|small|fast|lightning)/.test(id)) score -= 0.06;
      if (/(pro|max|ultra|plus|large|405b|1t)/.test(id)) score += 0.04;
      if (/(preview|alpha|beta|experimental)/.test(id)) score -= 0.03;
      if (candidate.releaseDate && Date.now() - Date.parse(candidate.releaseDate) < 6 * MONTH) score += 0.03;
    }
    if (task === 'codigo' && /coder|code|devstral|codestral/.test(id)) score += 0.08;
    if ((task === 'raciocinio' || task === 'codigo') && candidate.reasoning) score += 0.03;
    if (task === 'visao' && candidate.vision) score += 0.02;
    if (/\b(base)\b|-base$|:.*-base/.test(id)) score -= 0.25; // modelos "base" não seguem instruções
    return Math.max(0.05, Math.min(0.95, score));
  }

  /** "llama-3.3-70b" → 70; "qwen3-235b-a22b" → 235. */
  static paramsFromName(id: string): number | undefined {
    const match = /(\d+(?:\.\d+)?)\s*([bt])(?![a-z])/.exec(id);
    if (!match) return undefined;
    return Number(match[1]) * (match[2] === 't' ? 1000 : 1);
  }
}
