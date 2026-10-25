import fs from 'node:fs';
import path from 'node:path';
import { ResponseAttachments } from '../../agent/ResponseAttachments.js';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../../tools/BaseTool.js';
import { Logger } from '../../utils/Logger.js';
import type { MediaFormat, YtdlpClient } from './YtdlpClient.js';

const YOUTUBE = /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\//i;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/**
 * baixar_youtube (módulo midia): baixa áudio (MP3/WAV) ou vídeo (MP4) de um link ou playlist do YouTube
 * para `<workspace>/downloads` e entrega os arquivos pelo canal (Telegram, terminal ou navegador).
 */
export class DownloadMediaTool extends BaseTool {
  readonly name = 'baixar_youtube';
  readonly description =
    'Baixa áudio (mp3 ou wav) ou vídeo (mp4) de um link do YouTube, ou de todos os vídeos de uma playlist, e entrega os arquivos ao usuário. ' +
    'Só links youtube.com, youtu.be ou music.youtube.com.';
  readonly parameters: JsonSchema;
  private readonly logger = new Logger('Midia');

  constructor(
    private readonly client: YtdlpClient,
    private readonly workspaceDir: string,
    private readonly maxItems: number,
  ) {
    super();
    this.parameters = {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Link do vídeo ou da playlist no YouTube.' },
        formato: { type: 'string', enum: ['mp3', 'wav', 'mp4'], description: 'mp3 (áudio, padrão), wav (áudio sem perda) ou mp4 (vídeo).' },
        playlist: { type: 'boolean', description: 'true para baixar os vídeos da playlist do link; false (padrão) só o vídeo.' },
        max_itens: { type: 'integer', description: `Quantos vídeos da playlist, no máximo (padrão e limite: ${maxItems}).` },
      },
      required: ['url'],
      additionalProperties: false,
    };
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args.url).trim();
    if (!YOUTUBE.test(url)) throw new ToolArgumentError('Só links do YouTube (youtube.com, youtu.be, music.youtube.com).');
    const formato = (typeof args.formato === 'string' ? args.formato : 'mp3') as MediaFormat;
    // Link só de playlist (sem v=): baixa a playlist mesmo que o modelo esqueça de pedir.
    const playlist = args.playlist === true || (/[?&]list=/.test(url) && !/[?&]v=|youtu\.be\//.test(url));
    const maxItens = Math.min(this.maxItems, Math.max(1, Number(args.max_itens) || this.maxItems));
    const targetDir = path.join(this.workspaceDir, 'downloads');

    const started = Date.now();
    const files = await this.client.download({ url, formato, playlist, maxItens }, targetDir, (progress) =>
      this.logger.info(`⬇️ ${formato} ${progress}`),
    );
    const kind = formato === 'mp4' ? 'video' : 'audio';
    for (const file of files) ResponseAttachments.addMedia({ path: file, kind });
    this.logger.info(`✅ ${files.length} arquivo(s) ${formato} em ${Math.round((Date.now() - started) / 1000)} s`);

    const lines = files.map((file) => `- ${path.basename(file)} (${mb(fs.statSync(file).size)})`);
    return {
      output: [
        `ok: ${files.length} arquivo(s) ${formato.toUpperCase()} baixado(s) em ${targetDir}. Os arquivos já são entregues ao usuário junto da sua resposta (não repita os caminhos).`,
        ...lines,
        playlist && files.length >= maxItens ? `(parou no limite de ${maxItens} vídeos da playlist; peça max_itens maior, até ${this.maxItems}, se quiser mais)` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
}
