/**
 * 部署版本 —— "线上跑的到底是哪一版"。
 *
 * ## 为什么原来的「服务端版本」没有用
 *
 * 控制台「操作员账户」页一直有一个「服务端版本」格子，而它显示的是一个**硬编码的
 * `'0.1.0'`**。那个数字从写下那天起就没变过，也永远不会变 —— 一个永远显示同一个
 * 值的状态显示，比没有更糟：它看起来像在告诉你什么。
 *
 * 真正能回答这个问题的是 **git 提交**。而服务器上**没有 `.git`**：部署是把工作区
 * 打包上传（`.git` 在排除列表里），运行目录里根本没有仓库。所以这份信息只能由
 * **构建机**写下来随包传过去 —— 见 `scripts/deploy.ps1` 生成的 `build-info.json`。
 *
 * ## 它不猜
 *
 * 文件不存在时返回 `null`，控制台显示"未知"。**绝不回落到一个看起来正常的默认值**：
 * "我不知道我跑的是哪一版"和"我跑的是 0.1.0"是两件完全不同的事，
 * 而后者会让一个陈旧的部署看起来是正常的。
 *
 * ## 出站请求的边界
 *
 * 比对走 GitHub 的公开 API，**只在 `checkForUpdates()` 被调用时发生**，且带缓存。
 * 仓库地址来自 `build-info.json`（构建机从 `git remote` 读出来的），所以它不受
 * 用户输入控制；即便如此，owner/repo 仍然要过一遍严格的正则才允许拼进 URL ——
 * 这是纵深防御，不是形式。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, env } from './env.js';
import { createLogger } from './logger.js';

const log = createLogger('build');

/* -------------------------------------------------------------------------- */
/*  Build info                                                                 */
/* -------------------------------------------------------------------------- */

export interface BuildInfo {
  /** Full commit SHA. */
  commit: string;
  commitShort: string;
  branch: string;
  /** The commit's subject line —— 让控制台能显示**部署的是什么**，而不只是一个哈希。 */
  subject: string;
  /** Committer date of that commit (ISO 8601). */
  committedAt: string;
  /** When this build was packaged and shipped (ISO 8601, UTC). */
  deployedAt: string;
  /**
   * 打包时工作区有未提交改动。
   *
   * 这一位必须如实显示：为 true 时服务器跑的东西**不等于**上面那个提交，
   * 而"版本一致"会让一个改到一半的部署看起来是干净的。
   */
  dirty: boolean;
  /** Repository URL, as recorded by the build machine's `origin` remote. */
  repository: string;
}

const BUILD_INFO_FILE = path.join(REPO_ROOT, 'build-info.json');

let buildCache: BuildInfo | null | undefined;

/** Where the build info is expected. Exported so the API can say it in the UI. */
export function buildInfoPath(): string {
  return BUILD_INFO_FILE;
}

/**
 * Read the build info written by the deploy script, or `null` when there is none.
 *
 * Cached for the process lifetime: the file only changes when the process is
 * replaced, and re-reading it on every `/api/system` poll would be pure waste.
 */
export function readBuildInfo(): BuildInfo | null {
  if (buildCache !== undefined) return buildCache;
  buildCache = loadBuildInfoFrom(BUILD_INFO_FILE);
  return buildCache;
}

/**
 * Parse a `build-info.json` at an explicit path.
 *
 * Exported so tests can point at a temporary file — the alternative is writing into
 * the repository root, which is exactly the kind of side effect that makes a test
 * suite leave the working tree dirty.
 */
export function loadBuildInfoFrom(file: string): BuildInfo | null {
  let parsed: Partial<BuildInfo>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>;
  } catch {
    // 没有文件是**正常状态**（部署脚本早于这个功能、或用了别的部署方式），
    // 不是错误 —— 所以这里不记日志，由调用方把"未知"显示出来。
    return null;
  }

  /*
   * 只在字段齐全时才认它。一个半截的文件会让界面显示 "undefined @ undefined"，
   * 那比"未知"更让人困惑：前者看起来像个值，后者明确是个缺口。
   */
  if (typeof parsed.commit !== 'string' || parsed.commit.length === 0) return null;
  if (typeof parsed.branch !== 'string' || parsed.branch.length === 0) return null;

  return {
    commit: parsed.commit,
    commitShort: parsed.commitShort ?? parsed.commit.slice(0, 7),
    branch: parsed.branch,
    subject: parsed.subject ?? '',
    committedAt: parsed.committedAt ?? '',
    deployedAt: parsed.deployedAt ?? '',
    dirty: parsed.dirty === true,
    repository: parsed.repository ?? '',
  };
}

