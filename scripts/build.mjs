import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["ui/app.mjs"],
  outfile: "dist/app.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "eof",
});
await Promise.all([
  cp("ui/index.html", "dist/index.html"),
  cp("ui/style.css", "dist/style.css"),
]);
console.log("Relay fleet console built");
