import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // tests/setup.ts 在每个 fork worker 启动时 set CUTIE_DATA_DIR=tmpdir，
    // 避免污染 KOL 真实 ~/zylos/components/cutie/（review HIGH-3 修复）。
    // 用 setupFiles 而非 globalSetup：globalSetup 只跑在 main thread，env mutation
    // 不会传到 fork worker；setupFiles 在每个 worker 内执行，env 对该 worker 生效。
    setupFiles: ['./tests/setup.ts'],
    // 多个测试文件操作同一 CUTIE_DATA_DIR/state/ 真实路径，并行 fork 间会互相覆盖。
    // 单 fork 串行（CUTIE_DATA_DIR 已是 tmpdir，不会污染 KOL 数据，仅是测试隔离）。
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    coverage: {
      reporter: ['text', 'lcov'],
    },
  },
});
