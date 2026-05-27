import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CODEX_HOME,
  CODEX_HOME_STATUS_FILE,
  STATE_DIR,
} from '../src/paths.js';
import { buildDefaultSrtSettings, ensureCodexHome } from '../src/srt-settings.js';

const ORIGINAL_ENV = {
  HOME: process.env['HOME'],
  OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
  CODEX_API_KEY: process.env['CODEX_API_KEY'],
  OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'],
  CODEX_BASE_URL: process.env['CODEX_BASE_URL'],
};

beforeEach(() => {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  delete process.env['OPENAI_API_KEY'];
  delete process.env['CODEX_API_KEY'];
  delete process.env['OPENAI_BASE_URL'];
  delete process.env['CODEX_BASE_URL'];
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('srt settings', () => {
  it('adds managed Codex base URL host to sandbox allowlist', () => {
    process.env['OPENAI_BASE_URL'] = 'https://coco-runtime.example.com/v1/';

    const settings = buildDefaultSrtSettings('codex');

    expect(settings.network.allowedDomains).toContain('coco-runtime.example.com');
  });

  it('writes explicit env API key credentials into isolated CODEX_HOME', () => {
    process.env['OPENAI_API_KEY'] = 'sk-managed-test';
    process.env['OPENAI_BASE_URL'] = 'https://coco-runtime.example.com/v1';
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    fs.writeFileSync(
      path.join(CODEX_HOME, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'stale' } }, null, 2),
    );

    ensureCodexHome(null, process.execPath);

    const auth = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf8'));
    const config = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
    const status = JSON.parse(fs.readFileSync(CODEX_HOME_STATUS_FILE, 'utf8'));
    expect(auth).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-managed-test' });
    expect(config).toContain('openai_base_url = "https://coco-runtime.example.com/v1"');
    expect(status).toMatchObject({ status: 'ok', source: 'env_api_key', has_base_url: true });
  });

  it('allows platform-managed ~/.codex writes when no env API key is configured', () => {
    const home = path.join(STATE_DIR, 'fake-home');
    process.env['HOME'] = home;

    const settings = buildDefaultSrtSettings('codex');

    expect(settings.filesystem.allowWrite).toContain(path.join(home, '.codex'));
    expect(settings.filesystem.allowWrite).not.toContain(CODEX_HOME);
    expect(settings.filesystem.denyWrite).not.toContain(path.join(home, '.codex'));
  });

  it('uses platform-managed ~/.codex without copying auth into CODEX_HOME', () => {
    const home = path.join(STATE_DIR, 'fake-home');
    process.env['HOME'] = home;
    const realCodexHome = path.join(home, '.codex');
    fs.mkdirSync(realCodexHome, { recursive: true });
    fs.writeFileSync(
      path.join(realCodexHome, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'platform' } }, null, 2),
    );
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(CODEX_HOME, 'auth.json'), '{"stale":true}');
    fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), 'stale = true\n');

    ensureCodexHome(null, process.execPath);

    const status = JSON.parse(fs.readFileSync(CODEX_HOME_STATUS_FILE, 'utf8'));
    expect(status).toMatchObject({
      status: 'ok',
      source: 'platform_codex_home',
      codex_home: realCodexHome,
    });
    expect(fs.existsSync(path.join(CODEX_HOME, 'auth.json'))).toBe(false);
    expect(fs.existsSync(path.join(CODEX_HOME, 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(realCodexHome, 'auth.json'))).toBe(true);
  });
});
