import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

export interface TarEntryInput {
  name: string;
  mode: number;
  contents?: string;
  typeFlag?: string;
  /** 写入 PAX 扩展头（`path=` 记录）以验证长路径匹配；此时 name 字段通常是被截断的名字。 */
  paxPath?: string;
}

export interface TarEntry {
  /** 已应用 PAX `path=` 记录的有效名字。 */
  name: string;
  mode: number;
  typeFlag: string;
  size: number;
}

/** 测试用最小 ustar 写入器：宿主 tar 在 Windows 上无法产出 0666 条目，构造归档必须自己控制 mode。 */
export async function writeTarGz(
  archivePath: string,
  entries: readonly TarEntryInput[],
): Promise<void> {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "", "utf8");
    const typeFlag = entry.typeFlag ?? "0";
    // 目录等类型不提供 contents，长度为 0；GNU `L` 长名头则自带数据。
    const size = contents.length;
    if (entry.paxPath) {
      const body = Buffer.from(paxRecord("path", entry.paxPath), "utf8");
      blocks.push(
        buildHeader({ name: "PaxHeader", mode: 0o644, size: body.length, typeFlag: "x" }),
        body,
        padToBlock(body.length),
      );
    }
    blocks.push(buildHeader({ name: entry.name, mode: entry.mode, size, typeFlag }));
    if (size > 0) blocks.push(contents, padToBlock(size));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  await pipeline(Readable.from(blocks), createGzip(), createWriteStream(archivePath));
}

/** 读取归档条目并校验每个头的 checksum；checksum 被改坏时直接抛错。 */
export async function readTarGzEntries(archivePath: string): Promise<TarEntry[]> {
  const tar = gunzipSync(await readFile(archivePath));
  const entries: TarEntry[] = [];
  let pendingPaxPath: string | null = null;
  let offset = 0;
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    verifyChecksum(header, offset);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const dataOffset = offset + BLOCK_SIZE;
    if (typeFlag === "x") {
      pendingPaxPath = readPaxPath(tar.subarray(dataOffset, dataOffset + size));
    } else {
      entries.push({
        name: pendingPaxPath ?? readString(header, 0, 100),
        mode: readOctal(header, 100, 8),
        typeFlag,
        size,
      });
      pendingPaxPath = null;
    }
    offset = dataOffset + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return entries;
}

function buildHeader(input: {
  name: string;
  mode: number;
  size: number;
  typeFlag: string;
}): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  header.write(input.name, 0, 100, "utf8");
  writeOctal(header, 100, 8, input.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, input.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(input.typeFlag, 156, 1, "latin1");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

function verifyChecksum(header: Buffer, offset: number): void {
  const expected = readOctal(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let actual = 0;
  for (const byte of copy) actual += byte;
  if (actual !== expected) {
    throw new Error(`tar header checksum mismatch at offset ${offset}: ${actual} !== ${expected}`);
  }
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  target.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "latin1");
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const text = readString(buffer, offset, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const terminatorIndex = field.indexOf(0);
  return field.subarray(0, terminatorIndex < 0 ? field.length : terminatorIndex).toString("utf8");
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (length !== `${length}`.length + body.length) length = `${length}`.length + body.length;
  return `${length}${body}`;
}

function readPaxPath(body: Buffer): string | null {
  const text = body.toString("utf8");
  let offset = 0;
  while (offset < text.length) {
    const lengthEnd = text.indexOf(" ", offset);
    if (lengthEnd < 0) return null;
    const recordLength = Number.parseInt(text.slice(offset, lengthEnd), 10);
    if (!Number.isFinite(recordLength) || offset + recordLength > text.length) return null;
    const record = text.slice(lengthEnd + 1, offset + recordLength - 1);
    const separatorIndex = record.indexOf("=");
    if (separatorIndex > 0 && record.slice(0, separatorIndex) === "path") {
      return record.slice(separatorIndex + 1);
    }
    offset += recordLength;
  }
  return null;
}

function padToBlock(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}
