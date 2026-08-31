import { buildTutorPrompt, normalizeHintLevel } from './prompt.mjs';
import { ProviderError } from './provider.mjs';
import { boundedText, safeDisplayText } from '../security.mjs';

function numberedSources(results) {
  return results.map((source, index) => ({
    ...source,
    label: `S${index + 1}`,
    pageLabel: source.page ? `PDF 第 ${source.page} 页` : '知识关联页',
  }));
}

function sourceLine(source) {
  const location = source.page ? `PDF 第 ${source.page} 页` : '知识关联页';
  return `[${source.label}] ${source.title}，${location}`;
}

function relevantTopics(sources) {
  return [...new Set(sources.map((source) => source.title))].slice(0, 4);
}

export function buildOfflineAnswer({ message, hintLevel, sources }) {
  const level = normalizeHintLevel(hintLevel);
  const ocr = sources.filter((source) => source.evidenceTier === 'ocr_source');
  if (!sources.length || !ocr.length) {
    return [
      '这次没有检索到足够的教材证据，我先不猜答案。',
      '请补充题目全文、已知条件和你卡住的步骤，我会重新定位到具体教材页。',
    ].join('\n\n');
  }

  const topics = relevantTopics(sources).join('、');
  const firstOcr = ocr[0];
  const lines = [];
  if (level === 1) {
    lines.push(
      `先不要急着计算。把题目归入“${topics}”，检查已知条件对应哪个定义或定理。`,
      `第一步：回到 ${sourceLine(firstOcr)}，只对照条件和结论的适用范围，然后写出你认为应该使用的对象。`,
      '你可以回复“我的第一步是……”；我会只检查方向，不提前给出最终式子。',
    );
  } else if (level === 2) {
    lines.push(
      `关键路线是：识别“${topics}”中的条件，选择对应公式，再把题目数据代入到中间步骤。`,
      `教材定位：${sourceLine(firstOcr)}。相关 OCR 摘录如下：\n> ${firstOcr.excerpt}`,
      '请你先完成最后一步计算或化简；发回过程后，我再指出具体失分点。',
    );
  } else {
    lines.push(
      `这道题与“${topics}”相关。当前是本地检索辅导模式，下面给出完整的教材定位和核查路径，但不会在缺少题目细节时虚构唯一数值答案。`,
      ...ocr.slice(0, 3).map((source) => `${sourceLine(source)}\n> ${source.excerpt}`),
      `建议解题顺序：①列出条件；②写明使用的定义或定理；③逐步计算；④把结论与题目所求对齐。你的原问题是“${safeDisplayText(message)}”。`,
    );
  }
  lines.push('提示：教材正文来自 OCR 初稿，关键公式、上下标和符号请结合来源图片核对。');
  return lines.join('\n\n');
}

export class TutorService {
  constructor({ index, store, provider }) {
    if (!index || typeof index.search !== 'function') throw new TypeError('index is required');
    if (!store) throw new TypeError('store is required');
    if (!provider) throw new TypeError('provider is required');
    this.index = index;
    this.store = store;
    this.provider = provider;
  }

  async chat({ message, hintLevel = 1, sessionId = null }) {
    const cleanMessage = boundedText(message, 6000, '问题');
    const level = normalizeHintLevel(hintLevel);
    const results = this.index.search(cleanMessage, { limit: 6, maxPerDocument: 2, requireOcr: true });
    const sources = numberedSources(results);
    let session = sessionId ? this.store.getSession(sessionId) : null;
    if (sessionId && !session) throw new Error('会话不存在');
    if (!session) {
      session = this.store.startSession({
        title: safeDisplayText(cleanMessage).slice(0, 60),
        metadata: {
          mode: this.provider.available ? 'model' : 'retrieval',
          provider: this.provider.name || null,
          model: this.provider.available ? this.provider.model || null : null,
          hintLevel: level,
        },
      });
    }
    this.store.appendChatMessage({ sessionId: session.id, role: 'user', content: cleanMessage });
    const history = this.store.listChatMessages(session.id, { limit: 25 }).slice(0, -1);
    const storedProfile = this.store.getProfile();
    const profile = storedProfile ? {
      ...storedProfile.preferences,
      targetScore: storedProfile.targetScore,
      examDate: storedProfile.examDate,
    } : {};

    let answer;
    let mode = 'retrieval';
    let model = null;
    let providerWarning = null;
    if (this.provider.available) {
      const prompt = buildTutorPrompt({
        message: cleanMessage,
        hintLevel: level,
        sources,
        profile,
        history,
      });
      try {
        const generated = await this.provider.generate(prompt);
        answer = safeDisplayText(generated.text);
        mode = 'model';
        model = generated.model;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        providerWarning = error.message;
        answer = buildOfflineAnswer({ message: cleanMessage, hintLevel: level, sources });
      }
    } else {
      answer = buildOfflineAnswer({ message: cleanMessage, hintLevel: level, sources });
    }

    this.store.appendChatMessage({
      sessionId: session.id,
      role: 'assistant',
      content: answer,
      citations: sources,
    });
    return {
      sessionId: session.id,
      answer,
      citations: sources,
      hintLevel: level,
      mode,
      model,
      provider: mode === 'model' ? this.provider.name || 'deepseek' : null,
      providerWarning,
    };
  }
}

export function createTutorService(options) {
  return new TutorService(options);
}