/** Test seam — the cache would otherwise leak between cases. */
export function resetBuildInfoCache(): void {
  buildCache = undefined;
  updateCache = null;
}

/* -------------------------------------------------------------------------- */
/*  Product version                                                            */
/* -------------------------------------------------------------------------- */

let appVersionCache: string | undefined;

/**
 * `package.json` 的 `version` —— **产品版本**，与"部署的是哪个提交"是两回事。
 *
 * 两者都需要，而且不能互相替代：产品版本回答"这是个什么版本的东西"（发版时递增），
 * 提交回答"线上跑的是哪一次构建"（每次部署都变）。原来的问题是**只有前者、而且是
 * 硬编码的**，于是"线上是不是最新版"这个问题在整个界面上没有任何地方能回答。
 *
 * 读不到就回 `'unknown'` —— 不编一个版本号出来。
 */
export function readAppVersion(): string {
  if (appVersionCache !== undefined) return appVersionCache;
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    appVersionCache = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    appVersionCache = 'unknown';
  }
  return appVersionCache;
}

/* -------------------------------------------------------------------------- */
/*  Update check                                                               */
/* -------------------------------------------------------------------------- */

export type UpdateState = 'up-to-date' | 'behind' | 'ahead' | 'diverged' | 'unknown';

export interface UpdateCheck {
  state: UpdateState;
  /** 给操作员看的一句话。**永远不含凭据材料、也永远不含 API 响应原文。** */
  message: string;
  checkedAt: string;
  repository: string | null;
  branch: string | null;
  localCommit: string | null;
  latestCommit: string | null;
  latestCommitShort: string | null;
  latestSubject: string | null;
  latestCommittedAt: string | null;
  /** 只在 `state === 'behind'` 且 compare 成功时给出。 */
  behindBy: number | null;
}

/** GitHub API 地址。可覆盖以指向企业实例；默认是公开 API。 */
const GITHUB_API = (process.env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '');

/**
 * 结果缓存时长。
 *
 * GitHub 未认证的限额是 **60 次/小时/IP**，而这一页可能被反复刷新 ——
 * 10 分钟一次意味着最坏情况 6 次/小时，远在限额内。成功与失败**都**缓存：
 * 一个连不上的部署不该在每次刷新时都白等一次 8 秒超时。
 */
const CACHE_MS = 10 * 60_000;
/** 失败缓存得更短，好让"网络恢复了"能被较快发现。 */
const FAILURE_CACHE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

let updateCache: { at: number; key: string; result: UpdateCheck } | null = null;

/**
 * Turn a repository URL into `owner/repo`, or `null` when it cannot be trusted.
 *
 * Accepts the shapes `git remote get-url` actually produces:
 *   `https://github.com/owner/repo.git`
 *   `git@github.com:owner/repo.git`
 *   `ssh://git@github.com/owner/repo`
 *   `owner/repo`
 *
 * 这里**不能**用一条正则"去掉主机"了事：`owner/repo` 与 `host/owner/repo` 长得
 * 一模一样，一条贪婪的正则会把前者的 `owner/` 当成主机吃掉，于是裸 slug 解析出
 * `repo` 这种半截结果。所以主机的剥离必须**有条件**：只有第一段真的像主机
 * （含点，或是 localhost）时才剥。
 *
 * 字符集故意收得很窄 —— 这个字符串会被**拼进请求 URL**，所以"不是斜杠就行"
 * 是一个洞，不是一条规则。
 */
export function parseRepoSlug(repository: string): string | null {
  let rest = repository.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!rest) return null;

  const scheme = /^[a-z+]+:\/\//i.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);

  const scpLike = /^[^@/]+@([^/:]+):(.+)$/.exec(rest);
  if (scpLike) {
    rest = scpLike[2] as string;
  } else {
    const parts = rest.split('/');
    if (parts.length >= 3) {
      const head = parts[0] ?? '';
      if (head.includes('.') || head === 'localhost') rest = parts.slice(1).join('/');
    }
  }

  const parts = rest.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return `${owner}/${repo}`;
}

