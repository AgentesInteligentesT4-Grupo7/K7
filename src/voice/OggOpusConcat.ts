import { AudioSynthesisError } from '../errors/AppErrors.js';

/**
 * Junta vários Ogg Opus (um por trecho da fala) num só voice note, com silêncios entre eles, sem ffmpeg:
 * os pacotes Opus são copiados como estão e só as páginas Ogg são refeitas. O silêncio é o quadro Opus
 * de 20 ms de silêncio digital (o mesmo que o Discord usa).
 */

export type OggOpusPart = Buffer | { silenceMs: number };

/** 20 ms de silêncio (TOC 0xf8: CELT banda cheia, 20 ms, mono, 1 quadro). */
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
/** Uma página Ogg tem no máximo 255 entradas de lacing; ~1 s de áudio por página. */
const MAX_PAGE_LACING = 255;
const MAX_PAGE_PACKETS = 50;
const lacingSize = (packet: Buffer) => Math.floor(packet.length / 255) + 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function crc(page: Buffer): number {
  let value = 0;
  for (const byte of page) value = ((value << 8) ^ CRC_TABLE[((value >>> 24) ^ byte) & 0xff]!) >>> 0;
  return value;
}

/** Pacotes de um Ogg (junta os que atravessam páginas). */
export function oggPackets(file: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let partial: Buffer[] = [];
  let offset = 0;
  while (offset + 27 <= file.length) {
    if (file.toString('latin1', offset, offset + 4) !== 'OggS') throw new AudioSynthesisError('Ogg inválido: página sem "OggS"');
    const segments = file[offset + 26]!;
    const table = file.subarray(offset + 27, offset + 27 + segments);
    let data = offset + 27 + segments;
    for (const size of table) {
      partial.push(file.subarray(data, data + size));
      data += size;
      if (size < 255) {
        packets.push(Buffer.concat(partial));
        partial = [];
      }
    }
    offset = data;
  }
  return packets;
}

/** Duração de um pacote Opus em amostras a 48 kHz (RFC 6716, seção 3.1). */
export function opusPacketSamples(packet: Buffer): number {
  if (!packet.length) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  const ms = config < 12 ? [10, 20, 40, 60][config % 4]! : config < 16 ? [10, 20][config % 2]! : [2.5, 5, 10, 20][config % 4]!;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  return ms * 48 * frames;
}

class OggWriter {
  private readonly pages: Buffer[] = [];
  private sequence = 0;
  private readonly serial = Math.floor(Math.random() * 0xffffffff) >>> 0;

  page(packets: Buffer[], granule: bigint, flags: number): void {
    const lacing: number[] = [];
    for (const packet of packets) {
      for (let left = packet.length; ; left -= 255) {
        lacing.push(Math.min(left, 255));
        if (left < 255) break;
      }
    }
    const header = Buffer.alloc(27 + lacing.length);
    header.write('OggS', 0, 'latin1');
    header[5] = flags;
    header.writeBigInt64LE(granule, 6);
    header.writeUInt32LE(this.serial, 14);
    header.writeUInt32LE(this.sequence++, 18);
    header[26] = lacing.length;
    Buffer.from(lacing).copy(header, 27);
    const page = Buffer.concat([header, ...packets]);
    page.writeUInt32LE(crc(page), 22);
    this.pages.push(page);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.pages);
  }
}

export function concatOggOpus(parts: OggOpusPart[]): Buffer {
  let head: Buffer | undefined;
  let tags: Buffer | undefined;
  const audio: Buffer[] = [];
  for (const part of parts) {
    if (!Buffer.isBuffer(part)) {
      for (let ms = 0; ms < part.silenceMs; ms += 20) audio.push(SILENCE_FRAME);
      continue;
    }
    const [opusHead, opusTags, ...packets] = oggPackets(part);
    if (!opusHead || opusHead.toString('latin1', 0, 8) !== 'OpusHead') throw new AudioSynthesisError('Trecho de áudio não é Ogg Opus');
    // Mesmo número de canais em todos os trechos; os cabeçalhos ficam os do primeiro.
    if (head && head[9] !== opusHead[9]) throw new AudioSynthesisError('Trechos de áudio com número de canais diferente');
    head ??= opusHead;
    tags ??= opusTags;
    audio.push(...packets);
  }
  if (!head || !tags) throw new AudioSynthesisError('Nenhum trecho de áudio para juntar');
  return writeOggOpus(head, tags, audio);
}

/** Monta um Ogg Opus a partir dos cabeçalhos (OpusHead, OpusTags) e dos pacotes de áudio. */
export function writeOggOpus(head: Buffer, tags: Buffer, audio: Buffer[]): Buffer {
  const writer = new OggWriter();
  writer.page([head], 0n, 0x02);
  writer.page([tags], 0n, audio.length ? 0 : 0x04);
  let granule = BigInt(head.readUInt16LE(10)); // pre-skip
  let chunk: Buffer[] = [];
  let lacing = 0;
  audio.forEach((packet, index) => {
    chunk.push(packet);
    lacing += lacingSize(packet);
    granule += BigInt(opusPacketSamples(packet));
    const last = index === audio.length - 1;
    const next = audio[index + 1];
    if (last || chunk.length >= MAX_PAGE_PACKETS || lacing + lacingSize(next!) > MAX_PAGE_LACING) {
      writer.page(chunk, granule, last ? 0x04 : 0);
      chunk = [];
      lacing = 0;
    }
  });
  return writer.toBuffer();
}
