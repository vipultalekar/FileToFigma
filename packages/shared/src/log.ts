export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function createLogger(scope: string) {
  const emit = (level: LogLevel, args: unknown[]) => {
    if (ORDER[level] < ORDER[threshold]) return;
    const fn =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[w2f:${scope}]`, ...args);
  };
  return {
    debug: (...a: unknown[]) => emit('debug', a),
    info: (...a: unknown[]) => emit('info', a),
    warn: (...a: unknown[]) => emit('warn', a),
    error: (...a: unknown[]) => emit('error', a),
  };
}

/** Simple stage timer used to check the PRD section 11 budgets. */
export class Stopwatch {
  private readonly marks: { stage: string; ms: number }[] = [];
  private last = Date.now();

  mark(stage: string): void {
    const now = Date.now();
    this.marks.push({ stage, ms: now - this.last });
    this.last = now;
  }

  get timings(): { stage: string; ms: number }[] {
    return this.marks;
  }

  get totalMs(): number {
    return this.marks.reduce((a, b) => a + b.ms, 0);
  }
}
