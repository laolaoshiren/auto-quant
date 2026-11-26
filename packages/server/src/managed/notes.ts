/**
 * M3.3 反例衰减笔记（`packages/server/src/managed/notes.ts`）
 *
 * 升级跨轮记忆，解决传统自由文本记忆“只写不删、越写越虚、屡错不改”的三大顽疾：
 *   1. **按标的唯一替换语义**：同一标的（`trader_id + symbol`）永远只保留最新一条聚焦笔记，不无限堆积；
 *   2. **强制可验证触发条件**：必须包含具体价位/百分比/量比/指标数字条件，拒绝“谨慎观望/多看少动”类空话；
 *   3. **反例计数与权重衰减**：被市场证伪时累加 `counterexamples`，有效权重按 `1 / (1 + counterexamples)` 衰减，
 *      达 3 次反例自动淘汰退休；
 *   4. **双保险自动过期**：创建/刷新后 7 天自动过期，且若标的离开雷达候选池超过 24 小时自动退休清理。
 */

import { normalizeSymbol } from '@aq/shared';

import { getDb } from '../db/index.js';
import type { RadarBias } from '../radar/ai500.js';

/* -------------------------------------------------------------------------- */
/*  Constants & Public Types                                                   */
/* -------------------------------------------------------------------------- */

export const NOTE_DEFAULT_TTL_MS = 7 * 24 * 3600_000; // 7 天自动过期
export const NOTE_OUT_OF_POOL_TTL_MS = 24 * 3600_000; // 标的离池 24h 后自动退休
export const NOTE_MAX_COUNTEREXAMPLES = 3; // ≥ 3 次反例自动退休

