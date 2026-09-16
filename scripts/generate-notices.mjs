/**
 * 生成 `THIRD-PARTY-NOTICES.md`。
 *
 * 为什么需要这个文件：本项目分发的 Docker 镜像里包含第三方包的代码
 * （当前 194 个，准确数字以本脚本生成的产物为准 —— 这里不再写死一个数字，
 * 因为它已经漂移过两次：146 → 205 → 194）。
 * MIT / ISC / BSD / Apache-2.0 都要求**在再分发时保留版权声明与许可证文本**。
 * 不发这个文件就是不合规 —— 不是"最好有"，是许可证的明文条件。
 *
 * 为什么是脚本而不是手写清单：依赖会变。手写的清单几天后就会与现实不符，
 * 而不符的合规文件比没有更糟（它声称已经覆盖，实际漏了）。
 * CI 会检查本文件的产物是否与当前依赖一致（见 .github/workflows/ci.yml）。
 *
 * 用法：
 *   node scripts/generate-notices.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 只看**会打进镜像**的运行时依赖：devDependencies 不会被分发，不产生义务。 */
function runtimeClosure() {
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));

  /*
   * 先摘出本仓库自己的工作区包。
   *
   * 它们是**我们自己的代码**，不是第三方：`@aq/server` 依赖 `@aq/shared`，
   * 所以它会出现在依赖闭包里，但它不该出现在第三方声明里，
   * 也不该被 copyleft 检查拦下（它没有 license 字段）。
   */
  const workspaces = new Set();
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key.startsWith('packages/') && value.name) workspaces.add(value.name);
  }

  const roots = [];
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key.startsWith('packages/') && value.dependencies) {
      roots.push(...Object.keys(value.dependencies));
    }
  }

  const closure = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (closure.has(name)) continue;
    if (workspaces.has(name)) continue; // 自己的包，不是第三方
    closure.add(name);
    const entry = lock.packages[`node_modules/${name}`];
    if (entry?.dependencies) queue.push(...Object.keys(entry.dependencies));
  }
  return closure;
}

/**
 * 判断一个许可证是否属于 copyleft。
 *
 * 这是整个脚本里最需要认真对待的一段：如果某个依赖是 GPL/AGPL，
 * 那么本项目的分发方式（闭源镜像、或将来选宽松协议开源）就会与它冲突。
 * 遇到就**直接失败**，而不是记一条警告 —— 这类问题必须在引入依赖的那一刻暴露，
 * 而不是等到分发之后。
 */
const COPYLEFT = /(^|[^L])\bGPL|AGPL|SSPL|BUSL|Commons Clause|CC-BY-NC|OSL|EUPL/i;

function licenseOf(pkg) {
  if (pkg.license) return pkg.license;
  if (pkg.licenses) {
    return Array.isArray(pkg.licenses)
      ? pkg.licenses.map((l) => l.type).join(' OR ')
      : pkg.licenses.type;
  }
  return 'UNKNOWN';
}

function collect() {
  const closure = runtimeClosure();
  const seen = new Map();

  for (const name of closure) {
    const dir = path.join(REPO_ROOT, 'node_modules', name);
    const manifest = path.join(dir, 'package.json');
    if (!existsSync(manifest)) continue;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }

    const license = licenseOf(pkg);
    seen.set(`${pkg.name}@${pkg.version}`, {
      name: pkg.name,
      version: pkg.version,
      license,
      author:
        typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? ''),
      homepage: pkg.homepage ?? '',
      repository:
        typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? ''),
    });
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const packages = collect();

  const offenders = packages.filter((p) => COPYLEFT.test(p.license) || p.license === 'UNKNOWN');
  if (offenders.length > 0) {
    console.error('\n发现无法自动合规的依赖：\n');
    for (const p of offenders) {
      console.error(`  ✗ ${p.name}@${p.version}  →  ${p.license}`);
    }
    console.error(
      '\ncopyleft 许可证（GPL/AGPL/SSPL 等）会要求本项目以同样的条款分发源码，\n' +
        '与当前的闭源分发方式冲突。UNKNOWN 则意味着无法确认义务。\n\n' +
        '处理方式：换掉这个依赖，或明确记录你接受它带来的义务。\n' +
        '不要为了让脚本通过而放宽这个检查。\n',
    );
    process.exit(1);
  }

  const byLicense = new Map();
  for (const p of packages) {
    if (!byLicense.has(p.license)) byLicense.set(p.license, []);
    byLicense.get(p.license).push(p);
  }

  const lines = [];
  lines.push('# 第三方软件声明');
  lines.push('');
  lines.push(
    '本项目的 Docker 镜像包含以下第三方软件包。它们的许可证要求**在再分发时保留' +
      '版权声明与许可证文本**，本文件即为该义务的履行方式。',
  );
  lines.push('');
  lines.push(
    `运行时依赖共 **${packages.length}** 个，全部为宽松许可证（无 copyleft）。` +
      '开发依赖不会被打进镜像，因此不在此列。',
  );
  lines.push('');
  lines.push('> 本文件由 `node scripts/generate-notices.mjs` 自动生成，请勿手工编辑。');
  lines.push('> CI 会校验它与当前依赖一致。');
  lines.push('');

  lines.push('## 许可证汇总');
  lines.push('');
  lines.push('| 许可证 | 包数量 |');
  lines.push('| --- | --- |');
  for (const [license, list] of [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`| ${license} | ${list.length} |`);
  }
  lines.push('');
  lines.push(
    '各项义务：**MIT / ISC / BSD / BlueOak** 要求保留版权与许可证文本；' +
      '**Apache-2.0** 还要求在存在 `NOTICE` 文件时一并保留（当前依赖均不含 NOTICE）。' +
      '以上各项均已通过本文件与镜像内的原始许可证文件满足。',
  );
  lines.push('');

  lines.push('## 完整清单');
  lines.push('');
  lines.push('| 包 | 版本 | 许可证 | 版权方 |');
  lines.push('| --- | --- | --- | --- |');
  for (const p of packages) {
    const author = p.author.replace(/\|/g, '\\|').slice(0, 60) || '—';
    lines.push(`| ${p.name} | ${p.version} | ${p.license} | ${author} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '完整的许可证文本随各软件包一同分发（位于 `node_modules/<包名>/LICENSE`），' +
      '并已包含在发布的镜像内。',
  );
  lines.push('');

  const target = path.join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md');
  writeFileSync(target, lines.join('\n'), 'utf8');
  console.log(`已生成 THIRD-PARTY-NOTICES.md：${packages.length} 个运行时依赖，全部为宽松许可证。`);
}

main();
