/**
 * **Harness agent 运行时** —— 让角色真正"能自己干活"。
 *
 * ## 为什么需要它（实测对照，2026-10-12）
 *
 * 同一个任务（「查今天 BTC 三条新闻 + 方向判断」）跑两种做法：
 *
 * | | 手搓单次调用 | harness agent |
 * |---|---|---|
 * | 情报产出 | **零** —— 「我无法联网，没有工具」 | **3 条具体新闻 + 资金流 + 价格** |
 * | 来源 | 无 | **5 个真实 Sources 链接** |
 * | 行为 | 给框架、要用户贴新闻 | **自己调工具查到，还给结论与依据** |
 *
 * **差距是质，不是量。** 手搓的角色只是"被问一次就答一次"，
 * 而用户要的是"像公司员工一样，领了任务能自己去干"。
 *
 * 用户的原话：
 *
 * > 「在我理解中，智能体就像一个真人一样，公司干活的员工，公司给他委派任务，
 * >  他能**自己上班干活，给公司贡献**，而不是像机器人一样**问一次答一次**，
 * >  如果是这样那么这个模式和之前 2 个模式又有什么区别？」
 *
 * ## 为什么不自己写 agent 循环（"不重复造轮子"）
 *
 * 一个能干活的 agent 需要：工具调用、多轮循环、上下文压缩、权限、错误恢复。
 * 这些 harness 已经做得很成熟 —— 用户的需求 #4 明确要求直接用它们。
 *
 * ## 与 magpie 的关系（两者天然咬合）
 *
 * ```
 *   harness  = 会干活（工具、循环、自主）
 *   magpie   = 用哪个模型（按工种的路由组，优选→兜底）
 * ```
 *
 * magpie 原生说 Anthropic Messages 协议，所以 claude code 只要设
 * `ANTHROPIC_BASE_URL` 就能直接用它。
 */

import { spawn } from 'node:child_process';

