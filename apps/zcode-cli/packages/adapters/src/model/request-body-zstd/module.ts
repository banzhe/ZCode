/**
 * model-request-body-zstd 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const modelRequestBodyZstdModule = {
  id: "model-request-body-zstd",
  requires: [],
  provides: ["model-request-body-zstd"],
  publicEntrypoints: ["request-body-zstd-fetch.ts", "contract.ts"],
} as const;
