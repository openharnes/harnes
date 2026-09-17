import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySessionManager } from "./manager.ts";
import {
  SessionAbortRegistry,
  abortSessionTurn,
  finishSessionTurn,
  startSessionTurn,
} from "./session-turn.ts";

/** Stands in for `runAgentLoop`: resolves after a tick, or rejects/aborts. */
async function fakeTurn(signal: AbortSignal, shouldFail = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      if (shouldFail) reject(new Error("boom"));
      else resolve();
    }, 0);
  });
}

test("startSessionTurn sets status to running; finishSessionTurn(ok) sets it back to idle", async () => {
  const mgr = new InMemorySessionManager();
  const registry = new SessionAbortRegistry();
  const session = mgr.create({ title: "S1" });
  assert.equal(session.status, "idle");

  const signal = startSessionTurn(mgr, registry, session);
  assert.equal(mgr.get(session.id)!.status, "running");
  assert.equal(registry.has(session.id), true);

  await fakeTurn(signal);
  finishSessionTurn(mgr, registry, session, { ok: true });

  assert.equal(mgr.get(session.id)!.status, "idle");
  assert.equal(mgr.get(session.id)!.lastError, undefined);
  assert.equal(registry.has(session.id), false);
});

test("finishSessionTurn(error) sets status to error and records lastError", async () => {
  const mgr = new InMemorySessionManager();
  const registry = new SessionAbortRegistry();
  const session = mgr.create({ title: "S1" });

  const signal = startSessionTurn(mgr, registry, session);
  await fakeTurn(signal, true).catch(() => {});
  finishSessionTurn(mgr, registry, session, { ok: false, error: "boom" });

  const after = mgr.get(session.id)!;
  assert.equal(after.status, "error");
  assert.equal(after.lastError, "boom");
  assert.equal(registry.has(session.id), false);
});

test("a fresh startSessionTurn clears lastError once status leaves error", async () => {
  const mgr = new InMemorySessionManager();
  const registry = new SessionAbortRegistry();
  const session = mgr.create({ title: "S1" });

  mgr.setStatus(session.id, "error", "previous failure");
  assert.equal(mgr.get(session.id)!.lastError, "previous failure");

  startSessionTurn(mgr, registry, session);
  finishSessionTurn(mgr, registry, session, { ok: true });
  assert.equal(mgr.get(session.id)!.status, "idle");
  assert.equal(mgr.get(session.id)!.lastError, undefined);
});

test("abortSessionTurn on one session does not affect another session's controller", async () => {
  const mgr = new InMemorySessionManager();
  const registry = new SessionAbortRegistry();
  const a = mgr.create({ title: "A" });
  const b = mgr.create({ title: "B" });

  const signalA = startSessionTurn(mgr, registry, a);
  const signalB = startSessionTurn(mgr, registry, b);

  const aborted = abortSessionTurn(registry, a.id);
  assert.equal(aborted, true);
  assert.equal(signalA.aborted, true);
  assert.equal(signalB.aborted, false);

  // Session B's turn is unaffected and can still finish normally.
  await fakeTurn(signalB);
  finishSessionTurn(mgr, registry, b, { ok: true });
  assert.equal(mgr.get(b.id)!.status, "idle");

  // Session A's turn observed the abort and reports failure.
  finishSessionTurn(mgr, registry, a, { ok: false, error: "aborted" });
  assert.equal(mgr.get(a.id)!.status, "error");
});

test("abortSessionTurn returns false when nothing is registered for that id", () => {
  const registry = new SessionAbortRegistry();
  assert.equal(abortSessionTurn(registry, "no-such-session"), false);
});

test("abortSessionTurn returns false on a second call once already aborted", () => {
  const mgr = new InMemorySessionManager();
  const registry = new SessionAbortRegistry();
  const session = mgr.create({ title: "S1" });
  startSessionTurn(mgr, registry, session);

  assert.equal(abortSessionTurn(registry, session.id), true);
  assert.equal(abortSessionTurn(registry, session.id), false);
});

test("switching focus away from a running session does not abort or change its status", () => {
  const mgr = new InMemorySessionManager();
  const registry = new SessionAbortRegistry();
  const running = mgr.create({ title: "Running" });
  const signal = startSessionTurn(mgr, registry, running);

  const other = mgr.create({ title: "Other" }); // create() focuses `other`
  assert.equal(mgr.focused().id, other.id);
  mgr.focus(running.id);
  mgr.focus(other.id); // focus back and forth — nothing here should touch abort state

  assert.equal(signal.aborted, false);
  assert.equal(mgr.get(running.id)!.status, "running");
  assert.equal(registry.has(running.id), true);
});

test("startSessionTurn aborts and discards a stale controller left from a previous turn on the same session", async () => {
  const mgr = new InMemorySessionManager();
  const registry = new SessionAbortRegistry();
  const session = mgr.create({ title: "S1" });

  const firstSignal = startSessionTurn(mgr, registry, session);
  // Simulate a prior turn that never reached finishSessionTurn (e.g. caller
  // crashed) before a second turn starts on the same session.
  const secondSignal = startSessionTurn(mgr, registry, session);

  assert.equal(firstSignal.aborted, true);
  assert.equal(secondSignal.aborted, false);
  assert.equal(mgr.get(session.id)!.status, "running");

  finishSessionTurn(mgr, registry, session, { ok: true });
  assert.equal(registry.has(session.id), false);
});
