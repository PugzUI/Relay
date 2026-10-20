import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { open, setup, serve } from "../../../src/index.mjs";
import { Cdp, captureEnvironment, devtoolsEndpoint, stopOwnedBrowser } from "./capture.mjs";

// Isolated real-store/browser verification. These participants are not native agents.
const results = [];
let parent, evidence, listener, relay, broker, browser, cdp, primaryError;
let cleanupFailures = [];
let exceptions = 0,
  launchError = false;
const tokens = Object.fromEntries(
  ["full", "metadata", "work"].map((name) => [name, randomBytes(32).toString("base64url")]),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const credential = (name) => ({
  principal: `overview-${name}`,
  tokenDigest: hash(tokens[name]),
  grant: {
    enroll: [],
    register: [],
    workers: [],
    recipients: [],
    boardPost: [],
    boardClaim: [],
    inboxRead: name === "full" ? ["bounty"] : [],
    workRead: name !== "metadata" ? ["bounty"] : [],
    inspect: { messages: false, receipts: false, audit: false, topology: true },
    reportDevice: null,
  },
});
const registry = { version: 1, credentials: Object.keys(tokens).map(credential) };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(expression, label, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cdp.evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`browser did not reach ${label}`);
}
async function click(selector) {
  const point = await cdp.evaluate(
    `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) throw new Error('control unavailable'); node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
  );
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await cdp.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
}
async function key(key, code = key) {
  const codes = {
    Enter: 13,
    Escape: 27,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    "/": 191,
  };
  await cdp.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: codes[key],
    text: key === "Enter" ? "\r" : key === "/" ? "/" : "",
  });
  await cdp.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: codes[key],
  });
}
async function authenticate(name) {
  if (await cdp.evaluate("!document.getElementById('disconnect').disabled"))
    await click("#disconnect");
  await cdp.evaluate(
    `(() => { const input=document.getElementById('token'); input.value=${JSON.stringify(tokens[name])}; document.getElementById('auth-form').requestSubmit(); })()`,
  );
  await wait(
    "document.getElementById('connection').dataset.state === 'connected' && document.getElementById('topology').snapshot !== null",
    "authenticated topology",
  );
}
async function filter(value) {
  await cdp.evaluate(
    `(() => {const input=document.getElementById('node-filter');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await cdp.evaluate("document.getElementById('topology').updateComplete");
}
async function screenshot(name, target = null) {
  await cdp.evaluate(
    `(() => { document.activeElement?.blur(); ${target ? `document.querySelector(${JSON.stringify(target)})?.scrollIntoView({block:"start"})` : "window.scrollTo(0,0)"}; return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`,
  );
  const image = await cdp.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const path = join(evidence, `${name}.png`);
  await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600, flag: "wx" });
}
function passed(name) {
  results.push(name);
}

try {
  parent = await mkdtemp(join(tmpdir(), "relay-overview-probe-"));
  evidence = await mkdtemp(join(tmpdir(), "relay-overview-evidence-"));
  const root = join(parent, "store");
  const profile = join(parent, "browser");
  listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const registryPath = join(parent, "registry.json");
  const configPath = join(parent, "config.json");
  setup({ root, device: "overview-qa", role: "hub" });
  relay = open({ root });
  const first = relay.register("worker", { slot: "prime", caps: ["inspect"] });
  relay.register("worker", { slot: "001", caps: ["verify"] });
  const session = relay.join(first.id);
  relay.post(session.id, "bounty", { msg: "<img src=x onerror=alert(1)>\nText remains inert." });
  relay.post(session.id, "bounty", {
    work: { task: "inspect", input: "isolated overview verification" },
  });
  await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600, flag: "wx" });
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      role: "hub",
      mode: "local",
      listen: { host: "127.0.0.1", port },
      tls: null,
      allowedPeers: [],
      credentialsFile: "registry.json",
      hub: null,
      pool: null,
      views: [],
    }),
    { mode: 0o600, flag: "wx" },
  );
  broker = await serve({ root, configFile: configPath });
  browser = spawn(
    process.env.RELAY_BROWSER ?? "/usr/bin/chromium",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { shell: false, detached: true, stdio: "ignore", env: captureEnvironment() },
  );
  browser.once("error", () => {
    launchError = true;
  });
  cdp = await Cdp.connect(await devtoolsEndpoint(profile, browser, () => launchError));
  cdp.addEventListener("Runtime.exceptionThrown", () => {
    exceptions += 1;
  });
  await cdp.call("Runtime.enable");
  await cdp.call("Page.enable");
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "window.qaCspViolations=0;document.addEventListener('securitypolicyviolation',()=>window.qaCspViolations++);",
  });
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.call("Page.navigate", { url: origin });
  await wait(
    "document.readyState === 'complete' && document.querySelector('#overview dd')?.textContent === '—'",
    "disconnected unknown summary",
  );
  assert.equal(await cdp.evaluate("document.querySelectorAll('.worker-node').length"), 0);
  await screenshot("disconnected");
  passed("Disconnected view has unknown summary and no private rows");

  await authenticate("full");
  await wait(
    "document.getElementById('inbox-status').textContent === 'Ready' && document.getElementById('bounties-status').textContent === 'Ready'",
    "permitted panes",
  );
  assert.equal(await cdp.evaluate("document.querySelectorAll('.worker-node').length"), 2);
  assert.equal(await cdp.evaluate("document.getElementById('inspector').selection"), "bounty");
  assert.equal(
    await cdp.evaluate(
      "document.querySelector('#inbox-rows img') === null && document.querySelector('#inbox-rows pre').textContent.includes('<img')",
    ),
    true,
  );
  assert.equal(
    await cdp.evaluate(
      "document.querySelector('#inbox-rows .record-kind').textContent === 'MSG' && document.querySelector('#bounties-rows .record-kind').textContent === 'WORK' && document.querySelector('#inbox-rows .record-time').textContent.includes('T')",
    ),
    true,
  );
  assert.equal(
    await cdp.evaluate(
      "document.querySelector('#node-filter-options option[value=\"cap:verify\"]') !== null",
    ),
    true,
  );
  passed(
    "Authenticated snapshots/panes and initial inspector use real store state; payload stays inert",
  );
  await cdp.evaluate(
    "window.qaCopiedId=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value)=>{window.qaCopiedId=value}}})",
  );
  await click("#inbox-rows .record-copy");
  await wait(
    "window.qaCopiedId === document.querySelector('#inbox-rows .record-id').textContent && document.querySelector('#inbox-rows .record-copy').textContent === 'Copied'",
    "exact record ID copied",
  );
  passed("Record headers identify kind, state and time; Copy copies only the exact record ID");

  await cdp.evaluate(
    "window.qaInboxRow=document.querySelector('#inbox-rows > li');window.qaQuietTime=document.getElementById('topology').snapshot.time;const range=document.createRange();range.selectNodeContents(window.qaInboxRow.querySelector('pre'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.qaSelectedText=selection.toString();",
  );
  await wait(
    "document.getElementById('topology').snapshot.time > window.qaQuietTime",
    "quiet snapshot reconciliation",
    15_000,
  );
  assert.equal(
    await cdp.evaluate(
      "document.querySelector('#inbox-rows > li') === window.qaInboxRow && getSelection().toString() === window.qaSelectedText",
    ),
    true,
  );
  passed("Quiet snapshot reconciliation preserves history nodes and selected text");

  await click(".worker-node");
  await cdp.evaluate(
    "window.qaNode=document.querySelector('.worker-node');window.qaNode.focus();window.qaTime=document.getElementById('topology').snapshot.time;",
  );
  const selected = await cdp.evaluate("document.getElementById('inspector').selection");
  assert.equal(selected, first.id);
  relay.post(session.id, "bounty", { msg: "Committed live update." });
  await wait("document.querySelector('.path-pulse') !== null", "committed event pulse");
  await wait(
    "document.getElementById('topology').snapshot.time > window.qaTime && document.querySelectorAll('#inbox-rows > li').length === 2",
    "live snapshot and pane update",
  );
  assert.equal(
    await cdp.evaluate(
      "window.qaNode === document.querySelector('.worker-node') && document.activeElement === window.qaNode",
    ),
    true,
  );
  await key("ArrowDown");
  assert.equal(
    await cdp.evaluate(
      "document.activeElement === document.querySelectorAll('.worker-node')[1] && document.activeElement.matches(':focus-visible')",
    ),
    true,
  );
  await key("Enter");
  assert.notEqual(await cdp.evaluate("document.getElementById('inspector').selection"), selected);
  passed(
    "Committed event updates preserve keyed node identity/focus; arrow and Enter navigation work",
  );
  await wait("document.querySelector('.path-pulse') === null", "pulse expiry");
  passed("Committed pulses expire rather than becoming fabricated continuous traffic");

  await click(".collapse-control");
  await wait("document.querySelectorAll('.worker-node').length === 0", "collapsed branch");
  await filter("worker");
  assert.equal(await cdp.evaluate("document.querySelectorAll('.worker-node').length"), 2);
  await click(".worker-node");
  await key("Home");
  assert.equal(
    await cdp.evaluate("document.activeElement === document.querySelector('.device-node')"),
    true,
  );
  await key("End");
  assert.equal(
    await cdp.evaluate("document.activeElement === document.querySelectorAll('.worker-node')[1]"),
    true,
  );
  await key("/", "Slash");
  assert.equal(
    await cdp.evaluate(
      "document.activeElement === document.getElementById('node-filter') && document.activeElement.value === 'worker'",
    ),
    true,
  );
  await key("Escape");
  assert.equal(await cdp.evaluate("document.getElementById('node-filter').value"), "");
  passed(
    "Filtered keyboard navigation skips disabled collapse controls; slash focuses filter and Escape clears it",
  );
  await filter("not-a-relay-node");
  assert.equal(
    await cdp.evaluate(
      "document.getElementById('topology').textContent.includes('No matching nodes')",
    ),
    true,
  );
  assert.equal(
    await cdp.evaluate("document.getElementById('inspector').textContent.includes('filtered out')"),
    true,
  );
  await screenshot("filtered-empty");
  await filter("verify");
  assert.equal(
    await cdp.evaluate(
      "document.querySelectorAll('.device-node').length === 1 && document.querySelectorAll('.worker-node').length === 1",
    ),
    true,
  );
  await click(".device-node");
  assert.equal(
    await cdp.evaluate("document.querySelector('#inspector .eyebrow').textContent === 'Device'"),
    true,
  );
  await filter("type:worker state:registered cap:verify");
  assert.equal(
    await cdp.evaluate(
      "document.querySelectorAll('.worker-node').length === 1 && document.querySelectorAll('.board-node').length === 0 && document.getElementById('filter-summary').textContent.includes('1 worker')",
    ),
    true,
  );
  await filter("type:board");
  assert.equal(
    await cdp.evaluate(
      "document.querySelectorAll('.device-node,.worker-node').length === 0 && document.querySelectorAll('.board-node').length === 2 && document.querySelector('#inspector .eyebrow').textContent.includes('filtered out')",
    ),
    true,
  );
  await filter("type:device");
  assert.equal(
    await cdp.evaluate(
      "document.querySelectorAll('.device-node').length === 1 && document.querySelectorAll('.worker-node').length === 0 && document.querySelectorAll('.board-node').length === 0",
    ),
    true,
  );
  passed(
    "Combined typed filters keep contextual devices, scoped counts, and filtered inspector status consistent",
  );
  await filter("");
  assert.equal(await cdp.evaluate("document.querySelectorAll('.worker-node').length"), 0);
  await click("#expand-all");
  await wait("document.querySelectorAll('.worker-node').length === 2", "expanded branches");
  passed(
    "Collapse, filtered expansion, child-matched device inspection, empty search and Expand all preserve expected state",
  );

  const lease = relay.claim(session.id, { board: "bounty" });
  assert.ok(lease);
  await wait(
    "document.querySelector('.path-current') instanceof SVGPathElement && document.getElementById('topology').snapshot.agents.some(a=>a.assignmentCount === 1)",
    "real active assignment link",
  );
  assert.equal(
    await cdp.evaluate(
      "document.querySelector('.path-current').getAttribute('d').includes(' H ') && document.querySelector('.path-current').getAttribute('d').includes(' V ')",
    ),
    true,
  );
  await click(".worker-node");
  await wait(
    "document.querySelector('.path-current.path-selected') !== null && document.querySelector('#inspector .inspector-links .inspector-link-target') !== null",
    "highlighted selected relationship",
  );
  await screenshot("overview-wide");
  passed("A real claim renders an orthogonal selected SVG link and grouped worker inspector");
  for (const width of [1440, 1000, 760, 390, 360, 320]) {
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: width < 761,
    });
    await cdp.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    const geometry = await cdp.evaluate(
      "({width:innerWidth,document:document.documentElement.scrollWidth,clipped:[...document.querySelectorAll('.topology-toolbar button,.filter-control,.section-heading select')].some(e=>{const r=e.getBoundingClientRect();return r.left<0 || r.right>innerWidth;})})",
    );
    assert.equal(geometry.width, width);
    assert.equal(geometry.document, width);
    assert.equal(geometry.clipped, false);
    const sizes = await cdp.evaluate(
      "[...document.querySelectorAll('#disconnect,#refresh,#expand-all,.pager button')].map(e=>{const r=e.getBoundingClientRect();return [r.width,r.height]})",
    );
    assert.equal(sizes.length, 7);
    assert.ok(sizes.every(([w, h]) => w === 96 && h === (width <= 760 ? 44 : 36)));
    if (width === 390) {
      await screenshot("overview-narrow");
      await screenshot("records-narrow", ".panes");
    }
  }
  await cdp.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  assert.equal(await cdp.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
  relay.post(session.id, "bounty", { msg: "Reduced-motion committed update." });
  await wait("document.querySelector('.path-pulse') !== null", "reduced-motion committed pulse");
  assert.equal(
    await cdp.evaluate(
      "parseFloat(getComputedStyle(document.querySelector('.path-pulse')).animationDuration) <= .01 && getComputedStyle(document.querySelector('.path-pulse')).strokeDasharray === 'none'",
    ),
    true,
  );
  passed(
    "320/360/390/760/1000/1440px views have no document overflow or clipped toolbar controls; action buttons share 96px width and 36/44px height",
  );
  await cdp.call("Page.setFontSizes", { fontSizes: { standard: 32 } });
  await wait(
    "getComputedStyle(document.documentElement).fontSize === '32px'",
    "doubled browser default text size",
  );
  await cdp.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  const scaled = await cdp.evaluate(
    "({width:innerWidth,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('#refresh,#expand-all')].map(e=>{const r=e.getBoundingClientRect();return [r.width,r.height]})})",
  );
  assert.deepEqual(scaled, {
    width: 320,
    scroll: 320,
    buttons: [
      [192, 88],
      [192, 88],
    ],
  });
  await screenshot("overview-text-200");
  await cdp.call("Page.setFontSizes", { fontSizes: { standard: 16 } });
  await wait(
    "getComputedStyle(document.documentElement).fontSize === '16px'",
    "restored browser default text size",
  );
  passed("200% root text sizing reflows at 320px; shared buttons scale without page overflow");
  relay.ack(session.id, lease.id, "done");

  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (let slot = 2; slot <= 24; slot += 1)
    relay.register("worker", { slot: String(slot).padStart(3, "0") });
  await click("#refresh");
  await wait(
    "document.querySelectorAll('.worker-node').length === 24 && document.querySelector('[data-worker-overflow]')?.getAttribute('aria-expanded') === 'false'",
    "bounded worker group",
  );
  await click("[data-worker-overflow]");
  await wait(
    "document.querySelectorAll('.worker-node').length === 25 && document.querySelector('[data-worker-overflow]')?.getAttribute('aria-expanded') === 'true'",
    "expanded worker group",
  );
  assert.equal(
    await cdp.evaluate(
      "document.querySelector('[data-worker-overflow]').textContent === 'Show fewer workers'",
    ),
    true,
  );
  await click("[data-worker-overflow]");
  await wait(
    "document.querySelectorAll('.worker-node').length === 24 && document.querySelector('[data-worker-overflow]')?.getAttribute('aria-expanded') === 'false'",
    "folded worker group",
  );
  passed("Large worker groups expand and fold back without losing access to the overflow control");
  await filter("type:worker");
  assert.equal(
    await cdp.evaluate(
      "document.querySelectorAll('.worker-node').length === 24 && document.querySelector('[data-worker-overflow]') !== null && document.getElementById('filter-summary').textContent.includes('25 workers')",
    ),
    true,
  );
  await click("[data-worker-overflow]");
  await wait(
    "document.querySelectorAll('.worker-node').length === 25",
    "expanded filtered worker group",
  );
  await filter("");
  passed("Large structured query matches remain bounded and can be expanded explicitly");

  await authenticate("metadata");
  await wait(
    "document.getElementById('inbox-status').textContent === 'Denied' && document.getElementById('bounties-status').textContent === 'Denied'",
    "metadata-only body refusals",
  );
  assert.equal(
    await cdp.evaluate(
      "document.getElementById('topology').snapshot !== null && document.querySelectorAll('#inbox-rows > li,#bounties-rows > li').length === 0",
    ),
    true,
  );
  await screenshot("metadata-denied");
  passed("Metadata-only grants retain topology and deny/clear both body panes");
  await authenticate("work");
  await wait(
    "document.getElementById('inbox-status').textContent === 'Denied' && document.getElementById('bounties-status').textContent === 'Ready'",
    "work-only body scope",
  );
  passed("Work-only grants preserve Bounties while Inbox stays denied");

  await authenticate("full");
  await wait("document.getElementById('inbox-status').textContent === 'Ready'", "full body scope");
  await broker.close();
  broker = null;
  await wait(
    "document.getElementById('connection').dataset.state !== 'connected'",
    "broker disconnect",
  );
  assert.equal(
    await cdp.evaluate(
      "document.getElementById('topology').snapshot !== null && document.getElementById('inbox-status').textContent.includes('cached')",
    ),
    true,
  );
  await click("#refresh");
  await wait(
    "document.getElementById('connection').dataset.state === 'error'",
    "failed manual refresh",
  );
  assert.equal(
    await cdp.evaluate(
      "document.getElementById('topology').snapshot !== null && document.getElementById('inbox-status').textContent.includes('cached')",
    ),
    true,
  );
  passed(
    "Manual Refresh against the stopped broker keeps cached topology marked offline rather than opening a feed from it",
  );
  await screenshot("offline-cached");
  broker = await serve({ root, configFile: configPath });
  await wait(
    "document.getElementById('connection').dataset.state === 'connected' && document.getElementById('inbox-status').textContent === 'Ready'",
    "broker restart recovery",
  );
  passed("Actual broker stop/restart marks cached state and reconnects without new credentials");

  await filter("worker");
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      credentials: registry.credentials.filter((row) => row.principal !== "overview-full"),
    }),
    { mode: 0o600 },
  );
  await click("#refresh");
  await wait(
    "document.getElementById('connection').textContent === 'Authentication required' && document.getElementById('topology').snapshot === null",
    "credential revocation",
  );
  assert.equal(
    await cdp.evaluate(
      "document.querySelectorAll('#inbox-rows > li,#bounties-rows > li').length === 0 && document.getElementById('inspector').snapshot === null && document.getElementById('node-filter').value === '' && document.getElementById('node-filter-options').options.length === 0 && [...document.querySelectorAll('#overview dd')].every(e=>e.textContent === '—')",
    ),
    true,
  );
  passed(
    "Real credential revocation clears summary, topology, inspector, filter and private pane caches",
  );

  await authenticate("work");
  await wait(
    "document.getElementById('bounties-status').textContent === 'Ready'",
    "old authority work page",
  );
  const previousAuthority = await cdp.evaluate(
    "document.getElementById('topology').snapshot.authority",
  );
  const emptyRoot = join(parent, "empty");
  setup({ root: emptyRoot, device: "empty-qa", role: "hub" });
  await broker.close();
  broker = await serve({ root: emptyRoot, configFile: configPath });
  await wait(
    `document.getElementById('topology').snapshot?.authority !== ${JSON.stringify(previousAuthority)} && document.getElementById('connection').dataset.state === 'connected'`,
    "new authority recovery",
  );
  await wait(
    "document.getElementById('bounties-status').textContent === 'Empty' && document.getElementById('topology').snapshot.totals.agents === 0",
    "empty real store",
  );
  assert.equal(
    await cdp.evaluate("document.getElementById('topology').textContent.includes('No workers')"),
    true,
  );
  await screenshot("empty-store");
  passed(
    "Replacing broker authority automatically clears old body scope and renders zero workers/empty work from the new real store",
  );
  await click("#disconnect");
  await wait(
    "document.getElementById('topology').snapshot === null",
    "explicit disconnect cleanup",
  );
  assert.equal(
    await cdp.evaluate(
      "document.querySelectorAll('#inbox-rows > li,#bounties-rows > li').length === 0 && document.getElementById('disconnect').disabled",
    ),
    true,
  );
  passed("Explicit Disconnect clears private state and restores the authentication form");
  assert.equal(exceptions, 0);
  assert.equal(await cdp.evaluate("window.qaCspViolations"), 0);
  passed("No uncaught browser exceptions or CSP violations");
  const report = {
    qualified: "isolated real Relay store/broker/browser, not native agent delivery",
    runtime: process.version,
    checks: results,
    runtimeExceptions: exceptions,
    cspViolations: 0,
  };
  await writeFile(join(evidence, "overview-qa.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      passed: results.length,
      evidence,
      runtimeExceptions: exceptions,
      cspViolations: 0,
    }),
  );
} catch (error) {
  primaryError = error;
} finally {
  const failures = [];
  for (const cleanup of [
    () => cdp?.close(),
    () => browser && stopOwnedBrowser(browser),
    () => broker?.close(),
    () => relay?.close(),
    () =>
      listener?.listening &&
      new Promise((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
    () => parent && rm(parent, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  cleanupFailures = failures;
}
// Report after cleanup so the finally block never replaces the original failure.
if (primaryError && cleanupFailures.length)
  throw new AggregateError(
    [primaryError, ...cleanupFailures],
    "overview verification cleanup failed",
    {
      cause: primaryError,
    },
  );
if (primaryError) throw primaryError;
if (cleanupFailures.length)
  throw new AggregateError(cleanupFailures, "overview verification cleanup failed");
