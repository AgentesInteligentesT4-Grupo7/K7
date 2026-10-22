import { UserFacingError, errorMessage } from '../errors/AppErrors.js';
import { TaskClassifier } from '../llm/orchestration/TaskClassifier.js';
import { TaskContext } from '../llm/orchestration/TaskContext.js';
import type { ConversationSummarizer } from '../memory/ConversationSummarizer.js';
import type { UserSettings } from '../memory/UserSettings.js';
import { type Persona, PersonaCatalog } from '../personas/Personas.js';
import type { StyleCatalog, TextStyle } from '../personas/Styles.js';
import { type TextControls, controlsHelp, formatControls, parseControls, sanitizeControls } from '../personas/TextControls.js';
import type { Guardrails } from '../guardrails/Guardrails.js';
import { ResponseAttachments } from './ResponseAttachments.js';
import type { PrivacyLevel, Task } from '../llm/orchestration/types.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { SkillExecutor } from '../skills/SkillExecutor.js';
import type { SkillLoader, SkillMetadata } from '../skills/SkillLoader.js';
import type { SkillRouter } from '../skills/SkillRouter.js';
import { Logger, preview } from '../utils/Logger.js';
import type { AgentInput, AgentResponse, IContextProvider, IOutputHandler } from './types.js';

export interface AgentControllerDeps {
  memory: MemoryManager;
  skillLoader: SkillLoader;
  skillRouter: SkillRouter;
  skillExecutor: SkillExecutor;
  output: IOutputHandler;
  providerName: string;
  /** Privacidade padrão das conversas (PRIVACY_DEFAULT); documentos sobem para "pessoal". */
  privacyDefault?: PrivacyLevel;
  /** false quando o módulo "voz" está desligado: pedidos de resposta em áudio viram texto. */
  audioReplies?: boolean;
  /** Resumo incremental em segundo plano (memória v1.1). */
  summarizer?: ConversationSummarizer;
  /** Personas e estilos de texto (spec personas-styles). */
  personas?: PersonaCatalog;
  styles?: StyleCatalog;
  settings?: UserSettings;
  /** estilo_padrao da fita / ESTILO_PADRAO. */
  defaultStyle?: string;
  /** Guardrails declarados na fita (spec guardrails). */
  guardrails?: Guardrails;
  /** Contexto recuperado a cada mensagem (base de conhecimento no modo automático). */
  contextProviders?: IContextProvider[];
}

