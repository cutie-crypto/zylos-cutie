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

import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const COMPONENT_NAME = 'cutie';

export const ZYLOS_HOME = path.join(HOME, 'zylos');
export const COMPONENT_SRC_DIR = path.join(ZYLOS_HOME, '.claude/skills', COMPONENT_NAME);
/**
 * Resolve at module load. 后续 set CUTIE_DATA_DIR 不会改变已 frozen 的常量——
 * 测试要在 import 任何组件源码前 set env，否则导入次序会让 vitest 测试间互相污染。
 * tests/setup.ts 在 vitest globalSetup 阶段 set，比所有测试文件先跑。
 */
export const DATA_DIR = process.env['CUTIE_DATA_DIR']?.trim()
  || path.join(ZYLOS_HOME, 'components', COMPONENT_NAME);
export const STATE_DIR = path.join(DATA_DIR, 'state');
export const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const ZYLOS_GLOBAL_CONFIG = path.join(ZYLOS_HOME, '.zylos/config.json');
export const ZYLOS_ENV_FILE = path.join(ZYLOS_HOME, '.env');

// state files
export const RUNTIME_DETECT_FILE = path.join(STATE_DIR, 'runtime.json');
export const SANDBOX_DETECT_FILE = path.join(STATE_DIR, 'sandbox.json');
export const SAFETY_TEMPLATES_FILE = path.join(STATE_DIR, 'safety-templates.json');
export const SRT_SETTINGS_FILE = path.join(STATE_DIR, 'srt-settings.json');
/** CODEX_HOME 隔离目录（生产路径；不要污染 KOL 主 ~/.codex）*/
export const CODEX_HOME = path.join(STATE_DIR, 'codex-home');
/** ensureCodexHome 失败 / unavailable 时写在这——runner 启动前读决定要不要 fail closed（HIGH-7）*/
export const CODEX_HOME_STATUS_FILE = path.join(STATE_DIR, 'codex-home-status.json');
