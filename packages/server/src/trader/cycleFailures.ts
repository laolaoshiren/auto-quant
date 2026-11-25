/**
 * 决策周期失败原因与熔断裁决的中文表述（从 `autoTrader.ts` 阶段 1 纯搬抽出，文本逐字一致）。
 */
import type { StrategyConfig } from '@aq/shared';

import { BinanceApiError } from '../binance/types.js';
import { LlmError } from '../llm/errors.js';
import type { CircuitBreakerVerdict } from '../risk/engine.js';

/** 失败发生在周期的哪一段，仅在错误类型本身区分不开时作最后一级归类。 */
export type CycleFailurePhase =
  | 'bookkeeping'
  | 'market'
  | 'model'
  | 'parse'
  | 'risk'
  | 'execute';

const FAILURE_DETAIL_LIMIT = 300;

function clipDetail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '未提供错误详情';
  return flat.length > FAILURE_DETAIL_LIMIT ? `${flat.slice(0, FAILURE_DETAIL_LIMIT)}…` : flat;
}

function detailOf(error: unknown): string {
  if (error instanceof Error) return clipDetail(error.message);
  return clipDetail(String(error));
}

function looksLikeEmptyCompletion(error: LlmError): boolean {
  return error.status === null && /no assistant text/i.test(error.message);
}

/**
 * 一次失败的周期，该对操作员说什么（第一个全角冒号之前为固定类别名，供决策流元数据行提取）。
 */
export function describeCycleFailure(error: unknown, phase: CycleFailurePhase): string {
  if (error instanceof LlmError) {
    const detail = detailOf(error);
    switch (error.kind) {
      case 'quota_exhausted':
        return `AI 服务额度不足：${detail}。服务商已经把这条密钥判定为没有余额或没有额度，机器人在充值前每一轮决策都会失败 —— 请先在服务商后台充值或提高额度；充值后无需重启机器人，下一轮会自动恢复。`;
      case 'auth':
        return `AI 服务拒绝：${detail}。通常是 API Key 无效、已过期或被停用，请在控制台「设置 → AI 模型」里更新密钥。`;
      case 'permission':
        return `AI 服务拒绝：${detail}。这把密钥没有调用该模型的权限，请确认密钥权限或改用其他模型。`;
      case 'not_found':
        return `AI 服务拒绝：${detail}。配置的模型名在服务商侧不存在或已下线，请在控制台改用可用的模型。`;
      case 'bad_request':
        return `AI 服务拒绝：请求参数错误（${detail}）。请求被 AI 服务判定为参数异常，本轮没有产生任何决策；请检查模型名、温度与最大输出 Token 的配置，若反复出现请联系模型服务商。`;
      case 'content_filter':
        return `AI 服务拒绝：${detail}。模型侧的内容审核拦下了本次请求，一般下一轮就会恢复；若持续出现，请检查提示词与行情数据里是否有异常内容。`;
      case 'rate_limit':
      case 'overloaded':
      case 'server':
      case 'timeout': {
        const which =
          error.kind === 'rate_limit'
            ? '被限流'
            : error.kind === 'overloaded'
              ? '服务商过载'
              : error.kind === 'server'
                ? '服务商 5xx'
                : '请求超时';
        const http = typeof error.status === 'number' ? `HTTP ${error.status}` : '无 HTTP 状态';
        const advice =
          error.kind === 'timeout'
            ? '**注意：这一类的责任在我们这边** —— 请求没有在配置的时限内拿到响应，' +
              '通常意味着单次请求太大或模型推理太久，而不是上游挂了。' +
              '机器人在下一轮会重试；若反复出现，可考虑调小候选池或提高该模型的超时配置。'
            : '这是服务商侧的临时故障，机器人下一轮会自动重试，通常不需要人工处理。';
        return `AI 服务不可用：${which}（${http}）—— ${detail}。${advice}`;
      }
      case 'unknown':
        return looksLikeEmptyCompletion(error)
          ? `AI 响应无法解析：${detail}。模型返回了 HTTP 成功但没有任何可用文本（推理过程耗尽输出预算、或内容被审核掉都可能这样），本轮没有决策；机器人会在下一轮重新提问。`
          : `AI 服务不可用：${detail}。这次请求没有拿到模型的响应（网络不可达、被取消或响应异常），机器人下一轮会自动重试。`;
    }
  }

  if (error instanceof BinanceApiError) {
    const detail = detailOf(error);
    if (error.isInsufficientMargin) {
      return `交易所拒绝：保证金不足（${detail}）。这笔订单没有成交；请降低仓位比例或少开几个仓位，风控会按最新可用余额重算额度。`;
    }
    if (error.isRateLimited) {
      return `交易所限流：${detail}。请求过快或已被临时限制，机器人下一轮会自动重试。`;
    }
    if (error.isTimestampError) {
      return `交易所拒绝：请求时间戳超出接收窗口（${detail}）。服务器时钟需要与交易所同步，否则每一笔下单都会被拒。`;
    }
    if (error.isFilterError) {
      return `交易所拒绝：订单参数不符合该标的的交易规则（${detail}）。这通常是数量 / 价格的取整或最小名义价值问题，订单没有成交。`;
    }
    return `交易所拒绝：${detail}。这笔订单没有得到交易所确认；原始响应与错误码已记入订单表，可据此判断是否需要人工干预。`;
  }

  const detail = detailOf(error);

  if (error instanceof SyntaxError) {
    return `AI 响应无法解析：${detail}。模型返回的内容不是合法 JSON（可能被截断或混入了说明文字），本轮没有决策；机器人会在下一轮重新提问。`;
  }

  switch (phase) {
    case 'market':
      return `行情数据不可用：${detail}。本轮取不到可用行情，因此没有向模型提问、也没有下单；通常是交易所行情接口暂时失败，机器人会在下一轮重试。`;
    case 'model':
      return `AI 服务不可用：${detail}。调用模型时出错，且这个错误不属于已知的服务商故障类型；机器人会在下一轮重试。若持续出现，请检查网络与模型配置。`;
    case 'parse':
      return `AI 响应无法解析：${detail}。模型返回的内容无法解析成决策，本轮没有决策。`;
    case 'risk':
      return `决策处理失败：${detail}。本轮在风控裁决环节抛出异常，没有下任何单；这属于程序内部故障，请结合运行日志排查（该周期的提示词与模型返回已保存在这条记录里）。`;
    case 'execute':
      return `交易所下单失败：${detail}。这笔订单没有得到交易所确认，可能并未成交；请核对交易所的持仓与挂单，机器人下一轮会重新对账。`;
    case 'bookkeeping':
      return `未知错误：${detail}。本轮在账务 / 对账环节失败，且错误不属于已知的模型、行情或交易所类别；该周期已经拿到的提示词与执行记录已尽量保存，请结合运行日志排查。`;
  }
}

/** 把熔断裁决转成给操作员看的一句话（决策流与 `/stats` 共用，防两处口径漂移）。 */
export function describeBreaker(verdict: CircuitBreakerVerdict, config: StrategyConfig): string {
  if (!verdict.blocked) return '';
  return verdict.kind === 'total_drawdown'
    ? `${verdict.reason}注意：总回撤熔断不按日重置 —— 它要等权益回到最高水位以下 ` +
        `${config.circuitBreaker.maxTotalDrawdownPercent}% 以内才会解除，` +
        '而空仓时权益不会自己变化，所以它不会自行恢复。' +
        '要不要继续交易需要操作员决定（例如入金，或调整这一上限）。'
    : `${verdict.reason}单日亏损熔断按日结算，跨过零点后自动恢复。`;
}
