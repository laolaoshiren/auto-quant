/**
 * **提交信息必须是一行**（五道闸门的第 ⑤ 条）。
 *
 * ## 为什么这条可以自动化
 *
 * 第 ⑤ 条是**流程性**的（"提交信息一行"）。而 `docs/COLLABORATION.md` 里
 * 对它的要求很具体 —— 所以它是**五道闸门里最后一条可以自动化的**。
 *
 * ⚠️ 而"一行"这件事有**两个层次**，都要守：
 * 1. **格式**：`subject` 非空、不超过约定长度、不含换行；
 * 2. ⚠️ **内容**：**不得含站点特定信息**（域名、IP、主机名）——
 *    因为提交信息**会永久留在 git 历史里**，而它不像源码那样有 `.gitignore` 兜着。
 *
 * ## ⚠️ 第 2 条是这个仓库的真实风险
 *
 * `scripts/pre-commit.sh` 扫的是**提交内容**（新增的文件与行），
 * **不扫提交信息本身**。而 CI 那份同样只看 diff 的新增行。
 *
 * ⚠️ 所以"在提交信息里写一句服务器地址"是**现有两道防线都拦不住**的 ——
 * 而那正是第 ⑤ 条（一行）与第 ④ 条（无站点信息）的**交叉盲区**。
 *
 * ## ⚠️ 这条守卫**怎么拿到提交信息**（它不能只看工作区）
 *
 * 提交信息**不在工作区里** —— 它在 git 对象库里。所以这条用例要**跑 `git log`**。
 *
 * ⚠️ 但**不能扫全部历史**：
 * · 仓库可能有几千个提交，逐个扫会很慢；
 * · 更重要的是：**历史里已有的问题不该让每轮测试变红**（那会变成"永远红的测试"，
 *   而永远红的测试会被跳过 —— 与误报同样糟）。
 *
 * 所以判据是**只扫最近 N 个提交**（默认 50）—— 足够覆盖"本次改动"，
 * 又不会因为陈年旧账而失败。⚠️ 这个折中写在下面，别把它当成"全历史扫描"。
 *
 * ## 边界（诚实说明）
 *
 * · 它**不扫** `git log` 全部历史（见上）；
 * · 它抓不住"**看起来不像站点信息的普通域名**"（没有通用判据）；
 * · 它**不检查**提交信息的"语义质量"（"这个描述准不准"只有人判得了）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/** 从本文件定位仓库根。 */
function findRepoRoot(): string {
  const start = fileURLToPath(new URL('.', import.meta.url));
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      if (statSync(join(dir, 'docs', 'COLLABORATION.md')).isFile()) return dir;
    } catch {
      /* 继续往上。 */
    }
    dir = join(dir, '..');
  }
  throw new Error(`找不到仓库根（从 ${start} 向上找了 8 层）`);
}

const ROOT = findRepoRoot();

/** 扫最近多少个提交。 */
const RECENT = 50;

interface Commit {
  hash: string;
  /** 提交信息**全文**（含正文）—— 用它来判"是不是真的只有一行"。 */
  raw: string;
  subject: string;
}

