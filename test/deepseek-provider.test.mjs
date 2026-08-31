import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekChatProvider, toMessages } from '../src/agent/deepseek-provider.mjs';
import { ProviderError } from '../src/agent/provider.mjs';

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return payload; } };
}

test('DeepSeek provider sends Chat Completions request and returns text without reasoning content', async () => {
  let request;
  const provider = new DeepSeekChatProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/',
    transport: async (url, init) => {
      request = { url, init };
      return jsonResponse({
        id: 'chatcmpl-1',
        model: 'deepseek-v4-pro',
        choices: [{ message: { content: '先判断条件。[S1]', reasoning_content: '不应暴露' } }],
        usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
      });
    },
  });

  const result = await provider.generate({
    instructions: '你是考研数学辅导老师。',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '给我一级提示' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning_content', text: '内部推理' },
          { type: 'output_text', text: '先看定义。' },
        ],
        reasoning_content: '也不应进入请求',
      },
    ],
    maxOutputTokens: 321,
  });

  assert.equal(provider.name, 'deepseek');
  assert.equal(provider.available, true);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.authorization, 'Bearer test-key');
  assert.equal(request.init.headers['content-type'], 'application/json');
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body, {
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: '你是考研数学辅导老师。' },
      { role: 'user', content: '给我一级提示' },
      { role: 'assistant', content: '先看定义。' },
    ],
    max_tokens: 321,
    stream: false,
  });
  assert.equal(JSON.stringify(body).includes('内部推理'), false);
  assert.deepEqual(result, {
    text: '先判断条件。[S1]',
    responseId: 'chatcmpl-1',
    model: 'deepseek-v4-pro',
    usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
  });
  assert.equal(JSON.stringify(result).includes('不应暴露'), false);
});

test('message conversion accepts strings and ignores unsupported or reasoning content', () => {
  assert.deepEqual(toMessages('', '直接提问'), [{ role: 'user', content: '直接提问' }]);
  assert.deepEqual(toMessages('', { role: 'assistant', content: '单条历史回答' }), [
    { role: 'assistant', content: '单条历史回答' },
  ]);
  assert.deepEqual(toMessages('系统', [
    '第一问',
    { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
    { role: 'user', content: [{ type: 'image_url', image_url: 'x' }] },
    { role: 'invalid', content: '按用户消息处理' },
  ]), [
    { role: 'system', content: '系统' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '按用户消息处理' },
  ]);
});

test('missing API key fails before transport is called', async () => {
  let called = false;
  const provider = new DeepSeekChatProvider({ transport: async () => { called = true; } });
  assert.equal(provider.available, false);
  await assert.rejects(
    provider.generate({ input: '问题' }),
    (error) => error instanceof ProviderError && error.code === 'model_unavailable',
  );
  assert.equal(called, false);
});

test('invalid and empty successful responses use compatible provider errors', async () => {
  const invalid = new DeepSeekChatProvider({
    apiKey: 'x',
    transport: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError(); } }),
  });
  await assert.rejects(
    invalid.generate({ input: '问题' }),
    (error) => error instanceof ProviderError && error.code === 'model_invalid_response' && error.status === 200,
  );

  const empty = new DeepSeekChatProvider({
    apiKey: 'x',
    transport: async () => jsonResponse({ choices: [{ message: { reasoning_content: '只有推理' } }] }),
  });
  await assert.rejects(
    empty.generate({ input: '问题' }),
    (error) => error instanceof ProviderError && error.code === 'model_empty_response',
  );
});

test('HTTP errors preserve status and provider error code', async () => {
  const provider = new DeepSeekChatProvider({
    apiKey: 'x',
    transport: async () => jsonResponse(
      { error: { message: '余额不足', code: 'insufficient_balance' } },
      { ok: false, status: 402 },
    ),
  });
  await assert.rejects(
    provider.generate({ input: '问题' }),
    (error) => error instanceof ProviderError
      && error.status === 402
      && error.code === 'insufficient_balance'
      && /余额不足/.test(error.message),
  );
});

test('transport and timeout failures become model_transport_error', async () => {
  const transportFailure = new DeepSeekChatProvider({
    apiKey: 'x',
    transport: async () => { throw new TypeError('network down'); },
  });
  await assert.rejects(
    transportFailure.generate({ input: '问题' }),
    (error) => error instanceof ProviderError
      && error.code === 'model_transport_error'
      && /无法连接/.test(error.message),
  );

  const timeout = new DeepSeekChatProvider({
    apiKey: 'x',
    timeoutMs: 5,
    transport: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(
    timeout.generate({ input: '问题' }),
    (error) => error instanceof ProviderError
      && error.code === 'model_transport_error'
      && /超时/.test(error.message),
  );
});
