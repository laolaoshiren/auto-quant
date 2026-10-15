/**
 * **每一条 HTTP 路由都必须有鉴权**（或**显式登记为有意公开**）。
 *
 * ## 这条守卫接的是什么
 *
 * `api/server.ts` 有 **56 条路由**，而鉴权是**逐条显式声明**的：
 *
 * ```ts
 * const authed = { preHandler: requireAuth(deps.jwtSecret, tokenRevoked) };
 * app.get('/api/market/symbols', authed, async () => { … });
 * ```
 *
 * ⚠️ 这种"每条都要记得加"的结构**天生容易漏一条** —— 而漏掉的那条
 * **不会报错、不会让测试变红**，只是"这个端点谁都能调"。
 * 这正是本仓库反复出现的形态（`#126` 的接线、`#123` 的转义、`clerk` 的岗位…）：
 * **一组东西靠人逐个记，就一定会漏。**
 *
 * ## ⚠️ 我第一版的判据是错的（记在这里）
 *
 * 我先用"路由附近有没有 `authed`"扫了一遍，报出 **4 条**：
 * `/api/health`、`/api/auth/register`、`/api/auth/login`、`/api/events`。
 *
 * ⚠️ 前三条是**有意公开**的（健康检查、注册、登录）。
 * 而 `/api/events` 是 **WebSocket**（`{ websocket: true }`）—— 它**自己手动鉴权**：
 *
 * ```ts
 * const token = extractToken(request, { allowQueryToken: true });
 * if (!token) { socket.close(1008, '需要登录'); return; }
 * const payload = verifyToken(token, deps.jwtSecret);
 * if (!payload || tokenRevoked(payload)) { socket.close(1008, 'Invalid session'); return; }
 * ```
 *
 * ⚠️ 所以它是**安全的**，而我的判据**误报了** —— 因为"`authed` 中间件"只是
 * **鉴权的一种形式**。判据必须承认另外两种：**有意公开**、**手动鉴权**。
 *
 * ⚠️ 这个教训与第 24 轮那次一样：**判据本身也要被校准** ——
 * 一个误报的守卫会让人去改本来正确的代码。
 *
 * ## 判据（三类，每类都要显式）
 *
 * 1. **`authed` 中间件**（默认，绝大多数）；
 * 2. **`PUBLIC_ROUTES` 白名单**（有意公开 —— 必须写明理由）；
 * 3. **`MANUAL_AUTH` 白名单**（不用中间件但自己验 —— 必须写明理由）。
 *
 * ⚠️ 白名单**按路由精确匹配并附理由**，不是"整个文件豁免"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SRC = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

/** 剥掉行注释与块注释的行，但**保留行号**（否则报错位置会错）。 */
function stripCommentsKeepLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') ? line : '';
    })
    .join('\n');
}

interface Route {
  line: number;
  method: string;
  path: string;
  /** 附近（含自身）是否出现 `authed`。 */
  hasAuthedMiddleware: boolean;
  /** 是否是 WebSocket 路由（那种要用 `{ websocket: true }` 且手动鉴权）。 */
  isWebSocket: boolean;
}

function routes(): Route[] {
  const lines = stripCommentsKeepLines(SRC).split('\n');
  const out: Route[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/.exec(lines[i] ?? '');
    if (!m) continue;
    /* 向后看 13 行 —— 路由定义与它的 options 通常在这段里。 */
    const window = lines.slice(i, i + 13).join('\n');
    out.push({
      line: i + 1,
      method: m[1]!.toUpperCase(),
      path: m[2]!,
      hasAuthedMiddleware: /\bauthed\b/.test(window),
      isWebSocket: /\{\s*websocket:\s*true\s*\}/.test(window),
    });
  }
  return out;
}

/**
 * **有意公开**的路由 —— 显式登记，附理由。
 *
 * ⚠️ 键是 `METHOD /path`。
 */
const PUBLIC_ROUTES: ReadonlyMap<string, string> = new Map([
  ['GET /api/health', '健康检查：容器编排与监控要能在未登录时探活（也不含任何账户数据）'],
  ['POST /api/auth/register', '注册本身 —— 还没有账号，不可能带令牌'],
  ['POST /api/auth/login', '登录本身 —— 同上'],
]);

/**
 * **不用 `authed` 中间件、但自己验令牌**的路由 —— 显式登记，附理由。
 *
 * ⚠️ 这一类的存在是因为**有些协议拿不到中间件的注入点**
 *（例如 WebSocket 握手后拿到的是 `socket` 而不是 `reply`）。
 */
const MANUAL_AUTH: ReadonlyMap<string, string> = new Map([
  [
    'GET /api/events',
    'WebSocket 事件流（`{ websocket: true }`）—— 浏览器构造 WebSocket 时**无法设请求头**，' +
      '所以它是唯一允许从查询参数取令牌的地方（`extractToken(…, { allowQueryToken: true })`）。' +
      '⚠️ 它**自己验**：无令牌 → `close(1008)`；验签失败或已撤销 → `close(1008)`。' +
      '（我逐行核对过，见 `server.ts:2634-2646`。）',
  ],
]);

