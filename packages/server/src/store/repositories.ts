/**
 * 数据仓储统一出口（Barrel）。
 *
 * 按业务表拆分为 6 个无循环依赖的领域模块，外部调用方继续从 `./repositories.js` 导入即可：
 * - `configRepos.ts`   — users / exchanges / aiModels / strategies / traders / runInTransaction
 * - `positionsRepo.ts` — positions / orderIdIn
 * - `ordersRepo.ts`    — orders / margin mode helpers
 * - `tradesRepo.ts`    — trades / performance / attribution
 * - `decisionsRepo.ts` — decisions
 * - `telemetryRepo.ts` — equity / tradeEvents / settings / runtimeLogs / computeTraderStats
 */
export * from './configRepos.js';
export * from './positionsRepo.js';
export * from './ordersRepo.js';
export * from './tradesRepo.js';
export * from './decisionsRepo.js';
export * from './telemetryRepo.js';
