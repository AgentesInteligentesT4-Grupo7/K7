import type { Config } from '../../config/Config.js';

export interface BotCommand {
  command: string;
  description: string;
}

/** Comandos que só os donos veem no menu (gestão de acesso). */
export const OWNER_COMMANDS: readonly BotCommand[] = [
  { command: 'convite', description: 'Gerar convite com QR code: /convite <nome>' },
  { command: 'acessos', description: 'Quem pode usar o bot e os pedidos esperando' },
];

/**
 * Menu de comandos do bot desta fita: só o que os módulos ligados oferecem (sem voz clonada, nada de /falar).
 * `extra` são os comandos da extensão da fita.
 */
export function botCommands(config: Config, extra: readonly BotCommand[] = []): BotCommand[] {
  const has = (module: string) => config.modules.has(module);
  return [
    ...extra,
    { command: 'nova', description: 'Iniciar nova conversa' },
    ...(has('voz-clonada')
      ? [
          { command: 'falar', description: 'Áudio com sua voz clonada: /falar <texto>, com (animado) (pausa) (tosse) (contexto: ...)' },
          { command: 'entonacao', description: 'Marcações de jeito de falar: tons, pausas, efeitos, contexto' },
          { command: 'minhavoz', description: 'Cadastrar sua voz (envie um áudio em seguida)' },
          { command: 'vozes', description: 'Listar vozes cadastradas' },
          { command: 'apagarvoz', description: 'Apagar uma voz: /apagarvoz <nome>' },
          { command: 'testarvoz', description: 'Testar a voz clonada com um áudio: /testarvoz [@voz]' },
          { command: 'ajustar', description: 'Refazer o último áudio: mais emoção, mais lento, igualar...' },
          { command: 'salvarvoz', description: 'Guardar o áudio ajustado: /salvarvoz [nome]' },
        ]
      : []),
    ...(has('anexos') ? [{ command: 'anexos', description: 'Imagens e documentos guardados' }] : []),
    { command: 'memoria', description: 'O que eu lembro desta conversa e de você' },
    { command: 'skills', description: 'Listar skills instaladas' },
    ...(config.orchestrator.enabled
      ? [
          { command: 'modelos', description: 'Ranking dos modelos gratuitos (orquestrador)' },
          { command: 'modelo', description: 'Qual modelo respondeu a última mensagem' },
          { command: 'bom', description: 'A última resposta foi boa (feedback)' },
          { command: 'ruim', description: 'A última resposta foi ruim (feedback)' },
        ]
      : []),
    { command: 'start', description: 'Ajuda' },
  ].slice(0, 100);
}
