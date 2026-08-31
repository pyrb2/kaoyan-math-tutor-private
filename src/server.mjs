import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { buildVaultIndex } from './kb/index.mjs';
import { createTutorStore } from './store.mjs';
import { DeepSeekChatProvider } from './agent/deepseek-provider.mjs';
import { createTutorService } from './agent/tutor.mjs';
import { createRequestHandler } from './routes.mjs';

export async function createApplication(overrides = {}) {
  const config = overrides.config || loadConfig(overrides.configOverrides || {});
  const index = overrides.index || buildVaultIndex(config.vaultPath);
  const store = overrides.store || createTutorStore({
    dbPath: path.join(config.dataDir, 'tutor.db'),
    now: overrides.storeNow,
  });
  const provider = overrides.provider || new DeepSeekChatProvider(config.deepseek);
  const tutor = overrides.tutor || createTutorService({ index, store, provider });
  const handler = createRequestHandler({
    config,
    index,
    store,
    tutor,
    provider,
    now: overrides.now,
  });
  const server = http.createServer((request, response) => {
    handler(request, response).catch((error) => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: { code: 'internal_error', message: '服务内部错误' } }));
      } else {
        response.destroy(error);
      }
    });
  });
  let listening = false;
  let closed = false;

  return {
    config,
    index,
    store,
    provider,
    tutor,
    server,
    async listen({ port = config.port, host = config.host } = {}) {
      if (closed) throw new Error('应用已经关闭');
      if (listening) return server.address();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      listening = true;
      return server.address();
    },
    async close() {
      if (closed) return;
      if (listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      store.close();
      closed = true;
      listening = false;
    },
  };
}

export async function startServer(overrides = {}) {
  const app = await createApplication(overrides);
  const address = await app.listen();
  const shownHost = address.address === '127.0.0.1' || address.address === '::1' ? '127.0.0.1' : address.address;
  console.log(`考研数学辅导智能体已启动: http://${shownHost}:${address.port}`);
  console.log(`模式: ${app.provider.available ? `DeepSeek 模型辅导 (${app.provider.model})` : '检索辅导（未配置 DEEPSEEK_API_KEY）'}`);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return app;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  startServer().catch((error) => {
    console.error(`启动失败: ${error.message}`);
    process.exitCode = 1;
  });
}
