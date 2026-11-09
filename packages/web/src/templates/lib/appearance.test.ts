/**
 * 「这个主题在当前模板下会不会生效」—— 外部 issue #171 的回归测试。
 *
 * ## 这个测试防的是什么
 *
 * 浅色主题靠 CSS 属性选择器实现：
 *
 * ```
 * html.aq-quill[data-skin='light'] { … }   ← quill/theme.css:224
 * ```
 *
 * 如果一套模板**没有**写浅色规则，而外观页仍把「深色 / 浅色」两张卡原样摆出来，
 * 用户点「浅色」会：
 *
 *   · 写进 localStorage（设置确实存下来了）
 *   · `<html>` 上写了 `data-skin="light"`（属性也对了）
 *   · 按钮显示为**已选中**（带勾）
 *   · **界面一个像素都不变**
 *
 * 也就是"UI 承诺了它做不到的事" —— 与本仓库反复修过的
 * 「设置存下来但不生效且不报错」是同一族。
 *
 * ## UI 收敛之后（2026-11-10）
 *
 * 内置只剩 `quill` 一套，它**深 / 浅两套都支持**。`supportedSkins` 机制仍然保留：
 * 第三方模板若只有深色，声明 `supportedSkins: ['dark']` 即可让外观页禁用浅色卡
 * 并就地说明原因。所以下面既测"内置那套的声明与 CSS 一致"，也测机制本身。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isSkinSupported, unsupportedSkins, SKINS } from './appearance';
import { BUILT_IN } from '../registry';

test('★★★ 唯一内置模板（quill）必须声明两套主题都支持', () => {
  assert.equal(BUILT_IN.length, 1, `内置模板收敛后应只有 quill 一套，实际 ${BUILT_IN.length} 套`);
  const quill = BUILT_IN.find((t) => t.id === 'quill');
  assert.ok(quill, '找不到 quill 模板');

  assert.deepEqual(
    quill.supportedSkins,
    ['dark', 'light'],
    '★★★ quill 的 theme.css 里有 [data-skin=\'light\'] 规则，必须声明两套都支持',
  );
});

test('★ 声明与 CSS 实际规则一致 —— 两边漂移会让这个缺陷重现', () => {
  /*
   * 这条用例的价值在于：它把"CSS 里有没有浅色规则"与"注册表里怎么声明"
   * 绑在一起。只改一边就会红 —— 而这类"两处各写一份"正是本仓库吃过多次的亏。
   */
  const here = path.dirname(fileURLToPath(import.meta.url));

  for (const t of BUILT_IN) {
    const cssPath = path.join(here, '..', t.id, 'theme.css');
    const hasCss = existsSync(cssPath) && readFileSync(cssPath, 'utf8').includes("[data-skin='light']");
    const claimsLight = (t.supportedSkins ?? []).includes('light');

    if (claimsLight) {
      assert.ok(
        hasCss,
        `★ ${t.id} 声明支持浅色，但它的 theme.css 里没有 [data-skin='light'] 规则 —— ` +
          `那会让浅色选项变成点了没反应的开关（正是本 issue 的缺陷）`,
      );
    } else {
      assert.ok(
        !hasCss,
        `★ ${t.id} 的 theme.css 有浅色规则，但注册表没声明支持 —— 请把 'light' 加进 supportedSkins`,
      );
    }
  }
});

test('isSkinSupported：没声明就不做限制（第三方模板不必知道这个字段）', () => {
  assert.equal(isSkinSupported(undefined, 'light'), true);
  assert.equal(isSkinSupported([], 'light'), true);
  assert.equal(isSkinSupported(['dark', 'light'], 'light'), true);
  assert.equal(isSkinSupported(['dark'], 'light'), false);
  assert.equal(isSkinSupported(['dark'], 'dark'), true);
});

test('unsupportedSkins：给出"当前模板下不生效"的那些选项', () => {
  /* 只有深色的第三方模板 → 浅色是不生效的那个。 */
  assert.deepEqual(unsupportedSkins(['dark']), ['light']);
  /* 两套都支持 → 没有不生效的（内置 quill 就是这种情况）。 */
  assert.deepEqual(unsupportedSkins(['dark', 'light']), []);
  /* 未声明 → 视为全都支持（与 isSkinSupported 一致）。 */
  assert.deepEqual(unsupportedSkins(undefined), []);
});

test('SKINS 里恰好有深色与浅色两项 —— 与 Skin 类型同步', () => {
  assert.deepEqual(
    SKINS.map((s) => s.id),
    ['dark', 'light'],
  );
});
