/**
 * Trader dashboard tables barrel: 当前持仓 / 当前委托 / 历史成交 / 订单记录.
 *
 * Keeps all historical imports from `components/TraderTables` stable while the
 * implementation lives in focused submodules under `components/tables/`.
 */
export { TraderTables, type TraderTabId } from './tables/TraderTablesContainer';
export { PositionsTable } from './tables/PositionsTable';
export { OrdersTable, isOpenOrder } from './tables/OrdersTable';
export { TradesTable } from './tables/TradesTable';
