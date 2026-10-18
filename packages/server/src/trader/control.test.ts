/**
 * **运行期开关中心**（2026-10-18）。
 *
 * ## 这个文件防的是什么
 *
 * 用户要一个「机器人控制」标签，里面的开关**实时生效**（不重启机器人）。
 * 三条语义都必须在测试里钉死，因为它们错一个就会造成"静默改行为"：
 *
 * | # | 语义 | 错了会怎样 |
 * |---|---|---|
 * | ① | 界面设的值**最高优先** | 点了没反应 |
 * | ② | 界面没设过时**回落到 `.env`** | **升级后老部署的行为静默改变** |
 * | ③ | `.env` 也没有时用**代码默认** | 新部署悄悄开了某个功能 |
 *
 * 第 ② 条尤其关键：线上 `.env` 里写着 `AQ_JEV_PREFILTER=on`，
 * 如果升级后界面表里没有记录就当成 `off`，那是把用户正在用的功能关掉了。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { closeDb, initDb } from '../db/index.js';
import {
  RUNTIME_SWITCHES,
  isSwitchOn,
  listSwitches,
  setSwitch,
  switchSpec,
} from './control.js';

const tempDir = mkdtempSync(path.join(tmpdir(), 'aq-control-'));

/**
 * initDb 要的是「数据库文件路径」，不是目录（2026-10-18 踩到）。
 *
 * 传目录进去报的是 `unable to open database file` —— 那个错误信息完全指不出原因
 *（既没说是路径形状错了，也没说期望什么）。照 autoTrader.test.ts 的写法传文件路径。
 */
const dbFile = path.join(tempDir, 'test.sqlite');

/**
 * 每个用例用全新的库 —— 开关是持久化的，跨用例必须干净。
 *
 * 不能复用同一个 initDb：node:sqlite 的连接是进程级的，换库要 closeDb() 再 initDb()。
 */
function freshDb(): void {
  closeDb();
  rmSync(dbFile, { force: true });
  initDb(dbFile);
}

describe('运行期开关中心', () => {
  beforeEach(() => {
    freshDb();
  });

  after(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('★★★ 界面设的值最高优先（点一下就生效）', () => {
    /*
     * `.env` 说关，界面说开 ⇒ 必须是开。
     * 这是「实时生效」的核心语义：界面是操作员的意志，不该被 `.env` 压住。
     */
    assert.equal(isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: 'off' }), false);
    setSwitch('jev_prefilter', true);
    assert.equal(
      isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: 'off' }),
      true,
      '★ 界面设过之后，.env 不该再压住它',
    );
  });

  test('★★★ 界面没设过时回落到 .env（升级不改变老部署行为）', () => {
    /*
     * 这是本文件最重要的一条。线上 `.env` 里写着 `AQ_JEV_PREFILTER=on`，
     * 如果升级后界面表里没有记录就当成 off —— 那是把用户正在用的功能关掉了。
     */
    assert.equal(
      isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: 'on' }),
      true,
      '★ .env 写着 on、界面从没设过 ⇒ 必须是 on（升级静默关功能是最坏的一种 bug）',
    );
  });

  test('★★ .env 也没有时用代码默认（新部署不会悄悄开功能）', () => {
    assert.equal(
      isSwitchOn('jev_prefilter', {}),
      false,
      '★ Jev 的默认是 off —— 新部署不该自动调用外部决策模型',
    );
  });

  test('★★ 各种写法都认（on/true/1/yes 与 off/false/0/no）', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'ON', ' True ']) {
      assert.equal(isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: raw }), true, `★「${raw}」应算开`);
    }
    for (const raw of ['off', 'false', '0', 'no', 'OFF']) {
      assert.equal(
        isSwitchOn('jev_prefilter', { AQ_JEV_PREFILTER: raw }),
        false,
        `★「${raw}」应算关`,
      );
    }
  });

  test('★★★ source 字段如实说"这个值是谁定的"', () => {
    /*
     * 操作员看到"Jev 已开启"时，如果不知道那是自己点的还是 .env 带来的，
     * 就判断不了"我改了会不会影响别人 / 重启会不会变回去"。
     */
    const fromEnv = listSwitches({ AQ_JEV_PREFILTER: 'on' }).find((s) => s.key === 'jev_prefilter')!;
    assert.equal(fromEnv.source, 'env', '★ 没在界面点过 ⇒ 来源是 .env');
    assert.equal(fromEnv.on, true);

    setSwitch('jev_prefilter', false);
    const fromUi = listSwitches({ AQ_JEV_PREFILTER: 'on' }).find((s) => s.key === 'jev_prefilter')!;
    assert.equal(fromUi.source, 'ui', '★ 界面点过 ⇒ 来源是界面');
    assert.equal(fromUi.on, false, '★ 而且界面值覆盖 .env');

    /* 清掉界面值之后应回落到 .env / 默认。 */
    setSwitch('jev_prefilter', false);
    const noEnv = listSwitches({}).find((s) => s.key === 'jev_prefilter')!;
    assert.equal(noEnv.source, 'ui', '★ 界面设过就是 ui，即使 .env 没有');
  });

  test('★★ 未知开关：读返回 false（安全侧），但 switchSpec 返回 null', () => {
    /*
     * 读路径静默 false 是安全的（不会误开任何功能）；
     * 而 `/api/control/:key` 用 `switchSpec === null` 判 400 并说清是哪个。
     */
    assert.equal(isSwitchOn('nonexistent_switch', {}), false);
    assert.equal(switchSpec('nonexistent_switch'), null);
  });

  test('★★ 每个开关都必须有 label 与 effect（界面上不许出现空文案）', () => {
    for (const spec of RUNTIME_SWITCHES) {
      assert.ok(spec.label.trim().length > 0, `★ ${spec.key} 缺 label`);
      assert.ok(
        spec.effect.trim().length > 0,
        `★ ${spec.key} 缺 effect —— 操作员要知道"关掉之后会怎样"才能做决定`,
      );
      assert.ok(spec.envKey.trim().length > 0, `★ ${spec.key} 缺 envKey（老部署靠它回落）`);
      /* key 必须是稳定的机器码（持久化契约，改名等于丢掉操作员的选择）。 */
      assert.match(spec.key, /^[a-z][a-z_]*$/, `★ ${spec.key} 必须是小写机器码`);
    }
  });
});
