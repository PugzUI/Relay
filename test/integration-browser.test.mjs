import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { isolatedFleet, launchBrowser } from "./fixtures/isolated-hosts.mjs";

test("browser runs ACP turns, approvals, cancel, two hosts and restart boundaries",
  { timeout: 150000 }, async (t) => {
    const { hosts, webOrigin } = await isolatedFleet(t, { hostCount: 2, withWeb: true });
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    async function connect(label, host) {
      if (!(await page.locator(".connect-form").count())) {
        await page.getByRole("button", { name: /connect host/i }).click();
      }
      await page.locator('input[name="label"]').fill(label);
      await page.locator('input[name="endpoint"]').fill(host.origin);
      await page.locator('input[name="token"]').fill(host.token);
      await page.locator('.connect-form button[type="submit"]').click();
      await page.getByRole("button", { name: new RegExp(label, "i") })
        .filter({ has: page.locator(".host-text") }).waitFor({ state: "visible" });
      await page.waitForFunction((name) => {
        const item = [...document.querySelectorAll(".host-row")]
          .find((row) => row.querySelector("strong")?.textContent === name);
        return item?.querySelector("small")?.textContent === "connected";
      }, label, { timeout: 20000 });
    }

    async function createSession(label, host) {
      await page.locator(".host-row").filter({ hasText: label }).click();
      await page.locator(".sessions-panel button.primary").click();
      await page.locator('.create-form input[name="directory"]')
        .fill(pathToFileURL(host.workspace).href);
      await page.locator('.workspace-trust input[name="trustWorkspace"]').check();
      await page.locator(".create-form button.primary").click();
      await page.locator(".composer textarea").waitFor({ state: "visible" });
      await page.waitForFunction((hostId) => {
        const fleet = document.querySelector("relay-fleet")?.fleet;
        return fleet?.selected?.hostId === hostId &&
          fleet.slots.chat?.ready && !!fleet.chat;
      }, label.toLowerCase(), { timeout: 20000 });
    }

    async function prompt(message) {
      await page.locator(".composer textarea").fill(message);
      await page.locator('.composer button[type="submit"]').click();
    }

    async function turnState(message, state) {
      await page.waitForFunction(({ prompt, outcome }) =>
        [...document.querySelectorAll(".turn")].some((turn) =>
          turn.querySelector(".turn-prompt")?.textContent === prompt &&
          turn.querySelector(".turn-outcome")?.textContent?.toLowerCase().includes(outcome)),
      { prompt: message, outcome: state }, { timeout: 20000 });
    }

    try {
      await page.goto(webOrigin);
      assert.equal(await page.locator(".sidebar .rail-data").count(), 0,
        "Sidebar must not duplicate the four authoritative main metrics");
      assert.equal(await page.locator(".metrics > div").count(), 4);
      assert.equal(await page.locator(".sidebar").getByText("FLEET SUMMARY").count(), 0);
      assert.equal(await page.locator(".sidebar").getByText("No connected hosts. Add an AHP endpoint.").count(), 0);
      assert.equal(await page.locator(".topology-tools .topology-keys").count(), 1,
        "Keys belongs beside the search field, not the section title");
      assert.equal(await page.locator(".section-head .topology-keys").count(), 0);
      assert.equal(await page.locator(".inspector-head button").count(), 0,
        "An empty inspector must not display disabled session-only actions");
      assert.equal(await page.locator(".empty-map span").count(), 0,
        "The empty topology already explains itself without a second instruction");
      const mono = await page.locator(".rail-title").evaluate((node) =>
        getComputedStyle(node).fontFamily);
      assert.match(mono, /^"Geist Mono"/);
      await page.locator(".topology-keys").click();
      assert.equal(await page.locator(".shortcuts-dialog").evaluate((dialog) => dialog.open), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".shortcuts-dialog").evaluate((dialog) => dialog.open), false);
      // Both entry points must operate on the same real connection form.
      await page.getByRole("button", { name: "+ Connect host" }).click();
      assert.equal(await page.locator(".connect-form").count(), 0);
      await page.getByRole("button", { name: "+ Add host" }).click();
      await page.locator(".connect-form").waitFor({ state: "visible" });
      assert.equal(await page.locator('input[name="label"]').evaluate((input) =>
        document.activeElement === input), true);
      await connect("Alpha", hosts[0]);
      await connect("Beta", hosts[1]);
      await page.waitForFunction(() =>
        document.querySelectorAll(".host-row small").length === 2 &&
        [...document.querySelectorAll(".host-row small")]
          .every((node) => node.textContent === "connected"));
      await page.getByRole("button", { name: "+ Add host" }).click();
      assert.equal(await page.locator('input[name="label"]').evaluate((input) =>
        document.activeElement === input), true);
      assert.equal(await page.locator(".host-row").count(), 2,
        "Opening the connection form must not disrupt existing hosts");
      await page.getByRole("button", { name: "+ Connect host" }).click();

      await createSession("Alpha", hosts[0]);
      await createSession("Beta", hosts[1]);
      assert.equal(await page.locator(".inspector-head button").count(), 1,
        "Session refresh must remain available with a selected session");
      await page.waitForFunction(() =>
        document.querySelectorAll(".session-row").length === 2 &&
        document.querySelectorAll("svg.map .node.host").length === 2 &&
        document.querySelectorAll("svg.map .node.session").length === 2,
      null, { timeout: 20000 });

      await prompt("Normal Beta turn.");
      await turnState("Normal Beta turn.", "complete");
      assert.match(await page.locator(".response-text").last().innerText(), /Test turn complete/);

      await prompt("Check approval denial.");
      await page.locator(".attention-item button").filter({ hasText: "Deny this operation" })
        .waitFor({ state: "visible", timeout: 15000 });
      await page.locator(".attention-item button").filter({ hasText: "Deny this operation" }).click();
      await turnState("Check approval denial.", "complete");
      assert.match(await page.locator(".response-text").last().innerText(), /Permission deny/);

      await prompt("Check approval once.");
      const allow = page.locator(".attention-item button").filter({ hasText: "Allow once" });
      await allow.waitFor({ state: "visible", timeout: 15000 });
      await allow.click();
      await turnState("Check approval once.", "complete");
      assert.match(await page.locator(".response-text").last().innerText(), /Permission approve-once/);

      await prompt("Check cancel now.");
      await page.locator(".composer-actions button.quiet")
        .waitFor({ state: "visible", timeout: 15000 });
      await page.waitForFunction(() => !document.querySelector(".composer-actions button.quiet")?.disabled,
        null, { timeout: 15000 });
      await page.locator(".composer-actions button.quiet").click();
      await turnState("Check cancel now.", "cancelled");
      await page.waitForFunction(() =>
        document.querySelector(".inspector-title .state-text")?.textContent?.trim() === "idle",
      null, { timeout: 15000 });

      await page.locator(".rail-actions button").filter({ hasText: "Reconnect" }).click();
      await page.waitForFunction(() =>
        document.querySelector(".host-row.selected small")?.textContent === "connected" &&
        [...document.querySelectorAll(".turn-outcome")]
          .some((node) => /cancelled/i.test(node.textContent)), null, { timeout: 30000 });
      await prompt("After Beta reconnect.");
      await turnState("After Beta reconnect.", "complete");

      await page.locator(".session-row").filter({ hasText: "Alpha" }).click();
      await page.locator(".composer textarea").waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector(".transcript")?.textContent?.includes("No turns in this chat."));
      await prompt("Before Alpha restart.");
      await turnState("Before Alpha restart.", "complete");

      await hosts[0].stop();
      await page.waitForFunction(() => {
        const alpha = [...document.querySelectorAll(".host-row")]
          .find((row) => row.querySelector("strong")?.textContent === "Alpha");
        return alpha?.querySelector("small")?.textContent !== "connected" &&
          document.querySelector(".composer textarea")?.disabled;
      }, null, { timeout: 20000 });
      await hosts[0].start();
      await page.waitForFunction(() => {
        const alpha = [...document.querySelectorAll(".host-row")]
          .find((row) => row.querySelector("strong")?.textContent === "Alpha");
        return alpha?.querySelector("small")?.textContent === "connected" &&
          document.querySelector(".composer textarea")?.disabled &&
          document.querySelector(".inspector-title .state-text")?.textContent === "UNAVAILABLE" &&
          document.querySelector(".transcript")?.textContent?.includes("No agent for session");
      }, null, { timeout: 30000 }).catch(async (error) => {
        const state = await page.evaluate(() => {
          const fleet = document.querySelector("relay-fleet")?.fleet;
          return {
            hosts: [...document.querySelectorAll(".host-row")].map((node) => node.innerText),
            selected: fleet?.selected,
            sessionReady: !!fleet?.slots.session?.ready,
            chatReady: !!fleet?.slots.chat?.ready,
            sessionError: fleet?.slots.session?.error,
            chatError: fleet?.slots.chat?.error,
            transcript: document.querySelector(".transcript")?.innerText?.slice(0, 300),
            composerDisabled: document.querySelector(".composer textarea")?.disabled,
          };
        });
        throw Error(`AHP unavailable-session recovery: ${error.message}; state=${JSON.stringify(state)}`);
      });
      // This fixture deliberately advertises loadSession: false. ahpd reconnects,
      // but cannot restore its old ACP process. Relay must retain that boundary.
      await createSession("Alpha", hosts[0]);
      await prompt("Fresh session after Alpha restart.");
      await turnState("Fresh session after Alpha restart.", "complete");

      assert.equal(await page.locator(".host-row").count(), 2);
      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      assert.ok(mobile.document <= mobile.viewport + 1,
        `Mobile layout overflows the viewport: ${JSON.stringify(mobile)}`);
      const addHostMobile = await page.getByRole("button", { name: "+ Add host" })
        .evaluate((button) => ({ minHeight: button.getBoundingClientRect().height,
          right: button.getBoundingClientRect().right,
          viewport: window.innerWidth }));
      assert.ok(addHostMobile.minHeight >= 44 &&
        addHostMobile.right <= addHostMobile.viewport + 1,
      `The mobile Add host action is clipped or too small: ${JSON.stringify(addHostMobile)}`);
      assert.equal(await page.locator("svg.map .node.host").count(), 2);

      await page.setViewportSize({ width: 1440, height: 900 });
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator(".inspector-footer button.danger").click();
      await page.locator(".inspector-empty").waitFor({ state: "visible", timeout: 15000 });
      assert.deepEqual(pageErrors, []);
      // Credentials are not exported into page content or browser storage.
      const clientState = await page.evaluate(() => ({
        text: document.documentElement.outerHTML,
        local: JSON.stringify(localStorage),
      }));
      for (const host of hosts) {
        assert.ok(!clientState.text.includes(host.token));
        assert.ok(!clientState.local.includes(host.token));
      }
    } finally {
      await browser.close();
    }
  });

