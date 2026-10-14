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
 * ## DNS rebinding —— 已在**连接层**封死（2026-10-14，外部 issue #126）
 *
 * ⚠️ **本模块（`checkOutboundUrl`）本身仍然只判字面主机** —— 这一点没变，
 * 因为它在 `fetch` 之前运行，而真实 IP 要等连接时才确定。
 *
 * 但那条缺口不再敞着：`llm/http.ts` 的 `fetchGuarded` 给 undici 装了一个
 * `connect.lookup` 钩子，**在真正建立连接前**拿到解析结果、用
 * `checkResolvedAddress()`（就是下面那个函数）过同一套网段规则，
 * 不通过就以 `ENOTFOUND` 失败。
 *
 * 为什么必须是连接层：方案 A（在 `checkOutboundUrl` 里额外 `dns.lookup` 一次）
 * 挡不住 TTL=0 的经典 rebinding —— 它与连接是**两次独立的查询**，
 * 中间可以换答案。只有在连接层校验才没有那个时间差。
 *
 * ## 仍然不覆盖的情形（诚实边界，别删）
 *
 * · **`allowPrivateHosts` 里显式登记的目标**：那是操作员的决定，连接层同样放行 ——
 *   登记一个会 rebinding 的域名等于自己把门打开，这是配置问题不是代码问题；
 * · **同一进程内其它不经 `fetchGuarded` 的出站**（若有）：本模块管不到。
 *   新增出站路径时**必须**走 `fetchGuarded`，否则连接层校验不会被应用；
 * · **TLS 层**：这里判的是"连到哪个 IP"，不管证书是谁签的。
 *
 * 保留这段边界说明是**刻意的**：它的价值在于让后来人知道防线画在哪 ——
 * 删掉它比留着它危险。issue #126 的作者也专门叮嘱了这一点。
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
  ietfProtocolAssignments: 'IETF 协议分配段 192.0.0.0/24（Oracle Cloud 元数据服务 192.0.0.192 在这里）',
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
  /*
   * 192.0.0.0/24 —— IETF 协议分配段。
   *
   * Oracle Cloud 的实例元数据服务（`192.0.0.192`）在这里，而它与 `169.254.169.254`
   * 是同一类风险：**无需认证**就把实例凭据吐给本机上的请求者。AWS / 阿里 / GCP
   * 三条都早已在表里（分别是 169.254.169.254 与 100.100.100.200），唯独 OCI 漏了 ——
   * 而这个项目的部署文档并不限定云厂商。
   *
   * 整段都挡：`192.0.0.x` 之外这个段没有别的合法用途，逐个列端点反而会漏。
   */
  if (a === 192 && b === 0) return IPV4_BLOCKED_REASONS.ietfProtocolAssignments;
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
  /*
   * SIIT 写法（`::ffff:0:a.b.c.d`）—— 同一个 IPv4 的另一种字节布局：ffff 落在
   * byte 8-9 而不是 10-11（RFC 6145 的无状态转换形式）。常规协议栈**不会**把它
   * 当回环落地（Windows/Linux 的 `ipv6_addr_v4mapped()` 都只认 byte 10-11），
   * 但部署在真做 SIIT/NAT64 转换的网络里时它会路由 —— 纵深防御不该赌部署环境，
   * 识别成本只是多一条分支。
   */
  if (empty(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && empty(10, 12)) {
    return blockedIpv4Reason(bytes.slice(12));
  }
  if (empty(0, 12)) return blockedIpv4Reason(bytes.slice(12));
  /*
   * NAT64 —— RFC 6052 允许嵌入位置随前缀长度移动：`64:ff9b::/96` 把 IPv4 放在
   * 最后 32 位，RFC 8215 的本地用途前缀 `64:ff9b:1::/48` 放在 byte 6-9。
   * 只认 /96 的话，写 `64:ff9b:1::/48` 前缀的部署就整段绕过。
   *
   * ⚠️ 「/96」与更短前缀必须分开判，因为「这一段全零」的含义不同：
   *   · /96：byte 4-11 由前缀本身保证全零，IPv4 只会落在 byte 12-15，那一段
   *     全零**确实代表内嵌了 0.0.0.0** → 该拒。
   *   · 更短前缀（/48 等）：IPv4 可能落在 byte 6-9 **或** byte 12-15，一段全零
   *     只意味着「IPv4 没放在这一段」，不是内嵌 0.0.0.0。若把全零也交给
   *     `blockedIpv4Reason`，它会返回「未指定地址」，于是**误伤所有内嵌公网的
   *     /48 地址**（`64:ff9b:1:8888:8888::` 内嵌 136.136.136.136 也被拒），
   *     NAT64 部署下的 LLM 请求会全部失败。
   *
   * 这里不赌"操作员用的是哪种前缀"：**只要开头是 64:ff9b**（这个 /32 整段被
   * IANA 保留给 NAT64，公网地址不会长这样），/96 走精确判定，其余按两个可能
   * 嵌入位置查，且全零段视为「未内嵌」跳过。
   */
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (empty(4, 12)) return blockedIpv4Reason(bytes.slice(12)); // /96：byte 12-15 全零确实该判 0.0.0.0
    // 更短前缀：某段全零 = IPv4 不在这里，不是内嵌 0.0.0.0，必须跳过而非拒绝。
    const embeddedIpv4Reason = (seg: readonly number[]): string | null =>
      seg.every((x) => x === 0) ? null : blockedIpv4Reason(seg);
    return embeddedIpv4Reason(bytes.slice(12)) ?? embeddedIpv4Reason(bytes.slice(6, 10));
  }
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return '链路本地地址 fe80::/10';
  if ((bytes[0]! & 0xfe) === 0xfc) return '唯一本地地址 fc00::/7';
  if (bytes[0] === 0xff) return '组播地址 ff00::/8';
  return null;
}

