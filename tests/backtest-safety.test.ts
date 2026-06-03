import { describe, it, expect } from 'vitest';
import {
  isLoopbackOrPrivateHost,
  scrubReportUrl,
  scrubSnapshotValue,
  validateProviderCatalogTool,
  validateProviderParams,
  assertNoFloatMoneyFields,
  BacktestContractError,
  isSensitiveKey,
  looksLikeHighEntropyToken,
  type BacktestProviderCatalogTool,
  type JsonObject,
} from '../src/backtest-safety.js';

/* ------------------------------------------------------------------ */
/*  isLoopbackOrPrivateHost                                            */
/* ------------------------------------------------------------------ */

describe('isLoopbackOrPrivateHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['192.168.0.100', true],
    ['::1', true],
    ['localhost', true],
    ['foo.localhost', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.0.0.1', true],
  ])('%s → %s', (host, expected) => {
    expect(isLoopbackOrPrivateHost(host)).toBe(expected);
  });

  it.each([
    ['8.8.8.8', false],
    ['1.2.3.4', false],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['169.254.169.254', false],
    ['::ffff:8.8.8.8', false],
    ['google.com', false],
    ['256.0.0.1', false],
  ])('%s → %s', (host, expected) => {
    expect(isLoopbackOrPrivateHost(host)).toBe(expected);
  });

  it('handles bracketed IPv6', () => {
    expect(isLoopbackOrPrivateHost('[::1]')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  scrubReportUrl                                                     */
/* ------------------------------------------------------------------ */

describe('scrubReportUrl', () => {
  it('preserves relative path', () => {
    expect(scrubReportUrl('/reports/abc')).toBe('/reports/abc');
  });

  it('strips host from absolute URL', () => {
    expect(scrubReportUrl('http://127.0.0.1:8080/reports/abc')).toBe('/reports/abc');
  });

  it('strips host from https URL', () => {
    expect(scrubReportUrl('https://192.168.1.1/r?page=1')).toBe('/r?page=1');
  });

  it('drops sensitive query params', () => {
    const result = scrubReportUrl('http://localhost/r?token=abc123456789012345678901234567890');
    expect(result).toBe('/r');
  });

  it('rejects absolute file paths', () => {
    expect(scrubReportUrl('/Users/kol/report.html')).toBeUndefined();
    expect(scrubReportUrl('/home/user/report.html')).toBeUndefined();
  });

  it('rejects file:// URLs', () => {
    expect(scrubReportUrl('file:///tmp/report.html')).toBeUndefined();
  });

  it('returns undefined for empty/whitespace', () => {
    expect(scrubReportUrl(undefined)).toBeUndefined();
    expect(scrubReportUrl('')).toBeUndefined();
    expect(scrubReportUrl('   ')).toBeUndefined();
  });

  it('preserves relative path with query', () => {
    expect(scrubReportUrl('/reports/abc?format=html')).toBe('/reports/abc?format=html');
  });
});

/* ------------------------------------------------------------------ */
/*  scrubSnapshotValue                                                 */
/* ------------------------------------------------------------------ */

describe('scrubSnapshotValue', () => {
  it('removes sensitive keys', () => {
    const input = { tool_id: 'a', api_key: 'secret123', name: 'test' };
    const result = scrubSnapshotValue(input);
    expect(result).toEqual({ tool_id: 'a', name: 'test' });
    expect('api_key' in result).toBe(false);
  });

  it('removes nested sensitive keys', () => {
    const input = { config: { endpoint: 'http://localhost', name: 'ok' } };
    const result = scrubSnapshotValue(input);
    expect(result).toEqual({ config: { name: 'ok' } });
  });

  it('scrubs high-entropy string values', () => {
    const highEntropy = 'AbCdEfGhIjKlMnOpQrStUv1234';
    const input = { tool_id: 'a', value: highEntropy };
    const result = scrubSnapshotValue(input);
    expect(result.value).toBe('[scrubbed]');
  });

  it('preserves schema names (dotted lowercase identifiers)', () => {
    const input = { schema: 'cutie.backtest_tool_catalog.v1' };
    const result = scrubSnapshotValue(input);
    expect(result.schema).toBe('cutie.backtest_tool_catalog.v1');
  });

  it('scrubs arrays recursively', () => {
    const input = [{ api_key: 'x', name: 'ok' }];
    const result = scrubSnapshotValue(input);
    expect(result).toEqual([{ name: 'ok' }]);
  });

  it('preserves primitives', () => {
    expect(scrubSnapshotValue(42)).toBe(42);
    expect(scrubSnapshotValue(true)).toBe(true);
    expect(scrubSnapshotValue(null)).toBe(null);
  });

  it('scrubs file paths in values', () => {
    const input = { path: '/Users/kol/workspace/data.json' };
    const result = scrubSnapshotValue(input);
    expect(result.path).toBe('[scrubbed]');
  });
});

/* ------------------------------------------------------------------ */
/*  isSensitiveKey                                                     */
/* ------------------------------------------------------------------ */

describe('isSensitiveKey', () => {
  it.each([
    ['api_key', true],
    ['apiKey', true],
    ['user_api_key', true],
    ['secret', true],
    ['token', true],
    ['password', true],
    ['endpoint', true],
    ['description', false],
    ['tool_id', false],
    ['name', false],
    ['markets', false],
  ])('%s → %s', (key, expected) => {
    expect(isSensitiveKey(key)).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/*  looksLikeHighEntropyToken                                          */
/* ------------------------------------------------------------------ */

describe('looksLikeHighEntropyToken', () => {
  it('detects mixed-case long token', () => {
    expect(looksLikeHighEntropyToken('AbCdEfGhIjKlMnOpQrStUv1234')).toBe(true);
  });

  it('detects hex hash (32+ chars)', () => {
    expect(looksLikeHighEntropyToken('a'.repeat(32))).toBe(true);
  });

  it('rejects schema names', () => {
    expect(looksLikeHighEntropyToken('cutie.backtest_tool_catalog.v1')).toBe(false);
  });

  it('rejects short strings', () => {
    expect(looksLikeHighEntropyToken('short')).toBe(false);
  });

  it('rejects strings with spaces', () => {
    expect(looksLikeHighEntropyToken('has spaces in it')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  validateProviderCatalogTool                                        */
/* ------------------------------------------------------------------ */

describe('validateProviderCatalogTool', () => {
  const validTool: BacktestProviderCatalogTool = {
    tool_id: 'test-tool',
    wrapper_type: 'python_inprocess',
    name: 'Test',
    markets: ['BTC/USDT'],
    timeframes: ['1h'],
  };

  it('passes valid tool', () => {
    expect(validateProviderCatalogTool(validTool)).toBeNull();
  });

  it('rejects missing tool_id', () => {
    expect(validateProviderCatalogTool({ ...validTool, tool_id: '' })).toContain('tool_id');
  });

  it('rejects long tool_id', () => {
    expect(validateProviderCatalogTool({ ...validTool, tool_id: 'x'.repeat(129) })).toContain('128');
  });

  it('rejects missing wrapper_type', () => {
    const { wrapper_type: _, ...noWrapper } = validTool;
    expect(validateProviderCatalogTool(noWrapper as BacktestProviderCatalogTool)).toContain('wrapper_type');
  });

  it('rejects unsupported wrapper_type', () => {
    expect(validateProviderCatalogTool({ ...validTool, wrapper_type: 'docker' })).toContain('unsupported');
  });

  it('rejects empty markets', () => {
    expect(validateProviderCatalogTool({ ...validTool, markets: [] })).toContain('markets');
  });

  it('rejects empty timeframes', () => {
    expect(validateProviderCatalogTool({ ...validTool, timeframes: [] })).toContain('timeframes');
  });

  it('rejects async execution mode', () => {
    expect(
      validateProviderCatalogTool({ ...validTool, execution: { mode: 'async' } }),
    ).toContain('execution.mode');
  });

  it('rejects live_trading=true', () => {
    expect(
      validateProviderCatalogTool({ ...validTool, security: { live_trading: true } }),
    ).toContain('live_trading');
  });

  it('rejects unknown fields without x_ prefix', () => {
    const toolWithUnknown = { ...validTool, custom_field: 'value' } as unknown as BacktestProviderCatalogTool;
    expect(validateProviderCatalogTool(toolWithUnknown)).toContain('unknown');
  });

  it('allows x_ prefixed extension fields', () => {
    const toolWithExtension = { ...validTool, x_custom: 'value' } as unknown as BacktestProviderCatalogTool;
    expect(validateProviderCatalogTool(toolWithExtension)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  validateProviderParams                                             */
/* ------------------------------------------------------------------ */

describe('validateProviderParams', () => {
  const schema = {
    properties: {
      symbol: { type: 'string' },
      leverage: { type: 'integer', minimum: 1, maximum: 100 },
      mode: { type: 'string', enum: ['backtest', 'paper'] },
    },
    required: ['symbol'],
  };

  it('passes with valid params', () => {
    expect(validateProviderParams({ symbol: 'BTC/USDT', leverage: 10 }, schema)).toBeNull();
  });

  it('passes with no schema', () => {
    expect(validateProviderParams({ anything: true }, null)).toBeNull();
  });

  it('rejects missing required field', () => {
    expect(validateProviderParams({}, schema)).toContain('symbol');
  });

  it('rejects type mismatch', () => {
    expect(validateProviderParams({ symbol: 123 as unknown as string }, schema)).toContain('string');
  });

  it('rejects enum violation', () => {
    expect(validateProviderParams({ symbol: 'BTC', mode: 'live' }, schema)).toContain('one of');
  });

  it('rejects value below minimum', () => {
    expect(validateProviderParams({ symbol: 'BTC', leverage: 0 }, schema)).toContain('>= 1');
  });

  it('rejects value above maximum', () => {
    expect(validateProviderParams({ symbol: 'BTC', leverage: 200 }, schema)).toContain('<= 100');
  });

  it('rejects unknown fields by default', () => {
    expect(validateProviderParams({ symbol: 'BTC', unknown: true }, schema)).toContain('unknown');
  });

  it('allows unknown fields with additionalProperties=true', () => {
    const openSchema = { ...schema, additionalProperties: true };
    expect(validateProviderParams({ symbol: 'BTC', extra: 'ok' }, openSchema)).toBeNull();
  });

  it('skips required field with default', () => {
    const schemaWithDefault = {
      properties: { symbol: { type: 'string', default: 'BTC' } },
      required: ['symbol'],
    };
    expect(validateProviderParams({}, schemaWithDefault)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  assertNoFloatMoneyFields                                           */
/* ------------------------------------------------------------------ */

describe('assertNoFloatMoneyFields', () => {
  it('throws for money field as JSON number', () => {
    expect(() => assertNoFloatMoneyFields([{ price: 12345.67 }], 'trades')).toThrow(BacktestContractError);
  });

  it('passes for money field as decimal string', () => {
    expect(() => assertNoFloatMoneyFields([{ price: '12345.67' }], 'trades')).not.toThrow();
  });

  it('detects nested money fields', () => {
    expect(() =>
      assertNoFloatMoneyFields([{ fill: { price: 123 } }], 'trades'),
    ).toThrow(BacktestContractError);
  });

  it('throws for NaN/Infinity in any number field', () => {
    expect(() =>
      assertNoFloatMoneyFields([{ ratio: NaN }], 'metrics'),
    ).toThrow(BacktestContractError);
    expect(() =>
      assertNoFloatMoneyFields([{ value: Infinity }], 'metrics'),
    ).toThrow(BacktestContractError);
  });

  it('allows non-money number fields', () => {
    expect(() =>
      assertNoFloatMoneyFields([{ count: 42, ratio: 0.5 }], 'metrics'),
    ).not.toThrow();
  });
});
