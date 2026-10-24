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
      await connect("Alpha", hosts[0]);
      await connect("Beta", hosts[1]);
      await page.waitForFunction(() =>
        document.querySelectorAll(".host-row small").length === 2 &&
        [...document.querySelectorAll(".host-row small")]
          .every((node) => node.textContent === "connected"));

      await createSession("Alpha", hosts[0]);
      await createSession("Beta", hosts[1]);
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
