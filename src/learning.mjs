const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_MINUTES = 60;
const MAX_DAILY_MINUTES = 24 * 60;
const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, finiteNumber(value, 0)));
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function normalizeHintLevel(value = 0) {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new RangeError('hintLevel must be an integer between 0 and 3');
  }
  return value;
}

function resolveNow(value) {
  const supplied = typeof value === 'function' ? value() : value;
  const date = supplied === undefined ? new Date() : supplied instanceof Date ? supplied : new Date(supplied);
  if (Number.isNaN(date.valueOf())) throw new TypeError('now must be a valid date');
  return new Date(date.valueOf());
}

function validDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function inferIntervalDays(previous) {
  const explicit = finiteNumber(previous.intervalDays ?? previous.reviewSchedule?.intervalDays, NaN);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const last = validDate(previous.lastReviewedAt ?? previous.reviewSchedule?.lastReviewedAt);
  const next = validDate(previous.nextReviewAt ?? previous.reviewSchedule?.nextReviewAt);
  if (last && next && next >= last) return Math.max(1, Math.round((next - last) / DAY_MS));
  return 0;
}

/**
 * A compact SM-2 style scheduler. `hintLevel` is 0 for an unhinted answer and
 * 1 to 3 for progressively stronger help. Every returned timestamp is derived
 * from the injectable `now` value.
 */
export function scheduleReview(previous = {}, { correct, hintLevel = 0, now } = {}) {
  const source = previous && typeof previous === 'object' ? previous : {};
  requireBoolean(correct, 'correct');
  const hint = normalizeHintLevel(hintLevel);
  const reviewedAt = resolveNow(now);
  const nested = source.reviewSchedule && typeof source.reviewSchedule === 'object'
    ? source.reviewSchedule
    : {};
  const priorEase = Math.min(2.8, Math.max(1.3, finiteNumber(
    source.ease ?? source.easeFactor ?? nested.ease ?? nested.easeFactor,
    2.5,
  )));
  const priorRepetitions = nonNegativeInteger(
    source.repetitions ?? nested.repetitions,
    Math.min(20, nonNegativeInteger(source.correctCount ?? source.correctAttempts, 0)),
  );
  const priorLapses = nonNegativeInteger(source.lapses ?? nested.lapses, 0);
  const priorInterval = inferIntervalDays(source);
  const quality = correct ? 5 - hint : 1;
  const easeDelta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const ease = round(Math.min(2.8, Math.max(1.3, priorEase + easeDelta)), 3);

  let repetitions;
  let intervalDays;
  let lapses = priorLapses;
  if (!correct) {
    repetitions = 0;
    intervalDays = 1;
    lapses += 1;
  } else if (quality < 3) {
    // A level-3 reveal counts as exposure, but not as an independent recall.
    repetitions = 0;
    intervalDays = 1;
  } else {
    repetitions = priorRepetitions + 1;
    if (repetitions === 1) intervalDays = 1;
    else if (repetitions === 2) intervalDays = 3;
    else intervalDays = Math.max(4, Math.round(Math.max(1, priorInterval) * ease));
  }

  const nextReview = new Date(reviewedAt.valueOf() + intervalDays * DAY_MS);
  return {
    lastReviewedAt: reviewedAt.toISOString(),
    nextReviewAt: nextReview.toISOString(),
    intervalDays,
    ease,
    easeFactor: ease,
    repetitions,
    lapses,
    quality,
  };
}

/**
 * Update a mastery row without mutating it. The result can be passed directly
 * to TutorStore.upsertMastery; extra scheduler fields are harmless there.
 */
export function updateMastery(previous = {}, { correct, hintLevel = 0, now } = {}) {
  const source = previous && typeof previous === 'object' ? previous : {};
  requireBoolean(correct, 'correct');
  const hint = normalizeHintLevel(hintLevel);
  const before = clamp01(source.score);
  const attempts = nonNegativeInteger(source.attempts, 0) + 1;
  const priorCorrect = nonNegativeInteger(source.correctCount ?? source.correctAttempts, 0);
  const correctCount = Math.min(attempts, priorCorrect + (correct ? 1 : 0));

  // The remaining gap prevents scores from overshooting one. Lower help means
  // a strictly larger gain for every score below one.
  const gainFactors = [0.32, 0.24, 0.17, 0.1];
  const score = correct
    ? clamp01(before + (1 - before) * gainFactors[hint])
    : clamp01(before - (0.04 + 0.08 * before));
  const reviewSchedule = scheduleReview(source, { correct, hintLevel: hint, now });

  return {
    ...source,
    score: round(score),
    attempts,
    correctCount,
    correctAttempts: correctCount,
    lastReviewedAt: reviewSchedule.lastReviewedAt,
    nextReviewAt: reviewSchedule.nextReviewAt,
    intervalDays: reviewSchedule.intervalDays,
    ease: reviewSchedule.ease,
    easeFactor: reviewSchedule.easeFactor,
    repetitions: reviewSchedule.repetitions,
    lapses: reviewSchedule.lapses,
    lastResult: correct ? 'correct' : 'incorrect',
    lastHintLevel: hint,
    reviewSchedule,
  };
}