/** 一次 agent 任务的输入。 */
export interface AgentTaskInput {
  /** 交给这个"员工"的任务（自然语言，就像跟同事说话）。 */
  task: string;
  /**
   * 允许它用的工具（逗号分隔）。
   *
   * ⚠️ 用**白名单**而不是 `--dangerously-skip-permissions`：
   * 后者在 root 下会被 harness 直接拒绝（实测），而且给一个交易系统开全权限太危险。
   */
  allowedTools?: string;
  /** magpie 的路由组（`group/team-news` 之类）—— "这个人用哪档模型"。 */
  model?: string;
  /** 体力活用的快模型（harness 内部的小任务，例如压缩上下文）。 */
  fastModel?: string;
  /** 工作目录（agent 的"办公室"）。 */
  workdir: string;
  /**
   * **工具调用的最大轮数**（`--max-turns`）。
   *
   * ## 为什么必须有上限（2026-10-13 实测抓到）
   *
   * 不传这个参数时 claude code **没有轮数上限** —— 而猎手任务里写着
   * 「优先看这些来源」（每个猎手 3–5 个来源），于是它会**一个来源接一个来源地搜**，
   * 直到用光时间预算。
   *
   * ### 实测对照（同一个真实猎手任务）
   *
   * ```
   *   不限轮数（线上）      → **600 秒超时**，0 字产出
   *   --max-turns 10        → **86.1 秒**，正常完成（2 次 WebSearch）
   *   --max-turns 4         → 报 "Reached max turns"，但也没超时
   * ```
   * 步骤序列（限 10 轮那次）：
   * ```
   *   tool:WebSearch → tool:WebSearch → result(86111ms)
   * ```
   * **它 2 次搜索就够了** —— 那 600 秒全花在"继续搜更多来源"上，
   * 而那些额外搜索**对最终产出没有任何贡献**（它早就有结论了）。
   *
   * ## 取值
   *
   * 默认 **12**：实测 2 次搜索完成，留 6 倍余量给"需要多查几个来源"的情况。
   * 而这个上限的意义是**保证它在预算内交出结论**，而不是"搜到完美为止"。
   *
   * ══════════════════════════════════════════════════════════════════════════
   *  ⚠️⚠️ **12 在线上不够 —— 实测 15% 的轮次撞上限且产出为零**（2026-10-15）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ```
   *   含 "Reached max turns" 的轮次: 41 / 277（15%）
   *   其中【有部分产出】的:          0 / 41
   * ```
   * 线上原文（第 277 轮）：
   * ```
   *   全部四个猎手（news_hunter、flow_hunter、community_hunter、macro_hunter）
   *   均因 Reached max turns (12) 报错，未返回任何新闻条目、来源链接或发布时间
   * ```
   *
   * ## 上面那个"6 倍余量"的推断错在哪
   *
   * 它基于**一次**实测（2 次搜索完成）。而猎手任务是**多标的**的
   *（实测候选池 18–20 个），且要求"最近 48 小时内"——
   * 那意味着它要对多个标的分别搜、还要筛掉旧闻。**12 轮不够。**
   *
   * ## 提到 24，并配合"先写数组"的提示词纪律
   *
   * ⚠️ **单靠加轮数不够**（它还会继续搜到 24 用尽）—— 所以两层一起改：
   * ```
   *   ① 本参数 12 → 24（给"多标的 + 筛时效"留空间）
   *   ② `hunters.ts` 的 `buildHunterTask` 加"先输出数组，再继续搜"
   * ```
   * ②是**必须**的（与裁决官那次同一个道理：让机器读的东西先写完），
   * ①是给"确实需要多搜"的情形留余地。
   *
   * ⚠️ 超时 600 秒（`AQ_RESEARCH_TIMEOUT_MS`）仍然远大于 24 轮的实际耗时
   *（实测 10 轮 ≈ 86 秒），所以加轮数不会引入超时风险。
   */
  maxTurns?: number;
  /** 超时（毫秒）。 */
  timeoutMs?: number;
  /** magpie 网关地址。 */
  baseUrl?: string;
  /** magpie 调用密钥。 */
  authToken: string;
  /**
   * **外部中止信号**（2026-10-13 加）—— 机器人停止时用它把在飞的 agent 杀掉。
   *
   * ⚠️ 不传 = 行为与改动前完全一致（只受 `timeoutMs` 约束）。
   */
  signal?: AbortSignal;
}

/** 一次 agent 任务的结果。 */
export interface AgentTaskResult {
  ok: boolean;
  /** agent 的交付内容。 */
  text: string;
  /** 失败原因（ok=false 时有值）。 */
  error?: string;
  latencyMs: number;
}

/**
 * 失败信息里最多带多少字符的 stderr。
 *
 * ## ⚠️ 这个数从 200/300 提上来的理由（2026-10-17 实测）
 *
 * 线上出现「调研猎手 未产出」时，库里那一行只有 200 个字符的 stderr：
 *
 * ```
 *   [调研] 社区猎手 未产出：harness 退出码 143 · [claude-code:unrecognized_model] {"model":"group/team-news",…}
 *   We're changing auto mode to no longer charge for classifier requests in Claude Code. However, this session
 *   isn't eligible because your requests go through 127.0.0.1:3425, … Nothin        ← 正好断在这里
 * ```
 *
 * 而**真正的线索全在被截断的那半段里**：那两句是 Claude Code 自己的**通知**，
 * 说明「模型名不被识别」只是遥测、以及「auto mode 的分类器请求」这件事 ——
 * 排查时正因为看不到它们，才把一条无害的警告误当成了根因。
 *
 * 800 字符足以装下这两段通知（实测每段约 300–400 字符），
 * 又不会把 `runtime_logs` 一行撑爆（那张表按行数封顶，不按字节）。
 */
export const HARNESS_STDERR_TAIL = 800;

