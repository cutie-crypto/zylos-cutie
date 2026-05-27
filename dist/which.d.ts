/**
 * 同步 PATH 查找——用于 post-install 探测时不能用 await。
 * 避免依赖 npm `which` 包，减少安装期不必要的依赖。
 */
export declare function whichSync(cmd: string): string | null;
//# sourceMappingURL=which.d.ts.map