function normalizeMastery(mastery) {
  let values;
  if (mastery instanceof Map) {
    values = [...mastery.entries()].map(([knowledgeId, item]) => ({ knowledgeId, ...(item || {}) }));
  } else if (Array.isArray(mastery)) {
    values = mastery;
  } else if (mastery && typeof mastery === 'object') {
    values = Object.entries(mastery).map(([knowledgeId, item]) => (
      item && typeof item === 'object'
        ? { knowledgeId, ...item }
        : { knowledgeId, score: item }
    ));
  } else {
    values = [];
  }

  return values
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const knowledgeId = String(item.knowledgeId ?? item.id ?? `topic:${index}`).trim();
      return {
        ...item,
        knowledgeId,
        title: String(item.title || knowledgeId),
        score: clamp01(item.score),
        attempts: nonNegativeInteger(item.attempts, 0),
        nextReviewAt: validDate(item.nextReviewAt)?.toISOString() ?? null,
      };
    })
    .filter((item) => item.knowledgeId);
}

function normalizeMistakes(mistakes) {
  if (!Array.isArray(mistakes)) return [];
  return mistakes
    .filter((item) => item && typeof item === 'object' && item.status !== 'resolved')
    .map((item, index) => ({
      ...item,
      id: item.id ?? index + 1,
      knowledgeId: item.knowledgeId ? String(item.knowledgeId).trim() : null,
      title: String(item.title || item.knowledgeTitle || item.knowledgeId || '未归类错题'),
    }));
}

/** Return due topics, ordered by active mistakes, overdue time, and weakness. */
export function buildReviewQueue({ mastery = [], mistakes = [], now, limit = 100, includeUpcoming = false } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('limit must be an integer between 1 and 1000');
  }
  const current = resolveNow(now);
  const masteryRows = normalizeMastery(mastery);
  const activeMistakes = normalizeMistakes(mistakes);
  const mistakeGroups = new Map();
  for (const mistake of activeMistakes) {
    const key = mistake.knowledgeId || '__unclassified__';
    const group = mistakeGroups.get(key) || { count: 0, title: mistake.title, ids: [] };
    group.count += 1;
    group.ids.push(mistake.id);
    mistakeGroups.set(key, group);
  }

  const byId = new Map(masteryRows.map((row) => [row.knowledgeId, row]));
  for (const [key, group] of mistakeGroups) {
    if (key === '__unclassified__' || byId.has(key)) continue;
    byId.set(key, {
      knowledgeId: key,
      title: group.title,
      score: 0,
      attempts: 0,
      nextReviewAt: null,
    });
  }
  if (mistakeGroups.has('__unclassified__')) {
    byId.set('__unclassified__', {
      knowledgeId: null,
      queueKey: '__unclassified__',
      title: '未归类错题',
      score: 0,
      attempts: 0,
      nextReviewAt: null,
    });
  }

  const queue = [];
  for (const [key, row] of byId) {
    const dueDate = validDate(row.nextReviewAt);
    const mistakeGroup = mistakeGroups.get(key);
    const mistakeCount = mistakeGroup?.count || 0;
    const isDue = Boolean(dueDate && dueDate <= current);
    const isUnscheduledWeak = !dueDate && row.score < 0.6;
    if (!includeUpcoming && !isDue && !isUnscheduledWeak && mistakeCount === 0) continue;

    const overdueDays = isDue ? Math.max(0, Math.floor((current - dueDate) / DAY_MS)) : 0;
    const reasons = [];
    if (mistakeCount) reasons.push(`${mistakeCount} 道未解决错题`);
    if (isDue) reasons.push(overdueDays ? `已逾期 ${overdueDays} 天` : '今天到期');
    if (isUnscheduledWeak) reasons.push('掌握度偏低且尚未排期');
    if (includeUpcoming && dueDate && !isDue) reasons.push('即将到期');
    if (row.score < 0.5) reasons.push(`掌握度 ${Math.round(row.score * 100)}%`);
    const priority = mistakeCount * 100 + (isDue ? 35 + Math.min(overdueDays, 30) : 0)
      + (1 - row.score) * 30 + (isUnscheduledWeak ? 12 : 0);

    queue.push({
      knowledgeId: row.knowledgeId ?? null,
      title: row.title || mistakeGroup?.title || row.knowledgeId || '未归类错题',
      score: row.score,
      attempts: row.attempts,
      dueAt: dueDate?.toISOString() ?? current.toISOString(),
      overdueDays,
      activeMistakes: mistakeCount,
      mistakeIds: mistakeGroup?.ids ? [...mistakeGroup.ids] : [],
      priority: round(priority, 3),
      reasons,
      reason: reasons.join('；') || '常规复习',
    });
  }

  return queue
    .sort((left, right) => (
      right.priority - left.priority
      || left.dueAt.localeCompare(right.dueAt)
      || String(left.knowledgeId || '').localeCompare(String(right.knowledgeId || ''))
    ))
    .slice(0, limit);
}

