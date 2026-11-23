import type { ExchangeId } from '@aq/shared';
import type { ExchangeAccountInput } from '../../lib/api';

export interface AccountDraft {
  /*
   * `ExchangeId`（binance / gate）来自 `@aq/shared` —— 新增交易所时这里不用改。
   * 后端 `PATCH` 不收 `exchange`：创建后交易所不可更改（见表单里禁用的下拉）。
   */
  exchange: ExchangeId;
  label: string;
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  canTrade: boolean;
}

export const EMPTY_ACCOUNT: AccountDraft = {
  exchange: 'binance',
  label: '',
  apiKey: '',
  apiSecret: '',
  testnet: true,
  canTrade: true,
};

/**
 * 解析凭证最终保存的 `testnet` 环境标记：
 * - 币安：环境由进程级 `BINANCE_ENV`（`envTestnet`）决定；
 * - Gate：没有进程级环境开关，必须保留账户草稿自己的 `draftTestnet` ——
 *   在生产服务器上编辑 Gate 测试网凭证时，绝不能被 `envTestnet = false` 静默覆写成正式网。
 */
export function resolveDraftTestnet(
  exchange: ExchangeId,
  draftTestnet: boolean,
  envTestnet: boolean,
): boolean {
  return exchange === 'gate' ? draftTestnet : envTestnet;
}

/** 创建 / 草稿连接测试接口期望的完整载荷。 */
export function buildExchangeAccountCreatePayload(
  draft: AccountDraft,
  envTestnet: boolean,
): ExchangeAccountInput {
  return {
    exchange: draft.exchange,
    label: draft.label.trim() || draft.exchange,
    apiKey: draft.apiKey.trim(),
    apiSecret: draft.apiSecret,
    testnet: resolveDraftTestnet(draft.exchange, draft.testnet, envTestnet),
    canTrade: true,
  };
}

/** 编辑已有凭证时的 PATCH 载荷：密钥留空保持原样，且 Gate 保留自身的 `testnet` 选择。 */
export function buildExchangeAccountUpdatePayload(
  draft: AccountDraft,
  envTestnet: boolean,
): Partial<ExchangeAccountInput> {
  return {
    exchange: draft.exchange,
    label: draft.label.trim(),
    apiKey: draft.apiKey.trim() || undefined,
    ...(draft.apiSecret ? { apiSecret: draft.apiSecret } : {}),
    testnet: resolveDraftTestnet(draft.exchange, draft.testnet, envTestnet),
    canTrade: true,
  };
}
