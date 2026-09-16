/**
 * 决策流 SSR 回归检查 —— 入口包装。
 *
 * ## 为什么需要这一个包装
 *
 * 检查本身在 `ssr-decision-feed.tsx` 里（它是一个 **.tsx**，用 JSX 写元素树，
 * 可读性比 `createElement` 好得多）。但它有两个硬约束：
 *
 *   1. `tsx` 决定 JSX 转换方式（经典 `React.createElement` 还是 `react-jsx`）靠的是
 *      **入口文件所在目录树**能不能找到一份带 `jsx: react-jsx` 的 `tsconfig.json`。
 *      `packages/web/src/**` 命中 `packages/web/tsconfig.json`，而 `scripts/` 不在任何
 *      workspace 里 —— 直接把 `.tsx` 当入口，一跑就是
 *      `ReferenceError: React is not defined`（在别人的组件里爆，很难看出原因）。
 *   2. `TSX_TSCONFIG_PATH` 必须在 **tsx 启动之前**就存在于环境里：代码里
 *      `process.env.X = ...` 是**没用**的 —— 模块解析在入口文件第一行执行之前
 *      就完成了。所以设它这件事只能发生在**另一个进程**里。
 *
 * 这个 `.mjs` 只做那一件事：把 `TSX_TSCONFIG_PATH` 设成 `packages/web/tsconfig.json`
 * 的**绝对路径**，再用 `--import tsx` 拉起那份 `.tsx`。**绝对路径**这个细节必要：
 * 相对路径会被子进程按自己的 cwd 解析，从别的工作目录跑就找不到配置。
 *
 * 它不加任何依赖：`tsx` 是 `@aq/server` 的依赖，npm 会提升到仓库根目录，
 * 因此 `--import tsx` 这个裸标识符能解析到。找不到时下面的报错会直说。
 *
 * ## 用法
 *
 *     npm run test:feed
 *     node scripts/ssr-decision-feed.mjs        # 等价，任何工作目录都行
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, 'ssr-decision-feed.tsx');
const WEB_TSCONFIG = path.resolve(HERE, '../packages/web/tsconfig.json');

if (!existsSync(CHECK)) {
  process.stderr.write(`找不到检查脚本：${CHECK}\n`);
  process.exit(1);
}
if (!existsSync(WEB_TSCONFIG)) {
  process.stderr.write(
    `找不到 ${WEB_TSCONFIG} —— 这份检查需要它把 .tsx 按 react-jsx 编译。\n`,
  );
  process.exit(1);
}

const run = spawnSync(process.execPath, ['--import', 'tsx', CHECK], {
  stdio: 'inherit',
  env: { ...process.env, TSX_TSCONFIG_PATH: WEB_TSCONFIG },
});

if (run.error) {
  process.stderr.write(
    `子进程没跑起来：${run.error.message}\n` +
      '这一步需要 `tsx`（仓库根目录 node_modules 里应该有）：npm install\n',
  );
  process.exit(1);
}
if (run.signal) {
  process.stderr.write(`子进程被信号 ${run.signal} 终止。\n`);
  process.exit(1);
}

const status = run.status ?? 1;
process.stdout.write(
  status === 0
    ? '\n全部通过：四种执行状态都渲染进了 HTML。\n'
    : '\n检查失败 —— 每一条失败都对应屏幕上会少掉的一句话。\n',
);
process.exit(status);
