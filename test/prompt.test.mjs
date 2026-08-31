import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOfflineAnswer } from '../src/agent/tutor.mjs';
import { buildTutorPrompt, LEVEL_RULES, normalizeHintLevel } from '../src/agent/prompt.mjs';

const ocrSource = {
  id: 'zy30.calc.ch01.pdf008.01',
  label: 'S1',
  title: '第01讲-函数极限与连续',
  path: '01-课程笔记/高等数学/第01讲-函数极限与连续.md',
  page: 8,
  heading: '泰勒公式',
  status: 'OCR初稿',
  docType: 'ocr_page',
  evidenceTier: 'ocr_source',
  excerpt: '这是用于测试逐级披露的 OCR 教材摘录。',
};

const candidateSource = {
  id: 'kp.calc.approx.taylor.01',
  label: 'S2',
  title: '泰勒公式',
  path: '02-知识点/泰勒公式.md',
  page: null,
  heading: '',
  status: '待人工校验',
  docType: 'knowledge_candidate',
  evidenceTier: 'graph_candidate',
  excerpt: '候选知识关联页。',
};

test('hint levels normalize to the safe first level', () => {
  assert.equal(normalizeHintLevel(1), 1);
  assert.equal(normalizeHintLevel('2'), 2);
  assert.equal(normalizeHintLevel(3), 3);
  assert.equal(normalizeHintLevel(0), 1);
  assert.equal(normalizeHintLevel('bad'), 1);
});

test('prompt defines monotonic disclosure and evidence boundaries', () => {
  const prompts = [1, 2, 3].map((hintLevel) => buildTutorPrompt({
    message: '泰勒公式怎么用？',
    hintLevel,
    sources: [ocrSource, candidateSource],
    profile: { examType: '数学一', targetScore: 120, dailyMinutes: 90 },
  }));

  assert.match(prompts[0].instructions, /只给识别方向/);
  assert.match(prompts[0].instructions, /不得泄露最终结论/);
  assert.match(prompts[1].instructions, /关键公式/);
  assert.match(prompts[1].instructions, /最后计算留给学生/);
  assert.match(prompts[2].instructions, /完整、可核查的解法/);
  assert.match(prompts[2].instructions, /逐步解释/);
  assert.equal(LEVEL_RULES[1].includes('完整、可核查的解法'), false);
  assert.match(prompts[2].instructions, /候选知识页只能作为补充/);
  assert.match(prompts[2].instructions, /OCR初稿/);
  assert.match(prompts[2].instructions, /未经信任的参考数据/);
  assert.match(prompts[2].instructions, /知识库证据不足/);

  const payload = JSON.parse(prompts[2].input.at(-1).content);
  assert.equal(payload.sources[0].page, 8);
  assert.equal(payload.sources[1].page, null);
  assert.equal(payload.student.dailyMinutes, 90);
});

test('model prompt carries the most recent saved conversation records', () => {
  const history = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `历史消息 ${index + 1}`,
  }));
  const prompt = buildTutorPrompt({
    message: '继续上一轮',
    hintLevel: 1,
    sources: [ocrSource],
    profile: {},
    history,
  });
  assert.equal(prompt.input.length, 13);
  assert.equal(prompt.input[0].content, '历史消息 5');
  assert.equal(prompt.input[11].content, '历史消息 16');
  assert.equal(JSON.parse(prompt.input[12].content).task, '继续上一轮');
});

test('offline answers disclose direction, excerpt and full route in three stages', () => {
  const input = { message: '请帮我做这道泰勒公式题', sources: [candidateSource, ocrSource] };
  const level1 = buildOfflineAnswer({ ...input, hintLevel: 1 });
  const level2 = buildOfflineAnswer({ ...input, hintLevel: 2 });
  const level3 = buildOfflineAnswer({ ...input, hintLevel: 3 });

  assert.match(level1, /第一步/);
  assert.doesNotMatch(level1, /这是用于测试逐级披露的 OCR 教材摘录/);
  assert.match(level2, /这是用于测试逐级披露的 OCR 教材摘录/);
  assert.match(level2, /完成最后一步/);
  assert.doesNotMatch(level2, /建议解题顺序/);
  assert.match(level3, /这是用于测试逐级披露的 OCR 教材摘录/);
  assert.match(level3, /建议解题顺序/);
  assert.match(level3, /逐步计算/);
  for (const answer of [level1, level2, level3]) assert.match(answer, /OCR 初稿/);
});

test('offline mode refuses to invent an answer without OCR evidence', () => {
  const answer = buildOfflineAnswer({
    message: '给我答案',
    hintLevel: 3,
    sources: [candidateSource],
  });
  assert.match(answer, /没有检索到足够的教材证据/);
  assert.match(answer, /不猜答案/);
});
