#!/usr/bin/env node
/**
 * cutie-pair CLI — 把 KOL 在 Cutie App 上拿到的 pair_token 兑换成 connector_id +
 * connector_token，落地到 config.json，并把 server 下发的 agents_md / soul_md 缓存。
 *
 * 用法：
 *   cutie-pair <pair_token>
 *   cutie-pair --server https://server.tokenbeep.com <pair_token>
 *
 * 跑完之后 KOL 需要 `pm2 restart zylos-cutie` 让 service 切到 paired 状态启 WSS。
 */
export {};
//# sourceMappingURL=pair.d.ts.map