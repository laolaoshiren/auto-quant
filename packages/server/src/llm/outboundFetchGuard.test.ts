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
   * ⚠️⚠️ 下面两处**是真实缺口，但威胁模型比 #126 弱、且收紧它有代价** ——
   * 所以豁免 + 记风险，把"要不要收紧"留给产品决策。**这不是"没问题"，是"已知且有代价"。**
   *
   * 两处的共同点：
   *   · 地址来自 `.env`（`MAGPIE_GATEWAY_URL` / `MAGPIE_SEARCH_URL`）—— **运维可配**；
   *   · 都带 **`authorization: Bearer <key>`** —— 被重定向到内网时**密钥一起发过去**；
   *   · 都走裸 `fetch` —— **没有连接层校验**（`#126` 的 DNS rebinding 防线在这里不生效）。
   *
   * ## ⚠️ 但威胁模型与 #126 **不同级**（这一点我核实过，必须写清）
   *
   * `#126` 的面是「**任何拿到控制台会话的人**」—— 因为 `baseUrl` 是**界面上可配的**
   *（`api/server.ts` 的 `BaseUrlSchema` 就是为它加的校验）。
   *
   * 而这两处的地址**只来自 `process.env`**（我全仓 grep 过：除测试外只有
   * `manager.ts:2317` 与 `teamGateway.ts:85` 读它们）—— **界面改不了**。
   * 所以攻击者需要**改服务器的 `.env`**，即**已经有服务器访问权**。
   * 那是"已经拿到机器的人"再往外跳一步，**不是"一个登录用户升级成拿到凭据"**。
   *
   * ## ⚠️ 三个可选方向，我实测过每个的代价（都不是"免费的收紧"）
   *
   * | 方向 | 默认部署（`127.0.0.1`）| 内网网关部署（`10.0.0.5`）| 代价 |
   * | --- | --- | --- | --- |
   * | ② 只允许回环 | ✅ 不受影响 | ❌ **会被拒** | 破坏内网网关部署（`teamGateway.test.ts:33` 证明那是**受支持的形态**）|
   * | ③ 读 `ALLOW_PRIVATE_LLM_HOSTS` | ❌ **会被拒** | ✅ 需运维显式设 | 破坏**默认部署**（两个 `.env.example` **都未设**该变量）→ 团队模式起不来 |
   * | ① 默认 `.env` 写白名单 + 走 `fetchGuarded` | ✅ | ✅ | 语义最一致（与 `client.ts` 同一套），但要动**部署约定 + 两个 `.env.example` + 部署文档** |
   *
   * ### ⚠️⚠️ 以及一个"看起来零代价、实测是错的"的方案（我试过并否掉了）
   *
   * 我一度以为能找到**两全**的做法：白名单 = `ALLOW_PRIVATE_LLM_HOSTS`
   * **+ 该端点自己声明的主机**（理由是"运维既然把 `MAGPIE_GATEWAY_URL` 设成
   * `10.0.0.5`，那就是他显式声明的目标"）。
   *
   * ⚠️ **实测它把防线整个打开了**：`checkResolvedAddress` 里那条判据是
   * `hostIsAllowlisted(host, literal, …)` —— **主机名在白名单里就放行它解析到的任何 IP**。
   * 于是把目标主机加进白名单 = **取消该目标的连接层校验**：
   *
   * ```
   * 用方案④跑四种目标，连接层对 127.0.0.1 / 10.0.0.5 / 169.254.169.254 全部放行 ❌
   * ```
   *
   * ⚠️ 而这**正是 DNS rebinding 攻击要的东西**（"允许这个主机名" ≠ "允许它解析到内网"）。
   * 所以方案④**不是两全，是打开防线** —— 记在这里，免得将来有人"好心"再提一次。
   *
   * ⚠️ 我**没有擅自选** ①②③ —— ① 要改部署约定、②③ 都要牺牲某种受支持的部署形态。
   * 三者都超出"修一个 bug"的范围（见 `docs/COLLABORATION.md` 的产品决策边界）。
   *
   * ⚠️ 顺带发现（本轮）：**两个 `.env.example` 里根本没有 `ALLOW_PRIVATE_LLM_HOSTS`
   * 这个变量** —— 也就是说这个安全开关**在部署文档里没有出现过**。
   * 这本身是一个可独立推进的文档缺口（但它也属于"要不要把内网端点作为一等配置"的产品口径）。
   */
  [
    'trader/magpieGateway.ts',
    '⚠️ **已知缺口，待产品决策**：`discoverFromGateway` 用 `gateway.baseUrl`（来自 ' +
      '`MAGPIE_GATEWAY_URL`）+ `Bearer ${gateway.apiKey}` 走裸 `fetch`。' +
      '⚠️ 地址只来自 `.env`（**界面不可配**）→ 威胁模型弱于 #126。' +
      '三个方向见上面那张代价表。',
  ],
  [
    'trader/agent/webSearch.ts',
    '⚠️ **已知缺口，待产品决策**：`webSearch` 用 `process.env.MAGPIE_SEARCH_URL`（默认 ' +
      '`http://127.0.0.1:3425/mcp/magpie/web-search`）+ `Bearer ${config.apiKey}` 走裸 `fetch`。' +
      '同上：地址只来自 `.env`，威胁模型弱于 #126。',
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

test('★★★ 判据必须能真的报出裸 fetch —— 用人造源码校准', () => {  /*
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
