import { writeOggOpus } from '../../src/voice/OggOpusConcat.js';

/**
 * Ogg Opus mono de `ms` milissegundos de silêncio (quadros de 20 ms), no formato do voice note do Telegram
 * e do que o Chatterbox devolve. Os testes não guardam amostras de voz de verdade no repositório.
 */
export function silentOgg(ms: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48_000, 12);
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.alloc(8)]);
  return writeOggOpus(head, tags, Array.from({ length: Math.round(ms / 20) }, () => Buffer.from([0xf8, 0xff, 0xfe])));
}
