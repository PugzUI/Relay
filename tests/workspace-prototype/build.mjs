import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const result = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "vendor-entry.mjs")],
  bundle: true,
  minify: true,
  format: "esm",
  outdir: join(here, "assets"),
  entryNames: "app",
  metafile: true,
});
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(resolve(here, input));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Missing package provenance: ${input}`);
    directory = parent;
  }
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) continue;
  const filename = [
    "LICENSE",
    "LICENSE.txt",
    "LICENSE.md",
    "LICENCE.md",
    "CopyrightNotice.txt",
  ].find((name) => existsSync(join(directory, name)));
  if (!filename) throw new Error(`Missing bundled license: ${key}`);
  packages.set(
    key,
    `${key} (${manifest.license})\n${readFileSync(join(directory, filename), "utf8")}`,
  );
}
writeFileSync(
  join(here, "assets/LICENSES.txt"),
  [...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text)
    .join("\n\n---\n\n"),
);
console.log(
  `Built local X6 / Dockview / xterm bundle; retained ${packages.size} package licenses.`,
);
