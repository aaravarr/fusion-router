/** 采样行数上限：只扫最近 N 行（owner+started_at 索引前缀），绝不全表扫描。 */
export const FACET_SAMPLE_ROWS = 5_000
/** 单维度选项数上限：超过后不再收录（高频值在前，低频尾部截断）。 */
export const FACET_MAX_OPTIONS = 200
