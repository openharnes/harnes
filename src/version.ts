import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string; name?: string };

/** Always matches package.json so /status and update checks cannot drift. */
export const HARNES_VERSION: string = pkg.version ?? "0.0.0";
export const HARNES_PACKAGE_NAME: string = pkg.name ?? "@openharnes/harnes";
