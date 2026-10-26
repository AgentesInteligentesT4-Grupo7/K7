import fs from 'node:fs';
import path from 'node:path';
import { ProgressBoard } from '../../agent/ProgressBoard.js';
import { ResponseAttachments } from '../../agent/ResponseAttachments.js';
import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../../tools/BaseTool.js';
import { Logger } from '../../utils/Logger.js';
import { MediaDownloader } from './MediaDownloader.js';
import type { MediaLibrary } from './MediaLibrary.js';
import type { MediaFormat, YtdlpClient } from './YtdlpClient.js';

const YOUTUBE = /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\//i;
/** Arquivos listados um a um na resposta da ferramenta (playlists inteiras não lotam o contexto do modelo). */
const MAX_LISTED = 20;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Andamento para a tela: "⬇️ Baixando 120 de 400…" com os números para a barra de %. */
export function publishProgress(userId: string | undefined, progress: string): void {
  if (!userId) return;
  const [done, total] = progress.split('/');
  const counts = total && total !== '?' ? { done: Number(done), total: Number(total) } : undefined;
  ProgressBoard.set(userId, counts ? `⬇️ Baixando ${done} de ${total}…` : '⬇️ Lendo a playlist…', counts);
}

/**
 * baixar_youtube (módulo midia): baixa áudio (MP3/WAV) ou vídeo (MP4) de um link, de vários links ou de uma
 * playlist do YouTube para `<workspace>/downloads` e entrega os arquivos pelo canal (Telegram, terminal ou navegador).
 */
export class DownloadMediaTool extends BaseTool {
  readonly name = 'baixar_youtube';
  readonly description =
    'Baixa áudio (mp3 ou wav) ou vídeo (mp4) de um link do YouTube, de vários links de uma vez, ou de todos os vídeos de uma playlist, ' +
    'e entrega os arquivos ao usuário. Só links youtube.com, youtu.be ou music.youtube.com.';
  readonly parameters: JsonSchema;
  /** O mesmo serviço de download usado pelo chat (ex.: "tentar de novo" os links que falharam). */
  readonly downloader: MediaDownloader;
  private readonly logger = new Logger('Midia');

  /**
   * @param maxItems teto de vídeos por playlist (MIDIA_MAX_ITENS); 0 = sem limite.
   * @param library biblioteca do chat (barra lateral e tocador); cada download vira uma entrada de quem pediu.
   */
  constructor(
    client: YtdlpClient,
    workspaceDir: string,
    private readonly maxItems = 0,
    library?: MediaLibrary,
  ) {
    super();
    this.downloader = new MediaDownloader(client, workspaceDir, library);
    this.parameters = {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Link do vídeo ou da playlist no YouTube (um só).' },
        links: { type: 'array', items: { type: 'string' }, description: 'Vários links de vídeos de uma vez (em vez de url): baixados juntos, numa só lista.' },
        formato: { type: 'string', enum: ['mp3', 'wav', 'mp4'], description: 'mp3 (áudio, padrão), wav (áudio sem perda) ou mp4 (vídeo).' },
        playlist: { type: 'boolean', description: 'true para baixar os vídeos da playlist do link; false (padrão) só o vídeo.' },
        max_itens: {
          type: 'integer',
          description: `Só se o usuário pedir uma quantidade ("os 10 primeiros"); sem ele, a playlist inteira${maxItems ? ` (até ${maxItems})` : ''}.`,
        },
      },
      additionalProperties: false,
    };
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const links = Array.isArray(args.links) ? [...new Set(args.links.map((l) => String(l).trim()).filter(Boolean))] : [];
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url && !links.length) throw new ToolArgumentError('Informe o link (url) ou os links.');
    if (![url, ...links].filter(Boolean).every((l) => YOUTUBE.test(l))) throw new ToolArgumentError('Só links do YouTube (youtube.com, youtu.be, music.youtube.com).');
    const formato = (typeof args.formato === 'string' ? args.formato : 'mp3') as MediaFormat;
    // Link só de playlist (sem v=): baixa a playlist mesmo que o modelo esqueça de pedir.
    const playlist = !links.length && (args.playlist === true || (/[?&]list=/.test(url) && !/[?&]v=|youtu\.be\//.test(url)));
    const asked = Number(args.max_itens) > 0 ? Math.floor(Number(args.max_itens)) : undefined;
    // Sem pedido e sem teto configurado: a playlist inteira.
    const maxItens = this.maxItems ? Math.min(this.maxItems, asked ?? this.maxItems) : asked;

    const started = Date.now();
    // O canal mostra o andamento enquanto espera ("Baixando 120 de 400…"): playlists inteiras levam minutos.
    const userId = TaskContext.current()?.userId;
    const { files, fresh, reused, failures } = await this.downloader
      .download({ ...(links.length ? { links } : { url }), formato, playlist, maxItens, ...(userId ? { userId } : {}) }, (progress) => {
        this.logger.info(`⬇️ ${formato} ${progress}`);
        publishProgress(userId, progress);
      })
      .finally(() => userId && ProgressBoard.clear(userId));

    const kind = formato === 'mp4' ? 'video' : 'audio';
    for (const file of files) ResponseAttachments.addMedia({ path: file, kind });
    this.logger.info(`✅ ${fresh} novo(s) e ${reused} reaproveitado(s), ${formato}, em ${Math.round((Date.now() - started) / 1000)} s`);

    const lines = files.slice(0, MAX_LISTED).map((file) => `- ${path.basename(file)} (${mb(fs.statSync(file).size)})`);
    if (files.length > MAX_LISTED) lines.push(`- ... e mais ${files.length - MAX_LISTED}`);
    return {
      output: [
        `ok: ${files.length} arquivo(s) ${formato.toUpperCase()}: ${fresh} baixado(s) agora e ${reused} que já tinham sido baixados antes ` +
          `(reaproveitados, sem baixar de novo). Os arquivos já são entregues ao usuário junto da sua resposta e aparecem na biblioteca (não repita os caminhos).`,
        ...lines,
        playlist && maxItens && fresh >= maxItens ? `(parou em ${maxItens} vídeos da playlist${this.maxItems ? `, o teto de MIDIA_MAX_ITENS` : ''})` : '',
        failures.length
          ? `\n${failures.length} vídeo(s) com problema foram pulados. INFORME AO USUÁRIO cada um, com o link e o motivo, ` +
            `e que dá para tentar de novo só esses pelo botão da playlist na biblioteca:\n` +
            failures.map((f) => `- ${f.link ?? '(sem link)'}: ${f.motivo}`).join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
}
