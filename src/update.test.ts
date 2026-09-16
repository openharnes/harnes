import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkForUpdate, compareSemver, fetchLatestVersion } from "./update.ts";

describe("update", () => {
  it("compares semver", () => {
    assert.ok(compareSemver("0.2.0", "0.1.9") > 0);
    assert.ok(compareSemver("0.1.9", "0.2.0") < 0);
    assert.equal(compareSemver("0.2.0", "0.2.0"), 0);
  });

  it("detects an available update from the registry payload", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ version: "9.9.9" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const latest = await fetchLatestVersion(fetchImpl as typeof fetch);
    assert.equal(latest, "9.9.9");
    const check = await checkForUpdate("0.2.0", { force: true, fetchImpl: fetchImpl as typeof fetch });
    assert.equal(check.latest, "9.9.9");
    assert.equal(check.updateAvailable, true);
  });
});
