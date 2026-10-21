import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from '../errors/AppErrors.js';
import type { AudioSampleConverter, ReferenceAudio } from './AudioSampleConverter.js';

export interface VoiceSample {
  /** Nome da voz = nome do arquivo sem extensão (ex.: "agro"). */
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
    if (!found) throw new VoiceNotFoundError(`Voz "${wanted}" não encontrada. Disponíveis: ${voices.map((v) => v.name).join(', ')}.`);
    return found;
  }

  /** Converte e salva uma amostra; substitui a voz de mesmo nome. */
  async save(name: string, buffer: Buffer, sourceExtension: string): Promise<{ sample: VoiceSample; durationSeconds: number | null }> {
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
    return { sample: { name: voiceName, filePath }, durationSeconds: audio.durationSeconds };
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
