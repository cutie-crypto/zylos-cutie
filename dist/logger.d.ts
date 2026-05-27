/**
 * logger — 极简 stdout/stderr logger。
 *
 * PM2 会接管 stdout/stderr 写到 ~/zylos/components/cutie/logs/{out,error}.log。
 * 不引入 winston / pino 之类，避免增加依赖面（11-IMPL §13.5 的"敏感信息不入日志"
 * 是规则，不是 logger 框架的事）。
 */
export declare const log: {
    debug: (msg: string, ...args: unknown[]) => void;
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
};
//# sourceMappingURL=logger.d.ts.map