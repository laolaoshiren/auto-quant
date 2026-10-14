/**
 * **调研成果必须活过进程重启**（2026-10-13）。
 *
 * ## 为什么单独一条测试
 *
 * 这是一个**"功能在重启后悄悄退化"**的问题 —— 而它的现象（"首次调研"）
 * 看起来完全正常：**一个进程确实只能"首次"一次**。
 *
 * ## 事故现象
 *
 * 线上日志反复出现（每 16 分钟一次）：
 * ```
 *   03:08:20 [调研] 首次调研在后台进行 —— 本轮**没有新闻材料**
 *   03:24:56 [调研] 首次调研在后台进行 —— 本轮**没有新闻材料**
 *   03:28:21 [调研] 首次调研在后台进行 —— 本轮**没有新闻材料**
 *   03:45:08 [调研] 首次调研在后台进行 —— 本轮**没有新闻材料**
 * ```
 * 而同一时段**确实成功过一次**（`03:50:38 可用情报 2 条`），
 * 然后 `03:58:23` 服务重启（一次部署），`03:59:37` 又是"首次调研"。
 *
 * ## 根因
 *
 * `researchCache` 是**进程内存**（`Map`）—— 重启就没了。
 * 而一次调研要 **22 分钟**（实测），所以"重启 → 22 分钟没有新闻"是必然的。
 *
 * ⚠️ 这不是"实现 bug"，而是**与用户要求的冲突**：
 * > 「更新成 **7×24 不间断**、不定时、持续工作模式」
 *
 * ## 而它还有个隐蔽的代价
 *
 * 实测那份情报**只值 2 条**（查询一次成本很高：22 分钟 + 4 个 claude 进程）——
 * 每次部署都丢掉它，等于**每改一次代码就白花 22 分钟**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { codeOnly } from '../testUtils/sourceText.js';

const MANAGER = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8');


const CODE = codeOnly(MANAGER);

test('★★★ 调研缓存必须有持久化层（不能只有内存 Map）', () => {
  assert.ok(
    /function readPersistedResearch\(/.test(MANAGER),
    '★ 必须有"从库里读回"的路径',
  );
  assert.ok(
    /function persistResearch\(/.test(MANAGER),
    '★ 必须有"写进库"的路径',
  );
  assert.ok(
    MANAGER.includes('settings.get(') && MANAGER.includes('settings.set('),
    '★ 应当用 `settings` 表（它已经在别处被用于持久化）',
  );
});

test('★★★ 所有调用点必须走封装函数（不能绕过持久化）', () => {
  /*
   * ⚠️ 这是本修复最容易失效的地方：只要有**一处**还直接操作
   * `researchCache`，那条路径的成果就活不过重启。
   *
   * 允许的两处例外在 `getResearchCache` / `setResearchCache` 内部
   *（它们就是那层封装）—— 所以这里数的是"总出现次数"而不是"零出现"。
   */
  assert.ok(
    /function getResearchCache\(traderId: number\)/.test(MANAGER),
    '★ 必须有统一的读入口',
  );
  assert.ok(
    /function setResearchCache\(/.test(MANAGER),
    '★ 必须有统一的写入口',
  );
  /* 直接的 `researchCache.get/set/delete` 只该出现在那三个封装函数里（4 处）。 */
  const direct = CODE.match(/researchCache\.(get|set|delete)\(/g) ?? [];
  assert.ok(
    direct.length <= 4,
    `★ 直接操作内存 Map 的地方应当只在封装函数内（实际 ${direct.length} 处）`,
  );
});

