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

function cachePath(): string {
  return join(homedir(), ".cache", "harnes", "update.json");
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function readCache(): Promise<CacheFile> {
  try {
    return JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

async function writeCache(latest: string, checkedAt: number): Promise<void> {
  const file = cachePath();
  await mkdir(join(homedir(), ".cache", "harnes"), { recursive: true });
  await writeFile(file, `${JSON.stringify({ latest, checkedAt }, null, 2)}\n`, "utf8");
}

export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(REGISTRY_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`npm registry failed (${response.status})`);
  }
  const json = (await response.json()) as { version?: string };
  if (!json.version) throw new Error("npm registry response missing version");
  return json.version;
}

/**
 * Check for a newer published version.
 * Uses a 24h cache unless `force` is set.
 */
export async function checkForUpdate(
  current: string,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<UpdateCheck> {
  const now = Date.now();
  const cache = await readCache();
  let latest = cache.latest;
  let checkedAt = cache.checkedAt ?? 0;

  if (opts.force || !latest || now - checkedAt > CACHE_TTL_MS) {
    latest = await fetchLatestVersion(opts.fetchImpl);
    checkedAt = now;
    await writeCache(latest, checkedAt);
  }

  return {
    current,
    latest,
    updateAvailable: compareSemver(latest, current) > 0,
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
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ ok: false, output: error.message });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

export { compareSemver };
