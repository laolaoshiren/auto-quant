/**
 * **所有出站 `fetch` 都必须走 `fetchGuarded`**（`urlGuard.ts:35-36` 写明的约束）。
 *
 * ## 这条守卫接的是什么
 *
 * `llm/urlGuard.ts` 的文件头（第 31-37 行"仍然不覆盖的情形"）**明确写着**：
 *
 * > · **同一进程内其它不经 `fetchGuarded` 的出站**（若有）：本模块管不到。
 * >   新增出站路径时**必须**走 `fetchGuarded`，否则连接层校验不会被应用；
 *
 * ⚠️ 而**没有任何测试守着这句话**。我用它去扫全仓，发现**四处裸 `fetch(`**：
 *
 * | 位置 | 地址来源 | 是否用户可控 |
 * | --- | --- | --- |
 * | `llm/client.ts` / `llm/discovery.ts` | 用户可配 `baseUrl` | ✅ **已走 `fetchGuarded`** |
 * | `trader/magpieGateway.ts` | `gateway.baseUrl`（**用户可配**）| ⚠️ **裸 fetch** |
 * | `trader/agent/webSearch.ts` | `process.env.MAGPIE_SEARCH_URL`（运维可配）| ⚠️ **裸 fetch** |
 * | `binance/rest.ts` | 常量 endpoints | 低（但仍是出站）|
 * | `buildInfo.ts` | GitHub API（常量）| 低 |
 *
 * ## ⚠️ 为什么 `magpieGateway` 那处是真缺口（不是"另一个可接受的例外"）
 *
 * ① 它用的是**同一个** `baseUrl` —— `llm/client.ts` 走 `fetchGuarded`，
 *    而这里走裸 `fetch`。**同一个地址两条路径，一条有防线、一条没有。**
 * ② `api/server.ts` 的 `BaseUrlSchema` 确实校验了 `baseUrl`，但那是
 *    **字面层**（`checkOutboundUrl`）—— 而 `#126` 的结论正是
 *    "**字面层挡不住 DNS rebinding**，必须在连接层校验"。
 * ③ 它带 **`authorization: Bearer ${gateway.apiKey}`** —— 被重定向到内网时
 *    **密钥会一起发过去**。
 *
 * ## 判据
 *
 * 扫 `packages/server/src` 下**非测试**源码里的 `fetch(` / `undiciFetch(` 调用，
 * 断言每一个都在**白名单**里（`fetchGuarded` 自己、或显式登记的例外）。
 *
 * ⚠️ 白名单**必须显式列出并写明理由** —— 否则它会变成垃圾桶，而垃圾桶没人再看。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** 从本文件定位 `packages/server/src`（按标记找，不猜相对层数）。 */
function findServerSrc(): string {
  const start = fileURLToPath(new URL('.', import.meta.url));
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const probe = join(dir, 'src', 'llm', 'urlGuard.ts');
    try {
      if (statSync(probe).isFile()) return join(dir, 'src');
    } catch {
      /* 继续往上找。 */
    }
    dir = join(dir, '..');
  }
  throw new Error(`找不到 packages/server/src（从 ${start} 向上找了 8 层）`);
}

const SERVER_SRC = findServerSrc();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (/\.ts$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** 剥掉行注释与块注释的行（本仓库注释会逐字引用被讨论的代码）。 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

/**
 * 剥注释但**保留原行号**（把被剥掉的行换成空行）。
 *
 * ⚠️ 与 `stripComments` 的区别很要紧：直接 `filter` 掉注释行会让**行号整体前移**，
 * 于是报错里说的行号与文件里真实的位置对不上 —— 我第一次跑就报了
 * `webSearch.ts:27`，而实际那一行在 **82**。**报错指错位置比不报还费时间。**
 */
function stripCommentsKeepLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') ? line : '';
    })
    .join('\n');
}

/**
 * 允许直接用 `fetch` 的地方 —— **显式豁免，附理由**。
 *
 * ⚠️ 键是**相对 `packages/server/src` 的路径**（`/` 分隔）。
 */
