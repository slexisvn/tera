import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export function canonicalPath(filePath: string): string {
  const absolute = resolve(filePath);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function pathKey(filePath: string): string {
  const canonical = canonicalPath(filePath);
  return CASE_INSENSITIVE ? canonical.toLowerCase() : canonical;
}

export function pathOfUri(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    return canonicalPath(fileURLToPath(uri));
  } catch {
    return null;
  }
}

export function uriOfPath(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}
