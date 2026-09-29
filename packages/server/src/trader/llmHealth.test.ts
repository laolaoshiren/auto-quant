import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../db/index.js';
import { settings } from '../store/repositories.js';
import { readLlmHealth } from './manager.js';

/**
 * AI 模型的健康快照。
 *
 * ## 这个文件为什么存在
 *
 * 2026-09-29 实测：网关连着 **12 次**回
 * `You have insufficient credits to make this request.`（HTTP 400），
 * 而**控制台上一个字都没有** —— 机器人看着"在运行"，实际已经做不出决策，
 * 用户只能去服务器翻 `server.log` 才知道。
 *
 * 这份快照（写在 `settings` 的 `llm_health:<id>`）就是让界面能说出
 * "模型现在不能用"。它只是给界面看的，所以**坏了也只能当作"没有记录"**，
 * 绝不允许抛错打断任何事。
 */
let workDir: string;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'aq-llmhealth-'));
  initDb(path.join(workDir, 'health.sqlite'));
});

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().run('DELETE FROM settings');
});

test('★ 健康快照要能读出成功与失败', () => {
  settings.set(
    'llm_health:7',
    JSON.stringify({ ok: false, at: '2026-09-29T08:46:18.000Z', error: 'insufficient credits' }),
  );
  const failed = readLlmHealth(7);
  assert.equal(failed?.ok, false, '失败必须能被读出来 —— 否则界面上还是看不出模型不能用');
  assert.match(failed?.error ?? '', /insufficient credits/);

  settings.set(
    'llm_health:8',
    JSON.stringify({ ok: true, at: '2026-09-29T10:51:40.000Z', latencyMs: 2375 }),
  );
  const ok = readLlmHealth(8);
  assert.equal(ok?.ok, true);
  assert.equal(ok?.latencyMs, 2375);
});

test('★ 没有记录 = null；坏数据也只能当作没有记录，绝不抛错', () => {
  assert.equal(readLlmHealth(99), null, '没调用过就是 null，界面据此什么都不显示');

  /* 半截 JSON：可能是进程在写的时候被杀掉。 */
  settings.set('llm_health:9', '{ 坏掉的 JSON');
  assert.equal(readLlmHealth(9), null);

  /* 结构不对（缺 ok）：不能当成"失败"也不能当成"成功"。 */
  settings.set('llm_health:10', JSON.stringify({ at: '2026-01-01T00:00:00.000Z' }));
  assert.equal(readLlmHealth(10), null, '缺 ok 字段 → 当作没有记录');

  /* 它只是给界面看的 —— 无论如何不该让调用方炸。 */
  settings.set('llm_health:11', JSON.stringify({ ok: 'yes', at: 42 }));
  assert.equal(readLlmHealth(11), null);
});