test('★★★ 每一条 HTTP 路由都必须有鉴权，或显式登记为公开', () => {
  const all = routes();

  /* 前置断言：必须真的扫到路由（否则"零个问题"是因为没扫到东西）。 */
  assert.ok(
    all.length >= 40,
    `★ 只扫到 ${all.length} 条路由 —— 扫描可能失效了，那样这条什么都没验`,
  );

  const unprotected: string[] = [];
  for (const r of all) {
    const key = `${r.method} ${r.path}`;
    if (r.hasAuthedMiddleware) continue;
    if (PUBLIC_ROUTES.has(key) || MANUAL_AUTH.has(key)) continue;
    unprotected.push(`第 ${r.line} 行：${key}${r.isWebSocket ? '（WebSocket）' : ''}`);
  }

  assert.deepEqual(
    unprotected,
    [],
    '★★★ 这些路由**没有鉴权、也不在公开白名单里**：\n' +
      unprotected.map((u) => `      · ${u}`).join('\n') +
      '\n    ⚠️ 鉴权是**逐条显式声明**的（`app.get(path, authed, handler)`）——\n' +
      '    这种结构**漏一条不会报错、不会让测试变红**，只是"这个端点谁都能调"。\n' +
      '    ✅ 若它确实该公开，请加进 `PUBLIC_ROUTES`；\n' +
      '       若它自己验令牌（如 WebSocket），请加进 `MANUAL_AUTH` —— 都要**写明理由**。',
  );

  /* 反向：白名单不能留下已经不存在的路由（否则名单会腐化）。 */
  const live = new Set(all.map((r) => `${r.method} ${r.path}`));
  for (const key of [...PUBLIC_ROUTES.keys(), ...MANUAL_AUTH.keys()]) {
    if (!live.has(key)) {
      assert.fail(
        `★★ 白名单里的 \`${key}\` 已经不存在了 —— 请从 PUBLIC_ROUTES / MANUAL_AUTH 移除。\n` +
          '    留在名单里会让下一个人以为那条路由还在。',
      );
    }
  }
});

test('★★★ 手动鉴权的路由必须真的验签 + 查撤销 —— 不能只判"有没有令牌"', () => {
  /*
   * ⚠️ 这条守的是 `MANUAL_AUTH` 那一类的**质量**：
   * "有令牌"不等于"令牌有效" —— 只判前者等于没鉴权（伪造一个字符串就过了）。
   *
   * ⚠️ 我第一版扫描把 `/api/events` 误报成"无鉴权"，就是因为它不用中间件。
   * 所以我逐行核对过它的实现，并在这里把它**钉住** —— 免得将来有人
   * 为了"消掉误报"而把它加进 `PUBLIC_ROUTES`（那是**打开**而不是**记录**）。
   */
  const code = stripCommentsKeepLines(SRC);
  const wsStart = code.indexOf("app.get('/api/events'");
  assert.ok(wsStart > 0, '找不到 `/api/events` 路由 —— 结构变了，请更新本测试');

  const body = code.slice(wsStart, wsStart + 2000);
  assert.match(body, /verifyToken\(/, '★★★ 手动鉴权必须**验签**（`verifyToken`），不能只判令牌存在');
  assert.match(
    body,
    /tokenRevoked\(/,
    '★★★ 手动鉴权必须**查撤销**（`tokenRevoked`）—— 登出/改密后旧令牌要立刻失效',
  );
  assert.match(
    body,
    /close\(\s*1008/,
    '★★ 验不过时必须**关闭连接**（1008 = policy violation），不能"继续但不发数据"',
  );
});

test('★★★ 路由鉴权判据必须能真的报出漏网 —— 用人造源码校准', () => {
  /*
   * ⚠️ "探针校准"：上面那条断言 `unprotected` 为空，而**一个什么都没扫到的实现
   * 也返回空数组**。这里用同一套判据跑一段**故意漏鉴权**的源码，断言它会被报出。
   */
  const scan = (code: string): string[] => {
    const lines = code.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/.exec(lines[i] ?? '');
      if (!m) continue;
      const window = lines.slice(i, i + 13).join('\n');
      const key = `${m[1]!.toUpperCase()} ${m[2]!}`;
      if (/\bauthed\b/.test(window)) continue;
      if (PUBLIC_ROUTES.has(key) || MANUAL_AUTH.has(key)) continue;
      out.push(key);
    }
    return out;
  };

  assert.deepEqual(
    scan("app.get('/api/secret', async () => ({}));"),
    ['GET /api/secret'],
    '★★★ 判据必须能报出无鉴权路由 —— 否则上面那条是在空转',
  );
  assert.deepEqual(
    scan("app.get('/api/secret', authed, async () => ({}));"),
    [],
    '★★ 带 `authed` 的不能被误报',
  );
  assert.deepEqual(
    scan("app.get('/api/health', async () => ({}));"),
    [],
    '★★ 公开白名单里的不能被误报',
  );
});
