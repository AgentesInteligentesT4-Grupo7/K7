import fs from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ConfigError } from '../config/Config.js';
import { errorMessage } from '../errors/AppErrors.js';
import { createOrchestrator } from '../llm/orchestration/createOrchestrator.js';
import { TaskClassifier } from '../llm/orchestration/TaskClassifier.js';
import { TaskContext } from '../llm/orchestration/TaskContext.js';
import { type Task, modelKey } from '../llm/orchestration/types.js';
import { DatabaseConnection } from '../memory/DatabaseConnection.js';
import { loadConfig } from '../profiles/ProfileLoader.js';
import { Logger } from '../utils/Logger.js';
import { ProcessRunner } from '../utils/ProcessRunner.js';
import { sleep } from '../utils/text.js';

interface EvalCase {
  pergunta: string;
  /** Respostas aceitas: basta conter UMA delas (sem diferenciar maiúsculas/acentos). */
  esperado: string[];
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * `npm run eval -- [--perfil nome] <tarefa> [--modelos N] [--atraso ms]`
 * Roda o conjunto evals/<tarefa>.yaml nos melhores candidatos gratuitos (inclusive os locais)
 * e grava a nota medida no ranking (spec llm-orchestration RF-07). Respeita cotas: chamadas em série.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Todas as opções têm valor (--perfil x, --modelos N, --atraso ms): o posicional é a tarefa.
  const positional = args.filter((arg, i) => !arg.startsWith('--') && !(args[i - 1]?.startsWith('--') && !args[i - 1]!.includes('=')));
  const task = TaskClassifier.parse(positional[0]);
  if (!task || task === 'roteamento') {
    process.stdout.write('Uso: npm run eval -- <conversa|pesquisa|raciocinio|codigo|resumo> [--modelos 6] [--atraso 1500]\n');
    process.exit(1);
  }
  const option = (name: string, fallback: number) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) || fallback : fallback;
  };
  const maxModels = option('modelos', 6);
  const delayMs = option('atraso', 1500);

  const config = loadConfig({ requireTelegram: false });
  // O conjunto do perfil (perfil/evals/) tem prioridade sobre o do tocador (evals/).
  const files = [config.profileDir && path.join(config.profileDir, 'evals', `${task}.yaml`), path.resolve('evals', `${task}.yaml`)];
  const file = files.find((f): f is string => Boolean(f) && fs.existsSync(f!));
  if (!file) throw new Error(`Conjunto de avaliação não encontrado: ${files.filter(Boolean).join(' nem ')}`);
  const cases = parseYaml(fs.readFileSync(file, 'utf8')) as EvalCase[];

  Logger.setLevel('warn');
  const db = DatabaseConnection.getInstance(config.dbPath);
  const orchestrator = createOrchestrator(config, db, new ProcessRunner());
  await orchestrator.provider.refresh(true);

  // Perguntas de avaliação não são pessoais: todos os gratuitos concorrem.
  const candidates = orchestrator.ranker
    .rank(task as Task, 'publico', { tools: true, vision: false, minContext: 2_048 })
    .slice(0, maxModels);
  process.stdout.write(`\n🧪 Avaliando "${task}": ${cases.length} perguntas × ${candidates.length} modelos\n\n`);

  const results: Array<{ key: string; score: number; done: number; note: string }> = [];
  for (const { candidate } of candidates) {
    const key = modelKey(candidate);
    let correct = 0;
    let done = 0;
    let note = '';
    for (const item of cases) {
      try {
        // Contexto fixado no candidato: a chamada vai exatamente para este modelo.
        const response = await TaskContext.run({ task: task as Task, privacy: 'publico', userId: 'eval', pinned: key }, () =>
          orchestrator.provider.chat({
            messages: [
              { role: 'system', content: 'Responda em português do Brasil, de forma curta e direta.' },
              { role: 'user', content: item.pergunta },
            ],
            temperature: 0,
          }),
        );
        if (response.providerName !== key) {
          note = `indisponível (respondido por ${response.providerName})`;
          break;
        }
        done++;
        const answer = normalize(response.content ?? '');
        if (item.esperado.some((e) => answer.includes(normalize(e)))) correct++;
      } catch (error) {
        note = `falhou: ${errorMessage(error).slice(0, 60)}`;
        break;
      }
      await sleep(delayMs);
    }
    const score = done > 0 ? correct / done : 0;
    if (done >= 3) orchestrator.scores.recordEval(task as Task, key, score, done);
    results.push({ key, score, done, note });
    process.stdout.write(`  ${key.padEnd(48)} ${(score * 100).toFixed(0).padStart(3)}%  (${done}/${cases.length})${note ? `  ${note}` : ''}\n`);
  }

  process.stdout.write('\nRanking atualizado (só modelos com ≥ 3 respostas). Veja com /modelos ' + task + '\n');
  DatabaseConnection.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof ConfigError ? 'Configuração inválida: ' : ''}${errorMessage(error)}\n`);
  DatabaseConnection.close();
  process.exit(1);
});
