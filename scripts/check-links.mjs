/**
 * 检查文档里的**站内链接**是否都能解析。
 *
 * 为什么值得单独做一个脚本：这个项目的文档量很大（20+ 个 markdown 文件，
 * 彼此交叉引用），而文档是主要的交付物之一 —— 一个点不开的链接，
 * 对刚上手的人来说就是"这份文档不可信"。
 *
 * 这类问题很容易引入且很难靠肉眼发现，实际已经发生过一次：
 * 根目录的 README 里写了 `../../issues`（那是**子目录**里才该用的相对路径），
 * 结果在 GitHub 上直接跳出仓库，变成死链。
 *
 * 只检查站内链接；外链不检查（外部站点会挂，那不该由本项目 CI 负责，
 * 而且会让构建因为别人家的故障而变红）。
 *
 * 用法：node scripts/check-links.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 跳过这些目录：依赖、版本控制、以及大体积的第三方文档副本。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', '.github']);

/**
 * 被 gitignore 的路径不查 —— 它们不属于这个仓库。
 *
 * ## 为什么需要它（实测）
 *
 * `.claude/` 下是 AI 会话的草稿（issue 原文、笔记），`.gitignore` 明确忽略它
 * （「完整的对话历史……极易被无意识地提交」）。而本脚本按目录名递归，于是把草稿里的
 * `../blob/main/xxx#L745` 当成仓库坏链报出来 —— 那些错误**与仓库无关**，
 * 却让检查退出码 1。
 *
 * 坏处有两层：① 污染"发现 N 个坏链"这个数字，真的坏链被埋在里面；
 * ② 想让检查通过的人被迫去改**不属于项目的文件**，或者干脆忽略整个检查。
 *
 * 用 gitignore 裁、而不是把 `.claude` 加进 `SKIP_DIRS`：后者只治今天这一例，
 * 而"被忽略的目录里有 markdown"是一类问题（`.cursor/`、`.continue/`、`.dsh/`
 * 也都在 `.gitignore` 里）。判据是"它进不进版本库"，不是"它叫什么名字"。
 */
const SKIP_GITIGNORED = true;

/** 不算链接目标的写法。 */
const SKIP_TARGET = /^(?:https?:|mailto:|tel:|#|data:)/;
/** GitHub 上的绝对路径（`/issues`、`/discussions`）—— 不由本地文件系统解析。 */
const GITHUB_ABSOLUTE = /^\//;

function collectMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectMarkdown(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * 一次性问 git：这些文件里哪些被 ignore，返回其中被忽略的那些（绝对值）。
 *
 * 用 `git check-ignore --stdin` 批量问，而不是每个文件起一次进程 ——
 * 仓库里几十个 markdown，逐个问会是几十次 fork。
 *
 * ⚠️ 三个坑，都踩过：
 *
 *   · **喂相对路径**：喂绝对路径会让 git 在 Windows 上把 `/c/...` 的 `/c`
 *     当成一个路径段，报 `fatal: Invalid path '/c'`，一条都问不出来。
 *   · **必须关掉路径引号**：git 默认给路径加引号并转义反斜杠
 *     （`core.quotePath`），输出长成 `".claude\\issue-drafts\\issue1.md"`，
 *     与 `path.relative()` 给出的 `.claude/issue-drafts/issue1.md`
 *     **永远匹配不上** —— 过滤会静默失效（表现为"改了却没效果"）。
 *   · **不要用 `-z`**：`-z` 只作用于输出。带 `-z` 时 git 会把整行输入
 *     当成一个路径名，实测两个文件里**两个都被判成已忽略**（包括没被忽略的
 *     `README.md`）—— 那会把整个仓库都跳过，检查变成空转。
 *     正确做法是 `git -c core.quotePath=false check-ignore --stdin`：
 *     输出保持一行一路径、正斜杠、无引号，输入按换行分隔照常解析。
 *
 * 问不出来（不在 git 仓库里、git 不在 PATH 上）就**当作没有忽略规则**：
 * 这个检查不该因为环境问题而失效，退回"全都查"与改动前行为一致。
 */
function ignoredByGit(files) {
  if (!SKIP_GITIGNORED || files.length === 0) return new Set();
  const relativeOf = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');
  try {
    const result = spawnSync('git', ['-c', 'core.quotePath=false', 'check-ignore', '--stdin'], {
      cwd: REPO_ROOT,
      input: `${files.map(relativeOf).join('\n')}\n`,
      encoding: 'utf8',
    });
    // 退出码 1 = 没有任何一个被忽略，那是正常答案，不是错误。
    if (result.status !== 0 && result.status !== 1) return new Set();
    const ignored = new Set(
      (result.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    return new Set(files.filter((file) => ignored.has(relativeOf(file))));
  } catch {
    return new Set();
  }
}

function main() {
  const found = collectMarkdown(REPO_ROOT);
  const ignored = ignoredByGit(found);
  const files = found.filter((file) => !ignored.has(file));
  const broken = [];
  let checked = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');

    // 只扫正文，跳过围栏代码块 —— 代码块里出现的链接语法是内容，不是链接。
    const inFence = text.split(/^```/m).filter((_, index) => index % 2 === 0).join('\n');
    // 行内代码同理（`` `docs/X.md` `` 是提到文件名，不是链接）。
    const body = inFence.replace(/`[^`]*`/g, '');

    for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (SKIP_TARGET.test(target) || GITHUB_ABSOLUTE.test(target)) continue;

      const [filePart] = target.split('#');
      if (!filePart) continue;

      checked += 1;
      /*
       * `decodeURIComponent` 遇到非法的百分号序列会抛 URIError。
       * 一个手误写坏的链接（例如 `[x](foo%zz.md)`）不该让**整个检查崩掉** ——
       * 那样报出来的是 `URIError` 堆栈，而不是"哪个文件里哪条链接坏了"，
       * 而这个脚本存在的意义正是后者。
       */
      let decoded;
      try {
        decoded = decodeURIComponent(filePart);
      } catch {
        broken.push({ file: path.relative(REPO_ROOT, file), target });
        continue;
      }
      const resolved = path.resolve(path.dirname(file), decoded);
      if (!existsSync(resolved)) {
        broken.push({ file: path.relative(REPO_ROOT, file), target });
      }
    }
  }

  if (broken.length > 0) {
    console.error(`\n发现 ${broken.length} 个无法解析的站内链接：\n`);
    for (const item of broken) {
      console.error(`  ✗ ${item.file}  →  ${item.target}`);
    }
    console.error(
      '\n常见原因：\n' +
        '  · 目标文件被重命名或删除，引用没跟着改\n' +
        '  · 用了 `../../` —— 那是**子目录**里的写法；根目录下的文件用 `../../` 会跳出仓库。\n' +
        '    指向 GitHub 功能（issues / discussions / labels）请用绝对路径，例如 `/issues/new/choose`\n',
    );
    process.exit(1);
  }

  console.log(`✅ ${files.length} 个 markdown 文件、${checked} 个站内链接全部有效`);
}

main();
