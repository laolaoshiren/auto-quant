/**
 * 前后端接口对照 —— 前端 `api.ts` 声明的每个调用，后端 `server.ts` 是否真有那条路由。
 *
 * ## 为什么需要它
 *
 * 这个检查原来是**人工做的一次**（会话里对照两边清单），而它发现的东西值得每次
 * 都查：**前端调一条不存在的路由，只会在用户点下去的那一刻报错** ——
 * 类型系统看不见（`request<T>()` 只约束响应体），构建也看不见。
 *
 * ## 它检查两个方向，而第二个更要紧
 *
 * 1. **前端调了、后端没有** → 那是**坏掉的按钮**，每次点击都会失败。
 * 2. **后端有、前端没调** → 多数是给外部用的（首次注册、兼容旧前端、WebSocket
 *    升级），但也可能是**没人调的死路由** —— 而"没人调"本身不是错，
 *    所以这一侧只**报告**，不失败。
 *
 * （第 2 类里有几个是**刻意**的，见下面的 `INTENTIONALLY_UNCALLED`；
 *   判断依据写在 `docs/API.md` 与 `LoginPage.tsx` 里，不是我猜的。）
 *
 * ## 路径归一化
 *
 * `api.ts` 用模板插值（`` `/traders/${id}/stats` ``），`server.ts` 用参数名
 * （`/api/traders/:id/stats`）—— 两边都要化成同一个形状才比得了。
 *
 * ⚠️ **第一版只处理了模板插值**，于是 `/traders/:x/stats` 与 `/traders/:id/stats`
 * 被判成两条不同的路由，24 条带参数的前端调用全被误报成"后端没有"。
 * **问对问题之前，先让工具对。**
 */
import { readFileSync } from 'node:fs';

/*
 * ⚠️ 用 `process.cwd()` 而不是 `new URL('..', import.meta.url).pathname` ——
 * 后者会把**中文路径**百分号编码（`D:\项目\…` → `D:\%E9%A1%B9%E7%9B%AE\…`），
 * 于是 `readFileSync` 报 ENOENT 而错误信息里那一串看起来跟路径本身无关。
 * `npm run` 一律从仓库根执行，所以 cwd 就是这里要的那个根。
 */
const ROOT = `${process.cwd()}/`;
const apiSrc = readFileSync(`${ROOT}packages/web/src/lib/api.ts`, 'utf8');
const serverSrc = readFileSync(`${ROOT}packages/server/src/api/server.ts`, 'utf8');

/**
 * 后端有、前端**刻意**不调的端点。
 *
 * 这个名单不是"忽略列表"，而是一份**判断记录** —— 每一条都要能指出来源。
 */
const INTENTIONALLY_UNCALLED = new Map([
  ['/api/auth/register', 'LoginPage 明说"本系统没有注册入口，账号在服务首次启动时自动生成"'],
  ['/api/auth/password', 'docs/API.md：保留为同义端点，仅为了兼容浏览器中缓存的旧版前端'],
  ['/api/events', 'WebSocket 升级端点，由 `new WebSocket(...)` 连，不走 api.ts'],
]);

/** 把路径化成"形状"：参数一律写作 `:p`。 */
export const normalizePath = (p) =>
  p
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p')
    .split('?')[0]
    .replace(/\/+$/, '');

/** 从两个源文件里抽出调用的路径与注册的路由。导出是为了能被测试直接验证。 */
export function collectRoutes(apiSource = apiSrc, serverSource = serverSrc) {
  const frontend = new Map();
  for (const m of apiSource.matchAll(/(\w+):\s*(?:\([^)]*\)\s*=>\s*)?request[^(]*\(\s*[`'"]([^`'"]+)[`'"]/g)) {
    const path = normalizePath(m[2]);
    if (!path.startsWith('/')) continue;
    if (!frontend.has(path)) frontend.set(path, []);
    frontend.get(path).push(m[1]);
  }

  const backend = new Map();
  for (const m of serverSource.matchAll(/app\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
    const path = normalizePath(m[2]);
    if (!backend.has(path)) backend.set(path, []);
    backend.get(path).push(m[1].toUpperCase());
  }

  return { frontend, backend };
}

/* -------------------------------------------------------------------------- */
/*  作为脚本运行                                                               */
/* -------------------------------------------------------------------------- */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const { frontend, backend } = collectRoutes();
  console.log(`前端声明 ${frontend.size} 条调用 · 后端注册 ${backend.size} 条路由`);

  const missing = [];
  for (const [path, names] of frontend) {
    if (!backend.has(`/api${path}`)) missing.push(`${path}（api.ts: ${names.join(', ')}）`);
  }

  const uncalled = [];
  for (const [path, methods] of backend) {
    const bare = path.replace(/^\/api/, '');
    if (frontend.has(bare)) continue;
    if (INTENTIONALLY_UNCALLED.has(path)) continue;
    uncalled.push(`${path} [${methods.join(',')}]`);
  }

  if (missing.length > 0) {
    console.error(`\n✗ 前端调了但后端没有的路由（这些按钮点了必然失败）：`);
    for (const m of missing) console.error(`    ${m}`);
  }

  if (uncalled.length > 0) {
    console.warn(`\n⚠ 后端有、前端没调的端点（可能只是给外部用的，请确认）：`);
    for (const u of uncalled.sort()) console.warn(`    ${u}`);
  }

  if (missing.length === 0) {
    console.log('✓ 前端声明的每一条调用都有对应路由');
    console.log(`  （刻意不调的有 ${INTENTIONALLY_UNCALLED.size} 个，见脚本里的判断记录）`);
  }

  process.exit(missing.length > 0 ? 1 : 0);
}
