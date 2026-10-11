import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { parseJsonStrict } from "../config.mjs";

const MAX_RESPONSE = 24 * 1024;

async function readToken(root) {
  const tokenPath = join(resolve(root), "opencode-delivery.token");
  const handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || typeof process.getuid !== "function" || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size !== 64) throw new Error("Native bridge token is unavailable");
    const token = await handle.readFile("utf8");
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Native bridge token is unavailable");
    return token;
  } finally {
    await handle.close();
  }
}

export function openCodeSocketPath(root) {
  if (typeof root !== "string" || !root || root.includes("\0")) throw new TypeError("Relay root is invalid");
  return join(resolve(root), "opencode-delivery.sock");
}

export function callOpenCodeBridge(root, op, args, signal) {
  return readToken(root).then((token) => {
    const rid = randomUUID();
    const body = Buffer.from(JSON.stringify({ v: 1, rid, op, args }));
    return new Promise((resolveCall, rejectCall) => {
      if (signal?.aborted) return rejectCall(new Error("Native bridge call was cancelled"));
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
            const value = parseJsonStrict(Buffer.concat(chunks).toString("utf8"), MAX_RESPONSE);
            if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1 || value.rid !== rid || typeof value.ok !== "boolean" || !Number.isSafeInteger(value.time)) throw new Error("Native bridge response is invalid");
            if (value.ok) {
              if (Object.keys(value).sort().join(",") !== "ok,remainingMs,replayed,result,rid,time,v" || res.statusCode !== 200 || value.replayed !== false || value.remainingMs !== null || !Object.hasOwn(value, "result")) throw new Error("Native bridge response is invalid");
              return resolveCall(value.result);
            }
            if (Object.keys(value).sort().join(",") !== "fault,ok,rid,time,v" || !value.fault || typeof value.fault !== "object" || Array.isArray(value.fault)) throw new Error("Native bridge response is invalid");
            rejectCall(new Error("Native bridge rejected the request"));
          } catch (error) {
            rejectCall(error instanceof Error ? error : new Error("Native bridge response is invalid"));
          }
        });
        res.once("error", rejectCall);
      });
      req.setTimeout(18000, () => req.destroy(new Error("Native bridge call timed out")));
      req.once("error", rejectCall);
      req.end(body);
    });
  });
}
