import { readFileSync } from 'node:fs';
import { REPO_ROOT } from '../env.js';

/**
 * **magpie 网关的契约自检**（P0 免费层）。
 *
 * ## 为什么需要它（用户的要求）
 *
 * > 「既然项目团队模式高度依赖 magpie，那么是否有些功能/设置会因为 magpie 的改动更新
 * >   而需要做相应的调整，如果有你得跟进，还要研究看看有没有一劳永逸的方案
 * >   （不让这个成为项目包袱）」
 *
 * magpie 是**自动更新、一天多版**的项目。而我们对它的依赖比"一个 baseURL"深得多：
 * 4 个非标准端点面 + 3 类自由文本契约 + 2 个内部配置文件。
 *
 * ## 真正危险的不是"magpie 挂了"
 *
 * 挂了会报错、看得见、有人会去修。真正危险的是**静默降质**：
 *
 * | 漂移 | 症状 |
 * |---|---|
 * | 链上的模型 id 悄悄失效 | 每轮先撞 404，**决策变慢**，没有任何测试变红 |
 * | 错误文案改了 | 降级判据失效 ⇒ 每轮重复撞同一个死模型 |
 * | `/v1/models` 字段改名 | 预算算不出来 ⇒ 输出被截断 ⇒ **空内容** |
 *
 * 这三类**都不会让测试变红、不会出现 error 日志**，只会让一轮变慢、一个角色缺席。
 * ⇒ 这个模块就是为了让它们**在升级当天就在日志里出现一条**。
 *
 * ## 为什么叫"契约自检"而不是"监控"
 *
 * 它检查的不是"网关活着吗"（那是 `/api/health` 的事），而是
 * **"我们依赖的那些形状还成立吗"** —— 形状变了才叫契约漂移。
 *
 * ## 成本纪律
 *
 * **全部探针零 token**（只打 GET `/v1/models` 与 `/v1/magpie/quotas`）。
 * 默认关闭：多打几个请求本身就是行为变化。
 */

/** 一条契约不符。 */
export interface ContractMismatch {
  /** 哪条探针发现的。 */
  probe: string;
  /** `error` = 我们依赖的东西坏了；`warn` = 变了但可能不影响；`info` = 只是记录。 */
  severity: 'error' | 'warn' | 'info';
  /** 人话说明"哪里不符"。 */
  detail: string;
  /** 该怎么办（给操作员看的行动建议）。 */
  hint: string;
}

export interface ContractReport {
  /** 全部探针都通过。 */
  ok: boolean;
  at: number;
  /** 发出去的请求数（成本可见）。 */
  requests: number;
  mismatches: ContractMismatch[];
  /** 稳定摘要，用于去重（同一份问题不重复刷日志）。 */
  fingerprint: string;
  /** 网关报出的模型总数（`null` = 没拿到）。 */
  modelCount: number | null;
  /**
   * **网关版本**（来自 magpie 的 `last-version` 文件）。
   *
   * ## 为什么要它
   *
   * 用户提醒过：magpie 自动更新、一天多版。而"版本变了"是**唯一**能提前预警的信号 ——
   * 新版发布当天就可能改掉某个端点或字段。
   *
   * ⇒ 每次自检都带上版本号写进日志。这样"某天开始出问题"时，
   *   翻日志就能看到"问题是从 0.1.1285 → 0.1.1286 那次开始的"，而不必猜。
   *
   * `null` = 读不到（容器内路径可能不同，或没挂载）。**读不到不算错。**
   */
  gatewayVersion: string | null;
}

