import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ProfileError } from './ProfileManifest.js';

/**
 * Extrai um `.tgz` (formato do `npm pack`) sem depender do `tar` do sistema.
 * Só arquivos e pastas: links simbólicos/físicos e caminhos fora do destino são recusados.
 */
export function extractTarball(tgzPath: string, destDir: string, options: { stripPrefix?: string } = {}): string[] {
  const data = zlib.gunzipSync(fs.readFileSync(tgzPath));
  const root = path.resolve(destDir);
  const written: string[] = [];
  let offset = 0;
  let longName: string | undefined;

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156]!) || '0';
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    // Nomes longos: cabeçalho PAX ("x") ou GNU ("L") antes da entrada.
    if (type === 'x') {
      const match = /\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
      if (match) longName = match[1];
      continue;
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'g') continue;

    const prefix = field(header, 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type === '1' || type === '2') throw new ProfileError(`Pacote recusado: contém link (${name})`);
    if (type !== '0' && type !== '\0' && type !== '5') continue;

    if (options.stripPrefix) {
      if (!name.startsWith(options.stripPrefix)) continue;
      name = name.slice(options.stripPrefix.length);
    }
    if (!name) continue;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new ProfileError(`Pacote recusado: caminho fora do destino (${name})`);

    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      written.push(path.relative(root, target));
    }
  }
  return written;
}

function field(header: Buffer, start: number, length: number): string {
  return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}
