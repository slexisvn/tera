import { opcodesOf } from "./deopt-link";
import type { Stage } from "../types/stage";

const IMPORT = 'import { describe, expect, it } from "vitest";';
const HELPER = 'import { afterNamedPass } from "../../helpers/ir-text.js";';
const ASSERTIONS = 4;

type Opcodes = ReadonlyMap<string, string>;

function quote(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function linesOf(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

const DEFINES = /^(v\d+) = /;

function goneLines(before: string, after: string, now: Opcodes): readonly string[] {
  const kept = new Set(linesOf(after));
  const dropped = linesOf(before).filter((line) => !kept.has(line) && DEFINES.test(line));
  const vanished = dropped.filter((line) => !now.has(DEFINES.exec(line)![1]!));
  return vanished.length > 0 ? vanished : dropped;
}

function freshOpcodes(was: Opcodes, now: Opcodes): readonly string[] {
  const known = new Set(was.values());
  const grown = new Set<string>();
  for (const [id, opcode] of now) {
    if (!was.has(id) && !known.has(opcode)) grown.add(opcode);
  }
  return [...grown];
}

function exactly(pass: string, after: string): readonly string[] {
  return [`    expect(afterNamedPass(BEFORE, "${pass}")).toBe(\`${quote(after)}\`);`];
}

function roughly(
  pass: string,
  gone: readonly string[],
  grown: readonly string[],
): readonly string[] {
  return [
    `    const after = afterNamedPass(BEFORE, "${pass}");`,
    "",
    ...gone
      .slice(0, ASSERTIONS)
      .map((line) => `    expect(after).not.toContain(${JSON.stringify(line)});`),
    ...grown
      .slice(0, ASSERTIONS)
      .map((opcode) => `    expect(after).toContain(${JSON.stringify(opcode)});`),
  ];
}

export function fixtureFor(stage: Stage, previous: Stage | null): string | null {
  if (stage.kind !== "ir" || stage.passName === null || previous === null) return null;
  const pass = stage.passName;
  const was = opcodesOf(previous.text);
  const now = opcodesOf(stage.text);
  const minted = [...now.keys()].some((id) => !was.has(id));
  const gone = goneLines(previous.text, stage.text, now);
  const grown = freshOpcodes(was, now);
  const stable = !minted || (gone.length === 0 && grown.length === 0);

  return [
    IMPORT,
    HELPER,
    "",
    `describe("${pass} on ${stage.owner}", () => {`,
    `  const BEFORE = \`${quote(previous.text)}\`;`,
    "",
    `  it("${stage.changed ? "rewrites" : "leaves alone"} the graph the visualizer showed", () => {`,
    ...(stable ? exactly(pass, stage.text) : roughly(pass, gone, grown)),
    "  });",
    "});",
    "",
  ].join("\n");
}
