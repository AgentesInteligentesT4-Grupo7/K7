import path from 'node:path';
import type { Config } from '../../../config/Config.js';
import { type BotCommand, OWNER_COMMANDS, botCommands } from '../botCommands.js';
import type { BotProfile } from './TelegramBotSetup.js';

/**
 * Como o bot da fita aparece no Telegram, a partir do perfil: nome e emoji da identidade, propósito e descrição da
 * fita, menu de comandos dos módulos ligados (e da extensão) e a foto `bot/foto.jpg`, se existir.
 */
export function botProfileFor(config: Config, descricaoFita = '', extraCommands: readonly BotCommand[] = []): BotProfile {
  const { name, emoji, purpose } = config.identity;
  const about = [purpose && `${name}: ${purpose}.`, descricaoFita].filter(Boolean).join(' ').trim() || `${name}, um agente do K7.`;
  return {
    nome: `${emoji ? `${emoji} ` : ''}${name}`.trim(),
    descricao: `${about}\n\nToque em Iniciar para começar.`,
    curta: (descricaoFita || about).slice(0, 120),
    comandos: botCommands(config, extraCommands),
    donos: { ids: config.allowedUserIds, comandos: [...OWNER_COMMANDS] },
    ...(config.profileDir ? { foto: path.join(config.profileDir, 'bot', 'foto.jpg') } : {}),
  };
}