/**
 * **被信号终止时的退出码 → 人话**（2026-10-17 实测加）。
 *
 * ## 为什么必须单独判这一支
 *
 * `143 = 128 + 15 = SIGTERM`。它**不是配置错、也不是猎手自己失败** ——
 * 它是**有人把它杀了**。线上实测（2026-10-17 10:06:57）：
 *
 * ```
 *   systemctl show autoquant.service -p KillMode     → KillMode=control-group
 *                                       -p KillSignal → KillSignal=15
 *   journal：Stopping autoquant.service …（部署重启）
 * ```
 *
 * systemd 的默认 `KillMode=control-group` 会向**整个 cgroup** 发 `KillSignal`，
 * 而猎手（claude 进程）正是这个 cgroup 里的子进程 —— 于是它和主进程一起被带走，
 * 退出码 143。**与猎手本身没有任何关系。**
 *
 * ## 这一支为什么之前没有
 *
 * 我们自己的两条终止路径（超时、`AbortSignal`）都用 `SIGKILL` 并先 `finish()`，
 * 所以它们**不会**走到这里；而"外部发的 SIGTERM"从来没被识别过 ——
 * 于是在界面上表现为「harness 退出码 143」这种**把人引向错误方向**的说明：
 * 操作员会去查猎手为什么坏，而真相是**平台刚重启过**。
 *
 * @returns 人话；**普通退出码返回 `null`**（保持原来那条通用分支不变）。
 */
export function describeTermination(code: number | null, signal: string | null): string | null {
  if (signal === 'SIGTERM' || code === 143) {
    return (
      '被 SIGTERM 终止（143 = 128+15）—— 这是【外部】发来的停机信号，' +
      '不是猎手自身的故障：systemd 停/重启本服务时（KillMode=control-group、KillSignal=15）' +
      '会向整个 cgroup 发 SIGTERM，猎手是被一起带走的'
    );
  }
  if (signal === 'SIGKILL' || code === 137) {
    return '被 SIGKILL 终止（137 = 128+9）—— 进程被强杀（平台停机或内存压力）';
  }
  return null;
}

/**
 * **从 stderr/stdout 里认出两类"看起来像故障、其实不是"的东西**。
 *
 * 两条都是 2026-10-17 实测确认的，写进注释是因为**它们的字面意思都在骗人**：
 *
 * | 屏幕上的字 | 真相 |
 * |---|---|
 * | `[claude-code:unrecognized_model]` | **只是遥测信号**（CLI 内部的 `tengu_api_unrecognized_model` 统计）。实测同一个模型名直接调网关返回 **200**，且会话记录里有真实 token 用量 —— 模型名**能用** |
 * | `auto mode cannot determine the safety of …` | Claude Code 的 **auto mode 安全分类器**不可达：它要用的那个模型本网关没有（实测该模型名返回 401）。这是**间歇性**的 |
 *
 * ⚠️ 这两条都**不改变 `ok`**（不放松质量）—— 它们只让下一次排查不用再绕这一圈。
 */
export function harnessFailureHints(text: string): string {
  const hints: string[] = [];
  if (/auto mode cannot determine/i.test(text)) {
    hints.push(
      'Claude Code 的 auto mode 安全分类器不可达（网关不提供它要用的那个模型）—— ' +
        '它会让需要审批的工具调用被拒；实测是间歇性的',
    );
  }
  if (/unrecognized_model/i.test(text)) {
    hints.push(
      '[claude-code:unrecognized_model] 只是遥测信号，**不代表模型名不可用**' +
        '（实测该模型名直接调网关返回 200 且有 token 用量）',
    );
  }
  return hints.length > 0 ? `；提示：${hints.join('；')}` : '';
}

/**
 * 实际的进程执行 —— **抽成可注入的**。
 *
 * 两个原因：
 * ① 测试里不能真的起进程（本机沙箱下 `spawn` + `stdio: 'pipe'` 会 EPERM）；
 * ② 将来换 harness（codex / opencode / dsh）只改这一处。
 */