function utcDayStart(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeExamDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new TypeError('examDate must be a valid date');
    }
    return date;
  }
  const date = utcDayStart(value);
  if (!date) throw new TypeError('examDate must be a valid date');
  return date;
}

function dailyMinuteLimit(profile, explicit) {
  const preferences = profile?.preferences && typeof profile.preferences === 'object'
    ? profile.preferences
    : {};
  const value = explicit
    ?? profile?.dailyMinutes
    ?? preferences.dailyMinutes
    ?? preferences.dailyStudyMinutes
    ?? preferences.studyMinutesPerDay
    ?? preferences.minutesPerDay
    ?? DEFAULT_DAILY_MINUTES;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > MAX_DAILY_MINUTES) {
    throw new RangeError(`dailyMinutes must be between 0 and ${MAX_DAILY_MINUTES}`);
  }
  return Math.floor(number);
}

function normalizeCatalog(catalog) {
  let rows = [];
  if (Array.isArray(catalog)) {
    rows = catalog;
  } else if (catalog && typeof catalog === 'object' && catalog.knowledge) {
    rows = Object.entries(catalog.knowledge).map(([title, id]) => ({ id, title, type: 'knowledge_candidate' }));
  } else if (catalog && typeof catalog === 'object') {
    rows = Object.entries(catalog).map(([id, value]) => (
      value && typeof value === 'object' ? { id, ...value } : { id, title: value }
    ));
  }
  const seen = new Set();
  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row, index) => ({
      id: String(row.id ?? row.knowledgeId ?? `catalog:${index}`).trim(),
      title: String(row.title || row.name || row.id || row.knowledgeId || `知识点 ${index + 1}`),
      type: String(row.type || 'knowledge_candidate'),
    }))
    .filter((row) => {
      if (!row.id || row.type.includes('method') || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
}

function topicUniverse(catalog, mastery, mistakes, now) {
  const catalogRows = normalizeCatalog(catalog);
  const masteryRows = normalizeMastery(mastery);
  const activeMistakes = normalizeMistakes(mistakes);
  const map = new Map();
  for (const row of catalogRows) {
    map.set(row.id, {
      knowledgeId: row.id,
      title: row.title,
      score: 0.4,
      attempts: 0,
      nextReviewAt: null,
      mistakeCount: 0,
      unseen: true,
    });
  }
  for (const row of masteryRows) {
    const existing = map.get(row.knowledgeId);
    map.set(row.knowledgeId, {
      knowledgeId: row.knowledgeId,
      title: row.title || existing?.title || row.knowledgeId,
      score: row.score,
      attempts: row.attempts,
      nextReviewAt: row.nextReviewAt,
      mistakeCount: existing?.mistakeCount || 0,
      unseen: row.attempts === 0,
    });
  }
  for (const mistake of activeMistakes) {
    if (!mistake.knowledgeId) continue;
    const existing = map.get(mistake.knowledgeId) || {
      knowledgeId: mistake.knowledgeId,
      title: mistake.title,
      score: 0.35,
      attempts: 0,
      nextReviewAt: null,
      mistakeCount: 0,
      unseen: true,
    };
    map.set(mistake.knowledgeId, { ...existing, mistakeCount: existing.mistakeCount + 1 });
  }
  const current = resolveNow(now);
  return [...map.values()].map((topic) => {
    const due = validDate(topic.nextReviewAt);
    const overdueDays = due && due <= current ? Math.max(0, Math.floor((current - due) / DAY_MS)) : 0;
    return {
      ...topic,
      dueAt: due?.toISOString() ?? null,
      overdueDays,
      basePriority: round(
        topic.mistakeCount * 100
        + (1 - topic.score) * 45
        + (due && due <= current ? 25 + Math.min(20, overdueDays) : 0)
        + (topic.unseen ? 5 : 0),
        3,
      ),
    };
  });
}

function addTask(tasks, remaining, draft) {
  if (remaining <= 0 || draft.preferredMinutes <= 0) return remaining;
  const minutes = Math.min(remaining, Math.max(1, Math.floor(draft.preferredMinutes)));
  tasks.push({
    id: draft.id,
    type: draft.type,
    knowledgeId: draft.knowledgeId ?? null,
    title: draft.title,
    minutes,
    reason: draft.reason,
  });
  return remaining - minutes;
}

function rankedTopics(topics, assignmentCounts, predicate = () => true) {
  return topics
    .filter(predicate)
    .map((topic) => ({
      ...topic,
      adjustedPriority: topic.basePriority - (assignmentCounts.get(topic.knowledgeId) || 0) * 14,
    }))
    .sort((left, right) => (
      right.adjustedPriority - left.adjustedPriority
      || left.score - right.score
      || left.knowledgeId.localeCompare(right.knowledgeId)
    ));
}

/**
 * Build an explainable seven-day plan. Dates are handled as UTC calendar days,
 * so the same inputs and clock always produce the same plan on every machine.
 */
export function buildSevenDayPlan({
  profile = {},
  mastery = [],
  mistakes = [],
  catalog = [],
  now,
  dailyMinutes,
} = {}) {
  const generated = resolveNow(now);
  const start = utcDayStart(generated);
  const examDate = normalizeExamDate(profile?.examDate);
  const limit = dailyMinuteLimit(profile, dailyMinutes);
  const activeMistakes = normalizeMistakes(mistakes);
  const unclassifiedMistakes = activeMistakes.filter((item) => !item.knowledgeId);
  const topics = topicUniverse(catalog, mastery, activeMistakes, generated);
  const assignments = new Map();
  const daysUntilExam = examDate ? Math.ceil((examDate - start) / DAY_MS) : null;
  const urgency = daysUntilExam === null ? 'normal' : daysUntilExam <= 14 ? 'sprint' : daysUntilExam <= 60 ? 'focused' : 'foundation';
  const days = [];

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = new Date(start.valueOf() + dayIndex * DAY_MS);
    const dateKey = isoDay(date);
    const isExamDay = Boolean(examDate && date.valueOf() === examDate.valueOf());
    const isAfterExam = Boolean(examDate && date > examDate);
    const tasks = [];
    let remaining = isExamDay || isAfterExam ? 0 : limit;

    if (remaining > 0) {
      const mistakeTopics = rankedTopics(topics, assignments, (topic) => topic.mistakeCount > 0);
      const dueTopics = rankedTopics(topics, assignments, (topic) => {
        const due = validDate(topic.dueAt);
        return Boolean(due && due < new Date(date.valueOf() + DAY_MS));
      });
      const weakTopics = rankedTopics(topics, assignments);
      const mistakeTopic = mistakeTopics[dayIndex % Math.max(1, mistakeTopics.length)] || null;
      const dueTopic = dueTopics.find((topic) => topic.knowledgeId !== mistakeTopic?.knowledgeId) || dueTopics[0] || null;
      const focusTopic = weakTopics.find((topic) => (
        topic.knowledgeId !== mistakeTopic?.knowledgeId && topic.knowledgeId !== dueTopic?.knowledgeId
      )) || weakTopics[0] || null;

      if (mistakeTopic) {
        remaining = addTask(tasks, remaining, {
          id: `${dateKey}:mistake:${mistakeTopic.knowledgeId}`,
          type: 'mistake_review',
          knowledgeId: mistakeTopic.knowledgeId,
          title: `错题回炉 · ${mistakeTopic.title}`,
          preferredMinutes: urgency === 'sprint' ? 20 : 15,
          reason: `${mistakeTopic.mistakeCount} 道未解决错题，先复盘错误原因再独立重做`,
        });
        assignments.set(mistakeTopic.knowledgeId, (assignments.get(mistakeTopic.knowledgeId) || 0) + 1);
      } else if (unclassifiedMistakes.length) {
        remaining = addTask(tasks, remaining, {
          id: `${dateKey}:mistake:unclassified`,
          type: 'mistake_review',
          title: '未归类错题整理',
          preferredMinutes: 15,
          reason: `${unclassifiedMistakes.length} 道错题尚未关联知识点，先归因再重做`,
        });
      }

      if (dueTopic) {
        remaining = addTask(tasks, remaining, {
          id: `${dateKey}:review:${dueTopic.knowledgeId}`,
          type: 'spaced_review',
          knowledgeId: dueTopic.knowledgeId,
          title: `间隔复习 · ${dueTopic.title}`,
          preferredMinutes: 10,
          reason: dueTopic.overdueDays
            ? `复习已逾期 ${dueTopic.overdueDays} 天，用闭卷回忆检验保持度`
            : '已进入复习窗口，用闭卷回忆检验保持度',
        });
        assignments.set(dueTopic.knowledgeId, (assignments.get(dueTopic.knowledgeId) || 0) + 1);
      }

      if (focusTopic) {
        const percentage = Math.round(focusTopic.score * 100);
        remaining = addTask(tasks, remaining, {
          id: `${dateKey}:concept:${focusTopic.knowledgeId}`,
          type: focusTopic.attempts === 0 ? 'diagnostic_concept' : 'concept_repair',
          knowledgeId: focusTopic.knowledgeId,
          title: `${focusTopic.attempts === 0 ? '诊断学习' : '知识补强'} · ${focusTopic.title}`,
          preferredMinutes: urgency === 'sprint' ? 15 : 20,
          reason: focusTopic.attempts === 0
            ? '尚无作答记录，先用例题建立基线'
            : `当前掌握度 ${percentage}%，优先补齐薄弱环节`,
        });
        assignments.set(focusTopic.knowledgeId, (assignments.get(focusTopic.knowledgeId) || 0) + 1);
        remaining = addTask(tasks, remaining, {
          id: `${dateKey}:practice:${focusTopic.knowledgeId}`,
          type: 'targeted_practice',
          knowledgeId: focusTopic.knowledgeId,
          title: `针对练习 · ${focusTopic.title}`,
          preferredMinutes: urgency === 'sprint' ? 25 : 20,
          reason: urgency === 'sprint'
            ? '临近考试，以限时独立作答巩固可得分步骤'
            : '紧跟知识学习完成独立练习，避免只看懂不会做',
        });
      }

      if (remaining > 0) {
        remaining = addTask(tasks, remaining, {
          id: `${dateKey}:recall`,
          type: 'daily_recall',
          title: '当日闭环回忆',
          preferredMinutes: remaining,
          reason: '回忆公式、方法与今日错误，形成次日复习线索',
        });
      }
    }

    const plannedMinutes = tasks.reduce((sum, task) => sum + task.minutes, 0);
    let reason;
    if (isExamDay) reason = '考试日不安排新增学习任务，保留精力完成考试';
    else if (isAfterExam) reason = '考试已经结束，本周期不再安排备考任务';
    else if (limit === 0) reason = '每日学习时长设为 0 分钟';
    else if (tasks.some((task) => task.type === 'mistake_review')) reason = '优先处理未解决错题，再补弱项并完成独立练习';
    else reason = '按照掌握度和复习到期情况安排弱项补强';

    days.push({
      date: dateKey,
      weekday: WEEKDAYS_ZH[date.getUTCDay()],
      dayIndex,
      limitMinutes: isExamDay || isAfterExam ? 0 : limit,
      minutes: plannedMinutes,
      plannedMinutes,
      totalMinutes: plannedMinutes,
      focus: tasks[0]?.title || (isExamDay ? '考试日' : isAfterExam ? '考试已结束' : '无学习任务'),
      reason,
      tasks,
    });
  }

  const totalMinutes = days.reduce((sum, day) => sum + day.minutes, 0);
  return {
    generatedAt: generated.toISOString(),
    horizonStart: isoDay(start),
    examDate: examDate ? isoDay(examDate) : null,
    daysUntilExam,
    urgency,
    dailyMinutes: limit,
    dailyMinuteLimit: limit,
    totalMinutes,
    activeMistakeCount: activeMistakes.length,
    topicCount: topics.length,
    explanation: [
      activeMistakes.length
        ? `计划优先纳入 ${activeMistakes.length} 道未解决错题`
        : '暂无未解决错题，计划以掌握度和复习日期排序',
      examDate
        ? `距离考试 ${Math.max(0, daysUntilExam)} 天，采用${urgency === 'sprint' ? '冲刺' : urgency === 'focused' ? '强化' : '基础'}节奏`
        : '未设置考试日期，采用常规巩固节奏',
      `每天最多 ${limit} 分钟`,
    ],
    days,
  };
}

