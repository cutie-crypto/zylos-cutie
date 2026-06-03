/**
 * backtest-safety — W3.9 安全工具函数。
 *
 * 从 cutie-connector packages/connector/src/backtest.ts port 而来。
 * 纯函数，无副作用，覆盖：SSRF 私网校验、report URL 清洗、catalog snapshot scrub、
 * provider catalog v1 schema 校验、param_schema 二次校验、金额字段精度校验。
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type JsonObject = Record<string, unknown>;

export interface BacktestProviderCatalogTool {
  tool_id: string;
  kind?: string;
  name?: string;
  description?: string;
  wrapper_type?: string;
  provider_name?: string;
  engine_name?: string;
  engine_version?: string;
  data_source?: string | null;
  markets?: string[];
  timeframes?: string[];
  supported_symbols?: string[];
  symbols?: string[];
  is_default?: boolean;
  default?: boolean;
  health?: 'ok' | 'unavailable' | 'error';
  param_schema?: Record<string, unknown> | null;
  output_schema?: Record<string, unknown> | null;
  execution?: { mode?: string; [key: string]: unknown } | null;
  adapter?: Record<string, unknown> | null;
  report_capabilities?: Record<string, unknown> | null;
  security?: { live_trading?: boolean; [key: string]: unknown } | null;
  failure_codes?: string[];
  expected_outputs?: string[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

const ALLOWED_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'python_inprocess',
  'local_cli',
  'local_http',
]);

const CATALOG_TOOL_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'tool_id',
  'kind',
  'name',
  'description',
  'wrapper_type',
  'provider_name',
  'engine_name',
  'engine_version',
  'data_source',
  'markets',
  'timeframes',
  'supported_symbols',
  'symbols',
  'is_default',
  'default',
  'health',
  'param_schema',
  'output_schema',
  'execution',
  'adapter',
  'report_capabilities',
  'security',
  'failure_codes',
  'expected_outputs',
]);

const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  'api_key',
  'apikey',
  'secret',
  'token',
  'password',
  'passwd',
  'pwd',
  'private_key',
  'credential',
  'credentials',
  'bearer',
  'access_key',
  'endpoint',
  'catalog_url',
  'backtest_url',
  'base_url',
]);

const PATH_PATTERN = /(^|[^a-z])(\/Users\/|\/home\/|\/root\/|\/var\/|[A-Za-z]:\\|\\Users\\)/i;

const MONEY_FIELD_NAMES: ReadonlySet<string> = new Set([
  'equity',
  'price',
  'entry_price',
  'exit_price',
  'qty',
  'quantity',
  'size',
  'amount',
  'cost',
  'fee',
  'fees',
  'pnl',
  'realized_pnl',
  'notional',
  'capital',
  'cash',
]);

/* ------------------------------------------------------------------ */
/*  BacktestContractError                                              */
/* ------------------------------------------------------------------ */

export class BacktestContractError extends Error {
  readonly error_type = 'PROVIDER_CONTRACT_VIOLATION' as const;
}

/* ------------------------------------------------------------------ */
/*  SSRF private network validation                                    */
/* ------------------------------------------------------------------ */

export function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = mapped?.[1] ?? host;
  const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeKeyName(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKeyName(key);
  if (SENSITIVE_KEY_NAMES.has(normalized)) return true;
  return /(_api_key|_secret|_token|_password|_passwd|_pwd|_private_key|_credential|_bearer|_access_key)$/.test(
    normalized,
  );
}

export function looksLikeHighEntropyToken(value: string): boolean {
  if (/\s/.test(value)) return false;
  const dottedWords = value.split('.');
  const looksDottedIdentifier =
    dottedWords.length >= 2 && dottedWords.every(seg => /^[A-Za-z0-9_-]+$/.test(seg) && seg.length <= 40);
  if (looksDottedIdentifier && !/[A-Z]/.test(value)) {
    return false;
  }
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  if (value.length >= 24 && hasUpper && hasLower && hasDigit && /^[A-Za-z0-9._\-+/=]+$/.test(value)) {
    return true;
  }
  if (value.length >= 32 && /^[A-Fa-f0-9]+$/.test(value)) {
    return true;
  }
  if (value.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(value) && hasDigit) {
    return true;
  }
  return false;
}

function valueLooksSensitive(value: string): boolean {
  return PATH_PATTERN.test(value) || looksLikeHighEntropyToken(value);
}

/* ------------------------------------------------------------------ */
/*  Catalog snapshot scrubbing                                         */
/* ------------------------------------------------------------------ */

export function scrubSnapshotValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => scrubSnapshotValue(item)) as unknown as T;
  }
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [key, raw] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      out[key] = scrubSnapshotValue(raw);
    }
    return out as unknown as T;
  }
  if (typeof value === 'string' && valueLooksSensitive(value)) {
    return '[scrubbed]' as unknown as T;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/*  Report URL scrubbing                                               */
/* ------------------------------------------------------------------ */

function querySearchLooksSensitive(params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (isSensitiveKey(key)) return true;
    if (valueLooksSensitive(value)) return true;
  }
  return false;
}

