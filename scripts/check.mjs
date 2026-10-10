import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGKILL",
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

async function filesUnder(directory) {
  try {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }));
    return files.flat();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const sourceFiles = (await Promise.all(["src", "scripts", "examples", "ui"].map(filesUnder)))
  .flat()
  .filter((path) => path.endsWith(".mjs") || path.endsWith(".js"));
for (const path of sourceFiles) {
  const result = run(process.execPath, ["--check", path]);
  if (result.status !== 0) failures.push(`syntax: ${path}\n${result.stderr.trim()}`);
}
console.log(`syntax: checked ${sourceFiles.length} JavaScript module(s)`);

const expectedExports = ["Broker", "Client", "Fault", "LIMITS", "Relay", "connect", "open", "serve", "setup"];
const entrySource = await readFile(join(root, "src/index.mjs"), "utf8");
const actualExports = [...entrySource.matchAll(/export\s*\{([^}]+)\}/g)]
  .flatMap((match) => match[1].split(","))
  .map((name) => name.trim().split(/\s+as\s+/).at(-1))
  .sort();
if (JSON.stringify(actualExports) !== JSON.stringify([...expectedExports].sort())) {
  failures.push(`exports: expected ${expectedExports.join(", ")}; found ${actualExports.join(", ")}`);
} else {
  console.log(`exports: ${actualExports.length} frozen runtime exports`);
}

const compiler = join(root, "node_modules/typescript/bin/tsc");
try {
  await stat(compiler);
} catch {
  failures.push("declarations: TypeScript is unavailable; run npm ci first");
}
if (failures.every((failure) => !failure.startsWith("declarations:"))) {
  const typeScratch = await mkdtemp(join(root, "node_modules", "relay-types-"));
  try {
    const consumer = join(typeScratch, "consumer.mts");
    await writeFile(consumer, `import { Broker, Client, Fault, LIMITS, Relay, connect, open, serve, setup } from "@pugzui/relay";
import type { AdmissionReceipt, Agent, BoardId, Device, EnrollmentReceipt, Lease, Message, Page, Session, Snapshot, Stats } from "@pugzui/relay";
const relay: Relay = open({ root: "./disposable" });
const inspectOnly: Relay = open({ root: "./existing", readOnly: true });
const device: Device = setup({ root: "./disposable" });
const hubDevice: Device = setup({ root: "./hub", role: "hub" });
const enrollment: EnrollmentReceipt = relay.enroll(device);
const agent: Agent = relay.register("runtime", { caps: ["inspect"] });
const session: Session = relay.join(agent.id);
const admission: AdmissionReceipt = relay.send(session.id, agent.id, { msg: "ready" }, { key: "one" });
const board: BoardId = "bounty";
const lease: Lease | null = relay.claim(session.id, { board });
const page: Page<Message> = relay.list({ board, kind: "work", limit: LIMITS.pageMax });
const stats: Stats = relay.stats();
const snapshot: Snapshot = relay.snapshot();
const client: Promise<Client> = connect({ url: "https://relay.example", tokenFile: "./token" });
const broker: Promise<Broker> = serve({ root: "./store", configFile: "./relay.json" });
const fault = new Fault("data", "invalid payload");
void [admission, lease, page, stats, snapshot, client, broker, device, hubDevice, enrollment, inspectOnly, fault];
client.then((connected) => {
  const authority: string = connected.authority;
  const remoteEnrollment: Promise<EnrollmentReceipt> = connected.enroll(device);
  void [authority, remoteEnrollment];
});
`);
    const result = run(process.execPath, [
      compiler,
      "--noEmit",
      "--strict",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--lib", "ES2022",
      "src/index.d.ts",
      relative(root, consumer),
    ]);
    if (result.status !== 0) failures.push(`declarations:\n${result.stdout}${result.stderr}`);
    else console.log("declarations: strict package consumer check passed");
  } catch (error) {
    failures.push(`declarations: ${error.message}`);
  } finally {
    try {
      await rm(typeScratch, { recursive: true, force: true });
    } catch (error) {
      failures.push(`cleanup: could not remove declaration scratch (${error.message})`);
    }
  }
}

