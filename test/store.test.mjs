import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTutorStore } from '../src/store.mjs';

function withStore(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kaoyan-tutor-store-'));
  const store = createTutorStore({ dbPath: join(directory, 'nested', 'tutor.db'), ...options });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test('initializes an injectable database path and persists the single profile', (t) => {
  const moments = [
    '2026-08-18T01:00:00.000Z',
    '2026-08-18T01:00:01.000Z',
    '2026-08-18T01:00:02.000Z',
  ];
  const store = withStore(t, { now: () => moments.shift() ?? '2026-08-18T01:00:03.000Z' });
  assert.equal(store.getProfile(), null);

  const created = store.upsertProfile({
    name: '小林',
    examDate: '2026-12-20',
    targetScore: 125,
    subject: '数学一',
    preferences: { explanationLevel: 'hint-first' },
  });
  assert.equal(created.name, '小林');
  assert.equal(created.examDate, '2026-12-20T00:00:00.000Z');
  assert.equal(created.targetScore, 125);
  assert.deepEqual(created.preferences, { explanationLevel: 'hint-first' });

  const updated = store.upsertProfile({ targetScore: 130 });
  assert.equal(updated.name, '小林');
  assert.equal(updated.targetScore, 130);
  assert.deepEqual(updated.preferences, { explanationLevel: 'hint-first' });
});

test('records mastery and filters weak or due knowledge points', (t) => {
  const store = withStore(t);
  store.upsertMastery({
    knowledgeId: 'limit-definition',
    title: '极限定义',
    score: 0.35,
    attempts: 4,
    correctCount: 1,
    nextReviewAt: '2026-08-19T00:00:00Z',
  });
  store.upsertMastery({ knowledgeId: 'derivative', score: 0.85, attempts: 5, correctCount: 4 });

  assert.equal(store.getMastery('limit-definition').correctCount, 1);
  assert.deepEqual(store.listMastery({ belowScore: 0.5 }).map((row) => row.knowledgeId), ['limit-definition']);
  assert.deepEqual(
    store.listMastery({ dueBefore: '2026-08-20T00:00:00Z' }).map((row) => row.knowledgeId),
    ['limit-definition'],
  );
  assert.throws(
    () => store.upsertMastery({ knowledgeId: 'bad', score: 1.1 }),
    /score must be between 0 and 1/,
  );
  assert.throws(
    () => store.upsertMastery({ knowledgeId: 'bad-count', attempts: 1, correctCount: 2 }),
    /cannot exceed attempts/,
  );
});

test('creates, updates and filters mistakes', (t) => {
  const store = withStore(t);
  const mistake = store.addMistake({
    question: '求 lim(x→0) sin x / x',
    knowledgeId: 'limit-definition',
    userAnswer: '0',
    correctAnswer: '1',
    errorType: '概念混淆',
    sourceRef: '第01讲 PDF 12',
  });
  assert.ok(mistake.id > 0);
  assert.equal(store.listMistakes({ status: 'active' }).length, 1);

  const resolved = store.updateMistake(mistake.id, {
    status: 'resolved',
    analysis: '忽略了重要极限',
    reviewedAt: '2026-08-19T08:00:00Z',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.analysis, '忽略了重要极限');
  assert.equal(store.listMistakes({ status: 'active' }).length, 0);
  assert.equal(store.listMistakes({ knowledgeId: 'limit-definition' })[0].id, mistake.id);
  assert.throws(() => store.addMistake({ question: '题目', status: 'unknown' }), /status is invalid/);
});

test('stores sessions and ordered chat logs with structured citations', (t) => {
  const store = withStore(t);
  const session = store.startSession({
    id: 'session-1',
    title: '极限诊断',
    metadata: { mode: 'diagnostic' },
    startedAt: '2026-08-18T10:00:00Z',
  });
  assert.deepEqual(session.metadata, { mode: 'diagnostic' });

  store.appendChatMessage({ sessionId: session.id, role: 'user', content: '我不会这道题。' });
  const answer = store.appendChatMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '先观察它属于哪一种未定式。',
    citations: [{ note: '第01讲-函数极限与连续.md', page: 12 }],
    createdAt: '2026-08-18T10:05:00Z',
  });
  assert.deepEqual(answer.citations, [{ note: '第01讲-函数极限与连续.md', page: 12 }]);
  assert.deepEqual(store.listChatMessages(session.id).map((message) => message.role), ['user', 'assistant']);
  assert.equal(store.listChatMessages(session.id, { limit: 1 })[0].role, 'assistant');
  assert.equal(store.getSession(session.id).updatedAt, '2026-08-18T10:05:00.000Z');

  const ended = store.endSession(session.id, { summary: '需要复习重要极限' });
  assert.equal(ended.summary, '需要复习重要极限');
  assert.ok(ended.endedAt);
  assert.equal(store.listSessions()[0].id, session.id);
  assert.throws(
    () => store.appendChatMessage({ sessionId: session.id, role: 'invalid', content: 'x' }),
    /role is invalid/,
  );
  assert.throws(
    () => store.appendChatMessage({ sessionId: 'missing', role: 'user', content: 'x' }),
    /does not exist/,
  );
});

test('closing is idempotent and prevents subsequent use', () => {
  const store = createTutorStore();
  store.close();
  store.close();
  assert.throws(() => store.getProfile(), /closed/);
});
