import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from '../../errors/AppErrors.js';
import type { LibraryEntry, MediaLibrary } from './MediaLibrary.js';
import type { DownloadFailure, MediaFormat, YtdlpClient } from './YtdlpClient.js';

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

export interface MediaDownloadRequest {
  /** Link do vídeo ou da playlist; ou `links`, vários vídeos avulsos num só pedido. */
  url?: string;
  links?: string[];
  formato: MediaFormat;
  playlist: boolean;
  maxItens?: number;
  /** Dono da entrada na biblioteca (quem pediu). */
  userId?: string;
  /** Continua uma entrada existente (tentar de novo): as faixas novas se somam às que já estavam. */
  entryId?: string;
}

export interface MediaDownloadOutcome {
  /** Todos os arquivos do pedido, na ordem (novos e reaproveitados). */
  files: string[];
  fresh: number;
  reused: number;
  failures: DownloadFailure[];
  entry?: LibraryEntry;
}

/**
 * Downloads do módulo midia, usado pela ferramenta baixar_youtube (via agente) e pelo botão "tentar de novo"
 * do chat (direto, sem o modelo). Pula o que já foi baixado, mantém a ordem da playlist e atualiza a biblioteca
 * a cada arquivo pronto, para a playlist crescer na tela enquanto baixa.
 */
export class MediaDownloader {
  constructor(
    private readonly client: YtdlpClient,
    private readonly workspaceDir: string,
    readonly library?: MediaLibrary,
  ) {}

  get downloadsDir(): string {
    return path.join(this.workspaceDir, 'downloads');
  }

  async download(request: MediaDownloadRequest, onProgress?: (progress: string) => void): Promise<MediaDownloadOutcome> {
    const { formato, userId } = request;
    const index = DownloadIndex.load(this.downloadsDir);
    const known = index.ids(formato);
    const previous = request.entryId && userId && this.library ? this.library.files(userId, request.entryId) : [];
    let entry: LibraryEntry | undefined = request.entryId && userId ? this.library?.get(userId, request.entryId) : undefined;
    const label = request.links?.length ? `${request.links.length} link(s) de ${new Date().toLocaleDateString('pt-BR')}` : undefined;

    // Ordem: a da playlist (os downloads em paralelo terminam fora de ordem); sem ID, vai para o fim.
    const arrange = (fresh: Array<{ path: string; id?: string }>, skipped: string[], order: string[]) => {
      for (const file of fresh) if (file.id) index.add(file.id, formato, file.path);
      const reused = skipped.flatMap((id) => index.file(id, formato) ?? []);
      const ordered = order.flatMap((id) => index.file(id, formato) ?? []).filter((f) => fresh.some((x) => x.path === f) || reused.includes(f));
      return { files: [...new Set([...previous, ...ordered, ...fresh.map((f) => f.path), ...reused])], reused };
    };
    const record = (files: string[], title: string | undefined, failures?: DownloadFailure[]) => {
      if (!userId || !this.library) return;
      const titulo = entry?.titulo ?? title ?? label ?? (files.length ? path.parse(files[0]!).name : 'Download');
      entry = this.library.add(userId, { titulo, url: entry?.url ?? request.url ?? '', formato, arquivos: files, ...(failures ? { falhas: failures } : {}) }, entry?.id) ?? entry;
    };

    const result = await this.client.download(
      { url: request.url ?? '', ...(request.links?.length ? { links: request.links } : {}), formato, playlist: request.playlist, maxItens: request.maxItens, pular: known },
      this.downloadsDir,
      onProgress,
      // Cada arquivo pronto já entra na biblioteca (o chat mostra a playlist crescendo).
      (partial) => {
        record(arrange(partial.files, partial.skipped, partial.order ?? []).files, partial.title);
        index.save();
      },
    );
    const { files, reused } = arrange(result.files, result.skipped, result.order ?? []);
    index.save();
    record(files, result.title, result.failures);
    return { files, fresh: result.files.length, reused: reused.length, failures: result.failures, ...(entry ? { entry } : {}) };
  }

  /** Baixa de novo só os links que falharam na entrada; os que voltarem a falhar continuam na lista. */
  async retry(userId: string, entryId: string, onProgress?: (progress: string) => void): Promise<MediaDownloadOutcome> {
    const entry = this.library?.get(userId, entryId);
    if (!entry) throw new UserFacingError('Playlist não encontrada.');
    const links = [...new Set((entry.falhas ?? []).flatMap((f) => (f.link ? [f.link] : [])))];
    if (!links.length) throw new UserFacingError('Não há links com falha para tentar de novo.');
    return this.download({ links, formato: entry.formato as MediaFormat, playlist: false, userId, entryId }, onProgress);
  }
}
