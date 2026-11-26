/**
 * 总览页 60fps 全中文量化观测台 Canvas 视觉引擎集合（100% 真实数据驱动，零虚构数值）。
 *
 * 四套高性能 2D Canvas 实时渲染器：
 * 1. `HeatclockCanvas`       —— 24 小时量子精密表盘（映射真实周期、真实权益曲线与实时走时）；
 * 2. `PolarAlphaRadarCanvas` —— 全市场 522 永续 360° 极坐标态势雷达（4 象限清晰语义 + 旋转余辉扫描束 +
 *                               外围固定锚位全息标注与折线引线，彻底杜绝杂乱堆叠与文字遮挡）；
 * 3. `NeuralPipelineCanvas`  —— 实盘量化信号神经网络流图（实时行情 → AI 核心中枢 → 四大引擎子系统）；
 * 4. `QuantumRidgeCanvas`    —— 522 币种分层流动性 24h 收益密度霓虹脊线频谱。
 *
 * 深/浅双主题适配：订阅 `APPEARANCE_EVENT` 与 `html[data-skin]` 变化，实时切换高对比度双色板。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { DecisionRecord } from '@aq/shared';
import type { ManagedRadarItemView, MarketSymbol } from '../../lib/api';
import type { EquityPoint } from '../equityCurve';
import { fmtAsset, fmtPercent, fmtPriceUsd, fmtUsdSigned } from '../../lib/format';
import { APPEARANCE_EVENT } from '../../templates/lib/appearance';

function getIsLightSkin(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.skin === 'light';
}

function subscribeSkin(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const handler = () => onChange();
  window.addEventListener(APPEARANCE_EVENT, handler);
  const observer = new MutationObserver(handler);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] });
  return () => {
    window.removeEventListener(APPEARANCE_EVENT, handler);
    observer.disconnect();
  };
}

/** 响应式读取当前是否为浅色主题，切换外观时自动触发重绘/重渲染。 */
export function useIsLightSkin(): boolean {
  return useSyncExternalStore(subscribeSkin, getIsLightSkin, () => false);
}

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

