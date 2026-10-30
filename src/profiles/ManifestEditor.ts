import type { TelegramAccessMode } from '../config/Config.js';
import type { ChannelId } from '../modules/registry.js';
import { ProfileError, parseManifest } from './ProfileManifest.js';

export interface ManifestChanges {
  vitrine?: boolean;
  canais?: ChannelId[];
  /** Liga ou desliga a extensão comentando a linha `extensao:` (o caminho fica guardado no comentário). */
  extensaoLigada?: boolean;
  telegramAcesso?: TelegramAccessMode;
}

const TOP_LEVEL = /^([a-z_]+):(.*)$/;
const COMMENTED_EXTENSION = /^#\s*extensao:\s*(\S.*)$/;

/**
 * Edita o `perfil.yaml` mexendo só nas linhas das chaves alteradas: comentários, ordem e o resto do arquivo ficam
 * como a pessoa escreveu. O resultado é validado antes de ser devolvido (erro = nada muda).
 */
export function editManifest(text: string, changes: ManifestChanges): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  if (changes.vitrine !== undefined) lines = setKey(lines, 'vitrine', [`vitrine: ${changes.vitrine}`]);
  if (changes.canais !== undefined) {
    if (!changes.canais.length) throw new ProfileError('a fita precisa de pelo menos um canal');
    lines = setKey(lines, 'canais', [`canais: [${changes.canais.join(', ')}]`]);
  }
  if (changes.extensaoLigada !== undefined) lines = toggleExtension(lines, changes.extensaoLigada);
  if (changes.telegramAcesso !== undefined) {
    const current = parseManifest(lines.join('\n')).telegram ?? {};
    lines = setKey(lines, 'telegram', [
      'telegram:',
      `  acesso: ${changes.telegramAcesso}`,
      ...(current.pedidos !== undefined ? [`  pedidos: ${current.pedidos}`] : []),
      ...(current.limiteHora !== undefined ? [`  limite_hora: ${current.limiteHora}`] : []),
    ]);
  }
  const result = lines.join(eol);
  parseManifest(result); // valida: um perfil.yaml quebrado nunca é gravado
  return result;
}

/** Linhas que pertencem à chave de topo em `start` (a própria e as indentadas que vêm depois). */
function blockEnd(lines: string[], start: number): number {
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]!) || (lines[end]!.trim() === '' && /^\s+\S/.test(lines[end + 1] ?? '')))) end++;
  return end;
}

function setKey(lines: string[], key: string, replacement: string[]): string[] {
  const start = lines.findIndex((line) => TOP_LEVEL.exec(line)?.[1] === key);
  if (start < 0) {
    // Chave nova: no fim, antes das linhas em branco finais.
    let end = lines.length;
    while (end > 0 && lines[end - 1]!.trim() === '') end--;
    return [...lines.slice(0, end), ...replacement, ...lines.slice(end)];
  }
  return [...lines.slice(0, start), ...replacement, ...lines.slice(blockEnd(lines, start))];
}

function toggleExtension(lines: string[], on: boolean): string[] {
  const active = lines.findIndex((line) => TOP_LEVEL.exec(line)?.[1] === 'extensao');
  if (!on) {
    if (active < 0) return lines;
    const copy = [...lines];
    copy[active] = `# ${copy[active]}`;
    return copy;
  }
  if (active >= 0) return lines;
  const commented = lines.findIndex((line) => COMMENTED_EXTENSION.test(line));
  if (commented < 0) throw new ProfileError('esta fita não tem extensão para ligar (falta a linha "extensao:" no perfil.yaml)');
  const copy = [...lines];
  copy[commented] = `extensao: ${COMMENTED_EXTENSION.exec(copy[commented]!)![1]}`;
  return copy;
}

/** A fita tem extensão desligada (linha `# extensao: ...`)? */
export function disabledExtension(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = COMMENTED_EXTENSION.exec(line);
    if (match) return match[1]!.trim();
  }
  return undefined;
}
