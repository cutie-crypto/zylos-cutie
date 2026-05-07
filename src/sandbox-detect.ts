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

import fs from 'node:fs';
import { whichSync } from './which.js';

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

const APPARMOR_USERNS_FILE = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

export function detectSandbox(): SandboxDetectResult {
  const platform = process.platform;

  if (platform === 'darwin') {
    const sandboxExec = whichSync('sandbox-exec');
    return {
      status: sandboxExec ? 'ok' : 'SANDBOX_UNAVAILABLE',
      platform,
      primary_bin: sandboxExec,
      missing: sandboxExec ? [] : ['sandbox-exec'],
      apparmor: 'n/a',
      apparmor_restrict_unprivileged_userns: null,
      ...(sandboxExec ? {} : { hint: 'macOS sandbox-exec missing — system corruption?' }),
    };
  }

  if (platform === 'linux') {
    const bwrap = whichSync('bwrap');
    const rg = whichSync('rg');
    const socat = whichSync('socat');
    const missing: string[] = [];
    if (!bwrap) missing.push('bwrap');
    if (!rg) missing.push('rg');
    if (!socat) missing.push('socat');

    // AppArmor 检查（仅 Ubuntu 24.04+ 有这个 sysctl）
    let apparmor = 'not-present';
    let apparmorRestricts: boolean | null = null;
    try {
      const v = fs.readFileSync(APPARMOR_USERNS_FILE, 'utf8').trim();
      apparmorRestricts = v === '1';
      apparmor = apparmorRestricts ? 'restricting' : 'permissive';
    } catch {
      // 文件不存在 = 旧内核 / 无 AppArmor（CentOS / 旧 Ubuntu / Debian），放行
    }

    const usernsBlocked = apparmorRestricts === true;
    const ok = missing.length === 0 && !usernsBlocked;
    const hints: string[] = [];
    if (missing.length > 0) {
      hints.push(`missing tools: ${missing.join(', ')} — install via apt / dnf`);
    }
    if (usernsBlocked) {
      hints.push(
        'AppArmor restricts unprivileged user namespaces (Ubuntu 24.04+ default). ' +
        'KOL must (a) configure /etc/apparmor.d/cutie-bwrap profile, or ' +
        '(b) run: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0',
      );
    }

    return {
      status: ok ? 'ok' : 'SANDBOX_UNAVAILABLE',
      platform,
      primary_bin: bwrap,
      missing,
      apparmor,
      apparmor_restrict_unprivileged_userns: apparmorRestricts,
      ...(hints.length > 0 ? { hint: hints.join(' | ') } : {}),
    };
  }

  return {
    status: 'SANDBOX_UNAVAILABLE',
    platform,
    primary_bin: null,
    missing: [],
    apparmor: 'n/a',
    apparmor_restrict_unprivileged_userns: null,
    hint: `unsupported platform: ${platform}`,
  };
}