function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/* ==========================================================================
 *  1. 24 小时量子精密表盘（全中文中心全息读数）
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
  const isLight = useIsLightSkin();
  const lightRef = useRef(isLight);
  lightRef.current = isLight;
  const redrawRef = useRef<(() => void) | null>(null);

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

    const draw = (ts: number) => {
      const setup = setupHiDpiCanvas(canvas);
      if (!setup) {
        if (!reduced) raf = requestAnimationFrame(draw);
        return;
      }
      const { ctx, w, h } = setup;
      const d = dataRef.current;
      const light = lightRef.current;
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) * 0.45;

      ctx.clearRect(0, 0, w, h);

      const bgGrad = ctx.createRadialGradient(cx, cy, maxR * 0.08, cx, cy, maxR * 1.15);
      if (light) {
        bgGrad.addColorStop(0, 'rgba(5, 150, 105, 0.09)');
        bgGrad.addColorStop(0.55, 'rgba(79, 70, 229, 0.05)');
        bgGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      } else {
        bgGrad.addColorStop(0, 'rgba(14, 203, 129, 0.10)');
        bgGrad.addColorStop(0.55, 'rgba(112, 96, 245, 0.05)');
        bgGrad.addColorStop(1, 'rgba(6, 8, 13, 0)');
      }
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

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
        if (rec.decisions.some((x) => x.action !== 'wait' && x.action !== 'skip')) {
          bucketSign[slot] = 1;
        }
      }

      const now = new Date();
      const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
      const nowAngle = (nowSec / 86400) * Math.PI * 2 - Math.PI / 2;

      // 旋转激光尾迹
      const sweepSpan = 0.68;
      const steps = 24;
      for (let i = 0; i < steps; i++) {
        const a0 = nowAngle - (sweepSpan * (i + 1)) / steps;
        const a1 = nowAngle - (sweepSpan * i) / steps;
        const alpha = (1 - i / steps) * (light ? 0.13 : 0.17);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxR * 0.99, a0, a1);
        ctx.closePath();
        ctx.fillStyle = light
          ? `rgba(5, 150, 105, ${alpha.toFixed(3)})`
          : `rgba(14, 203, 129, ${alpha.toFixed(3)})`;
        ctx.fill();
      }

      // 同心精密仪表环
      [0.98, 0.84, 0.68, 0.50].forEach((ratio, idx) => {
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * ratio, 0, Math.PI * 2);
        ctx.strokeStyle = light
          ? idx === 0
            ? 'rgba(15, 23, 42, 0.18)'
            : 'rgba(15, 23, 42, 0.10)'
          : idx === 0
            ? 'rgba(148, 163, 184, 0.18)'
            : 'rgba(148, 163, 184, 0.10)';
        ctx.lineWidth = idx === 3 ? 1.2 : 0.8;
        ctx.stroke();
      });

      // 96 档时段热力环
      const symCount = d.symbols.length;
      for (let s = 0; s < 96; s++) {
        const angle = (s / 96) * Math.PI * 2 - Math.PI / 2;
        const inner = maxR * 0.69;
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
            ctx.strokeStyle = light
              ? `rgba(5, 150, 105, ${0.55 + k * 0.10})`
              : `rgba(14, 203, 129, ${0.44 + k * 0.12})`;
          } else if (buckets[s]! > 0.2) {
            ctx.strokeStyle = light
              ? `rgba(79, 70, 229, ${0.42 + k * 0.11})`
              : `rgba(192, 132, 252, ${0.32 + k * 0.11})`;
          } else {
            ctx.strokeStyle = light
              ? symUp
                ? `rgba(5, 150, 105, ${0.24 + k * 0.09})`
                : `rgba(225, 29, 72, ${0.24 + k * 0.09})`
              : symUp
                ? `rgba(14, 203, 129, ${0.15 + k * 0.07})`
                : `rgba(246, 70, 93, ${0.15 + k * 0.07})`;
          }
          ctx.stroke();
        }
      }

      // 外圈星尘粒子
      const pulsePhase = ts * 0.00045;
      const starCount = Math.min(64, d.symbols.length);
      for (let i = 0; i < starCount; i++) {
        const s = d.symbols[i]!;
        const a = (i / Math.max(1, starCount)) * Math.PI * 2 - Math.PI / 2 + pulsePhase * 0.1;
        const mag = Math.min(1, Math.abs(s.changePercent24h) / 25);
        const r = maxR * (0.86 + mag * 0.11);
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        const twinkle = 0.55 + 0.45 * Math.sin(ts * 0.004 + i * 1.7);
        ctx.beginPath();
        ctx.arc(px, py, 1.1 + mag * 1.4, 0, Math.PI * 2);
        ctx.fillStyle = light
          ? s.changePercent24h >= 0
            ? `rgba(5, 150, 105, ${(0.45 + 0.45 * twinkle).toFixed(2)})`
            : `rgba(225, 29, 72, ${(0.45 + 0.45 * twinkle).toFixed(2)})`
          : s.changePercent24h >= 0
            ? `rgba(14, 203, 129, ${(0.35 + 0.55 * twinkle).toFixed(2)})`
            : `rgba(246, 70, 93, ${(0.35 + 0.55 * twinkle).toFixed(2)})`;
        ctx.fill();
      }

      // 24 小时刻度
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = light ? 'rgba(51, 65, 85, 0.85)' : 'rgba(148, 163, 184, 0.6)';
      for (let hr = 0; hr < 24; hr += 3) {
        const a = (hr / 24) * Math.PI * 2 - Math.PI / 2;
        ctx.fillText(
          `${String(hr).padStart(2, '0')}时`,
          cx + Math.cos(a) * (maxR * 0.585),
          cy + Math.sin(a) * (maxR * 0.585),
        );
      }

      // 中心真实权益微弧线
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
        ctx.strokeStyle = light
          ? d.realizedPnl >= 0
            ? 'rgba(4, 120, 87, 0.90)'
            : 'rgba(190, 18, 60, 0.90)'
          : d.realizedPnl >= 0
            ? 'rgba(14, 203, 129, 0.88)'
            : 'rgba(246, 70, 93, 0.88)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      // 实时激光走时指针
      const tipX = cx + Math.cos(nowAngle) * (maxR * 0.99);
      const tipY = cy + Math.sin(nowAngle) * (maxR * 0.99);
      const baseX = cx + Math.cos(nowAngle) * (maxR * 0.50);
      const baseY = cy + Math.sin(nowAngle) * (maxR * 0.50);
      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = light ? 'rgba(51, 65, 85, 0.85)' : 'rgba(226, 232, 240, 0.9)';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(tipX, tipY, 3, 0, Math.PI * 2);
      ctx.fillStyle = light ? '#059669' : '#0ecb81';
      ctx.shadowColor = light ? 'rgba(5, 150, 105, 0.55)' : '#0ecb81';
      ctx.shadowBlur = light ? 6 : 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      // 中心全中文全息读数
      ctx.textAlign = 'center';
      ctx.fillStyle = light ? '#475569' : 'rgba(148, 163, 184, 0.82)';
      ctx.font = '600 10px system-ui, -apple-system, sans-serif';
      ctx.fillText(d.paperOnly ? '模拟账户权益' : '实盘账户权益', cx, cy - 26);

      ctx.fillStyle = light ? '#0f172a' : '#f8fafc';
      ctx.font = '700 21px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(fmtAsset(d.accountEquity, 'USDT', 2).replace(' USDT', ''), cx, cy - 5);

      ctx.fillStyle = light
        ? d.realizedPnl >= 0
          ? '#047857'
          : '#be123c'
        : d.realizedPnl >= 0
          ? '#0ecb81'
          : '#f6465d';
      ctx.font = '700 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`${fmtUsdSigned(d.realizedPnl, 2)} (${fmtPercent(d.returnPct)})`, cx, cy + 15);

      ctx.fillStyle = light ? '#475569' : 'rgba(148, 163, 184, 0.78)';
      ctx.font = '600 10px system-ui, -apple-system, sans-serif';
      const wrText =
        d.winRatePct !== null
          ? `胜率 ${d.winRatePct.toFixed(0)}% · ${d.wins}盈/${d.losses}亏`
          : now.toLocaleTimeString('zh-CN', { hour12: false });
      ctx.fillText(wrText, cx, cy + 32);

      if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
    };

    redrawRef.current = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
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
      redrawRef.current = null;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => {
    redrawRef.current?.();
  }, [isLight]);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-label="24小时量子热力表盘" />
    </div>
  );
}

/* ==========================================================================
 *  2. 全市场 522 永续 360° 极坐标态势雷达（清晰 4 象限 + 余辉扫描 + 零重叠外围引线标牌）
 * ========================================================================== */

