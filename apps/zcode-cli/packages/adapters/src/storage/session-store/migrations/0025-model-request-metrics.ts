/**
 * 0025：模型请求的传输指标（请求体字节、zstd 压缩后字节、上传完成耗时、provider 时钟）。
 *
 * 只加一列 JSON，不改既有列、不建新表：一条 `model_usage` 行仍是一次物理请求的唯一事实，
 * 请求性能面板按会话聚合这列；旧行该列为 NULL，按「无法测量」处理，不回填猜测值。
 */
export const MODEL_REQUEST_METRICS_MIGRATION_SQL = `
  alter table model_usage add column request_metrics_json text;
`;
