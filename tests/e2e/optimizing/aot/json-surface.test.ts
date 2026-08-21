import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

describe("AOT JSON.stringify", () => {
  itRunsPe("spells the scalars a literal holds", () => {
    agrees(
      src(
        "print(JSON.stringify({ id: 1, rate: 1.5, active: true }))",
        "print(JSON.stringify(7))",
        'print(JSON.stringify("plain"))',
      ),
    );
  });

  itRunsPe("escapes what JSON reserves", () => {
    agrees(
      src(
        `print(JSON.stringify({ quoted: 'a"b' }))`,
        'print(JSON.stringify("line\\nbreak"))',
        'print(JSON.stringify("tab\\there"))',
      ),
    );
  });

  itRunsPe("spells an array and an array a field holds", () => {
    agrees(
      src(
        "print(JSON.stringify([1, 2, 3]))",
        'print(JSON.stringify(["a", "b"]))',
        'print(JSON.stringify({ id: 1, tags: ["a", "b"] }))',
        "print(JSON.stringify([]))",
      ),
    );
  });

  itRunsPe("spells a class instance the same way", () => {
    agrees(
      src(
        "class Point:",
        "  public x: int",
        "  public y: int",
        "  public constructor(x: int, y: int):",
        "    this.x = x",
        "    this.y = y",
        "print(JSON.stringify(Point(3, 4)))",
      ),
    );
  });
});
