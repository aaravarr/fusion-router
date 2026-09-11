/** 采样窗口：只统计最近 30 天的请求（对齐看板最长预设区间），绝不回扫全表。 */
export const USAGE_FACET_WINDOW_MS = 30 * 24 * 3600 * 1000
/** 「近期仍活跃」判定窗口：模型在最近 24 天内出现过才进入下拉主列表。 */
export const USAGE_FACET_RECENT_MS = 24 * 24 * 3600 * 1000
/** 采样行数上限：只扫窗口内最近 N 行（owner+started_at 索引前缀），绝不全表扫描。 */
export const USAGE_FACET_SAMPLE_ROWS = 5_000
/** 单维度选项数上限：超过后不再收录（高频值在前，低频尾部截断）。 */
export const USAGE_FACET_MAX_OPTIONS = 200
