import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { crc32 } from 'node:zlib';
import { writeZip, zipSize } from '../src/canais/web/ZipStream.js';

/** Lê o diretório central de um .zip: nome, CRC, tamanho e o conteúdo de cada arquivo. */
function readZip(zip: Buffer): Array<{ name: string; crc: number; size: number; data: Buffer }> {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, 'fim do diretório central');
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(pos), 0x02014b50);
    const crc = zip.readUInt32LE(pos + 16);
    const size = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const offset = zip.readUInt32LE(pos + 42);
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLength);
    assert.equal(zip.readUInt32LE(offset), 0x04034b50, 'cabeçalho local');
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26);
    entries.push({ name, crc, size, data: zip.subarray(dataStart, dataStart + size) });
    pos += 46 + nameLength;
  }
  return entries;
}

describe('ZIP do canal web', () => {
  it('monta o .zip com nomes acentuados, CRC certo e o tamanho anunciado; nomes repetidos ganham (2)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
    const a = path.join(dir, 'a.mp3');
    const b = path.join(dir, 'b.mp3');
    fs.writeFileSync(a, Buffer.from('ID3 primeira música'));
    fs.writeFileSync(b, Buffer.alloc(70_000, 7));
    const entries = [
      { name: 'Canção Ótima.mp3', path: a },
      { name: 'Canção Ótima.mp3', path: b },
    ];
    const chunks: Buffer[] = [];
    const sink = new Writable({ write: (chunk, _enc, done) => (chunks.push(chunk as Buffer), done()) });
    await writeZip(sink, entries);
    const zip = Buffer.concat(chunks);
    assert.equal(zip.length, zipSize(entries), 'Content-Length exato');
    const read = readZip(zip);
    assert.deepEqual(read.map((e) => e.name), ['Canção Ótima.mp3', 'Canção Ótima (2).mp3']);
    for (const [i, file] of [a, b].entries()) {
      const content = fs.readFileSync(file);
      assert.ok(read[i]!.data.equals(content));
      assert.equal(read[i]!.crc, crc32(content));
      assert.equal(read[i]!.size, content.length);
    }
  });
});
