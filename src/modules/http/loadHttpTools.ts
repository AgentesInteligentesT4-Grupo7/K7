import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { HttpTool, type HttpTransport } from './HttpTool.js';
import { parseHttpToolSpec } from './HttpToolSpec.js';

const logger = new Logger('Http');

/**
 * Lê `ferramentas/*.yaml` do perfil (módulo "http"). Arquivo inválido é ignorado com aviso
 * (como uma skill com YAML ruim): o resto do perfil continua funcionando.
 */
export function loadHttpTools(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
  reserved: ReadonlySet<string> = new Set(),
  transport?: HttpTransport,
): HttpTool[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch {
    return [];
  }
  const tools: HttpTool[] = [];
  const names = new Set(reserved);
  for (const file of files) {
    const source = path.join(dir, file);
    try {
      const spec = parseHttpToolSpec(fs.readFileSync(source, 'utf8'), source);
      if (names.has(spec.nome)) throw new Error(`${source}: já existe uma ferramenta chamada "${spec.nome}"`);
      if (spec.autenticacao && !env[spec.autenticacao.variavel]?.trim()) {
        logger.warn(`🔑 ${spec.nome}: preencha ${spec.autenticacao.variavel} no .env do perfil (a ferramenta falhará até lá)`);
      }
      names.add(spec.nome);
      tools.push(new HttpTool(spec, env, transport));
    } catch (error) {
      logger.warn(`Ferramenta ignorada: ${errorMessage(error)}`);
    }
  }
  return tools;
}
