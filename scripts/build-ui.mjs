import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checking = process.argv.slice(2);
if (checking.length > 1 || checking.some((arg) => arg !== "--check")) throw new Error("usage: node scripts/build-ui.mjs [--check]");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["ui/console.mjs"],
  outfile: "ui/assets/console.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "external",
  write: false,
});
const packages = ["lit", "lit-element", "lit-html", "@lit/reactive-element"];
const licenses = await Promise.all(packages.map(async (name) => {
  const folder = resolve(root, "node_modules", name);
  const manifest = JSON.parse(await readFile(resolve(folder, "package.json"), "utf8"));
  return `${name} ${manifest.version}\n${await readFile(resolve(folder, "LICENSE"), "utf8")}`;
}));
const files = [...result.outputFiles.map((file) => ({ path: file.path, text: file.text })),
  { path: resolve(root, "ui/assets/licenses.txt"), text: licenses.join("\n\n") }];
if (checking.length) {
  for (const file of files) {
    const current = await readFile(file.path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current !== file.text) throw new Error("Packaged UI assets are stale; run npm run build:ui");
  }
} else {
  const assets = resolve(root, "ui/assets");
  await mkdir(assets, { recursive: true });
  const staging = await mkdtemp(resolve(root, ".relay-ui-build-"));
  let failure;
  try {
    for (const file of files) await writeFile(resolve(staging, basename(file.path)), file.text, { flag: "wx" });
    // Publish licenses first, then atomically replace the executable bundle.
    const ordered = [...files].sort((a, b) => Number(a.path.endsWith(".mjs")) - Number(b.path.endsWith(".mjs")));
    for (const file of ordered) await rename(resolve(staging, basename(file.path)), file.path);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await rm(staging, { recursive: true, force: true }); }
    catch (error) {
      if (failure) throw new AggregateError([failure, error], "UI build failed and staging cleanup failed", { cause: failure });
      throw error;
    }
  }
}
console.log(checking.length ? "ui: packaged bundle and licenses match source" : "ui: built local Lit bundle and licenses");
