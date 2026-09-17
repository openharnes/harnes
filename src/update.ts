import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const NPM_PACKAGE = "@openharnes/harnes";
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheck {
  current: string;
  latest: string;
  updateAvailable: boolean;
  checkedAt: number;
}

interface CacheFile {
  latest?: string;
  checkedAt?: number;
}

function cachePath(override?: string): string {
  if (override) return override;
  if (process.env.HARNES_UPDATE_CACHE) return process.env.HARNES_UPDATE_CACHE;
  return join(homedir(), ".cache", "harnes", "update.json");
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const cleaned = v.replace(/^v/, "");
    const [core, pre = ""] = cleaned.split("-", 2);
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { parts, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  // No prerelease > any prerelease (1.0.0 > 1.0.0-rc.1)
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre < pb.pre ? -1 : 1;
}

async function readCache(path: string): Promise<CacheFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

async function writeCache(path: string, latest: string, checkedAt: number): Promise<void> {
  const { dirname, join: pathJoin } = await import("node:path");
  const { rename } = await import("node:fs/promises");
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = pathJoin(dir, `.update.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ latest, checkedAt }, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`npm registry failed (${response.status})`);
    }
    const json = (await response.json()) as { version?: string };
    if (!json.version) throw new Error("npm registry response missing version");
    return json.version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check for a newer published version.
 * Uses a 24h cache unless `force` is set.
 * Pass `cachePath` (or `HARNES_UPDATE_CACHE`) so tests never touch ~/.cache/harnes.
 */
export async function checkForUpdate(
  current: string,
  opts: { force?: boolean; fetchImpl?: typeof fetch; cachePath?: string } = {}
): Promise<UpdateCheck> {
  const now = Date.now();
  const path = cachePath(opts.cachePath);
  const cache = await readCache(path);
  let latest = cache.latest;
  let checkedAt = cache.checkedAt ?? 0;

  if (opts.force || !latest || now - checkedAt > CACHE_TTL_MS) {
    latest = await fetchLatestVersion(opts.fetchImpl);
    checkedAt = now;
    await writeCache(path, latest, checkedAt);
  }

  return {
    current,
    latest: latest!,
    updateAvailable: compareSemver(latest!, current) > 0,
    checkedAt,
  };
}

/** Install latest from npm into the global prefix. */
export function applyUpdate(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "-g", NPM_PACKAGE], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    let settled = false;
    const finish = (ok: boolean, text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: text.trim() });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000);
      finish(false, output + "\n(npm install timed out after 120s)");
    }, 120_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      finish(false, error.message);
    });
    child.on("close", (code) => {
      finish(code === 0, output);
    });
  });
}

export { compareSemver };