export interface ManagedNote {
  id: number;
  traderId: number;
  symbol: string;
  note: string;
  triggerCondition: string;
  bias: RadarBias;
  confidence: number;
  counterexamples: number;
  /** 有效权重（0–1）：`1 / (1 + counterexamples)`，越低排越靠后。 */
  effectiveWeight: number;
  lastSeenInPoolAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertNoteInput {
  traderId: number;
  symbol: string;
  note: string;
  triggerCondition: string;
  bias?: RadarBias;
  confidence?: number;
  /** 可选直接覆盖或保留反例计数（默认新写替换笔记时归零，除非显式传值）。 */
  counterexamples?: number;
  nowMs?: number;
}

/* -------------------------------------------------------------------------- */
/*  Pure Validation & Weight Helpers                                           */
/* -------------------------------------------------------------------------- */

/**
 * 校验触发条件是否“可验证”：
 * 必须包含至少一个具体数字（价位 / 百分比 / 量比 / ATR / RSI / 评分等），
 * 或明确的结构锚点词 + 数值，拒绝纯主观空话（如“等合适时机”“谨慎做多”）。
 */
export function hasVerifiableTrigger(triggerCondition: string): boolean {
  const cleaned = triggerCondition.trim();
  if (cleaned.length < 4) return false;
  // 必须至少包含一个数字（具体价位、% 涨幅、量比倍数、ATR 倍数、费率或时间周期数字）
  return /\d/.test(cleaned);
}

/** 计算反例衰减权重：0→1.00, 1→0.50, 2→0.33, ≥3→0（自动退休）。 */
export function noteEffectiveWeight(counterexamples: number): number {
  if (!Number.isFinite(counterexamples) || counterexamples < 0) return 1;
  if (counterexamples >= NOTE_MAX_COUNTEREXAMPLES) return 0;
  return Math.round((1 / (1 + counterexamples)) * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/*  SQLite Repository                                                          */
/* -------------------------------------------------------------------------- */

interface NoteRow {
  id: number;
  trader_id: number;
  symbol: string;
  note: string;
  trigger_condition: string;
  bias: string;
  confidence: number;
  counterexamples: number;
  last_seen_in_pool_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function toNote(row: NoteRow): ManagedNote {
  return {
    id: row.id,
    traderId: row.trader_id,
    symbol: row.symbol,
    note: row.note,
    triggerCondition: row.trigger_condition,
    bias: row.bias === 'long' || row.bias === 'short' ? row.bias : 'neutral',
    confidence: row.confidence,
    counterexamples: row.counterexamples,
    effectiveWeight: noteEffectiveWeight(row.counterexamples),
    lastSeenInPoolAt: row.last_seen_in_pool_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const managedNotesStore = {
  /**
   * 写入或按标的替换一条观察笔记。
   * 强制校验 `triggerCondition` 必须可验证，否则返回 `{ ok: false, reason }` 不落库。
   */
  upsertNote(input: UpsertNoteInput): { ok: true; note: ManagedNote } | { ok: false; reason: string } {
    const norm = normalizeSymbol(input.symbol);
    if (!norm) return { ok: false, reason: '标的名称无效。' };
    const cleanNote = input.note.replace(/\s+/g, ' ').trim().slice(0, 240);
    let rawTrigger = input.triggerCondition.replace(/\s+/g, ' ').trim();
    // 剥离模型偶发误抄的提示词展示前缀 `触发[...]`，避免渲染成 `触发[触发[...]]`
    while (/^触发\[.*\]$/.test(rawTrigger)) {
      rawTrigger = rawTrigger.slice(3, -1).trim();
    }
    const cleanTrigger = rawTrigger.slice(0, 160);
    if (cleanNote.length < 4) return { ok: false, reason: '笔记正文过短，请写清关键结构判断。' };
    if (!hasVerifiableTrigger(cleanTrigger)) {
      return {
        ok: false,
        reason: '触发条件必须包含可验证的数字价位/量比/费率/指标（如“放量突破 152.4 且量比>1.8x”），拒绝空泛口号。',
      };
    }

    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + NOTE_DEFAULT_TTL_MS).toISOString();
    const bias: RadarBias = input.bias ?? 'neutral';
    const confidence = Math.max(0, Math.min(100, Math.round(input.confidence ?? 70)));
    const hasExplicitCounterexamples = input.counterexamples !== undefined;
    const counterexamples = Math.max(0, Math.round(input.counterexamples ?? 0));

    const db = getDb();
    db.run(
      `INSERT INTO managed_notes (
        trader_id, symbol, note, trigger_condition, bias, confidence,
        counterexamples, last_seen_in_pool_at, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trader_id, symbol) DO UPDATE SET
        note = excluded.note,
        trigger_condition = excluded.trigger_condition,
        bias = excluded.bias,
        confidence = excluded.confidence,
        counterexamples = CASE WHEN ? = 1 THEN excluded.counterexamples ELSE managed_notes.counterexamples END,
        last_seen_in_pool_at = excluded.last_seen_in_pool_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
      input.traderId,
      norm,
      cleanNote,
      cleanTrigger,
      bias,
      confidence,
      counterexamples,
      nowIso,
      expiresIso,
      nowIso,
      nowIso,
      hasExplicitCounterexamples ? 1 : 0,
    );

    const saved = db.get<NoteRow>(
      `SELECT * FROM managed_notes WHERE trader_id = ? AND symbol = ?`,
      input.traderId,
      norm,
    )!;
    return { ok: true, note: toNote(saved) };
  },

  /**
   * 为某标的记录一次反例（假设被证伪）：
   *   - `counterexamples + 1`
   *   - 若达到 `NOTE_MAX_COUNTEREXAMPLES`（3 次），自动删除退休并返回 `{ retired: true }`。
   */
  recordCounterexample(
    traderId: number,
    symbol: string,
    reason?: string,
    nowMs = Date.now(),
  ): { found: boolean; retired: boolean; counterexamples: number } {
    const norm = normalizeSymbol(symbol);
    const db = getDb();
    const existing = db.get<NoteRow>(
      `SELECT * FROM managed_notes WHERE trader_id = ? AND symbol = ?`,
      traderId,
      norm,
    );
    if (!existing) return { found: false, retired: false, counterexamples: 0 };

    const nextCount = existing.counterexamples + 1;
    if (nextCount >= NOTE_MAX_COUNTEREXAMPLES) {
      db.run(`DELETE FROM managed_notes WHERE id = ?`, existing.id);
      return { found: true, retired: true, counterexamples: nextCount };
    }

    const suffix = reason ? ` [反例#${nextCount}: ${reason.replace(/\s+/g, ' ').trim().slice(0, 60)}]` : '';
    const updatedNote = `${existing.note}${suffix}`.slice(0, 240);
    db.run(
      `UPDATE managed_notes SET counterexamples = ?, note = ?, updated_at = ? WHERE id = ?`,
      nextCount,
      updatedNote,
      new Date(nowMs).toISOString(),
      existing.id,
    );
    return { found: true, retired: false, counterexamples: nextCount };
  },

  /** 删除指定标的笔记。 */
  deleteNote(traderId: number, symbol: string): boolean {
    const norm = normalizeSymbol(symbol);
    const db = getDb();
    const res = db.run(`DELETE FROM managed_notes WHERE trader_id = ? AND symbol = ?`, traderId, norm);
    return Number(res.changes) > 0;
  },

  /**
   * 刷新当前在池标的的 `last_seen_in_pool_at`，并自动退休：
   *   1) 已超过 7 天过期时间（`expires_at <= now`）的笔记；
   *   2) 离开雷达池超过 24 小时（`last_seen_in_pool_at <= now - 24h`）且不在当前持仓中的笔记；
   *   3) 反例计数 ≥ 3 的笔记。
   */
  syncPoolAndPrune(
    traderId: number,
    activePoolSymbols: ReadonlySet<string>,
    nowMs = Date.now(),
  ): { pruned: number } {
    const db = getDb();
    const nowIso = new Date(nowMs).toISOString();
    const outOfPoolCutoff = new Date(nowMs - NOTE_OUT_OF_POOL_TTL_MS).toISOString();

    for (const sym of activePoolSymbols) {
      db.run(
        `UPDATE managed_notes SET last_seen_in_pool_at = ? WHERE trader_id = ? AND symbol = ?`,
        nowIso,
        traderId,
        normalizeSymbol(sym),
      );
    }

    const res = db.run(
      `DELETE FROM managed_notes
       WHERE trader_id = ?
         AND (expires_at <= ? OR last_seen_in_pool_at <= ? OR counterexamples >= ?)`,
      traderId,
      nowIso,
      outOfPoolCutoff,
      NOTE_MAX_COUNTEREXAMPLES,
    );
    return { pruned: Number(res.changes) };
  },

  /** 列出机器人全部有效笔记（按反例权重降序、更新时间降序）。 */
  listActive(traderId: number, nowMs = Date.now(), limit = 10): ManagedNote[] {
    const db = getDb();
    const nowIso = new Date(nowMs).toISOString();
    const rows = db.all<NoteRow>(
      `SELECT * FROM managed_notes
       WHERE trader_id = ? AND expires_at > ? AND counterexamples < ?
       ORDER BY counterexamples ASC, updated_at DESC
       LIMIT ?`,
      traderId,
      nowIso,
      NOTE_MAX_COUNTEREXAMPLES,
      limit,
    );
    return rows.map(toNote);
  },
};

/**
 * 格式化活跃观察笔记为简洁 Markdown 区块，供 `managed/prompt.ts` 使用。
 */
export function formatManagedNotesSection(notes: readonly ManagedNote[]): string {
  if (notes.length === 0) return '';
  const rows = notes.slice(0, 6).map((n) => {
    const biasCn = n.bias === 'long' ? '偏多' : n.bias === 'short' ? '偏空' : '中性';
    const weightPct = Math.round(n.effectiveWeight * 100);
    const ceTag = n.counterexamples > 0 ? ` · ⚠️反例${n.counterexamples}次(权重${weightPct}%)` : '';
    return `- **${n.symbol}**(${biasCn}${ceTag})：触发[${n.triggerCondition}] | ${n.note}`;
  });
  return `# 跨轮观察笔记（按标的替换 · 反例自动衰减）\n${rows.join('\n')}`;
}
