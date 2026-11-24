/**
 * **团队模式的 magpie 网关配置** —— 独立于「AI 模型」列表。
 *
 * ## 用户的要求（2026-10-12，这是本文件存在的理由）
 *
 * > 「团队多智能体模式，在创建/修改的时候就**不应该采用 AI 模型列表里面的**，
 * >  而是**直接采用系统的 magpie**，（系统 AI 列表里面添加的那些**不应该给这个模式使用**），
 * >  因为这个模式很多东西会和其他的冲突，例如我刚才修改列表里面 magpie 的模型，
 * >  目的是为了更改赚大钱机器人的模型，但是**我猜测实际影响到了你那个团队模式的测试机器人**」
 *
 * ## 他说的是对的 —— 实测确认
 *
 * ```
 *   #10 赚大钱   用的模型: #13
 *   #11 团队测试 用的模型: #13   ← 完全相同
 * ```
 *
 * 我原来的实现让团队模式**复用 `ai_models` 里那条 magpie 记录当网关出口**
 *（理由是"用户不用学新配置概念"）。**那个理由站不住**：
 *
 *   · 那条记录是**给别的机器人用的**（`赚大钱` 用它当模型）——
 *     改它的 baseUrl/模型去调一台机器人，会**连带改掉所有团队机器人**；
 *   · 团队模式要的是"**一个网关**"，而 `ai_models` 的语义是"**一个模型**"。
 *     两者生命周期与用途都不同，共用一条记录必然互相干扰。
 *
 * 所以团队模式的网关配置**独立存放**，与 `ai_models` 完全解耦：
 * 改 `ai_models` 里的任何东西都**不影响**团队模式，反之亦然。
 *
 * ## 配置从哪来
 *
 * 按优先级：
 *   1. `.env` 的 `MAGPIE_GATEWAY_URL` / `MAGPIE_GATEWAY_KEY`（显式配置，最可靠）
 *   2. 从 magpie 的标准位置**自动发现**（本机部署时通常能读到网关 key）
 *   3. 都没有 → 团队模式不可用，**明确报错**（绝不静默退回单模型）
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 团队模式的网关配置。 */
export interface TeamGatewayConfig {
  baseUrl: string;
  apiKey: string;
  /** 配置来源（给人看 —— 出问题时"它是从哪读的"是第一个要问的）。 */
  source: string;
}

/** magpie 网关的默认地址（本机部署）。 */
export const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425/v1';

/**
 * magpie 网关 key 的**候选位置**（按序尝试）。
 *
 * ⚠️ **顺序很重要**：`data/magpie-caller-keys.json` 是**部署脚本同步的副本**
 * 放在**第一位** —— 因为 magpie 自己的那份权限是 `-rw-------`（属主 UID 65532，
 * 容器内用户），**服务读不到**（实测确认，日志里表现为
 * 「AI 团队模式未启用：找不到 magpie 网关配置」→ 静默退回单模型）。
 *
 * 后面的路径是"原生安装 magpie"时的位置，保留作为兜底。
 *
 * ⚠️ **只读，绝不修改** —— 我们没有理由去动另一个程序的配置，
 * 而且它随时可能重写这些文件。
 */
const MAGPIE_KEY_PATHS = [
  /* ⭐ 部署脚本同步的副本（服务可读）—— 首选。 */
  '/opt/autoquant/data/magpie-caller-keys.json',
  /* Docker 卷（原文件；权限通常是 0600，服务多半读不到）。 */
  '/var/lib/docker/volumes/magpie-config/_data/magpie/caller-keys.json',
  /* 原生安装（magpie 默认配置目录，含 Windows / macOS / Linux 当前用户）。 */
  join(homedir(), '.config', 'magpie', 'caller-keys.json'),
  '/root/.config/magpie/caller-keys.json',
  '/home/magpie/.config/magpie/caller-keys.json',
];

/**
 * 解析团队模式的网关配置。
 *
 * @param env 环境变量（注入以便测试）
 * @param readFile 读文件（注入以便测试）
 * @returns 配置；`null` = 没找到（调用方**必须**明确报告，不能静默降级）
 */
export function resolveTeamGateway(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): TeamGatewayConfig | null {
  /* ① 显式配置优先 —— 用户说了算。 */
  const url = env.MAGPIE_GATEWAY_URL?.trim();
  const key = env.MAGPIE_GATEWAY_KEY?.trim();
  if (url && key) {
    return { baseUrl: url, apiKey: key, source: '.env（显式配置）' };
  }

  /*
   * ①b **只配了 key 的文件路径**（`MAGPIE_GATEWAY_KEY_FILE`）。
   *
   * 这条路径存在的理由：服务器上 key 是**部署脚本同步的副本**，
   * 而"把 key 本身写进 .env"意味着它同时出现在两个地方（副本 + .env），
   * 轮换时要改两处。指个文件路径就只有一处真相。
   */
  const keyFile = env.MAGPIE_GATEWAY_KEY_FILE?.trim();
  if (keyFile !== undefined && keyFile.length > 0) {
    try {
      const secret = firstSecret(JSON.parse(readFile(keyFile)));
      if (secret !== null) {
        return { baseUrl: url ?? DEFAULT_MAGPIE_URL, apiKey: secret, source: `${keyFile}（显式指定）` };
      }
    } catch {
      /* 读不到就走下面的自动发现。 */
    }
  }

  /* ② 自动发现：地址用默认值，key 从 magpie 的配置里读。 */
  for (const path of MAGPIE_KEY_PATHS) {
    try {
      const raw = readFile(path);
      const parsed: unknown = JSON.parse(raw);
      const secret = firstSecret(parsed);
      if (secret !== null) {
        return { baseUrl: url ?? DEFAULT_MAGPIE_URL, apiKey: secret, source: path };
      }
    } catch {
      /* 读不到就试下一个 —— 这些路径本来就是"碰运气"。 */
    }
  }

  /*
   * ③ 都没有 → 返回 null。
   *
   * ⚠️ **绝不在这里编一个 key 或退回 `ai_models`** ——
   * 那正是"静默走错路"的形状（复核发现的 P0-B）。
   * 让调用方去报告"团队模式未启用，原因是……"。
   */
  return null;
}

/**
 * 从 `caller-keys.json` 里取出第一个网关 key。
 *
 * 实测的格式是一个数组，每项形如 `{ "secret": "sk-magpie-…", … }`。
 * 兼容对象形态（`{ keys: [...] }`）以防 magpie 改结构 —— 但**不猜**：
 * 找不到就返回 `null`，让上层说"读到了但格式不认识"，而不是拿一个空字符串去请求。
 */
function firstSecret(parsed: unknown): string | null {
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { keys?: unknown }).keys)
      ? ((parsed as { keys: unknown[] }).keys)
      : null;
  if (list === null) return null;
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const secret = (item as { secret?: unknown }).secret;
    if (typeof secret === 'string' && secret.trim().length > 0) return secret.trim();
  }
  return null;
}
