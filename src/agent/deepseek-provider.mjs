import { ProviderError } from './provider.mjs';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function contentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .filter((part) => part && part.type !== 'reasoning_content' && !('reasoning_content' in part))
    .map((part) => {
      if (typeof part === 'string') return part;
      if (['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function toMessages(instructions, input) {
  const messages = [];
  const systemText = contentToText(instructions);
  if (systemText) messages.push({ role: 'system', content: systemText });

  const items = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && ('role' in input || 'content' in input)
      ? [input]
      : [{ role: 'user', content: input }];
  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') {
      const content = item.trim();
      if (content) messages.push({ role: 'user', content });
      continue;
    }

    const role = ['system', 'user', 'assistant'].includes(item.role) ? item.role : 'user';
    const content = contentToText(item.content);
    if (content) messages.push({ role, content });
  }
  return messages;
}

export class DeepSeekChatProvider {
  constructor({
    apiKey = '',
    model = DEFAULT_MODEL,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 60_000,
    transport = fetch,
  } = {}) {
    this.name = 'deepseek';
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    this.transport = transport;
  }

  get available() {
    return Boolean(this.apiKey);
  }

  async generate({ instructions, input, maxOutputTokens = 1800 }) {
    if (!this.available) {
      throw new ProviderError('未配置 DeepSeek API 密钥', { code: 'model_unavailable' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.transport(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: toMessages(instructions, input),
          max_tokens: maxOutputTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'DeepSeek 请求超时' : '无法连接 DeepSeek 服务';
      throw new ProviderError(message, { code: 'model_transport_error' });
    } finally {
      clearTimeout(timeout);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError('DeepSeek 返回了无法解析的响应', {
        status: response.status,
        code: 'model_invalid_response',
      });
    }

    if (!response.ok) {
      const detail = payload?.error?.message || `HTTP ${response.status}`;
      throw new ProviderError(`DeepSeek 请求失败: ${detail}`, {
        status: response.status,
        code: payload?.error?.code || 'model_request_failed',
      });
    }

    const text = typeof payload?.choices?.[0]?.message?.content === 'string'
      ? payload.choices[0].message.content.trim()
      : '';
    if (!text) {
      throw new ProviderError('DeepSeek 没有返回可展示的文本', { code: 'model_empty_response' });
    }

    return {
      text,
      responseId: payload.id || null,
      model: payload.model || this.model,
      usage: payload.usage || null,
    };
  }
}

export { contentToText, toMessages };
