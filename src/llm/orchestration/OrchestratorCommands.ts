import type { Bot, Context } from 'grammy';
import type { Orchestrator } from './createOrchestrator.js';
import { TaskClassifier } from './TaskClassifier.js';
import type { PrivacyLevel, Task } from './types.js';

const MAIN_TASKS: Task[] = ['conversa', 'pesquisa', 'raciocinio', 'codigo', 'resumo'];

/**
 * Comandos de transparência e feedback do orquestrador (spec llm-orchestration RF-10, RF-11):
 *   /modelos [tarefa] — ranking dos gratuitos (geral ou de uma tarefa)
 *   /modelo           — qual modelo respondeu a última mensagem e por quê
 *   /bom  /ruim       — feedback que sobe/desce o modelo naquela tarefa
 * Os métodos devolvem texto, para servir ao Telegram e ao terminal.
 */
export class OrchestratorCommands {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly privacyDefault: PrivacyLevel,
  ) {}

  async ranking(taskArg?: string): Promise<string> {
    await this.orchestrator.provider.refresh();
    const sources = this.orchestrator.catalog.sourceStatuses
      .map((s) => `${s.enabled ? '✅' : '⏹️'} ${s.source}: ${s.enabled ? `${s.models} modelos` : s.reason}`)
      .join('\n');

    const task = taskArg ? TaskClassifier.parse(taskArg) : null;
    if (taskArg && !task) return `Tarefa desconhecida: ${taskArg}. Use: ${MAIN_TASKS.join(', ')}, visao.`;

    const requirements = { tools: true, vision: task === 'visao', minContext: 4_096 };
    const blocks = (task ? [task] : MAIN_TASKS).map((t) => {
      const ranked = this.orchestrator.ranker.rank(t, this.privacyDefault, requirements, { includeCooling: true });
      const top = ranked.slice(0, task ? 8 : 3).map((r, i) => {
        const where = r.candidate.local ? (r.candidate.gpuFit === false ? 'local/CPU' : 'local/GPU') : r.candidate.source;
        const cooling = r.cooldownUntil ? ` ⏸️ até ${new Date(r.cooldownUntil).toLocaleTimeString('pt-BR')}` : '';
        return `  ${i + 1}. ${r.candidate.modelId} [${where}] ${r.score.toFixed(2)}${r.measured ? ' (medida)' : ''}${cooling}`;
      });
      return `🏷️ ${t}\n${top.join('\n') || '  (nenhum modelo gratuito disponível)'}`;
    });
    return `🧠 Fontes gratuitas:\n${sources}\n\n${blocks.join('\n\n')}\n\nNotas "(medida)" vêm de npm run eval; as demais são estimativas.`;
  }

  lastDecision(userId: string): string {
    const decision = this.orchestrator.provider.lastDecision(userId);
    if (!decision) return 'Ainda não respondi nada nesta sessão.';
    return `🎯 Última resposta: ${decision.model}\nTarefa: ${decision.task}\nMotivo: ${decision.reason}\nEm: ${decision.at.toLocaleString('pt-BR')}`;
  }

  feedback(userId: string, delta: 1 | -1): string {
    const decision = this.orchestrator.provider.lastDecision(userId);
    if (!decision) return 'Não há resposta recente para avaliar.';
    const total = this.orchestrator.scores.recordFeedback(decision.task, decision.model, delta);
    return `${delta > 0 ? '👍' : '👎'} Anotado para ${decision.model} em "${decision.task}" (saldo ${total > 0 ? '+' : ''}${total}).`;
  }

  /** Registra os comandos no bot do Telegram. */
  register(bot: Bot, reply: (chatId: number, text: string) => Promise<void>): void {
    const userId = (ctx: Context) => String(ctx.from!.id);
    bot.command('modelos', async (ctx) => reply(ctx.chat!.id, await this.ranking(String(ctx.match ?? '').trim() || undefined)));
    bot.command('modelo', (ctx) => reply(ctx.chat!.id, this.lastDecision(userId(ctx))));
    bot.command('bom', (ctx) => reply(ctx.chat!.id, this.feedback(userId(ctx), 1)));
    bot.command('ruim', (ctx) => reply(ctx.chat!.id, this.feedback(userId(ctx), -1)));
  }
}
