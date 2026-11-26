/**
 * 币种图标组件：优先展示主流币真实 Logo，缺失或加载失败时无感回落到确定性彩色首字母圆点
 * （「有的换、没有别硬换」，零 404 刷屏，零破图）。
 */
import { useState, type CSSProperties } from 'react';
import { cn } from './ui';

/**
 * 经实测在 CoinCap 静态图标库稳定存在的主流/活跃合约标的基底币清单。
 * 只对清单内标的发起图片请求，生僻新币直接走首字母徽章，避免控制台出现 404 噪音。
 */
const KNOWN_COIN_ICONS = new Set<string>([
  'btc', 'eth', 'bnb', 'sol', 'xrp', 'doge', 'ada', 'trx', 'avax', 'link',
  'dot', 'ltc', 'bch', 'uni', 'near', 'sui', 'apt', 'arb', 'op', 'fil',
  'atom', 'etc', 'aave', 'mkr', 'inj', 'sei', 'tia', 'fet', 'wld', 'ena',
  'zec', 'xmr', 'xlm', 'hbar', 'vet', 'algo', 'icp', 'sand', 'mana', 'axs',
  'gala', 'ape', 'pepe', 'shib', 'floki', 'bonk', 'wif', 'ton', 'ftm', 'ar',
  'grt', 'ldo', 'crv', 'snx', 'comp', 'sushi', 'dydx', 'gmx', 'rune', 'kava',
  'eos', 'theta', 'flow', 'ksm', 'qnt', 'chz', 'zil', 'iost', 'ont', 'omg',
  'zrx', 'bat', 'enj', 'neo', 'qtum', 'waves', 'cake', '1inch', 'blur', 'pendle',
  'jup', 'pyth', 'strk', 'ordi', 'trb', 'tao', 'stx', 'imx', 'kas', 'ray',
  'jto', 'bome', 'turbo', 'people', 'not', 's', 'hype', 'egld', 'xtz', 'cfx',
  'mina', 'rose', 'celo', 'one', 'ankr', 'rvn', 'zen', 'dash', 'knc', 'yfi',
  'bal', 'band', 'lrc', 'storj', 'skl', 'ctsi', 'ocean', 'agix', 'rndr', 'render',
  'ens', 'ssv', 'rpl', 'fxs', 'cvx', 'magic', 'rdnt', 'woo', 'jasmy', 'mask',
  'ach', 'api3', 'bico', 'celr', 'coti', 'dusk', 'edu', 'gal', 'gmt', 'high',
  'hook', 'id', 'joe', 'lever', 'lina', 'lpt', 'mav', 'mtl', 'nkn', 'og',
  'perp', 'phb', 'reef', 'rlc', 'rsr', 'sxp', 'tlm', 'tru', 'uma', 'unfi',
  'xvs', 'ygg', 'zen', 'zeta', 'zk', 'zro',
]);

/** 运行期加载失败缓存：同一标的失败一次后后续渲染直接走兜底，不再重复请求。 */
const failedIconBases = new Set<string>();

/** 剥离 USDT/USDC/BUSD 与 1000/1000000 前缀，提取标准基底币小写名。 */
export function extractCoinBase(symbol: string): string {
  const clean = (symbol || '')
    .trim()
    .toUpperCase()
    .replace(/(?:USDT|USDC|BUSD|FDUSD|PERP)$/i, '');
  const stripped = clean.replace(/^(?:1000000|10000|1000)/, '');
  return (stripped || clean).toLowerCase();
}

const FALLBACK_PALETTE = [
  '#4f63b8',
  '#2f8564',
  '#9c5470',
  '#a16a2a',
  '#357899',
  '#6e59a8',
  '#3e8077',
  '#9e564c',
];

function fallbackColor(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i += 1) {
    hash = (hash * 31 + symbol.charCodeAt(i)) | 0;
  }
  return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length]!;
}

export function CoinIcon({
  symbol,
  className,
}: {
  symbol: string;
  className?: string;
}) {
  const base = extractCoinBase(symbol);
  const canTryRealIcon = KNOWN_COIN_ICONS.has(base) && !failedIconBases.has(base);
  const [imgFailed, setImgFailed] = useState(!canTryRealIcon);

  if (canTryRealIcon && !imgFailed) {
    return (
      <img
        src={`https://assets.coincap.io/assets/icons/${base}@2x.png`}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => {
          failedIconBases.add(base);
          setImgFailed(true);
        }}
        className={cn(
          'h-5 w-5 shrink-0 rounded-full bg-base-800 object-cover ring-1 ring-white/10',
          className,
        )}
      />
    );
  }

  const style: CSSProperties = { backgroundColor: fallbackColor(symbol) };
  const initial = (base[0] ?? symbol[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden
      style={style}
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white/95 ring-1 ring-white/10',
        className,
      )}
    >
      {initial}
    </span>
  );
}
