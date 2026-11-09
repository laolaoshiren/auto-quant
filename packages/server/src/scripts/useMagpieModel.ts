/**
 * 把数据库里的默认 AI 模型切到**本机 magpie 网关**的 `workbuddy/deepseek-v4.1-flash`。
 *
 * 用户 2026-11-10 指示：项目里的 LLM 调用一律走本机 magpie，不要用 DeepSeek 官方端点。
 *
 * 用法（对哪个库生效由 `DATA_DIR` 决定）：
 *   $env:DATA_DIR="<仓库根>\.dsh\demo-data"; npx tsx packages/server/src/scripts/useMagpieModel.ts
 *
 * 幂等：已存在同 base_url + model 的模型时复用，并把默认模型指过去。
 */
import { dbPath, resolveMasterKey } from '../env.js';
import { Vault } from '../crypto/vault.js';
import { initDb, closeDb, getDb } from '../db/index.js';
import { aiModels, settings } from '../store/repositories.js';

const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';
const MAGPIE_MODEL = 'workbuddy/deepseek-v4.1-flash';

const masterKey = await resolveMasterKey();
const vault = new Vault(masterKey);
initDb(dbPath);

/*
 * ⚠️ **key 必须非空**（2026-11-10 走查发现）。
 *
 * `startTrader` 的预检会拒绝"没有存储 API Key"的模型（`AI 模型「…」还没有
 * 存储 API Key`）。magpie 是本地网关、不校验 key，但**空字符串仍会被那条
 * 校验拦住** —— 于是演示/开发环境里绑到 magpie 的机器人全都启动失败。
 * 存一个非空占位串即可（它不会被发到任何外部服务）。
 */
const MAGPIE_PLACEHOLDER_KEY = 'magpie-local';

try {
  const all = aiModels.list();
  const existing = all.find((m) => m.baseUrl === MAGPIE_BASE_URL && m.model === MAGPIE_MODEL);

  const row =
    existing ??
    aiModels.create({
      provider: 'custom',
      label: 'magpie workbuddy（deepseek-v4.1-flash）',
      model: MAGPIE_MODEL,
      baseUrl: MAGPIE_BASE_URL,
      apiKeyEnc: vault.encrypt(MAGPIE_PLACEHOLDER_KEY),
      temperature: 0.2,
      maxTokens: 8192,
      timeoutSeconds: 120,
      maxRetries: 2,
    });

  /* 已存在的模型如果 key 是空的（旧脚本写的），补一个非空占位。 */
  if (existing) {
    getDb().run(
      'UPDATE ai_models SET api_key_enc = ? WHERE id = ?',
      vault.encrypt(MAGPIE_PLACEHOLDER_KEY),
      row.id,
    );
  }

  /* 默认模型：优先那条已存在的；避免 UI"新建机器人默认模型"选错。 */
  settings.set('default_ai_model_id', String(row.id));

  console.log(
    JSON.stringify(
      {
        db: process.env.DATA_DIR ?? './data',
        modelId: row.id,
        label: row.label,
        model: row.model,
        baseUrl: row.baseUrl,
        defaultAiModelId: settings.get('default_ai_model_id'),
      },
      null,
      2,
    ),
  );
} finally {
  closeDb();
}
