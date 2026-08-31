import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildVaultIndex, scanVault } from '../src/kb/index.mjs';
import { resolveInside } from '../src/security.mjs';

const VAULT_ROOT = path.resolve(import.meta.dirname, '../../shuxue');
const scan = scanVault(VAULT_ROOT);
const index = buildVaultIndex(VAULT_ROOT);

test('vault baseline statistics remain complete', () => {
  assert.equal(scan.markdownFiles.length, 95);
  assert.deepEqual(index.stats, {
    markdownFileCount: 95,
    indexedDocumentCount: 86,
    chunkCount: index.stats.chunkCount,
    ocrPageChunkCount: index.stats.ocrPageChunkCount,
    ocrPageCount: 752,
    knowledgeCount: 38,
    methodCount: 16,
  });
  assert.equal(index.documents.filter((document) => document.docType === 'ocr_page').length, 32);
  assert.ok(index.stats.chunkCount >= index.stats.ocrPageCount + 38 + 16);
  assert.ok(index.stats.ocrPageChunkCount >= index.stats.ocrPageCount);
});

test('every indexed course page points to a real OCR page anchor', () => {
  const chunks = index.entries.map((entry) => entry.chunk);
  const courseDocuments = index.documents.filter((document) => document.docType === 'ocr_page');
  const pages = new Set();
  const sourceCache = new Map();

  for (const document of courseDocuments) {
    assert.ok(chunks.some((chunk) => chunk.path === document.path), `missing chunks for ${document.path}`);
  }

  for (const chunk of chunks.filter((item) => item.docType === 'ocr_page')) {
    assert.equal(chunk.evidenceTier, 'ocr_source');
    assert.match(chunk.anchor, /^pdf-page-\d+$/);
    assert.equal(Number(chunk.anchor.slice('pdf-page-'.length)), chunk.pdfPage);
    const key = `${chunk.path}#${chunk.anchor}`;
    if (pages.has(key)) continue;
    pages.add(key);
    const absolute = resolveInside(VAULT_ROOT, chunk.path);
    assert.ok(fs.existsSync(absolute), chunk.path);
    if (!sourceCache.has(absolute)) sourceCache.set(absolute, fs.readFileSync(absolute, 'utf8'));
    const markdown = sourceCache.get(absolute);
    assert.ok(
      markdown.includes(`id="${chunk.anchor}"`) || markdown.includes(`id='${chunk.anchor}'`),
      key,
    );
  }
  assert.equal(pages.size, 752);
});

test('candidate notes stay graph routes and cannot masquerade as textbook evidence', () => {
  const candidates = index.entries
    .map((entry) => entry.chunk)
    .filter((chunk) => chunk.docType === 'knowledge_candidate' || chunk.docType === 'method_candidate');
  assert.equal(new Set(candidates.map((chunk) => chunk.path)).size, 54);
  for (const candidate of candidates) {
    assert.equal(candidate.evidenceTier, 'graph_candidate');
    assert.equal(candidate.pdfPage, null);
    assert.equal(candidate.anchor, null);
  }
});

for (const query of [
  '泰勒公式什么时候用？和中值定理有什么联系？',
  '二重积分怎样交换积分次序？',
  '全概率公式、条件概率和贝叶斯公式',
]) {
  test(`retrieval includes verifiable OCR evidence: ${query}`, () => {
    const results = index.search(query, { limit: 6, maxPerDocument: 2, requireOcr: true });
    assert.ok(results.length > 0);
    assert.ok(results.some((result) => result.evidenceTier === 'ocr_source'));

    const perDocument = new Map();
    for (const result of results) {
      perDocument.set(result.path, (perDocument.get(result.path) || 0) + 1);
      if (result.evidenceTier === 'graph_candidate') {
        assert.equal(result.page, null);
        assert.equal(result.anchor, null);
        continue;
      }
      assert.equal(result.evidenceTier, 'ocr_source');
      const absolute = resolveInside(VAULT_ROOT, result.path);
      assert.ok(fs.existsSync(absolute));
      const markdown = fs.readFileSync(absolute, 'utf8');
      assert.ok(markdown.includes(`id="${result.anchor}"`) || markdown.includes(`id='${result.anchor}'`));
    }
    assert.ok([...perDocument.values()].every((count) => count <= 2));
  });
}
