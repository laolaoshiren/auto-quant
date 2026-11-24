import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AI_MANAGED_PRESET_MODEL,
  unboundedAiManagedConfig,
  usesModelPicker,
} from '@aq/shared';
import { initDb, closeDb } from '../db/index.js';
import { Vault } from '../crypto/vault.js';
import { aiModels, traders } from '../store/repositories.js';
import { TraderManager } from './manager.js';
import { AutoTrader } from './autoTrader.js';
import { SymbolRegistry } from '../binance/symbols.js';
import type { ExchangeConnection } from '../binance/bootstrap.js';

test('★ 共享契约：智能托管预设模型为 workbuddy/deepseek-v4.1-flash，且仅固定策略使用模型选择器', () => {
  assert.equal(AI_MANAGED_PRESET_MODEL, 'workbuddy/deepseek-v4.1-flash');
  assert.equal(usesModelPicker('strategy'), true);
  assert.equal(usesModelPicker('ai_managed'), false);
  assert.equal(usesModelPicker('ai_team'), false);
  assert.equal(usesModelPicker('jev'), false);
});

function fakePaperConnection(): ExchangeConnection {
  const registry = new SymbolRegistry([
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      pricePrecision: 2,
      quantityPrecision: 3,
      tickSize: 0.1,
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 1000,
      minNotional: 5,
      contractSize: 1,
    },
  ]);
  return {
    environment: 'demo',
    endpoints: {
      rest: 'https://demo-fapi.binance.com',
      ws: 'wss://stream.binancefuture.com',
      label: '模拟测试',
    },
    clockOffsetMs: 0,
    registry,
    rest: {
      hasCredentials: false,
      signedRequest: async () => ({}),
      publicRequest: async () => ({}),
    } as unknown as ExchangeConnection['rest'],
    market: {
      getMarkPrice: async () => 100_000,
    } as unknown as ExchangeConnection['market'],
    broker: {
      isDryRun: true,
      getAccountState: async () => ({
        equity: 1000,
        walletBalance: 1000,
        availableBalance: 1000,
        unrealizedPnl: 0,
        marginUsed: 0,
        openOrderMargin: 0,
      }),
      getPositions: async () => [],
      getOpenOrders: async () => [],
      getOpenAlgoOrders: async () => [],
      getMarkPrice: async () => 100_000,
      ensureOneWayMode: async () => ({ changed: false, warning: null }),
    } as unknown as ExchangeConnection['broker'],
  } as unknown as ExchangeConnection;
}

async function startMockMagpie(): Promise<{
  server: Server;
  baseUrl: string;
  seenModels: string[];
}> {
  const seenModels: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: AI_MANAGED_PRESET_MODEL, context_length: 1_000_000 }],
        }),
      );
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { model?: string };
          if (parsed.model) seenModels.push(parsed.model);
        } catch {
          /* ignore */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${addr.port}/v1`, seenModels };
}

test('★★★ 智能托管启动统一走 magpie 网关的 workbuddy/deepseek-v4.1-flash，彻底忽略 ai_models 占位记录', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'aq-ai-managed-preset-'));
  initDb(path.join(workDir, 'test.sqlite'));
  const mock = await startMockMagpie();

  const savedUrl = process.env.MAGPIE_GATEWAY_URL;
  const savedKey = process.env.MAGPIE_GATEWAY_KEY;
  process.env.MAGPIE_GATEWAY_URL = mock.baseUrl;
  process.env.MAGPIE_GATEWAY_KEY = 'sk-magpie-test-key';

  const originalStart = AutoTrader.prototype.start;
  const originalStop = AutoTrader.prototype.stop;
  let buildModelCalled = 0;

  try {
    /* 故意在 ai_models 里挂一条完全无关且无 API key 的 DeepSeek 记录当占位 */
    const unrelated = aiModels.create({
      provider: 'deepseek',
      label: '无关占位模型',
      model: 'deepseek-reasoner',
      baseUrl: 'https://should-never-be-called.invalid/v1',
      apiKeyEnc: '',
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSeconds: 60,
      maxRetries: 0,
    });
    const trader = traders.create({
      name: '智能托管预设模型测试',
      exchangeAccountId: null,
      aiModelId: unrelated.id,
      strategyId: null,
      cycleIntervalMinutes: 15,
      initialEquity: 1000,
      paperStartingBalance: 1000,
      mode: 'ai_managed',
      dryRun: true,
    });
    traders.setAgentConfig(trader.id, JSON.stringify(unboundedAiManagedConfig()));

    const manager = new TraderManager(new Vault(Buffer.alloc(32, 9)));
    const internals = manager as unknown as {
      connectionFor: () => Promise<ExchangeConnection>;
      buildModel: () => Promise<unknown>;
      attemptStart: (
        traderId: number,
        row: unknown,
        dryRun: boolean,
      ) => Promise<{
        result: {
          ok: boolean;
          error?: string;
          preflight: Array<{ name: string; ok: boolean; detail: string; severity: string }>;
        };
      }>;
    };
    internals.connectionFor = async () => fakePaperConnection();
    internals.buildModel = async () => {
      buildModelCalled += 1;
      throw new Error('智能托管模式绝不应该调用 buildModel(trader.aiModelId)');
    };

    (AutoTrader.prototype as unknown as { start: () => Promise<void> }).start = async () => undefined;
    (AutoTrader.prototype as unknown as { stop: () => Promise<void> }).stop = async () => undefined;

    const { result } = await internals.attemptStart(trader.id, traders.get(trader.id), true);
    assert.equal(result.ok, true, `启动应当成功，实际：${result.error}`);
    assert.equal(buildModelCalled, 0, '智能托管不得调用 buildModel 读取 ai_models');
    assert.ok(
      mock.seenModels.includes(AI_MANAGED_PRESET_MODEL),
      `实际请求模型应包含 ${AI_MANAGED_PRESET_MODEL}，收到：${JSON.stringify(mock.seenModels)}`,
    );
    const llmCheck = result.preflight.find((c) => c.name === '语言模型');
    assert.ok(llmCheck?.ok && llmCheck.detail.includes(AI_MANAGED_PRESET_MODEL));
  } finally {
    AutoTrader.prototype.start = originalStart;
    AutoTrader.prototype.stop = originalStop;
    if (savedUrl === undefined) delete process.env.MAGPIE_GATEWAY_URL;
    else process.env.MAGPIE_GATEWAY_URL = savedUrl;
    if (savedKey === undefined) delete process.env.MAGPIE_GATEWAY_KEY;
    else process.env.MAGPIE_GATEWAY_KEY = savedKey;
    mock.server.close();
    closeDb();
    rmSync(workDir, { recursive: true, force: true });
  }
});
