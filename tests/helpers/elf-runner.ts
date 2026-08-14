import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

export interface ElfRun {
  readonly status: number | null;
  readonly stdout: string;
}

type Launcher = (path: string, input: string) => ElfRun;

function inRunDirectory<T>(use: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "tera-elf-"));
  try {
    return use(join(directory, "program.elf"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const nativeLauncher: Launcher = (path, input) => {
  chmodSync(path, 0o755);
  const run = spawnSync(path, [], { input, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout ?? "" };
};

const wslLauncher: Launcher = (path, input) => {
  const translated = spawnSync("wsl.exe", ["-e", "wslpath", "-a", path], {
    encoding: "utf8",
  });
  if (translated.status !== 0) return { status: null, stdout: "" };
  const target = translated.stdout.trim();
  spawnSync("wsl.exe", ["-e", "chmod", "+x", target], { encoding: "utf8" });
  const run = spawnSync("wsl.exe", ["-e", target], { input, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout ?? "" };
};

function detect(): Launcher | null {
  if (process.platform === "linux" && process.arch === "x64") return nativeLauncher;
  const probe = spawnSync("wsl.exe", ["-e", "uname", "-m"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() === "x86_64") return wslLauncher;
  return null;
}

export const elfLauncher = detect();

export const itRunsElf = it.skipIf(elfLauncher === null);

export function runElf(image: Uint8Array, input = ""): ElfRun {
  if (elfLauncher === null) throw new Error("no launcher can run a linux elf here");
  return inRunDirectory((path) => {
    writeFileSync(path, image);
    return elfLauncher(path, input);
  });
}