test('★★★ 清缓存默认只清内存；删库必须是【显式】的', () => {
  /*
   * ⚠️ **两个场景需要相反的行为**（见 `clearResearchCache` 里那段长注释）：
   * ```
   *   进程重启（部署/崩溃）  → 库要保留（22 分钟换来的情报不该白丢）
   *   用户主动停止机器人     → 连库一起删（否则停止→启动会拿到旧情报）
   * ```
   * 而**进程重启时根本不会调用 `clearResearchCache`**（代码没跑），
   * 所以"默认只清内存"就足够区分两者。
   *
   * ⚠️ 这个区分必须显式（`dropPersisted: true`）——
   * 否则下一个人看到"停止时清了库、而重启时没清"会以为是漏了，
   * 然后"修"成一致，于是两个场景必然坏一个。
   */
  const m = /function clearResearchCache\([\s\S]{0,2500}?\n\}/.exec(CODE);
  assert.ok(m !== null, '★ 必须能定位 clearResearchCache');
  const body = m[0];
  assert.ok(/researchCache\.delete/.test(body), '★ 它要清内存');
  /* 删库必须挂在显式开关上。 */
  assert.ok(
    /options\?\.dropPersisted === true/.test(body),
    '★ 删库必须是显式的（`dropPersisted: true`），不能无条件',
  );
  /* ⚠️ 而且它必须【晚于】清内存 —— 保证"清内存"永远会发生。 */
  /*
   * ⚠️ 锚点要用 `if (options` 而不是裸的 `dropPersisted` ——
   * 后者会命中**函数签名里**的 `options?: { dropPersisted?: boolean }`
   *（第一版就是这样假失败的：签名在函数体之前，于是"顺序"判据必然失败）。
   */
  assert.ok(
    body.indexOf('researchCache.delete') < body.indexOf('if (options'),
    '★ 清内存必须在删库之前（保证前者永远执行）',
  );
});

test('★★★ 封装函数不能自己调自己（无限递归 —— 而 TS 抓不到）', () => {
  /*
   * ## 这条测试来自一次真实事故（2026-10-13）
   *
   * 我用批量替换把 `researchCache.get(` 换成 `getResearchCache(` ——
   * **结果把这个封装函数自己的函数体也换掉了**：
   * ```ts
   *   function getResearchCache(traderId) {
   *     const inMemory = getResearchCache(traderId);   // ← 无限递归！
   *   }
   *   function clearResearchCache(traderId) {
   *     clearResearchCache(traderId);                   // ← 更直接
   *   }
   * ```
   *
   * ⚠️ **TypeScript 抓不到这种错** —— 递归调用的类型完全合法。
   * 所以必须用一条**文本断言**钉住它。
   *
   * ⚠️ 教训：**批量替换会改到"定义处"本身** ——
   * 替换后必须逐个检查新写的封装函数体，而不是只看替换计数。
   */
  for (const name of ['getResearchCache', 'setResearchCache', 'clearResearchCache']) {
    /*
     * ⚠️ 用 `CODE`（去注释）—— 否则"函数体"会跨到注释里去，
     * 而注释里正好引用过 `researchCache.get(`（见 `codeOnly` 的说明）。
     */
    const m = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]{0,600}?)\\n\\}`).exec(CODE);
    assert.ok(m !== null, `★ 必须能定位 ${name}`);
    const body = m[1] ?? '';
    assert.ok(
      !new RegExp(`\\b${name}\\(`).test(body),
      `★★★ ${name} 的函数体里不能再调 ${name}（无限递归 —— TS 抓不到）`,
    );
  }
});

test('★★★ 持久化只认"真的有内容"的那一份（空情报不写库）', () => {
  /*
   * ⚠️ 占位对象（`at: 0`、`text: ''`）不该进库 ——
   * 否则重启后会把"空情报"当成"旧情报"（那是本项目已经修过一次的坑）。
   */
  /*
   * ⚠️ 窗口从 400 放宽到 1200（2026-10-15）—— 加 `keys` 参数时函数体里多了
   * 一段说明注释，把断言需要的那一行挤出了窗口，于是**这条守卫自己先红了**
   *（而它要守的行为其实没坏）。
   *
   * 这正是一类值得记的脆弱判据：**用"字符数窗口"定位函数体**，
   * 窗口大小会随着注释增长而失效 —— 而失效的方式是"守卫报假警报"，
   * 比"守卫漏报"好一些，但同样要人花时间分辨。
   * 更稳的写法是从 `function X(` 起、到下一个顶格 `}` 止（不数字符）。
   */
  const m = /function persistResearch\([\s\S]{0,1200}?\n\}/.exec(MANAGER);
  assert.ok(m !== null, '★ 必须能定位 persistResearch');
  assert.ok(
    /if \(at <= 0 \|\| text\.length === 0\) return;/.test(m[0]),
    '★ 空情报必须被挡在库外',
  );
  /* 读回来那一侧也要挡。 */
  assert.ok(
    /if \(at <= 0 \|\| text\.length === 0\) return undefined;/.test(MANAGER),
    '★ 读回来时也要挡（库里万一有历史脏数据）',
  );
});
