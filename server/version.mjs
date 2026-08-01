import { readFileSync } from "node:fs";

export const SUPPORTED_NODE_RANGE = ">=22.23.1 <23 || >=24.18.0 <25";

function parseNodeVersion(value) {
  const match = String(value).match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(version, minimum) {
  for (let index = 0; index < version.length; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }
  return true;
}

export function isSupportedNodeVersion(value) {
  const version = parseNodeVersion(value);
  if (!version) return false;
  if (version[0] === 22) return atLeast(version, [22, 23, 1]);
  if (version[0] === 24) return atLeast(version, [24, 18, 0]);
  return false;
}

export function assertSupportedNodeVersion(value = process.versions.node) {
  if (!isSupportedNodeVersion(value)) {
    throw new Error(
      `VECTOR requires Node.js ${SUPPORTED_NODE_RANGE}; received ${String(value)}.`,
    );
  }
}

export const APP_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
