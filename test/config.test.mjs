import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

test('DeepSeek is the default model provider configuration', () => {
  const config = loadConfig({ env: {}, envFile: path.join(os.tmpdir(), 'missing-kaoyan-tutor-env') });
  assert.equal(config.deepseek.apiKey, '');
  assert.equal(config.deepseek.model, 'deepseek-v4-pro');
  assert.equal(config.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.deepseek.timeoutMs, 60_000);
  assert.equal('openai' in config, false);
});

test('DeepSeek environment settings load without exposing them to public config fields', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-tutor-config-'));
  const envFile = path.join(temp, '.env');
  fs.writeFileSync(envFile, [
    'DEEPSEEK_API_KEY=test-secret',
    'DEEPSEEK_MODEL=deepseek-v4-flash',
    'DEEPSEEK_BASE_URL=https://api.deepseek.com/',
    'DEEPSEEK_TIMEOUT_MS=45000',
  ].join('\n'), 'utf8');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = loadConfig({ env: {}, envFile });
  assert.equal(config.deepseek.apiKey, 'test-secret');
  assert.equal(config.deepseek.model, 'deepseek-v4-flash');
  assert.equal(config.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.deepseek.timeoutMs, 45_000);
  assert.equal(JSON.stringify({
    host: config.host,
    port: config.port,
    vaultPath: config.vaultPath,
  }).includes('test-secret'), false);
});
