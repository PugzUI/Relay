# X6 + Dockview integration prototype

Isolated verification fixture, not a production renderer migration or native-agent delivery qualification. Everything in this directory is excluded from Relay's published package. The production UI remains Lit + native SVG under its existing strict CSP.

## Run

From the repository root, with Node 24+:

```sh
npm ci --prefix tests/workspace-prototype --ignore-scripts
npm --prefix tests/workspace-prototype run build
npm --prefix tests/workspace-prototype start
```

Open `http://127.0.0.1:18848/`. `PROTOTYPE_PORT` accepts an explicit alternative port. Startup refuses an occupied port rather than selecting another. The listener binds literal loopback, creates a private disposable hub store and two worker processes, and expires after two hours. Ctrl+C shuts down the workers, closes their sessions, and removes that instance's temporary store. No installed agent configuration or ordinary Relay profile is used.

The startup record identifies the instance's origin, root and process. This fixture has no existing-user bearer credential: a same-origin bootstrap obtains a per-run action token in memory. Mutations require that token, the exact Origin, a known live worker and an allowlisted command. The token is never placed in a URL, argv, terminal output or localStorage. Do not publish or proxy this local verification server.

## Exercise

1. Select ALPHA or BETA in X6, or use the keyboard-accessible inspector buttons. A repeat selection activates the existing console tab instead of opening a second one.
2. Use **Claim only**. A real worker process calls Relay's normal claim engine against the isolated bounty board; the package appears in Claimed after the store commits.
3. Use **Complete**. The worker computes SHA256 over the claimed fixture payload and acknowledges that lease. The committed work row appears in Done; the console displays the actual computation and acknowledgement.
4. Use **Run next** for claim + computation + acknowledgement, or **Auto on/off** for bounded fixture consumption. **Post work** adds three fixture packages, up to thirty total.
5. Dock, split or resize panels. Save the layout, reset it, and restore it. Layouts are scoped to the disposable instance and contain panel arrangement, not authority or credentials.
6. Disconnect the feed to inspect the cached view; mutation controls disable. Existing worker processes continue independently. Reconnect refreshes committed state without inventing another claim or acknowledgement, or replaying historical electrical activity.

The console accepts only `help`, `status`, `claim`, `complete`, `run`, `auto on`, `auto off`, and `message`. It is an xterm frontend to these fixture commands, **not an OS shell, PTY, native AI session attachment, or arbitrary execution endpoint**. Rejected commands remain rejected. Selecting a package only inspects it; board movement does not create execution authority. There is no Gantt scheduler.

## Verify

```sh
npm --prefix tests/workspace-prototype run verify
```

The verifier launches its own fresh loopback instance and Chromium, exercises node selection, single-console attachment, real claim/ack, synchronized board state, layout persistence, feed disconnect/reconnect, denied shell/token requests and narrow layouts. It records screenshots and a JSON result under the configured temporary directory, reports the evidence path, and verifies owned worker/process/store cleanup. Chromium defaults to `/usr/bin/chromium`; set `RELAY_BROWSER` to another local Chromium executable when needed.

Production UI browser verification is separate:

```sh
node tests/fixtures/ui/overview-qa.mjs
```

That fixture exercises the actual authenticated broker and production UI, including body permissions, committed pulses, reconnection, selected-text preservation, 320–1440px layouts, shared control dimensions and doubled browser default text sizing. Neither fixture qualifies real native-agent attachment.

## Rendering boundary

The prototype serves the actual `ui/style.css` and adds only workspace layout/library adaptation. It does not maintain another palette or action-button scale. Action controls share the production 96×36px body, with 44px narrow/coarse-pointer height; data-bearing rows stay fluid. Dockview supplies layout/tab behavior, X6 supplies graph interaction, and xterm supplies terminal presentation. The Relay store remains the only work-state authority.

The bundled libraries use DOM/SVG inline positioning, so this test-only server permits inline styles. Scripts remain local with no `unsafe-eval`, CDN or remote runtime dependencies. This is **not compatible with the production style CSP as-is**. Any product adoption must first resolve that boundary rather than relax production CSP silently. Native attachment, remote device authorization and reconnectable PTY transport remain separate unimplemented capabilities.

## Build provenance

Dependencies and versions are pinned in this directory's package lock. `build.mjs` bundles the browser modules locally and collects the actual bundled packages' license texts into `assets/LICENSES.txt`; missing license provenance fails the build. The prototype's dependencies do not enter the root runtime manifest or published package.

The generated `assets/` directory is ignored by Git. A fresh checkout must run
the install and build commands above before starting or verifying this fixture.
The build recreates both browser assets and their license notices; distribute
those notices with any copied bundle. Source files, the package lock, and build
instructions are versioned.
