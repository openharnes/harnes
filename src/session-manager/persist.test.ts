import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  saveSessionsToDisk,
  loadSessionsFromDisk,
  deleteSessionFile,
  defaultSessionsDir,
  type SessionSnapshot,
} from "./persist.ts";
import { freshUsage, type HarnesSession } from "./types.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "harnes-persist-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeSession(id: string, overrides: Partial<HarnesSession> = {}): HarnesSession {
  const now = Date.now();
  return {
    id,
    title: `Session ${id}`,
    cwd: "/tmp",
    sessionMode: "ask",
    history: [],
    todos: [],
    usage: freshUsage(),
    createdAt: now,
    updatedAt: now,
    status: "idle",
    ...overrides,
  };
}

test("defaultSessionsDir() resolves under ~/.config/harnes/sessions (XDG-style, not ~/.harnes)", () => {
  const dir = defaultSessionsDir();
  assert.ok(dir.includes(path.join(".config", "harnes", "sessions")));
  assert.ok(!dir.includes(path.join(".harnes", "sessions")));
});

test("saveSessionsToDisk() then loadSessionsFromDisk() round-trips plain data", async () => {
  await withTempDir(async (dir) => {
    const snapshot: SessionSnapshot = {
      sessions: [fakeSession("a"), fakeSession("b", { pinnedModelId: "model-x" })],
      archivedIds: ["b"],
      focusedId: "a",
    };
    await saveSessionsToDisk(dir, snapshot);

    const result = await loadSessionsFromDisk(dir);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.sessions.length, 2);
    assert.equal(result.focusedId, "a");
    assert.deepEqual(result.archivedIds, ["b"]);
    assert.equal(result.sessions.find((s) => s.id === "b")?.pinnedModelId, "model-x");
  });
});

test("loadSessionsFromDisk() on a missing directory returns empty result with no warnings (first run)", async () => {
  await withTempDir(async (dir) => {
    const result = await loadSessionsFromDisk(path.join(dir, "nope"));
    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.archivedIds, []);
    assert.equal(result.focusedId, undefined);
    assert.deepEqual(result.warnings, []);
  });
});

test("loadSessionsFromDisk() skips a corrupt session file but keeps valid ones", async () => {
  await withTempDir(async (dir) => {
    await saveSessionsToDisk(dir, { sessions: [fakeSession("good")], archivedIds: [] });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "bad.json"), "not json at all {{{", "utf8");

    const result = await loadSessionsFromDisk(dir);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]?.id, "good");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /bad\.json/);
  });
});

test("loadSessionsFromDisk() skips a JSON file that doesn't look like a HarnesSession", async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "notasession.json"), JSON.stringify({ foo: "bar" }), "utf8");

    const result = await loadSessionsFromDisk(dir);
    assert.equal(result.sessions.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /does not look like a HarnesSession/);
  });
});

test("loadSessionsFromDisk() tolerates a corrupt index.json and still loads sessions", async () => {
  await withTempDir(async (dir) => {
    await saveSessionsToDisk(dir, { sessions: [fakeSession("a")], archivedIds: [], focusedId: "a" });
    await writeFile(path.join(dir, "index.json"), "{{{ corrupt", "utf8");

    const result = await loadSessionsFromDisk(dir);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.focusedId, undefined); // index was unreadable, so no focus info
    assert.ok(result.warnings.some((w) => w.includes("index.json")));
  });
});

test("no secrets: a saved session file never contains an apiKey/token-shaped field", async () => {
  await withTempDir(async (dir) => {
    await saveSessionsToDisk(dir, { sessions: [fakeSession("a")], archivedIds: [] });
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.join(dir, "a.json"), "utf8");
    assert.doesNotMatch(raw.toLowerCase(), /apikey|api_key|"token"|secret/);
  });
});

test("deleteSessionFile() removes a session file and is a no-op if already missing", async () => {
  await withTempDir(async (dir) => {
    await saveSessionsToDisk(dir, { sessions: [fakeSession("a")], archivedIds: [] });
    await deleteSessionFile(dir, "a");
    const result = await loadSessionsFromDisk(dir);
    assert.equal(result.sessions.length, 0);
    await assert.doesNotReject(() => deleteSessionFile(dir, "a"));
  });
});