export interface ProbeInput {
  /** 网关基址，形如 `http://172.19.0.1:3425/v1`。 */
  baseUrl: string;
  /** Bearer token；空串则**一个请求都不发**（直接返回"未配置"）。 */
  apiKey: string;
  /** 候选链上出现的全部模型 id（用来检查它们是否还存在）。 */
  ladderIds: readonly string[];
  /** 单探针超时（默认 8000ms）。 */
  timeoutMs?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  /** 测试注入：版本读取函数（默认读 `last-version` 文件）。 */
  versionReader?: () => string | null;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * **读 magpie 的版本号**（`last-version` 文件，9 字节的纯文本）。
 *
 * 候选路径按顺序试（容器挂载点与原生安装各一个）：
 * ```
 * ## 候选路径的顺序（重要）
 *
 * ```
 *   ① <应用根>/data/magpie-last-version                             ← 部署脚本同步的副本
 *   ② /var/lib/docker/volumes/magpie-config/_data/magpie/last-version  ← Docker 卷（root 可读）
 *   ③ ~/.config/magpie/last-version                                    ← 原生安装
 * ```
 *
 * ⚠️ **① 必须是第一位**：线上服务以 `autoquant` 用户运行，而 ②③ 都是 root 可读、
 * 它读不到 —— 实测契约自检里那一格一直是「未知」就是因为它只试了 ②③。
 * 部署脚本（`scripts/deploy.ps1`）会把 ② 复制成 ① 并 chown 给 autoquant。
 *
 * ⚠️ **读不到返回 `null`，绝不编一个版本号** —— 与"未知不等于默认值"同一纪律。
 * 这个函数**永不抛**。
 */
export function readGatewayVersion(
  readFile: (path: string) => string = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  },
  candidates: readonly string[] = [
    /* ① 部署脚本同步的副本（服务用户可读）—— 线上唯一能成功的那条。 */
    `${REPO_ROOT}/data/magpie-last-version`,
    /* ② Docker 卷（root 可读，服务读不到；本机开发时能读到）。 */
    '/var/lib/docker/volumes/magpie-config/_data/magpie/last-version',
    /* ③ 原生安装。 */
    `${process.env['HOME'] ?? '/root'}/.config/magpie/last-version`,
  ],
): string | null {
  for (const path of candidates) {
    try {
      const raw = readFile(path).trim();
      if (raw.length > 0 && raw.length <= 32) return raw;
    } catch {
      /* 这个路径读不到，试下一个。 */
    }
  }
  return null;
}

/** 把 baseUrl 规范化成"不带尾斜杠"，并给出到 `/v1` 为止的根。 */
function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
}

/** 从 `/v1/models` 的响应里取出 id 列表；形状不对返回 `null`。 */
function extractModelIds(json: unknown): string[] | null {
  if (json === null || typeof json !== 'object') return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const item of data) {
    if (item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      ids.push((item as { id: string }).id);
    }
  }
  return ids;
}

/** 元数据完整度：有多少模型带了上下文长度字段。 */
function countWithContextLength(json: unknown): number {
  if (json === null || typeof json !== 'object') return 0;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return 0;
  let n = 0;
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const has =
      (typeof m['context_length'] === 'number' && m['context_length'] > 0) ||
      (typeof m['context_window'] === 'number' && m['context_window'] > 0) ||
      (typeof m['max_input_tokens'] === 'number' && m['max_input_tokens'] > 0);
    if (has) n += 1;
  }
  return n;
}

/**
 * 跑一轮契约自检。
 *
 * **永不抛**：任何失败都变成一条 `mismatch`。这是它能挂在启动流程上的前提。
 */
export async function probeGatewayContract(input: ProbeInput): Promise<ContractReport> {
  const at = Date.now();
  const mismatches: ContractMismatch[] = [];
  let requests = 0;
  let modelCount: number | null = null;

  const base = normalizeBase(input.baseUrl);
  const apiKey = input.apiKey.trim();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /*
   * 没有 key ⇒ 一个请求都不发。
   * 这不是"探针失败"，而是"没配置"—— 用一个 info 说明，不算 error
   *（单模型部署、或还没接 magpie 的环境本来就没有 key）。
   */
  if (base === '' || apiKey === '') {
    return {
      ok: true,
      at,
      requests: 0,
      mismatches: [
        {
          probe: 'config',
          severity: 'info',
          detail: '网关地址或 key 未配置，契约自检跳过。',
          hint: '如果这台机器应该用 magpie，检查 MAGPIE_GATEWAY_KEY_FILE。',
        },
      ],
      fingerprint: 'config',
      modelCount: null,
      gatewayVersion: (input.versionReader ?? readGatewayVersion)(),
    };
  }

  const doFetch = input.fetchImpl ?? fetch;

  /* ── 探针 1+2：`/v1/models` 的形状与元数据完整度 ──────────────────── */
  let modelsJson: unknown = null;
  try {
    requests += 1;
    const res = await doFetch(`${base}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      mismatches.push({
        probe: 'models.shape',
        severity: 'error',
        detail: `GET /v1/models 返回 HTTP ${res.status}。`,
        hint: '网关可能换了鉴权方式或端点路径。团队模式会因此退回单模型。',
      });
    } else {
      modelsJson = await res.json().catch(() => null);
      const ids = extractModelIds(modelsJson);
      if (ids === null || ids.length === 0) {
        mismatches.push({
          probe: 'models.shape',
          severity: 'error',
          detail: 'GET /v1/models 的响应里没有 `data: [{id}]` 形状。',
          hint: '响应结构变了 —— 自动发现会失效（表现为提示词预算退回保守值、输出被截断）。',
        });
      } else {
        modelCount = ids.length;

        /* 探针 2：元数据完整度（决定提示词预算算不算得出来）。 */
        const withCtx = countWithContextLength(modelsJson);
        const ratio = withCtx / ids.length;
        if (ratio < 0.2) {
          mismatches.push({
            probe: 'models.metadata',
            severity: 'error',
            detail: `只有 ${withCtx}/${ids.length}（${Math.round(ratio * 100)}%）个模型带上下文长度字段。`,
            hint: '预算算不出来 ⇒ 模型输出会被截断成空内容。检查 magpie 是否改了字段名。',
          });
        } else if (ratio < 0.5) {
          mismatches.push({
            probe: 'models.metadata',
            severity: 'warn',
            detail: `只有 ${withCtx}/${ids.length}（${Math.round(ratio * 100)}%）个模型带上下文长度字段。`,
            hint: '部分模型的预算会退回保守值（1M 的模型只能用 6 万）。',
          });
        }

        /* 探针 3：候选链上的 id 是否还存在。 */
        if (input.ladderIds.length > 0) {
          const known = new Set(ids);
          const missing = input.ladderIds.filter((id) => !known.has(id));
          if (missing.length > 0) {
            mismatches.push({
              probe: 'models.ladderIds',
              severity: 'warn',
              detail: `候选链上有 ${missing.length} 个模型在网关里不存在：${missing.slice(0, 10).join('、')}` +
                (missing.length > 10 ? ` …等 ${missing.length} 个` : ''),
              hint: '从 routedModel.ts 的候选链里删掉它们（启动时也会自动过滤，但改掉能省一次 404）。',
            });
          }
        }
      }
    }
  } catch (error) {
    mismatches.push({
      probe: 'models.shape',
      severity: 'error',
      detail: `GET /v1/models 失败：${error instanceof Error ? error.message : String(error)}`,
      hint: '网关不可达或超时。团队模式会退回单模型。',
    });
  }

  /* ── 探针 4：`/v1/magpie/quotas`（只 warn —— 它只影响提示词里的一句话） ── */
  try {
    requests += 1;
    const res = await doFetch(`${base}/v1/magpie/quotas`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      mismatches.push({
        probe: 'quotas.shape',
        severity: 'warn',
        detail: `GET /v1/magpie/quotas 返回 HTTP ${res.status}。`,
        hint: '这个端点没了只影响提示词里的额度提示，不影响交易。',
      });
    }
  } catch {
    mismatches.push({
      probe: 'quotas.shape',
      severity: 'warn',
      detail: 'GET /v1/magpie/quotas 失败（超时或不可达）。',
      hint: '同上 —— 只影响提示词里的额度提示。',
    });
  }

  /* 指纹：只由"哪些探针报了什么问题"决定，与具体数字无关（数字每次都变）。 */
  const fingerprint = mismatches
    .map((m) => `${m.probe}:${m.severity}`)
    .sort()
    .join('|');

  return {
    ok: mismatches.every((m) => m.severity !== 'error'),
    at,
    requests,
    mismatches,
    fingerprint,
    modelCount,
    gatewayVersion: (input.versionReader ?? readGatewayVersion)(),
  };
}

/** 把报告转成"该写进日志的几行"。`ok` 且无 warn 时返回空数组（不刷屏）。 */
export function contractMessages(report: ContractReport): Array<{ level: 'info' | 'warn' | 'error'; text: string }> {
  const out: Array<{ level: 'info' | 'warn' | 'error'; text: string }> = [];
  for (const m of report.mismatches) {
    /* `info` 级别（例如"未配置"）不当问题写 —— 那会让每次启动都有一条噪音。 */
    if (m.severity === 'info') continue;
    out.push({
      level: m.severity,
      text: `[网关契约] ${m.probe}：${m.detail} —— ${m.hint}`,
    });
  }
  return out;
}
