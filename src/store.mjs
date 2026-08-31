import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const CHAT_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MISTAKE_STATUSES = new Set(['active', 'reviewing', 'resolved']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string or null`);
  return value.trim() || null;
}

function timestamp(value, name) {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError(`${name} must be a valid date`);
  return date.toISOString();
}

function boundedNumber(value, name, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value, name, maximum = 1000) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function jsonString(value, name) {
  if (value === undefined) return '{}';
  assertObject(value, name);
  return JSON.stringify(value);
}

function jsonArray(value, name) {
  if (value === undefined) return '[]';
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return JSON.stringify(value);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapProfile(row) {
  return row ? {
    name: row.name,
    examDate: row.exam_date,
    targetScore: row.target_score,
    subject: row.subject,
    preferences: parseJson(row.preferences_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function mapMastery(row) {
  return row ? {
    knowledgeId: row.knowledge_id,
    title: row.title,
    score: row.score,
    attempts: row.attempts,
    correctCount: row.correct_count,
    notes: row.notes,
    lastReviewedAt: row.last_reviewed_at,
    nextReviewAt: row.next_review_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function mapMistake(row) {
  return row ? {
    id: row.id,
    question: row.question,
    knowledgeId: row.knowledge_id,
    userAnswer: row.user_answer,
    correctAnswer: row.correct_answer,
    errorType: row.error_type,
    analysis: row.analysis,
    sourceRef: row.source_ref,
    status: row.status,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function mapSession(row) {
  return row ? {
    id: row.id,
    title: row.title,
    summary: row.summary,
    metadata: parseJson(row.metadata_json, {}),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function mapChat(row) {
  return row ? {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    citations: parseJson(row.citations_json, []),
    createdAt: row.created_at,
  } : null;
}

function makeClock(now) {
  if (now === undefined) return () => new Date().toISOString();
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  return () => timestamp(now(), 'now');
}

export class TutorStore {
  #db;
  #now;
  #closed = false;

  constructor({ dbPath = ':memory:', now } = {}) {
    if (typeof dbPath !== 'string' || dbPath.trim() === '') {
      throw new TypeError('dbPath must be a non-empty string');
    }

    const normalizedPath = dbPath === ':memory:' ? dbPath : resolve(dbPath);
    if (normalizedPath !== ':memory:') mkdirSync(dirname(normalizedPath), { recursive: true });

    this.#now = makeClock(now);
    this.#db = new DatabaseSync(normalizedPath);
    this.#initialize(normalizedPath !== ':memory:');
  }

  #initialize(useWal) {
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    if (useWal) this.#db.exec('PRAGMA journal_mode = WAL;');

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        name TEXT,
        exam_date TEXT,
        target_score REAL CHECK (target_score IS NULL OR (target_score >= 0 AND target_score <= 150)),
        subject TEXT,
        preferences_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mastery (
        knowledge_id TEXT PRIMARY KEY,
        title TEXT,
        score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0 AND correct_count <= attempts),
        notes TEXT,
        last_reviewed_at TEXT,
        next_review_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mistakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        knowledge_id TEXT,
        user_answer TEXT,
        correct_answer TEXT,
        error_type TEXT,
        analysis TEXT,
        source_ref TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reviewing', 'resolved')),
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        summary TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        citations_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mastery_next_review ON mastery(next_review_at);
      CREATE INDEX IF NOT EXISTS idx_mistakes_status_created ON mistakes(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_session_id ON chat_logs(session_id, id);
      PRAGMA user_version = 1;
    `);
  }

  #assertOpen() {
    if (this.#closed) throw new Error('TutorStore is closed');
  }

  close() {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }

  getProfile() {
    this.#assertOpen();
    return mapProfile(this.#db.prepare('SELECT * FROM profile WHERE singleton = 1').get());
  }

  upsertProfile(input) {
    this.#assertOpen();
    assertObject(input, 'profile');
    const existing = this.getProfile();
    const now = this.#now();
    const profile = {
      name: input.name === undefined ? existing?.name ?? null : optionalText(input.name, 'name'),
      examDate: input.examDate === undefined ? existing?.examDate ?? null : timestamp(input.examDate, 'examDate'),
      targetScore: input.targetScore === undefined
        ? existing?.targetScore ?? null
        : input.targetScore === null ? null : boundedNumber(input.targetScore, 'targetScore', 0, 150),
      subject: input.subject === undefined ? existing?.subject ?? null : optionalText(input.subject, 'subject'),
      preferences: input.preferences === undefined ? existing?.preferences ?? {} : input.preferences,
    };
    const preferencesJson = jsonString(profile.preferences, 'preferences');

    this.#db.prepare(`
      INSERT INTO profile (
        singleton, name, exam_date, target_score, subject, preferences_json, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        name = excluded.name,
        exam_date = excluded.exam_date,
        target_score = excluded.target_score,
        subject = excluded.subject,
        preferences_json = excluded.preferences_json,
        updated_at = excluded.updated_at
    `).run(profile.name, profile.examDate, profile.targetScore, profile.subject, preferencesJson, existing?.createdAt ?? now, now);
    return this.getProfile();
  }

  getMastery(knowledgeId) {
    this.#assertOpen();
    return mapMastery(this.#db.prepare('SELECT * FROM mastery WHERE knowledge_id = ?').get(requiredText(knowledgeId, 'knowledgeId')));
  }

  upsertMastery(input) {
    this.#assertOpen();
    assertObject(input, 'mastery');
    const knowledgeId = requiredText(input.knowledgeId, 'knowledgeId');
    const existing = this.getMastery(knowledgeId);
    const score = input.score === undefined
      ? existing?.score ?? 0
      : boundedNumber(input.score, 'score', 0, 1);
    const attempts = input.attempts === undefined
      ? existing?.attempts ?? 0
      : nonNegativeInteger(input.attempts, 'attempts');
    const correctCount = input.correctCount === undefined
      ? existing?.correctCount ?? 0
      : nonNegativeInteger(input.correctCount, 'correctCount');
    if (correctCount > attempts) throw new RangeError('correctCount cannot exceed attempts');

    const now = this.#now();
    const values = {
      title: input.title === undefined ? existing?.title ?? null : optionalText(input.title, 'title'),
      notes: input.notes === undefined ? existing?.notes ?? null : optionalText(input.notes, 'notes'),
      lastReviewedAt: input.lastReviewedAt === undefined
        ? existing?.lastReviewedAt ?? null
        : timestamp(input.lastReviewedAt, 'lastReviewedAt'),
      nextReviewAt: input.nextReviewAt === undefined
        ? existing?.nextReviewAt ?? null
        : timestamp(input.nextReviewAt, 'nextReviewAt'),
    };

    this.#db.prepare(`
      INSERT INTO mastery (
        knowledge_id, title, score, attempts, correct_count, notes,
        last_reviewed_at, next_review_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(knowledge_id) DO UPDATE SET
        title = excluded.title,
        score = excluded.score,
        attempts = excluded.attempts,
        correct_count = excluded.correct_count,
        notes = excluded.notes,
        last_reviewed_at = excluded.last_reviewed_at,
        next_review_at = excluded.next_review_at,
        updated_at = excluded.updated_at
    `).run(
      knowledgeId, values.title, score, attempts, correctCount, values.notes,
      values.lastReviewedAt, values.nextReviewAt, existing?.createdAt ?? now, now,
    );
    return this.getMastery(knowledgeId);
  }

  listMastery({ limit = 200, belowScore, dueBefore } = {}) {
    this.#assertOpen();
    const clauses = [];
    const parameters = [];
    if (belowScore !== undefined) {
      clauses.push('score <= ?');
      parameters.push(boundedNumber(belowScore, 'belowScore', 0, 1));
    }
    if (dueBefore !== undefined) {
      clauses.push('next_review_at IS NOT NULL AND next_review_at <= ?');
      parameters.push(timestamp(dueBefore, 'dueBefore'));
    }
    parameters.push(positiveInteger(limit, 'limit'));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.#db.prepare(`
      SELECT * FROM mastery ${where}
      ORDER BY score ASC, COALESCE(next_review_at, '9999-12-31T23:59:59.999Z') ASC, knowledge_id ASC
      LIMIT ?
    `).all(...parameters).map(mapMastery);
  }

  addMistake(input) {
    this.#assertOpen();
    assertObject(input, 'mistake');
    const question = requiredText(input.question, 'question');
    const status = input.status ?? 'active';
    if (!MISTAKE_STATUSES.has(status)) throw new RangeError('status is invalid');
    const now = this.#now();
    const result = this.#db.prepare(`
      INSERT INTO mistakes (
        question, knowledge_id, user_answer, correct_answer, error_type,
        analysis, source_ref, status, reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      question,
      optionalText(input.knowledgeId, 'knowledgeId'),
      optionalText(input.userAnswer, 'userAnswer'),
      optionalText(input.correctAnswer, 'correctAnswer'),
      optionalText(input.errorType, 'errorType'),
      optionalText(input.analysis, 'analysis'),
      optionalText(input.sourceRef, 'sourceRef'),
      status,
      timestamp(input.reviewedAt, 'reviewedAt'),
      now,
      now,
    );
    return this.getMistake(Number(result.lastInsertRowid));
  }

  getMistake(id) {
    this.#assertOpen();
    return mapMistake(this.#db.prepare('SELECT * FROM mistakes WHERE id = ?').get(positiveInteger(id, 'id', Number.MAX_SAFE_INTEGER)));
  }

  updateMistake(id, patch) {
    this.#assertOpen();
    assertObject(patch, 'patch');
    const current = this.getMistake(id);
    if (!current) throw new Error(`mistake ${id} does not exist`);
    const status = patch.status ?? current.status;
    if (!MISTAKE_STATUSES.has(status)) throw new RangeError('status is invalid');
    const value = (key) => patch[key] === undefined ? current[key] : optionalText(patch[key], key);
    const reviewedAt = patch.reviewedAt === undefined
      ? current.reviewedAt
      : timestamp(patch.reviewedAt, 'reviewedAt');

    this.#db.prepare(`
      UPDATE mistakes SET
        question = ?, knowledge_id = ?, user_answer = ?, correct_answer = ?, error_type = ?,
        analysis = ?, source_ref = ?, status = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.question === undefined ? current.question : requiredText(patch.question, 'question'),
      value('knowledgeId'),
      value('userAnswer'),
      value('correctAnswer'),
      value('errorType'),
      value('analysis'),
      value('sourceRef'),
      status,
      reviewedAt,
      this.#now(),
      id,
    );
    return this.getMistake(id);
  }

  listMistakes({ status, knowledgeId, limit = 100 } = {}) {
    this.#assertOpen();
    const clauses = [];
    const parameters = [];
    if (status !== undefined) {
      if (!MISTAKE_STATUSES.has(status)) throw new RangeError('status is invalid');
      clauses.push('status = ?');
      parameters.push(status);
    }
    if (knowledgeId !== undefined) {
      clauses.push('knowledge_id = ?');
      parameters.push(requiredText(knowledgeId, 'knowledgeId'));
    }
    parameters.push(positiveInteger(limit, 'limit'));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.#db.prepare(`SELECT * FROM mistakes ${where} ORDER BY id DESC LIMIT ?`).all(...parameters).map(mapMistake);
  }

  startSession({ id = randomUUID(), title, metadata, startedAt } = {}) {
    this.#assertOpen();
    const sessionId = requiredText(id, 'id');
    const started = timestamp(startedAt ?? this.#now(), 'startedAt');
    const now = this.#now();
    this.#db.prepare(`
      INSERT INTO sessions (id, title, summary, metadata_json, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)
    `).run(sessionId, optionalText(title, 'title'), jsonString(metadata, 'metadata'), started, now, now);
    return this.getSession(sessionId);
  }

  getSession(id) {
    this.#assertOpen();
    return mapSession(this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(requiredText(id, 'id')));
  }

  endSession(id, { summary, endedAt } = {}) {
    this.#assertOpen();
    const sessionId = requiredText(id, 'id');
    if (!this.getSession(sessionId)) throw new Error(`session ${sessionId} does not exist`);
    this.#db.prepare(`UPDATE sessions SET summary = ?, ended_at = ?, updated_at = ? WHERE id = ?`).run(
      optionalText(summary, 'summary'),
      timestamp(endedAt ?? this.#now(), 'endedAt'),
      this.#now(),
      sessionId,
    );
    return this.getSession(sessionId);
  }

  listSessions({ limit = 50 } = {}) {
    this.#assertOpen();
    return this.#db.prepare('SELECT * FROM sessions ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(positiveInteger(limit, 'limit'))
      .map(mapSession);
  }

  appendChatMessage({ sessionId, role, content, citations, createdAt }) {
    this.#assertOpen();
    const normalizedSessionId = requiredText(sessionId, 'sessionId');
    if (!CHAT_ROLES.has(role)) throw new RangeError('role is invalid');
    if (!this.getSession(normalizedSessionId)) throw new Error(`session ${normalizedSessionId} does not exist`);
    const messageCreatedAt = timestamp(createdAt ?? this.#now(), 'createdAt');
    const result = this.#db.prepare(`
      INSERT INTO chat_logs (session_id, role, content, citations_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      normalizedSessionId,
      role,
      requiredText(content, 'content'),
      jsonArray(citations, 'citations'),
      messageCreatedAt,
    );
    this.#db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(messageCreatedAt, normalizedSessionId);
    return mapChat(this.#db.prepare('SELECT * FROM chat_logs WHERE id = ?').get(Number(result.lastInsertRowid)));
  }

  listChatMessages(sessionId, { limit = 500 } = {}) {
    this.#assertOpen();
    const id = requiredText(sessionId, 'sessionId');
    return this.#db.prepare(`
      SELECT * FROM (
        SELECT * FROM chat_logs WHERE session_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(id, positiveInteger(limit, 'limit')).map(mapChat);
  }
}

export function createTutorStore(options) {
  return new TutorStore(options);
}
