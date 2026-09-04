import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irJump,
  irReturn,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, connect, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import type { TypeInference } from "../../../src/optimizing/analyses/type-inference.js";
import {
  ABSENCE_VALUES,
  absenceTextOf,
  absenceValueOf,
  declaredAbsenceText,
  NULL_TEXT,
  referenceAbsenceTextOf,
  UNDEFINED_TEXT,
} from "../../../src/optimizing/metadata/printed-values.js";

beforeEach(() => resetIRNodeIds());

const HOLDER = "Held";

const holderTable = () =>
  buildClassTable([
    {
      name: HOLDER,
      parent: null,
      abstract: false,
      members: [
        {
          name: "v",
          declaredType: "int",
          member: "field",
          owner: HOLDER,
          abstract: false,
          visibility: "public",
          static: false,
        },
      ],
      constructorParams: [],
      constructorParamNames: [],
    },
  ]);

function graphNamed(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.classes = holderTable();
  return graph;
}

function inferenceOf(graph: CFGFunction): TypeInference {
  graph.rebuildUses();
  return new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId);
}

const textOf = (graph: CFGFunction, value: CFGInstruction): string | null =>
  absenceTextOf(value, graph, graph.classes!, inferenceOf(graph));

const referenceTextOf = (graph: CFGFunction, value: CFGInstruction): string | null =>
  referenceAbsenceTextOf(value, graph, graph.classes!, inferenceOf(graph));

function merging(held: readonly unknown[]): { graph: CFGFunction; phi: CFGInstruction } {
  const graph = graphNamed("merges");
  const entry = graph.addBlock();
  const merge = graph.addBlock();
  const phi = addPhi(merge, []);
  merge.addNode(irReturn(phi));
  const arms = held.map((value) => {
    const arm = graph.addBlock();
    const constant = arm.addNode(irConstant(value));
    arm.addNode(irJump(merge));
    connect(arm, merge, [constant]);
    return arm;
  });
  const [taken, untaken] = arms;
  entry.addNode(irBranch(entry.addNode(irConstant(1)), taken!, untaken!));
  link(entry, taken!);
  link(entry, untaken!);
  return { graph, phi };
}

function looping(cycled: boolean): { graph: CFGFunction; header: CFGInstruction } {
  const graph = graphNamed("loops");
  const entry = graph.addBlock();
  const head = graph.addBlock();
  const latch = graph.addBlock();
  const exit = graph.addBlock();

  const seed = entry.addNode(irConstant(null));
  entry.addNode(irJump(head));
  link(entry, head);

  const header = addPhi(head, [seed]);
  head.addNode(irBranch(header, latch, exit));
  link(head, latch);
  link(head, exit);

  const carried = cycled ? addPhi(latch, [header]) : header;
  latch.addNode(irJump(head));
  link(latch, head);
  header.addInput(carried);

  exit.addNode(irReturn(header));
  return { graph, header };
}

function receiving(declared: string): { graph: CFGFunction; value: CFGInstruction } {
  const graph = graphNamed("takes");
  graph.declaredSignature = { params: [declared], returns: null };
  const block = graph.addBlock();
  const value = graph.addParameter(0);
  block.addNode(irReturn(value));
  return { graph, value };
}

describe("absence values", () => {
  it("tells null and undefined apart by the text they print", () => {
    expect(absenceValueOf(null)?.text).toBe(NULL_TEXT);
    expect(absenceValueOf(undefined)?.text).toBe(UNDEFINED_TEXT);
    expect(NULL_TEXT).not.toBe(UNDEFINED_TEXT);
  });

  it("gives each one its own float64 payload", () => {
    const payloads = new Set(ABSENCE_VALUES.map((absence) => absence.bits));

    expect(payloads.size).toBe(ABSENCE_VALUES.length);
  });

  it("keeps every payload a quiet NaN, so no finite number is read as absent", () => {
    for (const absence of ABSENCE_VALUES) {
      const exponent = (absence.bits >> 52n) & 0x7ffn;
      const mantissa = absence.bits & ((1n << 52n) - 1n);

      expect(exponent).toBe(0x7ffn);
      expect(mantissa).not.toBe(0n);
    }
  });

  it("marks only the flavour a null reference stands for as reference-held", () => {
    const held = ABSENCE_VALUES.filter((absence) => absence.reference);

    expect(held).toEqual([absenceValueOf(null)]);
  });

  it("answers nothing for a value that is present", () => {
    expect(absenceValueOf(0)).toBeNull();
    expect(absenceValueOf("")).toBeNull();
    expect(absenceValueOf(false)).toBeNull();
  });
});

describe("declaredAbsenceText", () => {
  it("reads the one absence a declared type admits", () => {
    expect(declaredAbsenceText("string | undefined")).toBe(UNDEFINED_TEXT);
    expect(declaredAbsenceText("string | null")).toBe(NULL_TEXT);
    expect(declaredAbsenceText("int | undefined")).toBe(UNDEFINED_TEXT);
  });

  it("answers nothing when a type admits both, since the two cannot be told apart", () => {
    expect(declaredAbsenceText("string | null | undefined")).toBeNull();
  });

  it("answers nothing for a type that admits no absence at all", () => {
    expect(declaredAbsenceText("string")).toBeNull();
    expect(declaredAbsenceText(null)).toBeNull();
    expect(declaredAbsenceText(undefined)).toBeNull();
  });
});

describe("absenceTextOf over a value two branches merge", () => {
  it("spells the absence when every branch carries the same one", () => {
    const { graph, phi } = merging([null, null]);

    expect(textOf(graph, phi)).toBe(NULL_TEXT);
  });

  it("spells the other flavour when that is the one every branch carries", () => {
    const { graph, phi } = merging([undefined, undefined]);

    expect(textOf(graph, phi)).toBe(UNDEFINED_TEXT);
  });

  it("answers nothing when the branches disagree, since neither word is right", () => {
    const { graph, phi } = merging([null, undefined]);

    expect(textOf(graph, phi)).toBeNull();
  });

  it("answers nothing when one branch carries a value that is present", () => {
    const { graph, phi } = merging([null, 1]);

    expect(textOf(graph, phi)).toBeNull();
  });
});

describe("absenceTextOf over a merge that flows back into itself", () => {
  it("answers the word the entering branch carries rather than recursing forever", () => {
    const { graph, header } = looping(false);

    expect(textOf(graph, header)).toBe(NULL_TEXT);
  });

  it("answers nothing when the cycle runs through a second merge it cannot read", () => {
    const { graph, header } = looping(true);

    expect(textOf(graph, header)).toBeNull();
  });
});

describe("referenceAbsenceTextOf", () => {
  it("spells the absence an object-typed parameter admits", () => {
    const { graph, value } = receiving(`${HOLDER} | null`);

    expect(referenceTextOf(graph, value)).toBe(NULL_TEXT);
  });

  it("spells it for text, which a binary holds by reference too", () => {
    const { graph, value } = receiving("string | undefined");

    expect(referenceTextOf(graph, value)).toBe(UNDEFINED_TEXT);
  });

  it("answers nothing for a number, whose absence rides in its own payload", () => {
    const { graph, value } = receiving("int | undefined");

    expect(referenceTextOf(graph, value)).toBeNull();
  });

  it("answers nothing for a reference the declared type says always holds one", () => {
    const { graph, value } = receiving(HOLDER);

    expect(referenceTextOf(graph, value)).toBeNull();
  });
});
