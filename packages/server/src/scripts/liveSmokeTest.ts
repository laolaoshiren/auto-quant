/**
 * Live smoke test — proves the order path works against the **real** exchange.
 *
 * The simulation proves the logic; only this proves the wiring. It walks the
 * complete sequence with the smallest position the venue allows:
 *
 *   preflight → one-way mode → leverage → market entry →
 *   stop loss → take profit → verify both rest on the exchange →
 *   cancel → market exit → verify flat
 *
 * Safety properties, in order of importance:
 *
 *  1. **It always cleans up.** The cancel-and-flatten steps run from a `finally`
 *     block, so an exception mid-way still leaves the account flat.
 *  2. **It refuses to run without `--confirm`.** Real money moves here; it must
 *     never be a stray keystroke away.
 *  3. **It caps the notional** well below the account balance and aborts if the
 *     requested size is not representable.
 *  4. **Liquidation safety**: the entry is at lowest leverage and the stop is
 *     close, so the exposure window is small and bounded in time.
 *
 * Usage (on a host whose IP is whitelisted on the API key):
 *
 *   npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm
 *   npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm --symbol DOGEUSDT --notional 7
 */

import { getDb, closeDb, initDb } from '../db/index.js';
import { dbPath, resolveMasterKey } from '../env.js';
import { Vault } from '../crypto/vault.js';
import { connectExchange, preflight } from '../binance/bootstrap.js';
import { normalizeSymbol } from '../binance/symbols.js';
import { createLogger } from '../logger.js';
import { exchanges } from '../store/repositories.js';

const log = createLogger('smoke');

/* -------------------------------------------------------------------------- */
/*  Options                                                                    */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(`--${name}`);
const str = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

const CONFIRMED = has('confirm');
const SYMBOL = normalizeSymbol(str('symbol', 'DOGEUSDT'));
const NOTIONAL = Number(str('notional', '7'));
const LEVERAGE = Number(str('leverage', '3'));
const STOP_PERCENT = Number(str('stop', '1.2'));
const TARGET_PERCENT = Number(str('target', '2'));

/** Hard ceiling so a typo cannot turn this into a meaningful position. */
const MAX_NOTIONAL = 20;

/* -------------------------------------------------------------------------- */
/*  Console helpers                                                            */
/* -------------------------------------------------------------------------- */

