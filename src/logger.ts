/**
 * logger — 极简 stdout/stderr logger。
 *
 * PM2 会接管 stdout/stderr 写到 ~/zylos/components/cutie/logs/{out,error}.log。
 * 不引入 winston / pino 之类，避免增加依赖面（11-IMPL §13.5 的"敏感信息不入日志"
 * 是规则，不是 logger 框架的事）。
 */

const LEVEL = (process.env['CUTIE_LOG_LEVEL'] || 'info').toLowerCase();
const LEVELS = ['debug', 'info', 'warn', 'error'];
const minIdx = LEVELS.indexOf(LEVEL);
const enabled = (lvl: string) => LEVELS.indexOf(lvl) >= (minIdx >= 0 ? minIdx : 1);

function ts(): string {
  return new Date().toISOString();
}

function fmt(level: string, msg: string, args: unknown[]): string {
  if (args.length === 0) return `${ts()} [${level}] ${msg}`;
  const tail = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
  return `${ts()} [${level}] ${msg} ${tail}`;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const log = {
  debug: (msg: string, ...args: unknown[]) => {
    if (enabled('debug')) console.log(fmt('debug', msg, args));
  },
  info: (msg: string, ...args: unknown[]) => {
    if (enabled('info')) console.log(fmt('info', msg, args));
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (enabled('warn')) console.warn(fmt('warn', msg, args));
  },
  error: (msg: string, ...args: unknown[]) => {
    console.error(fmt('error', msg, args));
  },
};
