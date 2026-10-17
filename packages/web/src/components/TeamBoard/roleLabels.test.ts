/**
 * **团队成员的每一个角色 id 都必须有中文名**（2026-10-17 · t52 的 B3 / t53）。
 *
 * ## 这条守的是哪个缺陷
 *
 * `TeamDecisionRow.tsx` 的 `MemberLine` 在角色未登记时渲染：
 *
 * ```
 *   {label ?? `${member.role}（界面未登记这个角色）`}
 * ```
 *
 * 兜底本身是对的（**绝不能显示成空白** —— 那会让操作员以为"这一轮没人说话"），
 * 但**每命中一次兜底就等于一次露码**：屏幕上会出现一串英文 id。
 * 实测（本任务修复前）：`symbol_scout` 就是那个漏登记的正式岗位 ——
 * 它是 `firm.ts` 里 `status: 'staffed'` 的「标的侦查员」，一产出就渲染成
 * `symbol_scout（界面未登记这个角色）`。**用户报的「出现英文字符」正是这个形状。**
 *
 * ## 为什么用测试、而不是把它写成 `Record<FirmRole['id'], string>`
 *
 * t52 的清单建议把表收紧成 `Record<FirmRole['id'], string>` 让 typecheck 兜住。
 * **实测那个写法没有用**：`FirmRole.id` 的类型是 `string`（`firm.ts:103`），
 * 所以 `Record<FirmRole['id'], string>` 与 `Record<string, string>` **完全等价** ——
 * 漏登记照样编译通过。
 *
 * 真正能收口的两条路：
 *   ① 把 `FirmRole.id` 收紧成字面量联合 → 属 `shared/firm.ts`，超出本任务范围；
 *   ② **遍历 `FIRM_ROLES` 逐 id 断言有标签** → 本文件。
 * ② 与 `domain.test.ts` 那条 `CLOSE_REASON_LABELS` 穷尽用例是同一个思路：
 * 权威名单只有一份（`FIRM_ROLES`），这里不再抄一遍。
 *
 * ## 判据不许恒真
 *
 * 末尾都有探针：一个**不在名单里的 id** 必须被判出来。全仓已有过"恒真断言"
 * 的教训（`t41`/`t43` 清过一轮），所以这里每条守卫都要能"改坏即红"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRM_ROLES } from '@aq/shared';
import { registeredRoleIds, roleLabel } from './TeamDecisionRow.js';

test('★★★ FIRM_ROLES 的每一个角色 id 都必须在界面标签表里登记', () => {
  assert.ok(
    FIRM_ROLES.length >= 20,
    `★ 只拿到 ${FIRM_ROLES.length} 个角色 —— 权威名单读取失效，下面的断言会恒真`,
  );

  const registered = new Set(registeredRoleIds());
  const unregistered = FIRM_ROLES.map((role) => role.id).filter((id) => !registered.has(id));

  assert.deepEqual(
    unregistered,
    [],
    `★★★ 这些正式岗位在界面上没有中文名：${unregistered.join('、')} —— ` +
      '它们一产出就会渲染成 `<英文 id>（界面未登记这个角色）`，' +
      '而用户明确要求整个前端 UI 都是中文表述',
  );
});

test('★★★ 每个已登记角色的中文名都真的翻译过（不是把 id 抄一遍）', () => {
  for (const role of FIRM_ROLES) {
    const label = roleLabel(role.id);
    assert.ok(
      typeof label === 'string' && label.length > 0,
      `★★★ 角色 '${role.id}' 的标签为空 —— 界面上这一行会变成空白或兜底提示`,
    );
    assert.notEqual(
      label,
      role.id,
      `★★★ 角色 '${role.id}' 的标签与 id 相同 —— 那等于没翻译，屏幕上仍是英文`,
    );
    /*
     * 标签里不该有 ASCII 字母：那是"没翻译"的形状。
     * `execution` 的中文名写作「交易员（执行层）」，不含英文 —— 与 firm.ts 的
     * `label` 字段保持一致（那个字段本身就是给界面用的中文名）。
     */
    assert.ok(
      !/[A-Za-z]/.test(label),
      `★★★ 角色 '${role.id}' 的标签「${label}」里还有英文字母`,
    );
  }
});

test('★★ 标签表里不该有 FIRM_ROLES 不认识的 id —— 那会在界面留一个永远不动的空位', () => {
  /*
   * `firm.ts` 的文件头注释点明了两种漂移，这是第二种：
   * > ② 界面写了某个角色、服务端没有 → **界面上有个永远不动的空位**
   *
   * 反向断言（表 ⊆ 权威名单）把它变成可执行的判据。
   * 注意**方向**：只允许"表里的都在名单里"，不允许反推
   *（名单里多一个由上面第一条守）。
   */
  const known = new Set(FIRM_ROLES.map((role) => role.id));
  const strangers = registeredRoleIds().filter((id) => !known.has(id));
  assert.deepEqual(
    strangers,
    [],
    `★★ 界面登记了 firm.ts 里不存在的角色：${strangers.join('、')} —— ` +
      '看板上会多出一个永远没有产出的岗位',
  );
});

test('★ 未登记的角色必须回落成"未登记"而不是空白（兜底语义不能丢）', () => {
  /*
   * 这是 `roleLabel` 的契约：`null` 表示"没登记"，由调用处决定怎么显示
   *（`MemberLine` 会渲染成 `<id>（界面未登记这个角色）`）。
   * 它**不能**返回空串 —— 那会让这一行看起来像"没人说话"。
   */
  assert.equal(roleLabel('__probe__'), null, '★ 探针：未知角色必须返回 null（不是空串、不是 undefined）');
  assert.notEqual(roleLabel('__probe__'), '', '★ 空串会让这一行看起来像"这一轮没人说话"');
});

test('★ 探针校准：把手写的"漏登记"样本喂给同一套判据，必须被判出来', () => {
  /*
   * 上面三条断言如果"怎么改都不红"，就等于没有守卫 ——
   * 本仓库为此付过代价（`t41`/`t43` 那一轮）。这里用一个人造的漏登记样本
   * 跑**同一段判据逻辑**，证明它确实会报。
   */
  const naiveTable: Record<string, string> = { supervisor: '总管' };
  const offenders = FIRM_ROLES.map((role) => role.id).filter((id) => !(id in naiveTable));
  assert.ok(
    offenders.length >= 20,
    `★ 探针失效：漏登记样本应当被判出至少 20 个（实际 ${offenders.length}）`,
  );
  assert.ok(
    offenders.includes('symbol_scout'),
    '★ 探针必须能抓到历史上真实漏掉的那个角色（symbol_scout）',
  );
});
