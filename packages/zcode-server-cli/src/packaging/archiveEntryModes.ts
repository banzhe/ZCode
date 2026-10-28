import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const BLOCK_SIZE = 512;
const NAME_FIELD_OFFSET = 0;
const NAME_FIELD_LENGTH = 100;
const MODE_FIELD_OFFSET = 100;
const MODE_FIELD_LENGTH = 8;
const SIZE_FIELD_OFFSET = 124;
const SIZE_FIELD_LENGTH = 12;
const CHECKSUM_FIELD_OFFSET = 148;
const CHECKSUM_FIELD_LENGTH = 8;
const TYPE_FLAG_OFFSET = 156;
const EXECUTABLE_MODE = 0o755;
const PAX_EXTENDED_HEADER = "x";
const GNU_LONG_NAME_HEADER = "L";

export interface ApplyArchiveExecutableModesOptions {
  archivePath: string;
  /** 相对发行根的可执行路径，例如 `bin/zcode`、`runtime/node`、`runtime/tools/ripgrep/rg`。 */
  executablePaths: readonly string[];
}

/**
 * Bug 原因：NTFS 不保存 POSIX exec 位，Windows 宿主上的 `chmod(0o755)` 只切换只读属性，
 * System32 bsdtar 于是把归档成员记成 0666（目录 0777）。远端 `tar -xzf` 原样恢复后，
 * 首次安装执行 `<bootstrap>/bin/zcode` 直接 `Permission denied`，稳定启动器
 * `exec <release>/runtime/node` 同样失败。可执行性因此不能依赖宿主文件系统：归档落盘后
 * 按 staging 声明补齐；宿主已记录 0755 时跳过重写，POSIX 产物逐字节不变。
 */
export async function applyArchiveExecutableModes(
  options: ApplyArchiveExecutableModesOptions,
): Promise<void> {
  const executablePaths = new Set(options.executablePaths);
  if (executablePaths.size === 0) return;

  const plainTarPath = `${options.archivePath}.${process.pid}.tar`;
  const temporaryArchivePath = `${options.archivePath}.${process.pid}.tmp`;
  try {
    await pipeline(
      createReadStream(options.archivePath),
      createGunzip(),
      createWriteStream(plainTarPath),
    );
    const changedEntries = await rewriteExecutableModes(plainTarPath, executablePaths);
    if (changedEntries === 0) return;
    await pipeline(
      createReadStream(plainTarPath),
      createGzip(),
      createWriteStream(temporaryArchivePath),
    );
    await rm(options.archivePath, { force: true });
    await rename(temporaryArchivePath, options.archivePath);
  } finally {
    await rm(plainTarPath, { force: true });
    await rm(temporaryArchivePath, { force: true });
  }
}

async function rewriteExecutableModes(
  tarPath: string,
  executablePaths: ReadonlySet<string>,
): Promise<number> {
  const handle = await open(tarPath, "r+");
  try {
    const archiveSize = (await handle.stat()).size;
    const header = Buffer.alloc(BLOCK_SIZE);
    const matchedPaths = new Set<string>();
    let pendingLongName: string | null = null;
    let offset = 0;
    let changedEntries = 0;

    while (offset + BLOCK_SIZE <= archiveSize) {
      const { bytesRead } = await handle.read(header, 0, BLOCK_SIZE, offset);
      if (bytesRead < BLOCK_SIZE || isZeroBlock(header)) break;
      const entrySize = readNumericField(header, SIZE_FIELD_OFFSET, SIZE_FIELD_LENGTH);
      const typeFlag = String.fromCharCode(header[TYPE_FLAG_OFFSET] ?? 0);
      const dataOffset = offset + BLOCK_SIZE;
      const nextOffset = dataOffset + Math.ceil(entrySize / BLOCK_SIZE) * BLOCK_SIZE;

      if (typeFlag === PAX_EXTENDED_HEADER || typeFlag === GNU_LONG_NAME_HEADER) {
        pendingLongName = await readLongName(handle, dataOffset, entrySize, typeFlag);
      } else {
        const entryName =
          pendingLongName ?? readTextField(header, NAME_FIELD_OFFSET, NAME_FIELD_LENGTH);
        pendingLongName = null;
        const matchedPath = matchExecutablePath(entryName, executablePaths);
        if (matchedPath) {
          matchedPaths.add(matchedPath);
          if (readNumericField(header, MODE_FIELD_OFFSET, MODE_FIELD_LENGTH) !== EXECUTABLE_MODE) {
            writeExecutableMode(header);
            await handle.write(header, 0, BLOCK_SIZE, offset);
            changedEntries += 1;
          }
        }
      }

      offset = nextOffset;
    }

    // 声明了却不在归档里说明发行布局已经不对；静默跳过只会让同类故障再次以远端
    // `Permission denied` 的形式出现，因此这里 fail-closed。
    const missingPaths = [...executablePaths].filter((path) => !matchedPaths.has(path));
    if (missingPaths.length > 0) {
      throw new Error(
        `Release archive is missing declared executable entries: ${missingPaths.join(", ")} (${tarPath})`,
      );
    }
    return changedEntries;
  } finally {
    await handle.close();
  }
}

