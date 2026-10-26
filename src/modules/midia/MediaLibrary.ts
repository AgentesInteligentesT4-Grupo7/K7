import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Faixa de uma entrada: nome para mostrar e arquivo na pasta de downloads. */
export interface LibraryTrack {
  nome: string;
  arquivo: string;
}

export interface LibraryEntry {
  /** Aleatório e imprevisível: é ele que libera o áudio/vídeo no navegador (sem token no modo público). */
  id: string;
  dono: string;
  titulo: string;
  url: string;
  formato: string;
  criadoEm: string;
  faixas: LibraryTrack[];
  /** Links que falharam no último download (excluído, privado, bloqueado...): o botão "tentar de novo" usa estes. */
  falhas?: Array<{ link: string | null; motivo: string }>;
  /** Todas as faixas passaram pelo nivelamento de volume. */
  nivelada?: boolean;
}

/**
 * Biblioteca dos downloads (módulo midia): cada pedido vira uma entrada com as faixas na ordem da playlist,
 * registrada no nome de quem pediu. No chat público, cada visitante só vê as próprias entradas.
 * Fica em `<workspace>/biblioteca.json`; os arquivos continuam em `<workspace>/downloads` (sem cópias).
 */
export class MediaLibrary {
  private readonly file: string;
  private entries: LibraryEntry[];

  constructor(private readonly workspaceDir: string) {
    this.file = path.join(workspaceDir, 'biblioteca.json');
    try {
      this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LibraryEntry[];
    } catch {
      this.entries = [];
    }
  }

  get downloadsDir(): string {
    return path.join(this.workspaceDir, 'downloads');
  }

  /**
   * Registra (ou atualiza) o download. Com `entryId`, atualiza aquela entrada do dono (download em andamento ou
   * "tentar de novo"); sem ele, a mesma URL no mesmo formato, do mesmo dono, não vira entrada repetida.
   * `falhas`, quando vem, substitui as anteriores.
   */
  add(
    dono: string,
    item: { titulo: string; url: string; formato: string; arquivos: string[]; falhas?: LibraryEntry['falhas'] },
    entryId?: string,
  ): LibraryEntry | undefined {
    const faixas = item.arquivos.map((file) => ({ nome: path.parse(file).name, arquivo: path.basename(file) }));
    const existing = entryId
      ? this.entries.find((e) => e.dono === dono && e.id === entryId)
      : item.url
        ? this.entries.find((e) => e.dono === dono && e.url === item.url && e.formato === item.formato)
        : undefined;
    if (!faixas.length && !existing && !item.falhas?.length) return undefined;
    const entry: LibraryEntry = existing ?? { id: randomBytes(12).toString('hex'), dono, titulo: item.titulo, url: item.url, formato: item.formato, criadoEm: '', faixas: [] };
    if (existing && faixas.some((t) => !existing.faixas.some((old) => old.arquivo === t.arquivo))) entry.nivelada = false;
    Object.assign(entry, { titulo: item.titulo, faixas, criadoEm: new Date().toISOString() });
    if (item.falhas) entry.falhas = item.falhas;
    if (!existing) this.entries.push(entry);
    this.save();
    return entry;
  }

  /** A entrada do dono (com as faixas como estão gravadas), para continuar ou tentar de novo. */
  get(dono: string, id: string): LibraryEntry | undefined {
    return this.entries.find((e) => e.dono === dono && e.id === id);
  }

  /** Arquivos das faixas que ainda existem, na ordem (para o .zip e para juntar com as novas). */
  files(dono: string, id: string): string[] {
    return (this.get(dono, id)?.faixas ?? []).map((t) => path.join(this.downloadsDir, path.basename(t.arquivo))).filter((f) => fs.existsSync(f));
  }

  /** Entradas do dono, mais recentes primeiro, só com as faixas cujo arquivo ainda existe. */
  list(dono: string): LibraryEntry[] {
    return this.entries
      .filter((e) => e.dono === dono)
      .map((e) => ({ ...e, faixas: e.faixas.filter((t) => fs.existsSync(path.join(this.downloadsDir, t.arquivo))) }))
      .filter((e) => e.faixas.length || e.falhas?.length)
      .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  }

  /** Tira da biblioteca do dono (os arquivos ficam: podem estar em outra playlist ou ser de outro visitante). */
  remove(dono: string, id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.dono === dono && e.id === id));
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  /** Título e arquivos de uma entrada pelo id (imprevisível, como o das faixas): o .zip da playlist inteira. */
  bundle(id: string): { titulo: string; arquivos: Array<{ name: string; path: string }> } | undefined {
    if (!/^[0-9a-f]{24}$/.test(id)) return undefined;
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return undefined;
    const arquivos = entry.faixas
      .map((t) => ({ name: path.basename(t.arquivo), path: path.join(this.downloadsDir, path.basename(t.arquivo)) }))
      .filter((f) => fs.existsSync(f.path));
    return { titulo: entry.titulo, arquivos };
  }

  /**
   * Arquivos renomeados ou unidos na pasta de downloads (padronização): as faixas passam a apontar para o nome
   * novo; duas faixas que viraram o mesmo arquivo ficam uma só.
   */
  renameFiles(renames: Map<string, string>): void {
    let changed = false;
    for (const entry of this.entries) {
      const seen = new Set<string>();
      const faixas: LibraryTrack[] = [];
      for (const track of entry.faixas) {
        const arquivo = renames.get(track.arquivo) ?? track.arquivo;
        if (arquivo !== track.arquivo) changed = true;
        if (seen.has(arquivo)) {
          changed = true;
          continue;
        }
        seen.add(arquivo);
        faixas.push({ nome: path.parse(arquivo).name, arquivo });
      }
      entry.faixas = faixas;
    }
    if (changed) this.save();
  }

  /** Marca a entrada do dono como nivelada (o botão some até chegar faixa nova). */
  markLeveled(dono: string, id: string, leveled = true): void {
    const entry = this.get(dono, id);
    if (!entry) return;
    entry.nivelada = leveled;
    this.save();
  }

  /** Posição da faixa na entrada (a URL usa a posição original, que não muda quando um arquivo some). */
  indexOf(id: string, arquivo: string): number {
    return this.entries.find((e) => e.id === id)?.faixas.findIndex((t) => t.arquivo === arquivo) ?? -1;
  }

  /** Caminho da faixa `index` da entrada `id`, se existir. */
  track(id: string, index: number): { path: string; nome: string } | undefined {
    if (!/^[0-9a-f]{24}$/.test(id)) return undefined;
    const track = this.entries.find((e) => e.id === id)?.faixas[index];
    if (!track) return undefined;
    const full = path.join(this.downloadsDir, path.basename(track.arquivo));
    return fs.existsSync(full) ? { path: full, nome: track.arquivo } : undefined;
  }

  private save(): void {
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 1));
    fs.renameSync(tmp, this.file);
  }
}
