/**
 * **提交里不得出现真实凭据或站点特定信息**（五道闸门的第 ④ 条）。
 *
 * ## 为什么这条可以（也应该）自动化
 *
 * 第 ④ 条原本是**流程性**的（"人工检查"）。但它的**可自动化部分**是明确的：
 *
 * ```
 * ① 真实凭据的形状（API key / JWT / 私钥 / 长随机串）
 * ② 站点特定信息（真实域名、真实 IP、真实账号名）
 * ```
 *
 * ⚠️ 而这个仓库下的是**真实订单** —— 一次误提交的密钥意味着：
 * 拿到仓库的人可以直接下单。**这条闸门值得有守卫，而不是靠"记得检查"。**
 *
 * ## ⚠️ 判据必须区分"真实凭据"与"占位符/测试夹具"
 *
 * 我扫全仓时命中了 6 处，**逐处读过之后全是误报**：
 *
 * | 位置 | 实际内容 |
 * | --- | --- |
 * | `deploy/install.sh` | `${INSTALLER_TOKEN:-${GHCR_TOKEN:-}}` —— **从环境变量读** |
 * | `packages/web/src/lib/api.ts` | `'invalid_current_password'` —— **错误码常量** |
 * | `scripts/demoCycle.ts` | `'demo-not-a-real-key'` —— **占位符** |
 * | `api/authFlow.test.ts` | `'flow-test-secret-not-a-real-key'` 等 —— **测试夹具** |
 *
 * ⚠️ 所以判据不能是"出现 `apiKey:` 就报" —— 那样会**满屏误报**，
 * 而误报的守卫会被人忽略（甚至被删掉）。**判据必须认得出占位符的形状。**
 *
 * ## ⚠️ 判据的作用域也必须划清（我第一版命中了自己）
 *
 * 下面那条"探针校准"用例里**故意**写了真密钥的形状来验证判据有效 ——
 * 于是守卫**报出了自己**（`noCredentialsGuard.test.ts:167/171`）。
 *
 * ⚠️ 这不是"误报"而是"**判据的作用域没划清**"：**校准用的样本不该被当成真实内容**。
 * 所以扫描**排除测试文件**（夹具里出现"像密钥的字符串"是正常的）。
 *
 * ## 边界（诚实说明）
 *
 * · 它抓不住"**看起来不像密钥的站点信息**"（例如一个真实的普通域名）——
 *   那需要一份"允许出现的域名"清单，而那份清单本身要人维护；
 * · 它抓不住**已经提交进历史**的凭据（那要 `git log -p` 扫，且要人处置）；
 * · 它**不扫** `data/`、`.env`（那些本来就不该进仓库，且有 `.gitignore` 管 ——
 *   由下面第三条用例守着）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

/** 要扫的源码目录（**不含** `data/`、`.env`、`node_modules`、构建产物）。 */
const SCAN_DIRS = ['packages', 'scripts', 'deploy'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', '.git', 'coverage'].includes(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json|sh|ps1|yml|yaml|md)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 看起来像**真实密钥**的形状。
 *
 * ⚠️ 每一条都刻意收得**很窄** —— 宽判据会满屏误报，而误报的守卫没人会看。
 */
const SECRET_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'OpenAI 风格密钥（`sk-` + 长随机串）', re: /\bsk-[A-Za-z0-9_-]{24,}/g },
  { name: 'JWT（三段，`eyJ` 开头）', re: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Google API key（`AIza` + 35 位）', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: 'Slack/GitHub token 形状', re: /\b(?:ghp|gho|ghs|ghr|xox[baprs])-[A-Za-z0-9-]{20,}\b/g },
];

/**
 * 占位符 / 测试夹具的关键词 —— 命中这些就**不报**。
 *
 * ⚠️ 这份清单是**判据的一部分**：不列它，判据会因为测试夹具而满屏误报。
 */
const PLACEHOLDER =
  /(your|xxx|placeholder|example|sample|dummy|fake|mock|redacted|not[-_]?a[-_]?real|test|demo|todo|changeme|\*\*\*|<[a-z-]+>)/i;

