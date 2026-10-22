import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from '../errors/AppErrors.js';
import type { AudioSampleConverter, ReferenceAudio } from './AudioSampleConverter.js';
import { type VoiceParams, sanitizeParams } from './VoiceParams.js';

export interface VoiceSample {
  /** Nome da voz = nome do arquivo sem extensão (ex.: "parreira"). */
  name: string;
  filePath: string;
}

export interface VoiceLibraryOptions {
  /** Pasta das amostras (VOICE_CLONE_DIR). Arquivos colocados aqui manualmente também viram vozes. */
  dir: string;
  /** Voz usada quando nenhuma é informada (VOICE_CLONE_DEFAULT). */
  defaultVoice?: string;
  minSeconds?: number;
  maxSeconds?: number;
}

const SUPPORTED = new Set(['.wav', '.mp3', '.ogg', '.oga', '.opus']);

export class VoiceNotFoundError extends UserFacingError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Biblioteca de vozes clonáveis numa pasta local. Cada arquivo de áudio é uma voz:
 * os que chegam pelo Telegram são salvos já convertidos (WAV) e os colocados à mão
 * (.wav, .mp3, .ogg) são convertidos na hora do uso.
 */
export class VoiceLibrary {
  private readonly minSeconds: number;
  private readonly maxSeconds: number;

  constructor(
    private readonly options: VoiceLibraryOptions,
    private readonly converter: AudioSampleConverter,
  ) {
    this.minSeconds = options.minSeconds ?? 4;
    this.maxSeconds = options.maxSeconds ?? 120;
  }

  get dir(): string {
    return this.options.dir;
  }

