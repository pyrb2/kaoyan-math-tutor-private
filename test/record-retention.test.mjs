import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTutorStore } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';

test('chat records survive closing, reopening and continuing the same SQLite database', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-tutor-retention-'));
  const dbPath = path.join(temp, 'tutor.db');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const firstStore = createTutorStore({ dbPath });
  const session = firstStore.startSession({
    title: '保留记录测试',
    metadata: { provider: 'legacy-provider' },
  });
  firstStore.appendChatMessage({ sessionId: session.id, role: 'user', content: '第一轮问题' });
  firstStore.appendChatMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '第一轮回答',
    citations: [{ id: 'S1', path: '课程.md', page: 8 }],
  });
  firstStore.close();

  const reopened = createTutorStore({ dbPath });
  const saved = reopened.listChatMessages(session.id);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].content, '第一轮问题');
  assert.equal(saved[1].citations[0].page, 8);
  reopened.appendChatMessage({ sessionId: session.id, role: 'user', content: '切换 DeepSeek 后继续' });
  assert.equal(reopened.listChatMessages(session.id).length, 3);
  assert.equal(reopened.getSession(session.id).metadata.provider, 'legacy-provider');
  reopened.close();
});

test('the complete learning record survives an application restart with the same data directory', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-tutor-app-retention-'));
  let firstApp = null;
  let reopenedApp = null;
  t.after(async () => {
    if (reopenedApp) await reopenedApp.close();
    if (firstApp) await firstApp.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const config = loadConfig({
    env: {},
    envFile: path.join(os.tmpdir(), 'missing-kaoyan-retention-env'),
    dataDir: temp,
    vaultPath: path.resolve('../shuxue'),
    port: 0,
    apiKey: '',
  });
  const source = {
    id: 'zy30.calc.ch01.pdf008.01',
    sourceId: 'zy30.calc.ch01',
    title: '第01讲 函数极限与连续',
    path: '01-课程笔记/高等数学/第01讲.md',
    page: 8,
    anchor: 'pdf-page-008',
    status: 'OCR初稿',
    docType: 'ocr_page',
    evidenceTier: 'ocr_source',
    excerpt: '测试教材证据。',
    images: [],
  };
  const index = {
    stats: { markdownFileCount: 95, ocrPageCount: 752 },
    listCatalog: () => [{ id: 'kp.calc.limit.function', title: '函数极限', type: 'knowledge_candidate' }],
    search: () => [source],
  };
  const provider = { available: false, name: 'deepseek', model: 'deepseek-v4-pro', async generate() { throw new Error('offline'); } };
  const json = async (baseUrl, route, init) => {
    const response = await fetch(`${baseUrl}${route}`, init);
    assert.ok(response.ok, `${route} returned ${response.status}`);
    return response.json();
  };

  firstApp = await createApplication({ config, index, provider });
  const firstAddress = await firstApp.listen({ host: '127.0.0.1', port: 0 });
  const firstBase = `http://127.0.0.1:${firstAddress.port}`;
  await json(firstBase, '/api/profile', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '保留记录同学', dailyMinutes: 50, examType: '数学一' }),
  });
  await json(firstBase, '/api/mastery/review', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ knowledgeId: 'kp.calc.limit.function', title: '函数极限', correct: true, hintLevel: 1 }),
  });
  await json(firstBase, '/api/mistakes', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '测试错题', knowledgeId: 'kp.calc.limit.function' }),
  });
  const chat = await json(firstBase, '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '请帮我复习函数极限', hintLevel: 1 }),
  });
  await firstApp.close();
  firstApp = null;

  reopenedApp = await createApplication({ config, index, provider });
  const reopenedAddress = await reopenedApp.listen({ host: '127.0.0.1', port: 0 });
  const reopenedBase = `http://127.0.0.1:${reopenedAddress.port}`;
  const bootstrap = await json(reopenedBase, '/api/bootstrap');
  assert.equal(bootstrap.profile.name, '保留记录同学');
  assert.equal(bootstrap.mastery.length, 1);
  assert.equal(bootstrap.mistakes.length, 1);
  assert.equal(bootstrap.sessions.length, 1);
  const messages = await json(reopenedBase, `/api/sessions/${encodeURIComponent(chat.sessionId)}/messages`);
  assert.equal(messages.messages.length, 2);
  assert.equal(messages.messages[0].content, '请帮我复习函数极限');
});
