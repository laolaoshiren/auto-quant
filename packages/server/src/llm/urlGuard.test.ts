/**
 * 出站地址白名单（SSRF 防护）的回归测试。
 *
 * 这个测试存在的理由：`baseUrl` 是**服务端替操作员发出的请求**。
 * 一旦允许它指向内网，一个控制台会话就等于一把内网钥匙 ——
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * 会返回云主机的临时凭据，`http://127.0.0.1:2375/containers/json` 能打到
 * 只监听本机的 Docker 接口。响应体会经由模型探测结果回显给调用方。
 *
 * 所以这里逐个断言**绕过写法**，而不只是断言"某个域名被拒"：
 * WHATWG URL 会把 `2130706433`、`0x7f.1` 归一成 `127.0.0.1`，
 * 把 `[::ffff:169.254.169.254]` 归一成 `[::ffff:a9fe:a9fe]` ——
 * 只看字符串前缀的实现会漏掉这些形式。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkOutboundUrl } from './urlGuard.js';

/** 断言被拒，并返回原因，便于确认拒的是**正确的那一条规则**。 */
function rejected(url: string): string {
  const verdict = checkOutboundUrl(url);
  assert.equal(verdict.allowed, false, `${url} 应当被拒绝`);
  assert.ok(verdict.reason && verdict.reason.length > 0, '拒绝时必须给出原因');
  return verdict.reason;
}

function allowed(url: string): void {
  const verdict = checkOutboundUrl(url);
  assert.equal(verdict.allowed, true, `${url} 应当被允许，实际被拒：${verdict.reason ?? ''}`);
}

test('云元数据地址（链路本地）被拒绝', () => {
  // 这是最值钱的一个目标：AWS/GCP/Azure 的实例凭据都在这里，且无需任何认证
  const reason = rejected('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
  assert.match(reason, /链路本地/);
});

test('别名形式的 169.254.169.254 同样被拒绝', () => {
  // 十进制整数、八进制、十六进制写法：URL 解析器归一化之后必须还是被拦下
  rejected('http://2852039166/latest/meta-data/');
  rejected('http://0xA9FEA9FE/latest/meta-data/');
  rejected('http://0251.0376.0251.0376/latest/meta-data/');
});

test('IPv4 回环与 "0.0.0.0" 被拒绝', () => {
  rejected('http://127.0.0.1:2375/containers/json');
  rejected('http://127.1.2.3/v1');
  rejected('http://2130706433/v1');
  rejected('http://0x7f.1/v1');
  rejected('http://0.0.0.0:8080/v1');
});

test('RFC1918 私有网段被拒绝', () => {
  rejected('http://10.0.0.5/v1');
  rejected('http://172.16.0.1/v1');
  rejected('http://172.31.255.254/v1');
  rejected('http://192.168.1.1/v1');
  // 边界：172.32 已经不在 RFC1918 里，不能误伤
  allowed('http://172.32.0.1/v1');
});

test('运营商级 NAT 网段被拒绝（部分云厂商的元数据服务在这里）', () => {
  const reason = rejected('http://100.100.100.200/latest/meta-data/');
  assert.match(reason, /100\.64\.0\.0\/10/);
  allowed('http://100.128.0.1/v1');
});

test('IPv6 回环、ULA、链路本地被拒绝', () => {
  rejected('http://[::1]:8080/v1');
  rejected('http://[fe80::1]/v1');
  rejected('http://[fd00::1]/v1');
  rejected('http://[ff02::1]/v1');
  // 公网 IPv6 不能误伤
  allowed('http://[2606:4700:4700::1111]/v1');
});

test('IPv4-mapped 与 NAT64 形式的内网地址被拒绝', () => {
  // 只看字符串前缀的实现会全部漏掉这四种写法
  rejected('http://[::ffff:169.254.169.254]/v1');
  rejected('http://[::ffff:127.0.0.1]/v1');
  rejected('http://[::127.0.0.1]/v1');
  rejected('http://[64:ff9b::a9fe:a9fe]/v1');
  // 内嵌公网 IPv4 的 mapped 地址不应被误伤
  allowed('http://[::ffff:8.8.8.8]/v1');
});

test('localhost 与内部域名被拒绝（含结尾点写法）', () => {
  rejected('http://localhost:11434/v1');
  rejected('http://localhost./v1');
  rejected('http://api.internal/v1');
  rejected('http://metadata.google.internal/computeMetadata/v1/');
  rejected('http://printer.local/v1');
});

test('非 http(s) 协议被拒绝', () => {
  assert.match(rejected('file:///etc/passwd'), /http/);
  rejected('gopher://127.0.0.1:70/');
  // 大小写与空值
  rejected('');
  rejected('not a url');
});

test('正常的公网端点全部放行', () => {
  // 自定义端点是有意保留的功能：自建网关、代理、兼容层。白名单必须不能把它们挡掉
  allowed('https://api.deepseek.com/v1');
  allowed('https://api.openai.com/v1');
  allowed('https://openrouter.ai/api/v1');
  allowed('https://generativelanguage.googleapis.com/v1beta');
  allowed('http://gateway.example.com:8080/v1');
  // 主机名里含数字 / 连字符不能误判成 IP
  allowed('https://llm-2.example.com/v1');
});
