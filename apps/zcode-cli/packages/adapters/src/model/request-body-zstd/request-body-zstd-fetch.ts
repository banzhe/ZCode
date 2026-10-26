import { zstdCompress } from "node:zlib";
import { promisify } from "node:util";
import type { CreateRequestBodyZstdFetch } from "./contract.js";

const zstdCompressAsync = promisify(zstdCompress);
const CONTENT_ENCODING_HEADER = "content-encoding";
const CONTENT_LENGTH_HEADER = "content-length";
const ZSTD_CONTENT_ENCODING = "zstd";

/**
 * Provider 开启 `requestBodyZstd` 时，把模型请求体压缩为 zstd 再交给网络 transport。
 *
 * 位置必须在 Option Map 改写之后、网络 transport 之前：签名、鉴权头与
 * RawRequestBodyCapture 看到的仍是压缩前的 JSON 语义。
 * GET / HEAD 等无请求体请求原样透传，不压缩也不设置 content-encoding。
 */
export const createRequestBodyZstdFetch: CreateRequestBodyZstdFetch = (baseFetch) => {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "GET" || request.method === "HEAD") {
      return baseFetch(input, init);
    }

    const body = Buffer.from(await request.arrayBuffer());
    if (body.byteLength === 0) {
      return baseFetch(input, init);
    }

    const compressed = await zstdCompressAsync(body);
    const headers = new Headers(request.headers);
    headers.set(CONTENT_ENCODING_HEADER, ZSTD_CONTENT_ENCODING);
    headers.set(CONTENT_LENGTH_HEADER, String(compressed.byteLength));

    return baseFetch(request.url, {
      method: request.method,
      headers,
      body: compressed,
      signal: request.signal,
    });
  };
};
