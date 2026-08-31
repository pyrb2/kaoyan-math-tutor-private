import fs from 'node:fs';
import path from 'node:path';
import { buildSevenDayPlan, scheduleReview, updateMastery } from './learning.mjs';
import { boundedText, resolveInside, safeDisplayText } from './security.mjs';

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

class HttpError extends Error {
  constructor(status, message, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function securityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
}

function json(response, status, payload) {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(payload));
}

async function readJson(request, limitBytes) {
  const type = String(request.headers['content-type'] || '').split(';', 1)[0].trim();
  if (type !== 'application/json') throw new HttpError(415, '请求必须使用 application/json', 'unsupported_media_type');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, '请求内容过大', 'payload_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new HttpError(400, 'JSON 格式无效', 'invalid_json');
  }
}

function userProfile(stored) {
  if (!stored) {
    return {
      name: '',
      examDate: null,
      targetScore: null,
      subject: '考研数学',
      examType: '数学一',
      dailyMinutes: 60,
    };
  }
  return {
    name: stored.name || '',
    examDate: stored.examDate,
    targetScore: stored.targetScore,
    subject: stored.subject || '考研数学',
    examType: stored.preferences?.examType || '数学一',
    dailyMinutes: stored.preferences?.dailyMinutes || 60,
  };
}

function planFor({ store, index, now }) {
  return buildSevenDayPlan({
    profile: userProfile(store.getProfile()),
    mastery: store.listMastery({ limit: 500 }),
    mistakes: store.listMistakes({ limit: 500 }),
    catalog: index.listCatalog(),
    now,
  });
}

function integerParam(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `参数必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return parsed;
}

function booleanField(value, name) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${name} 必须是布尔值`);
  return value;
}

function normalizeExamDate(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, '考试日期无效');
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match || Number.isNaN(new Date(`${match[0]}T12:00:00+08:00`).valueOf())) {
    throw new HttpError(400, '考试日期无效');
  }
  return `${match[0]}T04:00:00.000Z`;
}

function publicCitation(source) {
  return {
    ...source,
    title: safeDisplayText(source.title),
    heading: safeDisplayText(source.heading || ''),
    excerpt: safeDisplayText(source.excerpt || ''),
    imageUrls: (source.images || []).map((imagePath) => `/api/vault-file?path=${encodeURIComponent(imagePath)}`),
  };
}

async function serveFile(response, absolute, { cache = 'no-cache', headOnly = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new HttpError(404, '文件不存在', 'not_found');
  }
  if (!stat.isFile()) throw new HttpError(404, '文件不存在', 'not_found');
  securityHeaders(response);
  response.statusCode = 200;
  response.setHeader('content-type', CONTENT_TYPES.get(path.extname(absolute).toLowerCase()) || 'application/octet-stream');
  response.setHeader('content-length', stat.size);
  response.setHeader('cache-control', cache);
  if (headOnly) {
    response.end();
    return;
  }
  fs.createReadStream(absolute).pipe(response);
}

