import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { InMemorySessionManager, createSessionManager } from "./manager.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "harnes-session-manager-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("create() focuses the new session", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  assert.equal(mgr.focused().id, a.id);

  const b = mgr.create({ title: "B" });
  assert.equal(mgr.focused().id, b.id);
  assert.notEqual(a.id, b.id);
});

test("exactly one session is focused at a time", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  const b = mgr.create({ title: "B" });
  mgr.create({ title: "C" });

  mgr.focus(a.id);
  assert.equal(mgr.focused().id, a.id);

  mgr.focus(b.id);
  assert.equal(mgr.focused().id, b.id);
});

test("focus() throws for an unknown id and leaves prior focus intact", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  assert.throws(() => mgr.focus("does-not-exist"));
  assert.equal(mgr.focused().id, a.id);
});

test("focused() throws when nothing has been created yet", () => {
  const mgr = new InMemorySessionManager();
  assert.throws(() => mgr.focused());
});

test("archive() on the focused session reassigns focus to a remaining session", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  const b = mgr.create({ title: "B" });
  // b is focused (most recently created).
  assert.equal(mgr.focused().id, b.id);

  mgr.archive(b.id);
  // Only "a" remains, so focus must move to it.
  assert.equal(mgr.focused().id, a.id);
});

test("archive() on the last remaining session clears focus", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "only" });
  mgr.archive(a.id);
  assert.throws(() => mgr.focused());
  assert.equal(mgr.list().length, 0);
});

test("archive() on a non-focused session does not change focus", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  const b = mgr.create({ title: "B" });
  mgr.focus(a.id);

  mgr.archive(b.id);
  assert.equal(mgr.focused().id, a.id);
  assert.equal(mgr.list().length, 1);
  assert.equal(mgr.list()[0]?.id, a.id);
});

test("archived sessions are excluded from list() and get()", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  mgr.create({ title: "B" });
  mgr.archive(a.id);

  assert.equal(mgr.get(a.id), undefined);
  assert.ok(!mgr.list().some((s) => s.id === a.id));
});

test("archive() is a no-op for an already-archived or unknown id", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  mgr.archive(a.id);
  assert.doesNotThrow(() => mgr.archive(a.id));
  assert.doesNotThrow(() => mgr.archive("unknown-id"));
});

test("list() returns newest-active (updatedAt desc) first", async () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A" });
  await new Promise((r) => setTimeout(r, 2));
  const b = mgr.create({ title: "B" });
  await new Promise((r) => setTimeout(r, 2));
  mgr.update(a.id, { title: "A renamed" }); // bumps a's updatedAt above b's

  const ids = mgr.list().map((s) => s.id);
  assert.deepEqual(ids, [a.id, b.id]);
});

test("update() patches allowed fields and bumps updatedAt", async () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create({ title: "A", cwd: "/tmp" });
  const before = a.updatedAt;
  await new Promise((r) => setTimeout(r, 2));

  const updated = mgr.update(a.id, { title: "Renamed", cwd: "/other", pinnedModelId: "model-x", sessionMode: "plan" });
  assert.equal(updated.title, "Renamed");
  assert.equal(updated.cwd, "/other");
  assert.equal(updated.pinnedModelId, "model-x");
  assert.equal(updated.sessionMode, "plan");
  assert.ok(updated.updatedAt > before);
});

test("update() throws for an unknown id", () => {
  const mgr = new InMemorySessionManager();
  assert.throws(() => mgr.update("nope", { title: "x" }));
});

test("new sessions start idle with empty history/todos and zeroed usage", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create();
  assert.equal(a.status, "idle");
  assert.deepEqual(a.history, []);
  assert.deepEqual(a.todos, []);
  assert.equal(a.usage.turns, 0);
  assert.equal(a.usage.costUsd, 0);
});

test("create() defaults cwd to process.cwd() and sessionMode via normalizeSessionMode", () => {
  const mgr = new InMemorySessionManager();
  const a = mgr.create();
  assert.equal(a.cwd, process.cwd());
  assert.equal(a.sessionMode, "ask"); // normalizeSessionMode(undefined) === "ask"
});

test("save() then load() round-trips sessions, focus, and archive state", async () => {
  await withTempDir(async (dir) => {
    const mgr = new InMemorySessionManager({ persistDir: dir });
    const a = mgr.create({ title: "A", cwd: "/tmp/a" });
    const b = mgr.create({ title: "B", cwd: "/tmp/b" });
    mgr.update(a.id, { pinnedModelId: "model-x", sessionMode: "plan" });
    mgr.archive(b.id); // b archived; focus falls back to a
    await mgr.save();

    const restored = new InMemorySessionManager({ persistDir: dir });
    await restored.load();

    assert.equal(restored.loadWarnings.length, 0);
    assert.equal(restored.focused().id, a.id);
    assert.equal(restored.get(a.id)?.pinnedModelId, "model-x");
    assert.equal(restored.get(a.id)?.sessionMode, "plan");
    // b was archived, so it's excluded from get()/list() but still on disk.
    assert.equal(restored.get(b.id), undefined);
    assert.equal(restored.list().length, 1);

    const onDisk = JSON.parse(await readFile(path.join(dir, `${a.id}.json`), "utf8"));
    assert.equal(onDisk.id, a.id);
    assert.equal(onDisk.pinnedModelId, "model-x");
  });
});

test("load() with no persisted data yet (first run) is a no-op, not a throw", async () => {
  await withTempDir(async (dir) => {
    const mgr = new InMemorySessionManager({ persistDir: path.join(dir, "does-not-exist-yet") });
    await assert.doesNotReject(() => mgr.load());
    assert.equal(mgr.loadWarnings.length, 0);
    assert.equal(mgr.list().length, 0);
  });
});

test("load() skips a corrupt session file and still restores the valid ones", async () => {
  await withTempDir(async (dir) => {
    const mgr = new InMemorySessionManager({ persistDir: dir });
    const a = mgr.create({ title: "A" });
    mgr.create({ title: "B" });
    await mgr.save();

    // Corrupt one of the two session files after saving.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, `${a.id}.json`), "{ this is not valid json", "utf8");

    const restored = new InMemorySessionManager({ persistDir: dir });
    await restored.load();

    assert.equal(restored.list().length, 1);
    assert.equal(restored.get(a.id), undefined);
    assert.ok(restored.loadWarnings.length >= 1);
    assert.match(restored.loadWarnings[0]!, /corrupt/i);
  });
});

test("createSessionManager(options) accepts a persistDir and save()/load() work through it", async () => {
  await withTempDir(async (dir) => {
    const mgr = createSessionManager({ persistDir: dir });
    mgr.create({ title: "Only" });
    await assert.doesNotReject(() => mgr.save());
    await assert.doesNotReject(() => mgr.load());
    assert.equal(mgr.list().length, 1);
  });
});

test("new default-titled sessions after load() do not collide with restored ordinals", async () => {
  await withTempDir(async (dir) => {
    const mgr = new InMemorySessionManager({ persistDir: dir });
    mgr.create(); // "Session 1"
    mgr.create(); // "Session 2"
    await mgr.save();

    const restored = new InMemorySessionManager({ persistDir: dir });
    await restored.load();
    const c = restored.create(); // should not collide with "Session 1"/"Session 2"
    assert.equal(c.title, "Session 3");
  });
});
