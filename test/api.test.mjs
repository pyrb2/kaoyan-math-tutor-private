import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';

async function jsonRequest(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = await response.json();
  return { response, body };
}

test('profile, mastery, mistakes and plan form a persistent local learning loop', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-tutor-api-'));
  const fixedNow = new Date('2026-08-18T02:00:00.000Z');
  const config = loadConfig({
    env: {},
    vaultPath: path.resolve('../shuxue'),
    dataDir,
    host: '127.0.0.1',
    port: 0,
    apiKey: '',
  });
  let providerCalls = 0;
  const app = await createApplication({
    config,
    now: () => new Date(fixedNow),
    storeNow: () => new Date(fixedNow),
    provider: {
      available: false,
      model: null,
      async generate() { providerCalls += 1; throw new Error('offline test'); },
    },
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const profile = await jsonRequest(baseUrl, '/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '测试同学',
      examDate: '2026-12-26',
      targetScore: 120,
      examType: '数学一',
      dailyMinutes: 45,
    }),
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.profile.dailyMinutes, 45);
  assert.equal(profile.body.plan.days.length, 7);
  assert.ok(profile.body.plan.days.every((day) => day.minutes <= 45));

  const mastery = await jsonRequest(baseUrl, '/api/mastery/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      knowledgeId: 'kp.calc.approx.taylor',
      title: '泰勒公式',
      correct: true,
      hintLevel: 1,
    }),
  });
  assert.equal(mastery.response.status, 200);
  assert.ok(mastery.body.mastery.score > 0 && mastery.body.mastery.score <= 1);
  assert.equal(mastery.body.mastery.attempts, 1);

  const created = await jsonRequest(baseUrl, '/api/mistakes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: '写错了泰勒余项',
      knowledgeId: 'kp.calc.approx.taylor',
      errorType: '公式条件',
      analysis: '没有检查展开点',
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.mistake.status, 'active');

  const resolved = await jsonRequest(baseUrl, `/api/mistakes/${created.body.mistake.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'resolved', reviewedAt: fixedNow.toISOString() }),
  });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.body.mistake.status, 'resolved');

  const bootstrap = await jsonRequest(baseUrl, '/api/bootstrap');
  assert.equal(bootstrap.body.profile.name, '测试同学');
  assert.equal(bootstrap.body.mastery[0].knowledgeId, 'kp.calc.approx.taylor');
  assert.equal(bootstrap.body.mistakes[0].status, 'resolved');
  assert.equal(providerCalls, 0);
});

test('vault image endpoint is read-only and rejects traversal', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-tutor-image-'));
  const config = loadConfig({ env: {}, vaultPath: path.resolve('../shuxue'), dataDir, port: 0, apiKey: '' });
  const app = await createApplication({
    config,
    provider: { available: false, model: null, async generate() { throw new Error('offline'); } },
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') || '', /^text\/html/);
  assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
  const homeHtml = await home.text();
  assert.match(homeHtml, /id="view-tutor"/);
  assert.match(homeHtml, /id="view-mistakes"/);
  assert.match(homeHtml, /id="session-list"/);
  const cssHead = await fetch(`${baseUrl}/styles.css`, { method: 'HEAD' });
  assert.equal(cssHead.status, 200);
  assert.match(cssHead.headers.get('content-type') || '', /^text\/css/);
  assert.equal((await cssHead.arrayBuffer()).byteLength, 0);
  const appScript = await fetch(`${baseUrl}/app.js`);
  assert.equal(appScript.status, 200);
  assert.match(appScript.headers.get('content-type') || '', /^text\/javascript/);
  const appScriptText = await appScript.text();
  assert.doesNotMatch(appScriptText, /(?:OPENAI|DEEPSEEK)_API_KEY|Bearer\s/i);
  assert.match(appScriptText, /\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/messages/);
  assert.match(appScriptText, /data-session-id/);

  const search = await jsonRequest(baseUrl, `/api/search?q=${encodeURIComponent('二重积分换序')}&limit=5`);
  const imageUrl = search.body.results.flatMap((result) => result.imageUrls || [])[0];
  assert.ok(imageUrl, 'representative OCR search should expose a source image URL');
  const image = await fetch(`${baseUrl}${imageUrl}`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type') || '', /^image\//);
  assert.ok((await image.arrayBuffer()).byteLength > 1000);

  const traversal = await jsonRequest(baseUrl, `/api/vault-file?path=${encodeURIComponent('../package.json')}`);
  assert.equal(traversal.response.status, 400);
  assert.equal(traversal.body.error.code, 'invalid_path');
  const malformed = await jsonRequest(baseUrl, '/%ZZ');
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error.code, 'invalid_url');
});
