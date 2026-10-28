const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * 二进制字节数展示（`0 B` / `312 B` / `1.2 MB`）。
 *
 * 单位固定、不随 locale 变化：请求体与上下文面板里的技术数值共用同一口径，避免中文
 * 「万/亿」与二进制单位混用造成误读。迁移自 resource-manager，公开面保持一致。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
}
