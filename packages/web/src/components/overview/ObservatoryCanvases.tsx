/**
 * 总览页 60fps 实时量化观测台 Canvas 视觉引擎集合（100% 真实数据驱动，零虚构数值）。
 *
 * 包含四套高性能 2D Canvas 实时渲染器：
 * 1. `HeatclockCanvas`       —— 24 小时量子热力精密表盘（映射真实周期、真实权益曲线与实时走时）；
 * 2. `MarketGalaxyCanvas`    —— 3D 旋转全市场 522 永续合约星云与 AI500 神经射线场；
 * 3. `NeuralPipelineCanvas`  —— 实盘量化信号神经管线流（行情 → AI500 → LLM 三段式 → 硬风控 → 执行器）；
 * 4. `QuantumRidgeCanvas`    —— 522 币种分层流动性 24h 收益分布霓虹脊线频谱（Tail Probability Ridge）。
 *
 * 性能与安全守则：
 * - 自动监听 `document.visibilitychange`，切出标签页立刻停帧零 CPU 占用；
 * - 自动尊重 `prefers-reduced-motion`（降至静态精绘一帧）；
 * - DPR 封顶 2，ResizeObserver 自适应容器宽度，卸载彻底清理 RAF 与监听器。
 */
import { useEffect, useRef } from 'react';
import type { DecisionRecord } from '@aq/shared';
import type { ManagedRadarItemView, MarketSymbol } from '../../lib/api';
import type { EquityPoint } from '../equityCurve';
import { fmtAsset, fmtPercent, fmtPriceUsd, fmtUsdSigned } from '../../lib/format';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function setupHiDpiCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
} | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/* ==========================================================================
 *  1. HEATCLOCK — 24 小时量子精密热力表盘
 * ========================================================================== */

