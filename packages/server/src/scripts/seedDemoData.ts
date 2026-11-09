/**
 * **演示数据填充 —— 入口（负责把写操作锁进演示库）**
 *
 * 真正造数据的那一大段在 `seedDemoData.impl.ts`。这个文件只做一件事：
 * **在 `env.ts` 被加载之前决定 `DATA_DIR`**，从而保证 `npm run seed:demo`
 * 永远不会往真实的 `data/` 里灌演示数据。
 *
 * ## 为什么必须拆成两个文件
 *
 * `env.ts` 在**模块加载时**就把 `DATA_DIR` 解析成常量（`dbPath = path.join(env.dataDir, …)`），
 * 而 ESM 的静态 `import` 先于模块体执行。所以"在同一个文件里先设置
 * `process.env.DATA_DIR` 再 import 数据库"是做不到的 —— 导入早已发生。
 * 唯一的办法是让入口文件用**动态 `import()`** 去加载实现，中间隔着一次
 * "环境变量已经写好"的时刻。
 *
 * 这不是过度设计：`data/` 里有加密后的交易所凭据与 AES 主密钥
 * （`docs/AGENTS.md` §4.1）。一个会往生产库灌 14 个假机器人、几千笔假成交的脚本，
 * 只要有一次在真实部署上被误跑，运维就得面对"哪些是真的"这个问题 ——
 * 而账本里混进假数据，比没有数据更糟。
 *
 * ## 用法
 *
 * ```bash
 * npm run seed:demo                 # 默认写 .dsh/demo-data（与真实 data/ 隔离）
 * npm run seed:demo:clean           # 只清理演示库
 * npm run seed:demo -- --scale 3    # 三倍规模（压力测试）
 * npm run seed:demo -- --data-dir .dsh/demo-data-b
 * ```
 *
 * 指向哪个库由这四者决定（优先级从高到低）：
 *
 * 1. `--data-dir <path>` 命令行参数；
 * 2. 环境变量 `DATA_DIR`（`DATA_DIR=... npm run seed:demo`）—— 显式指定，永远优先；
 * 3. `.env` 里的 `DATA_DIR` —— **但仅当它不指向真实 `data/` 时**；
 * 4. 以上都没有（或 `.env` 指的正是真实库）→ `.dsh/demo-data`。
 *
 * ## 为什么 `.env` 指向 `data/` 时要**忽略**它
 *
 * `.env` 是**服务端**的配置，其中 `DATA_DIR=./data` 是文档里的默认值。如果
 * 原样照抄，一台全新机器上"一条命令"就会直接撞上拒绝 —— 那不是安全，是
 * **没人能跑通**。而安全承诺仍然完整：
 *
 *   · 想灌演示库 → `npm run seed:demo`（默认 `.dsh/demo-data`）；
 *   · 显式 `--data-dir ./data` 或 `DATA_DIR=./data` → **拒绝**（要加
 *     `--allow-real-dir` 二次确认）。
 *
 * ⚠️ **解析结果等于仓库的 `data/` 时会直接拒绝**（退出码 1）。演示数据必须写进
 * 独立的目录，用同一条命令去"方便地"灌真实库是一个不该存在的便利。
 * 确实要在自己的开发库里灌（例如你明确知道那台机器没有真实凭据），
 * 加 `--allow-real-dir` 显式说明。
 *
 * ## 与其它脚本的关系
 *
 * | 脚本 | 写哪 | 用途 |
 * | --- | --- | --- |
 * | `demoCycle.ts` | 真实库（`[DEMO]` 前缀） | **一条**决策周期，跑完整流水线（要联网、要模型） |
 * | `simulate.ts` | 临时库 | 全生命周期回放，控制台看不到 |
 * | `seedDemoData.ts`（本入口） | **演示库**（默认 `.dsh/demo-data`） | **规模化、多形态**的确定性数据，控制台直接看 |
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `packages/server/src/scripts` → 仓库根。与 `env.ts` 的 `REPO_ROOT` 同一个值。 */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
/** 真实数据库目录 —— 演示数据**永远不写这里**。 */
const REAL_DATA_DIR = path.join(REPO_ROOT, 'data');
/** 默认演示库目录。`.dsh/` 是本地目录（不入库，部署脚本也排除它）。 */
const DEFAULT_DEMO_DIR = path.join(REPO_ROOT, '.dsh', 'demo-data');

const argv = process.argv.slice(2);
const hasFlag = (name: string): boolean => argv.includes(`--${name}`);
const flagValue = (name: string): string | null => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
};

