import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cCompiler, cSource, itNative } from "../../../helpers/c-executor.js";
import {
  CFGFunction,
  irConstant,
  irBranch,
  irFloat64Add,
  irFloat64Compare,
  irCallKnownFunction,
  irReturn,
  resetIRNodeIds,
} from "../../../../src/optimizing/ir/index.js";
import { link } from "../../../../src/optimizing/ir/cfg-edit.js";
import { moduleFromGraphs } from "../../../../src/optimizing/compilation-unit.js";
import { compileModule, type AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { writeAotProgram } from "../../../../src/optimizing/drivers/write.js";
import { cBackend } from "../../../../src/optimizing/backends/c/backend.js";

beforeEach(() => resetIRNodeIds());

function addOne(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["float"], names: ["value"], returns: "float" };
  const p0 = graph.addParameter(0);
  const entry = graph.addBlock();
  const zero = irConstant(0);
  const negative = irFloat64Compare("<", p0, zero);
  const raised = graph.addBlock();
  const kept = graph.addBlock();
  entry.addNode(zero);
  entry.addNode(negative);
  entry.addNode(irBranch(negative, raised, kept));
  link(entry, raised);
  link(entry, kept);
  raised.addNode(irReturn(zero));
  const one = irConstant(1);
  const sum = irFloat64Add(p0, one);
  kept.addNode(one);
  kept.addNode(sum);
  kept.addNode(irReturn(sum));
  graph.rebuildUses();
  return graph;
}

function callsAddOne(name: string, calleeName: string): CFGFunction {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  const arg = irConstant(41);
  const call = irCallKnownFunction({ name: calleeName } as never, [arg]);
  block.addNode(arg);
  block.addNode(call);
  block.addNode(irReturn(call));
  return graph;
}

function runNative(program: AotProgram, entry: string): number {
  const dir = mkdtempSync(join(tmpdir(), "tera-call-"));
  try {
    writeAotProgram(program, dir);
    writeFileSync(
      join(dir, "main.c"),
      `#include <stdio.h>\n#include "program.h"\nint main(void){printf("%.17g\\n", ${entry}());return 0;}\n`,
    );
    const exe = join(dir, "prog.exe");
    const build = spawnSync(cCompiler!, [join(dir, "program.c"), join(dir, "main.c"), "-o", exe, "-lm"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (build.status !== 0) throw new Error(`compile failed: ${build.stderr}`);
    const run = spawnSync(exe, [], { encoding: "utf8" });
    return Number(run.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("C backend function calls", () => {
  it("emits a direct call to a known function", () => {
    const program = compileModule(
      moduleFromGraphs([callsAddOne("use_add", "add_one"), addOne("add_one")], "calls"),
      cBackend,
    );

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.emitted.symbol)).toEqual(["use_add", "add_one"]);
    expect(cSource(program)).toContain("add_one(");
  });

  it("skips a call whose target has no resolvable name", () => {
    const graph = new CFGFunction("bad_call");
    const block = graph.addBlock();
    const arg = irConstant(1);
    const call = irCallKnownFunction({} as never, [arg]);
    block.addNode(arg);
    block.addNode(call);
    block.addNode(irReturn(call));

    const program = compileModule(moduleFromGraphs([graph], "bad"), cBackend);
    expect(program.compiled).toEqual([]);
    expect(program.skipped[0]!.reason).toContain("resolvable name");
  });

  itNative("links and runs the call natively", () => {
    const program = compileModule(
      moduleFromGraphs([callsAddOne("use_add", "add_one"), addOne("add_one")], "calls"),
      cBackend,
    );
    expect(runNative(program, "use_add")).toBe(42);
  });
});
