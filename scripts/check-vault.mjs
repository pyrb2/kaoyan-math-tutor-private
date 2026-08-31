import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { buildVaultIndex } from '../src/kb/index.mjs';
import { resolveInside } from '../src/security.mjs';

const EXPECTED = Object.freeze({
  markdownFileCount: 95,
  indexedDocumentCount: 86,
  ocrDocumentCount: 32,
  ocrPageCount: 752,
  knowledgeCount: 38,
  methodCount: 16,
});

const REPRESENTATIVE_QUERIES = [
  '泰勒公式什么时候用？和中值定理有什么联系？',
  '二重积分怎么交换积分次序？',
  '条件概率、全概率公式和贝叶斯公式',
];

function verifyVault(index, vaultPath) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const courseDocuments = index.documents.filter((document) => document.docType === 'ocr_page');
  const chunks = index.entries.map((entry) => entry.chunk);
  const sourceCache = new Map();

  for (const [key, expected] of Object.entries(EXPECTED)) {
    const actual = key === 'ocrDocumentCount' ? courseDocuments.length : index.stats[key];
    expect(actual === expected, `${key}: 预期 ${expected}，实际 ${actual}`);
  }

  for (const document of courseDocuments) {
    expect(
      chunks.some((chunk) => chunk.path === document.path),
      `课程文档没有生成索引块: ${document.path}`,
    );
  }

  const seenPages = new Set();
  for (const chunk of chunks) {
    if (chunk.docType === 'ocr_page') {
      expect(chunk.evidenceTier === 'ocr_source', `课程块证据级别错误: ${chunk.id}`);
      expect(Number.isInteger(chunk.pdfPage) && chunk.pdfPage > 0, `课程块页码无效: ${chunk.id}`);
      expect(
        /^pdf-page-\d+$/.test(chunk.anchor) && Number(chunk.anchor.slice('pdf-page-'.length)) === chunk.pdfPage,
        `课程块页锚与页码不一致: ${chunk.id}`,
      );
      const pageKey = `${chunk.path}#${chunk.anchor}`;
      if (seenPages.has(pageKey)) continue;
      seenPages.add(pageKey);
      let absolute;
      try {
        absolute = resolveInside(vaultPath, chunk.path);
      } catch (error) {
        failures.push(`课程来源路径越界: ${chunk.path} (${error.message})`);
        continue;
      }
      expect(fs.existsSync(absolute), `课程来源不存在: ${chunk.path}`);
      if (!fs.existsSync(absolute)) continue;
      if (!sourceCache.has(absolute)) sourceCache.set(absolute, fs.readFileSync(absolute, 'utf8'));
      const markdown = sourceCache.get(absolute);
      expect(
        markdown.includes(`id="${chunk.anchor}"`) || markdown.includes(`id='${chunk.anchor}'`),
        `课程来源缺少页锚: ${pageKey}`,
      );
    } else if (chunk.docType === 'knowledge_candidate' || chunk.docType === 'method_candidate') {
      expect(chunk.evidenceTier === 'graph_candidate', `候选页冒充教材证据: ${chunk.id}`);
      expect(chunk.pdfPage === null && chunk.anchor === null, `候选页不应携带 PDF 页码或页锚: ${chunk.id}`);
    }
  }

  expect(seenPages.size === EXPECTED.ocrPageCount, `唯一课程页数量异常: ${seenPages.size}`);

  for (const query of REPRESENTATIVE_QUERIES) {
    const results = index.search(query, { limit: 6, maxPerDocument: 2, requireOcr: true });
    expect(results.length > 0, `代表性检索没有结果: ${query}`);
    expect(results.some((result) => result.evidenceTier === 'ocr_source'), `代表性检索缺少 OCR 课程证据: ${query}`);
    const counts = new Map();
    for (const result of results) {
      counts.set(result.path, (counts.get(result.path) || 0) + 1);
      if (result.evidenceTier === 'graph_candidate') {
        expect(result.page === null && result.anchor === null, `候选检索结果伪装成页级教材证据: ${result.id}`);
      }
      if (result.evidenceTier !== 'ocr_source') continue;
      const absolute = resolveInside(vaultPath, result.path);
      expect(fs.existsSync(absolute), `检索引用来源不存在: ${result.path}`);
      const markdown = fs.readFileSync(absolute, 'utf8');
      expect(
        markdown.includes(`id="${result.anchor}"`) || markdown.includes(`id='${result.anchor}'`),
        `检索引用页锚不存在: ${result.path}#${result.anchor}`,
      );
    }
    expect([...counts.values()].every((count) => count <= 2), `代表性检索未限制单文档占位: ${query}`);
  }

  return failures;
}

function main() {
  const config = loadConfig();
  const index = buildVaultIndex(config.vaultPath);
  const failures = verifyVault(index, config.vaultPath);
  const ocrDocumentCount = index.documents.filter((document) => document.docType === 'ocr_page').length;
  console.log(`知识库: ${config.vaultPath}`);
  console.log(JSON.stringify({ ...index.stats, ocrDocumentCount }, null, 2));
  if (failures.length) {
    console.error(`\n校验失败，共 ${failures.length} 项:`);
    for (const failure of failures.slice(0, 30)) console.error(`- ${failure}`);
    if (failures.length > 30) console.error(`- 其余 ${failures.length - 30} 项已省略`);
    process.exitCode = 1;
    return;
  }
  console.log('\n校验通过: 统计、页锚、证据分级与代表性检索均符合基线。');
}

main();
