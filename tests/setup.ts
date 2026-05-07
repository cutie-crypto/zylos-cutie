/**
 * Vitest setupFiles — 在每个 fork worker 启动时 set CUTIE_DATA_DIR=tmpdir。
 *
 * Review HIGH-3 修复（5 路 review 共识）：vitest 之前直接读写 KOL 真实数据，
 * KOL 跑一次 npm test 就清空生产 safety templates + knowledge md。
 *
 * 用 setupFiles 而非 globalSetup：globalSetup 只跑在 main thread，env mutation
 * 不会传到 fork worker；setupFiles 在每个 worker 内执行，env 对 worker 生效。
 *
 * paths.ts 在模块加载时一次性解析 DATA_DIR；本文件**必须比 paths.ts 先 import**——
 * vitest setupFiles 自动满足这个顺序。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = path.join(os.tmpdir(), `zylos-cutie-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env['CUTIE_DATA_DIR'] = tmpRoot;

// vitest 在测试 worker 退出时调 globalTeardown / afterAll；本 setupFile 没法注册
// teardown，留 tmpdir 给系统 cron 清——`/tmp/zylos-cutie-test-*` 模式好辨识。
// 真要严格清理可改回 globalSetup 模式 + globalTeardown 但需要每个 worker 同步 env。
