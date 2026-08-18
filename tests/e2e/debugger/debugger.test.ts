import { describe, expect, it } from "vitest";
import { Engine, TeraDebugSession } from "../../../src/index.js";
import { DebugController } from "../../../src/debugger/index.js";
import type { DebugCommand, DebugPauseEvent } from "../../../src/debugger/index.js";

const SOURCE_NAME = "debugger-test.tera";

function runWithCommands(
  source: string,
  commands: DebugCommand[],
  configure: (controller: DebugController) => void,
): DebugPauseEvent[] {
  const pauses: DebugPauseEvent[] = [];
  const controller = new DebugController({
    onPause: (event) => {
      pauses.push(event);
      return commands.shift() ?? "continue";
    },
  });
  configure(controller);
  new Engine({ typecheck: "off", debugger: controller }).runNative(source, {
    sourceName: SOURCE_NAME,
  });
  return pauses;
}

describe("Tera debugger", () => {
  it("records source locations on emitted bytecode", () => {
    const compiled = new Engine({ typecheck: "off" }).compile(
      "x: int = 1\nx + 2",
      { sourceName: SOURCE_NAME },
    );
    expect(compiled.sourceMap.some((entry) =>
      entry?.sourceName === SOURCE_NAME &&
      entry.line === 1 &&
      typeof entry.column === "number",
    )).toBe(true);
    expect(compiled.sourceMap.some((entry) =>
      entry?.sourceName === SOURCE_NAME && entry.line === 2,
    )).toBe(true);
  });

  it("pauses on line breakpoints and snapshots locals", () => {
    const pauses = runWithCommands(
      "x: int = 1\ny: int = x + 2\ny + 3",
      ["continue"],
      (controller) => controller.setBreakpoint({ sourceName: SOURCE_NAME, line: 2 }),
    );
    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.reason).toBe("breakpoint");
    expect(pauses[0]!.location.line).toBe(2);
    const frame = pauses[0]!.snapshot.frames.at(-1)!;
    expect(frame.locals.find((local) => local.name === "x")?.value.display).toBe("1");
  });

  it("snapshots globals for debugger watches", () => {
    const pauses = runWithCommands(
      "add10 = 10\nnums = [1, 2, 3]\nadd10",
      ["continue"],
      (controller) => controller.setBreakpoint({ sourceName: SOURCE_NAME, line: 3 }),
    );
    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.snapshot.globals.find((item) => item.name === "add10")?.value.display).toBe("10");
    const nums = pauses[0]!.snapshot.globals.find((item) => item.name === "nums");
    expect(nums?.value.children?.find((child) => child.name === "length")?.value.raw).toBe(3);
  });

  it("steps over calls without pausing inside the callee", () => {
    const pauses = runWithCommands(
      [
        "fn inc(v):",
        "  next: int = v + 1",
        "  return next",
        "x: int = 1",
        "y: int = inc(x)",
        "y",
      ].join("\n"),
      ["stepOver", "continue"],
      (controller) => controller.setBreakpoint({ sourceName: SOURCE_NAME, line: 5 }),
    );
    expect(pauses.map((event) => event.location.line)).toEqual([5, 6]);
  });

  it("does not re-hit a continued breakpoint after returning from a callee on the same line", () => {
    const pauses = runWithCommands(
      [
        "fn inc(v):",
        "  return v + 1",
        "x: int = 1",
        "y: int = inc(x)",
        "y",
      ].join("\n"),
      ["continue"],
      (controller) => controller.setBreakpoint({ sourceName: SOURCE_NAME, line: 4 }),
    );
    expect(pauses.map((event) => event.location.line)).toEqual([4]);
  });

  it("offers a session wrapper that records pause events", () => {
    const session = new TeraDebugSession({
      typecheck: "off",
      onPause: () => "continue",
    });
    session.controller.setBreakpoint({ sourceName: SOURCE_NAME, line: 1 });
    expect(session.runNative("x: int = 7\nx", { sourceName: SOURCE_NAME })).toBe(7);
    expect(session.pauses).toHaveLength(1);
    session.dispose();
  });
});
