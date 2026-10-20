import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const evidence = await mkdtemp(join(tmpdir(), "relay-workspace-evidence-"));
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(here, "server.mjs")], {
  env: { ...process.env, PROTOTYPE_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser, fixtureDirectory;
let workerPids = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 10000);
    let output = "";
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited during startup: ${code}`));
    });
    server.stdout.on("data", (data) => {
      output += data;
      const line = output
        .split("\n")
        .slice(0, -1)
        .find((line) => line.includes('"fixture":true'));
      if (line) {
        fixtureDirectory = dirname(JSON.parse(line).root);
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on("data", (data) => process.stderr.write(data));
  });
  browser = await chromium.launch({
    executablePath: process.env.RELAY_BROWSER ?? "/usr/bin/chromium",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  const errors = [],
    consoleErrors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(origin);
  // Interval polling, not the default requestAnimationFrame polling: a headless
  // Chromium that stops producing compositor frames never re-evaluates a
  // frame-polled predicate, so the wait would expire on an already-true state.
  await page.waitForFunction(
    () => window.workspaceStudy?.connected && workspaceStudy.state.workers.every((w) => w.online),
    null,
    { polling: 100 },
  );
  workerPids = await page.evaluate(() => workspaceStudy.state.workers.map((w) => w.pid));
  const dimensions = () =>
    page.locator(".toolbar button").evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return [r.width, r.height];
      }),
    );
  const desktopSizes = await dimensions();
  assert.equal(desktopSizes.length, 6);
  assert.ok(desktopSizes.every(([w, h]) => w === 96 && h === 36));
  const alpha = await page.evaluate(() => workspaceStudy.state.workers[0].id);
  await page.locator(".x6-node").filter({ hasText: "ALPHA" }).click();
  await page.waitForFunction(() => workspaceStudy.sessionPanels.size === 1, null, { polling: 100 });
  await page.locator(".x6-node").filter({ hasText: "ALPHA" }).click();
  assert.equal(await page.evaluate(() => workspaceStudy.sessionPanels.size), 1);
  await page.getByRole("button", { name: "Claim only", exact: true }).click();
  await page.waitForFunction(
    () => workspaceStudy.state.work.some((w) => w.state === "claimed"),
    null,
    {
      polling: 100,
    },
  );
  const mid = await page.evaluate(
    () => workspaceStudy.state.work.find((w) => w.state === "claimed").id,
  );
  assert.match(await page.locator(".lane").nth(1).textContent(), /alpha/);
  await page.screenshot({ path: join(evidence, "workspace-claimed.png"), fullPage: true });
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await page.waitForFunction(
    (id) => workspaceStudy.state.work.find((w) => w.id === id)?.state === "done",
    mid,
    { polling: 100 },
  );
  const committed = await page.evaluate(
    (id) => ({
      state: workspaceStudy.state.work.find((w) => w.id === id).state,
      worker: workspaceStudy.state.workers[0].id,
      pid: workspaceStudy.state.workers[0].pid,
      ackCount: workspaceStudy.state.audit.filter((e) => e.mid === id && e.type === "ack").length,
      computation: workspaceStudy.state.workers[0].logs.some((l) =>
        /SHA256 [a-f0-9]{64}/.test(l.text),
      ),
    }),
    mid,
  );
  assert.equal(committed.ackCount, 1);
  assert.equal(committed.computation, true);
  await page.click("#save");
  const ids = await page.evaluate(() => workspaceStudy.dock.panels.map((p) => p.id).sort());
  await page.click("#reset");
  assert.equal(await page.evaluate(() => workspaceStudy.sessionPanels.size), 0);
  await page.click("#restore");
  await page.waitForFunction(() => workspaceStudy.sessionPanels.size === 1, null, { polling: 100 });
  assert.deepEqual(
    await page.evaluate(() => workspaceStudy.dock.panels.map((p) => p.id).sort()),
    ids,
  );
  await page.click("#disconnect");
  assert.equal(await page.locator("#post").isDisabled(), true);
  const accepted = await page.evaluate(async (worker) => {
    const boot = await (await fetch("/api/bootstrap")).json();
    return (
      await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Prototype-Token": boot.token },
        body: JSON.stringify({ action: "command", worker, command: "run" }),
      })
    ).status;
  }, alpha);
  assert.equal(accepted, 202);
  await page.waitForTimeout(2300);
  await page.click("#disconnect");
  await page.waitForFunction(
    () =>
      workspaceStudy.connected &&
      workspaceStudy.state.work.filter((w) => w.state === "done").length === 2,
    null,
    { polling: 100 },
  );
  assert.equal(
    await page.evaluate(() => workspaceStudy.state.audit.filter((e) => e.type === "ack").length),
    2,
  );
  const denied = await page.evaluate(async (worker) => {
    const boot = await (await fetch("/api/bootstrap")).json();
    const shell = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Prototype-Token": boot.token },
      body: JSON.stringify({ action: "command", worker, command: "sh -c whoami" }),
    });
    const noAuth = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "seed" }),
    });
    return { shell: shell.status, noAuth: noAuth.status };
  }, alpha);
  assert.deepEqual(denied, { shell: 403, noAuth: 403 });
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  const malformed = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Prototype-Token": bootstrap.token,
    },
    body: new Uint8Array([123, 34, 255, 34, 58, 48, 125]),
  });
  assert.equal(malformed.status, 400);
  await malformed.body.cancel();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.click("#reset");
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const offender = [...document.querySelectorAll("body *")]
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.right > window.innerWidth + 1)
        .sort((a, b) => b.rect.right - a.rect.right)[0];
      const classes = offender ? String(offender.node.className).split(" ").filter(Boolean) : [];
      return {
        scrollWidth: root.scrollWidth,
        innerWidth: window.innerWidth,
        offender: offender ? [offender.node.tagName.toLowerCase(), ...classes].join(".") : null,
        offenderRight: offender ? Math.round(offender.rect.right) : null,
      };
    });
    assert.equal(
      overflow.scrollWidth > overflow.innerWidth,
      false,
      `horizontal overflow at ${width}px: scrollWidth ${overflow.scrollWidth} > innerWidth ${
        overflow.innerWidth
      } (offender ${overflow.offender ?? "none"} right=${overflow.offenderRight ?? 0}px)`,
    );
    assert.ok((await dimensions()).every(([w, h]) => w === 96 && h === 44));
  }
  await page.screenshot({ path: join(evidence, "workspace-narrow.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    consoleErrors.filter((text) => !text.includes("403 (Forbidden)")),
    [],
  );
  const report = {
    scope:
      "Isolated real Relay store and fixture worker processes; not native AI attachment or shell execution",
    committed,
    denied,
    checks: [
      "96×36 desktop / 96×44 narrow controls",
      "X6 node selection opens one console",
      "real claim / SHA256 / ack and synchronized board",
      "layout save / reset / restore",
      "worker continues during feed disconnect; reconnect has no duplicate ack",
      "shell and unauthenticated commands rejected",
      "760 / 390 / 320px without page overflow",
      "zero unexpected browser errors",
    ],
    evidence,
  };
  await writeFile(join(evidence, "verification.json"), JSON.stringify(report, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 4000);
    await exited;
    clearTimeout(timer);
  }
  if (fixtureDirectory)
    assert.equal(existsSync(fixtureDirectory), false, "Fixture must remove its owned store");
  for (const pid of workerPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  console.log("Cleanup verified: owned fixture store removed and worker processes exited.");
}
