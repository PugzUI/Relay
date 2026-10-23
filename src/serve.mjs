import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const base = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const routes = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const port = Number(process.env.PORT || 4200);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw Error("PORT must be 1–65535");
}

const server = createServer(async (request, response) => {
  const route = routes.get(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(join(base, route[0]));
    response.writeHead(200, {
      "Content-Type": route[1],
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws: wss:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(503).end("Build the console with npm run build");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log("Relay console: http://127.0.0.1:" + port);
});
