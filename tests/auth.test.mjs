import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorize, authorizeBoardRead, authenticate, loadRegistry } from "../src/auth.mjs";
import { Fault } from "../src/fault.mjs";
import { credential, emptyGrant, privateFile, withTempDir } from "./network-helpers.mjs";

test("registry rejects duplicate JSON keys before constructing a snapshot", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "credentials.json");
    await privateFile(path, '{"version":1,"version":1,"credentials":[]}');
    await assert.rejects(
      loadRegistry(path),
      (error) => error instanceof Fault && error.code === "input",
    );
  });
});

test("authentication uses the current complete grant and rejects duplicate Authorization", async () => {
  await withTempDir(async (root) => {
    const grant = emptyGrant();
    grant.workers = ["east:worker:001"];
    grant.register = [
      { deviceId: "east", deviceName: "east", runtimes: ["worker"], allocate: true },
    ];
    grant.recipients = ["hub:worker:prime"];
    grant.boardClaim = ["bounty"];
    const auth = credential({ grant });
    const path = join(root, "credentials.json");
    await privateFile(path, JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const snapshot = await loadRegistry(path);
    const principal = authenticate(snapshot, `Bearer ${auth.token}`);
    assert.equal(principal.id, "worker");
    assert.equal(
      authorize(snapshot, principal, "send", {
        sid: "session",
        to: "hub:worker:prime",
        envelope: { msg: "hello" },
      }).scopeKey,
      principal.scopeKey,
    );
    assert.equal(
      authorize(snapshot, principal, "register", { runtime: "worker" }).operation,
      "register",
    );
    assert.throws(
      () => authenticate(snapshot, [`Bearer ${auth.token}`, `Bearer ${auth.token}`]),
      (error) => error.code === "auth",
    );
    assert.throws(
      () =>
        authorize(snapshot, principal, "send", {
          sid: "session",
          to: "other:worker:001",
          envelope: { msg: "hello" },
        }),
      (error) => error.code === "denied",
    );
  });
});

test("DEV_RELAY authenticates only the development topology grant", () => {
  const previous = process.env.DEV_RELAY;
  const token = "D".repeat(43);
  process.env.DEV_RELAY = token;
  try {
    const principal = authenticate({ version: 1, credentials: [] }, `Bearer ${token}`);
    assert.equal(principal.id, "dev-relay");
    assert.equal(principal.grant.inspect.topology, true);
    assert.equal(principal.grant.inspect.messages, false);
    assert.equal(
      authorize({ version: 1, credentials: [] }, principal, "snapshot", { options: {} }).operation,
      "snapshot",
    );
    assert.equal(
      authorizeBoardRead({ version: 1, credentials: [] }, principal, "bounty", "msg", false)
        .operation,
      "list",
    );
    assert.throws(
      () => authorize({ version: 1, credentials: [] }, principal, "stats", {}),
      (error) => error.code === "denied",
    );
    assert.throws(
      () => authenticate({ version: 1, credentials: [] }, `Bearer ${"E".repeat(43)}`),
      (error) => error.code === "auth",
    );
  } finally {
    if (previous === undefined) delete process.env.DEV_RELAY;
    else process.env.DEV_RELAY = previous;
  }
});

test("board reads require their own board and kind grant", async () => {
  await withTempDir(async (root) => {
    const grant = emptyGrant();
    grant.inboxRead = ["host:device-1"];
    const auth = credential({ grant });
    const path = join(root, "credentials.json");
    await privateFile(path, JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const snapshot = await loadRegistry(path);
    const principal = authenticate(snapshot, `Bearer ${auth.token}`);
    assert.equal(
      authorizeBoardRead(snapshot, principal, "host:device-1", "msg", true).operation,
      "list",
    );
    assert.throws(
      () => authorizeBoardRead(snapshot, principal, "host:device-1", "work", false),
      (error) => error.code === "denied",
    );
  });
});

test("message inspection grants stats independently from topology snapshots", async () => {
  await withTempDir(async (root) => {
    const grant = emptyGrant();
    grant.inspect.messages = true;
    const auth = credential({ grant });
    const path = join(root, "credentials.json");
    await privateFile(path, JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const snapshot = await loadRegistry(path);
    const principal = authenticate(snapshot, `Bearer ${auth.token}`);
    assert.equal(authorize(snapshot, principal, "stats", {}).operation, "stats");
    assert.throws(
      () => authorize(snapshot, principal, "snapshot", { options: {} }),
      (error) => error.code === "denied",
    );

    grant.inspect.messages = false;
    grant.inspect.topology = true;
    auth.entry.grant = grant;
    await privateFile(path, JSON.stringify({ version: 1, credentials: [auth.entry] }));
    const topologyOnly = await loadRegistry(path);
    const topologyPrincipal = authenticate(topologyOnly, `Bearer ${auth.token}`);
    assert.equal(
      authorize(topologyOnly, topologyPrincipal, "snapshot", { options: {} }).operation,
      "snapshot",
    );
    assert.throws(
      () => authorize(topologyOnly, topologyPrincipal, "stats", {}),
      (error) => error.code === "denied",
    );
  });
});

test("registry digest collisions and unknown grant keys fail closed", async () => {
  await withTempDir(async (root) => {
    const first = credential();
    const second = credential({ principal: "other", token: first.token });
    const path = join(root, "credentials.json");
    await privateFile(
      path,
      JSON.stringify({ version: 1, credentials: [first.entry, second.entry] }),
    );
    await assert.rejects(
      loadRegistry(path),
      (error) => error instanceof Fault && error.code === "input",
    );
    first.entry.grant.extra = true;
    await privateFile(path, JSON.stringify({ version: 1, credentials: [first.entry] }));
    await assert.rejects(
      loadRegistry(path),
      (error) => error instanceof Fault && error.code === "input",
    );
  });
});

// ---------------------------------------------------------------------------
// Lane 10 -- the registry digest index carrier.
//
// The published registry snapshot carries a credential array AND a digest index
// (tokenDigest -> principal). The contract declares the index as a public typed
// field and also describes it as internal storage; this carrier follows the
// type-authoritative reading the owner routed, and A3/A4 stay valid under
// either reading, because the published principal and the published digest are
// public regardless of the index's status.
//
// ANCHORED OUTSIDE THE SUBJECT'S OUTPUT: every expected value is read back
// from the REGISTRY FILE on disk. No expectation is taken from
// snapshot.credentials[i] and none from the index itself. A3 and A4 are the
// input anchors; A5 looks the REGISTERED digest up in the index.
//
// LIMITS, STATED:
//   - The carrier does not pin the grant normalisation or the scopeKey
//     derivation. Both are documented derivations, and asserting them would
//     re-implement the subject instead of observing it. The case "U1" below
//     shows that limit is real: a normalisation mutant changes the published
//     grant and the derived scopeKey, and no assertion here sees it.
//   - The carrier does not assert the index's insertion order. The case "I1"
//     below reverses the insertion order and must stay unflagged.
//
// A5 compares two published places (the index value and the published
// principal), so it is blind to a substitution the subject performs in both at
// once. A3 and A4 are the input anchors that make that blindness unreachable:
// F1, F2, F3 and F4 are each caught.
//
// NON-VACUOUS: every assertion is falsified by a named mutant, and the
// mutants run against a COPY of src/ -- the repository source is never
// modified. The free-field census mutates exactly one published field at a
// time and gates on "every covered case is caught by at least one assertion":
// a hole in this carrier is a failing test, not a judgement.
//
// FIELD NAMES, so the wiring can be checked by reading: the table declares
// `direction` ("flag" | "ignore"), which is the ONLY field the census gate
// reads, and `coverage` ("covered" | "inert-control" | "declared-unpinned"),
// which is the descriptive classification. The closed direction set is
// enforced at load time: an unknown label is a hard error, never a fallback
// to the ignore branch, and the descriptive classification and the direction
// label are checked against each other so they cannot disagree.
//
// The case list and the runner are checked against the same list: the
// runner's own output must carry every case ID and the count, so a case that
// is added to the table but dropped from the run cannot report green. The
// case IDs follow the assigned list, which has no M5.
//
// The corpus sweep applies one carrier mutation to a copy of the whole
// published source tree and asserts that every file of that corpus still
// parses, with the processed count as the denominator: an exception inside
// the sweep must never shrink it.
// ---------------------------------------------------------------------------

const CARRIER_SOURCE_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const CARRIER_INDEX = "new Map(credentials.map((entry) => [entry.tokenDigest, entry.principal]))";
const CARRIER_INDEX_FROM_DOC =
  "new Map(doc.credentials.map((entry) => [entry.tokenDigest, entry.principal]))";
const CARRIER_SNAPSHOT_RETURN =
  "return Object.freeze({ version: 1, credentials: Object.freeze(credentials), digestIndex });";

const CARRIER_ASSERTIONS = [
  {
    id: "A1",
    clause: "the published digest index is a Map",
    check: (snapshot) => snapshot.digestIndex instanceof Map,
  },
  {
    id: "A2",
    clause: "the published digest index holds one entry per published credential",
    check: (snapshot) => snapshot.digestIndex.size === snapshot.credentials.length,
  },
  {
    id: "A3",
    clause: "every published principal equals the registered principal",
    check: (snapshot, registered) =>
      snapshot.credentials.every((entry, i) => entry.principal === registered[i].principal),
  },
  {
    id: "A4",
    clause: "every published tokenDigest equals the registered tokenDigest",
    check: (snapshot, registered) =>
      snapshot.credentials.every((entry, i) => entry.tokenDigest === registered[i].tokenDigest),
  },
  {
    id: "A5",
    clause: "the index maps every registered digest to the published principal",
    check: (snapshot, registered) =>
      registered.every(
        (entry, i) =>
          snapshot.digestIndex.get(entry.tokenDigest) === snapshot.credentials[i].principal,
      ),
  },
];

// One published field moves per case.
//
// The direction label is a CLOSED set: "flag" means the case must be caught by
// at least one assertion, "ignore" means it must be caught by none. Any other
// value is a hard error at load time, never a fallback to "ignore" -- a
// mislabelled case would otherwise lose the ability to fail at all. The
// "coverage" field only records what the case is (a free field the census
// covers, an inert control, or a derivation the carrier declares unpinned);
// the gate reads the direction, not the coverage, and the two are checked
// against each other at load time.
const CARRIER_DIRECTIONS = new Set(["flag", "ignore"]);
const CARRIER_MUTANTS = [
  {
    id: "M1",
    direction: "flag",
    field: "digestIndex values",
    coverage: "covered",
    note: "the index maps the registered digest to the other principal",
    edits: [
      [
        CARRIER_INDEX,
        "new Map(credentials.map((entry, i) => [entry.tokenDigest, credentials[(i + 1) % credentials.length].principal]))",
        1,
      ],
    ],
    caughtBy: ["A5"],
    authentication: "authenticated:P1",
  },
  {
    id: "M2",
    direction: "flag",
    field: "digestIndex values",
    coverage: "covered",
    note: "the index value is the scope key instead of the principal",
    edits: [
      [
        CARRIER_INDEX,
        "new Map(credentials.map((entry) => [entry.tokenDigest, entry.scopeKey]))",
        1,
      ],
    ],
    caughtBy: ["A5"],
    authentication: "authenticated:P1",
  },
  {
    id: "M3",
    direction: "flag",
    field: "digestIndex entry set",
    coverage: "covered",
    note: "the index is empty",
    edits: [[CARRIER_INDEX, "new Map()", 1]],
    caughtBy: ["A2", "A5"],
    authentication: "authenticated:P1",
  },
  {
    id: "M4",
    direction: "flag",
    field: "digestIndex entry set",
    coverage: "covered",
    note: "one index entry is dropped",
    edits: [
      [
        CARRIER_INDEX,
        "new Map(credentials.slice(0, 1).map((entry) => [entry.tokenDigest, entry.principal]))",
        1,
      ],
    ],
    caughtBy: ["A2", "A5"],
    authentication: "authenticated:P1",
  },
  {
    id: "M6",
    direction: "flag",
    field: "digestIndex entry set",
    coverage: "covered",
    note: "the index carries one extra unknown entry; only A2 sees it",
    edits: [
      [
        CARRIER_INDEX,
        'new Map([...credentials.map((entry) => [entry.tokenDigest, entry.principal]), ["deadbeef", "PX"]])',
        1,
      ],
    ],
    caughtBy: ["A2"],
    authentication: "authenticated:P1",
  },
  {
    id: "M7",
    direction: "flag",
    field: "digestIndex type",
    coverage: "covered",
    note: "the index is a plain object instead of a Map",
    edits: [
      [
        CARRIER_SNAPSHOT_RETURN,
        "return Object.freeze({ version: 1, credentials: Object.freeze(credentials), digestIndex: Object.fromEntries(digestIndex) });",
        1,
      ],
    ],
    caughtBy: ["A1", "A2", "A5"],
    authentication: "authenticated:P1",
  },
  {
    id: "F1",
    direction: "flag",
    field: "published principal",
    coverage: "covered",
    note: "the published principal is normalised and the index follows it",
    edits: [["principal: entry.principal,", "principal: entry.principal.toLowerCase(),", 1]],
    caughtBy: ["A3"],
    authentication: "authenticated:p1",
  },
  {
    id: "F2",
    direction: "flag",
    field: "published principal",
    coverage: "covered",
    note: "the published principal is normalised while the index keeps the raw document",
    edits: [
      ["principal: entry.principal,", "principal: entry.principal.toLowerCase(),", 1],
      [CARRIER_INDEX, CARRIER_INDEX_FROM_DOC, 1],
    ],
    caughtBy: ["A3", "A5"],
    authentication: "authenticated:p1",
  },
  {
    id: "F3",
    direction: "flag",
    field: "published tokenDigest",
    coverage: "covered",
    note: "the published digest is re-hashed and the index follows it",
    edits: [["tokenDigest: entry.tokenDigest,", "tokenDigest: hash(entry.tokenDigest),", 1]],
    caughtBy: ["A4", "A5"],
    authentication: "rejected:auth",
  },
  {
    id: "F4",
    direction: "flag",
    field: "published tokenDigest",
    coverage: "covered",
    note:
      "the published digest is re-hashed while the index keeps the raw document: " +
      "the index stays consistent with the file, so only the input anchor sees it",
    edits: [
      ["tokenDigest: entry.tokenDigest,", "tokenDigest: hash(entry.tokenDigest),", 1],
      [CARRIER_INDEX, CARRIER_INDEX_FROM_DOC, 1],
    ],
    caughtBy: ["A4"],
    authentication: "rejected:auth",
  },
  {
    id: "I1",
    direction: "ignore",
    field: "digestIndex insertion order",
    coverage: "inert-control",
    note: "the index is built in reverse order: the carrier does not assert the order",
    edits: [
      [
        CARRIER_INDEX,
        "new Map(credentials.toReversed().map((entry) => [entry.tokenDigest, entry.principal]))",
        1,
      ],
    ],
    caughtBy: [],
    authentication: "authenticated:P1",
  },
  {
    id: "U1",
    direction: "ignore",
    field: "published grant and scopeKey",
    coverage: "declared-unpinned",
    note: "the grant normalisation drops a grant list: a documented derivation the carrier does not pin",
    edits: [
      [
        "const grant = normalizeGrant(entry.grant);",
        "const grant = { ...normalizeGrant(entry.grant), workers: [] };",
        1,
      ],
    ],
    caughtBy: [],
    authentication: "authenticated:P1",
  },
];

function carrierGrant() {
  const grant = emptyGrant();
  grant.workers = ["east:worker:001"];
  grant.inspect.topology = true;
  return grant;
}

// Every file of the published source tree, relative to the tree root.
async function carrierCorpusFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
}

async function carrierFixture(root) {
  const first = credential({ principal: "P1", grant: carrierGrant() });
  const second = credential({ principal: "P2" });
  const path = join(root, "credentials.json");
  await privateFile(path, JSON.stringify({ version: 1, credentials: [first.entry, second.entry] }));
  const registered = JSON.parse(await readFile(path, "utf8")).credentials;
  return { path, registered, token: first.token };
}

function evaluateCarrier(snapshot, registered) {
  const failed = [];
  for (const assertion of CARRIER_ASSERTIONS) {
    let passed = false;
    try {
      passed = assertion.check(snapshot, registered) === true;
    } catch {
      passed = false;
    }
    if (!passed) failed.push(assertion.id);
  }
  return failed;
}

function runCarrierMutant(mutant, fixture) {
  return withTempDir(async (root) => {
    const srcDir = join(root, "src");
    await cp(CARRIER_SOURCE_DIR, srcDir, { recursive: true });
    const sourcePath = join(srcDir, "auth.mjs");
    const original = await readFile(sourcePath, "utf8");
    let mutated = original;
    const applied = [];
    for (const [pattern, replacement, expectedSites] of mutant.edits) {
      const parts = mutated.split(pattern);
      const found = parts.length - 1;
      assert.equal(
        found,
        expectedSites,
        `${mutant.id}: the anchor matched ${found} site(s), expected ${expectedSites}`,
      );
      applied.push(found);
      mutated = parts.join(replacement);
    }
    assert.notEqual(mutated, original, `${mutant.id}: the mutation changed no source text`);
    await writeFile(sourcePath, mutated);
    const mutatedModule = await import(pathToFileURL(sourcePath).href);
    assert.equal(typeof mutatedModule.loadRegistry, "function", `${mutant.id}: loadRegistry`);
    assert.equal(typeof mutatedModule.authenticate, "function", `${mutant.id}: authenticate`);
    const snapshot = await mutatedModule.loadRegistry(fixture.path);
    const failed = evaluateCarrier(snapshot, fixture.registered);
    let authentication;
    try {
      const principal = mutatedModule.authenticate(snapshot, `Bearer ${fixture.token}`);
      authentication = `authenticated:${principal.id}`;
    } catch (error) {
      authentication = `rejected:${error.code ?? "unknown"}`;
    }
    return { failed, authentication, applied };
  });
}

// The census gate. A "flag" case must be caught by at least one assertion (a
// hole is a failing test); an "ignore" case must be caught by none (an
// over-flag is a failing test).
function censusViolations(cases, outcomes) {
  const violations = [];
  for (const item of cases) {
    const outcome = outcomes.get(item.id);
    if (item.direction === "flag") {
      if (outcome.failed.length === 0) {
        violations.push(`hole: ${item.id} moves ${item.field} and no assertion catches it`);
      }
    } else if (outcome.failed.length > 0) {
      violations.push(
        `over-flag: ${item.id} is ${item.direction} and was caught by [${outcome.failed.join(", ")}]`,
      );
    }
  }
  return violations;
}

// The direction of every case is checked against the case's OWN expectation,
// and an unknown label is a hard error, never a fallback to "ignore". This
// runs at load time, so a mislabelled case cannot reach the runner at all.
function assertCarrierTable(cases) {
  for (const item of cases) {
    assertCarrierCase(item);
  }
}

function assertCarrierCase(item) {
  if (!CARRIER_DIRECTIONS.has(item.direction)) {
    throw new Error(
      `case ${item.id} carries the unknown direction label "${item.direction}": the accepted labels are "flag" and "ignore"`,
    );
  }
  const expectedDirection = item.coverage === "covered" ? "flag" : "ignore";
  if (item.direction !== expectedDirection) {
    throw new Error(
      `case ${item.id} is classified "${item.coverage}" but carries the direction "${item.direction}"`,
    );
  }
  if (item.direction === "flag" && item.caughtBy.length === 0) {
    throw new Error(`case ${item.id} is a flag case that expects no assertion to catch it`);
  }
  if (item.direction === "ignore" && item.caughtBy.length > 0) {
    throw new Error(
      `case ${item.id} is an ignore case that expects [${item.caughtBy.join(", ")}] to catch it`,
    );
  }
}

assertCarrierTable(CARRIER_MUTANTS);

test("the published registry snapshot satisfies the digest index carrier and authenticates a valid credential", async () => {
  await withTempDir(async (root) => {
    const fixture = await carrierFixture(root);
    const snapshot = await loadRegistry(fixture.path);
    const failed = evaluateCarrier(snapshot, fixture.registered);
    assert.deepEqual(failed, [], `the carrier failed: ${failed.join(", ")}`);
    const principal = authenticate(snapshot, `Bearer ${fixture.token}`);
    assert.equal(principal.id, "P1");
  });
});

test("every digest index carrier assertion is falsified by a named mutant", async () => {
  await withTempDir(async (root) => {
    const fixture = await carrierFixture(root);
    const results = [];
    for (const mutant of CARRIER_MUTANTS) {
      const run = await runCarrierMutant(mutant, fixture);
      results.push({ mutant, ...run });
    }
    for (const result of results) {
      assert.deepEqual(
        result.failed,
        result.mutant.caughtBy,
        `${result.mutant.id} (${result.mutant.note}) must be caught by [${result.mutant.caughtBy.join(", ")}]`,
      );
      const expected = result.mutant.authentication;
      assert.equal(
        result.authentication,
        expected,
        `${result.mutant.id}: the authentication outcome`,
      );
    }
    const falsified = new Set(results.flatMap((result) => result.failed));
    for (const assertion of CARRIER_ASSERTIONS) {
      assert.ok(
        falsified.has(assertion.id),
        `${assertion.id} is never falsified: the carrier is vacuous there`,
      );
    }
    const unique = new Set(
      results.filter((result) => result.failed.length === 1).map((result) => result.failed[0]),
    );
    for (const id of ["A2", "A3", "A4", "A5"]) {
      assert.ok(unique.has(id), `${id} never uniquely catches a mutant`);
    }
  });
});

test("the digest index carrier's free-field census has no hole", async () => {
  await withTempDir(async (root) => {
    const fixture = await carrierFixture(root);
    const outcomes = new Map();
    for (const mutant of CARRIER_MUTANTS) {
      outcomes.set(mutant.id, await runCarrierMutant(mutant, fixture));
    }
    // The case list and the runner are checked against the same list: the
    // runner's own output carries every case ID and the count, so a case that
    // is added to the table but dropped from the run cannot report green.
    assert.equal(outcomes.size, CARRIER_MUTANTS.length, "the runner processed a different count");
    assert.deepEqual([...outcomes.keys()].sort(), [
      "F1",
      "F2",
      "F3",
      "F4",
      "I1",
      "M1",
      "M2",
      "M3",
      "M4",
      "M6",
      "M7",
      "U1",
    ]);
    const coveredIds = CARRIER_MUTANTS.filter((item) => item.coverage === "covered").map(
      (item) => item.id,
    );
    assert.deepEqual(coveredIds, ["M1", "M2", "M3", "M4", "M6", "M7", "F1", "F2", "F3", "F4"]);
    assert.deepEqual(censusViolations(CARRIER_MUTANTS, outcomes), [], "the census found a hole");
    // The gate is driven by the DIRECTION label, and the label is
    // load-bearing: flipping it must make the gate report a violation.
    const flippedToIgnore = CARRIER_MUTANTS.map((item) =>
      item.id === "M6" ? { ...item, direction: "ignore" } : item,
    );
    assert.ok(
      censusViolations(flippedToIgnore, outcomes).some((entry) => entry.startsWith("over-flag:")),
      "the direction label is not load-bearing: a flipped direction reports no over-flag",
    );
    const flippedToFlag = CARRIER_MUTANTS.map((item) =>
      item.id === "I1" ? { ...item, direction: "flag" } : item,
    );
    assert.ok(
      censusViolations(flippedToFlag, outcomes).some((entry) => entry.startsWith("hole:")),
      "the hole branch is not load-bearing: a hole reports no violation",
    );
    // An unknown direction label is a hard error at load time, never a
    // fallback to the ignore branch.
    for (const label of ["FLAG", "must-flag", "flag ", ""]) {
      assert.throws(
        () =>
          assertCarrierTable([
            { id: "M6", direction: label, coverage: "covered", caughtBy: ["A2"] },
          ]),
        /unknown direction label/,
        `the direction label "${label}" is accepted: the closed set is not enforced`,
      );
    }
    // The descriptive classification and the gate label cannot disagree.
    assert.throws(
      () =>
        assertCarrierTable([{ id: "I1", direction: "ignore", coverage: "covered", caughtBy: [] }]),
      /classified "covered" but carries the direction "ignore"/,
    );
    const covered = new Set(
      CARRIER_MUTANTS.filter((item) => item.coverage === "covered").map((item) => item.field),
    );
    for (const field of [
      "published principal",
      "published tokenDigest",
      "digestIndex values",
      "digestIndex entry set",
      "digestIndex type",
    ]) {
      assert.ok(covered.has(field), `the census does not cover ${field}`);
    }
  });
});

test("a re-hashed published digest is caught by the carrier and stops authentication", async () => {
  await withTempDir(async (root) => {
    const fixture = await carrierFixture(root);
    const snapshot = await loadRegistry(fixture.path);
    const principal = authenticate(snapshot, `Bearer ${fixture.token}`);
    assert.equal(principal.id, "P1");
    for (const id of ["F3", "F4"]) {
      const mutant = CARRIER_MUTANTS.find((entry) => entry.id === id);
      const run = await runCarrierMutant(mutant, fixture);
      assert.ok(
        run.failed.includes("A4"),
        `${id}: the carrier must catch the re-hashed published digest`,
      );
      assert.equal(
        run.authentication,
        "rejected:auth",
        `${id}: the valid bearer token must stop authenticating`,
      );
    }
  });
});

test("the carrier's corpus sweep leaves every published source file parsing", async () => {
  await withTempDir(async (root) => {
    const srcDir = join(root, "src");
    await cp(CARRIER_SOURCE_DIR, srcDir, { recursive: true });
    const corpus = await carrierCorpusFiles(CARRIER_SOURCE_DIR);
    assert.deepEqual(
      await carrierCorpusFiles(srcDir),
      corpus,
      "the copy of the source tree is not the published corpus",
    );
    // The carrier's own operation, applied to the copy.
    const mutant = CARRIER_MUTANTS.find((item) => item.id === "F3");
    const sourcePath = join(srcDir, "auth.mjs");
    const original = await readFile(sourcePath, "utf8");
    let mutated = original;
    for (const [pattern, replacement, expectedSites] of mutant.edits) {
      const parts = mutated.split(pattern);
      const found = parts.length - 1;
      assert.equal(found, expectedSites, `${mutant.id}: the anchor matched ${found} site(s)`);
      mutated = parts.join(replacement);
    }
    assert.notEqual(mutated, original, `${mutant.id}: the mutation changed no source text`);
    await writeFile(sourcePath, mutated);
    // Every file of the corpus still parses after the carrier's operation, and
    // the processed count is the denominator: an exception inside the sweep
    // must never shrink it.
    const files = corpus.filter((rel) => rel.endsWith(".mjs")).map((rel) => join(srcDir, rel));
    const script = `
const { pathToFileURL } = await import("node:url");
const files = process.argv.slice(1);
process.argv[1] = "--carrier-corpus";
let loaded = 0;
for (const file of files) {
  await import(pathToFileURL(file).href);
  loaded += 1;
}
process.stdout.write(String(loaded));
`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, "--", ...files],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, `the corpus sweep failed: ${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      String(files.length),
      "the corpus sweep did not process every file",
    );
  });
});
