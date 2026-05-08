/**
 * B9 — api.register 单测。
 *
 * mock connector-core 的 register，验 RegisterParams 组装：
 *   - platform = os.platform()
 *   - agentPlatform = 'zylos'
 *   - connectorVersion = COMPONENT_VERSION
 *   - deviceName 默认 = `${hostname}-zylos-cutie`
 *   - capabilities 选填（不传则 params 不含此字段）
 *
 * Review HIGH-1 教训：自写 register HTTP 漏字段（缺 `platform`）会被
 * server 422 拒；这里锁住 connector-core register 调用契约。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import { COMPONENT_VERSION } from '../src/version.js';

const coreRegisterMock = vi.fn();

vi.mock('@cutie-crypto/connector-core', () => ({
  register: coreRegisterMock,
}));

beforeEach(() => {
  coreRegisterMock.mockReset();
  coreRegisterMock.mockResolvedValue({
    connector_id: 'cntr_test_x',
    connector_token: 'ctk_test_x',
    safety_templates: { agents_md: 'A', soul_md: 'S', canary_token: 'CANARY-y' },
    heartbeat_interval_seconds: 30,
    ws_endpoint: 'wss://server.tokenbeep.com/v1/connector/ws',
  });
});

describe('api.register', () => {
  it('组装 RegisterParams 含全部 server 必填字段', async () => {
    const { register } = await import('../src/api.js');
    await register({
      server_url: 'https://server.tokenbeep.com',
      pair_token: 'ptk_xxx',
    });
    expect(coreRegisterMock).toHaveBeenCalledOnce();
    const [serverUrl, params] = coreRegisterMock.mock.calls[0];
    expect(serverUrl).toBe('https://server.tokenbeep.com');
    expect(params).toMatchObject({
      pairToken: 'ptk_xxx',
      platform: os.platform(),
      agentPlatform: 'zylos',
      connectorVersion: COMPONENT_VERSION,
      agentVersion: COMPONENT_VERSION,
    });
  });

  it('deviceName 默认 = `${hostname}-zylos-cutie`', async () => {
    const { register } = await import('../src/api.js');
    await register({ server_url: 'https://x', pair_token: 'p' });
    const [, params] = coreRegisterMock.mock.calls[0];
    expect(params.deviceName).toBe(`${os.hostname()}-zylos-cutie`);
  });

  it('显式传 device_name 优先于默认值', async () => {
    const { register } = await import('../src/api.js');
    await register({
      server_url: 'https://x',
      pair_token: 'p',
      device_name: 'custom-device-001',
    });
    const [, params] = coreRegisterMock.mock.calls[0];
    expect(params.deviceName).toBe('custom-device-001');
  });

  it('capabilities 不传 → params 不含 capabilities 字段（不发空数组）', async () => {
    const { register } = await import('../src/api.js');
    await register({ server_url: 'https://x', pair_token: 'p' });
    const [, params] = coreRegisterMock.mock.calls[0];
    expect('capabilities' in params).toBe(false);
  });

  it('capabilities 显式传入 → params 含该字段', async () => {
    const { register } = await import('../src/api.js');
    await register({
      server_url: 'https://x',
      pair_token: 'p',
      capabilities: ['sandbox=srt', 'runtime=claude'],
    });
    const [, params] = coreRegisterMock.mock.calls[0];
    expect(params.capabilities).toEqual(['sandbox=srt', 'runtime=claude']);
  });

  it('agentPlatform 永远是 "zylos"，不接受 caller 改', async () => {
    const { register } = await import('../src/api.js');
    await register({ server_url: 'https://x', pair_token: 'p' });
    const [, params] = coreRegisterMock.mock.calls[0];
    expect(params.agentPlatform).toBe('zylos');
  });

  it('register 返回值透传 connector-core register 结果', async () => {
    const { register } = await import('../src/api.js');
    const r = await register({ server_url: 'https://x', pair_token: 'p' });
    expect(r.connector_id).toBe('cntr_test_x');
    expect(r.connector_token).toBe('ctk_test_x');
  });
});
