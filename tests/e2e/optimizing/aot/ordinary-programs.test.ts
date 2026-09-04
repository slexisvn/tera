import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { peAgrees } from "../../../helpers/aot-agreement.js";

const PROGRAMS = ["bfs-shortest-path", "rpn-calculator", "matrix-multiply"] as const;

function sourceOf(name: string): string {
  const text = readFileSync(
    fileURLToPath(new URL(`./sources/${name}.tera`, import.meta.url)),
    "utf8",
  );
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

function refused(source: string): string[] {
  try {
    nodeEngine({ typecheck: "strict" }).compile(`${source}\n`);
    return [];
  } catch (error) {
    return [(error as Error).message];
  }
}

describe("ordinary programs compiled ahead of time", () => {
  for (const name of PROGRAMS) {
    it(`${name} passes the strict check the compiler runs`, () => {
      expect(refused(sourceOf(name))).toEqual([]);
    });

    itRunsPe(`${name} prints what the interpreter prints`, () => {
      peAgrees(sourceOf(name));
    });
  }
});