export function HeatclockCanvas({
  accountEquity,
  realizedPnl,
  returnPct,
  winRatePct,
  wins,
  losses,
  curve,
  decisions,
  symbols,
  paperOnly,
}: {
  accountEquity: number;
  realizedPnl: number;
  returnPct: number;
  winRatePct: number | null;
  wins: number;
  losses: number;
  curve: EquityPoint[];
  decisions: DecisionRecord[];
  symbols: MarketSymbol[];
  paperOnly: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef({
    accountEquity,
    realizedPnl,
    returnPct,
    winRatePct,
    wins,
    losses,
    curve,
    decisions,
    symbols,
    paperOnly,
  });
  dataRef.current = {
    accountEquity,
    realizedPnl,
    returnPct,
    winRatePct,
    wins,
    losses,
    curve,
    decisions,
    symbols,
    paperOnly,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const reduced = prefersReducedMotion();

    // 预构建 96 个 15 分钟刻度槽（对应 24h）
    const draw = (ts: number) => {
      const setup = setupHiDpiCanvas(canvas);
      if (!setup) {
        if (!reduced) raf = requestAnimationFrame(draw);
        return;
      }
      const { ctx, w, h } = setup;
      const d = dataRef.current;
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) * 0.46;

      ctx.clearRect(0, 0, w, h);

      // 背景深邃微径向光晕
      const bgGrad = ctx.createRadialGradient(cx, cy, maxR * 0.1, cx, cy, maxR * 1.15);
      bgGrad.addColorStop(0, 'rgba(14, 203, 129, 0.08)');
      bgGrad.addColorStop(0.55, 'rgba(112, 96, 245, 0.04)');
      bgGrad.addColorStop(1, 'rgba(6, 8, 13, 0)');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // 统计 24h 内 96 个 15m 槽的真实活跃度（来自真实曲线快照 + 决策记录）
      const buckets = new Float32Array(96);
      const bucketSign = new Int8Array(96);
      for (const p of d.curve) {
        const dt = new Date(p.t);
        const slot = (dt.getHours() * 4 + Math.floor(dt.getMinutes() / 15)) % 96;
        buckets[slot] = Math.min(1, buckets[slot]! + 0.25);
      }
      for (const rec of d.decisions) {
        const dt = new Date(rec.timestamp);
        if (Number.isNaN(dt.getTime())) continue;
        const slot = (dt.getHours() * 4 + Math.floor(dt.getMinutes() / 15)) % 96;
        buckets[slot] = Math.min(1, buckets[slot]! + 0.55);
        const hasAction = rec.decisions.some(
          (x) => x.action !== 'wait' && x.action !== 'skip',
        );
        if (hasAction) bucketSign[slot] = 1;
      }

      const now = new Date();
      const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
      const nowAngle = (nowSec / 86400) * Math.PI * 2 - Math.PI / 2;

      // 1. 旋转扫描扇面尾迹（紧随当前实时时钟指针）
      const sweepSpan = 0.65;
      const steps = 26;
      for (let i = 0; i < steps; i++) {
        const a0 = nowAngle - (sweepSpan * (i + 1)) / steps;
        const a1 = nowAngle - (sweepSpan * i) / steps;
        const alpha = (1 - i / steps) * 0.16;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxR * 0.99, a0, a1);
        ctx.closePath();
        ctx.fillStyle = `rgba(14, 203, 129, ${alpha.toFixed(3)})`;
        ctx.fill();
      }

      // 2. 同心精密仪表环
      const rings = [0.98, 0.84, 0.68, 0.50];
      rings.forEach((ratio, idx) => {
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * ratio, 0, Math.PI * 2);
        ctx.strokeStyle = idx === 0 ? 'rgba(148, 163, 184, 0.16)' : 'rgba(148, 163, 184, 0.09)';
        ctx.lineWidth = idx === 3 ? 1.2 : 0.8;
        ctx.stroke();
      });

      // 3. 96 槽位全天候热力块（映射真实市场波动 + 真实周期活动）
      const symCount = d.symbols.length;
      for (let s = 0; s < 96; s++) {
        const angle = (s / 96) * Math.PI * 2 - Math.PI / 2;
        const inner = maxR * 0.69;
        // 若该时段有真实周期活动高亮，否则映射对应全市场合约的真实 24h 振幅做微光星点
        const sym = symCount > 0 ? d.symbols[s % symCount] : null;
        const symAmp = sym ? Math.min(1, Math.abs(sym.changePercent24h) / 14) : 0.12;
        const symUp = sym ? sym.changePercent24h >= 0 : true;
        const activity = Math.max(buckets[s]!, symAmp * 0.55);

        const segs = Math.max(1, Math.round(activity * 5));
        for (let k = 0; k < segs; k++) {
          const r0 = inner + k * (maxR * 0.027);
          const r1 = r0 + maxR * 0.019;
          ctx.beginPath();
          ctx.arc(cx, cy, (r0 + r1) / 2, angle - 0.02, angle + 0.02);
          ctx.lineWidth = maxR * 0.018;
          if (bucketSign[s] === 1) {
            ctx.strokeStyle = `rgba(14, 203, 129, ${0.42 + k * 0.12})`;
          } else if (buckets[s]! > 0.2) {
            ctx.strokeStyle = `rgba(245, 194, 231, ${0.28 + k * 0.11})`;
          } else {
            ctx.strokeStyle = symUp
              ? `rgba(14, 203, 129, ${0.14 + k * 0.07})`
              : `rgba(246, 70, 93, ${0.14 + k * 0.07})`;
          }
          ctx.stroke();
        }
      }

      // 4. 外环实时市场粒子星环（前 64 个真实币种的实时涨跌星尘）
      const pulsePhase = ts * 0.0005;
      const starCount = Math.min(64, d.symbols.length);
      for (let i = 0; i < starCount; i++) {
        const s = d.symbols[i]!;
        const a = (i / Math.max(1, starCount)) * Math.PI * 2 - Math.PI / 2 + pulsePhase * 0.12;
        const mag = Math.min(1, Math.abs(s.changePercent24h) / 25);
        const r = maxR * (0.86 + mag * 0.11);
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        const twinkle = 0.55 + 0.45 * Math.sin(ts * 0.004 + i * 1.7);
        ctx.beginPath();
        ctx.arc(px, py, 1.1 + mag * 1.4, 0, Math.PI * 2);
        ctx.fillStyle =
          s.changePercent24h >= 0
            ? `rgba(14, 203, 129, ${(0.35 + 0.55 * twinkle).toFixed(2)})`
            : `rgba(246, 70, 93, ${(0.35 + 0.55 * twinkle).toFixed(2)})`;
        ctx.fill();
      }

      // 5. 24 小时刻度数字（每 3 小时标一个：00 / 03 / 06 ... 21）
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
      for (let hr = 0; hr < 24; hr += 3) {
        const a = (hr / 24) * Math.PI * 2 - Math.PI / 2;
        const lx = cx + Math.cos(a) * (maxR * 0.59);
        const ly = cy + Math.sin(a) * (maxR * 0.59);
        ctx.fillText(String(hr).padStart(2, '0'), lx, ly);
      }

      // 6. 中心微型真实权益弧线（沿着内环画一圈真实走势）
      if (d.curve.length >= 2) {
        let minEq = Infinity;
        let maxEq = -Infinity;
        for (const pt of d.curve) {
          if (pt.equity < minEq) minEq = pt.equity;
          if (pt.equity > maxEq) maxEq = pt.equity;
        }
        const span = Math.max(0.01, maxEq - minEq);
        ctx.beginPath();
        const slice = d.curve.slice(-48);
        slice.forEach((pt, idx) => {
          const a = -Math.PI * 0.78 + (idx / Math.max(1, slice.length - 1)) * (Math.PI * 0.56);
          const norm = (pt.equity - minEq) / span;
          const rr = maxR * (0.37 + norm * 0.08);
          const x = cx + Math.cos(a) * rr;
          const y = cy + Math.sin(a) * rr;
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = d.realizedPnl >= 0 ? 'rgba(14, 203, 129, 0.85)' : 'rgba(246, 70, 93, 0.85)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      // 7. 激光时钟指针（精准指向当前时刻）
      const tipX = cx + Math.cos(nowAngle) * (maxR * 0.99);
      const tipY = cy + Math.sin(nowAngle) * (maxR * 0.99);
      const baseX = cx + Math.cos(nowAngle) * (maxR * 0.50);
      const baseY = cy + Math.sin(nowAngle) * (maxR * 0.50);
      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.88)';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(tipX, tipY, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#0ecb81';
      ctx.shadowColor = '#0ecb81';
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      // 8. 中心全息核心读数（全部真实数据）
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.78)';
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(d.paperOnly ? 'PAPER EQUITY' : 'LIVE ACCOUNT EQUITY', cx, cy - 26);

      ctx.fillStyle = '#f8fafc';
      ctx.font = '700 20px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(fmtAsset(d.accountEquity, 'USDT', 2).replace(' USDT', ''), cx, cy - 6);

      ctx.fillStyle = d.realizedPnl >= 0 ? '#0ecb81' : '#f6465d';
      ctx.font = '700 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`${fmtUsdSigned(d.realizedPnl, 2)} (${fmtPercent(d.returnPct)})`, cx, cy + 14);

      const clockStr = now.toLocaleTimeString('zh-CN', { hour12: false });
      ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
      ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const wrText = d.winRatePct !== null ? `WR ${d.winRatePct.toFixed(0)}% · ${d.wins}W/${d.losses}L` : clockStr;
      ctx.fillText(wrText, cx, cy + 31);

      if (!reduced && !document.hidden) {
        raf = requestAnimationFrame(draw);
      }
    };

    const onVis = () => {
      if (!document.hidden && !reduced) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" aria-label="24小时量子热力表盘" />;
}

/* ==========================================================================
 *  2. 3D MARKET GALAXY — 522 永续合约全市场 3D 旋转星云 + AI500 神经射线
 * ========================================================================== */

interface ProjectedNode {
  sym: MarketSymbol;
  sx: number;
  sy: number;
  depth: number;
  radius: number;
  radar: ManagedRadarItemView | null;
  isTopMover: boolean;
}

export function MarketGalaxyCanvas({
  symbols,
  radarItems,
}: {
  symbols: MarketSymbol[];
  radarItems: ManagedRadarItemView[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef({ symbols, radarItems });
  dataRef.current = { symbols, radarItems };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const reduced = prefersReducedMotion();

    // 确定性哈希用于给每个交易对分配稳定 Z 方位，避免数据刷新时粒子乱跳
    const hashOf = (s: string): number => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0) / 4294967295;
    };

    const draw = (ts: number) => {
      const setup = setupHiDpiCanvas(canvas);
      if (!setup) {
        if (!reduced) raf = requestAnimationFrame(draw);
        return;
      }
      const { ctx, w, h } = setup;
      const { symbols: syms, radarItems: radars } = dataRef.current;

      ctx.clearRect(0, 0, w, h);

      // 深空微光背景
      const cx = w * 0.5;
      const cy = h * 0.52;
      const nebula = ctx.createRadialGradient(cx, cy, 12, cx, cy, Math.max(w, h) * 0.58);
      nebula.addColorStop(0, 'rgba(112, 96, 245, 0.16)');
      nebula.addColorStop(0.42, 'rgba(14, 203, 129, 0.07)');
      nebula.addColorStop(1, 'rgba(7, 9, 14, 0)');
      ctx.fillStyle = nebula;
      ctx.fillRect(0, 0, w, h);

      // 3D 透视投影参数（缓慢自转）
      const yaw = reduced ? 0.55 : ts * 0.00022;
      const pitch = 0.44;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const fov = Math.min(w, h) * 1.15;
      const camZ = 3.25;

      const project = (x: number, y: number, z: number): { sx: number; sy: number; depth: number; scale: number } => {
        const rx = x * cosY - z * sinY;
        const rz = x * sinY + z * cosY;
        const ry = y * cosP - rz * sinP;
        const rz2 = y * sinP + rz * cosP;
        const depth = camZ + rz2;
        const scale = fov / Math.max(0.5, depth);
        return {
          sx: cx + rx * scale,
          sy: cy - ry * scale,
          depth,
          scale,
        };
      };

      // 1. 绘制 3D 底部透视全息坐标网格
      ctx.lineWidth = 0.7;
      const gridRange = 1.45;
      const gridY = -0.62;
      const gridLines = 8;
      for (let i = -gridLines; i <= gridLines; i++) {
        const t = (i / gridLines) * gridRange;
        const a1 = project(t, gridY, -gridRange);
        const a2 = project(t, gridY, gridRange);
        ctx.beginPath();
        ctx.moveTo(a1.sx, a1.sy);
        ctx.lineTo(a2.sx, a2.sy);
        ctx.strokeStyle = i === 0 ? 'rgba(112, 96, 245, 0.28)' : 'rgba(148, 163, 184, 0.08)';
        ctx.stroke();

        const b1 = project(-gridRange, gridY, t);
        const b2 = project(gridRange, gridY, t);
        ctx.beginPath();
        ctx.moveTo(b1.sx, b1.sy);
        ctx.lineTo(b2.sx, b2.sy);
        ctx.strokeStyle = i === 0 ? 'rgba(14, 203, 129, 0.24)' : 'rgba(148, 163, 184, 0.08)';
        ctx.stroke();
      }

      // 底部脉冲雷达同心波纹
      const waveR = ((ts * 0.00035) % 1) * gridRange;
      ctx.beginPath();
      for (let k = 0; k <= 48; k++) {
        const ang = (k / 48) * Math.PI * 2;
        const p = project(Math.cos(ang) * waveR, gridY, Math.sin(ang) * waveR);
        if (k === 0) ctx.moveTo(p.sx, p.sy);
        else ctx.lineTo(p.sx, p.sy);
      }
      ctx.strokeStyle = `rgba(14, 203, 129, ${(0.32 * (1 - waveR / gridRange)).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // 2. 构建雷达 Map 与领涨前排集合
      const radarMap = new Map<string, ManagedRadarItemView>();
      for (const r of radars) radarMap.set(r.symbol, r);

      const topMovers = new Set<string>();
      const sortedByAbs = [...syms]
        .filter((s) => s.quoteVolume24h >= 5_000_000)
        .sort((a, b) => Math.abs(b.changePercent24h) - Math.abs(a.changePercent24h));
      for (const m of sortedByAbs.slice(0, 4)) topMovers.add(m.symbol);
      topMovers.add('BTCUSDT');

      // 3. 投影全部 522 个真实永续合约到 3D 空间
      const corePt = project(0, 0.05, 0);
      const projected: ProjectedNode[] = [];
      for (let i = 0; i < syms.length; i++) {
        const sym = syms[i]!;
        const h1 = hashOf(sym.symbol);
        const h2 = hashOf(`${sym.symbol}:z`);
        // X/Z 按圆盘散开，极强动量向外圈跃迁；Y 按对数成交额悬浮高度
        const volLog = Math.log10(Math.max(10_000, sym.quoteVolume24h)); // ~4..10
        const yNorm = Math.max(-0.55, Math.min(0.88, ((volLog - 5.2) / 4.8) * 1.15 - 0.38));
        const pctClamped = Math.max(-35, Math.min(35, sym.changePercent24h));
        const radial = 0.24 + (Math.abs(pctClamped) / 35) * 1.02 + h1 * 0.22;
        const theta = h2 * Math.PI * 2 + (pctClamped >= 0 ? 0 : Math.PI * 0.25);
        const bob = reduced ? 0 : Math.sin(ts * 0.0018 + i * 0.9) * 0.025;
        const p = project(Math.cos(theta) * radial, yNorm + bob, Math.sin(theta) * radial);
        const radar = radarMap.get(sym.symbol) ?? null;
        const isTopMover = topMovers.has(sym.symbol);
        const baseRadius = radar ? 5.2 : isTopMover ? 4.1 : 1.5 + Math.max(0, (volLog - 5.5) * 0.55);
        projected.push({
          sym,
          sx: p.sx,
          sy: p.sy,
          depth: p.depth,
          radius: Math.max(1.2, baseRadius * (p.scale / (fov / camZ))),
          radar,
          isTopMover,
        });
      }

      // 深度排序（远→近）
      projected.sort((a, b) => b.depth - a.depth);

      // 4. 绘制中心 AI500 QUANT CORE 到重点目标的弯曲发光神经射线 + 流动光子
      const featured = projected.filter((n) => n.radar !== null || n.isTopMover).slice(0, 8);
      featured.forEach((node, idx) => {
        const midX = (corePt.sx + node.sx) / 2;
        const midY = Math.min(corePt.sy, node.sy) - 26 - (idx % 3) * 14;
        const isRadar = node.radar !== null;
        const isUp = node.sym.changePercent24h >= 0;
        const beamColor = isRadar
          ? 'rgba(245, 158, 11, 0.55)'
          : isUp
            ? 'rgba(14, 203, 129, 0.36)'
            : 'rgba(246, 70, 93, 0.36)';

        ctx.beginPath();
        ctx.moveTo(corePt.sx, corePt.sy);
        ctx.quadraticCurveTo(midX, midY, node.sx, node.sy);
        ctx.strokeStyle = beamColor;
        ctx.lineWidth = isRadar ? 1.5 : 1.0;
        ctx.stroke();

        // 沿贝塞尔曲线奔跑的高能光点
        const t = ((ts * 0.00055 + idx * 0.21) % 1);
        const inv = 1 - t;
        const bx = inv * inv * corePt.sx + 2 * inv * t * midX + t * t * node.sx;
        const by = inv * inv * corePt.sy + 2 * inv * t * midY + t * t * node.sy;
        ctx.beginPath();
        ctx.arc(bx, by, isRadar ? 2.6 : 2.0, 0, Math.PI * 2);
        ctx.fillStyle = isRadar ? '#fbbf24' : isUp ? '#34d399' : '#fb7185';
        ctx.shadowColor = isRadar ? '#fbbf24' : isUp ? '#0ecb81' : '#f6465d';
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
      });

      // 5. 绘制 522 个真实合约光球
      for (const node of projected) {
        const up = node.sym.changePercent24h >= 0;
        const isHot = node.radar !== null || node.isTopMover;
        const depthFade = Math.max(0.28, Math.min(1, 1.35 - (node.depth - 1.5) * 0.22));

        if (isHot) {
          // 发光外晕
          const halo = ctx.createRadialGradient(node.sx, node.sy, 0.5, node.sx, node.sy, node.radius * 3.4);
          if (node.radar) {
            halo.addColorStop(0, 'rgba(251, 191, 36, 0.72)');
            halo.addColorStop(0.5, 'rgba(251, 191, 36, 0.18)');
            halo.addColorStop(1, 'rgba(251, 191, 36, 0)');
          } else if (up) {
            halo.addColorStop(0, 'rgba(14, 203, 129, 0.65)');
            halo.addColorStop(0.5, 'rgba(14, 203, 129, 0.14)');
            halo.addColorStop(1, 'rgba(14, 203, 129, 0)');
          } else {
            halo.addColorStop(0, 'rgba(246, 70, 93, 0.65)');
            halo.addColorStop(0.5, 'rgba(246, 70, 93, 0.14)');
            halo.addColorStop(1, 'rgba(246, 70, 93, 0)');
          }
          ctx.beginPath();
          ctx.arc(node.sx, node.sy, node.radius * 3.4, 0, Math.PI * 2);
          ctx.fillStyle = halo;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(node.sx, node.sy, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = node.radar
          ? '#fde68a'
          : up
            ? `rgba(14, 203, 129, ${(0.78 * depthFade).toFixed(2)})`
            : `rgba(246, 70, 93, ${(0.78 * depthFade).toFixed(2)})`;
        ctx.fill();
      }

      // 6. 中心 AI500 QUANT CORE 能量球
      const corePulse = 1 + 0.14 * Math.sin(ts * 0.004);
      const coreGlow = ctx.createRadialGradient(corePt.sx, corePt.sy, 2, corePt.sx, corePt.sy, 26 * corePulse);
      coreGlow.addColorStop(0, 'rgba(167, 139, 250, 0.95)');
      coreGlow.addColorStop(0.35, 'rgba(112, 96, 245, 0.45)');
      coreGlow.addColorStop(1, 'rgba(112, 96, 245, 0)');
      ctx.beginPath();
      ctx.arc(corePt.sx, corePt.sy, 26 * corePulse, 0, Math.PI * 2);
      ctx.fillStyle = coreGlow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(corePt.sx, corePt.sy, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(corePt.sx, corePt.sy, 13 * corePulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(167, 139, 250, 0.7)';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(226, 232, 240, 0.92)';
      ctx.fillText('AI500 CORE', corePt.sx, corePt.sy + 23);

      // 7. 为前 6 个重点节点（AI500 雷达 + BTC + 暴涨龙头）绘制防碰撞全息浮标标签
      const placedBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      for (const node of featured.slice(0, 6)) {
        const label = node.radar
          ? `${node.sym.baseAsset} ${Math.round(node.radar.score)}分 ${fmtPercent(node.sym.changePercent24h)}`
          : node.sym.symbol === 'BTCUSDT'
            ? `BTC ${fmtPriceUsd(node.sym.price)} ${fmtPercent(node.sym.changePercent24h)}`
            : `${node.sym.baseAsset} ${fmtPercent(node.sym.changePercent24h)}`;
        const tw = ctx.measureText(label).width + 12;
        const th = 18;
        let bx = Math.min(w - tw - 8, Math.max(8, node.sx + 9));
        let by = Math.min(h - th - 8, Math.max(10, node.sy - 9));

        // 迭代避让，防止高密度区全息标签擦碰
        for (let pass = 0; pass < 3; pass++) {
          for (const b of placedBoxes) {
            if (bx < b.x + b.w + 6 && bx + tw + 6 > b.x && by < b.y + b.h + 5 && by + th + 5 > b.y) {
              const tryDown = b.y + b.h + 6;
              const tryUp = b.y - th - 6;
              if (tryDown + th < h - 34) by = tryDown;
              else if (tryUp > 10) by = tryUp;
              else bx = Math.min(w - tw - 8, b.x + b.w + 8);
            }
          }
        }
        placedBoxes.push({ x: bx, y: by, w: tw, h: th });

        ctx.fillStyle = 'rgba(10, 13, 22, 0.84)';
        ctx.strokeStyle = node.radar
          ? 'rgba(251, 191, 36, 0.65)'
          : node.sym.changePercent24h >= 0
            ? 'rgba(14, 203, 129, 0.55)'
            : 'rgba(246, 70, 93, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(bx, by, tw, th, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = node.radar
          ? '#fde68a'
          : node.sym.changePercent24h >= 0
            ? '#6ee7b7'
            : '#fda4af';
        ctx.fillText(label, bx + 6, by + th / 2 + 0.5);
      }

      if (!reduced && !document.hidden) {
        raf = requestAnimationFrame(draw);
      }
    };

    const onVis = () => {
      if (!document.hidden && !reduced) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" aria-label="3D 全市场522合约星云雷达" />;
}

/* ==========================================================================
 *  3. NEURAL PIPELINE — Grok-Bot 风格实时信号神经网络流图
 * ========================================================================== */

export function NeuralPipelineCanvas({
  symbols,
  totalSymbols,
  radarItems,
  runningCount,
  latestCycle,
  openPositions,
}: {
  symbols: MarketSymbol[];
  totalSymbols: number;
  radarItems: ManagedRadarItemView[];
  runningCount: number;
  latestCycle: number | null;
  openPositions: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef({ symbols, totalSymbols, radarItems, runningCount, latestCycle, openPositions });
  dataRef.current = { symbols, totalSymbols, radarItems, runningCount, latestCycle, openPositions };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const reduced = prefersReducedMotion();

    const draw = (ts: number) => {
      const setup = setupHiDpiCanvas(canvas);
      if (!setup) {
        if (!reduced) raf = requestAnimationFrame(draw);
        return;
      }
      const { ctx, w, h } = setup;
      const d = dataRef.current;

      ctx.clearRect(0, 0, w, h);

      // 左侧 4 个真实行情输入源
      const inputs = d.symbols.slice(0, 4);
      const leftX = Math.max(82, w * 0.14);
      const centerX = w * 0.5;
      const rightX = Math.min(w - 92, w * 0.84);
      const midY = h * 0.5;

      const rightNodes = [
        { title: 'AI500 六维引擎', sub: `${d.radarItems.length} 焦点标的`, color: '#38bdf8' },
        { title: 'LLM 三段式大脑', sub: d.latestCycle ? `周期 #${d.latestCycle}` : '待命', color: '#a78bfa' },
        { title: '硬风控闸门', sub: `持仓 ${d.openPositions} · 强校验`, color: '#fbbf24' },
        { title: '交易所执行器', sub: d.runningCount > 0 ? '实盘在线' : '待机', color: '#0ecb81' },
      ];

      const rowY = (idx: number, total: number) => h * 0.18 + (idx / Math.max(1, total - 1)) * (h * 0.64);

      // 连线：左 → 中心核
      inputs.forEach((sym, i) => {
        const y = rowY(i, 4);
        const up = sym.changePercent24h >= 0;
        const c1x = leftX + (centerX - leftX) * 0.5;
        ctx.beginPath();
        ctx.moveTo(leftX + 58, y);
        ctx.bezierCurveTo(c1x, y, c1x, midY, centerX - 34, midY);
        ctx.strokeStyle = up ? 'rgba(14, 203, 129, 0.35)' : 'rgba(246, 70, 93, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // 流动能量脉冲粒子
        const t = ((ts * 0.00065 + i * 0.25) % 1);
        const inv = 1 - t;
        const px =
          inv * inv * inv * (leftX + 58) +
          3 * inv * inv * t * c1x +
          3 * inv * t * t * c1x +
          t * t * t * (centerX - 34);
        const py =
          inv * inv * inv * y +
          3 * inv * inv * t * y +
          3 * inv * t * t * midY +
          t * t * t * midY;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = up ? '#0ecb81' : '#f6465d';
        ctx.shadowColor = up ? '#0ecb81' : '#f6465d';
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;

        // 左侧输入卡片
        ctx.fillStyle = 'rgba(15, 20, 32, 0.9)';
        ctx.strokeStyle = up ? 'rgba(14, 203, 129, 0.4)' : 'rgba(246, 70, 93, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(leftX - 58, y - 20, 116, 40, 8);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(sym.baseAsset, leftX - 48, y - 5);
        ctx.fillStyle = up ? '#34d399' : '#fb7185';
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`${fmtPriceUsd(sym.price)}`, leftX - 48, y + 10);
        ctx.textAlign = 'right';
        ctx.fillText(fmtPercent(sym.changePercent24h), leftX + 50, y - 5);
      });

      // 连线：中心核 → 右侧 4 个真实引擎子系统
      rightNodes.forEach((rn, i) => {
        const y = rowY(i, 4);
        const c2x = centerX + (rightX - centerX) * 0.5;
        ctx.beginPath();
        ctx.moveTo(centerX + 34, midY);
        ctx.bezierCurveTo(c2x, midY, c2x, y, rightX - 68, y);
        ctx.strokeStyle = `${rn.color}55`;
        ctx.lineWidth = 1.6;
        ctx.stroke();

        const t = ((ts * 0.00058 + i * 0.23 + 0.12) % 1);
        const inv = 1 - t;
        const px =
          inv * inv * inv * (centerX + 34) +
          3 * inv * inv * t * c2x +
          3 * inv * t * t * c2x +
          t * t * t * (rightX - 68);
        const py =
          inv * inv * inv * midY +
          3 * inv * inv * t * midY +
          3 * inv * t * t * y +
          t * t * t * y;
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = rn.color;
        ctx.shadowColor = rn.color;
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = 'rgba(15, 20, 32, 0.92)';
        ctx.strokeStyle = `${rn.color}66`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(rightX - 68, y - 20, 136, 40, 8);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 11px system-ui, -apple-system, sans-serif';
        ctx.fillText(rn.title, rightX - 58, y - 4);
        ctx.fillStyle = rn.color;
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(rn.sub, rightX - 58, y + 11);
      });

      // 中央 AUTOQUANT 神经枢纽
      const pulse = 1 + 0.12 * Math.sin(ts * 0.0045);
      const glow = ctx.createRadialGradient(centerX, midY, 6, centerX, midY, 54 * pulse);
      glow.addColorStop(0, 'rgba(112, 96, 245, 0.65)');
      glow.addColorStop(0.55, 'rgba(14, 203, 129, 0.18)');
      glow.addColorStop(1, 'rgba(112, 96, 245, 0)');
      ctx.beginPath();
      ctx.arc(centerX, midY, 54 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(centerX, midY, 34, 0, Math.PI * 2);
      ctx.fillStyle = '#0f1322';
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('AI CORE', centerX, midY - 4);
      ctx.fillStyle = '#0ecb81';
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`${d.totalSymbols || d.symbols.length} MKTS`, centerX, midY + 11);

      if (!reduced && !document.hidden) {
        raf = requestAnimationFrame(draw);
      }
    };

    const onVis = () => {
      if (!document.hidden && !reduced) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" aria-label="实时量化信号神经网络流" />;
}

