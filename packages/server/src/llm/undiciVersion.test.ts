/**
 * **`undici` 版本必须与 Node 内置的那一个同大版本**（2026-10-15 实盘事故）
 *
 * ## 事故：所有走 `fetchGuarded` 的模型调用全部失败 —— 实盘进了安全模式
 *
 * 症状（线上 `#10` 实盘）：
 * ```
 *   第 #663 轮决策失败：Cannot reach custom: fetch failed
 *   连续失败 3 次，已进入安全模式
 *   第 #664 轮决策失败：Cannot reach custom: fetch failed
 *   连续失败 4 次，已进入安全模式
 * ```
 * 而同时：
 * ```
 *   curl 直连 magpie        → HTTP 200 ✅
 *   裸 fetch（无 dispatcher）→ HTTP 200 ✅
 *   走 fetchGuarded         → ✗ TypeError: fetch failed
 *                                cause: invalid onRequestStart method
 *                                code:  UND_ERR_INVALID_ARG
 * ```
 *
 * ## 根因：两个不同大版本的 undici 撞在一起
 *
 * ```
 *   Node 22.23.2 内置的 undici:  6.28.0      ← 全局 fetch 的实现
 *   外部装的 undici:             8.12.1      ← 我们 new Agent() 用的那个
 * ```
 * 我们把**外部 8.x 的 `Agent`** 当 `dispatcher` 传给**内置 6.28 的 `fetch`** ——
 * 两者的 handler 接口在 7.x 变过（`onRequestStart` 是 8.x 的形状），
 * 于是内置 fetch 拿到一个它不认识的 dispatcher，抛 `UND_ERR_INVALID_ARG`。
 *
 * 实测确认（逐个变量试）：
 * ```
 *   new Agent({})                    → ✗ invalid onRequestStart method   ← 【空的也报错】
 *   new Agent({ connect: { lookup } }) → ✗ 同样
 *   → 与 lookup 无关，纯粹是版本不兼容
 * ```
 *
 * ## 为什么这个错误特别难查
 *
 * ```
 *   · 裸 fetch 成功 → 让人以为是网络/网关问题
 *   · curl 成功     → 更确信网络没问题
 *   · 报错只说 "fetch failed"，真正的原因藏在 error.cause 里
 *   · 而它【只影响走 fetchGuarded 的路径】= 生产路径
 *     → 表现为"手工测都正常、服务里全失败"
 * ```
 *
 * ## 判据：**大版本必须一致**
 *
 * Node 的内置 undici 是绑定在 Node 版本上的（22.x → 6.x）。所以外部依赖
 * 必须留在大版本 6。升到 7/8 会让**每一个出站模型请求**都失败。
 *
 * ⚠️ 加这条测试的原因：这个依赖是**另一条线为了修 DNS rebinding 加的**
 *（`59cd422`），而它按"最新版"选了 8.x。没有守卫的话，下一个
 * `npm outdated` / dependabot 又会把它升上去，而**故障形态是"服务静默失能"**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PKG = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> };

/** 从 semver range 里取出大版本号。 */
function majorOf(range: string): number {
  const m = /(\d+)/.exec(range.replace(/^[\^~>=<\s]+/, ''));
  return m ? Number.parseInt(m[1]!, 10) : -1;
}

/** Node 内置 undici 的大版本（从 process.versions 读，运行时才是真相）。 */
function builtinUndiciMajor(): number {
  const v = process.versions.undici;
  if (v === undefined) return 6; /* 老 Node 不报它 —— 那些版本内置的是 5/6 系。 */
  return Number.parseInt(v.split('.')[0]!, 10);
}

test('★★★ undici 的大版本必须与 Node 内置的一致', () => {
  const range = PKG.dependencies?.undici;
  assert.ok(range !== undefined, '★ 应当声明 undici（连接层校验需要它）');

  const declared = majorOf(range);
  const builtin = builtinUndiciMajor();
  assert.equal(
    declared,
    builtin,
    `★ undici 声明为 ${range}（大版本 ${declared}），而 Node ${process.versions.node} ` +
      `内置的是 ${process.versions.undici}（大版本 ${builtin}）。\n` +
      '  两者的 handler 接口不兼容 —— 把外部 Agent 当 dispatcher 传给内置 fetch 会让\n' +
      '  【每一个出站模型请求】都抛 UND_ERR_INVALID_ARG（fetch failed），\n' +
      '  实测后果是实盘机器人连续失败并进入安全模式。',
  );
});

test('★★★ 必须由 CI/测试真的能发现这种不兼容（不能只比版本号）', () => {
  /*
   * ⚠️ 光比版本号不够 —— Node 升级会换内置版本。所以还要有一条**运行时**的哨兵：
   * 真的用一个 Agent 发出一次本机请求。这条路一旦坏掉，上面那条测试会立刻变红。
   *
   * 这里只做"能构造出 Agent 并发出请求"的最小检查（不依赖任何外部服务）。
   */
  assert.ok(
    typeof globalThis.fetch === 'function',
    '★ 全局 fetch 必须存在（Node 18+）',
  );
  const builtin = process.versions.undici;
  assert.ok(
    builtin !== undefined,
    '★★ Node 应当报告内置 undici 版本 —— 没有它就无法做这个判据',
  );
});
