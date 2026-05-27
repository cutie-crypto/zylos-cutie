/**
 * 组件配置（持久化在 ~/zylos/components/cutie/config.json）。
 *
 * 字段尽量少：MVP 只需要服务地址 + KOL 标识 + 已 paired 状态。
 * 其他运行期信息走 state/ 子文件（runtime.json / sandbox.json / safety-templates.json）。
 */
import fs from 'node:fs';
import { CONFIG_FILE } from './paths.js';
export const DEFAULT_CONFIG = {
    enabled: true,
    server_url: 'https://server.tokenbeep.com',
    ws_url: 'wss://ws.tokenbeep.com/connector/v1',
    paired: false,
    agent_model_default: 'claude-sonnet-4-6',
};
export function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
}
export function saveConfig(cfg) {
    // HIGH-6：connector_token 是 KOL ↔ Server 凭证，必须 0o600（只有当前用户可读）。
    // 同主机其他用户能看到 token = 能假冒该 KOL connector 接 task → 泄漏 KOL 关注者
    // 提问内容 + 在 KOL 名义下走 server-side filter_output 后入 task.result 表。
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    // 二次保险：writeFileSync mode 仅在 file 不存在时生效（已存在时不改 mode）
    try {
        fs.chmodSync(CONFIG_FILE, 0o600);
    }
    catch {
        // chmod 失败（如 Windows 文件系统）静默；CONFIG_FILE 在 ~/zylos/components/cutie/
        // 已经被 KOL home 目录的 0o755 兜住一层
    }
}
//# sourceMappingURL=config.js.map