export type SpawnAgent = (input: AgentTaskInput) => Promise<AgentTaskResult>;

/**
 * **默认实现：驱动 claude code**。
 *
 * 命令形状（实测可用，2026-10-12）：
 *
 * ```
 *   claude --print --allowedTools "WebSearch,WebFetch"   ← 任务走 stdin
 * ```
 *
 * ⚠️ 三个实测踩到的坑，都在下面标注了。
 */
export const spawnClaudeCode: SpawnAgent = async (input) => {
  const started = Date.now();
  const bin = process.env.AQ_HARNESS_BIN ?? '/opt/autoquant/tools/harness/node_modules/.bin/claude';
  const timeoutMs = input.timeoutMs ?? 300_000;

  return await new Promise<AgentTaskResult>((resolve) => {
    /*
     * ⚠️ 坑 ①：任务必须走 **stdin**。
     * 实测把任务当位置参数传会报 "Input must be provided either through stdin
     * or as a prompt argument" —— 而它其实是在等 stdin。
     */
    const child = spawn(bin, [
      '--print',
      ...(input.allowedTools !== undefined && input.allowedTools.length > 0
        ? ['--allowedTools', input.allowedTools]
        : []),
      /*
       * ⚠️ **必须有轮数上限**（2026-10-13）—— 见 `maxTurns` 的说明。
       * 实测：不限轮数 → 600 秒超时；限 10 轮 → 86 秒完成。
       */
      '--max-turns',
      String(input.maxTurns ?? 24),
    ], {
      cwd: input.workdir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: input.baseUrl ?? 'http://127.0.0.1:3425',
        ANTHROPIC_AUTH_TOKEN: input.authToken,
        ...(input.model !== undefined ? { ANTHROPIC_MODEL: input.model } : {}),
        ...(input.fastModel !== undefined ? { ANTHROPIC_SMALL_FAST_MODEL: input.fastModel } : {}),
        /*
         * ⚠️ 坑 ②：claude code 不认识 `group/team-*` 这种模型名，会警告并
         * **按 200k 预估上下文**。我们显式告诉它真实窗口，避免它过早压缩上下文。
         */
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.AQ_HARNESS_CONTEXT_TOKENS ?? '200000',
        HOME: process.env.AQ_HARNESS_HOME ?? `${input.workdir}/.home`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: AgentTaskResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, text: '', error: `agent 超过 ${Math.round(timeoutMs / 1000)} 秒未返回`, latencyMs: Date.now() - started });
    }, timeoutMs);

    /*
     * ── **外部中止通道**（2026-10-13 加）──────────────────────────────────
     *
     * ## 为什么需要它（实测）
     *
     * 实测：`#11` 已经 `stopped`，而服务器上**仍有 2 个 claude 进程在跑**
     *（`etime 00:27`）—— 它们是"启动时立刻跑一次"那批猎手。
     *
     * 我修了定时器泄漏（`stopResearchRefresher`），但**已经起飞的进程停不下来**：
     * 它们会跑完（约 200–600 秒）才自然退出。而单个 claude 进程约 150–250MB ——
     * **机器人停止后还在吃几分钟资源**，且期间它还会写 `researchCache`。
     *
     * ⚠️ 用 `AbortSignal`（Node 标准形状）而不是自造接口：
     * 调用方直接传 `controller.signal`，与 `fetch` 的用法一致。
     */
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish({ ok: false, text: '', error: '已中止（机器人停止）', latencyMs: Date.now() - started });
    };
    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });

    child.on('error', (e) => {
      /*
       * ⚠️ 坑 ③：**没装 harness 时必须说清楚**，不能静默失败 ——
       * 否则现象是"这个分析师这轮没产出"，而真正原因是环境没装好。
       */
      finish({
        ok: false,
        text: '',
        error: `起不了 harness（${bin}）：${e.message} —— 需要先安装（见 .dsh 文档的 harness 安装步骤）`,
        latencyMs: Date.now() - started,
      });
    });

    child.on('close', (code, signal) => {
      const latency = Date.now() - started;
      const text = out.trim();
      /*
       * stderr 的留痕长度与"看起来像故障、其实不是"的提示 —— 见两个常量的说明。
       * ⚠️ 它们**只影响 error 文本**，不影响 `ok`（不放松质量）。
       */
      const stderrTail = err.trim().slice(0, HARNESS_STDERR_TAIL);
      const hints = harnessFailureHints(err);
      if (code === 0 && text.length > 0) {
        finish({ ok: true, text, latencyMs: latency });
        return;
      }
      /*
       * ⚠️ **"撞上轮数上限"不等于失败**（2026-10-13）。
       *
       * ## 为什么必须区别对待
       *
       * `--max-turns` 到达时会报 `Error: Reached max turns (N)` 并**以非 0 退出**。
       * 而那时它**可能已经写出了我们要的东西** —— 实测（限 10 轮那次）：
       * ```
       *   tool:WebSearch → tool:WebSearch → result(86111ms)   ← 正常完成
       * ```
       * 而限 4 轮那次是 `Error: Reached max turns (4)`，但**它已经搜过了**。
       *
       * 若把这种情形一律判为失败，就会丢掉**一份可用的产出** ——
       * 而那正是我们加轮数上限想要得到的东西（在预算内拿到结论）。
       *
       * ## 判据：有实质文本就收下，但**在 error 里说清它是被截断的**
       *
       * 不能静默当成完整成功：调用方需要知道"这份产出是在轮数用尽时截下来的"
       *（它可能少了最后那段结论）。所以 `ok: true` 而 `error` 仍写明原因。
       *
       * ══════════════════════════════════════════════════════════════════════════
       *  ⚠️⚠️ **`text.length > 0` 这个判据是错的 —— 实测污染了所有下游**（2026-10-15）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * ## 事故：错误信息本身被当成了"产出"
       *
       * 线上 `research_cache:11` 的原文：
       * ```
       *   ## 消息面调研（4/4 个猎手有产出）      ← 标题说全部有产出
       *   ### 新闻猎手（news_hunter）
       *   Error: Reached max turns (12)          ← 而内容是一句错误
       *   ### 资金猎手（flow_hunter）
       *   Error: Reached max turns (12)
       *   …
       * ```
       * 而 `mergeHunterReports` 的 `okCount` 就是数 `r.ok` —— 于是它写"4/4 有产出"。
       *
       * ## 为什么 `text.length > 0` 判不出来
       *
       * `claude --print` 在撞上限时把 `Error: Reached max turns (N)` **写到 stdout**，
       * 于是 `text` 非空 —— 但它**一个字的情报都没有**。
       * 用"有没有文本"当判据，等于"有没有报错"当判据。
       *
       * ## 正确的判据：文本里有没有**实质内容**
       *
       * 撞上限时那行错误的形状是稳定的（`Error: Reached max turns (N)`）。
       * 所以判据是：**剥掉这类错误行之后，还剩不剩东西**。
       *
       * ⚠️ 这与本仓库反复记的那条同源：**"一个把故障说成正常的地方，比报错更危险"** ——
       * 这里它是第四次（前三次：决策详情页、`<risk>` 块、猎手零产出）。
       * 而这一次最靠底层：它让**下游所有角色**都以为"消息面调研成功了"。
       */
      const hitMaxTurns = /Reached max turns/i.test(err) || /Reached max turns/i.test(text);
      /*
       * 剥掉 harness 自己写的错误行，看还剩不剩**实质内容**。
       * ⚠️ 只剥"看起来是 harness/CLI 的错误行"，不剥正常文本 ——
       * 否则会把一份"恰好提到这个短语"的真实产出误判成空。
       */
      const substantive = text
        .split('\n')
        .filter((line) => !/^\s*(Error:\s*)?Reached max turns/i.test(line))
        .join('\n')
        .trim();
      if (hitMaxTurns && substantive.length > 0) {
        finish({
          ok: true,
          text,
          error: `达到轮数上限（产出可能不完整）：${stderrTail}${hints}`,
          latencyMs: latency,
        });
        return;
      }
      /*
       * ══════════════════════════════════════════════════════════════════════════
       *  ⚠️ **被外部信号终止** —— 单独判，因为它的字面数字最容易被误读（2026-10-17）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * 线上原文：
       * ```
       *   [调研] 社区猎手 未产出：harness 退出码 143 · [claude-code:unrecognized_model] …
       * ```
       * `143` 看起来像"某个配置项写错了"，而它其实是 **SIGTERM（128+15）**：
       * 那一刻 systemd 正在**停这个服务做部署**，`KillMode=control-group`
       * 把 SIGTERM 发给了整个 cgroup —— 猎手是被**平台重启**带走的。
       *
       * 判据与依据都在 `describeTermination()` 里。这里只负责：
       *   · 把"被杀"与"它自己失败"分开说；
       *   · **仍然 `ok: false`**（被杀的一轮不该被当成一份产出）；
       *   · 有实质文本时**保留在 `text` 里**（只作证据，不参与 ok 判定）。
       */
      const killed = describeTermination(code, signal);
      if (killed !== null) {
        finish({
          ok: false,
          text: substantive.length > 0 ? text : '',
          error:
            `${killed}` +
            (hitMaxTurns ? '；另外它当时也已经撞上了轮数上限' : '') +
            (stderrTail.length > 0 ? ` · ${stderrTail}` : '') +
            hints,
          latencyMs: latency,
        });
        return;
      }
      /*
       * ⚠️ 撞了上限而**没有实质内容** ⇒ 那是失败，不是"截断的产出"。
       * 原来这条会落到下面的 `ok: false`，但 `text` 仍是那句错误 ——
       * 所以 `error` 要写清"它一个字都没写"，而不是把错误当产出带下去。
       */
      if (hitMaxTurns) {
        finish({
          ok: false,
          text: '',
          error: `达到轮数上限，且**没有任何实质产出**（只输出了错误行）：${stderrTail}${hints}`,
          latencyMs: latency,
        });
        return;
      }
      finish({
        ok: false,
        text,
        error: `harness 退出码 ${code ?? 'null'}${signal !== null ? `（信号 ${signal}）` : ''}${
          stderrTail.length > 0 ? ` · ${stderrTail}` : ''
        }${hints}`,
        latencyMs: latency,
      });
    });

    child.stdin.write(input.task);
    child.stdin.end();
  });
};

