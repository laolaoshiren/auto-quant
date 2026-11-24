/**
 * 最新 AI500 雷达快照持久化（`packages/server/src/managed/radarStore.ts`）
 *
 * 将每台 `ai_managed` 机器人最新一轮扫描出的 AI500 Top 10、筹码结构摘要与 15m Δ 落盘至
 * `managed_radar_latest`，供 `/api/traders/:id/managed-intel` 与前端详情页零解析成本直接读取。
 */

import { getDb } from '../db/index.js';
import type { Ai500Candidate } from '../radar/ai500.js';
import type { DeltaMomentumState } from '../radar/deltaTracker.js';

export interface PersistedRadarItem {
  symbol: string;
  score: number;
  tier: Ai500Candidate['tier'];
  bias: Ai500Candidate['bias'];
  price: number;
  change4hPct: number;
  dimensions: Ai500Candidate['dimensions'];
  tags: string[];
  vpSummary: string | null;
  deltaState: DeltaMomentumState | null;
  scoreDelta: number | null;
}

export interface PersistedRadarSnapshot {
  traderId: number;
  updatedAt: string;
  btcBenchmark: string | null;
  summary: string;
  items: PersistedRadarItem[];
}

interface RadarLatestRow {
  trader_id: number;
  updated_at: string;
  btc_benchmark: string | null;
  summary: string;
  items_json: string;
}

export const managedRadarStore = {
  save(input: {
    traderId: number;
    btcBenchmark: string | null;
    summary: string;
    items: readonly PersistedRadarItem[];
    nowMs?: number;
  }): void {
    const db = getDb();
    const updatedAt = new Date(input.nowMs ?? Date.now()).toISOString();
    db.run(
      `INSERT INTO managed_radar_latest (trader_id, updated_at, btc_benchmark, summary, items_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(trader_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         btc_benchmark = excluded.btc_benchmark,
         summary = excluded.summary,
         items_json = excluded.items_json`,
      input.traderId,
      updatedAt,
      input.btcBenchmark,
      input.summary,
      JSON.stringify(input.items.slice(0, 10)),
    );
  },

  get(traderId: number): PersistedRadarSnapshot | null {
    const db = getDb();
    const row = db.get<RadarLatestRow>(
      `SELECT * FROM managed_radar_latest WHERE trader_id = ?`,
      traderId,
    );
    if (!row) return null;
    let items: PersistedRadarItem[] = [];
    try {
      const parsed = JSON.parse(row.items_json);
      if (Array.isArray(parsed)) items = parsed as PersistedRadarItem[];
    } catch {
      items = [];
    }
    return {
      traderId: row.trader_id,
      updatedAt: row.updated_at,
      btcBenchmark: row.btc_benchmark,
      summary: row.summary,
      items,
    };
  },
};
