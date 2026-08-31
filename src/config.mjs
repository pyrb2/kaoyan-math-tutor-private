import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const separator = trimmed.indexOf('=');
  if (separator < 1) return null;
  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return /^[A-Z][A-Z0-9_]*$/.test(key) ? [key, value] : null;
}

export function loadEnvFile(filePath = path.join(PROJECT_ROOT, '.env'), env = process.env) {
  if (!fs.existsSync(filePath)) return env;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

function integer(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return parsed;
}

function absoluteFromProject(value, fallback) {
  const selected = value || fallback;
  return path.resolve(PROJECT_ROOT, selected);
}

export function loadConfig(overrides = {}) {
  const env = overrides.env || process.env;
  loadEnvFile(overrides.envFile || path.join(PROJECT_ROOT, '.env'), env);
  const config = {
    projectRoot: PROJECT_ROOT,
    publicDir: path.join(PROJECT_ROOT, 'public'),
    vaultPath: absoluteFromProject(overrides.vaultPath || env.TUTOR_VAULT_PATH, '../shuxue'),
    dataDir: absoluteFromProject(overrides.dataDir || env.TUTOR_DATA_DIR, './data'),
    host: overrides.host || env.TUTOR_HOST || '127.0.0.1',
    port: integer(overrides.port ?? env.TUTOR_PORT, 3210, 0, 65535, 'TUTOR_PORT'),
    requestLimitBytes: integer(
      overrides.requestLimitBytes ?? env.TUTOR_REQUEST_LIMIT_BYTES,
      256 * 1024,
      1024,
      2 * 1024 * 1024,
      'TUTOR_REQUEST_LIMIT_BYTES',
    ),
    deepseek: {
      apiKey: overrides.apiKey ?? env.DEEPSEEK_API_KEY ?? '',
      model: overrides.model || env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      baseUrl: (overrides.baseUrl || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
      timeoutMs: integer(
        overrides.timeoutMs ?? env.DEEPSEEK_TIMEOUT_MS,
        60_000,
        5_000,
        180_000,
        'DEEPSEEK_TIMEOUT_MS',
      ),
    },
  };
  return Object.freeze(config);
}

export { PROJECT_ROOT };