/**
 * 解析"允许访问的内网主机"清单。
 *
 * ## 为什么需要它（2026-10-11，用户的实际需求）
 *
 * 用户要把 `baseUrl` 指向**自己内网里的 LLM 服务**（`http://172.19.0.1:8317/v1`），
 * 被本模块的私网规则挡住了。而**自建网关 / 私有部署**正是这个白名单一开始就
 * 明确保留支持的场景（见文件头注释）。
 *
 * ## 为什么不是"直接放开私网"
 *
 * 那会把**云元数据**那条路一起放开 —— 文件头注释里写的
 * `169.254.169.254/latest/meta-data/...` 正是要挡的东西：
 * 一个能登录控制台的人会因此拿到云主机的临时凭据。
 *
 * 所以做成**显式声明**：默认仍然全挡，只有操作员亲手写进来的目标才放行。
 * 一个"我允许访问 172.19.0.1"的声明，不会顺带允许 169.254.169.254。
 *
 * ## 支持的写法
 *
 *   `172.19.0.1`      精确主机
 *   `172.19.0.0/16`   IPv4 CIDR
 *   `.corp.lan`       域名后缀（与上面被挡的 `.internal` 等同一形式）
 *   `my-gateway`      精确主机名
 *
 * 逗号或空白分隔。
 */
export function parseHostAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''))
    .filter((entry) => entry.length > 0);
}

/** IPv4 CIDR 匹配（只支持 IPv4 —— 内网白名单够用，且 IPv6 的掩码语义更易写错）。 */
function ipv4InCidr(bytes: readonly number[], cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  if (base === undefined || bitsText === undefined) return false;
  const baseBytes = parseIpv4(base);
  if (!baseBytes) return false;
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  let remaining = bits;
  for (let i = 0; i < 4; i += 1) {
    const take = Math.min(8, Math.max(0, remaining));
    remaining -= take;
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((bytes[i]! & mask) !== (baseBytes[i]! & mask)) return false;
  }
  return true;
}

/**
 * 这个主机是否在操作员声明的白名单里。
 *
 * ⚠️ **只用来放行"私网/内部"这一类拒绝** —— 协议校验、空主机名校验
 * 在这之前就已经返回了，白名单不能绕过它们。
 */
function hostIsAllowlisted(
  host: string,
  literal: string,
  family: number,
  list: readonly string[],
): boolean {
  if (list.length === 0) return false;
  const bytes = family === 4 ? parseIpv4(literal) : null;
  for (const entry of list) {
    if (entry.startsWith('.')) {
      if (host.endsWith(entry)) return true;
      continue;
    }
    if (entry.includes('/')) {
      if (bytes && ipv4InCidr(bytes, entry)) return true;
      continue;
    }
    if (host === entry || literal === entry) return true;
  }
  return false;
}

/**
 * 判断一个出站 `baseUrl` 是否允许。
 *
 * 只允许 http / https：`file:`、`gopher:` 这类协议在别的组件里可能被当成读取原语。
 * http 保留是因为自建网关与内网反代经常没有证书，而这里已经按地址挡掉了内网目标。
 *
 * `allowPrivateHosts` 是**操作员显式声明的内网目标**（见 `parseHostAllowlist`）；
 * 不传 = 行为与从前完全一致（全挡）。
 */
