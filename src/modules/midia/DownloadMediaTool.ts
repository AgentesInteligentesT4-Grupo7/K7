import fs from 'node:fs';
import path from 'node:path';
import { ProgressBoard } from '../../agent/ProgressBoard.js';
import { ResponseAttachments } from '../../agent/ResponseAttachments.js';
import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../../tools/BaseTool.js';
import { Logger } from '../../utils/Logger.js';
import type { MediaLibrary } from './MediaLibrary.js';
import type { MediaFormat, YtdlpClient } from './YtdlpClient.js';

const YOUTUBE = /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\//i;
/** Arquivos listados um a um na resposta da ferramenta (playlists inteiras não lotam o contexto do modelo). */
const MAX_LISTED = 20;

/**
 * Índice dos downloads da pasta (`.k7-indice.json`): ID do vídeo + formato → arquivo. É o que evita baixar
 * de novo a mesma música; o ID (11 caracteres do link) já existe antes do download, ao contrário de um hash.
 */
class DownloadIndex {
  private constructor(
    private readonly file_: string,
    private readonly entries: Record<string, string>,
  ) {}

  static load(dir: string): DownloadIndex {
    const file = path.join(dir, '.k7-indice.json');
    try {
      return new DownloadIndex(file, JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>);
    } catch {
      return new DownloadIndex(file, {});
    }
  }

  /** IDs com arquivo ainda presente na pasta (apagou o arquivo? baixa de novo). */
  ids(format: string): string[] {
    return Object.keys(this.entries)
      .filter((key) => key.endsWith(`.${format}`) && this.file(key.slice(0, -format.length - 1), format))
      .map((key) => key.slice(0, -format.length - 1));
  }

  file(id: string, format: string): string | undefined {
    const name = this.entries[`${id}.${format}`];
    const full = name && path.join(path.dirname(this.file_), name);
    return full && fs.existsSync(full) ? full : undefined;
  }

  add(id: string, format: string, filePath: string): void {
    this.entries[`${id}.${format}`] = path.basename(filePath);
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file_), { recursive: true });
    fs.writeFileSync(this.file_, JSON.stringify(this.entries, null, 1));
  }
}
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

  /**
   * @param maxItems teto de vídeos por playlist (MIDIA_MAX_ITENS); 0 = sem limite.
   * @param library biblioteca do chat (barra lateral e tocador); cada download vira uma entrada de quem pediu.
   */
  constructor(
    private readonly client: YtdlpClient,
    private readonly workspaceDir: string,
    private readonly maxItems = 0,
    private readonly library?: MediaLibrary,
  ) {
    super();
    this.parameters = {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Link do vídeo ou da playlist no YouTube.' },
        formato: { type: 'string', enum: ['mp3', 'wav', 'mp4'], description: 'mp3 (áudio, padrão), wav (áudio sem perda) ou mp4 (vídeo).' },
        playlist: { type: 'boolean', description: 'true para baixar os vídeos da playlist do link; false (padrão) só o vídeo.' },
        max_itens: {
          type: 'integer',
          description: `Só se o usuário pedir uma quantidade ("os 10 primeiros"); sem ele, a playlist inteira${maxItems ? ` (até ${maxItems})` : ''}.`,
        },
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
    const asked = Number(args.max_itens) > 0 ? Math.floor(Number(args.max_itens)) : undefined;
    // Sem pedido e sem teto configurado: a playlist inteira.
    const maxItens = this.maxItems ? Math.min(this.maxItems, asked ?? this.maxItems) : asked;
    const targetDir = path.join(this.workspaceDir, 'downloads');
    // Já baixados antes neste formato (pelo ID do vídeo): o serviço pula e o arquivo existente é entregue de novo.
    const index = DownloadIndex.load(targetDir);
    const known = index.ids(formato);

    const started = Date.now();
    // O canal mostra o andamento enquanto espera ("Baixando 120 de 400…"): playlists inteiras levam minutos.
    const userId = TaskContext.current()?.userId;
    const { files: fresh, failures, skipped, title, order } = await this.client
      .download({ url, formato, playlist, maxItens, pular: known }, targetDir, (progress) => {
        this.logger.info(`⬇️ ${formato} ${progress}`);
        const [done, total] = progress.split('/');
        const counts = total && total !== '?' ? { done: Number(done), total: Number(total) } : undefined;
        if (userId) ProgressBoard.set(userId, counts ? `⬇️ Baixando ${done} de ${total}…` : '⬇️ Lendo a playlist…', counts);
      })
      .finally(() => userId && ProgressBoard.clear(userId));
    for (const file of fresh) if (file.id) index.add(file.id, formato, file.path);
    index.save();
    const reused = skipped.flatMap((id) => index.file(id, formato) ?? []);
    // Na ordem da playlist (os downloads em paralelo terminam fora de ordem); sem ID, vai para o fim.
    const ordered = (order ?? []).flatMap((id) => index.file(id, formato) ?? []);
    const files = [...new Set([...ordered, ...fresh.map((f) => f.path), ...reused])];
    if (userId && this.library) {
      const single = files.length === 1 ? path.parse(files[0]!).name : undefined;
      this.library.add(userId, { titulo: title ?? single ?? `Downloads de ${new Date().toLocaleDateString('pt-BR')}`, url, formato, arquivos: files });
    }

    const kind = formato === 'mp4' ? 'video' : 'audio';
    for (const file of files) ResponseAttachments.addMedia({ path: file, kind });
    this.logger.info(`✅ ${fresh.length} novo(s) e ${reused.length} reaproveitado(s), ${formato}, em ${Math.round((Date.now() - started) / 1000)} s`);

    const lines = files.slice(0, MAX_LISTED).map((file) => `- ${path.basename(file)} (${mb(fs.statSync(file).size)})`);
    if (files.length > MAX_LISTED) lines.push(`- ... e mais ${files.length - MAX_LISTED}`);
    return {
      output: [
        `ok: ${files.length} arquivo(s) ${formato.toUpperCase()}: ${fresh.length} baixado(s) agora e ${reused.length} que já tinham sido baixados antes ` +
          `(reaproveitados, sem baixar de novo). Os arquivos já são entregues ao usuário junto da sua resposta (não repita os caminhos).`,
        ...lines,
        playlist && maxItens && fresh.length >= maxItens ? `(parou em ${maxItens} vídeos da playlist${this.maxItems ? `, o teto de MIDIA_MAX_ITENS` : ''})` : '',
        failures.length
          ? `\n${failures.length} vídeo(s) com problema foram pulados. INFORME AO USUÁRIO cada um, com o link e o motivo:\n` +
            failures.map((f) => `- ${f.link ?? '(sem link)'}: ${f.motivo}`).join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
}