export function createRequestHandler({ config, index, store, tutor, provider, now = () => new Date() }) {
  if (!config || !index || !store || !tutor || !provider) throw new TypeError('route dependencies are required');
  const catalogById = new Map(index.listCatalog().map((item) => [item.id, item]));

  return async function handleRequest(request, response) {
    try {
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      let pathname;
      try {
        pathname = decodeURIComponent(requestUrl.pathname);
      } catch {
        throw new HttpError(400, 'URL 编码无效', 'invalid_url');
      }
      if (request.method === 'GET' && pathname === '/api/health') {
        json(response, 200, {
          ok: true,
          mode: provider.available ? 'model' : 'retrieval',
          provider: provider.available ? provider.name || 'deepseek' : null,
          model: provider.available ? provider.model : null,
          indexStats: index.stats,
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        json(response, 200, {
          mode: provider.available ? 'model' : 'retrieval',
          provider: provider.available ? provider.name || 'deepseek' : null,
          model: provider.available ? provider.model : null,
          indexStats: index.stats,
          profile: userProfile(store.getProfile()),
          catalog: index.listCatalog(),
          mastery: store.listMastery({ limit: 500 }),
          mistakes: store.listMistakes({ limit: 200 }),
          sessions: store.listSessions({ limit: 20 }),
          plan: planFor({ store, index, now: now() }),
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/search') {
        const query = boundedText(requestUrl.searchParams.get('q') || '', 6000, '检索词');
        const limit = integerParam(requestUrl.searchParams.get('limit'), 8, 1, 20);
        const results = index.search(query, { limit }).map(publicCitation);
        json(response, 200, { query, results });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/chat') {
        const body = await readJson(request, config.requestLimitBytes);
        const result = await tutor.chat(body);
        json(response, 200, { ...result, citations: result.citations.map(publicCitation) });
        return;
      }

      if (request.method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(pathname)) {
        const sessionId = decodeURIComponent(pathname.split('/')[3]);
        const session = store.getSession(sessionId);
        if (!session) throw new HttpError(404, '会话不存在', 'not_found');
        const messages = store.listChatMessages(sessionId).map((message) => ({
          ...message,
          citations: message.citations.map(publicCitation),
        }));
        json(response, 200, { session, messages });
        return;
      }

      if (request.method === 'PUT' && pathname === '/api/profile') {
        const body = await readJson(request, config.requestLimitBytes);
        const previous = store.getProfile();
        const dailyMinutes = integerParam(body.dailyMinutes, previous?.preferences?.dailyMinutes || 60, 15, 600);
        const examType = body.examType === undefined
          ? previous?.preferences?.examType || '数学一'
          : boundedText(body.examType, 40, '考试类型');
        const targetScore = body.targetScore === '' || body.targetScore === null || body.targetScore === undefined
          ? null
          : Number(body.targetScore);
        const stored = store.upsertProfile({
          name: body.name ?? previous?.name ?? '',
          examDate: body.examDate === undefined ? previous?.examDate ?? null : normalizeExamDate(body.examDate),
          targetScore,
          subject: body.subject || previous?.subject || '考研数学',
          preferences: { ...(previous?.preferences || {}), dailyMinutes, examType },
        });
        json(response, 200, { profile: userProfile(stored), plan: planFor({ store, index, now: now() }) });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/mastery/review') {
        const body = await readJson(request, config.requestLimitBytes);
        const knowledgeId = boundedText(body.knowledgeId, 160, '知识点 ID');
        const correct = booleanField(body.correct, 'correct');
        const hintLevel = integerParam(body.hintLevel, 0, 0, 3);
        const previous = store.getMastery(knowledgeId);
        const practicedAt = now();
        const state = updateMastery(previous && {
          score: previous.score,
          attempts: previous.attempts,
          correctAttempts: previous.correctCount,
          lastPracticedAt: previous.lastReviewedAt,
        }, { correct, hintLevel, now: practicedAt });
        const schedule = scheduleReview(previous, { correct, hintLevel, now: practicedAt });
        const catalogItem = catalogById.get(knowledgeId);
        const mastery = store.upsertMastery({
          knowledgeId,
          title: body.title || previous?.title || catalogItem?.title || knowledgeId,
          score: state.score,
          attempts: state.attempts,
          correctCount: state.correctAttempts,
          lastReviewedAt: state.lastPracticedAt,
          nextReviewAt: schedule.nextReviewAt,
          notes: previous?.notes || null,
        });
        json(response, 200, { mastery, schedule, plan: planFor({ store, index, now: practicedAt }) });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/mistakes') {
        const body = await readJson(request, config.requestLimitBytes);
        const mistake = store.addMistake({
          question: body.question,
          knowledgeId: body.knowledgeId,
          userAnswer: body.userAnswer,
          correctAnswer: body.correctAnswer,
          errorType: body.errorType,
          analysis: body.analysis,
          sourceRef: body.sourceRef,
          status: body.status,
        });
        json(response, 201, { mistake, plan: planFor({ store, index, now: now() }) });
        return;
      }

      const mistakeMatch = pathname.match(/^\/api\/mistakes\/(\d+)$/);
      if (request.method === 'PATCH' && mistakeMatch) {
        const body = await readJson(request, config.requestLimitBytes);
        const mistake = store.updateMistake(Number(mistakeMatch[1]), body);
        json(response, 200, { mistake, plan: planFor({ store, index, now: now() }) });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/plan') {
        json(response, 200, { plan: planFor({ store, index, now: now() }) });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/vault-file') {
        const requested = requestUrl.searchParams.get('path');
        let absolute;
        try {
          absolute = resolveInside(config.vaultPath, requested);
        } catch (error) {
          throw new HttpError(400, error.message, 'invalid_path');
        }
        if (!IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
          throw new HttpError(415, '仅允许读取知识库图片', 'unsupported_media_type');
        }
        await serveFile(response, absolute, { cache: 'private, max-age=3600' });
        return;
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        const publicPath = pathname === '/' ? 'index.html' : pathname.slice(1);
        let absolute;
        try {
          absolute = resolveInside(config.publicDir, publicPath);
        } catch {
          throw new HttpError(404, '页面不存在', 'not_found');
        }
        await serveFile(response, absolute, { headOnly: request.method === 'HEAD' });
        return;
      }

      throw new HttpError(404, '接口不存在', 'not_found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      const code = error instanceof HttpError ? error.code : 'request_failed';
      const message = error instanceof HttpError ? error.message : safeDisplayText(error?.message || '请求失败');
      if (!response.headersSent) json(response, status, { error: { code, message } });
      else response.destroy();
    }
  };
}

export { HttpError, userProfile };
