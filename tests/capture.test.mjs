import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureEnvironment, capturePageState, captureUrl, pngDimensions, readCaptureToken } from "./fixtures/ui/capture.mjs";

test("capture URL accepts only loopback origins", () => {
  assert.equal(captureUrl("http://127.0.0.1:4200"), "http://127.0.0.1:4200");
  assert.equal(captureUrl("https://[::1]:4200"), "https://[::1]:4200");
  for (const value of ["https://example.test", "http://127.0.0.1/path", "http://user@localhost", "http://localhost/?token=x"]) {
    assert.throws(() => captureUrl(value));
  }
});

test("capture evidence requires connected selected-board data and exact viewport geometry", () => {
  const state = {
    origin: "http://127.0.0.1:4200", blank: false, ready: true,
    viewportWidth: 390, viewportHeight: 844, documentWidth: 390, documentHeight: 1600,
    horizontalOverflow: false, connection: "connected", selectedBoard: "bounty",
    topologyItems: 4, inbox: 2, bounties: 3, inboxState: "Ready", bountiesState: "Ready", loading: false, error: false,
  };
  assert.deepEqual(capturePageState(state, { origin: state.origin, width: 390, height: 844 }), {
    origin: state.origin, selectedBoard: "bounty",
    viewport: { width: 390, height: 844 },
    document: { width: 390, height: 1600, horizontalOverflow: false },
    topologyItems: 4,
    panes: { inboxRows: 2, bountiesRows: 3 }, connection: "connected",
    paneStates: { inbox: "Ready", bounties: "Ready" },
  });
  for (const change of [
    { origin: "https://elsewhere.test" }, { blank: true }, { connection: "disconnected" },
    { selectedBoard: "" }, { documentWidth: 400, horizontalOverflow: true },
    { inbox: 0 }, { bounties: 0 }, { loading: true }, { error: true },
  ]) {
    assert.throws(() => capturePageState({ ...state, ...change }, { origin: state.origin, width: 390, height: 844 }));
  }
  assert.throws(() => capturePageState(state, { origin: state.origin, width: 1440, height: 900 }));
});

test("capture browser environment drops inherited desktop bindings and capture credentials", () => {
  assert.deepEqual(captureEnvironment({
    PATH: "/bin", HOME: "/home/test", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1",
    XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    HYPRLAND_INSTANCE_SIGNATURE: "private", RELAY_CAPTURE_TOKEN_FILE: "/tmp/token", RELAY_CAPTURE_URL: "http://127.0.0.1:4200",
  }), { PATH: "/bin", HOME: "/home/test" });
});

test("capture screenshot dimensions come from the PNG pixel header", () => {
  const image = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.write("IHDR", 12, "ascii");
  image.writeUInt32BE(390, 16);
  image.writeUInt32BE(844, 20);
  assert.deepEqual(pngDimensions(image), { width: 390, height: 844 });
  assert.throws(() => pngDimensions(Buffer.alloc(24)));
});

test("capture token reader accepts a private token file and rejects unsafe forms", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-capture-test-"));
  const path = join(root, "token");
  const token = "A".repeat(43);
  try {
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    assert.equal(await readCaptureToken(path), token);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await assert.rejects(readCaptureToken(path), /private file/);
      await chmod(path, 0o600);
      const link = join(root, "token-link");
      await symlink(path, link);
      await assert.rejects(readCaptureToken(link), /opened safely/);
    }
    await writeFile(path, `${token}extra`, { mode: 0o600 });
    await assert.rejects(readCaptureToken(path), /invalid size/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
