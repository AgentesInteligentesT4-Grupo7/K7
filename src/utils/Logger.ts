export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: COLORS.gray,
  info: COLORS.cyan,
  warn: COLORS.yellow,
  error: COLORS.red,
};

/**
 * Logger simples para stdout com escopo, nível mínimo e cores.
 * O nível global é definido uma vez no startup via `Logger.setLevel`.
 */
export class Logger {
  private static minLevel: LogLevel = 'info';

  constructor(private readonly scope: string) {}

  static setLevel(level: string | undefined): void {
    if (level && level in LEVEL_WEIGHT) Logger.minLevel = level as LogLevel;
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`);
  }

  debug(message: string, ...extra: unknown[]): void {
    this.write('debug', message, extra);
  }

  info(message: string, ...extra: unknown[]): void {
    this.write('info', message, extra);
  }

  warn(message: string, ...extra: unknown[]): void {
    this.write('warn', message, extra);
  }

  error(message: string, ...extra: unknown[]): void {
    this.write('error', message, extra);
  }

  private write(level: LogLevel, message: string, extra: unknown[]): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[Logger.minLevel]) return;
    const now = new Date();
    const time = `${now.toLocaleTimeString('pt-BR', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    const prefix = `${COLORS.gray}${time}${COLORS.reset} ${LEVEL_COLOR[level]}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${COLORS.magenta}[${this.scope}]${COLORS.reset}`;
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    out(`${prefix} ${message}`, ...extra);
  }
}

/** Encurta strings longas para logs legíveis. */
export function preview(text: string | null | undefined, max = 300): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}… (+${flat.length - max} chars)` : flat;
}