  list(): VoiceSample[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.options.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => ({ name: path.parse(entry.name).name, filePath: path.join(this.options.dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Apaga a voz pelo nome exato (sem a padrão como atalho: apagar exige dizer qual).
   * Remove todos os arquivos com esse nome (.wav, .mp3, .ogg...) e avisa se era a voz padrão.
   */
  remove(name: string): { removed: string; wasDefault: boolean; remaining: VoiceSample[] } {
    const key = VoiceLibrary.sanitizeName(name);
    const voices = this.list();
    const matches = voices.filter((voice) => voice.name.toLowerCase() === key);
    if (!key || matches.length === 0) {
      const available = voices.map((v) => v.name).join(', ');
      throw new VoiceNotFoundError(`Voz "${name.trim()}" não encontrada.${available ? ` Disponíveis: ${available}.` : ' Nenhuma voz cadastrada.'}`);
    }
    for (const voice of matches) fs.rmSync(voice.filePath, { force: true });
    fs.rmSync(this.paramsPath(matches[0]!.name), { force: true });
    return {
      removed: matches[0]!.name,
      wasDefault: VoiceLibrary.sanitizeName(this.options.defaultVoice ?? '') === key,
      remaining: this.list(),
    };
  }

  /** Ajustes de fala da voz (`<nome>.json` ao lado do áudio); sem arquivo = padrão do servidor. */
  params(name: string): VoiceParams {
    try {
      return sanitizeParams(JSON.parse(fs.readFileSync(this.paramsPath(name), 'utf8')));
    } catch {
      return {};
    }
  }

  saveParams(name: string, params: VoiceParams): void {
    fs.mkdirSync(this.options.dir, { recursive: true });
    fs.writeFileSync(this.paramsPath(name), `${JSON.stringify(sanitizeParams(params), null, 2)}\n`);
  }

  /** Grava uma amostra já convertida (ex.: a do teste espelho) como voz permanente. */
  saveReference(name: string, reference: ReferenceAudio): VoiceSample {
    const voiceName = VoiceLibrary.sanitizeName(name);
    if (!voiceName) throw new UserFacingError('Nome de voz inválido. Use letras, números e hífen (ex.: minha-voz).');
    fs.mkdirSync(this.options.dir, { recursive: true });
    for (const existing of this.list().filter((voice) => voice.name.toLowerCase() === voiceName)) fs.rmSync(existing.filePath, { force: true });
    const filePath = path.join(this.options.dir, `${voiceName}.${reference.extension}`);
    fs.writeFileSync(filePath, reference.buffer);
    return { name: voiceName, filePath };
  }

  private paramsPath(name: string): string {
    return path.join(this.options.dir, `${VoiceLibrary.sanitizeName(name)}.json`);
  }

  /** Resolve a voz pelo nome (sem diferenciar maiúsculas); sem nome usa a padrão ou a única existente. */
  resolve(name?: string): VoiceSample {
    const voices = this.list();
    if (voices.length === 0) {
      throw new VoiceNotFoundError('Nenhuma voz cadastrada ainda. Use /minhavoz e envie um áudio de 10 a 30 segundos.');
    }
    const wanted = name?.trim() || this.options.defaultVoice?.trim();
    if (!wanted) {
      if (voices.length === 1) return voices[0]!;
      throw new VoiceNotFoundError(`Há ${voices.length} vozes (${voices.map((v) => v.name).join(', ')}). Diga qual usar ou defina VOICE_CLONE_DEFAULT.`);
    }
    const key = VoiceLibrary.sanitizeName(wanted);
    const found = voices.find((voice) => voice.name.toLowerCase() === key);
    if (found) return found;
    const available = voices.map((v) => v.name).join(', ');
    if (!name?.trim()) {
      // A voz padrão (VOICE_CLONE_DEFAULT) foi apagada: com uma voz só, ela é a escolha óbvia.
      if (voices.length === 1) return voices[0]!;
      throw new VoiceNotFoundError(`A voz padrão "${wanted}" não existe mais. Diga qual usar (ex.: /falar @${voices[0]!.name} texto). Disponíveis: ${available}.`);
    }
    throw new VoiceNotFoundError(`Voz "${wanted}" não encontrada. Disponíveis: ${available}.`);
  }

  /** Converte e salva uma amostra; substitui a voz de mesmo nome. */
  async save(name: string, buffer: Buffer, sourceExtension: string): Promise<{ sample: VoiceSample; durationSeconds: number | null; trimmedFromSeconds?: number }> {
    const voiceName = VoiceLibrary.sanitizeName(name);
    if (!voiceName) throw new UserFacingError('Nome de voz inválido. Use letras, números e hífen (ex.: minha-voz).');

    const audio = await this.converter.toReferenceAudio(buffer, sourceExtension);
    if (audio.durationSeconds !== null && audio.durationSeconds < this.minSeconds) {
      throw new UserFacingError(`Áudio muito curto (${audio.durationSeconds.toFixed(1)}s). Envie de 10 a 30 segundos falando naturalmente.`);
    }
    if (audio.durationSeconds !== null && audio.durationSeconds > this.maxSeconds) {
      throw new UserFacingError(`Áudio muito longo (${audio.durationSeconds.toFixed(0)}s). Envie de 10 a 30 segundos.`);
    }

    fs.mkdirSync(this.options.dir, { recursive: true });
    for (const existing of this.list().filter((voice) => voice.name.toLowerCase() === voiceName)) {
      fs.rmSync(existing.filePath, { force: true });
    }
    const filePath = path.join(this.options.dir, `${voiceName}.${audio.extension}`);
    fs.writeFileSync(filePath, audio.buffer);
    return { sample: { name: voiceName, filePath }, durationSeconds: audio.durationSeconds, ...(audio.trimmedFromSeconds ? { trimmedFromSeconds: audio.trimmedFromSeconds } : {}) };
  }

  /** Lê a amostra já no formato aceito pelo Chatterbox (converte .ogg colocado à mão). */
  async load(sample: VoiceSample): Promise<ReferenceAudio> {
    return this.converter.toReferenceAudio(fs.readFileSync(sample.filePath), path.extname(sample.filePath));
  }

  /** "Minha Voz!" → "minha-voz". */
  static sanitizeName(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }
}