interface RadarPoint {
  sym: MarketSymbol;
  x: number;
  y: number;
  angle: number;
  radius: number;
  dotR: number;
  radar: ManagedRadarItemView | null;
}

export function PolarAlphaRadarCanvas({
  symbols,
  radarItems,
}: {
  symbols: MarketSymbol[];
  radarItems: ManagedRadarItemView[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isLight = useIsLightSkin();
  const lightRef = useRef(isLight);
  lightRef.current = isLight;
  const redrawRef = useRef<(() => void) | null>(null);

  const dataRef = useRef({ symbols, radarItems });
  dataRef.current = { symbols, radarItems };

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
      const { symbols: syms, radarItems: radars } = dataRef.current;
      const light = lightRef.current;

      ctx.clearRect(0, 0, w, h);

      // 为底部浮层图例与四角象限标签预留明确安全区，确保 1366×768 / 1920×1080 / 390×844 / 844×390 全视口零裁切
      const topReserve = 12;
      const bottomReserve = w < 440 ? 50 : 38;
      const availH = Math.max(120, h - topReserve - bottomReserve);
      const cx = w * 0.5;
      const cy = topReserve + availH * 0.5;
      // 为左右外围全息标牌留出充裕呼吸区，让圆盘和标牌永远井然有序
      const maxR = Math.min(availH * 0.42, w >= 520 ? w * 0.27 : w * 0.34);

      // 柔和环境光晕
      const bgGlow = ctx.createRadialGradient(cx, cy, maxR * 0.08, cx, cy, maxR * 1.45);
      if (light) {
        bgGlow.addColorStop(0, 'rgba(79, 70, 229, 0.08)');
        bgGlow.addColorStop(0.55, 'rgba(5, 150, 105, 0.04)');
        bgGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
      } else {
        bgGlow.addColorStop(0, 'rgba(112, 96, 245, 0.14)');
        bgGlow.addColorStop(0.55, 'rgba(14, 203, 129, 0.06)');
        bgGlow.addColorStop(1, 'rgba(6, 9, 18, 0)');
      }
      ctx.fillStyle = bgGlow;
      ctx.fillRect(0, 0, w, h);

      // 1. 4 个同心轨道环（对应真实 24h 涨跌振幅：3% / 10% / 20% / 40%+）
      const ringDefs = [
        { frac: 0.28, label: '3%' },
        { frac: 0.52, label: '10%' },
        { frac: 0.76, label: '20%' },
        { frac: 1.0, label: '40%+' },
      ];
      for (const ring of ringDefs) {
        const rr = maxR * ring.frac;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.strokeStyle = light
          ? ring.frac === 1
            ? 'rgba(2, 132, 199, 0.34)'
            : 'rgba(15, 23, 42, 0.11)'
          : ring.frac === 1
            ? 'rgba(56, 189, 248, 0.24)'
            : 'rgba(148, 163, 184, 0.11)';
        ctx.lineWidth = ring.frac === 1 ? 1.2 : 0.8;
        ctx.stroke();

        // 轨道刻度标在正上方
        ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = light ? 'rgba(51, 65, 85, 0.78)' : 'rgba(148, 163, 184, 0.45)';
        ctx.fillText(ring.label, cx, cy - rr + 8);
      }

      // 2. 十字象限坐标轴 + 45° 辅助虚线
      ctx.strokeStyle = light ? 'rgba(15, 23, 42, 0.14)' : 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(cx - maxR * 1.05, cy);
      ctx.lineTo(cx + maxR * 1.05, cy);
      ctx.moveTo(cx, cy - maxR * 1.05);
      ctx.lineTo(cx, cy + maxR * 1.05);
      ctx.stroke();

      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = light ? 'rgba(15, 23, 42, 0.08)' : 'rgba(148, 163, 184, 0.07)';
      const diag = maxR * 0.72;
      ctx.beginPath();
      ctx.moveTo(cx - diag, cy - diag);
      ctx.lineTo(cx + diag, cy + diag);
      ctx.moveTo(cx + diag, cy - diag);
      ctx.lineTo(cx - diag, cy + diag);
      ctx.stroke();
      ctx.setLineDash([]);

      // 4 象限清晰中文说明标签（锚定在安全区内，既不遮挡星点也不与外围标牌/底部图例重叠）
      const qTopY = Math.max(topReserve + 8, cy - maxR * 0.90);
      const qBotY = Math.min(h - bottomReserve - 8, cy + maxR * 0.90);
      const compactLabels = w < 460;
      const tightWings = w >= 520 && w < 620;
      ctx.font = compactLabels || tightWings
        ? '600 9.5px system-ui, -apple-system, sans-serif'
        : '600 10px system-ui, -apple-system, sans-serif';
      ctx.textBaseline = 'middle';

      const qXOffset = maxR * (tightWings ? 0.50 : 0.56);
      const rightLabelX = compactLabels ? w - 10 : cx + qXOffset;
      const leftLabelX = compactLabels ? 10 : cx - qXOffset;

      ctx.textAlign = compactLabels ? 'right' : 'left';
      ctx.fillStyle = light ? '#047857' : 'rgba(110, 231, 183, 0.62)';
      ctx.fillText('↗ 放量领涨区', rightLabelX, qTopY);
      ctx.fillStyle = light ? '#0369a1' : 'rgba(56, 189, 248, 0.58)';
      ctx.fillText('↘ 中小盘潜伏上涨', rightLabelX, qBotY);

      ctx.textAlign = compactLabels ? 'left' : 'right';
      ctx.fillStyle = light ? '#be123c' : 'rgba(251, 113, 133, 0.62)';
      ctx.fillText('放量回调区 ↖', leftLabelX, qTopY);
      ctx.fillStyle = light ? '#475569' : 'rgba(148, 163, 184, 0.55)';
      ctx.fillText('弱势休整区 ↙', leftLabelX, qBotY);

      // 3. 实时旋转翡翠雷达扫描束（每 5.5 秒完整扫过全市场 522 合约，附余辉高亮）
      const sweepAngle = reduced ? -Math.PI * 0.25 : ((ts * 0.00115) % (Math.PI * 2)) - Math.PI;
      const trailSpan = 0.72;
      const trailSteps = 24;
      for (let i = 0; i < trailSteps; i++) {
        const a0 = sweepAngle - (trailSpan * (i + 1)) / trailSteps;
        const a1 = sweepAngle - (trailSpan * i) / trailSteps;
        const alpha = (1 - i / trailSteps) * (light ? 0.12 : 0.16);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxR, a0, a1);
        ctx.closePath();
        ctx.fillStyle = light
          ? `rgba(5, 150, 105, ${alpha.toFixed(3)})`
          : `rgba(14, 203, 129, ${alpha.toFixed(3)})`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweepAngle) * maxR, cy + Math.sin(sweepAngle) * maxR);
      ctx.strokeStyle = light ? 'rgba(5, 150, 105, 0.78)' : 'rgba(52, 211, 153, 0.82)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 4. 将全部 522 个真实永续合约映射到清晰的 4 象限极坐标
      const radarMap = new Map<string, ManagedRadarItemView>();
      for (const r of radars) radarMap.set(r.symbol, r);

      const points: RadarPoint[] = [];
      for (let i = 0; i < syms.length; i++) {
        const sym = syms[i]!;
        const pct = sym.changePercent24h;
        const up = pct >= 0;
        const highVol = sym.quoteVolume24h >= 20_000_000;
        const h1 = hashOf(sym.symbol);
        const localFrac = 0.07 + h1 * 0.86;
        let angle: number;
        if (up && highVol) angle = -Math.PI * 0.5 + localFrac * (Math.PI * 0.5);
        else if (up && !highVol) angle = localFrac * (Math.PI * 0.5);
        else if (!up && highVol) angle = -Math.PI + localFrac * (Math.PI * 0.5);
        else angle = Math.PI * 0.5 + localFrac * (Math.PI * 0.5);

        const absPct = Math.abs(pct);
        const normR = Math.min(0.96, 0.16 + (Math.log1p(absPct) / Math.log1p(55)) * 0.80);
        const radius = normR * maxR;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        const volLog = Math.log10(Math.max(100_000, sym.quoteVolume24h));
        const radar = radarMap.get(sym.symbol) ?? null;
        const dotR = radar ? 4.4 : Math.max(1.6, Math.min(3.6, (volLog - 4.8) * 0.65));

        points.push({ sym, x, y, angle, radius, dotR, radar });
      }

      // 5. 绘制 522 个真实合约光点（雷达束刚扫过时触发余辉闪烁！）
      for (const p of points) {
        let diff = sweepAngle - p.angle;
        while (diff < 0) diff += Math.PI * 2;
        while (diff >= Math.PI * 2) diff -= Math.PI * 2;
        const ping = diff < 0.85 ? 1 - diff / 0.85 : 0;
        const up = p.sym.changePercent24h >= 0;

        if (p.radar || ping > 0.35) {
          const haloR = p.dotR * (p.radar ? 3.2 : 2.3);
          const halo = ctx.createRadialGradient(p.x, p.y, 0.5, p.x, p.y, haloR);
          if (p.radar) {
            halo.addColorStop(0, light ? 'rgba(217, 119, 6, 0.48)' : 'rgba(251, 191, 36, 0.72)');
            halo.addColorStop(1, light ? 'rgba(217, 119, 6, 0)' : 'rgba(251, 191, 36, 0)');
          } else if (up) {
            halo.addColorStop(0, light ? `rgba(5, 150, 105, ${(0.45 * ping).toFixed(2)})` : `rgba(14, 203, 129, ${(0.55 * ping).toFixed(2)})`);
            halo.addColorStop(1, light ? 'rgba(5, 150, 105, 0)' : 'rgba(14, 203, 129, 0)');
          } else {
            halo.addColorStop(0, light ? `rgba(225, 29, 72, ${(0.45 * ping).toFixed(2)})` : `rgba(246, 70, 93, ${(0.55 * ping).toFixed(2)})`);
            halo.addColorStop(1, light ? 'rgba(225, 29, 72, 0)' : 'rgba(246, 70, 93, 0)');
          }
          ctx.beginPath();
          ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
          ctx.fillStyle = halo;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.dotR + ping * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = p.radar
          ? light
            ? '#d97706'
            : '#fde68a'
          : light
            ? up
              ? `rgba(5, 150, 105, ${(0.62 + ping * 0.38).toFixed(2)})`
              : `rgba(225, 29, 72, ${(0.62 + ping * 0.38).toFixed(2)})`
            : up
              ? `rgba(14, 203, 129, ${(0.52 + ping * 0.48).toFixed(2)})`
              : `rgba(246, 70, 93, ${(0.52 + ping * 0.48).toFixed(2)})`;
        ctx.fill();
      }

      // 6. 挑选最多 6 个焦点标的，按左右侧自动分配至固定外围标牌槽（彻底 0 重叠！）
      const featured: RadarPoint[] = [];
      const picked = new Set<string>();
      const pushFeat = (pt: RadarPoint | undefined) => {
        if (!pt || picked.has(pt.sym.symbol) || featured.length >= 6) return;
        picked.add(pt.sym.symbol);
        featured.push(pt);
      };
      const radarPoints = points
        .filter((p) => p.radar !== null)
        .sort((a, b) => (b.radar?.score ?? 0) - (a.radar?.score ?? 0));
      for (const rp of radarPoints.slice(0, 4)) pushFeat(rp);
      pushFeat(points.find((p) => p.sym.symbol === 'BTCUSDT'));
      const sortedMovers = [...points]
        .filter((p) => p.sym.quoteVolume24h >= 15_000_000)
        .sort((a, b) => Math.abs(b.sym.changePercent24h) - Math.abs(a.sym.changePercent24h));
      for (const mp of sortedMovers) pushFeat(mp);

      if (w >= 520 && featured.length > 0) {
        const leftList: RadarPoint[] = [];
        const rightList: RadarPoint[] = [];
        for (const fp of featured) {
          if (fp.x < cx && leftList.length < 3) leftList.push(fp);
          else if (rightList.length < 3) rightList.push(fp);
          else leftList.push(fp);
        }
        leftList.sort((a, b) => a.y - b.y);
        rightList.sort((a, b) => a.y - b.y);

        const drawCalloutWing = (list: RadarPoint[], side: 'left' | 'right') => {
          const cardW = Math.min(144, Math.max(114, Math.floor((w - maxR * 2) * 0.40)));
          const cardH = 38;
          const slotStep = Math.min(62, (availH - 16) / Math.max(1, list.length));
          const startY = cy - ((list.length - 1) * slotStep) / 2;

          list.forEach((pt, idx) => {
            const boxX = side === 'left' ? 12 : w - cardW - 12;
            const rawBoxY = startY + idx * slotStep - cardH / 2;
            const boxY = Math.max(topReserve + 2, Math.min(h - bottomReserve - cardH - 2, rawBoxY));
            const anchorX = side === 'left' ? boxX + cardW : boxX;
            const anchorY = boxY + cardH / 2;
            const kneeX = side === 'left' ? anchorX + 16 : anchorX - 16;

            const isRadar = pt.radar !== null;
            const up = pt.sym.changePercent24h >= 0;
            const accentColor = light
              ? isRadar
                ? '#b45309'
                : up
                  ? '#047857'
                  : '#be123c'
              : isRadar
                ? '#fbbf24'
                : up
                  ? '#34d399'
                  : '#fb7185';
            const strokeAlpha = light
              ? isRadar
                ? 'rgba(217, 119, 6, 0.55)'
                : up
                  ? 'rgba(5, 150, 105, 0.45)'
                  : 'rgba(225, 29, 72, 0.45)'
              : isRadar
                ? 'rgba(251, 191, 36, 0.55)'
                : up
                  ? 'rgba(14, 203, 129, 0.45)'
                  : 'rgba(246, 70, 93, 0.45)';

            // 中心 → 目标脉冲射线 + 目标 → 外围标牌折线引线
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(pt.x, pt.y);
            ctx.strokeStyle = light
              ? isRadar
                ? 'rgba(217, 119, 6, 0.24)'
                : 'rgba(2, 132, 199, 0.18)'
              : isRadar
                ? 'rgba(251, 191, 36, 0.25)'
                : 'rgba(56, 189, 248, 0.16)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(kneeX, anchorY);
            ctx.lineTo(anchorX, anchorY);
            ctx.strokeStyle = strokeAlpha;
            ctx.lineWidth = 1.1;
            ctx.stroke();

            // 沿折线流动的微光粒子
            const phase = (ts * 0.0007 + idx * 0.31) % 1;
            const lx = pt.x + (kneeX - pt.x) * phase;
            const ly = pt.y + (anchorY - pt.y) * phase;
            ctx.beginPath();
            ctx.arc(lx, ly, 2, 0, Math.PI * 2);
            ctx.fillStyle = accentColor;
            ctx.fill();

            // 目标准星圆环
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 7.5, 0, Math.PI * 2);
            ctx.strokeStyle = strokeAlpha;
            ctx.lineWidth = 1.1;
            ctx.stroke();

            // 标牌卡片
            ctx.fillStyle = light ? 'rgba(255, 255, 255, 0.94)' : 'rgba(10, 14, 26, 0.88)';
            ctx.strokeStyle = strokeAlpha;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(boxX, boxY, cardW, cardH, 7);
            ctx.fill();
            ctx.stroke();

            // 左侧色条
            ctx.fillStyle = accentColor;
            ctx.beginPath();
            ctx.roundRect(boxX, boxY + 6, 2.5, cardH - 12, 2);
            ctx.fill();

            // 第一行：币种名 + 雷达评分/基准标记
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = light ? '#0f172a' : '#f8fafc';
            ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillText(pt.sym.baseAsset.slice(0, 8), boxX + 9, boxY + 13);

            ctx.textAlign = 'right';
            ctx.fillStyle = accentColor;
            ctx.font = '700 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillText(
              pt.radar ? `${Math.round(pt.radar.score)}分` : fmtPercent(pt.sym.changePercent24h),
              boxX + cardW - 8,
              boxY + 13,
            );

            // 第二行：价格 + 24h 涨跌
            ctx.textAlign = 'left';
            ctx.fillStyle = light ? '#475569' : 'rgba(148, 163, 184, 0.82)';
            ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillText(fmtPriceUsd(pt.sym.price), boxX + 9, boxY + 27);

            if (pt.radar) {
              ctx.textAlign = 'right';
              ctx.fillStyle = light
                ? up
                  ? '#047857'
                  : '#be123c'
                : up
                  ? '#6ee7b7'
                  : '#fda4af';
              ctx.fillText(fmtPercent(pt.sym.changePercent24h), boxX + cardW - 8, boxY + 27);
            }
          });
        };

        drawCalloutWing(leftList, 'left');
        drawCalloutWing(rightList, 'right');
      }

      // 7. 中心 AI500 雷达中枢核心
      const pulse = 1 + 0.1 * Math.sin(ts * 0.004);
      const coreGlow = ctx.createRadialGradient(cx, cy, 4, cx, cy, 28 * pulse);
      if (light) {
        coreGlow.addColorStop(0, 'rgba(79, 70, 229, 0.28)');
        coreGlow.addColorStop(0.5, 'rgba(5, 150, 105, 0.12)');
        coreGlow.addColorStop(1, 'rgba(79, 70, 229, 0)');
      } else {
        coreGlow.addColorStop(0, 'rgba(139, 92, 246, 0.65)');
        coreGlow.addColorStop(0.5, 'rgba(14, 203, 129, 0.22)');
        coreGlow.addColorStop(1, 'rgba(139, 92, 246, 0)');
      }
      ctx.beginPath();
      ctx.arc(cx, cy, 28 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = coreGlow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, 17, 0, Math.PI * 2);
      ctx.fillStyle = light ? '#ffffff' : '#0b1020';
      ctx.strokeStyle = light ? '#4f46e5' : 'rgba(139, 92, 246, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = light ? '#1e1b4b' : '#ffffff';
      ctx.font = '700 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('AI500', cx, cy - 3);
      ctx.fillStyle = light ? '#047857' : '#34d399';
      ctx.font = '600 8px system-ui, -apple-system, sans-serif';
      ctx.fillText('雷达中枢', cx, cy + 7);

      if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
    };

    redrawRef.current = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
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
      redrawRef.current = null;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => {
    redrawRef.current?.();
  }, [isLight]);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-label="全市场522永续360度极坐标态势雷达" />
    </div>
  );
}

