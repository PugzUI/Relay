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
// The one overflow measurement used by every narrow-width check: the
// DOCUMENT scroll width against the viewport width, plus the widest element
// whose right edge passes the viewport. Extracted so that every measurement
// in this harness is taken by the same procedure.
const measureOverflow = (target) =>
  target.evaluate(() => {
    const root = document.documentElement;
    const offenders = [...document.querySelectorAll("body *")]
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > window.innerWidth + 1)
      .sort((a, b) => b.rect.right - a.rect.right);
    const offender = offenders[0];
    const classes = offender ? String(offender.node.className).split(" ").filter(Boolean) : [];
    return {
      scrollWidth: root.scrollWidth,
      innerWidth: window.innerWidth,
      offenderCount: offenders.length,
      offender: offender ? [offender.node.tagName.toLowerCase(), ...classes].join(".") : null,
      offenderRight: offender ? Math.round(offender.rect.right) : null,
    };
  });
// The product's own control-height rule (ui/style.css:1108) is a
// disjunction: @media (max-width: 760px), (pointer: coarse) sets
// --btn-h: var(--touch-min-h), so a control is 44px tall when the viewport
// is at most 760px wide OR the pointer is coarse, and 36px otherwise
// (ui/style.css:83-86). The expected height is therefore read from the
// product's rule and the page's media state, never from a width table: a
// width table encodes only the width half of the rule and contradicts the
// product on a coarse pointer. The rule text is fixed here, in the harness,
// so a change to the stylesheet's own rule is measured against the rule as
// declared instead of against whatever the stylesheet now says.
const controlHeight = (target) =>
  target.evaluate(() =>
    window.matchMedia("(max-width: 760px), (pointer: coarse)").matches ? 44 : 36,
  );
// The widths the ladder visits. They are declared once, so the coverage
// guard below and the measurements above cannot drift apart: a guard that
// checked a different set of widths than the ladder measured would claim a
// coverage the ladder does not have.
const ladderWidths = [1050, 1024, 800, 780, 760, 600, 390, 320];
// How a media condition's widths are read.
//
// A WIDTH BAND is a media condition that carries BOTH a lower and an upper
// width bound. A defect confined to such a band is active at every width
// inside it, so a single width inside the band catches it - but only if the
// ladder visits one. The bands are read from the stylesheets the page
// actually SERVED, so a band the product declares is a band the harness
// knows about. px, em and rem are comparable (a media query's em is the
// initial font size, 16px); a width in any other unit is reported rather
// than skipped.
//
// One width bound of one condition part. A bound the guard cannot compare
// is reported (value null), never skipped: a bound that exists and cannot
// be read must fail the guard, not disappear from it.
const widthBound = (text, name) => {
  if (!new RegExp(`${name}\\s*:`).test(text)) return null;
  const exact = new RegExp(`\\(\\s*${name}\\s*:\\s*([0-9.]+)(px|em|rem)\\s*\\)`).exec(text);
  if (!exact) return { value: null };
  return { value: Math.round(Number(exact[1]) * (exact[2] === "px" ? 1 : 16)) };
};
// One comma-separated part of one media condition: a band (both bounds), a
// threshold (one bound), an unreadable width (a bound that exists but cannot
// be compared) or no width at all.
const parseBandPart = (text) => {
  const min = widthBound(text, "min-width");
  const max = widthBound(text, "max-width");
  if (!min && !max) return { kind: "none" };
  if (min && max) {
    if (min.value === null || max.value === null) return { kind: "unparsed" };
    return { kind: "band", min: min.value, max: max.value };
  }
  const single = min ?? max;
  return single.value === null ? { kind: "unparsed" } : { kind: "threshold" };
};
// The comma-separated parts of every media condition, each with the
// stylesheet it came from.
const conditionParts = (conditions) =>
  conditions.flatMap((condition) =>
    condition.conditionText
      .split(",")
      .map((part) => part.trim())
      .filter((text) => text.length > 0)
      .map((text) => ({ href: condition.href, conditionText: text })),
  );
