import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_URL_PATTERN = /^file:/i;
const VARIABLE_PATTERN = /\$\{[^}]+\}/;

export function hasUnresolvedVariablePath(path: string | null | undefined): boolean {
  return typeof path === "string" && VARIABLE_PATTERN.test(path);
}

export function normalizeDebugPath(path: string | null | undefined, cwd?: string | null): string {
  if (!path) return "";
  const filePath = FILE_URL_PATTERN.test(path) ? fileURLToPath(path) : path;
  const resolved = isAbsolute(filePath)
    ? normalize(filePath)
    : normalize(resolve(cwd || process.cwd(), filePath));
  if (!existsSync(resolved)) return resolved;
  return realpathSync.native(resolved);
}
