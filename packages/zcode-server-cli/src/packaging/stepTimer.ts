/**
 * staging 阶段计时的唯一出口。`[ci][timer] <label> start` / `... end duration_ms=` 是发布链路的
 * 日志契约（docs/specs/release-pipeline-build-reuse.md），桌面打包侧 bundle.mjs 用同一格式，
 * 因此这里必须输出裸行，不能加 `[stage]` 之类的前缀。
 */
export async function timeStep<T>(label: string, task: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return await task();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startedAt}`);
  }
}
