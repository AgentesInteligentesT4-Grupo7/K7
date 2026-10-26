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

  /** Registra (ou atualiza) o download: a mesma URL no mesmo formato, do mesmo dono, não vira entrada repetida. */
  add(dono: string, item: { titulo: string; url: string; formato: string; arquivos: string[] }): LibraryEntry | undefined {
    const faixas = item.arquivos.map((file) => ({ nome: path.parse(file).name, arquivo: path.basename(file) }));
    if (!faixas.length) return undefined;
    const existing = this.entries.find((e) => e.dono === dono && e.url === item.url && e.formato === item.formato);
    const entry: LibraryEntry = existing ?? { id: randomBytes(12).toString('hex'), dono, titulo: item.titulo, url: item.url, formato: item.formato, criadoEm: '', faixas: [] };
    Object.assign(entry, { titulo: item.titulo, faixas, criadoEm: new Date().toISOString() });
    if (!existing) this.entries.push(entry);
    this.save();
    return entry;
  }

  /** Entradas do dono, mais recentes primeiro, só com as faixas cujo arquivo ainda existe. */
  list(dono: string): LibraryEntry[] {
    return this.entries
      .filter((e) => e.dono === dono)
      .map((e) => ({ ...e, faixas: e.faixas.filter((t) => fs.existsSync(path.join(this.downloadsDir, t.arquivo))) }))
      .filter((e) => e.faixas.length)
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