/* ==========================================================================
 *  4. QUANTUM RIDGE — 522 币种分层流动性 24h 收益密度霓虹脊线频谱
 * ========================================================================== */

export function QuantumRidgeCanvas({ symbols }: { symbols: MarketSymbol[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const symRef = useRef(symbols);
  symRef.current = symbols;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const reduced = prefersReducedMotion();

    const draw = (ts: number) => {
      const setup = setupHiDpiCanvas(canvas);
      if (!setup) {
        if (!reduced) raf = requestAnimationFrame(draw);
        return;
      }
      const { ctx, w, h } = setup;
      const syms = symRef.current;
      ctx.clearRect(0, 0, w, h);

      // 按真实 24h 成交额把 522 币种切分为 7 层（蓝筹 → 中盘 → 小盘），计算每层在 [-16%, +16%] 的真实收益密度脊线
      const layers = 7;
      const bins = 40;
      const sorted = [...syms].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
      const chunkSize = Math.max(1, Math.ceil(sorted.length / layers));

      const padX = 18;
      const plotW = w - padX * 2;
      const topY = 26;
      const botY = h - 22;

      // 0% 中轴参考虚线
      const zeroX = padX + plotW * 0.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(zeroX, 10);
      ctx.lineTo(zeroX, botY);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      for (let l = 0; l < layers; l++) {
        const slice = sorted.slice(l * chunkSize, (l + 1) * chunkSize);
        const hist = new Float32Array(bins);
        for (const s of slice) {
          const clamped = Math.max(-16, Math.min(16, s.changePercent24h));
          const b = Math.min(bins - 1, Math.max(0, Math.floor(((clamped + 16) / 32) * bins)));
          // 轻微高斯核平滑，保留真实多峰形状
          for (let k = -2; k <= 2; k++) {
            const idx = b + k;
            if (idx >= 0 && idx < bins) {
              const weight = k === 0 ? 1 : Math.abs(k) === 1 ? 0.55 : 0.2;
              hist[idx] = hist[idx]! + weight;
            }
          }
        }
        let maxVal = 0.01;
        for (let b = 0; b < bins; b++) {
          if (hist[b]! > maxVal) maxVal = hist[b]!;
        }

        const baseY = topY + (l / Math.max(1, layers - 1)) * (botY - topY);
        const amp = (botY - topY) * 0.34;
        const breathe = reduced ? 1 : 0.92 + 0.08 * Math.sin(ts * 0.0022 + l * 0.85);

        ctx.beginPath();
        ctx.moveTo(padX, baseY);
        for (let b = 0; b < bins; b++) {
          const x = padX + (b / (bins - 1)) * plotW;
          const shimmer = reduced ? 0 : Math.sin(ts * 0.003 + b * 0.35 + l) * 1.4;
          const val = (hist[b]! / maxVal) * amp * breathe;
          const y = baseY - val + shimmer * (val > 2 ? 1 : 0.2);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(padX + plotW, baseY);
        ctx.closePath();

        // 填充深邃紫色/青色霓虹渐变
        const fillGrad = ctx.createLinearGradient(padX, baseY - amp, padX + plotW, baseY);
        fillGrad.addColorStop(0, 'rgba(246, 70, 93, 0.26)');
        fillGrad.addColorStop(0.45, 'rgba(139, 92, 246, 0.34)');
        fillGrad.addColorStop(0.75, 'rgba(56, 189, 248, 0.26)');
        fillGrad.addColorStop(1, 'rgba(14, 203, 129, 0.34)');
        ctx.fillStyle = fillGrad;
        ctx.fill();

        // 发光霓虹脊线描边
        const strokeGrad = ctx.createLinearGradient(padX, baseY, padX + plotW, baseY);
        strokeGrad.addColorStop(0, 'rgba(246, 70, 93, 0.72)');
        strokeGrad.addColorStop(0.45, 'rgba(167, 139, 250, 0.92)');
        strokeGrad.addColorStop(0.78, 'rgba(56, 189, 248, 0.82)');
        strokeGrad.addColorStop(1, 'rgba(14, 203, 129, 0.92)');
        ctx.strokeStyle = strokeGrad;
        ctx.lineWidth = l === layers - 1 ? 1.8 : 1.15;
        ctx.stroke();
      }

      // 横轴真实刻度标签
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
      ctx.textAlign = 'left';
      ctx.fillText('-16% 左尾', padX, h - 6);
      ctx.textAlign = 'center';
      ctx.fillText('0% 平衡轴', zeroX, h - 6);
      ctx.textAlign = 'right';
      ctx.fillText('+16% 暴涨右尾', padX + plotW, h - 6);

      if (!reduced && !document.hidden) {
        raf = requestAnimationFrame(draw);
      }
    };

    const onVis = () => {
      if (!document.hidden && !reduced) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={canvasRef} className="block h-full w-full" aria-label="全市场522币种收益密度霓虹脊线图" />;
}