/** 归档以发行根目录为顶层（`tar -czf … zcode-server-<target>`）；缺顶层目录时条目名本身就是有效路径。 */
function matchExecutablePath(
  entryName: string,
  executablePaths: ReadonlySet<string>,
): string | null {
  const normalized = entryName.replace(/^\.\//u, "");
  const candidates = [normalized, stripFirstSegment(normalized)];
  return candidates.find((candidate) => executablePaths.has(candidate)) ?? null;
}

function stripFirstSegment(entryPath: string): string {
  const separatorIndex = entryPath.indexOf("/");
  return separatorIndex < 0 ? entryPath : entryPath.slice(separatorIndex + 1);
}

async function readLongName(
  handle: FileHandle,
  dataOffset: number,
  entrySize: number,
  typeFlag: string,
): Promise<string | null> {
  if (entrySize <= 0) return null;
  const body = Buffer.alloc(entrySize);
  await handle.read(body, 0, entrySize, dataOffset);
  if (typeFlag === GNU_LONG_NAME_HEADER) {
    const name = readTextField(body, 0, body.length).trim();
    return name.length > 0 ? name : null;
  }
  // PAX 扩展头没有 `path` 记录时，后续条目仍使用自己的 name 字段，不能沿用上一个长名。
  return readPaxPath(body);
}

function readPaxPath(body: Buffer): string | null {
  const text = body.toString("utf8");
  let offset = 0;
  while (offset < text.length) {
    const lengthEnd = text.indexOf(" ", offset);
    if (lengthEnd < 0) return null;
    const recordLength = Number.parseInt(text.slice(offset, lengthEnd), 10);
    if (
      !Number.isFinite(recordLength) ||
      recordLength <= 0 ||
      offset + recordLength > text.length
    ) {
      return null;
    }
    // 记录长度含自身与结尾换行：`<length> <key>=<value>\n`。
    const record = text.slice(lengthEnd + 1, offset + recordLength - 1);
    const separatorIndex = record.indexOf("=");
    if (separatorIndex > 0 && record.slice(0, separatorIndex) === "path") {
      return record.slice(separatorIndex + 1);
    }
    offset += recordLength;
  }
  return null;
}

function writeExecutableMode(header: Buffer): void {
  // 八进制字段沿用归档自身写入器的形态（6 位八进制 + 空格 + NUL），避免同一归档里出现两种填充风格。
  header.write(
    `${EXECUTABLE_MODE.toString(8).padStart(6, "0")} \0`,
    MODE_FIELD_OFFSET,
    MODE_FIELD_LENGTH,
    "latin1",
  );
  // 改 mode 会让原 checksum 失效，必须按「checksum 字段视为 8 个空格」重算。
  header.fill(0x20, CHECKSUM_FIELD_OFFSET, CHECKSUM_FIELD_OFFSET + CHECKSUM_FIELD_LENGTH);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(
    `${checksum.toString(8).padStart(6, "0")}\0 `,
    CHECKSUM_FIELD_OFFSET,
    CHECKSUM_FIELD_LENGTH,
    "latin1",
  );
}

function readNumericField(header: Buffer, offset: number, length: number): number {
  if (((header[offset] ?? 0) & 0x80) !== 0) {
    // 超出八进制字段容量的数值会用 base-256 编码。发行包没有这种成员，遇到时 fail-closed，
    // 避免按错误偏移继续扫描归档并静默漏掉声明集合。
    throw new Error(
      "Release archive uses base-256 tar numeric fields; executable mode rewrite is unsupported",
    );
  }
  const text = readTextField(header, offset, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) {
    throw new Error(`Release archive has an unreadable tar numeric field: ${JSON.stringify(text)}`);
  }
  return value;
}

function readTextField(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const terminatorIndex = field.indexOf(0);
  return field.subarray(0, terminatorIndex < 0 ? field.length : terminatorIndex).toString("utf8");
}

function isZeroBlock(header: Buffer): boolean {
  return header.every((byte) => byte === 0);
}