/**
 * **判断一次失败是不是"网关侧不可用"**（2026-10-13）。
 *
 * ## 为什么需要它（实测事故）
 *
 * ```
 *   ok=false 4s
 *   text: "Failed to authenticate. API Error: 403 OpenCode Zen Free:
 *          OpenCode's free tier can only be used from within OpenCode."
 * ```
 * **4 秒**就失败了 —— 而正常一次猎手要 200–500 秒。
 * 而线上日志里 4 个猎手**同时**以这个理由失败：
 * ```
 *   [调研] 4 个来源中 **4 个未产出**
 *         每个都是：harness 退出码 1 · [claude-code:unrecognized_model]
 * ```
 * 根因：`team-news` 组的 **6 个候选全部是 `opencode-zen-free/*` /
 * `our-free-model/*`**，而它们**都返回同一个 403** ——
 * 而 **magpie 的组路由【不降级】**（实测：直接调 `group/team-news`
 * 得到的是那个 403，而不是"试下一个候选"）。
 *
 * ## 为什么要识别它
 *
 * 这个失败是**可重试的**（换一组模型、或等限流恢复）——
 * 而"任务本身失败"（模型说"我查不到"）是不可重试的。
 * 把两者混在一起，会让"换一组模型就能解决"的问题**静默变成"没有新闻"**。
 *
 * ⚠️ 判据必须**只看网关侧的错误**（认证/限流/额度），
 * 不能把"模型自己输出了一句含 Error 的话"也算进来 ——
 * 那会触发无意义的重试。
 */