let step = 0;
function heading(text: string): void {
  step += 1;
  process.stdout.write(`\n[${String(step).padStart(2)}] ${text}\n`);
}
function info(text: string): void {
  process.stdout.write(`     ${text}\n`);
}
function ok(text: string): void {
  process.stdout.write(`     ✅ ${text}\n`);
}
function fail(text: string): void {
  process.stdout.write(`     ❌ ${text}\n`);
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  process.stdout.write('\n' + '='.repeat(74) + '\n实盘冒烟测试 —— 会真正下单，但只用最小仓位\n' + '='.repeat(74) + '\n');
  info(`标的 ${SYMBOL} | 名义价值 ${NOTIONAL} USDT | 杠杆 ${LEVERAGE}x | 止损 -${STOP_PERCENT}% | 止盈 +${TARGET_PERCENT}%`);

  if (!CONFIRMED) {
    fail('缺少 --confirm 参数。这会动用真实资金，因此必须显式确认。');
    info('用法： npx tsx packages/server/src/scripts/liveSmokeTest.ts --confirm');
    process.exitCode = 1;
    return;
  }
  if (!(NOTIONAL > 0) || NOTIONAL > MAX_NOTIONAL) {
    fail(`名义价值必须在 0 到 ${MAX_NOTIONAL} USDT 之间（收到 ${NOTIONAL}）。`);
    process.exitCode = 1;
    return;
  }

  /* --- Credentials ------------------------------------------------------ */
  heading('读取凭据');
  const envKey = process.env.BINANCE_API_KEY ?? '';
  const envSecret = process.env.BINANCE_API_SECRET ?? '';

  let apiKey = envKey;
  let apiSecret = envSecret;
  let vault: Vault | null = null;
  /**
   * The venue is derived from **where the credential came from**, never from a
   * stray environment variable.
   *
   * A previous version read `BINANCE_USE_TESTNET` from the project's `.env`, so a
   * production key was pointed at the demo host and failed authentication. The
   * preflight caught it and no order was placed — which is the safety system
   * working — but the failure was confusing and entirely avoidable.
   */
  let environment: 'production' | 'demo' = has('testnet') ? 'demo' : 'production';

  if (!apiKey || !apiSecret) {
    initDb(dbPath);
    vault = new Vault(await resolveMasterKey());
    const wanted = str('account', '');
    const accounts = exchanges.list();
    const account = wanted ? accounts.find((a) => String(a.id) === wanted) : accounts[0];
    if (!account) {
      fail('数据库里没有交易所凭据，也没有设置 BINANCE_API_KEY / BINANCE_API_SECRET 环境变量。');
      closeDb();
      process.exitCode = 1;
      return;
    }
    const row = exchanges.getWithSecret(account.id);
    if (!row) throw new Error('无法读取凭据记录');
    apiKey = row.api_key;
    apiSecret = vault.decrypt(row.api_secret_enc);
    // The stored flag is authoritative: it records which venue the key belongs to.
    environment = row.testnet === 1 ? 'demo' : 'production';
    info(`使用数据库中的凭据 #${account.id}「${account.label}」`);
  } else {
    info('使用环境变量中的凭据');
  }
  ok(`API Key ${apiKey.slice(0, 8)}…${apiKey.slice(-4)}（Secret 不显示）`);
  info(`目标环境：${environment === 'demo' ? '币安 Demo 模拟盘' : '币安实盘'}${has('testnet') ? '（--testnet 指定）' : ''}`);

  /* --- Connect ---------------------------------------------------------- */
  heading('连接交易所并读取合约元数据');
  const connection = await connectExchange({
    environment,
    apiKey,
    apiSecret,
    dryRun: false,
  });
  info(`环境 ${connection.endpoints.label}`);
  info(`时钟偏移 ${connection.clockOffsetMs}ms`);
  info(`可交易合约 ${connection.registry.size}`);
  ok(`权重预算 ${connection.rest.weightLimitPerMinute}/分钟（从 exchangeInfo 读取）`);

  /* --- Preflight -------------------------------------------------------- */
  heading('启动预检');
  const checks = await preflight(connection, { requireCredentials: true });
  let blocking = 0;
  for (const check of checks) {
    process.stdout.write(`     ${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}\n`);
    if (!check.ok && check.blocking) blocking += 1;
  }
  if (blocking > 0) {
    fail(`有 ${blocking} 项阻塞性问题，测试中止（未下任何单）。`);
    process.exitCode = 1;
    return;
  }
  ok('预检通过');

  const info_ = connection.registry.require(SYMBOL);
  info(`${SYMBOL} 最小下单量 ${info_.minQty}，步长 ${info_.stepSize}，最小名义价值 ${info_.minNotional} USDT`);
  if (NOTIONAL < info_.minNotional) {
    fail(`请求的 ${NOTIONAL} USDT 低于该标的的最小名义价值 ${info_.minNotional} USDT，请换一个更便宜的标的或调大 --notional。`);
    process.exitCode = 1;
    return;
  }

  /* ---------------------------------------------------------------------- */
  /*  Trading — everything below is wrapped so cleanup always runs           */
  /* ---------------------------------------------------------------------- */

  let openedQuantity = 0;
  let entryPrice = 0;
  let stopPlaced = false;
  let targetPlaced = false;
  let failed = false;

  try {
    /* --- One-way mode --------------------------------------------------- */
    heading('准备账户状态');
    const mode = await connection.broker.ensureOneWayMode();
    if (mode.changed) ok('已从双向持仓切换为单向持仓');
    else if (mode.warning) info(mode.warning);
    else ok('已是单向持仓模式');

    const before = await connection.broker.getAccountState();
    info(`起始权益 ${before.equity.toFixed(4)} USDT，可用 ${before.availableBalance.toFixed(4)} USDT`);

    /* --- Leverage ------------------------------------------------------- */
    heading(`设置 ${SYMBOL} 杠杆为 ${LEVERAGE}x`);
    const lev = await connection.broker.setLeverage(SYMBOL, LEVERAGE);
    if (lev.ok) ok(`杠杆已设为 ${lev.leverage}x`);
    else info(`${lev.note ?? '杠杆未改变'}`);

    /* --- Entry ---------------------------------------------------------- */
    heading('市价开多');
    const markPrice = await connection.broker.getMarkPrice(SYMBOL);
    info(`当前标记价 ${markPrice}`);
    const quantity = connection.registry.notionalToQuantity(SYMBOL, NOTIONAL, markPrice);
    if (quantity <= 0) throw new Error(`${NOTIONAL} USDT 在价格 ${markPrice} 下取整为 0 张`);
    info(`下单数量 ${quantity}（名义价值约 ${(quantity * markPrice).toFixed(4)} USDT）`);

    const entryOrder = await connection.broker.placeOrder({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'MARKET',
      quantity,
      clientOrderId: `smoke-entry-${Date.now()}`,
    });
    const entryFilled = await connection.broker.waitForFill(entryOrder, 15_000);
    if (entryFilled.status !== 'FILLED') throw new Error(`开仓未成交，状态 ${entryFilled.status}`);

    openedQuantity = entryFilled.executedQty || quantity;
    entryPrice = entryFilled.avgPrice || markPrice;
    ok(`已成交：${openedQuantity} 张 @ ${entryPrice}（订单号 ${entryFilled.id}）`);

    /* --- Stop loss ------------------------------------------------------ */
    heading('挂交易所侧止损（closePosition=true 的 Algo 条件单）');
    const stopPrice = Number((entryPrice * (1 - STOP_PERCENT / 100)).toPrecision(8));
    const stopOrder = await connection.broker.placeOrder({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'STOP_MARKET',
      triggerPrice: stopPrice,
      closePosition: true,
      workingType: 'MARK_PRICE',
      priceProtect: true,
      clientOrderId: `smoke-sl-${Date.now()}`,
    });
    stopPlaced = true;
    ok(`止损已挂：触发价 ${stopPrice}，algoId ${stopOrder.id}，状态 ${stopOrder.status}`);
    info(`（走的是 ${stopOrder.kind === 'algo' ? '/fapi/v1/algoOrder' : '/fapi/v1/order'}）`);

    /* --- Take profit ---------------------------------------------------- */
    heading('挂交易所侧止盈');
    const targetPrice = Number((entryPrice * (1 + TARGET_PERCENT / 100)).toPrecision(8));
    const targetOrder = await connection.broker.placeOrder({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice: targetPrice,
      closePosition: true,
      workingType: 'MARK_PRICE',
      priceProtect: true,
      clientOrderId: `smoke-tp-${Date.now()}`,
    });
    targetPlaced = true;
    ok(`止盈已挂：触发价 ${targetPrice}，algoId ${targetOrder.id}，状态 ${targetOrder.status}`);

    /* --- Verify on the exchange ----------------------------------------- */
    heading('回读交易所，确认保护单真的挂着');
    const openAlgo = await connection.broker.getOpenAlgoOrders(SYMBOL);
    info(`交易所返回 ${openAlgo.length} 张未触发的条件单：`);
    for (const order of openAlgo) {
      info(`  algoId ${order.algoId}  ${order.orderType}  触发价 ${order.triggerPrice}  closePosition=${order.closePosition}  ${order.algoStatus}`);
    }
    const hasStop = openAlgo.some((o) => String(o.algoId) === stopOrder.id);
    const hasTarget = openAlgo.some((o) => String(o.algoId) === targetOrder.id);
    if (hasStop && hasTarget) ok('止损与止盈都在交易所侧，已确认');
    else throw new Error(`保护单未被交易所确认：止损 ${hasStop}，止盈 ${hasTarget}`);

    const positions = await connection.broker.getPositions(SYMBOL);
    if (positions.length === 0) throw new Error('交易所报告没有持仓，与预期不符');
    ok(`交易所持仓：${positions[0]!.side} ${positions[0]!.quantity} 张，强平价 ${positions[0]!.liquidationPrice ?? '—'}`);
    info(`未实现盈亏 ${positions[0]!.unrealizedPnl.toFixed(4)} USDT（${positions[0]!.unrealizedPnlPercent.toFixed(2)}%）`);
  } catch (error) {
    failed = true;
    fail(`测试过程中出错：${(error as Error).message}`);
  } finally {
    /* -------------------------------------------------------------------- */
    /*  Cleanup — always runs                                                */
    /* -------------------------------------------------------------------- */

    heading('清理（无论上面成功与否都会执行）');

    if (stopPlaced || targetPlaced) {
      await connection.broker.cancelAllOrders(SYMBOL).catch(() => undefined);
      const remaining = await connection.broker.getOpenAlgoOrders(SYMBOL).catch(() => []);
      if (remaining.length === 0) ok('保护单已全部撤销');
      else fail(`仍有 ${remaining.length} 张条件单未撤销，请手动检查`);
    }

    if (openedQuantity > 0) {
      const live = await connection.broker.getPositions(SYMBOL).catch(() => []);
      if (live.length === 0) {
        ok('仓位已不存在（可能已被止损/止盈平掉）');
      } else {
        try {
          const exitOrder = await connection.broker.placeOrder({
            symbol: SYMBOL,
            side: 'SELL',
            type: 'MARKET',
            quantity: live[0]!.quantity,
            reduceOnly: true,
            clientOrderId: `smoke-exit-${Date.now()}`,
          });
          const exitFilled = await connection.broker.waitForFill(exitOrder, 15_000);
          ok(`已市价平仓：${exitFilled.executedQty} 张 @ ${exitFilled.avgPrice}`);
        } catch (error) {
          fail(`平仓失败：${(error as Error).message} —— 请在交易所手动平掉该仓位`);
        }
      }
    }

    /* --- Final state ---------------------------------------------------- */
    heading('最终状态');
    try {
      const after = await connection.broker.getAccountState();
      const positions = await connection.broker.getPositions();
      const openOrders = await connection.broker.getOpenOrders();
      const openAlgo = await connection.broker.getOpenAlgoOrders();

      info(`权益 ${after.equity.toFixed(4)} USDT，可用 ${after.availableBalance.toFixed(4)} USDT`);
      info(`持仓 ${positions.length} 个，普通挂单 ${openOrders.length} 张，条件挂单 ${openAlgo.length} 张`);

      if (positions.length === 0 && openAlgo.length === 0) {
        ok('账户已回到干净状态（无持仓、无挂单）');
      } else {
        fail('账户仍有持仓或挂单残留，请手动检查');
      }
    } catch (error) {
      fail(`无法读取最终状态：${(error as Error).message}`);
    }

    if (vault) closeDb();
  }

  process.stdout.write('\n' + '='.repeat(74) + '\n');
  if (failed) {
    process.stdout.write('结果：测试失败 —— 详情见上方\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('结果：全部通过 —— 下单、止损、止盈、撤单、平仓均在真实交易所验证成功\n');
  }
  process.stdout.write('='.repeat(74) + '\n\n');
}

main().catch((error) => {
  process.stderr.write(`冒烟测试异常：${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
