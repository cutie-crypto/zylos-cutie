import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { COMPONENT_VERSION } from '../src/version.js';

describe('COMPONENT_VERSION', () => {
  it('matches package.json version', () => {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version: string };
    expect(COMPONENT_VERSION).toBe(pkg.version);
  });
});