test("missing or invalid token can be repaired with the same host name", { timeout: 45000 }, async (t) => {
  const { hosts, webOrigin } = await isolatedFleet(t, { withWeb: true });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    await page.goto(webOrigin);
    await page.locator('input[name="label"]').fill("v-arch");
    await page.locator('input[name="endpoint"]').fill(hosts[0].origin);
    await page.locator('.connect-form button[type="submit"]').click();
    assert.equal(await page.locator('input[name="token"]').evaluate((input) =>
      input.validity.valueMissing), true);
    assert.equal(await page.locator(".host-row").count(), 0);

    await page.locator('input[name="token"]').fill("invalid-token");
    await page.locator('.connect-form button[type="submit"]').click();
    await page.waitForFunction(() =>
      document.querySelector(".host-error")?.textContent?.includes("Check the host URL and access token"),
    null, { timeout: 15000 });
    // Retry from the Connect form without deleting the failed v-arch entry.
    // The previous behavior raised "Host name is already in use".
    await page.getByRole("button", { name: "+ Connect host" }).click();
    await page.locator('input[name="label"]').fill("v-arch");
    await page.locator('input[name="endpoint"]').fill(hosts[0].origin);
    await page.locator('input[name="token"]').fill(hosts[0].token);
    await page.locator('.connect-form button[type="submit"]').click();
    await page.waitForFunction(() =>
      document.querySelector(".host-row small")?.textContent === "connected", null, { timeout: 15000 });
    assert.equal(await page.locator(".host-error").count(), 0);
    assert.equal(await page.locator(".host-row").count(), 1, "Retry must not duplicate the host");
    // Re-submitting that name once connected must not interrupt its sessions.
    await page.getByRole("button", { name: "+ Connect host" }).click();
    await page.locator('input[name="label"]').fill("v-arch");
    await page.locator('input[name="endpoint"]').fill(hosts[0].origin);
    await page.locator('input[name="token"]').fill(hosts[0].token);
    await page.locator('.connect-form button[type="submit"]').click();
    await page.waitForFunction(() =>
      document.querySelector(".alert")?.textContent?.includes("already connected"), null,
      { timeout: 10000 });
    assert.equal((await page.locator(".host-row small").innerText()).toLowerCase(), "connected");
    assert.equal(await page.locator(".host-row").count(), 1);

    // The token's instructions remain available to assistive technology, but
    // do not shift the input or button or add visual clutter at any viewport.
    for (const width of [1440, 1280, 1161, 1160, 1101, 1100, 900, 760, 540, 390, 360]) {
      await page.setViewportSize({ width, height: 900 });
      const positions = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        const form = rect(".connect-form");
        const token = rect('.connect-form input[name="token"]');
        const button = rect('.connect-form button[type="submit"]');
        const help = document.querySelector("#host-token-help");
        return {
          rightInset: form.right - button.right,
          aligned: Math.abs(token.bottom - button.bottom) <= 1,
          helpVisuallyHidden: getComputedStyle(help).position === "absolute" &&
            help.getBoundingClientRect().width <= 1,
          hintAssociation: document.querySelector('.connect-form input[name="token"]')
            .getAttribute("aria-describedby") === "host-token-help",
        };
      });
      assert.ok(positions.rightInset >= 12,
        `Connect button clips the form edge at ${width}px: ${JSON.stringify(positions)}`);
      if (width > 760) {
        assert.ok(positions.aligned,
          `Token help shifts the field away from Connect at ${width}px`);
      }
      assert.ok(positions.helpVisuallyHidden && positions.hintAssociation,
        `Token hint is visually distracting or loses accessible labeling at ${width}px`);
    }
  } finally {
    await browser.close();
  }
});
