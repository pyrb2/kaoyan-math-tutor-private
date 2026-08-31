import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { DeepSeekChatProvider } from '../src/agent/deepseek-provider.mjs';
import { createApplication } from '../src/server.mjs';

async function requestJson(baseUrl, pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  return { response, payload: await response.json() };
}

test('DeepSeek model mode stays server-side and continues with saved session history', async (t) => {
  const canaryKey = 'deepseek-canary-secret-never-return';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-tutor-deepseek-api-'));
  const requests = [];
  const provider = new DeepSeekChatProvider({
    apiKey: canaryKey,
    model: 'deepseek-v4-pro',
    transport: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: `deepseek-response-${requests.length}`,
            model: 'deepseek-v4-pro',
            choices: [{ message: { content: `模型回答 ${requests.length}。[S1]` } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      };
    },
  });
  const config = loadConfig({
    env: {},
    envFile: path.join(os.tmpdir(), 'missing-kaoyan-deepseek-env'),
    vaultPath: path.resolve('../shuxue'),
    dataDir,
    apiKey: canaryKey,
    port: 0,
  });
  const app = await createApplication({ config, provider });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await requestJson(baseUrl, '/api/health');
  assert.equal(health.payload.provider, 'deepseek');
  assert.equal(health.payload.model, 'deepseek-v4-pro');
  assert.equal(JSON.stringify(health.payload).includes(canaryKey), false);
  const bootstrap = await requestJson(baseUrl, '/api/bootstrap');
  assert.equal(JSON.stringify(bootstrap.payload).includes(canaryKey), false);

  const first = await requestJson(baseUrl, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '第一轮：泰勒公式怎么用？', hintLevel: 1 }),
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.mode, 'model');
  assert.equal(first.payload.provider, 'deepseek');
  assert.equal(JSON.stringify(first.payload).includes(canaryKey), false);

  const second = await requestJson(baseUrl, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: '第二轮：接着解释余项。',
      hintLevel: 2,
      sessionId: first.payload.sessionId,
    }),
  });
  assert.equal(second.response.status, 200);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].init.headers.authorization, `Bearer ${canaryKey}`);
  assert.ok(requests[1].body.messages.some((message) => message.role === 'user' && message.content === '第一轮：泰勒公式怎么用？'));
  assert.ok(requests[1].body.messages.some((message) => message.role === 'assistant' && /模型回答 1/.test(message.content)));
  assert.equal(JSON.stringify(second.payload).includes(canaryKey), false);

  const saved = await requestJson(baseUrl, `/api/sessions/${encodeURIComponent(first.payload.sessionId)}/messages`);
  assert.equal(saved.payload.messages.length, 4);
  assert.equal(saved.payload.messages[0].content, '第一轮：泰勒公式怎么用？');
  assert.equal(saved.payload.messages[3].content, '模型回答 2。[S1]');
});
