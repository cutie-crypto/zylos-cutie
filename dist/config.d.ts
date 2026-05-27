/**
 * 组件配置（持久化在 ~/zylos/components/cutie/config.json）。
 *
 * 字段尽量少：MVP 只需要服务地址 + KOL 标识 + 已 paired 状态。
 * 其他运行期信息走 state/ 子文件（runtime.json / sandbox.json / safety-templates.json）。
 */
export interface ZylosCutieConfig {
    enabled: boolean;
    /** Server HTTP base，例 https://server.tokenbeep.com */
    server_url: string;
    /** Server WS base，例 wss://ws.tokenbeep.com（用 / 开头时与 server_url 拼）*/
    ws_url: string;
    /** register 之后落地（pairing 成功的标志）*/
    paired: boolean;
    connector_id?: string;
    connector_token?: string;
    /** Server 在 register response 里给的实际 ws endpoint，可能覆盖 ws_url */
    ws_endpoint?: string;
    heartbeat_interval_seconds?: number;
    /** AI runner 模型；默认走 server task.payload.agent_model */
    agent_model_default: string;
}
export declare const DEFAULT_CONFIG: ZylosCutieConfig;
export declare function loadConfig(): ZylosCutieConfig;
export declare function saveConfig(cfg: ZylosCutieConfig): void;
//# sourceMappingURL=config.d.ts.map