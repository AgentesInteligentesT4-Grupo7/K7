import { errorMessage } from '../errors/AppErrors.js';
import { TaskContext } from '../llm/orchestration/TaskContext.js';
import type { PrivacyLevel } from '../llm/orchestration/types.js';
import type { ILlmProvider } from '../llm/types.js';
import { Logger } from '../utils/Logger.js';
import { compactMessage } from './ContextBuilder.js';
import type { MemoryManager } from './MemoryManager.js';

export interface SummarizerOptions {
  /** Mensagens que ficam fora do resumo, sempre inteiras no contexto (MEMORY_RECENT_MESSAGES). */
  recentMessages: number;
  /** Quantas mensagens fora da janela recente disparam um novo resumo (MEMORY_SUMMARY_TRIGGER). */
  trigger: number;
  maxChars: number;
  factsEnabled: boolean;
  privacy: PrivacyLevel;
}

/** Segredos nunca entram no resumo nem nos fatos (spec memory v1.1 EC-06). */
const SECRET =
  /(AIza[0-9A-Za-z_-]{20,}|\bsk-[A-Za-z0-9_-]{16,}|\bgsk_[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}|\bnvapi-[A-Za-z0-9_-]{16,}|\b\d{8,10}:AA[A-Za-z0-9_-]{20,}|\b(senha|password|token|api[ _-]?key|chave)\b\s*[:=]\s*\S+|\b(?:\d[ -]?){13,19}\b)/i;
const SECTIONS = ['Assunto', 'Pedidos do usuário', 'Decisões e fatos', 'Entregas', 'Pendências', 'Anexos citados'];

/**
 * Resumo incremental + fatos duradouros (spec memory v1.1 RF-04, RF-06, RF-07, RF-09, RF-10):
 * roda depois da resposta, com o LLM barato do roteamento; se falhar, fica o último resumo válido.
 */
export class ConversationSummarizer {
  private readonly logger = new Logger('Memória');
  private readonly running = new Set<string>();

  constructor(
    private readonly memory: MemoryManager,
    private readonly llm: ILlmProvider,
    private readonly options: SummarizerOptions,
  ) {}

  /** Agenda sem bloquear a entrega da resposta. */
  schedule(conversationId: string, userId: string): void {
    setTimeout(() => void this.summarize(conversationId, userId), 50).unref();
  }

  /** Gera um novo resumo se houver mensagens suficientes fora da janela recente. Devolve se resumiu. */
  async summarize(conversationId: string, userId: string): Promise<boolean> {
    if (this.running.has(conversationId)) return false;
    const pending = this.memory.unsummarized(conversationId);
    const outside = pending.slice(0, Math.max(0, pending.length - this.options.recentMessages));
    if (outside.length < this.options.trigger) return false;

    this.running.add(conversationId);
    const started = Date.now();
    try {
      const previous = this.memory.summaries.latest(conversationId)?.summary ?? '';
      const facts = this.options.factsEnabled ? this.memory.summaries.facts(userId).map((f) => f.fact) : [];
      const transcript = outside
        .map((m) => `#${m.id} ${m.role === 'user' ? 'usuário' : 'assistente'}: ${compactMessage(m, 600).slice(0, 2_000)}`)
        .join('\n');
      const response = await TaskContext.run({ task: 'resumo', privacy: this.options.privacy, userId }, () =>
        this.llm.chat({ messages: [{ role: 'user', content: this.prompt(previous, facts, transcript) }], temperature: 0 }),
      );
      const parsed = ConversationSummarizer.parse(response.content ?? '', this.options.maxChars);
      if (!parsed) {
        this.logger.warn('Resumo fora do formato; mantendo o anterior');
        return false;
      }
      const lastId = outside.at(-1)!.id;
      this.memory.summaries.save(conversationId, parsed.summary, lastId);
      if (this.options.factsEnabled && parsed.facts) this.memory.summaries.replaceFacts(userId, parsed.facts, lastId);
      this.logger.info(`🧠 Resumo atualizado até a mensagem #${lastId} (${parsed.summary.length} caracteres, ${Date.now() - started}ms)`);
      return true;
    } catch (error) {
      this.logger.warn(`Resumo não gerado (fica o anterior): ${errorMessage(error)}`);
      return false;
    } finally {
      this.running.delete(conversationId);
    }
  }

  private prompt(previous: string, facts: string[], transcript: string): string {
    return `Você mantém a memória de uma conversa entre um usuário e um assistente. Atualize o resumo anterior incorporando as novas mensagens.

Regras:
- Use só o que está nas mensagens; não invente. Indique a mensagem de origem das decisões, ex.: (#123).
- Una pedidos repetidos, reformulados ou corrigidos numa única linha com a versão final; correções substituem a versão anterior.
- Nunca copie senhas, tokens, chaves de API, números de cartão ou documentos pessoais.
- No máximo ${this.options.maxChars} caracteres no resumo. Omita seções vazias. Escreva em português.

Formato exato:
${SECTIONS.map((s) => `## ${s}\n- ...`).join('\n')}
### FATOS_DURADOUROS
- fatos estáveis sobre o usuário que valem em outras conversas (preferências, projetos, dados de trabalho)

Em FATOS_DURADOUROS, devolva a lista COMPLETA e atualizada: mantenha os fatos atuais, acrescente os novos e remova os que foram contraditos. Se não houver nenhum, escreva "- (nenhum)".

# Resumo anterior
${previous || '(nenhum)'}

# Fatos atuais
${facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(nenhum)'}

# Novas mensagens
${transcript}`;
  }

  /** Valida o formato (EC-07), tira segredos (EC-06) e limita o tamanho (EC-05). */
  static parse(text: string, maxChars: number): { summary: string; facts: string[] | undefined } | undefined {
    const [summaryPart = '', factsPart] = text.replace(/```\w*\n?/g, '').split(/^###\s*FATOS[_ ]DURADOUROS\s*$/im);
    const lines = summaryPart.split('\n').filter((line) => !SECRET.test(line) && !/^\s*[-*]\s*\(?nenhum[a]?\)?\.?\s*$/i.test(line));
    // Seções que ficaram vazias saem (RF-06: "cada seção vazia é omitida").
    let summary = lines
      .join('\n')
      .replace(/^##[^\n]*\n(?=\s*(##|$))/gm, '')
      .trim();
    if (!SECTIONS.some((s) => new RegExp(`^##\\s*${s}`, 'im').test(summary))) return undefined;
    summary = summary.slice(summary.search(/^##\s/m));
    if (summary.length > maxChars) summary = `${summary.slice(0, summary.lastIndexOf('\n', maxChars)).trim()}\n[…]`;
    const facts =
      factsPart === undefined
        ? undefined
        : factsPart
            .split('\n')
            .map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/\s*\((#\d+[,\s]*)+\)\s*$/, '').trim())
            .filter((l) => l && !/^\(?nenhum\)?\.?$/i.test(l) && !SECRET.test(l) && l.length <= 200)
            .slice(0, 30);
    return { summary, facts };
  }
}
