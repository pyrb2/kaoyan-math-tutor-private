import test from 'node:test';
import assert from 'node:assert/strict';
import { createTutorStore } from '../src/store.mjs';
import { buildOfflineAnswer, createTutorService } from '../src/agent/tutor.mjs';

const OCR_SOURCE = {
  id: 'zy30.calc.ch06.pdf178.01',
  sourceId: 'zy30.calc.ch06',
  title: '第06讲 中值定理',
  path: '01-课程笔记/高等数学/第06讲.md',
  page: 178,
  anchor: 'pdf-page-178',
  heading: '泰勒公式',
  status: 'OCR初稿',
  docType: 'ocr_page',
  evidenceTier: 'ocr_source',
  excerpt: '在适用条件下选择相应展开并检查余项。',
  images: [],
};

test('offline tutor never calls a model and keeps source citations', async (t) => {
  const store = createTutorStore();
  t.after(() => store.close());
  let calls = 0;
  const tutor = createTutorService({
    index: { search: () => [OCR_SOURCE] },
    store,
    provider: { available: false, async generate() { calls += 1; } },
  });
  const result = await tutor.chat({ message: '泰勒公式怎么用？', hintLevel: 1 });
  assert.equal(calls, 0);
  assert.equal(result.mode, 'retrieval');
  assert.equal(result.citations[0].label, 'S1');
  assert.match(result.answer, /PDF 第 178 页/);
  assert.doesNotMatch(result.answer, /完整的教材定位和核查路径/);
  assert.equal(store.listChatMessages(result.sessionId).length, 2);
});

test('configured tutor uses provider output and records the selected model', async (t) => {
  const store = createTutorStore();
  t.after(() => store.close());
  const tutor = createTutorService({
    index: { search: () => [OCR_SOURCE] },
    store,
    provider: {
      available: true,
      async generate(prompt) {
        assert.equal(prompt.hintLevel, 2);
        return { text: '先检查展开点与阶数。[S1]', model: 'fake-model' };
      },
    },
  });
  const result = await tutor.chat({ message: '请给我第二级提示', hintLevel: 2 });
  assert.equal(result.mode, 'model');
  assert.equal(result.model, 'fake-model');
  assert.match(result.answer, /\[S1\]/);
});

test('continued sessions send saved recent history back to the stateless model provider', async (t) => {
  const store = createTutorStore();
  t.after(() => store.close());
  const prompts = [];
  const tutor = createTutorService({
    index: { search: () => [OCR_SOURCE] },
    store,
    provider: {
      name: 'deepseek',
      model: 'deepseek-v4-pro',
      available: true,
      async generate(prompt) {
        prompts.push(prompt);
        return { text: prompts.length === 1 ? '第一轮回答。[S1]' : '第二轮回答。[S1]', model: 'deepseek-v4-pro' };
      },
    },
  });
  const first = await tutor.chat({ message: '第一轮问题', hintLevel: 1 });
  await tutor.chat({ message: '接着上一轮继续', hintLevel: 2, sessionId: first.sessionId });
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[1].input.slice(0, 2), [
    { role: 'user', content: '第一轮问题' },
    { role: 'assistant', content: '第一轮回答。[S1]' },
  ]);
  assert.equal(store.listChatMessages(first.sessionId).length, 4);
});

test('offline tutor refuses to invent an answer without OCR evidence', () => {
  const answer = buildOfflineAnswer({
    message: '一个不明确的问题',
    hintLevel: 3,
    sources: [{ ...OCR_SOURCE, evidenceTier: 'graph_candidate' }],
  });
  assert.match(answer, /没有检索到足够的教材证据/);
  assert.match(answer, /不猜答案/);
});
