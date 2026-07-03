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
export interface AtomicWriteOptions {
    /** 文件权限；未指定时沿用已存在目标文件的权限（目标不存在才落到 fs.writeFileSync 默认值） */
    mode?: number;
    /** rename 前是否给已存在的旧文件留一份 `.bak`（默认 true，仅当旧文件存在时生效） */
    backup?: boolean;
}
export declare function atomicWriteFileSync(filePath: string, content: string, opts?: AtomicWriteOptions): void;
//# sourceMappingURL=atomic-fs.d.ts.map