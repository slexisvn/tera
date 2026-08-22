import { spawnSync } from "node:child_process";
import { removeDirectory } from "./workspace.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { runsOwnBackends } from "./native-tier.js";

export interface PeRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function inRunDirectory<T>(use: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "tera-pe-"));
  try {
    return use(join(directory, "program.exe"));
  } finally {
    removeDirectory(directory);
  }
}

export const runsWindowsPrograms =
  runsOwnBackends && process.platform === "win32" && process.arch === "x64";

export const itRunsPe = it.skipIf(!runsWindowsPrograms);

export function runPe(image: Uint8Array, input = ""): PeRun {
  if (!runsWindowsPrograms) throw new Error("no launcher can run a windows exe here");
  return inRunDirectory((path) => {
    writeFileSync(path, image);
    const run = spawnSync(path, [], { input, encoding: "utf8" });
    if (run.error !== undefined) throw run.error;
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  });
}
