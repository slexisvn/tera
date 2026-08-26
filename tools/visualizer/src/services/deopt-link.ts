import type { DeoptOrigin, Stage } from "../types/stage";

export type DeoptMatch = "node" | "line" | "retired" | "graph";

export type DeoptTarget = {
  readonly stageId: string;
  readonly node: string | null;
  readonly line: number | null;
  readonly match: DeoptMatch;
};

const DEFINITION = /^\s*(v\d+)\s*=\s*([A-Za-z][A-Za-z0-9_]*)/;

export function opcodesOf(text: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = DEFINITION.exec(line);
    if (match !== null) found.set(match[1]!, match[2]!);
  }
  return found;
}

export function guardOf(origin: DeoptOrigin): string | null {
  if (origin.node !== null) return origin.node;
  return origin.candidates.length === 1 ? origin.candidates[0]! : null;
}

function ownedGraphs(stages: readonly Stage[], owner: string): readonly Stage[] {
  const mine = stages.filter((stage) => stage.kind === "ir" && stage.owner === owner);
  return [
    ...mine.filter((stage) => stage.group !== "executed"),
    ...mine.filter((stage) => stage.group === "executed"),
  ];
}

function atLine(stage: Stage, line: number, opcode: string | null): readonly string[] {
  const opcodes = opcodesOf(stage.text);
  return Object.keys(stage.positions).filter(
    (key) =>
      stage.positions[key] === line && (opcode === null || opcodes.get(key) === opcode),
  );
}

export function targetForDeopt(
  stages: readonly Stage[],
  origin: DeoptOrigin,
): DeoptTarget | null {
  const graphs = ownedGraphs(stages, origin.owner);
  if (graphs.length === 0) return null;
  const guard = guardOf(origin);

  for (let at = graphs.length - 1; at >= 0; at--) {
    const stage = graphs[at]!;
    if (guard === null) break;
    if (origin.opcode !== null && opcodesOf(stage.text).get(guard) !== origin.opcode) continue;
    if (origin.opcode === null && !opcodesOf(stage.text).has(guard)) continue;
    return {
      stageId: stage.id,
      node: guard,
      line: stage.positions[guard] ?? origin.line,
      match: "node",
    };
  }

  const last = graphs[graphs.length - 1]!;
  if (origin.line !== null) {
    const here = atLine(last, origin.line, origin.opcode);
    if (here.length === 1) {
      return { stageId: last.id, node: here[0]!, line: origin.line, match: "line" };
    }
  }
  const retired =
    origin.opcode !== null && ![...opcodesOf(last.text).values()].includes(origin.opcode);
  return {
    stageId: last.id,
    node: null,
    line: origin.line,
    match: retired ? "retired" : "graph",
  };
}
