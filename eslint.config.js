/**
 * ESLint —— **只做一件事**：检查 React Hook 的调用规则。
 *
 * ## 为什么专门为这一件事引入 ESLint
 *
 * 这个仓库对依赖是克制的（`node:sqlite`、手写 JWT、手写 .env 解析、HTTP 用内置
 * `fetch`），默认答案是"自己写那 30 行"。但 Hook 规则检查**不是 30 行能写的**：
 * 它要判断"某个 hook 会不会在某条控制流上被跳过"，需要 AST + 控制流分析。
 *
 * 而这正是我在这里真实犯过的一个错：`useMemo` 被写在条件 `return` **之后** ——
 * 加载态那次渲染提前返回、少执行一个 hook，数据到位后 hook 数从 N 变成 N+1，
 * React 抛 `error #310`，整个机器人详情页白屏。
 *
 * **没有任何一层能拦住它**：
 *
 *   · `tsc`（typecheck）—— 只看类型，不看 hook 的调用顺序
 *   · `tsx --test`（单元测试）—— 除非起一个渲染环境做**两次**渲染，否则看不见
 *   · `vite build` —— 语法和类型都对，构建全绿
 *
 * 只有 `react-hooks/rules-of-hooks` 在**写代码的那一刻**就报出来。所以这里用
 * ESLint，而且**只开这两条规则**。
 *
 * ## 为什么不开 `recommended`
 *
 * 引入整套 `js.configs.recommended` / `tseslint.configs.recommended` 会立刻产生
 * 几十条与本次目的无关的风格告警（`no-unused-vars`、`no-explicit-any`…）。那样
 * 真正要防的那一条会被淹在噪声里 —— 而**一个响个不停的检查等于没有检查**
 * （`docs/DEVELOPMENT.md` 里记过同类教训）。
 *
 * `exhaustive-deps` 设为 `warn` 而不是 `error`：漏依赖是"可能有问题"，
 * 而 hook 顺序错是"一定白屏"。两者不该同一个严重度。
 */
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      /**
       * ★ 这条是本文件存在的全部理由。
       *
       * Hooks 必须在每次渲染时**以同样的顺序**被调用：不能放在条件、循环、
       * 提前 `return` 之后，也不能嵌套在函数里。
       */
      'react-hooks/rules-of-hooks': 'error',
      /**
       * 依赖数组不全会让 effect 读到过期的值 —— 真实但更隐蔽，
       * 所以是 `warn`（不阻塞提交，但看得见）。
       */
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
