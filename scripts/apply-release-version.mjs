// 版本戳写回的唯一实现：stamp job 只生成 version，两个构建 job 各自用同一个 version 改自己
// 工作区的 package.json。只替换首个顶层 "version" 字段，其余字节（编码、行尾、结尾换行）保持不变。

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const VERSION_FIELD_PATTERN = /^(\s*"version":\s*")([^"]+)(")/mu;

const [version, packageJsonArg] = process.argv.slice(2);
if (!version) {
  throw new Error("usage: node scripts/apply-release-version.mjs <version> [package.json]");
}

const packageJsonPath = resolve(packageJsonArg ?? "package.json");
const text = readFileSync(packageJsonPath, "utf8");
if (!VERSION_FIELD_PATTERN.test(text)) {
  throw new Error(`version field not found in ${packageJsonPath}`);
}
const updated = text.replace(
  VERSION_FIELD_PATTERN,
  (_match, prefix, _previous, suffix) => `${prefix}${version}${suffix}`,
);
writeFileSync(packageJsonPath, updated, "utf8");
console.log(`[release-version] ${packageJsonPath} → ${version}`);
