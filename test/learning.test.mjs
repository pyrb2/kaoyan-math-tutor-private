import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReviewQueue,
  buildSevenDayPlan,
  clamp01,
  scheduleReview,
  updateMastery,
} from '../src/learning.mjs';

const NOW = '2026-08-18T08:00:00.000Z';

test('clamp01 and mastery updates always stay inside the score range', () => {
  assert.equal(clamp01(-10), 0);
  assert.equal(clamp01(10), 1);
  assert.equal(updateMastery({ score: 5 }, { correct: true, now: NOW }).score, 1);
  assert.equal(updateMastery({ score: -5 }, { correct: false, now: NOW }).score, 0);
});

test('an unhinted correct answer gains more than a hinted answer', () => {
  const previous = { knowledgeId: 'kp.limit', score: 0.4, attempts: 2, correctCount: 1 };
  const unhinted = updateMastery(previous, { correct: true, hintLevel: 0, now: NOW });
  const hinted = updateMastery(previous, { correct: true, hintLevel: 2, now: NOW });

  assert.ok(unhinted.score > hinted.score);
  assert.ok(hinted.score > previous.score);
  assert.equal(unhinted.attempts, 3);
  assert.equal(unhinted.correctCount, 2);
  assert.equal(previous.attempts, 2, 'the previous object is not mutated');
});

test('an incorrect answer never raises mastery', () => {
  for (const score of [0, 0.2, 0.7, 1]) {
    const result = updateMastery({ score }, { correct: false, hintLevel: 0, now: NOW });
    assert.ok(result.score <= score);
    assert.ok(result.score >= 0 && result.score <= 1);
  }
});

test('the review scheduler is deterministic and follows simplified SM-2 intervals', () => {
  const first = scheduleReview({}, { correct: true, hintLevel: 0, now: NOW });
  assert.equal(first.intervalDays, 1);
  assert.equal(first.nextReviewAt, '2026-08-19T08:00:00.000Z');

  const second = scheduleReview(first, { correct: true, hintLevel: 1, now: '2026-08-19T08:00:00.000Z' });
  assert.equal(second.intervalDays, 3);
  assert.equal(second.nextReviewAt, '2026-08-22T08:00:00.000Z');

  const failed = scheduleReview(second, { correct: false, now: '2026-08-22T08:00:00.000Z' });
  assert.equal(failed.repetitions, 0);
  assert.equal(failed.intervalDays, 1);
  assert.equal(failed.lapses, 1);
});

test('review queue prioritizes unresolved mistakes and overdue weak topics', () => {
  const queue = buildReviewQueue({
    now: NOW,
    mastery: [
      { knowledgeId: 'kp.strong', title: '强项', score: 0.9, nextReviewAt: '2026-08-17T08:00:00Z' },
      { knowledgeId: 'kp.weak', title: '弱项', score: 0.3, nextReviewAt: '2026-08-16T08:00:00Z' },
      { knowledgeId: 'kp.future', title: '以后复习', score: 0.8, nextReviewAt: '2026-09-01T08:00:00Z' },
    ],
    mistakes: [{ id: 7, knowledgeId: 'kp.strong', status: 'active' }],
  });

  assert.equal(queue[0].knowledgeId, 'kp.strong');
  assert.equal(queue[0].activeMistakes, 1);
  assert.equal(queue.some((item) => item.knowledgeId === 'kp.future'), false);
  assert.ok(queue.find((item) => item.knowledgeId === 'kp.weak').reason.includes('逾期'));
});

test('seven-day plan is reproducible, explainable, and never exceeds the daily cap', () => {
  const input = {
    now: NOW,
    profile: {
      examDate: '2026-12-20',
      preferences: { dailyMinutes: 55 },
    },
    catalog: [
      { id: 'kp.limit', title: '函数极限', type: 'knowledge_candidate' },
      { id: 'kp.taylor', title: '泰勒公式', type: 'knowledge_candidate' },
      { id: 'method.taylor', title: '泰勒展开', type: 'method_candidate' },
    ],
    mastery: [
      { knowledgeId: 'kp.limit', title: '函数极限', score: 0.25, attempts: 4 },
      { knowledgeId: 'kp.taylor', title: '泰勒公式', score: 0.75, attempts: 3 },
    ],
    mistakes: [
      { id: 1, knowledgeId: 'kp.taylor', status: 'active', title: '泰勒公式' },
      { id: 2, knowledgeId: 'kp.taylor', status: 'resolved', title: '泰勒公式' },
    ],
  };
  const first = buildSevenDayPlan(input);
  const second = buildSevenDayPlan(input);

  assert.deepEqual(first, second);
  assert.equal(first.days.length, 7);
  assert.ok(first.days.every((day) => day.minutes <= 55));
  assert.ok(first.days.every((day) => day.minutes === day.tasks.reduce((sum, task) => sum + task.minutes, 0)));
  assert.ok(first.days[0].tasks.some((task) => task.type === 'mistake_review'));
  assert.ok(first.days.flatMap((day) => day.tasks).some((task) => task.knowledgeId === 'kp.limit'));
  assert.ok(first.days.every((day) => day.tasks.every((task) => task.reason.length > 0)));
});

test('the plan stops assigning study minutes on and after the exam date', () => {
  const plan = buildSevenDayPlan({
    now: '2026-08-18T23:30:00.000Z',
    profile: { examDate: '2026-08-20', dailyMinutes: 120 },
    catalog: [{ id: 'kp.limit', title: '函数极限' }],
  });
  assert.equal(plan.days[0].date, '2026-08-18');
  assert.ok(plan.days[0].minutes <= 120);
  assert.ok(plan.days[1].minutes <= 120);
  assert.equal(plan.days[2].minutes, 0);
  assert.ok(plan.days.slice(2).every((day) => day.minutes === 0));
});

test('small and zero daily limits are respected exactly', () => {
  const small = buildSevenDayPlan({
    now: NOW,
    dailyMinutes: 7,
    catalog: [{ id: 'kp.limit', title: '函数极限' }],
  });
  assert.ok(small.days.every((day) => day.minutes <= 7));

  const empty = buildSevenDayPlan({ now: NOW, dailyMinutes: 0 });
  assert.ok(empty.days.every((day) => day.minutes === 0 && day.tasks.length === 0));
});