const PRIVACY_ORDER: PrivacyLevel[] = ['publico', 'pessoal', 'local'];
const stricter = (a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel =>
  PRIVACY_ORDER.indexOf(a) >= PRIVACY_ORDER.indexOf(b) ? a : b;

/**
 * Facade da aplicação: recebe a entrada normalizada e orquestra
 * Memória → Skills (Loader/Router/Executor) → AgentLoop → Output.
 */
export class AgentController {
  private readonly logger = new Logger('Controller');

  constructor(private readonly deps: AgentControllerDeps) {}

  /** Processa a entrada e entrega a resposta (ou o erro formatado) no chat. */
  async handle(input: AgentInput): Promise<void> {
    const started = Date.now();
    this.logger.info(`📩 [${input.source}] user=${input.userId}: ${preview(input.text, 120)}`);
    try {
      const response = await this.process(input);
      await this.deps.output.send(input.chatId, response);
      this.logger.info(`📤 Resposta entregue em ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      if (error instanceof UserFacingError) this.logger.warn(error.message);
      else this.logger.error(`Falha no processamento: ${errorMessage(error)}`, error);
      await this.deps.output.sendError(input.chatId, error);
    }
  }

  async process(original: AgentInput): Promise<AgentResponse> {
    const { memory } = this.deps;
    const userId = String(original.userId);
    // Persona: "@nome mensagem" vale só para esta mensagem; senão, a escolhida com /persona.
    const mention = this.deps.personas?.mention(original.text);
    const persona = mention?.persona ?? this.activePersona(userId);
    // Controles de texto na mensagem ("detalhe=3 tom=8") valem só para ela e saem do texto.
    const asked = parseControls(mention?.text ?? original.text);
    const input: AgentInput = { ...original, text: asked.rest };
    // Memória isolada por persona; anexos, roteamento e orquestrador seguem com o usuário real.
    const memoryUserId = PersonaCatalog.memoryUserId(userId, persona);
    const conversation = memory.getOrCreateActiveConversation(memoryUserId, this.deps.providerName);

    // A entrada é persistida ANTES do LLM: se o provider cair, o texto (ex.: transcrição) não se perde.
    const saved = memory.saveMessage(conversation.id, 'user', input.text, {
      channel: input.channel ?? 'telegram',
      source: input.source,
      requires_audio_reply: input.requiresAudioReply,
      ...(input.voiceId ? { voice_id: input.voiceId } : {}),
      ...(input.attachmentName ? { attachment: input.attachmentName } : {}),
    });

    const { history, memory: memoryText } = memory.buildContext(conversation.id, memoryUserId);
    if (!saved) history.push({ role: 'user', content: input.text });
    // Imagens vão só na mensagem atual (o histórico guarda a referência "[Anexo #id]", não a imagem).
    const current = history.at(-1);
    if (input.images?.length && current?.role === 'user') current.images = input.images;

    // Hot-reload: as skills são relidas do disco a cada requisição.
    // Persona com "skills: [...]" só enxerga essas skills.
    const skills = this.deps.skillLoader.loadAll().filter((s) => !persona?.skills.length || persona.skills.includes(s.name));
    const style = this.resolveStyle(userId, input.text, persona);
    const controls = this.resolveControls(userId, style, persona, asked.controls);
    if (persona || style || controls) {
      this.logger.info(`🎭 ${persona ? `persona ${persona.name}` : 'agente'}${style ? ` · estilo ${style.name}` : ''}${controls ? ` · ${formatControls(controls)}` : ''}`);
    }
    // Privacidade: documentos e anexos são dados pessoais (spec llm-orchestration RF-09).
    const privacy = input.source === 'document' ? stricter(this.deps.privacyDefault ?? 'publico', 'pessoal') : (this.deps.privacyDefault ?? 'publico');

    // Guardrails de entrada: injeção e tópico. Documento enviado é conteúdo externo (só avisa).
    const { guardrails } = this.deps;
    const verdict = guardrails
      ? await TaskContext.run({ task: 'roteamento', privacy, userId }, () => guardrails.checkInput(input.text, { external: input.source === 'document' }))
      : undefined;
    if (verdict?.blocked) {
      memory.saveMessage(conversation.id, 'assistant', verdict.blocked, { guardrails: verdict.events });
      return { text: verdict.blocked, isAudio: false };
    }
    const guardrailsPrompt = [guardrails?.promptSection(), verdict?.warning].filter(Boolean).join('\n\n') || undefined;
    const routed = await TaskContext.run({ task: 'roteamento', privacy, userId }, () =>
      this.deps.skillRouter.routeWithTask(input.text, skills),
    );
    const skill = routed.skill;
    const task: Task = input.images?.length ? 'visao' : (routed.task ?? TaskClassifier.fromSkill(skill?.name) ?? TaskClassifier.heuristic(input.text));

    const retrieved = await this.retrieve(input.text, { task, privacy, userId });
    const { result, images } = await ResponseAttachments.collect(() =>
      TaskContext.run({ task, privacy, userId }, () => this.deps.skillExecutor.execute({ skill, availableSkills: skills, history, input, memory: memoryText, persona, style, controls, guardrails: guardrailsPrompt, retrieved })),
    );
    // Guardrails de saída: palavras proibidas e dados pessoais (a versão salva na memória também sai limpa).
    const output = guardrails ? await TaskContext.run({ task, privacy, userId }, () => guardrails.checkOutput(result.text)) : undefined;
    const text = output?.text ?? result.text;
    const guardrailEvents = [...(verdict?.events ?? []), ...(output?.events ?? [])];

    for (const step of result.steps) {
      memory.saveMessage(conversation.id, 'tool', `${step.tool}(${step.arguments}) → ${step.observation}`, {
        tool: step.tool,
        iteration: step.iteration,
      });
    }
    memory.saveMessage(
      conversation.id,
      'assistant',
      text,
      {
        provider: result.providerName,
        skill: result.skillName,
        task,
        privacy,
        ...(persona ? { persona: persona.name } : {}),
        ...(style ? { style: style.name } : {}),
        ...(controls ? { controls } : {}),
        ...(guardrailEvents.length ? { guardrails: guardrailEvents } : {}),
        iterations: result.iterations,
        ...result.details,
        ...(images.length ? { images: images.map((i) => i.path) } : {}),
        ...AgentController.sources(result.steps),
      },
      result.providerName,
    );

    this.deps.summarizer?.schedule(conversation.id, memoryUserId);
    return { text, isAudio: input.requiresAudioReply && (this.deps.audioReplies ?? true), ...(images.length ? { images } : {}) };
  }

  /** Contexto dos provedores (falha de um não derruba a resposta). */
  private async retrieve(text: string, context: { task: Task; privacy: PrivacyLevel; userId: string }): Promise<string | undefined> {
    const providers = this.deps.contextProviders ?? [];
    if (!providers.length) return undefined;
    const parts = await TaskContext.run(context, () =>
      Promise.all(
        providers.map((p) =>
          p.contextFor(text).catch((error: unknown) => {
            this.logger.warn(`Contexto indisponível: ${errorMessage(error)}`);
            return undefined;
          }),
        ),
      ),
    );
    return parts.filter(Boolean).join('\n\n') || undefined;
  }

  /** URLs lidas com ler_pagina nesta resposta (spec web-search §9: metadata.sources). */
  private static sources(steps: Array<{ tool: string; arguments: string }>): { sources?: string[] } {
    const urls = steps
      .filter((s) => s.tool === 'ler_pagina')
      .map((s) => {
        try {
          return String((JSON.parse(s.arguments) as { url?: unknown }).url ?? '');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    return urls.length ? { sources: [...new Set(urls)] } : {};
  }

  /** `/memoria`: o que o agente lembra desta conversa e do usuário (spec memory v1.1 RF-11). */
  memoryReport(userId: number | string): string {
    const { memory } = this.deps;
    const id = this.memoryUserId(userId);
    const conversation = memory.getOrCreateActiveConversation(id, this.deps.providerName);
    const summary = memory.summaries.latest(conversation.id)?.summary.trim();
    const facts = memory.summaries.facts(id);
    return [
      '🧠 Memória desta conversa:',
      summary || '(ainda sem resumo: ele é criado quando a conversa fica longa)',
      '',
      '📌 Fatos sobre você (valem em todas as conversas):',
      facts.length ? facts.map((f, i) => `${i + 1}. ${f.fact}`).join('\n') : '(nenhum)',
      '',
      'Apagar: /esquecer <número> ou /esquecer tudo',
    ].join('\n');
  }

  /** `/esquecer <n>` remove um fato; `/esquecer tudo` limpa fatos e o resumo da conversa ativa. */
  forget(userId: number | string, arg: string): string {
    const { memory } = this.deps;
    const id = this.memoryUserId(userId);
    if (/^tudo$/i.test(arg.trim())) {
      memory.summaries.clearFacts(id);
      memory.summaries.clear(memory.getOrCreateActiveConversation(id, this.deps.providerName).id);
      return '🧹 Esqueci os fatos e o resumo desta conversa.';
    }
    const n = Number(arg.trim());
    const removed = Number.isInteger(n) ? memory.summaries.removeFact(id, n) : undefined;
    return removed ? `🧹 Esqueci: "${removed}"` : 'Use /esquecer <número do fato> (veja em /memoria) ou /esquecer tudo.';
  }

  /** `/persona`: lista, ativa (`/persona kael`) ou volta ao agente (`/persona sair`). */
  personaCommand(userId: number | string, arg: string): string {
    const { personas, settings } = this.deps;
    const available = personas?.list() ?? [];
    if (!personas || !settings || available.length === 0) return 'Esta fita não tem personas (crie arquivos em personas/<nome>.md).';
    const id = String(userId);
    const wanted = arg.trim().toLowerCase().replace(/^@/, '');
    if (!wanted) {
      const active = this.activePersona(id)?.name;
      const list = available.map((p) => `${p.name === active ? '▶' : '-'} ${p.name}: ${p.description}`).join('\n');
      return `🎭 Personas (${active ? `ativa: ${active}` : 'falando com o agente'}):\n${list}\n\nUse /persona <nome>, /persona sair ou "@nome mensagem".`;
    }
    if (['sair', 'nenhuma', 'agente'].includes(wanted)) {
      settings.set(id, 'persona', undefined);
      return '🎭 De volta ao agente.';
    }
    const persona = personas.get(wanted);
    if (!persona) return `Persona "${wanted}" não existe. Disponíveis: ${available.map((p) => p.name).join(', ')}.`;
    settings.set(id, 'persona', persona.name);
    return `🎭 Agora você fala com ${persona.name} (memória própria). /persona sair volta ao agente.`;
  }

  /**
   * `/estilo`: lista, fixa (`/estilo formal`), ajusta níveis (`/estilo formal detalhe=3 tom=2`)
   * ou volta ao padrão (`/estilo padrao`, que também zera os níveis).
   */
  styleCommand(userId: number | string, arg: string): string {
    const { styles, settings } = this.deps;
    if (!styles || !settings) return 'Estilos não disponíveis.';
    const id = String(userId);
    const { controls, rest } = parseControls(arg);
    const wanted = rest.trim().toLowerCase();
    const changedControls = Object.keys(controls).length > 0;
    if (!wanted && !changedControls) {
      const active = settings.get(id, 'estilo') ?? this.deps.defaultStyle;
      const saved = this.savedControls(id);
      const list = styles.list().map((s) => `${s.name === active ? '▶' : '-'} ${s.name}: ${s.description}`).join('\n');
      return [
        `✍️ Estilos (${active ? `ativo: ${active}` : 'nenhum fixo'}${Object.keys(saved).length ? ` · níveis: ${formatControls(saved)}` : ''}):`,
        list,
        '',
        'Níveis (combine com o estilo, ex.: /estilo formal detalhe=3):',
        controlsHelp(),
        '',
        'Use /estilo <nome> [níveis], /estilo padrao, ou peça na mensagem ("em tom formal", "detalhe=8").',
      ].join('\n');
    }
    if (['padrao', 'padrão', 'nenhum', 'sair'].includes(wanted)) {
      settings.set(id, 'estilo', undefined);
      settings.set(id, 'controles', undefined);
      return '✍️ Estilo e níveis de volta ao padrão.';
    }
    const replies: string[] = [];
    if (wanted) {
      const style = styles.get(wanted);
      if (!style) return `Estilo "${wanted}" não existe. Disponíveis: ${styles.list().map((s) => s.name).join(', ')}.`;
      settings.set(id, 'estilo', style.name);
      replies.push(`✍️ Estilo fixado: ${style.name}.`);
    }
    if (changedControls) {
      const merged = { ...this.savedControls(id), ...controls };
      settings.set(id, 'controles', JSON.stringify(merged));
      replies.push(`🎚️ Níveis: ${formatControls(merged)}.`);
    }
    return `${replies.join(' ')} /estilo padrao desfaz.`;
  }

  private savedControls(userId: string): TextControls {
    const raw = this.deps.settings?.get(userId, 'controles');
    if (!raw) return {};
    try {
      return sanitizeControls(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  /** Níveis do texto: estilo → persona → /estilo → mensagem (o mais específico vence). */
  private resolveControls(userId: string, style: TextStyle | undefined, persona: Persona | undefined, asked: TextControls): TextControls | undefined {
    const merged = { ...style?.controls, ...persona?.controls, ...this.savedControls(userId), ...asked };
    return Object.keys(merged).length ? merged : undefined;
  }

  private activePersona(userId: string): Persona | undefined {
    const name = this.deps.settings?.get(userId, 'persona');
    if (!name) return undefined;
    const persona = this.deps.personas?.get(name);
    if (!persona) this.logger.warn(`Persona "${name}" não existe mais na fita; usando o agente`);
    return persona;
  }

  private memoryUserId(userId: number | string): string {
    return PersonaCatalog.memoryUserId(String(userId), this.activePersona(String(userId)));
  }

  /** Precedência (spec personas-styles §5.2): pedido na mensagem → persona → /estilo → padrão da fita. */
  private resolveStyle(userId: string, text: string, persona: Persona | undefined): TextStyle | undefined {
    const { styles, settings } = this.deps;
    if (!styles) return undefined;
    const requested = styles.detect(text);
    if (requested) return requested;
    for (const name of [persona?.style, settings?.get(userId, 'estilo'), this.deps.defaultStyle]) {
      const style = name ? styles.get(name) : undefined;
      if (style) return style;
    }
    return undefined;
  }

  newConversation(userId: number | string): void {
    const conversation = this.deps.memory.startNewConversation(this.memoryUserId(userId), this.deps.providerName);
    this.logger.info(`🆕 Conversa reiniciada para user=${userId} (${conversation.id.slice(0, 8)})`);
  }

  listSkills(): SkillMetadata[] {
    return this.deps.skillLoader.loadAll();
  }
}
