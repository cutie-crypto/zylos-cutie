import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import type {
  MaintenanceCommand,
  MaintenanceReport,
  MaintenanceReportDelivery,
  MaintenanceAckOutcome,
} from '@cutie-crypto/connector-core';
import { ZylosMaintenanceExecutor, redact } from '../src/maintenance.js';

const mockUnref = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  spawn: vi.fn(() => ({ pid: 12345, unref: mockUnref })),
}));

const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);

function makeCommand(overrides: Partial<MaintenanceCommand> = {}): MaintenanceCommand {
  return {
    type: 'maintenance.command',
    command_id: 'cmd-1',
    nonce: 'nonce-1',
    command_type: 'diagnose',
    expires_at: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

function makeAckPromise(outcome: MaintenanceAckOutcome = 'acked'): Promise<MaintenanceAckOutcome> {
  return Promise.resolve(outcome);
}

function collectingReporter(): {
  reports: MaintenanceReport[];
  report: (r: MaintenanceReport) => MaintenanceReportDelivery;
} {
  const reports: MaintenanceReport[] = [];
  return {
    reports,
    report: (r: MaintenanceReport): MaintenanceReportDelivery => {
      reports.push(r);
      return { send: 'sent' as const, ack: makeAckPromise() };
    },
  };
}

const exitMock = vi.fn();

function makeExecutor() {
  return new ZylosMaintenanceExecutor({
    config: {
      server_url: 'https://server.tokenbeep.com',
      connector_id: 'conn-123',
      connector_token: 'tok-secret',
    },
    connectorVersion: '2.3.9',
    exit: exitMock as unknown as (code: number) => never,
  });
}

describe('redact', () => {
  it('scrubs connector_token values', () => {
    expect(redact('connector_token=abc123secret')).toBe('connector_token=[REDACTED]');
  });

  it('scrubs Bearer tokens', () => {
    expect(redact('Authorization: Bearer eyJhbG...')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('scrubs api_key values', () => {
    expect(redact('"api_key": "sk-proj-abc"')).toContain('[REDACTED]');
    expect(redact('"api_key": "sk-proj-abc"')).not.toContain('sk-proj-abc');
  });

  it('scrubs OPENAI_API_KEY env', () => {
    expect(redact('OPENAI_API_KEY=sk-xxx')).toBe('OPENAI_API_KEY=[REDACTED]');
  });

  it('preserves non-secret text', () => {
    const text = 'normal log line with no secrets';
    expect(redact(text)).toBe(text);
  });
});

describe('ZylosMaintenanceExecutor', () => {
  let executor: ZylosMaintenanceExecutor;

  beforeEach(() => {
    vi.useFakeTimers();
    executor = makeExecutor();
    exitMock.mockReset();
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('' as unknown as Buffer);
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue({ pid: 12345, unref: mockUnref } as unknown as ReturnType<typeof spawn>);
    mockUnref.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('diagnose', () => {
    it('returns system diagnostics', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('pm2 describe')) return 'online' as unknown as Buffer;
        if (typeof cmd === 'string' && cmd.includes('zylos list')) return '{"cutie":"2.3.9"}' as unknown as Buffer;
        return '' as unknown as Buffer;
      });

      const { report } = collectingReporter();
      const result = await executor.execute(makeCommand(), report) as Record<string, unknown>;

      expect(result).toMatchObject({
        connector_version: '2.3.9',
        node_version: process.version,
        config: {
          has_connector_id: true,
          has_connector_token: true,
          server_url: 'https://server.tokenbeep.com',
        },
      });
      expect(result['runtime']).toMatchObject({
        manager: 'pm2',
        pm2_status: 'available',
      });
    });

    it('includes logs tail when requested', async () => {
      const logContent = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(logContent);

      const { report } = collectingReporter();
      const result = await executor.execute(
        makeCommand({ payload: { include_logs_tail: true } }),
        report,
      ) as Record<string, unknown>;

      const tail = result['logs_tail'] as string[];
      expect(tail.length).toBeLessThanOrEqual(20);
      expect(tail[tail.length - 1]).toBe('line 29');

      vi.restoreAllMocks();
    });
  });

  describe('self_reinstall', () => {
    it('spawns detached zylos upgrade with CUTIE_SELF_UPGRADE=1', async () => {
      const { reports, report } = collectingReporter();
      await executor.execute(
        makeCommand({ command_type: 'self_reinstall', requested_version: '2.4.0' }),
        report,
      );

      expect(mockSpawn).toHaveBeenCalledWith(
        'zylos',
        expect.arrayContaining(['upgrade', 'cutie', '--version', '2.4.0']),
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          env: expect.objectContaining({ CUTIE_SELF_UPGRADE: '1' }),
        }),
      );
      expect(mockUnref).toHaveBeenCalled();

      const statuses = reports.map((r) => r.status);
      expect(statuses).toEqual(['preflight_ok', 'executing', 'success']);

      await vi.advanceTimersByTimeAsync(EXIT_AFTER_SENT_MS + 100);
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it('rejects non-semver non-latest version', async () => {
      const { report } = collectingReporter();
      await expect(
        executor.execute(
          makeCommand({ command_type: 'self_reinstall', requested_version: 'badversion' }),
          report,
        ),
      ).rejects.toThrow('self_reinstall version must be latest or semver');
    });

    it('accepts latest as version (no --version flag)', async () => {
      const { report } = collectingReporter();
      await executor.execute(
        makeCommand({ command_type: 'self_reinstall', requested_version: 'latest' }),
        report,
      );

      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain('--version');
    });
  });

  describe('rollback', () => {
    it('requires semver version', async () => {
      const { report } = collectingReporter();
      await expect(
        executor.execute(
          makeCommand({ command_type: 'rollback', requested_version: 'latest' }),
          report,
        ),
      ).rejects.toThrow('rollback version must be semver');
    });

    it('spawns detached zylos upgrade with specific version', async () => {
      const { report } = collectingReporter();
      await executor.execute(
        makeCommand({ command_type: 'rollback', requested_version: '2.2.0' }),
        report,
      );

      expect(mockSpawn).toHaveBeenCalledWith(
        'zylos',
        expect.arrayContaining(['--version', '2.2.0']),
        expect.objectContaining({ detached: true }),
      );
    });
  });

  describe('restart', () => {
    it('reports success and schedules exit', async () => {
      const { reports, report } = collectingReporter();
      await executor.execute(makeCommand({ command_type: 'restart' }), report);

      expect(reports.map((r) => r.status)).toEqual(['preflight_ok', 'executing', 'success']);
      expect(reports[2].result).toMatchObject({ restart_scheduled: true });

      await vi.advanceTimersByTimeAsync(EXIT_AFTER_SENT_MS + 100);
      expect(exitMock).toHaveBeenCalledWith(0);
    });
  });

  describe('reset_config', () => {
    it('deletes config and exits after ack', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

      const { reports, report } = collectingReporter();
      await executor.execute(
        makeCommand({ command_type: 'reset_config', payload: { revoke_token: true } }),
        report,
      );

      expect(reports.map((r) => r.status)).toEqual(['preflight_ok', 'executing', 'success']);
      expect(reports[2].result).toMatchObject({ config_deleted: true, revoke_token: true });

      await vi.advanceTimersByTimeAsync(EXIT_AFTER_SENT_MS + 100);
      expect(unlinkSpy).toHaveBeenCalled();
      expect(exitMock).toHaveBeenCalledWith(0);

      vi.restoreAllMocks();
    });

    it('throws if config file does not exist', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const { report } = collectingReporter();
      await expect(
        executor.execute(makeCommand({ command_type: 'reset_config' }), report),
      ).rejects.toThrow('connector config file does not exist');

      vi.restoreAllMocks();
    });
  });

  describe('unknown command', () => {
    it('throws for unknown command type', async () => {
      const { report } = collectingReporter();
      await expect(
        executor.execute(
          makeCommand({ command_type: 'unknown_cmd' as 'diagnose' }),
          report,
        ),
      ).rejects.toThrow('unknown maintenance command');
    });
  });

  describe('ack handling', () => {
    it('throws on rejected ack', async () => {
      const rejectedReport = (r: MaintenanceReport): MaintenanceReportDelivery => ({
        send: 'sent',
        ack: Promise.resolve('rejected' as MaintenanceAckOutcome),
      });

      await expect(
        executor.execute(makeCommand({ command_type: 'restart' }), rejectedReport),
      ).rejects.toThrow('not acknowledged');
    });
  });
});

const EXIT_AFTER_SENT_MS = 500;
