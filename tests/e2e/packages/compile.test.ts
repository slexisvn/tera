import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../../../src/cli/main.js";
import { hostBackendId } from "../../../src/optimizing/backends/host.js";

const FIXTURE = fileURLToPath(new URL("./fixture", import.meta.url));
const ENTRY = path.join(FIXTURE, "src", "main.tera");
const OUTPUT = "{body: GET /status}";
const EXECUTABLE_SUFFIX = process.platform === "win32" ? ".exe" : "";

const itBuildsNatively = it.skipIf(hostBackendId() === null);

async function inWorkspace(use: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tera-packages-compile-"));
  const error = console.error;
  console.error = () => {};
  try {
    await use(directory);
  } finally {
    console.error = error;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("tera compile", () => {
  itBuildsNatively("builds a binary that runs the installed package's code", async () => {
    await inWorkspace(async (directory) => {
      const binary = path.join(directory, `app${EXECUTABLE_SUFFIX}`);

      expect(await main(["compile", ENTRY, "-o", binary])).toBe(0);

      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 30_000 });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(OUTPUT);
    });
  });

  it("compiles the installed package into the emitted source", async () => {
    await inWorkspace(async (directory) => {
      expect(await main(["compile", ENTRY, "--emit=source", "-o", directory])).toBe(0);

      const emitted = fs
        .readdirSync(directory)
        .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
        .join("\n");
      expect(emitted).toContain("GET ");
      expect(emitted).toContain("{body: ");
    });
  });
});