export function isGatewayUnavailable(text: string): boolean {
  return (
    /Failed to authenticate/i.test(text) ||
    /permission_error/i.test(text) ||
    /\b403\b/.test(text) ||
    /can only be used from within/i.test(text) ||
    /rate.?limit/i.test(text) ||
    /\b429\b/.test(text) ||
    /insufficient|quota|credit/i.test(text)
  );
}

/**
 * **跑一次 agent 任务**。
 *
 * 调用方（角色）只需要给"任务是什么、能用什么工具、用哪档模型"，
 * **不需要知道底下是 claude code 还是别的 harness**。
 *
 * ## 网关侧失败会重试一次（2026-10-13 加）
 *
 * 见 `isGatewayUnavailable()`：组里候选全坏时 magpie **不降级**，
 * 于是整个组瞬间失败。而那种失败往往是**暂时的**
 *（限流恢复、magpie 换了一批候选）—— 所以值得再试一次。
 *
 * ⚠️ **只重试一次**，且**只在"网关侧失败"时**：
 * ```
 *   网关侧失败（403/429/额度）→ 重试 1 次（间隔 3 秒）
 *   其它失败（模型没查到、轮数用尽、超时）→ 不重试
 * ```
 * 理由：重试有成本（每个 claude 进程 150–250MB，而服务器只有 2 核），
 * 而"模型说查不到"重试一遍还是查不到。
 */
