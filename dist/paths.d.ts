/**
 * 组件路径常量。
 *
 * Zylos 标准目录约定（见 zylos-component-template）：
 *   ~/zylos/.claude/skills/<name>/   组件源码 + node_modules（PM2 cwd）
 *   ~/zylos/components/<name>/       组件 data dir（state / knowledge / logs / config）
 *   ~/zylos/.zylos/config.json       Zylos runtime 全局配置（runtime / paths…）
 *   ~/zylos/.env                     Zylos 全局 env，组件 src/index.ts 启动时 dotenv 加载
 *
 * **测试隔离 / 自定义部署**：
 *   - `CUTIE_DATA_DIR` 环境变量覆盖整个 components/cutie/ 路径（review HIGH-3 修复）
 *   - tests/setup.ts 启动时 set 这个变量到 tmpdir，避免污染 KOL 真实数据目录
 *   - 生产 KOL 不需要设这个变量；运维如果想把组件数据放在非 ~/zylos 下也能用
 */
export declare const ZYLOS_HOME: string;
export declare const COMPONENT_SRC_DIR: string;
/**
 * Resolve at module load. 后续 set CUTIE_DATA_DIR 不会改变已 frozen 的常量——
 * 测试要在 import 任何组件源码前 set env，否则导入次序会让 vitest 测试间互相污染。
 * tests/setup.ts 在 vitest globalSetup 阶段 set，比所有测试文件先跑。
 */
export declare const DATA_DIR: string;
export declare const STATE_DIR: string;
export declare const KNOWLEDGE_DIR: string;
export declare const LOGS_DIR: string;
export declare const CONFIG_FILE: string;
export declare const ZYLOS_GLOBAL_CONFIG: string;
export declare const ZYLOS_ENV_FILE: string;
export declare const RUNTIME_DETECT_FILE: string;
export declare const SANDBOX_DETECT_FILE: string;
export declare const SAFETY_TEMPLATES_FILE: string;
export declare const SRT_SETTINGS_FILE: string;
/** 可选 CODEX_HOME 隔离目录（仅显式 OPENAI_API_KEY / CODEX_API_KEY 路径使用） */
export declare const CODEX_HOME: string;
/** ensureCodexHome 写凭据模式 / unavailable 原因；runner 启动前读决定要不要 fail closed */
export declare const CODEX_HOME_STATUS_FILE: string;
//# sourceMappingURL=paths.d.ts.map