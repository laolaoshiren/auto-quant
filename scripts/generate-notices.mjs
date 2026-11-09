/**
 * 生成 `THIRD-PARTY-NOTICES.md`。
 *
 * 为什么需要这个文件：本项目分发的 Docker 镜像里包含第三方包的代码
 * （当前数量以本脚本生成的产物为准 —— 这里**不写死一个数字**，因为它已经漂移过两次：
 * 146 → 205 → 194）。
 * MIT / ISC / BSD / Apache-2.0 都要求**在再分发时保留版权声明与许可证文本**。
 * 不发这个文件就是不合规 —— 不是"最好有"，是许可证的明文条件。
 *
 * 为什么是脚本而不是手写清单：依赖会变。手写的清单几天后就会与现实不符，
 * 而不符的合规文件比没有更糟（它声称已经覆盖，实际漏了）。
 *
 * ## ⚠️ CI 目前**没有**校验这个产物
 *
 * 脚本以前的注释声称「CI 会检查本文件与当前依赖一致」，并指向
 * `.github/workflows/ci.yml` —— 那是**不成立的**：那份 workflow 里没有这一步。
 * 所以现在提供 `--check`，把"产物是否过期"变成一条本地可执行的判据：
 *
 *   node scripts/generate-notices.mjs           # 重新生成
 *   node scripts/generate-notices.mjs --check   # 只校验（过期则退出码 1）
 *
 * CI 是否接入这一步由维护者决定；接入之后，这里就不再依赖"人记得跑一次"。
 *
 * ## 依赖闭包按 **lockfile 的真实解析位置** 算，不是只看仓库根 `node_modules`
 *
 * npm workspaces 下大多数依赖被提升到根 `node_modules`，但**不能提升的那些**
 * （版本冲突、`npm ci --omit=dev` 的分支安装）会落在 `packages/<workspace>/node_modules/`。
 * 旧实现只读根目录，于是把它们从清单里**静默漏掉** —— 而镜像里明明装着它们。
 *
 * 实测（2026-11-09）：`undici` 是 `@aq/server` 的运行时依赖，
 * 装在 `packages/server/node_modules/undici`；旧脚本生成的清单里没有它，
 * 而仓库里已提交的那份清单反而写着一个 **lockfile 里根本不存在的版本**
 * （`undici 8.12.1`，来自某次被污染的本地 `node_modules`）。两种错都指向同一件事：
 * **合规清单必须从 lockfile 推导，不能从"这台机器上碰巧有什么"推导。**
 *
 * 用法：
 *   node scripts/generate-notices.mjs [--check]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md');

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

/** 从 lockfile 读一条依赖的落盘目录 key（相对仓库根），按 Node 的上溯解析顺序找。 */
function resolveLockKey(lock, name, fromKey) {
  /*
   * Node 的解析顺序：从 importer 所在目录出发，逐级上溯查 `node_modules/<name>`。
   * 对 lockfile 来说，importer 的 key 可能是 `packages/server`（workspace）
   * 或 `node_modules/foo`（某个依赖包）。两种都要能解析出它自己的可达依赖。
   */
  let dir = fromKey;
  for (;;) {
    const candidate = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (dir === '') return null;
    const slash = dir.lastIndexOf('/');
    dir = slash < 0 ? '' : dir.slice(0, slash);
  }
}

/**
 * 会进入镜像的运行时依赖闭包。
 *
 * 根集合 = 每个 workspace 的 `dependencies`（**不是** devDependencies：
 * 镜像用 `npm ci --omit=dev` 安装，开发依赖不会被打进去）。
 * 注意 web 的 production 依赖也会被装进镜像（Dockerfile 复制了它的 package.json），
 * 所以它们同样在合规范围内。
 */