/* ==========================================================================
 *  3. 实时信号神经网络流（全中文节点）
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
  const isLight = useIsLightSkin();
  const lightRef = useRef(isLight);
  lightRef.current = isLight;
  const redrawRef = useRef<(() => void) | null>(null);

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
      const light = lightRef.current;

      ctx.clearRect(0, 0, w, h);

      const compact = w < 480;
      const leftBoxW = compact ? 96 : 120;
      const rightBoxW = compact ? 112 : 140;
      const leftHalf = leftBoxW / 2;
      const rightHalf = rightBoxW / 2;
      const hubR = compact ? 30 : 38;

      const inputs = d.symbols.slice(0, 4);
      const leftX = Math.max(leftHalf + 10, w * 0.14);
      const centerX = w * 0.5;
      const rightX = Math.min(w - rightHalf - 10, w * 0.84);
      const bottomReserve = compact ? 46 : 34;
      const usableH = Math.max(140, h - bottomReserve);
      const midY = usableH * 0.5;

      const rightNodes = [
        { title: 'AI500 六维引擎', sub: `${d.radarItems.length} 个焦点标的`, color: light ? '#0284c7' : '#38bdf8' },
        { title: 'LLM 三段式大脑', sub: d.latestCycle ? `周期 #${d.latestCycle}` : '待命中', color: light ? '#4f46e5' : '#a78bfa' },
        { title: '硬风控闸门', sub: `持仓 ${d.openPositions} · 强校验`, color: light ? '#b45309' : '#fbbf24' },
        { title: '交易所执行器', sub: d.runningCount > 0 ? '实盘在线' : '待机中', color: light ? '#047857' : '#0ecb81' },
      ];

      const rowY = (idx: number, total: number) => usableH * 0.16 + (idx / Math.max(1, total - 1)) * (usableH * 0.68);

      inputs.forEach((sym, i) => {
        const y = rowY(i, 4);
        const up = sym.changePercent24h >= 0;
        const c1x = leftX + (centerX - leftX) * 0.5;
        ctx.beginPath();
        ctx.moveTo(leftX + leftHalf, y);
        ctx.bezierCurveTo(c1x, y, c1x, midY, centerX - hubR, midY);
        ctx.strokeStyle = light
          ? up
            ? 'rgba(5, 150, 105, 0.40)'
            : 'rgba(225, 29, 72, 0.40)'
          : up
            ? 'rgba(14, 203, 129, 0.38)'
            : 'rgba(246, 70, 93, 0.38)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const t = (ts * 0.00065 + i * 0.25) % 1;
        const inv = 1 - t;
        const px =
          inv * inv * inv * (leftX + leftHalf) +
          3 * inv * inv * t * c1x +
          3 * inv * t * t * c1x +
          t * t * t * (centerX - hubR);
        const py =
          inv * inv * inv * y +
          3 * inv * inv * t * y +
          3 * inv * t * t * midY +
          t * t * t * midY;
        const dotColor = light ? (up ? '#059669' : '#e11d48') : up ? '#0ecb81' : '#f6465d';
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.shadowColor = dotColor;
        ctx.shadowBlur = light ? 6 : 10;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = light ? 'rgba(255, 255, 255, 0.95)' : 'rgba(13, 18, 32, 0.92)';
        ctx.strokeStyle = light
          ? up
            ? 'rgba(5, 150, 105, 0.45)'
            : 'rgba(225, 29, 72, 0.45)'
          : up
            ? 'rgba(14, 203, 129, 0.42)'
            : 'rgba(246, 70, 93, 0.42)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(leftX - leftHalf, y - 20, leftBoxW, 40, 8);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = light ? '#0f172a' : '#f8fafc';
        ctx.font = compact
          ? '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
          : '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(sym.baseAsset.slice(0, 6), leftX - leftHalf + 8, y - 6);
        ctx.fillStyle = light ? (up ? '#047857' : '#be123c') : up ? '#34d399' : '#fb7185';
        ctx.font = compact
          ? '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace'
          : '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(fmtPriceUsd(sym.price), leftX - leftHalf + 8, y + 9);
        ctx.textAlign = 'right';
        ctx.fillText(fmtPercent(sym.changePercent24h), leftX + leftHalf - 8, y - 6);
      });

      rightNodes.forEach((rn, i) => {
        const y = rowY(i, 4);
        const c2x = centerX + (rightX - centerX) * 0.5;
        ctx.beginPath();
        ctx.moveTo(centerX + hubR, midY);
        ctx.bezierCurveTo(c2x, midY, c2x, y, rightX - rightHalf, y);
        ctx.strokeStyle = `${rn.color}66`;
        ctx.lineWidth = 1.6;
        ctx.stroke();

        const t = (ts * 0.00058 + i * 0.23 + 0.12) % 1;
        const inv = 1 - t;
        const px =
          inv * inv * inv * (centerX + hubR) +
          3 * inv * inv * t * c2x +
          3 * inv * t * t * c2x +
          t * t * t * (rightX - rightHalf);
        const py =
          inv * inv * inv * midY +
          3 * inv * inv * t * midY +
          3 * inv * t * t * y +
          t * t * t * y;
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = rn.color;
        ctx.shadowColor = rn.color;
        ctx.shadowBlur = light ? 6 : 10;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = light ? 'rgba(255, 255, 255, 0.95)' : 'rgba(13, 18, 32, 0.92)';
        ctx.strokeStyle = `${rn.color}70`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(rightX - rightHalf, y - 20, rightBoxW, 40, 8);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = light ? '#0f172a' : '#f8fafc';
        ctx.font = compact
          ? '700 10px system-ui, -apple-system, sans-serif'
          : '700 11px system-ui, -apple-system, sans-serif';
        ctx.fillText(rn.title, rightX - rightHalf + 8, y - 6);
        ctx.fillStyle = rn.color;
        ctx.font = compact
          ? '600 9.5px system-ui, -apple-system, sans-serif'
          : '600 10px system-ui, -apple-system, sans-serif';
        ctx.fillText(rn.sub, rightX - rightHalf + 8, y + 9);
      });

      const pulse = 1 + 0.12 * Math.sin(ts * 0.0045);
      const glow = ctx.createRadialGradient(centerX, midY, 6, centerX, midY, (hubR + 20) * pulse);
      if (light) {
        glow.addColorStop(0, 'rgba(79, 70, 229, 0.26)');
        glow.addColorStop(0.55, 'rgba(5, 150, 105, 0.10)');
        glow.addColorStop(1, 'rgba(79, 70, 229, 0)');
      } else {
        glow.addColorStop(0, 'rgba(112, 96, 245, 0.65)');
        glow.addColorStop(0.55, 'rgba(14, 203, 129, 0.18)');
        glow.addColorStop(1, 'rgba(112, 96, 245, 0)');
      }
      ctx.beginPath();
      ctx.arc(centerX, midY, (hubR + 20) * pulse, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(centerX, midY, hubR, 0, Math.PI * 2);
      ctx.fillStyle = light ? '#ffffff' : '#0f1322';
      ctx.strokeStyle = light ? '#4f46e5' : '#8b5cf6';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = light ? '#0f172a' : '#ffffff';
      ctx.font = compact
        ? '700 9.5px system-ui, -apple-system, sans-serif'
        : '700 11px system-ui, -apple-system, sans-serif';
      ctx.fillText('AI 核心中枢', centerX, midY - 6);
      ctx.fillStyle = light ? '#047857' : '#34d399';
      ctx.font = compact
        ? '600 9px ui-monospace, SFMono-Regular, Menlo, monospace'
        : '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`${d.totalSymbols || d.symbols.length} 永续`, centerX, midY + 9);

      if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
    };

    redrawRef.current = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
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
      redrawRef.current = null;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => {
    redrawRef.current?.();
  }, [isLight]);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-label="实时量化信号神经网络流" />
    </div>
  );
}

/* ==========================================================================
 *  4. 全市场 522 币种分层流动性 24h 收益分布霓虹脊线频谱
 * ========================================================================== */

