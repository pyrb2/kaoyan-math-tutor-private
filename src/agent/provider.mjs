export class ProviderError extends Error {
  constructor(message, { status = 0, code = 'provider_error' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const parts = [];
  for (const item of payload?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('\n').trim();
}

export class OpenAIResponsesProvider {
  constructor({ apiKey = '', model, baseUrl, timeoutMs = 60_000, transport = fetch }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
  }

  get available() {
    return Boolean(this.apiKey);
  }

  async generate({ instructions, input, maxOutputTokens = 1800 }) {
    if (!this.available) {
      throw new ProviderError('未配置模型密钥', { code: 'model_unavailable' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.transport(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          instructions,
          input,
          max_output_tokens: maxOutputTokens,
          store: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error?.name === 'AbortError' ? '模型请求超时' : '无法连接模型服务';
      throw new ProviderError(message, { code: 'model_transport_error' });
    } finally {
      clearTimeout(timeout);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError('模型服务返回了无法解析的响应', {
        status: response.status,
        code: 'model_invalid_response',
      });
    }
    if (!response.ok) {
      const detail = payload?.error?.message || `HTTP ${response.status}`;
      throw new ProviderError(`模型请求失败: ${detail}`, {
        status: response.status,
        code: payload?.error?.code || 'model_request_failed',
      });
    }
    const text = extractOutputText(payload);
    if (!text) {
      throw new ProviderError('模型没有返回可展示的文本', { code: 'model_empty_response' });
    }
    return {
      text,
      responseId: payload.id || null,
      model: payload.model || this.model,
    };
  }
}

export { extractOutputText };
