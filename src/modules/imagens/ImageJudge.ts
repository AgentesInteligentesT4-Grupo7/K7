import { errorMessage } from '../../errors/AppErrors.js';
import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { ILlmProvider, ImagePart } from '../../llm/types.js';
import { Logger } from '../../utils/Logger.js';

export interface CandidateVerdict {
  /** Corpo sem membros, mãos ou dedos a mais/faltando, sem partes fundidas ou duplicadas. */
  anatomyOk: boolean;
  /** 0–10: quanto lembra o personagem da referência (rosto, cabelo, roupa, cores). Sem referência, 10. */
  likeness: number;
  problem?: string;
}

export interface JudgeResult {
  best: number;
  verdicts: CandidateVerdict[];
}

/** Referências maiores que isso não vão ao juiz (o pedido ficaria pesado demais para modelos gratuitos). */
const MAX_REFERENCE_BYTES = 1_500_000;

/**
 * Inspeção de qualidade com um modelo de visão (pedido do usuário: corpo correto e personagem igual à ficha):
 * olha as versões geradas (miniaturas), aponta erro de anatomia e dá nota de semelhança com a referência.
 */
export class ImageJudge {
  private readonly logger = new Logger('Imagens');

  constructor(private readonly llm: ILlmProvider) {}

  async judge(candidates: ImagePart[], context: { references?: ImagePart[]; character?: string; scene: string }): Promise<JudgeResult | undefined> {
    const references = (context.references ?? []).filter((r) => r.base64.length * 0.75 <= MAX_REFERENCE_BYTES).slice(0, 1);
    const prompt = [
      references.length
        ? `A primeira imagem é a REFERÊNCIA do personagem${context.character ? ` "${context.character}"` : ''}. As ${candidates.length} seguintes são CANDIDATAS (numeradas de 1 a ${candidates.length}, na ordem).`
        : `As ${candidates.length} imagens são CANDIDATAS (numeradas de 1 a ${candidates.length}, na ordem).`,
      `Cena pedida: ${context.scene.slice(0, 300)}`,
      'Para cada candidata, confira com rigor a anatomia: conte braços, mãos e pernas de cada personagem; procure membro a mais ou faltando, duas mãos do mesmo lado, mão saindo de lugar errado, dedos a mais, partes fundidas ou duplicadas, rosto deformado. Conte também os personagens: o mesmo personagem repetido (clone) quando a cena pede um só, ou texto, balões e rabiscos de assinatura na imagem, também reprovam (anatomia_ok=false).',
      references.length ? 'Dê também uma nota de 0 a 10 de semelhança com a referência (rosto, cabelo, olhos, roupa, cores).' : 'Como não há referência, use 10 na semelhança.',
      'Responda só com JSON: {"candidatas": [{"anatomia_ok": true|false, "semelhanca": 0-10, "problema": "frase curta ou vazio"}], "melhor": número da melhor (1..N, prefira anatomia_ok e depois maior semelhança)}',
    ].join('\n');
    const current = TaskContext.current();
    try {
      const response = await TaskContext.run({ task: 'visao', privacy: current?.privacy ?? 'publico', userId: current?.userId ?? 'imagens' }, () =>
        this.llm.chat({ messages: [{ role: 'user', content: prompt, images: [...references, ...candidates] }], temperature: 0 }),
      );
      const match = /\{[\s\S]*\}/.exec(response.content ?? '');
      if (!match) return undefined;
      const parsed = JSON.parse(match[0]) as { candidatas?: Array<{ anatomia_ok?: unknown; semelhanca?: unknown; problema?: unknown }>; melhor?: unknown };
      const verdicts = candidates.map((_, i) => {
        const v = parsed.candidatas?.[i];
        const problem = typeof v?.problema === 'string' && v.problema.trim() ? v.problema.trim().slice(0, 160) : undefined;
        return { anatomyOk: v?.anatomia_ok !== false, likeness: Math.max(0, Math.min(10, Number(v?.semelhanca) || 0)), ...(problem ? { problem } : {}) };
      });
      // A escolha é recalculada aqui (anatomia antes de semelhança): não depende só do "melhor" do modelo.
      const best = verdicts.map((v, i) => ({ v, i })).sort((a, b) => Number(b.v.anatomyOk) - Number(a.v.anatomyOk) || b.v.likeness - a.v.likeness)[0]!.i;
      this.logger.info(`🧐 Inspeção: ${verdicts.map((v, i) => `#${i + 1} ${v.anatomyOk ? 'ok' : 'erro'} ${v.likeness}/10`).join(' · ')} → #${best + 1}`);
      return { best, verdicts };
    } catch (error) {
      this.logger.warn(`Inspeção das imagens indisponível (${errorMessage(error).slice(0, 120)}); usando a primeira`);
      return undefined;
    }
  }
}
