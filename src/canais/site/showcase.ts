import { listProfiles, profileDirs } from '../../profiles/ProfileLoader.js';
import type { ShowcaseTape } from './SiteServer.js';

/** Fitas da vitrine do site: só as com `vitrine: true` no perfil.yaml (e que carregam sem erro). */
export function showcaseTapes(env: NodeJS.ProcessEnv = process.env, rootDir = process.cwd()): ShowcaseTape[] {
  return listProfiles(profileDirs(env, rootDir)).flatMap(({ name, manifest }) =>
    manifest?.vitrine
      ? [{ nome: name, titulo: manifest.identidade.nome ?? name, emoji: manifest.identidade.emoji ?? '📼', descricao: manifest.descricao }]
      : [],
  );
}
