# 代码注释里的外部编号引用

> ⚠️ 这份文档**不解释那些编号的内容** —— 它说明**它们出自哪里、为什么不在仓库里、
> 以及你该看什么**。

---

## 现象

`packages/server/src/llm/` 下的注释里有 **27 处**形如 `B.14` 的编号引用：

```
packages/server/src/llm/client.ts:88     Full-jitter backoff bounds from B.14 (`base ≈ 500ms`, cap ≈ 30s)
packages/server/src/llm/client.ts:140    overload (B.14)
packages/server/src/llm/errors.ts:29     preferred over any locally computed backoff (B.14 rule 1)
packages/server/src/llm/errors.ts:68     quota exhaustion is pure waste (B.14)
packages/server/src/llm/errors.ts:144    must not be retried (B.14)
packages/server/src/llm/errors.ts:155    Map a coarse kind onto the retry policy from B.14
packages/server/src/llm/errors.ts:242    dangerous provider behaviour in the research document (B.8)
packages/server/src/llm/http.ts:254      Kimi answers a gateway timeout with an HTML error page (B.7)
packages/server/src/llm/http.ts:279      (B.14 rule 1)
packages/server/src/llm/anthropic.ts:56  accepts only `1.0` and `top_p` only ≥ 0.99, everything else is a 400 (B.3)
packages/server/src/llm/gemini.ts:13     Native Gemini `generateContent` (B.4)
packages/server/src/llm/gemini.ts:207    (B.12)
… 以及 openaiCompatible.ts / types.ts / llm.test.ts 里的若干处
```

## 它们出自哪里

⚠️ **一份仓库外的研究文档**（provider 行为调研）。

`llm/errors.ts:242` 的注释自己写明了这一点：

> dangerous provider behaviour **in the research document** (B.8).

`git log -S "B.14" --all` 显示这些引用**从仓库初始化提交（`b03bd02`）就存在** ——
也就是说那份文档**从来没有进过这个仓库**。

## ⚠️ 为什么这值得记一笔

`docs/AGENTS.md` §5.1 要求注释解释「**为什么**」。而"为什么"指向一个
**读者无法访问的出处**时，那个"为什么"就**不可查证**：

- 读者不能确认它**是否仍然成立**；
- 读者不知道改它**会不会违反某个约定**。

⚠️ 这与本仓库反复强调的"注释与实现漂移"是同一族问题：**引用还在，出处没了**。

## ✅ 但代码本身没问题

那些规则**在代码里都有实现**，而且注释的上下文足够说明意图：

| 编号 | 代码里的对应实现 |
| --- | --- |
| `B.1` | provider 通用约定（`openaiCompatible.ts` 的请求/响应处理）|
| `B.14` | `llm/errors.ts` 的 `isRetryable` 分类；`retryAfterMs` 优先于本地退避；`llm/client.ts` 的 full-jitter 退避（`base 500ms` / `cap 30s`）|
| `B.8` | `errors.ts` 里对"危险 provider 行为"的判别（不重试的永久性错误）|
| `B.7` | `llm/http.ts` 里对"HTML 错误页"的处理 |
| `B.3` / `B.4` / `B.12` / `B.15` | 各 provider 的参数兼容与调用形状（`anthropic.ts` / `gemini.ts` / `openaiCompatible.ts`）|
| `B.16` | 启动预检的廉价能力探测（`client.ts`）|

⚠️ **所以这不是 bug** —— 是**可维护性**问题。

## 该怎么办（两条路，择一）

### ① 把那份研究文档的相关部分摘进 `docs/`

例如 `docs/LLM-PROVIDERS.md`，然后把注释里的 `B.x` 改成指向它。
**这需要那份文档的内容** —— 而它不在仓库里。

### ② 把编号换成**自包含的说明**

例如把

```
Full-jitter backoff bounds from B.14 (`base ≈ 500ms`, cap ≈ 30s).
```

改成

```
Full-jitter exponential backoff: base ≈ 500ms, cap ≈ 30s.
优先用服务端返回的 `Retry-After`（它在 `LlmError.retryAfterMs` 上）。
```

⚠️ **不要照抄上面这个例子** —— 它只是说明**形式**。
改写时必须**从代码里的实际行为**出发，而不是从编号猜内容
（那份文档看不到，猜出来的说明会比引用更糟）。

## 守卫

`packages/server/src/docReferenceGuard.test.ts` 会检查：
**注释里引用的外部编号必须能在 `docs/` 里查到**（或已在 `KNOWN_EXTERNAL` 里登记）。

⚠️ 所以：**新增一个外部编号引用会被拦下** —— 要么把它写进 `docs/`，要么登记理由。

⚠️ 若你完成了 ① 或 ②，请把对应的条目从那个测试的 `KNOWN_EXTERNAL` 里**移除** ——
留在名单里会让下一个人以为它仍未解决。
