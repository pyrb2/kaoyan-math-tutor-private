import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT_PATH = path.resolve(PROJECT_ROOT, '../shuxue');

async function request(baseUrl, pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  assert.ok(response.status < 500, `${pathname} 不应返回 ${response.status}: ${text}`);
  return { response, payload };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-tutor-smoke-'));
  let app;
  let providerCalls = 0;
  const offlineProvider = {
    available: false,
    model: null,
    async generate() {
      providerCalls += 1;
      throw new Error('离线 smoke 不允许调用模型 provider');
    },
  };

  try {
    const config = loadConfig({
      env: {},
      vaultPath: VAULT_PATH,
      dataDir,
      host: '127.0.0.1',
      port: 0,
      apiKey: '',
    });
    app = await createApplication({ config, provider: offlineProvider });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await request(baseUrl, '/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.ok, true);
    assert.equal(health.payload.mode, 'retrieval');
    assert.equal(health.payload.indexStats.ocrPageCount, 752);

    const bootstrap = await request(baseUrl, '/api/bootstrap');
    assert.equal(bootstrap.response.status, 200);
    assert.equal(bootstrap.payload.mode, 'retrieval');

    const search = await request(baseUrl, `/api/search?q=${encodeURIComponent('泰勒公式与中值定理')}`);
    assert.equal(search.response.status, 200);
    assert.ok(search.payload.results.some((source) => source.evidenceTier === 'ocr_source'));

    const chat = await request(baseUrl, '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '泰勒公式什么时候用？先给我一级提示。', hintLevel: 1 }),
    });
    assert.equal(chat.response.status, 200);
    assert.equal(chat.payload.mode, 'retrieval');
    assert.equal(chat.payload.hintLevel, 1);
    assert.ok(chat.payload.answer);
    assert.ok(chat.payload.citations.some((source) => source.evidenceTier === 'ocr_source'));
    assert.equal(providerCalls, 0, '离线模式不得调用模型 provider');

    const traversal = await request(baseUrl, `/api/vault-file?path=${encodeURIComponent('../package.json')}`);
    assert.ok(traversal.response.status >= 400 && traversal.response.status < 500);

    console.log(`离线 smoke 通过: ${baseUrl}`);
    console.log('已验证 health、bootstrap、search、chat、路径越界和模型调用次数为 0。');
  } finally {
    if (app) await app.close();
    const resolvedTemp = path.resolve(os.tmpdir());
    const resolvedData = path.resolve(dataDir);
    if (path.dirname(resolvedData) === resolvedTemp && path.basename(resolvedData).startsWith('kaoyan-tutor-smoke-')) {
      fs.rmSync(resolvedData, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