const expectedModules = [
  "src/cli.mjs", "src/fault.mjs", "src/relay.mjs", "src/broker.mjs", "src/client.mjs", "src/validate.mjs",
  "src/sqlite.mjs", "src/schema.sql", "src/auth.mjs", "src/config.mjs", "src/pool.mjs", "src/feed.mjs",
  "scripts/demo.mjs", "scripts/capture.mjs",
];
const absent = [];
for (const path of expectedModules) {
  try {
    await stat(join(root, path));
  } catch (error) {
    if (error.code === "ENOENT") absent.push(path);
    else throw error;
  }
}
if (absent.length) failures.push(`implementation imports pending from assigned lanes: ${absent.join(", ")}`);
else console.log("implementation imports: all contract modules are present");

const packScratch = await mkdtemp(join(tmpdir(), "relay-check-"));
try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("run packaging check through npm run check");
  const pack = run(process.execPath, [npmCli, "pack", "--dry-run", "--ignore-scripts", "--json"], {
    env: { ...process.env, npm_config_cache: packScratch, npm_config_logs_max: "0" },
  });
  if (pack.status !== 0) {
    failures.push(`packaging:\n${pack.stdout}${pack.stderr}`);
  } else {
    try {
      const packages = JSON.parse(pack.stdout);
      if (!Array.isArray(packages) || packages.length !== 1 || !Array.isArray(packages[0]?.files)) {
        throw new Error("npm returned an invalid package file manifest");
      }
      const packedPaths = packages[0].files.map((file) => {
        if (typeof file?.path !== "string") throw new Error("npm returned an invalid package path");
        return file.path;
      });
      const forbiddenPaths = packedPaths.filter((path) => {
        const allowed = ["package.json", "README.md", "LICENSE"].includes(path)
          || path.startsWith("src/") || path.startsWith("ui/");
        return !allowed || path.split("/").includes("..")
          || /(?:^|\/)(?:\.git|\.relay|\.local|node_modules|coverage|tests?|fixtures?)(?:\/|$)/i.test(path)
          || /(?:^|\/)(?:\.env(?:\.[^/]*)?|token(?:\.(?:txt|json))?|credentials(?:\.json)?|registry\.json)$/i.test(path)
          || /\.(?:sqlite|db)(?:-[^/]*)?$|\.(?:pem|key|p12|pfx|log|tgz|bak|orig|tmp)$/i.test(path);
      });
      if (forbiddenPaths.length) {
        failures.push(`packaging: unexpected/private package files ${JSON.stringify(forbiddenPaths)}`);
      }
      const requiredPacked = ["package.json", "LICENSE", "src/index.mjs", "src/index.d.ts",
        ...expectedModules.filter((path) => path.startsWith("src/") && !absent.includes(path))];
      const missingPacked = requiredPacked.filter((path) => !packedPaths.includes(path));
      if (missingPacked.length) failures.push(`packaging: missing runtime files ${JSON.stringify(missingPacked)}`);
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      const expectedFiles = ["src/", "ui/", "LICENSE"];
      if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
        failures.push(`packaging: files allowlist must be ${expectedFiles.join(", ")}`);
      }
      if (manifest.name !== "@pugzui/relay" || manifest.engines?.node !== ">=24.0.0" || manifest.license !== "MIT") {
        failures.push("packaging: package identity, supported Node engine, or license changed from the frozen contract");
      }
      for (const script of ["check", "test", "demo", "capture"]) {
        if (typeof manifest.scripts?.[script] !== "string") failures.push(`packaging: missing npm script ${script}`);
      }
      if (Object.keys(manifest.dependencies ?? {}).length !== 0) {
        failures.push("packaging: runtime dependencies must remain empty");
      }
      for (const path of ["package-lock.json", "LICENSE", "src/index.mjs", "src/index.d.ts"]) {
        await stat(join(root, path));
      }
      if (!failures.some((failure) => failure.startsWith("packaging:"))) {
        console.log(`packaging: validated ${packedPaths.length} emitted file(s), runtime entries, and private-artifact exclusions`);
      }
    } catch (error) {
      failures.push(`packaging: manifest/files check failed (${error.message})`);
    }
  }
} catch (error) {
  failures.push(`packaging: ${error.message}`);
} finally {
  try {
    await rm(packScratch, { recursive: true, force: true });
  } catch (error) {
    failures.push(`cleanup: could not remove packaging scratch (${error.message})`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log("check complete; automated tests are not run by this command");
}
