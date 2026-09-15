import { createLogger } from '../logger.js';
import { fetchBalanceSnapshot, type AccountBalanceSnapshot } from '../binance/account.js';
import { BinanceRest, type BinanceRestOptions } from '../binance/rest.js';
import { resolveEndpoints, type BinanceEnvironment } from '../binance/endpoints.js';
import type { Vault } from '../crypto/vault.js';
import { exchanges } from '../store/repositories.js';

const log = createLogger('balance');

/* -------------------------------------------------------------------------- */
/*  Result                                                                     */
/* -------------------------------------------------------------------------- */

export type BalanceResult =
  | { ok: true; balance: AccountBalanceSnapshot; cached: boolean }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/*  Service                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reads and caches exchange account balances for display.
 *
 * Two things make this worth its own service rather than a call site:
 *
 *  1. **Cost.** The console polls, and the obvious implementation —
 *     `connectExchange()` then `broker.getAccountState()` — costs three signed
 *     requests per refresh (time sync, `exchangeInfo`, account) because it builds
 *     a full symbol registry that a balance read does not need. This uses a bare
 *     REST client instead: **one** request per refresh.
 *  2. **Clock offset.** Binance rejects a signature whose timestamp has drifted.
 *     Each account keeps its own long-lived `BinanceRest`, so the synced offset
 *     is reused across refreshes rather than re-derived every time.
 *
 * Errors are values, not exceptions: one bad credential must not break the
 * credentials list, it should render as "余额读取失败" on that row alone.
 */
export class BalanceService {
  /** Long-lived REST client per account, so the clock offset survives. */
  private readonly clients = new Map<number, { rest: BinanceRest; fingerprint: string }>();
  private readonly cache = new Map<number, { at: number; result: BalanceResult }>();

  constructor(
    private readonly vault: Vault,
    /** How long a cached reading stays fresh. */
    private readonly ttlMs = 20_000,
  ) {}

  /**
   * Read an account's balance, from cache when it is fresh.
   *
   * `force` bypasses the cache — used by an explicit refresh button, where the
   * operator is asking for "now" and a stale number would be a lie.
   */
  async get(accountId: number, options: { force?: boolean } = {}): Promise<BalanceResult> {
    const cached = this.cache.get(accountId);
    if (!options.force && cached && Date.now() - cached.at < this.ttlMs) {
      // Re-shape the cached value so callers can tell it was not a fresh read.
      return cached.result.ok ? { ...cached.result, cached: true } : cached.result;
    }

    const result = await this.read(accountId);
    this.cache.set(accountId, { at: Date.now(), result });
    return result;
  }

  /** Drop a cached reading, e.g. after the credential is edited. */
  invalidate(accountId: number): void {
    this.cache.delete(accountId);
    // The stored key may have changed, so the client must be rebuilt too.
    this.clients.delete(accountId);
  }

  invalidateAll(): void {
    this.cache.clear();
    this.clients.clear();
  }

  private clientFor(accountId: number): BinanceRest | null {
    const row = exchanges.getWithSecret(accountId);
    if (!row) return null;

    let apiSecret: string;
    try {
      apiSecret = this.vault.decrypt(row.api_secret_enc);
    } catch (error) {
      log.warn(`无法解密账户 ${accountId} 的凭据：${(error as Error).message}`);
      return null;
    }
    if (!apiSecret) return null;

    // Rebuild only when the key material or environment actually changed.
    const fingerprint = `${row.api_key}:${apiSecret.length}:${row.testnet}`;
    const existing = this.clients.get(accountId);
    if (existing && existing.fingerprint === fingerprint) return existing.rest;

    const environment: BinanceEnvironment = row.testnet === 1 ? 'demo' : 'production';
    const options: BinanceRestOptions = {
      environment,
      apiKey: row.api_key,
      apiSecret,
      // A balance read should fail fast rather than hold up the whole list.
      timeoutMs: 12_000,
      maxRetries: 1,
    };
    const rest = new BinanceRest(options);
    this.clients.set(accountId, { rest, fingerprint });
    return rest;
  }

  private async read(accountId: number): Promise<BalanceResult> {
    const row = exchanges.getWithSecret(accountId);
    if (!row) return { ok: false, error: '找不到该交易所账户' };

    const rest = this.clientFor(accountId);
    if (!rest) return { ok: false, error: '无法读取该账户的 API 凭据' };

    try {
      // Cheap and cached internally: re-syncs at most once a minute, and only
      // when the offset is actually stale.
      await rest.syncTime();
    } catch (error) {
      return { ok: false, error: `无法连接交易所：${(error as Error).message}` };
    }

    const snapshot = await fetchBalanceSnapshot(rest);
    if (!snapshot.ok) return snapshot;
    return { ok: true, balance: snapshot.balance, cached: false };
  }

  /** Read every account in parallel. Failures are per-account. */
  async getAll(options: { force?: boolean } = {}): Promise<Map<number, BalanceResult>> {
    const accounts = exchanges.list();
    const entries = await Promise.all(
      accounts.map(async (account) => [account.id, await this.get(account.id, options)] as const),
    );
    return new Map(entries);
  }

  /**
   * The wallet balance of an account, used to seed a new trader's starting
   * equity. Returns `null` when it cannot be read, so the caller can decide
   * whether to fall back or refuse.
   */
  async walletBalanceOf(accountId: number): Promise<number | null> {
    const result = await this.get(accountId, { force: true });
    return result.ok ? result.balance.walletBalance : null;
  }
}

export { resolveEndpoints };
