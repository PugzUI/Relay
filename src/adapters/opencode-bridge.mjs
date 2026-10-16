import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { parseJsonStrict } from "../config.mjs";

const MAX_RESPONSE = 96 * 1024;

/** Read an owned, fixed-size token without following links or blocking on a FIFO. */
export async function readOpenCodeTokenFile(tokenPath) {
  const handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.alloc(65);
  try {
    const info = await handle.stat();
    if (!info.isFile() || typeof process.getuid !== "function" || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size !== 64) throw new Error("Native bridge token is unavailable");
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== 64) throw new Error("Native bridge token is unavailable");
    const token = buffer.subarray(0, size).toString("utf8");
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Native bridge token is unavailable");
    return { token, dev: info.dev, ino: info.ino };
  } finally {
    buffer.fill(0);
    await handle.close();
  }
}

export function openCodeSocketPath(root) {
  if (typeof root !== "string" || !root || root.includes("\0")) throw new TypeError("Relay root is invalid");
  return join(resolve(root), "opencode-delivery.sock");
}

export function callOpenCodeBridge(root, op, args, signal) {
  if (signal?.aborted) return Promise.reject(new Error("Native bridge call was cancelled"));
  return readOpenCodeTokenFile(join(resolve(root), "opencode-delivery.token")).then(({ token }) => {
    const rid = randomUUID();
    const body = Buffer.from(JSON.stringify({ v: 1, rid, op, args }));
    return new Promise((resolveCall, rejectCall) => {
      if (signal?.aborted) return rejectCall(new Error("Native bridge call was cancelled"));
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectCall(error); else resolveCall(value);
      };
      const req = request({
        socketPath: openCodeSocketPath(root),
        path: "/v1/call",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.byteLength), authorization: `Relay ${token}`, connection: "close" },
        signal,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE) req.destroy(new Error("Native bridge response exceeded its limit"));
          else chunks.push(chunk);
        });
        res.once("end", () => {
          try {
            const value = parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), MAX_RESPONSE);
            if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1 || value.rid !== rid || typeof value.ok !== "boolean" || !Number.isSafeInteger(value.time)) throw new Error("Native bridge response is invalid");
            if (value.ok) {
              if (Object.keys(value).sort().join(",") !== "ok,remainingMs,replayed,result,rid,time,v" || res.statusCode !== 200 || value.replayed !== false || value.remainingMs !== null || !Object.hasOwn(value, "result")) throw new Error("Native bridge response is invalid");
              return finish(null, value.result);
            }
            if (Object.keys(value).sort().join(",") !== "fault,ok,rid,time,v" || !value.fault || typeof value.fault !== "object" || Array.isArray(value.fault)) throw new Error("Native bridge response is invalid");
            finish(new Error("Native bridge rejected the request"));
          } catch (error) {
            finish(error instanceof Error ? error : new Error("Native bridge response is invalid"));
          }
        });
        res.once("error", (error) => finish(error));
      });
      // Bound total elapsed time, not socket inactivity that partial bytes can reset.
      timer = setTimeout(() => {
        const error = new Error("Native bridge call timed out");
        req.destroy(error);
        finish(error);
      }, 18000);
      req.once("error", (error) => finish(error));
      req.end(body);
    });
  });
}
