import { once } from 'node:events';
import fs from 'node:fs';
import type { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';

/**
 * ZIP sem compressão (método "store"), escrito enquanto é enviado: MP3/MP4 já são comprimidos, então comprimir de
 * novo só gastaria CPU. Os arquivos não passam inteiros pela memória. Sem ZIP64: o pacote precisa ficar abaixo de 4 GB.
 */

export interface ZipEntry {
  /** Nome dentro do .zip. */
  name: string;
  /** Caminho do arquivo no disco. */
  path: string;
}

const MAX_ZIP32 = 0xffffffff;
const UTF8_NAMES = 0x0800;

export class ZipTooLargeError extends Error {
  constructor() {
    super('O pacote passaria de 4 GB; baixe os arquivos separadamente.');
  }
}

/** Nomes únicos dentro do .zip ("música.mp3", "música (2).mp3"...). */
function uniqueNames(entries: ZipEntry[]): ZipEntry[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    const dot = entry.name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [entry.name.slice(0, dot), entry.name.slice(dot)] : [entry.name, ''];
    let name = entry.name;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
    used.add(name.toLowerCase());
    return { ...entry, name };
  });
}

/** Tamanho exato do .zip (para o Content-Length e a barra de progresso do navegador). */
export function zipSize(entries: ZipEntry[]): number {
  let total = 22;
  for (const entry of uniqueNames(entries)) {
    const name = Buffer.byteLength(entry.name);
    total += 30 + name + fs.statSync(entry.path).size + 46 + name;
  }
  if (total > MAX_ZIP32) throw new ZipTooLargeError();
  return total;
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function fileCrc(path: string): Promise<number> {
  let crc = 0;
  for await (const chunk of fs.createReadStream(path)) crc = crc32(chunk as Buffer, crc);
  return crc;
}

async function write(out: Writable, data: Buffer): Promise<void> {
  if (!out.write(data)) await once(out, 'drain');
}

export async function writeZip(out: Writable, entries: ZipEntry[]): Promise<void> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of uniqueNames(entries)) {
    const stat = fs.statSync(entry.path);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = await fileCrc(entry.path);
    const { time, date } = dosDateTime(stat.mtime);
    if (offset + 30 + name.length + stat.size > MAX_ZIP32) throw new ZipTooLargeError();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versão necessária
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stat.size, 18);
    local.writeUInt32LE(stat.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    await write(out, Buffer.concat([local, name]));
    for await (const chunk of fs.createReadStream(entry.path)) await write(out, chunk as Buffer);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // feito por
    header.writeUInt16LE(20, 6); // versão necessária
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(stat.size, 20);
    header.writeUInt32LE(stat.size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + stat.size;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = central.length / 2;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(out, Buffer.concat([directory, end]));
}