export function scrubReportUrl(reportUrl: string | undefined): string | undefined {
  const raw = cleanString(reportUrl);
  if (!raw) return undefined;
  if (PATH_PATTERN.test(raw) || raw.startsWith('file:')) {
    return undefined;
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const search = querySearchLooksSensitive(parsed.searchParams) ? '' : parsed.search;
    const relative = `${parsed.pathname}${search}`;
    return relative || undefined;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Provider catalog v1 schema validation                              */
/* ------------------------------------------------------------------ */

export function validateProviderCatalogTool(tool: BacktestProviderCatalogTool): string | null {
  if (!tool.tool_id || typeof tool.tool_id !== 'string') {
    return 'tool_id missing or not a string';
  }
  if (tool.tool_id.length > 128) {
    return 'tool_id exceeds 128 chars';
  }
  if (tool.wrapper_type === undefined || tool.wrapper_type === null) {
    return 'wrapper_type missing (required for cutie.backtest_provider_catalog.v1)';
  }
  if (!ALLOWED_WRAPPER_TYPES.has(tool.wrapper_type)) {
    return `unsupported wrapper_type '${tool.wrapper_type}' (allowed: python_inprocess, local_cli, local_http)`;
  }
  if (!Array.isArray(tool.markets) || tool.markets.length === 0) {
    return 'markets must be a non-empty array';
  }
  if (!Array.isArray(tool.timeframes) || tool.timeframes.length === 0) {
    return 'timeframes must be a non-empty array';
  }
  const execMode = tool.execution?.mode;
  if (execMode !== undefined && execMode !== null && execMode !== 'sync') {
    return `unsupported execution.mode '${execMode}' (P0 only supports sync)`;
  }
  if (tool.security?.live_trading === true) {
    return 'security.live_trading=true is not allowed for backtest providers';
  }
  if (tool.param_schema !== undefined && tool.param_schema !== null) {
    if (!isJsonObject(tool.param_schema)) {
      return 'param_schema must be a JSON object (JSON Schema subset)';
    }
  }
  for (const key of Object.keys(tool as unknown as Record<string, unknown>)) {
    if (CATALOG_TOOL_ALLOWED_KEYS.has(key)) continue;
    if (key.startsWith('x_') || key.startsWith('x-')) continue;
    return `unknown catalog tool field "${key}" (cutie.backtest_provider_catalog.v1 is a strict contract; use x_ prefix for extensions)`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Provider params validation (JSON Schema P0 subset)                 */
/* ------------------------------------------------------------------ */

function validateParamField(key: string, value: unknown, def: JsonObject): string | null {
  const type = typeof def.type === 'string' ? def.type : undefined;
  if (type) {
    switch (type) {
      case 'string':
        if (typeof value !== 'string') return `provider_params field "${key}" must be a string`;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return `provider_params field "${key}" must be a boolean`;
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value))
          return `provider_params field "${key}" must be an integer`;
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value))
          return `provider_params field "${key}" must be a finite number`;
        break;
      default:
        break;
    }
  }
  if (Array.isArray(def.enum) && !def.enum.some(opt => opt === value)) {
    return `provider_params field "${key}" must be one of ${JSON.stringify(def.enum)}`;
  }
  if (typeof value === 'number') {
    if (typeof def.minimum === 'number' && value < def.minimum) {
      return `provider_params field "${key}" must be >= ${def.minimum}`;
    }
    if (typeof def.maximum === 'number' && value > def.maximum) {
      return `provider_params field "${key}" must be <= ${def.maximum}`;
    }
  }
  return null;
}

export function validateProviderParams(
  params: JsonObject | undefined,
  schema: Record<string, unknown> | null | undefined,
): string | null {
  if (!isJsonObject(schema)) return null;
  const props = isJsonObject(schema.properties) ? schema.properties : undefined;
  if (!props) return null;
  const value = params ?? {};
  const allowAdditional = schema.additionalProperties === true;
  if (!allowAdditional) {
    for (const key of Object.keys(value)) {
      if (!(key in props)) {
        return `provider_params contains unknown field "${key}" (not in tool param_schema)`;
      }
    }
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : [];
  for (const key of required) {
    const propDef = isJsonObject(props[key]) ? props[key] as JsonObject : undefined;
    const hasDefault = propDef ? 'default' in propDef : false;
    if (!(key in value) && !hasDefault) {
      return `provider_params missing required field "${key}"`;
    }
  }
  for (const [key, propRaw] of Object.entries(props)) {
    if (!(key in value)) continue;
    if (!isJsonObject(propRaw)) continue;
    const fieldError = validateParamField(key, value[key], propRaw);
    if (fieldError) return fieldError;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Money field precision validation                                   */
/* ------------------------------------------------------------------ */

function assertNoFloatMoneyFieldsDeep(value: unknown, context: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoFloatMoneyFieldsDeep(item, context);
    }
    return;
  }
  if (!isJsonObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (MONEY_FIELD_NAMES.has(key.toLowerCase()) && typeof child === 'number') {
      throw new BacktestContractError(
        `Provider response ${context} field "${key}" must be a decimal string, not a JSON number (money/quantity precision rule)`,
      );
    }
    if (typeof child === 'number' && !Number.isFinite(child)) {
      throw new BacktestContractError(
        `Provider response ${context} field "${key}" must not be NaN/Infinity`,
      );
    }
    if (Array.isArray(child) || isJsonObject(child)) {
      assertNoFloatMoneyFieldsDeep(child, context);
    }
  }
}

export function assertNoFloatMoneyFields(rows: JsonObject[], context: string): void {
  for (const row of rows) {
    assertNoFloatMoneyFieldsDeep(row, context);
  }
}
