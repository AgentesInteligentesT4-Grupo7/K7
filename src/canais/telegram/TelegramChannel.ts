import { Bot } from 'grammy';
import type { Core } from '../../app/createCore.js';
import { OrchestratorCommands } from '../../llm/orchestration/OrchestratorCommands.js';
import { ChatQueue } from '../../utils/ChatQueue.js';
import { Logger } from '../../utils/Logger.js';
import { ChatActionNotifier } from './ChatActionNotifier.js';
import { TelegramFileDownloader } from './input/TelegramFileDownloader.js';
import { AudioOutputStrategy } from './output/strategies/AudioOutputStrategy.js';
import { ErrorOutputStrategy } from './output/strategies/ErrorOutputStrategy.js';
import { FileOutputStrategy } from './output/strategies/FileOutputStrategy.js';
import { ImageOutputStrategy } from './output/strategies/ImageOutputStrategy.js';
import { MediaOutputStrategy } from './output/strategies/MediaOutputStrategy.js';
import { TextOutputStrategy } from './output/strategies/TextOutputStrategy.js';
import { TelegramOutputHandler } from './output/TelegramOutputHandler.js';
import { TelegramSender } from './output/TelegramSender.js';
import { TelegramAttachmentHandler } from './TelegramAttachmentHandler.js';
import { TelegramBotApp } from './TelegramBotApp.js';
import { botCommands } from './botCommands.js';
import { TelegramInputHandler } from './TelegramInputHandler.js';
import { VoiceCloneCommands } from './VoiceCloneCommands.js';
import { TelegramAccessGate } from './acesso/TelegramAccessGate.js';
import { TelegramAccessStore } from './acesso/TelegramAccessStore.js';
import { EnrollmentVerifier } from '../../voice/EnrollmentVerifier.js';

const logger = new Logger('Telegram');

/** Canal Telegram: liga os adaptadores de entrada/saída do grammy ao núcleo compartilhado. */
export function createTelegramChannel(core: Core): TelegramBotApp {
  const { config } = core;

  // Saída
  const bot = new Bot(config.telegramBotToken);
  const sender = new TelegramSender(bot.api);
  const notifier = new ChatActionNotifier(sender);
  const textStrategy = new TextOutputStrategy(sender);
  const output = new TelegramOutputHandler(
    {
      text: textStrategy,
      file: new FileOutputStrategy(sender, core.tmp, textStrategy),
      error: new ErrorOutputStrategy(sender),
      audio: new AudioOutputStrategy(sender, core.tmp, core.tts, core.ffmpeg, notifier),
      image: new ImageOutputStrategy(sender),
      media: new MediaOutputStrategy(sender, (chatId, text) => textStrategy.send(chatId, text)),
    },
    core.voiceClone,
  );
  const controller = core.createController(output);

  // Entrada
  const downloader = new TelegramFileDownloader(bot.api, config.telegramBotToken, core.tmp);
  const queue = new ChatQueue();
  const voiceCommands = core.voiceClone && new VoiceCloneCommands({
    service: core.voiceClone,
    downloader,
    output,
    queue,
    notifier,
    tmp: core.tmp,
    defaultVoiceName: config.voiceClone.defaultVoice ?? 'minha-voz',
    ...(core.voiceTuner ? { tuner: core.voiceTuner } : {}),
    // Sem o módulo voz, a transcrição está desligada e o cadastro verificado avisa isso ao usuário.
    ...(config.voiceClone.verifyText ? { verification: { verifier: new EnrollmentVerifier(core.llm, config.voiceClone.verifyMin), stt: core.stt } } : {}),
  });
  // Quem pode usar o bot desta fita: donos (.env) e, conforme telegram.acesso, convidados e pedidos aprovados.
  const access = new TelegramAccessGate({
    store: new TelegramAccessStore(core.db),
    owners: config.allowedUserIds,
    mode: config.telegramAccess.mode,
    requests: config.telegramAccess.requests,
    hourlyLimit: config.telegramAccess.hourlyLimit,
    agentName: config.identity.name,
  }).attach(bot);
  new TelegramInputHandler({
    access,
    controller,
    output,
    downloader,
    documents: core.documents,
    stt: core.stt,
    tmp: core.tmp,
    queue,
    notifier,
    maxDocumentBytes: config.maxDocumentBytes,
    maxDocumentChars: config.maxDocumentChars,
    voiceId: core.tts.voice,
    extraCommands: [
      access,
      ...(core.attachments
        ? [
            new TelegramAttachmentHandler({
              attachments: core.attachments,
              controller,
              output,
              downloader,
              tmp: core.tmp,
              queue,
              notifier,
              maxBytes: config.maxDocumentBytes,
              voiceId: core.tts.voice,
            }),
          ]
        : []),
      ...(voiceCommands ? [voiceCommands] : []),
      ...(core.orchestrator
        ? [
            {
              register: (b: Bot) =>
                new OrchestratorCommands(core.orchestrator!, config.orchestrator.privacyDefault).register(b, (chatId, text) =>
                  output.notify(chatId, text),
                ),
            },
          ]
        : []),
    ],
    identity: config.identity,
  }).register(bot);

  const { mode } = config.telegramAccess;
  logger.info(
    `🔒 Acesso "${mode}": ${config.allowedUserIds.size} dono(s)` +
      (mode === 'lista' ? '' : ` + ${access.store.list('ativo').length} liberado(s), ${access.store.list('pendente').length} pedido(s) esperando`),
  );
  return new TelegramBotApp(bot, botCommands(config), config.allowedUserIds);
}
