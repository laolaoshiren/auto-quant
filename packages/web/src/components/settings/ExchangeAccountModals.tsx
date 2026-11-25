import type { ExchangeId } from '@aq/shared';
import type { ExchangeAccountRow, PreflightCheck } from '../../lib/api';
import type { AccountDraft } from './exchangeAccountDraft';
import { Badge, Button, ErrorNote, Field, Modal, Select, TextInput, cn } from '../ui';
import { CheckList } from '../Badges';
import { TRADING_ENV_LABEL, fmtAsset, fmtTime, tradingEnvLabel } from '../../lib/format';
import { checksPassed } from './ExchangeAccountCard';
import type { ExchangeOption } from './ExchangeBalanceRail';

export function ExchangeAccountFormModal({
  open,
  editing,
  draft,
  draftTestnet,
  exchanges,
  draftChecks,
  draftTestedAt,
  draftError,
  testingDraft,
  busy,
  onClose,
  onChangeDraft,
  onTestDraft,
  onSubmit,
}: {
  open: boolean;
  editing: ExchangeAccountRow | null;
  draft: AccountDraft;
  draftTestnet: boolean;
  exchanges: ExchangeOption[];
  draftChecks: PreflightCheck[] | null;
  draftTestedAt: number | null;
  draftError: string | null;
  testingDraft: boolean;
  busy: boolean;
  onClose: () => void;
  onChangeDraft: (next: AccountDraft) => void;
  onTestDraft: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `编辑“${editing.label}”` : '添加交易所凭证'}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" busy={testingDraft} onClick={onTestDraft}>
            测试连接
          </Button>
          <span className="mr-auto text-xs text-ink-faint">
            {draftChecks
              ? `${checksPassed(draftChecks) ? '检查通过' : '存在阻断项'}${
                  draftTestedAt ? ` · 测试于 ${fmtTime(new Date(draftTestedAt).toISOString())}` : ''
                }`
              : '保存前建议先测一次。'}
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" busy={busy} onClick={onSubmit}>
            {editing ? '保存凭证' : '添加凭证'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {editing && (
          <div className="rounded-md border border-base-700 bg-base-850/60 px-3 py-2 text-xs leading-relaxed text-ink-lo">
            正在编辑 <span className="text-ink-hi">{editing.label}</span>。已保存的密钥
            <span className="mx-1 text-ink-hi">不会回传到浏览器</span>
            —— 它只以掩码出现，因此这里的输入框是空的。留空即保持原密钥不变，只有粘贴新值才会替换。
          </div>
        )}

        <Field
          label="交易所"
          hint={
            editing
              ? '创建后不可更改交易所。'
              : exchanges.find((row) => row.id === draft.exchange)?.market
          }
        >
          <Select
            value={draft.exchange}
            disabled={editing !== null}
            onChange={(event) => {
              const next = event.target.value as ExchangeId;
              onChangeDraft({ ...draft, exchange: next, testnet: true });
            }}
          >
            {exchanges.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
                {row.available ? ` · ${row.market}` : '（联调中）'}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="名称"
          hint={
            draft.exchange === 'gate'
              ? '便于识别的名称 — 例如“Gate 测试网”“主账户”。'
              : '便于识别的名称 — 例如“币安模拟盘”“主账户”。'
          }
        >
          <TextInput value={draft.label} onChange={(event) => onChangeDraft({ ...draft, label: event.target.value })} />
        </Field>

        <Field label="API Key" hint={editing ? '留空则保留已存储的 Key。' : '在交易所后台创建，只勾选合约交易。'}>
          <TextInput
            className="num"
            value={draft.apiKey}
            onChange={(event) => onChangeDraft({ ...draft, apiKey: event.target.value })}
            placeholder={editing ? '留空保持不变' : '粘贴密钥'}
            autoComplete="off"
          />
        </Field>

        <Field
          label="API Secret"
          hint={editing ? '留空则保留已存储的密钥。' : '静态存储时加密，绝不会回传给浏览器。'}
        >
          <TextInput
            type="password"
            className="num"
            value={draft.apiSecret}
            onChange={(event) => onChangeDraft({ ...draft, apiSecret: event.target.value })}
            placeholder={editing ? '留空保持不变' : '粘贴密钥'}
            autoComplete="off"
          />
        </Field>

        {draft.exchange === 'gate' && (
          <div>
            <span className="field-label">交易环境</span>
            <div
              role="group"
              aria-label="交易环境"
              className="inline-flex rounded-md border border-base-700 bg-base-900 p-0.5"
            >
              {[
                { testnet: true, label: '测试网' },
                { testnet: false, label: '正式网' },
              ].map((option) => {
                const selected = draft.testnet === option.testnet;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onChangeDraft({ ...draft, testnet: option.testnet })}
                    className={cn(
                      'rounded px-3 py-1 text-base transition',
                      selected
                        ? option.testnet
                          ? 'bg-base-800 text-ink-hi'
                          : 'bg-warn/20 text-warn'
                        : 'text-ink-lo hover:text-ink-hi',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <span className="mt-1 block text-xs text-ink-faint">
              测试网=假钱、真实撮合（默认）；正式网=真实资金。
            </span>
          </div>
        )}

        {draftTestnet ? (
          <div className="rounded-md border border-base-700 bg-base-850/60 px-3 py-2 text-base leading-relaxed text-ink-lo">
            这是
            <span className="mx-1 text-ink-hi">
              {draft.exchange === 'gate' ? 'Gate 测试网' : TRADING_ENV_LABEL.long.testnet}
            </span>
            凭证：下单不会进入真实市场，但撮合与手续费按真实规则计算。
          </div>
        ) : (
          <div className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-base leading-relaxed text-warn">
            <span className="font-semibold">
              {draft.exchange === 'gate' ? 'Gate 正式网（真实资金）。' : `${TRADING_ENV_LABEL.long.live}。`}
            </span>
            保存后，使用该凭证的机器人会向真实市场提交真实订单，盈亏从账户里真实增减。
            请确认密钥已关闭提现权限，并尽量限制为服务器 IP。
          </div>
        )}

        {draftError && <ErrorNote>{draftError}</ErrorNote>}
        {draftChecks && (
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="panel-title">连接测试</span>
                <Badge tone={checksPassed(draftChecks) ? 'up' : 'down'}>
                  {checksPassed(draftChecks) ? '通过' : '未通过'}
                </Badge>
              </span>
              {draftTestedAt && (
                <span className="num text-xs text-ink-faint">
                  测试于 {fmtTime(new Date(draftTestedAt).toISOString())}
                </span>
              )}
            </div>
            <CheckList checks={draftChecks} />
          </div>
        )}

        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
          请使用已开启合约交易、但<span className="font-semibold">已禁用提现</span>的密钥。
          如果交易所支持，再按 IP 限制。
        </div>
      </div>
    </Modal>
  );
}

export function DeleteExchangeAccountModal({
  removing,
  exchangeLabel,
  busy,
  onClose,
  onConfirm,
}: {
  removing: ExchangeAccountRow | null;
  exchangeLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={removing !== null}
      onClose={onClose}
      title="删除交易所凭证"
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" busy={busy} onClick={onConfirm}>
            永久删除
          </Button>
        </>
      }
    >
      {removing && (
        <div className="space-y-3">
          <p className="text-base leading-relaxed text-ink-hi">
            即将永久删除凭证“<span className="font-semibold">{removing.label}</span>”（{exchangeLabel}
            ，{tradingEnvLabel(removing.testnet, 'short')}）。
          </p>
          <ul className="space-y-1.5 text-base leading-relaxed text-ink-lo">
            <li>• 服务端存储的 API Key 与加密后的 Secret 会一并删除，<span className="text-ink-hi">无法恢复</span>。</li>
            <li>• 仍在引用该凭证的机器人会失去交易所连接，无法开仓，也无法平掉已有持仓。</li>
            <li>• 已成交的历史订单与账本记录不受影响；若还要继续运行，请先把机器人改配到另一把凭证。</li>
            {!removing.testnet && (
              <li className="text-warn">• 这是主网凭证：删除后本终端将无法再对这个真实账户下单或平仓，请先到交易所确认持仓。</li>
            )}
          </ul>
          <p className="num text-xs text-ink-faint">
            最近一次读取的权益：
            {removing.balance ? fmtAsset(removing.balance.equity, removing.balance.asset) : '未读取到'}
          </p>
          <div className="rounded-md border border-base-750 bg-base-850/60 px-3 py-2 text-xs leading-relaxed text-ink-lo">
            交易所可能出于安全策略自动禁用被泄露的密钥；本操作不会在交易所侧撤销该密钥的权限，
            如需彻底失效请同时到交易所后台删除该 API Key。
          </div>
        </div>
      )}
    </Modal>
  );
}