export async function runAgentTask(
  input: AgentTaskInput,
  spawnAgent: SpawnAgent = spawnClaudeCode,
): Promise<AgentTaskResult> {
  if (input.task.trim().length === 0) {
    return { ok: false, text: '', error: '任务为空 —— 没给这个 agent 任何活干', latencyMs: 0 };
  }
  const first = await spawnAgent(input);
  if (first.ok) return first;
  /*
   * ⚠️ **只重试"网关侧失败"**（见 `isGatewayUnavailable`）——
   * 而且只看 `error` 与 `text` 里的**网关错误**，不把"模型自己提到 403"算进来。
   *
   * ⚠️ 而"任务为空"那条不该走到这里（上面已经返回）。
   * ⚠️ **超时也不重试**：一次超时已经花掉了整个 `timeoutMs`
   *（实测 600 秒），再试一次等于让这一轮再等 10 分钟 ——
   * 而"没有新闻"比"决策等 20 分钟"好得多（调研在后台，但仍是资源）。
   */
  const gatewayIssue =
    isGatewayUnavailable(first.error ?? '') ||
    (first.text.length > 0 && isGatewayUnavailable(first.text));
  if (!gatewayIssue) return first;

  /* 间隔 3 秒：给 magpie 一点时间（换候选 / 限流窗口过去）。 */
  await new Promise((r) => setTimeout(r, 3_000));
  const second = await spawnAgent(input);
  /*
   * 第二次失败时**把两次的原因都带上** —— 否则排查时只看到"还是失败"，
   * 而不知道第一次与第二次是不是同一个原因（那决定了该改什么）。
   */
  if (!second.ok) {
    return {
      ...second,
      error: `重试后仍失败（第 1 次：${(first.error ?? '').slice(0, 150)}｜第 2 次：${(second.error ?? '').slice(0, 150)}）`,
      latencyMs: first.latencyMs + second.latencyMs,
    };
  }
  return { ...second, latencyMs: first.latencyMs + second.latencyMs };
}