export function QuantumRidgeCanvas({ symbols }: { symbols: MarketSymbol[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isLight = useIsLightSkin();
  const lightRef = useRef(isLight);
  lightRef.current = isLight;
  const redrawRef = useRef<(() => void) | null>(null);

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
      const light = lightRef.current;
      ctx.clearRect(0, 0, w, h);

      const layers = 7;
      const bins = 40;
      const sorted = [...syms].sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
      const chunkSize = Math.max(1, Math.ceil(sorted.length / layers));

      const padX = 18;
      const plotW = w - padX * 2;
      const topY = 24;
      const botY = h - 22;

      const zeroX = padX + plotW * 0.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(zeroX, 10);
      ctx.lineTo(zeroX, botY);
      ctx.strokeStyle = light ? 'rgba(15, 23, 42, 0.18)' : 'rgba(148, 163, 184, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      for (let l = 0; l < layers; l++) {
        const slice = sorted.slice(l * chunkSize, (l + 1) * chunkSize);
        const hist = new Float32Array(bins);
        for (const s of slice) {
          const clamped = Math.max(-16, Math.min(16, s.changePercent24h));
          const b = Math.min(bins - 1, Math.max(0, Math.floor(((clamped + 16) / 32) * bins)));
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

        const fillGrad = ctx.createLinearGradient(padX, baseY - amp, padX + plotW, baseY);
        if (light) {
          fillGrad.addColorStop(0, 'rgba(225, 29, 72, 0.16)');
          fillGrad.addColorStop(0.45, 'rgba(79, 70, 229, 0.20)');
          fillGrad.addColorStop(0.75, 'rgba(2, 132, 199, 0.16)');
          fillGrad.addColorStop(1, 'rgba(5, 150, 105, 0.22)');
        } else {
          fillGrad.addColorStop(0, 'rgba(246, 70, 93, 0.26)');
          fillGrad.addColorStop(0.45, 'rgba(139, 92, 246, 0.34)');
          fillGrad.addColorStop(0.75, 'rgba(56, 189, 248, 0.26)');
          fillGrad.addColorStop(1, 'rgba(14, 203, 129, 0.34)');
        }
        ctx.fillStyle = fillGrad;
        ctx.fill();

        const strokeGrad = ctx.createLinearGradient(padX, baseY, padX + plotW, baseY);
        if (light) {
          strokeGrad.addColorStop(0, 'rgba(190, 18, 60, 0.82)');
          strokeGrad.addColorStop(0.45, 'rgba(79, 70, 229, 0.90)');
          strokeGrad.addColorStop(0.78, 'rgba(3, 105, 161, 0.84)');
          strokeGrad.addColorStop(1, 'rgba(4, 120, 87, 0.92)');
        } else {
          strokeGrad.addColorStop(0, 'rgba(246, 70, 93, 0.72)');
          strokeGrad.addColorStop(0.45, 'rgba(167, 139, 250, 0.92)');
          strokeGrad.addColorStop(0.78, 'rgba(56, 189, 248, 0.82)');
          strokeGrad.addColorStop(1, 'rgba(14, 203, 129, 0.92)');
        }
        ctx.strokeStyle = strokeGrad;
        ctx.lineWidth = l === layers - 1 ? 1.8 : 1.15;
        ctx.stroke();
      }

      ctx.font = '600 10px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = light ? '#334155' : 'rgba(148, 163, 184, 0.72)';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText('-16% 左尾普跌', padX, h - 6);
      ctx.textAlign = 'center';
      ctx.fillText('0% 多空平衡轴', zeroX, h - 6);
      ctx.textAlign = 'right';
      ctx.fillText('+16% 右尾暴涨', padX + plotW, h - 6);

      if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
    };

    redrawRef.current = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
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
      redrawRef.current = null;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => {
    redrawRef.current?.();
  }, [isLight]);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-label="全市场522币种收益密度霓虹脊线频谱" />
    </div>
  );
}
