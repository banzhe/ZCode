import type { ResourceUsageCategory, ResourceUsageProcess } from "@zcode/shared";

/** 三组固定顺序：基础服务 / 内置插件 / 社区插件 */
export const RESOURCE_USAGE_CATEGORY_ORDER: readonly ResourceUsageCategory[] = [
  "base",
  "builtin-plugin",
  "community-plugin",
];

export interface ResourceUsageGroupView {
  category: ResourceUsageCategory;
  processCount: number;
  cpuPercent: number;
  memoryBytes: number;
  /** 组内是否有指标尚未采到的进程 */
  hasUnsampled: boolean;
  /** 按 CPU 降序、内存降序、pid 升序 */
  processes: ResourceUsageProcess[];
}

export function groupResourceUsage(
  processes: readonly ResourceUsageProcess[],
): ResourceUsageGroupView[] {
  return RESOURCE_USAGE_CATEGORY_ORDER.map((category) => {
    const members = processes
      .filter((process) => process.category === category)
      .sort(
        (left, right) =>
          right.cpuPercent - left.cpuPercent ||
          right.memoryBytes - left.memoryBytes ||
          left.pid - right.pid,
      );
    return {
      category,
      processCount: members.length,
      cpuPercent: roundPercent(members.reduce((sum, process) => sum + process.cpuPercent, 0)),
      memoryBytes: members.reduce((sum, process) => sum + process.memoryBytes, 0),
      hasUnsampled: members.some((process) => !process.sampled),
      processes: members,
    };
  });
}

export function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function formatPercent(value: number): string {
  return `${roundPercent(value).toFixed(1)}%`;
}

// 字节格式化已迁到共享 lib（请求性能面板同口径）；这里保留 re-export 不改变本模块公开面。
export { formatBytes } from "@/lib/byteSizeFormat.js";
