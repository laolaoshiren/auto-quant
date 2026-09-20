/**
 * `tailwind.config.js` 是 JavaScript，本身没有类型声明。
 *
 * 测试需要读它的颜色 token（`equityCurve.test.ts` 里那条"CHART_INK 必须与
 * tailwind 的 token 逐位一致"的用例），而 `tsc -p tsconfig.test.json` 会
 * 顺着 import 检查过来 —— 没有这份声明就会报 TS7016（隐式 any）。
 *
 * 这里只声明**测试真正用到的形状**（`theme.extend.colors`），而不是把整个
 * Tailwind 配置类型化：那份类型属于 tailwindcss 包，重复一遍只会两边漂移。
 */
declare const config: {
  theme: {
    extend: {
      colors: {
        up: string;
        down: string;
        warn: string;
        accent: string;
        base: Record<string, string>;
        ink: Record<string, string>;
      };
    };
  };
};

export default config;