/** 判定一段文本里有没有"看起来像真实凭据"的内容。 */
function scanSecrets(text: string): string[] {
  const out: string[] = [];
  for (const { name, re } of SECRET_SHAPES) {
    for (const m of text.matchAll(re)) {
      if (PLACEHOLDER.test(m[0])) continue;
      out.push(name);
    }
  }
  return out;
}

test('★★★ 源码里不得出现真实凭据（第 ④ 条闸门的可自动化部分）', () => {
  /*
   * ⚠️ 排除**测试文件** —— 夹具里出现"像密钥的字符串"是正常的，
   * 而下面那条校准用例**故意**写了真形状（我第一版就因此命中了自己）。
   */
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => {
    const rel = f.replace(/\\/g, '/');
    return !rel.endsWith('.test.ts') && !rel.endsWith('.test.tsx');
  });
  assert.ok(files.length >= 100, `★ 只扫到 ${files.length} 个文件 —— 扫描可能失效了`);

  const hits: string[] = [];
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const name of scanSecrets(text)) {
      hits.push(`${rel}（${name}）`);
    }
  }

  assert.deepEqual(
    hits,
    [],
    '★★★ 这些位置出现了**看起来像真实凭据**的内容：\n' +
      hits.map((h) => `      · ${h}`).join('\n') +
      '\n    ⚠️ 这是五道闸门的第 ④ 条：「不得有站点特定信息/凭据」。\n' +
      '    ⚠️ 这个仓库下的是**真实订单** —— 一次误提交的密钥意味着\n' +
      '    拿到仓库的人可以直接下单。\n' +
      '    ✅ 修法：删掉它、**立刻在交易所/服务商那边吊销它**、改用环境变量。\n' +
      '       ⚠️ 光删文件不够 —— 它已经进了 git 历史。',
  );
});

test('★★★ 判据必须能真的报出密钥，且不误报占位符', () => {
  /*
   * ⚠️ "探针校准"（双向）：
   *   ① 真密钥形状**必须**被报出；
   *   ② 占位符/测试夹具**必须**被放过 —— 否则判据会满屏误报，而没人会看误报。
   */
  assert.ok(
    scanSecrets('const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";').length >= 1,
    '★★★ 判据必须能报出 OpenAI 风格密钥 —— 否则上面那条是在空转',
  );
  assert.ok(
    scanSecrets('const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";').length >= 1,
    '★★★ 判据必须能报出 JWT',
  );

  /* ② 占位符与测试夹具必须被放过。 */
  for (const placeholder of [
    "apiKey: 'demo-not-a-real-key'",
    "const JWT_SECRET = 'flow-test-secret-not-a-real-key';",
    "const PASSWORD = 'first-password-42';",
    "const key = 'your-api-key-here';",
    "const key = 'sk-xxxxxxxxxxxxxxxxxxxxxxxx';",
  ]) {
    assert.deepEqual(
      scanSecrets(placeholder),
      [],
      `★★ 占位符/测试夹具不能被误报：${placeholder}\n` +
        '    ⚠️ 满屏误报的守卫会被人忽略，甚至被删掉 —— 那比没有守卫更糟。',
    );
  }
});

test('★★ `.env` 与 `data/` 必须被 git 忽略（凭据不该有进仓库的路径）', () => {
  /*
   * ⚠️ 这条守的是**上游**：如果 `.env` 没被忽略，那么"提交时检查"就是最后一道防线，
   * 而那道防线靠人。**让凭据一开始就进不来**比"检查它有没有进来"更可靠。
   */
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  const lines = gitignore
    .split('\n')
    .map((l) => l.trim().replace(/\/$/, ''))
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  for (const pattern of ['.env', 'data']) {
    assert.ok(
      lines.includes(pattern),
      `★★ \`.gitignore\` 里必须有 \`${pattern}\` ——\n` +
        '    ⚠️ 凭据（`.env`）与运行时数据（`data/`）不该有进仓库的路径。\n' +
        '    "提交时检查"是最后一道防线，而那道防线靠人。',
    );
  }
});
