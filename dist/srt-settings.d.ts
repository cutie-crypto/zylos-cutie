/**
 * srt-settings.ts — SRT 沙箱配置生成。
 *
 * 13-SPIKE-RESULT §3 实测策略：
 *   - 网络白名单只包含 AI provider API + OAuth 必需域名；非白名单一律 403
 *   - 文件读策略：denyRead 把 ~/.ssh / ~/.aws / ~/zylos/memory / ~/.zylos 都拒掉
 *     （deny-then-allow，可在需要时 allowRead 精确放回）
 *   - 文件写策略：allowWrite 仅 cwd + /tmp + 组件 state；Codex 托管模式允许
 *     CLI 写平台维护的 ~/.codex，避免复制 credential 与平台刷新机制竞争。
 *   - 平台差异：macOS Seatbelt 不支持嵌套；Linux bwrap 用 mount 隔离，被拒文件
 *     表现为 ENOENT 而非 EPERM（runner 错误分类时要兼容）
 */
export interface SrtSettings {
    network: {
        allowedDomains: string[];
        deniedDomains: string[];
    };
    filesystem: {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
    };
}
/**
 * 默认 SRT settings。runtime 决定 Codex 凭据目录写策略：
 *   - 有 OPENAI_API_KEY/CODEX_API_KEY 时走隔离 CODEX_HOME（用户自带 key / 未来 broker env）
 *   - 没有 env key 时走 COCO/Zylos 平台维护的 ~/.codex
 *
 * @param runtime 'claude' / 'codex'
 */
export declare function buildDefaultSrtSettings(runtime: 'claude' | 'codex'): SrtSettings;
export declare function writeSrtSettings(settings: SrtSettings): string;
/**
 * 准备 Codex 凭据模式。
 *
 * 默认 COCO/Zylos 托管路径：不读取、不复制、不刷新 ~/.codex/auth.json；
 * 仅确认平台 credential 文件存在，runner 直接调用 codex CLI，让 CLI 使用平台维护
 * 的真实 ~/.codex。这样不会和 COCO 的 token 刷新机制产生独立 auth 副本竞争。
 *
 * 可选用户 API key 路径：如果显式设置 OPENAI_API_KEY/CODEX_API_KEY，则写入
 * 隔离 CODEX_HOME，runner 会设置 CODEX_HOME=$DATA_DIR/codex-home。
 *
 * **HIGH-7 修复**：凭据不可用时，写 `codex-home-status.json` 显式标
 * unavailable + 原因。runner.ts 启动前读这个文件，看到 unavailable 就提前 fail closed
 * 报 `RUNNER_UNAVAILABLE`，而不是让 codex 跑起来后用空 auth.json 被错归 RUNNER_FAILURE。
 */
export declare function ensureCodexHome(_claudeFallbackBin: string | null, codexBin: string | null): void;
//# sourceMappingURL=srt-settings.d.ts.map