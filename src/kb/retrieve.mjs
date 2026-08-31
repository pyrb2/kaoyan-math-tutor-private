import { safeDisplayText } from '../security.mjs';

function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokenize(value) {
  const text = normalized(value);
  const tokens = [];
  for (const match of text.matchAll(/[\p{Script=Han}]+|[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?/gu)) {
    const item = match[0];
    if (/^[\p{Script=Han}]+$/u.test(item)) {
      if (item.length <= 12) tokens.push(item);
      for (let index = 0; index < item.length - 1; index += 1) tokens.push(item.slice(index, index + 2));
      for (let index = 0; index < item.length - 2; index += 1) tokens.push(item.slice(index, index + 3));
    } else {
      tokens.push(item);
    }
  }
  return tokens;
}

function frequencies(tokens) {
  const result = new Map();
  for (const token of tokens) result.set(token, (result.get(token) || 0) + 1);
  return result;
}

function excerptFor(chunk, queryTokens, length = 460) {
  const plain = chunk.text.replace(/\s+/g, ' ').trim();
  const lower = normalized(plain);
  let position = -1;
  for (const token of queryTokens.sort((a, b) => b.length - a.length)) {
    position = lower.indexOf(token);
    if (position >= 0) break;
  }
  const start = Math.max(0, position < 0 ? 0 : position - Math.floor(length / 3));
  const value = plain.slice(start, start + length);
  return `${start > 0 ? '…' : ''}${value}${start + length < plain.length ? '…' : ''}`;
}

function bm25Score(entry, queryTokens, documentFrequency, total, averageLength) {
  const k1 = 1.35;
  const b = 0.72;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const tf = entry.frequency.get(token) || 0;
    if (!tf) continue;
    const df = documentFrequency.get(token) || 0;
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
    const denominator = tf + k1 * (1 - b + b * (entry.length / averageLength));
    score += idf * ((tf * (k1 + 1)) / denominator);
  }
  return score;
}

function displayResult(entry, queryTokens, score, reason) {
  const chunk = entry.chunk;
  return {
    id: chunk.id,
    sourceId: chunk.sourceId,
    title: safeDisplayText(chunk.title),
    path: chunk.path,
    page: chunk.pdfPage,
    anchor: chunk.anchor,
    heading: safeDisplayText(chunk.heading || ''),
    status: chunk.status,
    docType: chunk.docType,
    evidenceTier: chunk.evidenceTier,
    excerpt: safeDisplayText(excerptFor(chunk, [...queryTokens])),
    images: chunk.images,
    contentHash: chunk.contentHash,
    retrievalReason: reason,
    score: Number(score.toFixed(4)),
  };
}

export class VaultSearchIndex {
  constructor(scanResult) {
    this.documents = scanResult.documents;
    this.markdownFiles = scanResult.markdownFiles;
    this.entries = scanResult.chunks.map((chunk) => {
      const titleTokens = tokenize(chunk.title);
      const tokens = tokenize(`${chunk.title} ${chunk.heading || ''} ${chunk.text}`);
      return {
        chunk,
        normalizedTitle: normalized(chunk.title),
        titleTokens: new Set(titleTokens),
        frequency: frequencies(tokens),
        length: Math.max(1, tokens.length),
      };
    });
    this.byPath = new Map();
    this.documentFrequency = new Map();
    for (const entry of this.entries) {
      if (!this.byPath.has(entry.chunk.path)) this.byPath.set(entry.chunk.path, []);
      this.byPath.get(entry.chunk.path).push(entry);
      for (const token of entry.frequency.keys()) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) || 0) + 1);
      }
    }
    this.averageLength = this.entries.reduce((sum, entry) => sum + entry.length, 0) / Math.max(1, this.entries.length);
    this.stats = {
      markdownFileCount: this.markdownFiles.length,
      indexedDocumentCount: new Set(this.entries.map((entry) => entry.chunk.path)).size,
      chunkCount: this.entries.length,
      ocrPageChunkCount: this.entries.filter((entry) => entry.chunk.docType === 'ocr_page').length,
      ocrPageCount: new Set(
        this.entries
          .filter((entry) => entry.chunk.docType === 'ocr_page')
          .map((entry) => `${entry.chunk.path}#${entry.chunk.anchor}`),
      ).size,
      knowledgeCount: this.documents.filter((document) => document.docType === 'knowledge_candidate').length,
      methodCount: this.documents.filter((document) => document.docType === 'method_candidate').length,
    };
  }

  search(query, { limit = 8, maxPerDocument = 2, requireOcr = true } = {}) {
    const cleanQuery = normalized(query);
    const queryTokens = tokenize(cleanQuery);
    if (!queryTokens.length) return [];
    const scored = [];
    for (const entry of this.entries) {
      let score = bm25Score(entry, queryTokens, this.documentFrequency, this.entries.length, this.averageLength);
      let reason = 'lexical';
      if (cleanQuery.includes(entry.normalizedTitle) || entry.normalizedTitle.includes(cleanQuery)) {
        score += 9;
        reason = 'title_match';
      } else {
        const titleMatches = queryTokens.filter((token) => entry.titleTokens.has(token)).length;
        if (titleMatches) score += titleMatches * 1.8;
      }
      if (entry.chunk.docType !== 'ocr_page') score *= 1.12;
      if (score > 0.05) scored.push({ entry, score, reason });
    }
    scored.sort((left, right) => right.score - left.score || left.entry.chunk.id.localeCompare(right.entry.chunk.id));

    const linkedCoursePaths = new Set();
    for (const item of scored.slice(0, 8)) {
      if (item.entry.chunk.docType === 'ocr_page') continue;
      for (const link of item.entry.chunk.outboundLinks) {
        if (link.startsWith('01-课程笔记/')) linkedCoursePaths.add(link);
      }
    }
    if (linkedCoursePaths.size) {
      for (const item of scored) {
        if (!linkedCoursePaths.has(item.entry.chunk.path)) continue;
        item.score += 3.25;
        if (item.reason === 'lexical') item.reason = 'linked_from';
      }
      scored.sort((left, right) => right.score - left.score || left.entry.chunk.id.localeCompare(right.entry.chunk.id));
    }

    const selected = [];
    const perPath = new Map();
    for (const item of scored) {
      const count = perPath.get(item.entry.chunk.path) || 0;
      if (count >= maxPerDocument) continue;
      selected.push(item);
      perPath.set(item.entry.chunk.path, count + 1);
      if (selected.length >= limit) break;
    }
    if (requireOcr && selected.length && !selected.some((item) => item.entry.chunk.docType === 'ocr_page')) {
      const fallback = scored.find((item) => item.entry.chunk.docType === 'ocr_page');
      if (fallback) {
        if (selected.length >= limit) selected.pop();
        selected.push(fallback);
      }
    }
    return selected.map((item) => displayResult(item.entry, queryTokens, item.score, item.reason));
  }

  listCatalog() {
    return this.documents
      .filter((document) => document.docType === 'knowledge_candidate' || document.docType === 'method_candidate')
      .map((document) => ({
        id: catalogIdForDocument(document, this.entries),
        title: safeDisplayText(document.title),
        type: document.docType,
        path: document.path,
        status: document.status,
        domain: document.volume,
      }))
      .filter((item) => item.id)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

function catalogIdForDocument(document, entries) {
  return entries.find((entry) => entry.chunk.path === document.path)?.chunk.sourceId || null;
}
