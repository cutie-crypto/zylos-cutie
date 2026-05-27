/**
 * sandbox-detect — 探测 SRT 沙箱底座是否可用。
 *
 * 跨 macOS / Linux：
 *   macOS: `sandbox-exec` 系统自带，**不需要 ripgrep**（spike 实测 + SRT 0.0.50
 *          源码 macos-sandbox-utils.js 注释 "no ripgrep needed on macOS"）
 *   Linux: 需要 bwrap + socat + ripgrep；并检查 Ubuntu 24.04+ 的
 *          `kernel.apparmor_restrict_unprivileged_userns`，启用时 bwrap user
 *          namespace 创建会失败，提前 fail closed 而不是无声崩溃。
 *
 * 探测结果按 13-SPIKE-RESULT §6 fail-closed 矩阵的契约写到 sandbox.json，
 * runner 启动每个 task 之前读它的 status 字段。
 */
export type SandboxStatus = 'ok' | 'SANDBOX_UNAVAILABLE';
export interface SandboxDetectResult {
    status: SandboxStatus;
    platform: NodeJS.Platform;
    /** macOS: sandbox-exec 路径；Linux: bwrap 路径；其他平台 null */
    primary_bin: string | null;
    /** 缺哪些工具（仅 Linux） */
    missing: string[];
    /** Linux only: AppArmor 状态描述（'restricting' / 'permissive' / 'not-present' / 'n/a'） */
    apparmor: string;
    /** Linux only: kernel.apparmor_restrict_unprivileged_userns 的值（true=禁、false=放行、null=不存在） */
    apparmor_restrict_unprivileged_userns: boolean | null;
    hint?: string;
}
export declare function detectSandbox(): SandboxDetectResult;
//# sourceMappingURL=sandbox-detect.d.ts.map