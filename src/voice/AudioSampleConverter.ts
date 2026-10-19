import { OggOpusDecoder } from 'ogg-opus-decoder';
import { UserFacingError } from '../errors/AppErrors.js';

export interface ReferenceAudio {
  buffer: Buffer;
  /** Formato aceito pelo Chatterbox como referência. */
  extension: 'wav' | 'mp3';
  /** Duração em segundos, quando conhecida. */
  durationSeconds: number | null;
}

export class UnsupportedAudioFormatError extends UserFacingError {
  constructor(extension: string) {
    super(`Formato de áudio .${extension} não suportado para clonagem. Use voice note do Telegram, .ogg, .mp3 ou .wav.`);
  }
}

const OGG_EXTENSIONS = new Set(['ogg', 'oga', 'opus']);

/**
 * Converte o áudio recebido para WAV/MP3, os formatos que o Chatterbox aceita como
 * referência. Voice notes do Telegram (OGG/Opus) são decodificados em WebAssembly,
 * sem depender de ffmpeg no Windows.
 */
export class AudioSampleConverter {
  async toReferenceAudio(buffer: Buffer, extension: string): Promise<ReferenceAudio> {
    const ext = extension.replace(/^\./, '').toLowerCase();
    if (OGG_EXTENSIONS.has(ext) || AudioSampleConverter.isOgg(buffer)) {
      const decoder = new OggOpusDecoder();
      try {
        await decoder.ready;
        const decoded = await decoder.decodeFile(new Uint8Array(buffer));
        if (decoded.samplesDecoded === 0) throw new UserFacingError('Não consegui ler esse áudio (OGG vazio ou corrompido).');
        return {
          buffer: AudioSampleConverter.encodeWav(decoded.channelData, decoded.sampleRate),
          extension: 'wav',
          durationSeconds: decoded.samplesDecoded / decoded.sampleRate,
        };
      } finally {
        decoder.free();
      }
    }
    if (ext === 'wav') return { buffer, extension: 'wav', durationSeconds: AudioSampleConverter.wavDuration(buffer) };
    if (ext === 'mp3') return { buffer, extension: 'mp3', durationSeconds: null };
    throw new UnsupportedAudioFormatError(ext || 'desconhecido');
  }

  static isOgg(buffer: Buffer): boolean {
    return buffer.subarray(0, 4).toString('latin1') === 'OggS';
  }

  /** WAV PCM 16 bits mono (mixa os canais). */
  static encodeWav(channels: Float32Array[], sampleRate: number): Buffer {
    const length = channels[0]?.length ?? 0;
    const data = Buffer.alloc(length * 2);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i] ?? 0;
      const sample = Math.max(-1, Math.min(1, sum / channels.length));
      data.writeInt16LE(Math.round(sample * 0x7fff), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1');
    header.writeUInt32LE(16, 16); // tamanho do bloco fmt
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits por amostra
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  }

  /** Duração de um WAV PCM a partir do cabeçalho (null se não reconhecer). */
  static wavDuration(buffer: Buffer): number | null {
    if (buffer.length < 44 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('latin1', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'fmt ') byteRate = buffer.readUInt32LE(offset + 16);
      if (id === 'data') return byteRate > 0 ? size / byteRate : null;
      offset += 8 + size + (size % 2);
    }
    return null;
  }
}
