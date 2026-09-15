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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 跳过这些目录：依赖、版本控制、以及大体积的第三方文档副本。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', '.github']);

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

function main() {
  const files = collectMarkdown(REPO_ROOT);
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
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(filePart));
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
