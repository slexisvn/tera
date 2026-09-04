import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irInt32Compare,
  irReturn,
  irSelect,
  resetIRNodeIds,
  IR_PHI,
  IR_SELECT,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AOT_OPCODES } from "../../../src/optimizing/analyses/aot-legality.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { PassManager } from "../../../src/optimizing/infra/pass-manager.js";
import { createAnalysisRegistry } from "../../../src/optimizing/analyses/index.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import { capabilitySet, type Capability } from "../../../src/optimizing/target/capabilities.js";
import { defaultMachineReprOf, type TargetModel } from "../../../src/optimizing/target/model.js";
import { proveOrGeneric } from "../../../src/optimizing/target/speculation.js";
import { targetLegalizationPipeline } from "../../../src/optimizing/target/legalization.js";

beforeEach(() => resetIRNodeIds());

const OPERATION_LEGALIZATION = "operation-legalization";

const EMITS_SELECT: ReadonlySet<string> = new Set([...AOT_OPCODES, IR_SELECT]);

const INTEGER_ARMS: readonly [number, number] = [2, 1];
const FLOAT_ARMS: readonly [number, number] = [2.5, 1.5];

function targetSelecting(...capabilities: Capability[]): TargetModel {
  return {
    name: capabilities.join("+"),
    capabilities: capabilitySet(...capabilities),
    speculation: proveOrGeneric,
    abi: null,
    machineReprOf: defaultMachineReprOf,
  };
}

function chooses(arms: readonly [number, number], returns: string): CFGFunction {
  const graph = new CFGFunction("clamped");
  graph.declaredSignature = { params: ["int"], names: ["n"], returns };
  const n = graph.addParameter(0);
  const entry = graph.addBlock();

  const zero = entry.addNode(irConstant(0));
  const negative = entry.addNode(irInt32Compare("<", n, zero));
  const whenTrue = entry.addNode(irConstant(arms[0]));
  const whenFalse = entry.addNode(irConstant(arms[1]));
  entry.addNode(irReturn(entry.addNode(irSelect(negative, whenTrue, whenFalse))));

  graph.emits = EMITS_SELECT;
  graph.rebuildUses();
  return graph;
}

const choosesAnInteger = (): CFGFunction => chooses(INTEGER_ARMS, "int");
const choosesAFloat = (): CFGFunction => chooses(FLOAT_ARMS, "float");

function legalize(graph: CFGFunction, target: TargetModel): void {
  const options = compilerOptions();
  const pass = targetLegalizationPipeline(target, options).find(
    (candidate) => candidate.name === OPERATION_LEGALIZATION,
  );
  if (pass === undefined) throw new Error(`no ${OPERATION_LEGALIZATION} pass in the pipeline`);
  new PassManager(new AnalysisManager(graph, createAnalysisRegistry()), options).run(graph, [
    pass,
  ]);
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const countOf = (graph: CFGFunction, type: string): number =>
  nodesOf(graph).filter((node) => node.type === type).length;

describe("the legalization pipeline asks the target which values it can select", () => {
  it("expands a float select on a target that selects only integers", () => {
    const graph = choosesAFloat();

    legalize(graph, targetSelecting("select-integer"));

    expect(countOf(graph, IR_SELECT)).toBe(0);
    expect(countOf(graph, IR_PHI)).toBe(1);
  });

  it("keeps an integer select on that same target", () => {
    const graph = choosesAnInteger();

    legalize(graph, targetSelecting("select-integer"));

    expect(countOf(graph, IR_SELECT)).toBe(1);
    expect(countOf(graph, IR_PHI)).toBe(0);
  });

  it("keeps a float select on a target that selects floats too", () => {
    const graph = choosesAFloat();

    legalize(graph, targetSelecting("select-integer", "select-float"));

    expect(countOf(graph, IR_SELECT)).toBe(1);
    expect(countOf(graph, IR_PHI)).toBe(0);
  });

  it("expands an integer select on a target that selects neither", () => {
    const graph = choosesAnInteger();

    legalize(graph, targetSelecting());

    expect(countOf(graph, IR_SELECT)).toBe(0);
    expect(countOf(graph, IR_PHI)).toBe(1);
  });
});