const parseWidthBands = (conditions) => {
  const bands = [];
  const thresholds = [];
  const unparsed = [];
  for (const part of conditionParts(conditions)) {
    const parsed = parseBandPart(part.conditionText);
    if (parsed.kind === "band") bands.push({ ...part, min: parsed.min, max: parsed.max });
    else if (parsed.kind === "threshold") thresholds.push(part);
    else if (parsed.kind === "unparsed") unparsed.push(part);
  }
  return { bands, thresholds, unparsed };
};
// The stylesheets the page actually served, read through the CSSOM of the
// live page rather than from a file list: the prototype serves the
// PRODUCTION stylesheet (server.mjs maps /relay-style.css to
// ../../ui/style.css), so a file-scoped read would miss every production
// branch, and a stylesheet that failed to load would be read as an empty
// one.
const servedStylesheets = (target) =>
  target.evaluate(() => {
    const sheets = [...document.styleSheets].map((sheet) => {
      try {
        return {
          href: sheet.href ?? "(inline)",
          rules: [...sheet.cssRules].map((rule) => ({
            type: rule.type,
            conditionText: rule.conditionText ?? null,
          })),
        };
      } catch (error) {
        return { href: sheet.href ?? "(inline)", rules: null, error: String(error) };
      }
    });
    return { sheets };
  });
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
  const dimensions = (target = page) =>
    target.locator(".toolbar button").evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return [r.width, r.height];
      }),
    );
  const desktopSizes = await dimensions();
  assert.equal(desktopSizes.length, 6);
  const desktopHeight = await controlHeight(page);
  assert.ok(
    desktopSizes.every(([w, h]) => w === 96 && h === desktopHeight),
    `desktop action control size at 1500px: expected 96x${desktopHeight}, measured ${JSON.stringify(desktopSizes)}`,
  );
  // The functional page itself was never overflow-gated: every measurement
  // below was taken at a width the ladder chose, and the delivered desktop
  // state was never measured. Its document width is checked here, in the
  // state the page is delivered in.
  // The gate is only meaningful if the element a width-confined defect
  // would widen is present to be measured: the Dockview overlay host the
  // product's own stylesheet caps. Without the host a mutant that widens it
  // is a no-op and the gate would pass on a page that cannot overflow, so
  // the host's presence is asserted as a positive control before the gate is
  // trusted.
  const overlayHostCount = await page.evaluate(
    () => document.querySelectorAll(".dv-floating-overlay-host").length,
  );
  assert.ok(overlayHostCount > 0, "no Dockview overlay host was present on the desktop page");
  const desktopMeasurements = [];
  const desktopOverflow = await measureOverflow(page);
  desktopMeasurements.push({ width: 1500, state: "desktop", ...desktopOverflow });
  assert.equal(
    desktopOverflow.scrollWidth > desktopOverflow.innerWidth,
    false,
    `horizontal overflow at 1500px on the desktop page: scrollWidth ${desktopOverflow.scrollWidth} > innerWidth ${desktopOverflow.innerWidth} (offender ${desktopOverflow.offender ?? "none"} right=${desktopOverflow.offenderRight ?? 0}px)`,
  );
  // The width-band guard. A finite ladder cannot visit every width, so a
  // defect confined to a window the ladder never samples is invisible to it:
  // measured at the published tip, 9 of 9 maximal invisible windows pass the
  // ladder. The guard closes that class the only way it can be closed, from
  // the product's OWN conditions. Every media condition in the served
  // stylesheets that carries BOTH a lower and an upper width bound must
  // contain a width the ladder visits, because a defect confined to such a
  // band is active at every width inside it. The band count is reported, so
  // a pass with zero bands is legible as vacuous rather than as coverage.
  const stylesheets = await servedStylesheets(page);
  const unread = stylesheets.sheets
    .filter((sheet) => sheet.error)
    .map((sheet) => `${sheet.href}: ${sheet.error}`);
  assert.deepEqual(unread, [], `a served stylesheet could not be read: ${unread.join("; ")}`);
  const conditions = stylesheets.sheets.flatMap((sheet) =>
    (sheet.rules ?? [])
      .filter((rule) => rule.type === 4 && rule.conditionText)
      .map((rule) => ({ href: sheet.href, conditionText: rule.conditionText })),
  );
  assert.ok(conditions.length > 0, "no media condition was read from the served stylesheets");
  assert.ok(
    conditions.some((condition) => /max-width\s*:\s*760px/.test(condition.conditionText)),
    "the product's own control-height width bound was not read from the served stylesheets",
  );
  assert.ok(
    conditions.some((condition) => /pointer\s*:\s*coarse/.test(condition.conditionText)),
    "the product's own pointer bound was not read from the served stylesheets",
  );
  const { bands, thresholds, unparsed } = parseWidthBands(conditions);
  assert.deepEqual(
    unparsed.map((entry) => `${entry.href}: ${entry.conditionText}`),
    [],
    "a width condition could not be compared with the ladder's widths",
  );
  for (const band of bands) {
    assert.ok(
      ladderWidths.some((width) => width >= band.min && width <= band.max),
      `width band with no ladder sample: ${band.href}: ${band.conditionText} => [${band.min},${band.max}] (bands found: ${bands.length})`,
    );
  }
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
  const narrowMeasurements = [];
  const wideMeasurements = [];
  // The ladder NARROWS at every step. The resize direction is the stimulus
  // for the direction-sensitive defect this harness exists to catch — the
  // Dockview overlay host keeps the previous, wider inline width when the
  // viewport narrows — so a ladder that widens at one step measures a
  // stimulus its own comment does not describe. The widths sampled are the
  // product's own width branches and the INTERIOR of each branch, not only
  // its edges: the production control height switches at 760px
  // (ui/style.css:1108) and the prototype layout switches at 850px
  // (app.mjs:76,513), so the hybrid regime (760,850) and the desktop band
  // above 850 are reachable only by widths an edge-only ladder never visits.
  // A defect confined to a WINDOW of widths (a media query with two bounds)
  // overflows from the window's low edge, so every boundary is also sampled
  // just above it: 780 sits immediately above the 760px branch, and 1024
  // immediately below the 1050px sample, so a window confined to (760,780]
  // or (1024,1050] is visible to the ladder. What the ladder does not
  // visit is covered by the width-band guard above, for every band the
  // product DECLARES; a window the product does not declare is outside the
  // product's own conditions and outside this harness's reach.
  for (const width of ladderWidths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.click("#reset");
    await page.waitForTimeout(150);
    const overflow = await measureOverflow(page);
    const measurement = { width, state: "settled", ...overflow };
    (width <= 760 ? narrowMeasurements : wideMeasurements).push(measurement);
    assert.equal(
      overflow.scrollWidth > overflow.innerWidth,
      false,
      `horizontal overflow at ${width}px: scrollWidth ${overflow.scrollWidth} > innerWidth ${
        overflow.innerWidth
      } (offender ${overflow.offender ?? "none"} right=${overflow.offenderRight ?? 0}px)`,
    );
    // The control height follows the product's own rule: 44px when the
    // viewport is at most 760px wide or the pointer is coarse, 36px above it
    // (ui/style.css:83-86,1108-1111). The expectation is read from that rule
    // and the page's media state, not from the width alone.
    const expectedHeight = await controlHeight(page);
    const sizes = await dimensions();
    assert.ok(sizes.length > 0, `no action control was measured at ${width}px`);
    assert.ok(
      sizes.every(([w, h]) => w === 96 && h === expectedHeight),
      `action control size at ${width}px: expected 96x${expectedHeight}, measured ${JSON.stringify(sizes)}`,
    );
  }
  // The pointer half of the product's control-height rule is unreachable from
  // a fine-pointer context at ANY width, so it is exercised on its own page:
  // a wide viewport with a coarse pointer, where the rule requires the 44px
  // touch height even though the width half of the rule does not match. The
  // pointer type is a property of the context this harness creates, so it is
  // asserted as a precondition before the product is measured against it.
  const coarseMeasurements = [];
  const coarsePage = await browser.newPage({
    viewport: { width: 1500, height: 1050 },
    hasTouch: true,
  });
  coarsePage.on("pageerror", (error) => errors.push(error.message));
  coarsePage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    await coarsePage.goto(origin);
    await coarsePage.waitForFunction(
      () => window.workspaceStudy?.connected && workspaceStudy.state.workers.every((w) => w.online),
      null,
      { polling: 100 },
    );
    // The precondition is the branch the rule names, not the negation of a
    // sibling value: "(pointer: fine)" is false for a coarse pointer AND for
    // a context with no pointer at all, so asserting only that a fine
    // pointer is absent admits a "none" context that never matches the
    // product's (pointer: coarse) disjunct. The coarse branch is asserted
    // directly, so the population below cannot be measured against a
    // context in which the rule does not apply.
    const pointerState = await coarsePage.evaluate(() => ({
      coarse: window.matchMedia("(pointer: coarse)").matches,
      fine: window.matchMedia("(pointer: fine)").matches,
    }));
    assert.equal(
      pointerState.coarse,
      true,
      "the coarse-pointer page does not report a coarse pointer",
    );
    assert.equal(pointerState.fine, false, "the coarse-pointer page still reports a fine pointer");
    const coarseSizes = await dimensions(coarsePage);
    assert.ok(coarseSizes.length > 0, "no action control was measured on the coarse-pointer page");
    const coarseHeight = await controlHeight(coarsePage);
    assert.ok(
      coarseSizes.every(([w, h]) => w === 96 && h === coarseHeight),
      `coarse-pointer action control size at 1500px: expected 96x${coarseHeight}, measured ${JSON.stringify(coarseSizes)}`,
    );
    const coarseOverflow = await measureOverflow(coarsePage);
    coarseMeasurements.push({ width: 1500, state: "coarse pointer", ...coarseOverflow });
    assert.equal(
      coarseOverflow.scrollWidth > coarseOverflow.innerWidth,
      false,
      `horizontal overflow at 1500px on the coarse-pointer page: scrollWidth ${coarseOverflow.scrollWidth} > innerWidth ${coarseOverflow.innerWidth} (offender ${coarseOverflow.offender ?? "none"} right=${coarseOverflow.offenderRight ?? 0}px)`,
    );
  } finally {
    await coarsePage.close();
  }
  // The descent above measures the SETTLED state: it waits 150ms after every
  // resize, so the layout re-sync has already rewritten the Dockview overlay
  // host's inline width before the measurement is taken. The transient state
  // — a narrow viewport while the layout still carries the previous, wider
  // width — is therefore outside the reach of every measurement above, and it
  // is the state in which this prototype first failed: a stalled frame left
  // the document wider than the viewport. This page reproduces that state
  // deterministically instead of racing for it. Its ResizeObserver is frozen
  // before any page script runs, so the re-sync callback never fires and the
  // stale width persists for the whole measurement, at 150ms and at 650ms.
  const stalePage = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  stalePage.on("pageerror", (error) => errors.push(error.message));
  stalePage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    await stalePage.addInitScript(() => {
      window.ResizeObserver = class FrozenResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    });
    await stalePage.goto(origin);
    await stalePage.waitForFunction(
      () => window.workspaceStudy?.connected && workspaceStudy.state.workers.every((w) => w.online),
      null,
      { polling: 100 },
    );
    await stalePage.setViewportSize({ width: 320, height: 1000 });
    await stalePage.waitForTimeout(150);
    const stale = await measureOverflow(stalePage);
    narrowMeasurements.push({ width: 320, state: "layout re-sync frozen", ...stale });
    assert.equal(
      stale.scrollWidth > stale.innerWidth,
      false,
      `horizontal overflow at 320px with the layout re-sync frozen: scrollWidth ${
        stale.scrollWidth
      } > innerWidth ${stale.innerWidth} (offender ${stale.offender ?? "none"} right=${
        stale.offenderRight ?? 0
      }px)`,
    );
  } finally {
    await stalePage.close();
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
      "96×36 desktop controls on a fine pointer / 96×44 narrow and coarse-pointer controls",
      "1500px desktop page without page overflow",
      "X6 node selection opens one console",
      "real claim / SHA256 / ack and synchronized board",
      "layout save / reset / restore",
      "worker continues during feed disconnect; reconnect has no duplicate ack",
      "shell and unauthenticated commands rejected",
      "760 / 600 / 390 / 320px without page overflow",
      "1024 / 1050 / 800 / 780px without page overflow",
      "96×44 controls on a coarse pointer at 1500px without page overflow",
      "320px without page overflow while the layout re-sync is frozen",
      "zero unexpected browser errors",
      "every width band the served stylesheets declare is visited by the ladder",
    ],
    desktopViewport: {
      measurements: desktopMeasurements.length,
      overflows: desktopMeasurements.filter((m) => m.scrollWidth > m.innerWidth).length,
      results: desktopMeasurements,
    },
    narrowViewport: {
      measurements: narrowMeasurements.length,
      overflows: narrowMeasurements.filter((m) => m.scrollWidth > m.innerWidth).length,
      results: narrowMeasurements,
    },
    wideViewport: {
      measurements: wideMeasurements.length,
      overflows: wideMeasurements.filter((m) => m.scrollWidth > m.innerWidth).length,
      results: wideMeasurements,
    },
    coarsePointer: {
      measurements: coarseMeasurements.length,
      overflows: coarseMeasurements.filter((m) => m.scrollWidth > m.innerWidth).length,
      results: coarseMeasurements,
    },
    widthBandGuard: {
      sheets: stylesheets.sheets.map((sheet) => sheet.href),
      mediaConditions: conditions.length,
      widthBands: bands.length,
      widthThresholds: thresholds.length,
      ladderWidths,
      bands,
    },
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
