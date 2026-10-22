import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from '../../errors/AppErrors.js';
import type { ImagePart } from '../../llm/types.js';

/** Ficha de personagem (spec image-generation §fichas): a referência que mantém rosto e corpo iguais em toda a história. */
export interface CharacterSheet {
  /** Identificador da pasta: personagem + fase (ex.: "nie-li-adulto"). */
  id: string;
  nome: string;
  obra?: string;
  /** Fase do personagem (idade, época, temporada): cada fase tem corpo, rosto e roupa próprios. */
  fase?: string;
  /** Traços visuais em inglês (cabelo, olhos, roupa, cores, marcas). */
  tags: string;
  /** Tag do Danbooru, quando o modelo de anime conhece o personagem. */
  danbooru?: string;
  /** De onde veio a referência: internet, anexo do usuário ou uma imagem gerada aprovada. */
  origem: 'internet' | 'anexo' | 'imagem-gerada';
  fontes?: string[];
  criadaEm: string;
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
/** Referências por fase (rosto, meio corpo, corpo inteiro...): todas entram juntas no IP-Adapter. */
export const MAX_SHEET_IMAGES = 4;

export const sheetId = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Fichas em `<dados do perfil>/personagens/<id>/` (ficha.json + ref-1.png...), uma pasta por personagem. */
export class CharacterSheets {
  constructor(private readonly dir: string) {}

  list(): CharacterSheet[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory()).flatMap((e) => {
      const sheet = this.read(e.name);
      return sheet ? [sheet] : [];
    });
  }

  get(name: string): CharacterSheet | undefined {
    const id = sheetId(name);
    return this.read(id) ?? this.list().find((s) => sheetId(s.nome) === id);
  }

  /** Todas as fases salvas de um personagem (pelo nome, sem a obra). */
  phases(name: string): CharacterSheet[] {
    const base = sheetId(name);
    return this.list().filter((s) => sheetId(s.nome) === base);
  }

  /** Cria ou substitui a ficha (as imagens antigas saem). */
  save(sheet: Omit<CharacterSheet, 'id' | 'criadaEm'>, images: ImagePart[]): CharacterSheet {
    if (!images.length) throw new UserFacingError('A ficha precisa de ao menos uma imagem de referência.');
    const id = sheetId(sheet.fase ? `${sheet.nome} ${sheet.fase}` : sheet.nome);
    if (!id) throw new UserFacingError('Nome de personagem inválido.');
    const folder = path.join(this.dir, id);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    images.slice(0, MAX_SHEET_IMAGES).forEach((image, i) => fs.writeFileSync(path.join(folder, `ref-${i + 1}${EXT[image.mime] ?? '.png'}`), Buffer.from(image.base64, 'base64')));
    const full: CharacterSheet = { ...sheet, id, criadaEm: new Date().toISOString() };
    fs.writeFileSync(path.join(folder, 'ficha.json'), `${JSON.stringify(full, null, 2)}\n`);
    return full;
  }

  remove(name: string): boolean {
    const sheet = this.get(name);
    if (!sheet) return false;
    fs.rmSync(path.join(this.dir, sheet.id), { recursive: true, force: true });
    return true;
  }

  /** Imagens de referência da ficha, na ordem (ref-1 é a principal). */
  images(sheet: CharacterSheet): Array<{ data: Buffer; name: string; mime: string }> {
    const folder = path.join(this.dir, sheet.id);
    return fs
      .readdirSync(folder)
      .filter((f) => /^ref-\d+\.(png|jpe?g|webp)$/i.test(f))
      .sort()
      .map((f) => ({ data: fs.readFileSync(path.join(folder, f)), name: `${sheet.id}-${f}`, mime: MIME[path.extname(f).toLowerCase()] ?? 'image/png' }));
  }

  private read(id: string): CharacterSheet | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, id, 'ficha.json'), 'utf8')) as CharacterSheet;
    } catch {
      return undefined;
    }
  }
}