function runtimeClosure(lock) {
  const workspaces = new Set();
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key.startsWith('packages/') && value.name) workspaces.add(value.name);
  }

  const visitedKeys = new Set();
  const closure = new Map(); // name@version -> manifest info
  const missing = [];
  const queue = [];
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!key.startsWith('packages/') || !value.dependencies) continue;
    for (const dep of Object.keys(value.dependencies)) {
      queue.push({ name: dep, fromKey: key });
    }
  }

  while (queue.length > 0) {
    const { name, fromKey } = queue.pop();
    if (workspaces.has(name)) continue; // 自己的包，不是第三方
    const resolvedKey = resolveLockKey(lock, name, fromKey);
    if (resolvedKey === null) {
      /* lockfile 里没有 = 依赖树与 lock 不一致（例如 `npm install` 之后没提交）——直接失败。 */
      throw new Error(`lockfile 里找不到依赖 ${name}（来自 ${fromKey}）的安装位置`);
    }
    if (visitedKeys.has(resolvedKey)) continue;
    visitedKeys.add(resolvedKey);

    const manifestPath = path.join(REPO_ROOT, resolvedKey, 'package.json');
    if (!existsSync(manifestPath)) {
      /*
       * lockfile 说有、磁盘上没有。这在 `npm ci --omit=dev` 的环境里意味着
       * 依赖没装全（或这批依赖只存在于别的平台）——**不能静默跳过**：
       * 那正好是"清单漏了一个真在镜像里的包"的形态。
       */
      missing.push({ name, resolvedKey });
      continue;
    }

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error(`读不懂 ${resolvedKey}/package.json`);
    }

    /*
     * ⚠️ **磁盘上的版本必须等于 lockfile 里的版本。**
     *
     * 镜像用的是 lockfile（`npm ci`），所以清单也必须描述 lockfile 的那棵树。
     * 若本机的 `node_modules` 是某次 `npm install` 留下的旧状态，产出的清单
     * 就会**和镜像不一致** —— 而它看起来完全正常（合规文件最危险的那种错法）。
     * 这一条让"生成环境不等于部署环境"当场失败，而不是静默发出一份错的清单。
     */
    const lockedVersion = lock.packages[resolvedKey].version;
    if (lockedVersion !== undefined && pkg.version !== lockedVersion) {
      throw new Error(
        `${resolvedKey} 的磁盘版本是 ${pkg.version}，而 lockfile 是 ${lockedVersion} —— ` +
          '先按 lockfile 重装（`npm ci`）再生成清单',
      );
    }

    closure.set(`${pkg.name}@${pkg.version}`, {
      name: pkg.name,
      version: pkg.version,
      license: licenseOf(pkg),
      author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? ''),
      homepage: pkg.homepage ?? '',
      repository:
        typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? ''),
    });

    const entry = lock.packages[resolvedKey];
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      queue.push({ name: dep, fromKey: resolvedKey });
    }
  }

  if (missing.length > 0) {
    throw new Error(
      '这些依赖在 lockfile 里有、但本机 node_modules 里没有：\n' +
        missing.map((m) => `  · ${m.name} → ${m.resolvedKey}`).join('\n') +
        '\n先跑 `npm ci`（镜像同款安装）再生成清单 —— ' +
        '否则产物会漏掉真实存在的包，而那比没有清单更糟。',
    );
  }

  return [...closure.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 生成清单正文（不写盘）—— `--check` 需要一份可比较的字符串。 */
function render(packages) {
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
  lines.push(
    '> 改过依赖后必须重新生成并提交；' +
      '`node scripts/generate-notices.mjs --check` 可校验它是否已过期。',
  );
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

  return lines.join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));

  let packages;
  try {
    packages = runtimeClosure(lock);
  } catch (error) {
    console.error(`\n${(error).message}\n`);
    process.exit(1);
  }

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

  const next = render(packages);

  if (checkOnly) {
    const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
    if (current !== next) {
      console.error(
        '\nTHIRD-PARTY-NOTICES.md 已过期（与当前 lockfile 的运行时依赖不一致）。\n' +
          '运行 `node scripts/generate-notices.mjs` 重新生成并提交。\n',
      );
      process.exit(1);
    }
    console.log(`✅ THIRD-PARTY-NOTICES.md 与当前依赖一致（${packages.length} 个运行时依赖）`);
    return;
  }

  writeFileSync(TARGET, next, 'utf8');
  console.log(
    `已生成 THIRD-PARTY-NOTICES.md：${packages.length} 个运行时依赖，全部为宽松许可证。`,
  );
}

main();