function recentCommits(): Commit[] {
  /*
   * ⚠️ 用 `%x00` 当分隔（提交信息里不会出现 NUL）——
   * 这样多行信息也能安全切分。用换行当分隔会把正文混进来。
   */
  const out = execFileSync(
    'git',
    ['log', `-${RECENT}`, '--format=%H%x00%B%x00'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  const parts = out.split('\u0000');
  const commits: Commit[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const hash = (parts[i] ?? '').trim();
    const raw = (parts[i + 1] ?? '').replace(/\n+$/, '');
    if (!hash) continue;
    commits.push({ hash, raw, subject: raw.split('\n')[0] ?? '' });
  }
  return commits;
}

test('★★★ 最近 50 个提交的信息都必须是"一行"（第 ⑤ 条闸门）', () => {
  const commits = recentCommits();

  /* 前置断言：必须真的读到提交（否则"零个问题"是因为没读到东西）。 */
  assert.ok(
    commits.length >= 10,
    `★ 只读到 ${commits.length} 个提交 —— \`git log\` 可能没跑起来，那样这条什么都没验`,
  );

  const offenders: string[] = [];
  for (const c of commits) {
    const lines = c.raw.split('\n').filter((l) => l.trim().length > 0);
    /* 允许多行里只有一行是内容（尾随空行不算）。 */
    if (lines.length > 1) {
      offenders.push(`${c.hash.slice(0, 7)}：有 ${lines.length} 行（第二行起：${lines[1]!.slice(0, 40)}…）`);
      continue;
    }
    if (c.subject.trim().length === 0) {
      offenders.push(`${c.hash.slice(0, 7)}：主题为空`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    '★★★ 这些提交的信息**不是一行**：\n' +
      offenders.map((o) => `      · ${o}`).join('\n') +
      '\n    ⚠️ 这是五道闸门的第 ⑤ 条：「提交信息一行」。\n' +
      '    ⚠️ 提交信息**会永久留在 git 历史里**，而且它不像源码那样有 `.gitignore` 兜着 ——\n' +
      '    写进正文的站点信息**没有第二道防线**。\n' +
      '    ✅ 修法：把要说的话写进 PR 描述或 issue，提交信息只留一行结论。',
  );
});

test('★★★ 最近 50 个提交的信息里不得含站点特定信息（域名 / IP / 主机名）', () => {
  /*
   * ⚠️ 这是第 ⑤ 条与第 ④ 条的**交叉盲区**：
   * `scripts/pre-commit.sh` 扫提交**内容**，**不扫提交信息本身**；
   * CI 那份同样只看 diff 的新增行。
   *
   * 所以"在提交信息里写一句服务器地址"是**现有两道防线都拦不住**的。
   */
  const commits = recentCommits();
  assert.ok(commits.length >= 10, `★ 只读到 ${commits.length} 个提交`);

  /**
   * 站点特定信息的形状 —— 刻意收得**窄**（宁可漏报，不可误报）。
   *
   * ⚠️ 与 `pre-commit.sh` 同一条原则：**误报会让人绕过检查**。
   */
  const SITE_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
    /* 裸 IPv4（排除 0.0.0.0 / 127.0.0.1 / 版本号形状 1.2.3）。 */
    { name: 'IPv4 地址', re: /\b(?!0\.0\.0\.0|127\.0\.0\.1|255\.255\.255\.255)(?:\d{1,3}\.){3}\d{1,3}\b/g },
    /* 形如 `xxx.xxx.com` 的真实域名（排除 example.com 与常见文档域名）。 */
    {
      name: '疑似真实域名',
      re: /\b(?!example\.(?:com|org|net)|github\.com|localhost)(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi,
    },
  ];

  const hits: string[] = [];
  for (const c of commits) {
    for (const { name, re } of SITE_SHAPES) {
      for (const m of c.raw.matchAll(re)) {
        const text = m[0];
        /* ⚠️ 排除提交信息里**讨论**这些形状的写法（例如 "127.0.0.1"、"0.0.0.0"）。 */
        if (/^(?:0\.0\.0\.0|127\.0\.0\.1|255\.255\.255\.255)$/.test(text)) continue;
        hits.push(`${c.hash.slice(0, 7)}（${name}）：${text}`);
      }
    }
  }

  assert.deepEqual(
    hits,
    [],
    '★★★ 这些提交信息里出现了**疑似站点特定信息**：\n' +
      hits.map((h) => `      · ${h}`).join('\n') +
      '\n    ⚠️ 提交信息**会永久留在 git 历史里**，而它**没有第二道防线**：\n' +
      '      · `scripts/pre-commit.sh` 扫的是提交**内容**，不扫信息本身；\n' +
      '      · CI 那份同样只看 diff 的新增行。\n' +
      '    ✅ 修法：把地址写进 gitignored 的 `sensitive-patterns.txt` 或部署文档，\n' +
      '       提交信息里只留结论。',
  );
});

test('★★★ 判据必须能真的报出多行信息与站点信息 —— 用人造数据校准', () => {
  /*
   * ⚠️ "探针校准"：上面两条断言 `offenders` / `hits` 为空，而**一个什么都没扫到的
   * 实现也返回空数组**。这里用同一套判据跑人造提交信息，断言它会被报出。
   */
  const multiLine = (raw: string): boolean => raw.split('\n').filter((l) => l.trim().length > 0).length > 1;
  assert.equal(multiLine('fix: 一行'), false, '★★ 一行信息不该被误报');
  assert.equal(
    multiLine('fix: 一行\n\n这是正文，解释了为什么。'),
    true,
    '★★★ 判据必须能报出多行信息 —— 否则上面那条是在空转',
  );

  const SITE = /\b(?!0\.0\.0\.0|127\.0\.0\.1|255\.255\.255\.255)(?:\d{1,3}\.){3}\d{1,3}\b/g;
  assert.ok(
    [...'fix: 部署到 203.0.113.45'.matchAll(SITE)].length > 0,
    '★★★ 判据必须能报出 IP',
  );
  assert.equal(
    [...'fix: 绑定 127.0.0.1 与 0.0.0.0'.matchAll(SITE)].length,
    0,
    '★★ 回环与通配地址不能被误报（它们不是站点信息）',
  );
});
