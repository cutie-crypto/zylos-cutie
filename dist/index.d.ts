/**
 * src/index.ts — service entry，PM2 拉起。
 *
 * 启动顺序：
 *   1. 读 ~/zylos/.env（KOL 配置过的 token / 自定义 server_url）
 *   2. 读组件 config.json
 *   3. 探测 sandbox + runtime（即便 post-install 已经写过，这里也要重检——KOL 可能在
 *      service 启动后才装 claude / codex CLI，post-install 时还不可用）
 *   4. 写 srt-settings.json（若不存在）+ ensureCodexHome
 *   5. paired? 是 → 起 ZylosCutieConnection；否 → idle wait（等 cutie-pair CLI）
 */
export {};
//# sourceMappingURL=index.d.ts.map