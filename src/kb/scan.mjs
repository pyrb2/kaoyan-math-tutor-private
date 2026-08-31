import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { catalogId } from './catalog.mjs';
import { isInside, normalizeVaultPath } from '../security.mjs';

const PAGE_ANCHOR_RE = /<a\s+id=["'](pdf-page-(\d+))["']\s*><\/a>/gi;
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))[^>]*>/gi;

export function walkMarkdown(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.obsidian' || entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(absolute);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function scalar(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontmatter(markdown) {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, body: normalized };
  const data = {};
  let activeList = null;
  for (const line of match[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && activeList) {
      data[activeList].push(scalar(item[1]));
      continue;
    }
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const [, key, rawValue] = field;
    if (!rawValue.trim()) {
      data[key] = [];
      activeList = key;
    } else {
      data[key] = scalar(rawValue);
      activeList = null;
    }
  }
  return { data, body: normalized.slice(match[0].length) };
}

function decodeEntities(value) {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

export function markdownToPlain(markdown) {
  return decodeEntities(markdown)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(MD_IMAGE_RE, ' [教材图片] ')
    .replace(HTML_IMAGE_RE, ' [教材图片] ')
    .replace(/<\/(?:td|th|tr|p|div|table)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(WIKILINK_RE, (_, raw) => {
      const [targetAndHeading, alias] = raw.split('|', 2);
      const target = targetAndHeading.split('#', 1)[0];
      return alias || path.posix.basename(target);
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?(?:\[![^\]]+\]\s*)?/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHeading(markdown) {
  const headings = [...markdown.matchAll(/^\s{0,3}#{1,5}\s+(.+?)\s*$/gm)]
    .map((match) => markdownToPlain(match[1]))
    .filter((title) => title && !/^PDF\s*第\s*\d+\s*页$/i.test(title) && title !== 'OCR 正文');
  return headings.at(-1) || null;
}

function extractOutboundLinks(markdown) {
  const links = new Set();
  for (const match of markdown.matchAll(WIKILINK_RE)) {
    let target = match[1].split('|', 1)[0].split('#', 1)[0].trim().replaceAll('\\', '/');
    if (!target || /^https?:/i.test(target)) continue;
    if (!path.posix.extname(target)) target += '.md';
    links.add(path.posix.normalize(target));
  }
  return [...links];
}

function resolveImageReference(vaultRoot, sourceRelative, raw) {
  const cleaned = decodeURIComponent(String(raw || '').split(/[?#]/, 1)[0]).replaceAll('\\', '/');
  if (!cleaned || /^(?:https?:|data:|app:)/i.test(cleaned) || /^[A-Za-z]:\//.test(cleaned)) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRelative), cleaned));
  const absolute = path.resolve(vaultRoot, ...joined.split('/'));
  if (!isInside(vaultRoot, absolute) || !fs.existsSync(absolute)) return null;
  return normalizeVaultPath(vaultRoot, absolute);
}

function extractImages(vaultRoot, sourceRelative, markdown) {
  const found = new Set();
  for (const pattern of [MD_IMAGE_RE, HTML_IMAGE_RE]) {
    pattern.lastIndex = 0;
    for (const match of markdown.matchAll(pattern)) {
      const resolved = resolveImageReference(vaultRoot, sourceRelative, match[1] || match[2]);
      if (resolved) found.add(resolved);
    }
  }
  return [...found];
}

function splitLongText(text, targetLength = 2600, overlap = 260) {
  if (text.length <= targetLength) return [text];
  const paragraphs = text.split(/\n{2,}/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > targetLength) {
      chunks.push(current.trim());
      current = `${current.slice(-overlap)}\n\n${paragraph}`;
    } else {
      current += `${current ? '\n\n' : ''}${paragraph}`;
    }
    while (current.length > targetLength * 1.7) {
      chunks.push(current.slice(0, targetLength).trim());
      current = current.slice(targetLength - overlap);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function contentHash(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function classifyDocument(relative, frontmatter) {
  if (/^01-课程笔记\/(?:高等数学|概率论与数理统计)\/(?:00-卷首资料|第\d{2}讲-|附录\d{2}-)/.test(relative)) {
    return 'ocr_page';
  }
  if (frontmatter.type === 'knowledge-point-candidate') return 'knowledge_candidate';
  if (frontmatter.type === 'method-candidate') return 'method_candidate';
  return 'navigation';
}

function courseSourceId(relative) {
  const volume = relative.includes('/高等数学/') ? 'calc' : 'prob';
  const base = path.posix.basename(relative, '.md');
  if (base === '00-卷首资料') return `zy30.${volume}.front`;
  const chapter = base.match(/^第(\d{2})讲-/);
  if (chapter) return `zy30.${volume}.ch${chapter[1]}`;
  const appendix = base.match(/^附录(\d{2})-/);
  if (appendix) return `zy30.${volume}.app${appendix[1]}`;
  return `zy30.${volume}.unknown`;
}

function normalizeCandidateType(docType) {
  return docType === 'knowledge_candidate' ? 'knowledge_candidate' : 'method_candidate';
}

export function scanVault(vaultRoot) {
  const documents = [];
  const chunks = [];
  const markdownFiles = walkMarkdown(vaultRoot);
  for (const absolute of markdownFiles) {
    const relative = normalizeVaultPath(vaultRoot, absolute);
    const markdown = fs.readFileSync(absolute, 'utf8');
    const { data: frontmatter, body } = parseFrontmatter(markdown);
    const title = frontmatter.title || markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relative, '.md');
    const docType = classifyDocument(relative, frontmatter);
    const outboundLinks = extractOutboundLinks(body);
    const document = {
      path: relative,
      title,
      status: frontmatter.status || '未标注',
      volume: frontmatter.volume || frontmatter.domain || null,
      docType,
      evidenceTier: docType === 'ocr_page' ? 'ocr_source' : docType.endsWith('_candidate') ? 'graph_candidate' : 'navigation',
      outboundLinks,
    };
    documents.push(document);
    if (docType === 'navigation') continue;

    if (docType === 'ocr_page') {
      const sourceId = courseSourceId(relative);
      const anchors = [...body.matchAll(PAGE_ANCHOR_RE)];
      for (let index = 0; index < anchors.length; index += 1) {
        const match = anchors[index];
        const end = anchors[index + 1]?.index ?? body.length;
        const segment = body.slice(match.index, end);
        const page = Number(match[2]);
        const anchor = match[1];
        const heading = extractHeading(segment);
        const images = extractImages(vaultRoot, relative, segment);
        let plain = markdownToPlain(segment)
          .replace(new RegExp(`PDF\\s*第\\s*0*${page}\\s*页`, 'ig'), '')
          .trim();
        if (!plain && images.length) plain = `PDF 第 ${page} 页包含 ${images.length} 张教材图片，需查看原图。`;
        const pageParts = splitLongText(plain || `PDF 第 ${page} 页 OCR 文本为空，需核对原页。`);
        pageParts.forEach((text, partIndex) => {
          const paddedPage = String(page).padStart(3, '0');
          const chunkId = `${sourceId}.pdf${paddedPage}.${String(partIndex + 1).padStart(2, '0')}`;
          chunks.push({
            id: chunkId,
            sourceId,
            path: relative,
            title,
            status: document.status,
            volume: document.volume,
            docType,
            evidenceTier: 'ocr_source',
            pdfPage: page,
            anchor,
            heading,
            text,
            images,
            outboundLinks,
            contentHash: contentHash(text),
          });
        });
      }
      continue;
    }

    const candidateType = normalizeCandidateType(docType);
    const stableId = catalogId(candidateType, title);
    const plain = markdownToPlain(body);
    const images = extractImages(vaultRoot, relative, body);
    const parts = splitLongText(plain, 3200, 240);
    parts.forEach((text, partIndex) => {
      const chunkId = `${stableId || `route.${crypto.createHash('sha1').update(relative).digest('hex').slice(0, 12)}`}.${String(partIndex + 1).padStart(2, '0')}`;
      chunks.push({
        id: chunkId,
        sourceId: stableId,
        path: relative,
        title,
        status: document.status,
        volume: document.volume,
        docType,
        evidenceTier: 'graph_candidate',
        pdfPage: null,
        anchor: null,
        heading: extractHeading(body),
        text,
        images,
        outboundLinks,
        contentHash: contentHash(text),
      });
    });
  }
  return { markdownFiles, documents, chunks };
}

export { PAGE_ANCHOR_RE };
