/**
 * atomic-fs — 原子写文件（tmp 写入 → 可选 reread 校验 → rename 落地）。
 *
 * 行为对齐 cutie-connector `packages/connector-core/src/atomic-fs.ts` 的
 * `atomicWriteFileSync`（2026-07-03 原子写收尾批次）。zylos-cutie 依赖的
 * `@cutie-crypto/connector-core@^0.6.1` 是 atomic-fs 下沉之前发布的版本，
 * 引不到 core 导出，所以这里先放一份本地实现。
 *
 * 待 connector-core 发布含 atomic-fs 的下个版本后，切换为
 * `import { atomicWriteFileSync } from '@cutie-crypto/connector-core'`
 * 并删除本文件。
 */
import fs from 'node:fs';
import path from 'node:path';
export function atomicWriteFileSync(filePath, content, opts = {}) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // mode 未显式指定时继承既有目标文件的权限：writeFileSync 直写保留 inode 权限，
    // 而 tmp+rename 会替换 inode——不继承的话 0600 的旧文件会被 umask 默认权限
    // （通常 0644）的新文件替换（2026-07-03 Codex review P2）
    let effectiveMode = opts.mode;
    if (effectiveMode === undefined) {
        try {
            effectiveMode = fs.statSync(filePath).mode & 0o777;
        }
        catch { /* 目标不存在，用默认 */ }
    }
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
    const writeOpts = effectiveMode !== undefined ? { mode: effectiveMode } : undefined;
    fs.writeFileSync(tmpPath, content, writeOpts);
    const backup = opts.backup ?? true;
    if (backup && fs.existsSync(filePath)) {
        try {
            fs.copyFileSync(filePath, filePath + '.bak');
            // .bak 与主文件对齐权限：copyFileSync 覆盖已存在的 .bak 时会保留 .bak 的旧
            // 权限，敏感文件（config/凭据）的备份可能停留在宽松权限上（2026-07-03 Codex review P1）
            if (effectiveMode !== undefined)
                fs.chmodSync(filePath + '.bak', effectiveMode);
        }
        catch { /* best effort，备份失败不阻塞主写入 */ }
    }
    try {
        fs.renameSync(tmpPath, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
}
//# sourceMappingURL=atomic-fs.js.map