export function checkOutboundUrl(raw: string, allowPrivateHosts: readonly string[] = []): UrlGuardVerdict {
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
    /* 操作员显式放行的内网目标：**只在这里放行**，协议与空主机名的检查已经在上面做过。 */
    if (reason && hostIsAllowlisted(host, literal, family, allowPrivateHosts)) return { allowed: true };
    return reason ? { allowed: false, reason } : { allowed: true };
  }
  if (family === 6) {
    const bytes = parseIpv6(host);
    const reason = bytes ? blockedIpv6Reason(bytes) : null;
    if (reason && hostIsAllowlisted(host, literal, family, allowPrivateHosts)) return { allowed: true };
    return reason ? { allowed: false, reason } : { allowed: true };
  }

  // 主机名：这些后缀不可能指向一个合法的公网 LLM 端点，
  // 但它们经常指向内网服务或云厂商的元数据别名（metadata.google.internal）。
  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (hostIsAllowlisted(host, literal, 0, allowPrivateHosts)) return { allowed: true };
    return { allowed: false, reason: '目标是本机（localhost）。' };
  }
  for (const suffix of ['.internal', '.local', '.home.arpa']) {
    if (host.endsWith(suffix)) {
      if (hostIsAllowlisted(host, literal, 0, allowPrivateHosts)) return { allowed: true };
      return { allowed: false, reason: `目标主机名属于内部 DNS（${suffix}）。` };
    }
  }

  return { allowed: true };
}

/** 允许则返回裁剪后的地址，否则抛出中文错误（调用方直接回显给操作员）。 */
export function assertOutboundUrlAllowed(raw: string, allowPrivateHosts: readonly string[] = []): string {
  const verdict = checkOutboundUrl(raw, allowPrivateHosts);
  if (!verdict.allowed) {
    throw new Error(`baseUrl 不被允许：${verdict.reason}`);
  }
  return raw.trim();
}

/* -------------------------------------------------------------------------- */
/*  连接层校验（DNS rebinding 的正解）—— 外部 issue #126                          */
/* -------------------------------------------------------------------------- */

/**
 * 一个**已经解析出来的 IP 字面量**是否允许连接。
 *
 * ## 为什么需要它：`checkOutboundUrl` 只判字面主机
 *
 * `checkOutboundUrl` 看的是 URL 里写的主机名。一个**公开域名**（`attacker.example.com`）
 * 会被放行 —— 而它在 DNS 里解析到 `169.254.169.254` 时，请求会真的打到云元数据服务。
 * 这就是 DNS rebinding：**字面主机在 `fetch` 之前检查，真实 IP 在连接时才确定**，
 * 两者之间必然有时间差。
 *
 * ## 所以要有一个"按解析结果判"的入口
 *
 * 这个函数就是那套判据的复用点：它接受**解析后的地址字符串**，
 * 走与 `checkOutboundUrl` **完全相同**的网段规则
 *（`blockedIpv4Reason` / `blockedIpv6Reason` + 白名单）——
 * 一套规则两个入口，而不是在连接层再写一份（那必然分叉）。
 *
 * ⚠️ 只判字面量：传进来的必须已经是 IP（`dns.lookup` 给的就是）。
 * 传主机名会返回 `allowed: true` —— 那是**故意的**，因为主机名在这一层没有意义
 *（它的解析结果才是要判的东西），而在这里再解析一次就会掉进"两次查询之间换答案"。
 *
 * `allowPrivateHosts` 沿用同一个**字面量/主机名**匹配（`hostIsAllowlisted`）。
 * ⚠️ **`hostname`（可选）是原主机名**：操作员的白名单里可能写的是**主机名**
 *（`AQ_ALLOW_PRIVATE_LLM_HOSTS=localhost` 或 `.corp.lan`），而这里拿到的是
 * **解析结果**（`::1` / `127.0.0.1`）。不把原主机名带进来匹配的话，
 * 白名单对此**完全失效** —— 实测形态：登记了 `localhost`，IPv4 那侧解析出
 * `127.0.0.1` 恰好等于字面量所以碰巧放行，而 **IPv6 那侧解析出 `::1` 被拒**，
 * 于是"登记了却连不上"，且报错完全指不到白名单。
 */
export function checkResolvedAddress(
  address: string,
  allowPrivateHosts: readonly string[] = [],
  hostname?: string,
): UrlGuardVerdict {
  const literal = address.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!literal) return { allowed: false, reason: '解析结果为空。' };

  const host = (hostname ?? literal).trim().toLowerCase().replace(/\.$/, '');

  const family = isIP(literal);
  /* 不是 IP（理论上不会发生）→ 放行，交给上面那层的字面校验。 */
  if (family === 0) return { allowed: true };

  if (family === 4) {
    const bytes = parseIpv4(literal);
    if (!bytes) return { allowed: true };
    const reason = blockedIpv4Reason(bytes);
    if (!reason) return { allowed: true };
    if (hostIsAllowlisted(host, literal, 4, allowPrivateHosts)) return { allowed: true };
    return { allowed: false, reason: `${literal} 解析到 ${reason}` };
  }

  const bytes = parseIpv6(literal);
  if (!bytes) return { allowed: true };
  const reason = blockedIpv6Reason(bytes);
  if (!reason) return { allowed: true };
  if (hostIsAllowlisted(host, literal, 6, allowPrivateHosts)) return { allowed: true };
  return { allowed: false, reason: `${literal} 解析到 ${reason}` };
}
