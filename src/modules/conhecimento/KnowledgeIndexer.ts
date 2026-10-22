import fs from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { PdfExtractor } from '../../documents/DocumentExtractor.js';
import { errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { type ChunkOptions, DEFAULT_CHUNKS, chunkText } from './Chunker.js';
import { type IEmbeddings, describeEmbeddingsError } from './Embeddings.js';
import type { KnowledgeStore } from './KnowledgeStore.js';

/** Raízes da base: a da fita (só leitura, vem com ela) e a do usuário (o que ele guarda pelo chat). */
export interface KnowledgeRoot {
  label: 'fita' | 'usuario';
  dir: string;
}

export interface KnowledgeBaseInfo {
  name: string;
  description: string;
  language?: string;
  documents: number;
}

export const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.pdf']);
const REGISTRY_FILE = 'bases.yaml';
const BASE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** Arquivos na raiz de conhecimento/ (fora de subpasta) pertencem a esta base. */
export const DEFAULT_BASE = 'geral';

export const baseName = (raw: string) =>
  raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || DEFAULT_BASE;

export interface IndexerOptions {
  chunk?: ChunkOptions;
  /** Intervalo mínimo entre varreduras automáticas da pasta (a busca dispara uma se passou disso). */
  rescanMs?: number;
  embeddings?: () => Promise<IEmbeddings | undefined>;
}

/**
 * Mantém o índice em dia com as pastas (spec knowledge-base §5.1): só reprocessa arquivos novos ou
 * alterados (tamanho/mtime), remove os apagados e gera vetores para os trechos que ainda não têm.
 */
export class KnowledgeIndexer {
  private readonly logger = new Logger('Conhecimento');
  private readonly pdf = new PdfExtractor();
  private running: Promise<void> | undefined;
  private lastSync = 0;
  private embedPausedUntil = 0;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly roots: KnowledgeRoot[],
    private readonly options: IndexerOptions = {},
  ) {}

  /** Registro de bases: `bases.yaml` (descrição e idioma) + subpastas existentes. */
  bases(): KnowledgeBaseInfo[] {
    const info = new Map<string, KnowledgeBaseInfo>();
    for (const root of this.roots) {
      for (const [name, meta] of Object.entries(this.registry(root.dir))) {
        info.set(name, { name, description: meta.descricao ?? '', ...(meta.idioma ? { language: meta.idioma } : {}), documents: 0 });
      }
    }
    for (const doc of this.store.documents()) {
      const base = info.get(doc.base) ?? { name: doc.base, description: '', documents: 0 };
      base.documents++;
      info.set(doc.base, base);
    }
    return [...info.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Varre as pastas (no máximo uma por vez; `force` ignora o intervalo mínimo). */
  async sync(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastSync < (this.options.rescanMs ?? 30_000)) return;
    this.running = this.doSync().finally(() => {
      this.running = undefined;
      this.lastSync = Date.now();
    });
    return this.running;
  }

  private async doSync(): Promise<void> {
    const seen = new Set<string>();
    const known = new Map(this.store.documents().map((d) => [d.key, d]));
    let changed = 0;
    for (const root of this.roots) {
      for (const file of this.walk(root.dir)) {
        const rel = path.relative(root.dir, file).split(path.sep).join('/');
        const key = `${root.label}:${rel}`;
        seen.add(key);
        const stat = fs.statSync(file);
        const doc = known.get(key);
        if (doc && doc.size === stat.size && Math.abs(doc.mtimeMs - stat.mtimeMs) < 1) continue;
        const base = rel.includes('/') ? baseName(rel.split('/')[0]!) : DEFAULT_BASE;
        try {
          const text = await this.extract(file);
          this.store.replaceDocument({ key, base, mtimeMs: stat.mtimeMs, size: stat.size }, chunkText(text, this.options.chunk ?? DEFAULT_CHUNKS));
          changed++;
        } catch (error) {
          this.logger.warn(`Não consegui ler ${rel}: ${errorMessage(error)}`);
        }
      }
    }
    for (const key of known.keys()) {
      if (!seen.has(key)) {
        this.store.removeDocument(key);
        changed++;
      }
    }
    if (changed) this.logger.info(`📚 Base de conhecimento: ${changed} arquivo(s) atualizado(s); ${this.store.stats().chunks} trechos`);
    await this.embedPending();
  }

  /** Gera vetores em lotes; erro (cota, Ollama fora) pausa por 10 min e a busca segue só por palavras. */
  async embedPending(): Promise<void> {
    if (Date.now() < this.embedPausedUntil || this.store.stats().chunks === 0) return;
    const provider = await this.options.embeddings?.();
    if (!provider) return;
    let total = 0;
    for (;;) {
      const pending = this.store.pendingEmbeddings(provider.model, provider.batchSize);
      if (!pending.length) break;
      try {
        const vectors = await provider.embed(pending.map((p) => p.text), 'documento');
        this.store.saveEmbeddings(provider.model, pending.map((p, i) => ({ id: p.id, vector: vectors[i]! })));
        total += pending.length;
      } catch (error) {
        this.embedPausedUntil = Date.now() + 10 * 60_000;
        this.logger.warn(`⚠️ ${describeEmbeddingsError(provider, error)}`);
        break;
      }
    }
    if (total) this.logger.info(`🧭 ${total} trecho(s) com vetores (${provider.name}: ${provider.model})`);
  }

  private registry(dir: string): Record<string, { descricao?: string; idioma?: string }> {
    const file = path.join(dir, REGISTRY_FILE);
    if (!fs.existsSync(file)) return {};
    try {
      const raw = parseYaml(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
      const out: Record<string, { descricao?: string; idioma?: string }> = {};
      for (const [name, meta] of Object.entries(raw ?? {})) {
        const key = baseName(name);
        if (!BASE_NAME.test(key)) continue;
        const record = typeof meta === 'string' ? { descricao: meta } : ((meta ?? {}) as Record<string, unknown>);
        out[key] = {
          ...(record.descricao ? { descricao: String(record.descricao).trim() } : {}),
          ...(record.idioma ? { idioma: String(record.idioma).trim() } : {}),
        };
      }
      return out;
    } catch (error) {
      this.logger.warn(`${REGISTRY_FILE} inválido em ${dir}: ${errorMessage(error).split('\n')[0]}`);
      return {};
    }
  }

  private *walk(dir: string, depth = 0): Generator<string> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) yield* this.walk(full, depth + 1);
      else if (entry.isFile() && entry.name !== REGISTRY_FILE && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (fs.statSync(full).size <= MAX_FILE_BYTES) yield full;
      }
    }
  }

  private async extract(file: string): Promise<string> {
    return path.extname(file).toLowerCase() === '.pdf' ? this.pdf.extract(file) : fs.promises.readFile(file, 'utf8');
  }
}
