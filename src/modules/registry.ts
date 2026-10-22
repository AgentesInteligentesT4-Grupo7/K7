import fs from 'node:fs';
import path from 'node:path';

/**
 * Módulos do tocador (spec profiles-modules RF-01/RF-02). Cada perfil liga os que quiser;
 * um módulo desligado não registra ferramentas, comandos nem skills.
 * O código dos módulos mora no tocador; as skills de cada módulo, em `modulos/<id>/skills/`.
 */
export interface ModuleDefinition {
  id: string;
  descricao: string;
}

export const MODULES: readonly ModuleDefinition[] = [
  { id: 'arquivos', descricao: 'Ferramentas de arquivos no workspace (criar, ler, listar)' },
  { id: 'voz', descricao: 'Mensagens de voz: transcrição (Whisper) e respostas em áudio (Kokoro/Edge)' },
  { id: 'voz-clonada', descricao: 'Clonagem de voz (Chatterbox): /minhavoz, /falar e skill voz-clonada' },
  { id: 'refinamento', descricao: 'Loop criador ↔ crítico com modelos distintos (skill idealizador-analisador)' },
  { id: 'http', descricao: 'Ferramentas HTTP declaradas pelo perfil em ferramentas/*.yaml (APIs REST, sem código)' },
];

export const MODULE_IDS: readonly string[] = MODULES.map((m) => m.id);

/** Todos os módulos: comportamento de quando nenhum perfil é usado (retrocompatível). */
export const DEFAULT_MODULES = MODULE_IDS.join(',');

export const CHANNELS = ['telegram', 'terminal'] as const;
export type ChannelId = (typeof CHANNELS)[number];

/** Pastas de skills dos módulos ligados (só as que existem). */
export function moduleSkillDirs(rootDir: string, enabled: Iterable<string>): string[] {
  const dirs: string[] = [];
  for (const id of enabled) {
    const dir = path.resolve(rootDir, 'modulos', id, 'skills');
    if (fs.existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}
