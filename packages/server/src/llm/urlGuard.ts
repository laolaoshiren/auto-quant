import { isIP } from 'node:net';

/**
 * 出站 URL 白名单：阻止把「自定义模型端点」当成 SSRF 跳板。
 *
 * 自定义 `baseUrl` 是**有意保留**的功能（自建网关、代理、私有部署的兼容接口），
 * 所以这里不能一刀切禁止自定义地址，只能挡住「内部目标」这一类。
 *
 * 为什么必须挡：控制台在反向代理后面（部署文档就是这么建议的），任何拿到会话的人
 * 都能把 `baseUrl` 指向 `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * —— 服务端会**真的发出这个请求**，并把响应体通过 `test-draft` 的探测结果、
 * 或交易循环的报错信息回显出来。云元数据服务返回的正是实例的临时凭据，
 * 于是「一个能登录控制台的人」升级成「拿到云主机凭据的人」。
 * `127.0.0.1` 同理：可以打到只监听本机的管理端口（Docker socket 代理、数据库、
 * 其他内部服务），而这些端口对操作员本人是**不可见**的。
 *
 * 已知不覆盖的情形：这里校验的是**字面主机**，不做 DNS 解析。
 * 一个公开域名如果解析到内网地址（DNS rebinding），本模块拦不住。
 * 要彻底封死需要在 socket 连接层校验解析结果，那是更大的改动，见报告中的说明。
 */

export interface UrlGuardVerdict {
  allowed: boolean;
  /** 面向操作员的中文原因，仅在 `allowed === false` 时有值。 */
  reason?: string;
}

const IPV4_BLOCKED_REASONS = {
  unspecified: '未指定地址 0.0.0.0/8',
  loopback: '回环地址 127.0.0.0/8',
  private10: '私有地址 10.0.0.0/8',
  private172: '私有地址 172.16.0.0/12',
  private192: '私有地址 192.168.0.0/16',
  linkLocal: '链路本地地址 169.254.0.0/16（云元数据服务 169.254.169.254 就在这里）',
  cgnat: '运营商级 NAT 地址 100.64.0.0/10（部分云元数据服务在此，如 100.100.100.200）',
  reserved: '组播或保留地址 224.0.0.0/4 及以上',
} as const;

/** 严格 dotted-quad。URL 解析器会把 `2130706433` / `0x7f.1` 这类写法归一成这种形式。 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function blockedIpv4Reason(bytes: readonly number[]): string | null {
  const a = bytes[0]!;
  const b = bytes[1]!;
  if (a === 0) return IPV4_BLOCKED_REASONS.unspecified;
  if (a === 127) return IPV4_BLOCKED_REASONS.loopback;
  if (a === 10) return IPV4_BLOCKED_REASONS.private10;
  if (a === 172 && b >= 16 && b <= 31) return IPV4_BLOCKED_REASONS.private172;
  if (a === 192 && b === 168) return IPV4_BLOCKED_REASONS.private192;
  if (a === 169 && b === 254) return IPV4_BLOCKED_REASONS.linkLocal;
  if (a === 100 && b >= 64 && b <= 127) return IPV4_BLOCKED_REASONS.cgnat;
  if (a >= 224) return IPV4_BLOCKED_REASONS.reserved;
  return null;
}

/**
 * IPv6 文本 → 16 字节。
 *
 * 必须自己做而不是靠字符串前缀匹配：WHATWG URL 会把 `[::ffff:169.254.169.254]`
 * 归一成 `[::ffff:a9fe:a9fe]`，只看开头几个字符的朴素实现会漏掉这条例最常用的绕过。
 */
function parseIpv6(host: string): number[] | null {
  // URL 的 IPv6 主机带方括号；zone id（%eth0）对出站请求无意义，直接丢弃。
  const text = host.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? '';
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const groups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const out: number[] = [];
    for (const group of segment.split(':')) {
      if (group.includes('.')) {
        const v4 = parseIpv4(group);
        if (!v4) return null;
        out.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = groups(halves[0] ?? '');
  if (!head) return null;

  let full: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    full = head;
  } else {
    const tail = groups(halves[1] ?? '');
    if (!tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    full = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }

  return full.flatMap((group) => [group >> 8, group & 0xff]);
}

function blockedIpv6Reason(bytes: readonly number[]): string | null {
  const empty = (from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0);

  // :: 与 ::1
  if (empty(0, 15) && (bytes[15] === 0 || bytes[15] === 1)) return '回环/未指定地址 ::1 或 ::';
  // IPv4-mapped（::ffff:a.b.c.d）与 IPv4-compatible（::a.b.c.d）：按内嵌的 IPv4 判定
  if (empty(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return blockedIpv4Reason(bytes.slice(12));
  }
  if (empty(0, 12)) return blockedIpv4Reason(bytes.slice(12));
  // NAT64 64:ff9b::/96 —— 前缀本身是公网地址，但内嵌的 IPv4 可以是 169.254.169.254
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && empty(4, 12)) {
    return blockedIpv4Reason(bytes.slice(12));
  }
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return '链路本地地址 fe80::/10';
  if ((bytes[0]! & 0xfe) === 0xfc) return '唯一本地地址 fc00::/7';
  if (bytes[0] === 0xff) return '组播地址 ff00::/8';
  return null;
}

/**
 * 判断一个出站 `baseUrl` 是否允许。
 *
 * 只允许 http / https：`file:`、`gopher:` 这类协议在别的组件里可能被当成读取原语。
 * http 保留是因为自建网关与内网反代经常没有证书，而这里已经按地址挡掉了内网目标。
 */
export function checkOutboundUrl(raw: string): UrlGuardVerdict {
  const trimmed = raw.trim();
  if (!trimmed) return { allowed: false, reason: '地址为空。' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { allowed: false, reason: '不是合法的 URL。' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `只允许 http / https 协议，收到的是 ${url.protocol.replace(':', '')}。` };
  }

  // 末尾的点是合法的 FQDN 写法（`localhost.`），不处理就等于白名单被绕过
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { allowed: false, reason: '地址里没有主机名。' };

  const literal = host.replace(/^\[/, '').replace(/\]$/, '');
  const family = isIP(literal);

  if (family === 4) {
    const bytes = parseIpv4(literal);
    const reason = bytes ? blockedIpv4Reason(bytes) : null;
    return reason ? { allowed: false, reason } : { allowed: true };
  }
  if (family === 6) {
    const bytes = parseIpv6(host);
    const reason = bytes ? blockedIpv6Reason(bytes) : null;
    return reason ? { allowed: false, reason } : { allowed: true };
  }

  // 主机名：这些后缀不可能指向一个合法的公网 LLM 端点，
  // 但它们经常指向内网服务或云厂商的元数据别名（metadata.google.internal）。
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { allowed: false, reason: '目标是本机（localhost）。' };
  }
  for (const suffix of ['.internal', '.local', '.home.arpa']) {
    if (host.endsWith(suffix)) {
      return { allowed: false, reason: `目标主机名属于内部 DNS（${suffix}）。` };
    }
  }

  return { allowed: true };
}

/** 允许则返回裁剪后的地址，否则抛出中文错误（调用方直接回显给操作员）。 */
export function assertOutboundUrlAllowed(raw: string): string {
  const verdict = checkOutboundUrl(raw);
  if (!verdict.allowed) {
    throw new Error(`baseUrl 不被允许：${verdict.reason}`);
  }
  return raw.trim();
}