const ALLOWED_RAW_FETCH: ReadonlyMap<string, string> = new Map([
  [
    'llm/http.ts',
    '`fetchGuarded` **自身**的实现 —— 它就是要调 `fetch` 的那一处（且已带 `dispatcher`，' +
      '由 `fetchGuardedWiring.test.ts` 守着）',
  ],
  [
    'binance/rest.ts',
    '币安 REST 客户端：地址来自**代码里的常量 endpoints**（`this.endpoints.rest`），' +
      '用户无法改；且它带的是交易所密钥、目标固定 —— 走 `fetchGuarded` 反而会引入' +
      '「允许私网」白名单的语义混淆',
  ],
  [
    'buildInfo.ts',
    '拉 GitHub 的版本信息：URL 由**常量拼接**（`api.github.com`），不可配',
  ],
  /*
   * ⚠️⚠️ 下面两处**是真实缺口，但收紧它会打断默认部署** —— 所以豁免 + 记风险，
   * 把"要不要收紧"留给产品决策。**这不是"没问题"，是"已知且有代价"。**
   *
   * 两处的共同点：
   *   · 地址来自 `.env`（`MAGPIE_GATEWAY_URL` / `MAGPIE_SEARCH_URL`）—— **运维可配**；
   *   · 都带 **`authorization: Bearer <key>`** —— 被重定向到内网时**密钥一起发过去**；
   *   · 都走裸 `fetch` —— **没有连接层校验**（`#126` 的 DNS rebinding 防线在这里不生效）。
   *
   * ⚠️ 而**默认端点就是 `http://127.0.0.1:3425`**（私网）——
   * 而 `fetchGuarded` 会拿 `env.allowPrivateLlmHosts` 过私网白名单，**默认是空的**。
   * 所以**直接换成 `fetchGuarded` 会让默认部署当场失效**（团队模式起不来）。
   *
   * 三个可选方向（**都需要产品/部署决策，不是纯技术修复**）：
   *   ① 默认部署就在 `.env` 里显式写 `ALLOW_PRIVATE_LLM_HOSTS=127.0.0.1`，
   *      然后这两处改走 `fetchGuarded` —— 最干净，但要动部署文档与默认 `.env`；
   *   ② 给这两处一个"只允许回环"的专用校验（比 `fetchGuarded` 宽、比裸 `fetch` 严）；
   *   ③ 保持现状，在 `docs/` 里记一条"已知：这两处只有字面层校验"。
   *
   * ⚠️ 我**没有擅自选** —— 因为 ① 要改部署约定、② 要定新的安全口径，
   * 两者都超出"修一个 bug"的范围（见 `docs/COLLABORATION.md` 的产品决策边界）。
   */
  [
    'trader/magpieGateway.ts',
    '⚠️ **已知缺口，待产品决策**：`discoverFromGateway` 用 `gateway.baseUrl`（来自 ' +
      '`MAGPIE_GATEWAY_URL`）+ `Bearer ${gateway.apiKey}` 走裸 `fetch`。' +
      '默认端点是 `http://127.0.0.1:3425/v1`（私网）—— 换成 `fetchGuarded` 会打断默认部署。' +
      '详见上面那段"三个可选方向"。',
  ],
  [
    'trader/agent/webSearch.ts',
    '⚠️ **已知缺口，待产品决策**：`webSearch` 用 `process.env.MAGPIE_SEARCH_URL`（默认 ' +
      '`http://127.0.0.1:3425/mcp/magpie/web-search`）+ `Bearer ${config.apiKey}` 走裸 `fetch`。' +
      '同上：换成 `fetchGuarded` 会打断默认部署。',
  ],
]);

test('★★★ 所有出站 fetch 都必须走 fetchGuarded（urlGuard.ts 写明的约束）', () => {
  const files = walk(SERVER_SRC);
  const offenders: string[] = [];
  let checked = 0;

  for (const file of files) {
    const rel = file.slice(SERVER_SRC.length + 1).replace(/\\/g, '/');
    const code = stripCommentsKeepLines(readFileSync(file, 'utf8'));

    /* 只找"真正发起请求"的形状（`await fetch(` / `undiciFetch(`），不含类型引用。 */
    const calls = [...code.matchAll(/(?<![\w.])(?:await\s+)?(?:undici)?[Ff]etch\(/g)];
    if (calls.length === 0) continue;

    /* 是否走了 `fetchGuarded`（同文件里出现即可 —— 它是唯一的出站封装）。 */
    const usesGuarded = /fetchGuarded\(/.test(code);
    checked += calls.length;

    if (!usesGuarded && !ALLOWED_RAW_FETCH.has(rel)) {
      for (const call of calls) {
        const line = code.slice(0, call.index).split('\n').length;
        offenders.push(`${rel}:${line}`);
      }
    }
  }

  /* 前置断言：必须真的扫到若干处调用（否则"零个问题"是因为没扫到东西）。 */
  assert.ok(
    checked >= 4,
    `★ 只扫到 ${checked} 处出站 fetch 调用 —— 扫描可能失效了，那样这条什么都没验`,
  );

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些出站 `fetch` **没有走 `fetchGuarded`**：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    ⚠️ `llm/urlGuard.ts` 的文件头明确写着：\n' +
      '      「新增出站路径时**必须**走 `fetchGuarded`，否则连接层校验不会被应用」。\n' +
      '    字面层校验（`checkOutboundUrl`）**挡不住 DNS rebinding** —— 那是 #126 的结论。\n' +
      '    ✅ 若某处确实该直接用 `fetch`（地址是代码里的常量、用户不可控），\n' +
      '       请加进 `ALLOWED_RAW_FETCH` 并**写明理由** —— 显式豁免，不是默默放过。',
  );
});

test('★★★ 判据必须能真的报出裸 fetch —— 用人造源码校准', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言 `offenders` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用同一套判据跑一段**故意裸 fetch** 的源码，断言它会被报出。
   */
  const scan = (code: string): string[] =>
    code
      .split('\n')
      .flatMap((line, i) =>
        [...line.matchAll(/(?<![\w.])(?:await\s+)?(?:undici)?[Ff]etch\(/g)].map(() => `line${i + 1}`),
      );

  assert.deepEqual(
    scan('const r = await fetch(url, { headers });'),
    ['line1'],
    '★★★ 判据必须能报出裸 fetch —— 否则上面那条是在空转',
  );
  /* 反向：走封装的不该被误报。 */
  const guarded = stripComments('const r = await fetchGuarded(url, init);');
  assert.equal(
    /(?<![\w.])(?:await\s+)?(?:undici)?[Ff]etch\(/.test(guarded),
    false,
    '★★ `fetchGuarded(` 不能被误判成裸 `fetch(`',
  );
});