interface GithubCommitBody {
  sha?: string;
  commit?: { message?: string; committer?: { date?: string } };
}

interface GithubCompareBody {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
}

/**
 * Ask GitHub what the branch's head is, and how far behind we are.
 *
 * Never throws: every failure becomes a `state: 'unknown'` with a message that
 * says *which* failure it was. A version panel that throws a 500 would take the
 * whole 操作员账户 page down for a diagnostic that is, by definition, optional.
 */
export async function checkForUpdates(info: BuildInfo | null = readBuildInfo()): Promise<UpdateCheck> {
  const checkedAt = new Date().toISOString();
  const base = (state: UpdateState, message: string, extra: Partial<UpdateCheck> = {}): UpdateCheck => ({
    state,
    message,
    checkedAt,
    repository: info?.repository ?? null,
    branch: info?.branch ?? null,
    localCommit: info?.commit ?? null,
    latestCommit: null,
    latestCommitShort: null,
    latestSubject: null,
    latestCommittedAt: null,
    behindBy: null,
    ...extra,
  });

  if (env.updateCheckDisabled) {
    return base('unknown', '服务端已关闭版本比对（UPDATE_CHECK_DISABLED）。');
  }
  if (!info) {
    return base(
      'unknown',
      '这次部署没有写出版本信息，无法判断线上是哪一版。用 scripts/deploy.ps1 重新部署一次就会带上。',
    );
  }
  const slug = parseRepoSlug(info.repository);
  if (!slug) {
    return base('unknown', '版本信息里没有可用的仓库地址，无法与远端比对。');
  }

  const cacheKey = `${slug}#${info.branch}#${info.commit}`;
  if (updateCache && updateCache.key === cacheKey) {
    const age = Date.now() - updateCache.at;
    const ttl = updateCache.result.state === 'unknown' ? FAILURE_CACHE_MS : CACHE_MS;
    if (age < ttl) return updateCache.result;
  }

  const remember = (result: UpdateCheck): UpdateCheck => {
    updateCache = { at: Date.now(), key: cacheKey, result };
    return result;
  };

  try {
    const head = await githubGet<GithubCommitBody>(
      `${GITHUB_API}/repos/${slug}/commits/${encodeURIComponent(info.branch)}`,
    );
    const latestCommit = head.sha ?? '';
    const latestCommitShort = latestCommit ? latestCommit.slice(0, 7) : null;
    // 提交信息是多行的，界面只放得下一行 —— 取主题行，和 `git log --oneline` 一致。
    const latestSubject = (head.commit?.message ?? '').split('\n')[0] ?? '';
    const latestCommittedAt = head.commit?.committer?.date ?? '';

    const seen = {
      latestCommit: latestCommit || null,
      latestCommitShort,
      latestSubject: latestSubject || null,
      latestCommittedAt: latestCommittedAt || null,
    };

    if (latestCommit && latestCommit === info.commit) {
      return remember(base('up-to-date', `与 GitHub 上的 ${info.branch} 一致。`, seen));
    }

    /*
     * 不同 —— 再问一次"差了多少"。
     *
     * compare 有一个会失败的情形值得单独说：**线上那个提交在远端根本不存在**
     * （改完没推就部署了）。那时 GitHub 返回 404，而这既不等于"落后"也不等于
     * "领先" —— 报 `unknown` 并说清原因，比猜一个方向有用。
     */
    let behindBy: number | null = null;
    try {
      const cmp = await githubGet<GithubCompareBody>(
        `${GITHUB_API}/repos/${slug}/compare/${info.commit}...${encodeURIComponent(info.branch)}`,
      );
      /*
       * ## ⚠️ 这两个方向原来**正好写反了**
       *
       * GitHub 的 `compare/{base}...{head}` 语义是「**head 相对 base 怎么样**」：
       * `status: 'ahead'` 表示 **head 领先 base**（`ahead_by` 是 head 多出的提交数）。
       *
       * 而这里的 base 是 `info.commit`（**线上正在跑的那个提交**）、
       * head 是 `info.branch`（**GitHub 上的 main**）。所以：
       *
       *   · `ahead`   ⇒ GitHub 上的 main 领先线上跑的 ⇒ **服务器落后，该部署了**；
       *   · `behind`  ⇒ GitHub 上的 main 落后线上跑的 ⇒ **本地有提交没推**。
       *
       * 原来两句写成了反的（`ahead` 说"领先 GitHub，线上的提交还没推送"）——
       * **一个方向说反的提示比没有提示更糟**：它只在"服务器落后"时出现，
       * 而它让人以为"是我本地忘了推送"，正好指错排查方向。
       *
       * 用真实仓库验证过一次：
       *   `compare/b4b835e...0c1206b` → `{"status":"ahead","ahead_by":2,"behind_by":0}`
       * 即 `ahead` 时**第一个参数（base）是落后的那一方**。
       */
      if (cmp.status === 'ahead') {
        /* 服务器落后：GitHub 上有更新的提交，`ahead_by` 就是差了多少个。 */
        behindBy = cmp.ahead_by ?? null;
        const howFar = behindBy === null ? '' : ` ${behindBy} 个提交`;
        return remember(
          base(
            'behind',
            `落后 GitHub 上的 ${info.branch}${howFar} —— 远端最新是 ${latestSubject || latestCommitShort || '（未知）'}。`,
            { ...seen, behindBy },
          ),
        );
      }
      if (cmp.status === 'behind') {
        /* 服务器领先：本地有提交还没推上去。 */
        return remember(
          base('ahead', `领先 GitHub 上的 ${info.branch} —— 本地的提交还没推送。`, seen),
        );
      }
      if (cmp.status === 'diverged') {
        return remember(base('diverged', `与 GitHub 上的 ${info.branch} 已经分叉。`, seen));
      }
      if (cmp.status === 'identical') {
        return remember(base('up-to-date', `与 GitHub 上的 ${info.branch} 一致。`, seen));
      }
    } catch {
      return remember(
        base(
          'unknown',
          `线上的提交 ${info.commitShort} 在 GitHub 上找不到 —— 它可能还没有推送，或者分支被改写过。`,
          seen,
        ),
      );
    }

    /*
     * 兜底：`compare` 成功、但 `status` 是上面四个之外的值（GitHub 将来加了新状态，
     * 或者返回了一个我们没预期的形状）。
     *
     * 这时 `behindBy` 一定是 `null`（它只在 `ahead` 分支里被赋值），所以给出的
     * 是一句不带数字的"落后"——**方向选"落后"而不是"领先"**：落后意味着
     * "线上不是最新的"，那是一个值得去看一眼的状态；而"领先"暗示"一切正常"。
     * 一个说不清的版本比对，宁可让人去部署一次，也不要让人以为没事。
     */
    const howFar = behindBy === null ? '' : ` ${behindBy} 个提交`;
    return remember(
      base(
        'behind',
        `落后 GitHub 上的 ${info.branch}${howFar} —— 远端最新是 ${latestSubject || latestCommitShort || '（未知）'}。`,
        { ...seen, behindBy },
      ),
    );
  } catch (error) {
    /*
     * 失败也缓存（更短），并且**只回我们自己的话**：GitHub 的响应体可能很长、
     * 也可能含有我们不该替它转述的内容。
     */
    const reason = (error as Error).message;
    log.warn(`版本比对失败：${reason}`);
    return remember(base('unknown', `无法连接 GitHub：${reason}`));
  }
}

/**
 * One GET against the GitHub API.
 *
 * `env.githubToken` (when present) goes into the request header only — never into
 * a log line, an error message or the response body. Same convention as the LLM
 * client's API keys.
 */
async function githubGet<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'auto-quant/0.1',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.githubToken) headers.Authorization = `Bearer ${env.githubToken}`;

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    if (response.status === 404) throw new Error('仓库或分支不存在（私有仓库需要 GITHUB_TOKEN）');
    if (response.status === 403 || response.status === 429) throw new Error('GitHub 接口速率受限');
    throw new Error(`GitHub 返回 HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