/**
 * 读 `.env` 里的 `DATA_DIR`。
 *
 * 为什么自己读一遍而不是等 `env.ts`：本文件必须在任何会加载 `env.ts` 的模块
 * **之前**决定目录，而 `env.ts` 正是在加载时自己读 `.env` 的。这里只解析
 * `DATA_DIR=` 这一行（与 `env.ts` 的极简解析器同一套规则：`#` 注释、可选引号）。
 */
function dataDirFromDotEnv(): string | null {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== 'DATA_DIR') continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value === '' ? null : value;
  }
  return null;
}

/** 相对路径按仓库根解析 —— 与 `env.ts` 的 `dataDir` 完全一致。 */
function absoluteDataDir(raw: string): string {
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(REPO_ROOT, raw);
}

const explicit = flagValue('data-dir');
/*
 * `.env` 里的 `DATA_DIR` 只在**它不指向真实库**时才被采纳。
 *
 * 这不是"多一个判断"，而是"一条命令能跑通"与"绝不写真实库"两个要求同时成立
 * 的唯一解：文档让所有人把 `DATA_DIR=./data` 写进 `.env`，而演示脚本的默认目标
 * 必须是演示库。显式环境变量（`DATA_DIR=... npm run seed:demo`）仍然优先 ——
 * 那是操作员当场表达的意图，不受这条规则影响。
 */
const dotEnvRaw = dataDirFromDotEnv();
const dotEnvResolved = dotEnvRaw === null ? null : absoluteDataDir(dotEnvRaw);
const dotEnvPointsAtRealData =
  dotEnvResolved !== null && path.relative(dotEnvResolved, REAL_DATA_DIR) === '';
const chosen =
  explicit ??
  process.env.DATA_DIR ??
  (dotEnvPointsAtRealData ? DEFAULT_DEMO_DIR : dotEnvResolved) ??
  DEFAULT_DEMO_DIR;
const resolved = absoluteDataDir(chosen);

if (dotEnvPointsAtRealData && explicit === null && !process.env.DATA_DIR) {
  console.log(
    `.env 里的 DATA_DIR 指向真实库（${dotEnvResolved}），演示脚本已忽略它，改用 ${DEFAULT_DEMO_DIR}。`,
  );
}

/*
 * ⚠️ **这条闸是本次改造的核心承诺**（用户 2026-11-10："绝不污染真实 data/"）。
 *
 * 用路径相等而不是"包含 data 字样"：`./data-demo` 是合法的演示库，而
 * `data/` 才是那个不能碰的目录。用 `path.relative` 处理大小写/尾斜杠差异。
 */
const relativeToReal = path.relative(resolved, REAL_DATA_DIR);
const isRealDataDir = relativeToReal === '';
if (isRealDataDir && !hasFlag('allow-real-dir')) {
  console.error(
    [
      '',
      '✗ 拒绝执行：演示数据要写入真实数据库目录。',
      `    目标：${resolved}`,
      '',
      '  演示脚本会清空并重灌整批机器人/成交/决策数据，而 data/ 里是真实账本、',
      '  加密凭据与 AES 主密钥（docs/AGENTS.md §4.1）。',
      '',
      '  请改用独立目录（默认即可）：',
      '    npm run seed:demo',
      '    npm run seed:demo -- --data-dir .dsh/demo-data',
      '',
      '  如果你**明确知道**这台机器没有真实数据、就是要灌自己的开发库，',
      '  再加 --allow-real-dir 显式确认。',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/*
 * 现有环境变量优先（用户显式指定的 `DATA_DIR=... npm run seed:demo` 必须被尊重）；
 * 否则把解析结果灌进去，让随后加载的 `env.ts` 读到它。
 *
 * `env.ts` 的 `.env` 加载规则是"真实环境变量优先"，所以这里写进去之后，
 * `.env` 里那个 `DATA_DIR` 不会反过来覆盖它。
 */
if (process.env.DATA_DIR === undefined || process.env.DATA_DIR === '') {
  process.env.DATA_DIR = resolved;
}

console.log(`演示库：${process.env.DATA_DIR}（真实库 ${REAL_DATA_DIR} 不动）`);

/*
 * 动态 import —— 到这一刻 `DATA_DIR` 已经确定，实现文件里所有对 `env.ts`
 * 的读取（`dbPath`、`resolveMasterKey`）都会落到演示库上。
 */
try {
  await import('./seedDemoData.impl.js');
} catch (error) {
  console.error(`填充失败：${(error as Error).message}`);
  console.error(error);
  process.exitCode = 1;
}
