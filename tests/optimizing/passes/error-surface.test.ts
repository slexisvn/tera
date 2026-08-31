import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallBuiltin,
  irConstant,
  irLoadGlobal,
  irGenericCall,
  irGenericGetProp,
  irNewObject,
  irReturn,
  propertyNameOf,
  resetIRNodeIds,
  IR_GENERIC_ADD,
  type CFGBlock,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { addPhi } from "../../../src/optimizing/ir/cfg-edit.js";
import { lowerErrorSurface } from "../../../src/optimizing/passes/error-surface.js";
import {
  markThrownValue,
  recordPendingThrow,
  takePendingThrow,
  carriesPendingThrow,
} from "../../../src/optimizing/builder/throw-recovery.js";
import {
  buildClassTable,
  CLASS_ID_PROP,
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  VALUE_CLASS_PROP,
  type ClassTable,
} from "../../../src/optimizing/metadata/class-table.js";
import { moduleFromGraphs, type ModuleIR } from "../../../src/optimizing/compilation-unit.js";
import {
  PRINT_BUILTIN,
  THROW_BUILTIN,
} from "../../../src/optimizing/metadata/builtin-methods.js";
import { SCALAR_POINTER, SCALAR_STRING } from "../../../src/optimizing/types/scalar.js";
import {
  ERROR_DISPLAY_PREFIX,
  ERROR_GLOBAL,
  ERROR_MESSAGE_FIELD,
} from "../../../src/optimizing/prelude/errors.js";
import { CLASS_DATA_MEMBER } from "../../../src/core/class-member.js";
import type { ClassSurface } from "../../../src/frontend/modules/interface.js";

const field = (owner: string, name: string, declaredType: string) => ({
  name,
  declaredType,
  member: CLASS_DATA_MEMBER,
  owner,
  abstract: false,
  visibility: "public" as const,
  static: false,
});

const surface = (
  name: string,
  parent: string | null,
  members: ReturnType<typeof field>[],
  constructorParams: string[],
): ClassSurface => ({
  name,
  parent,
  abstract: false,
  members,
  constructorParams,
  constructorParamNames: constructorParams.map((_type, at) => `p${at}`),
});

const ERROR = surface(ERROR_GLOBAL, null, [field(ERROR_GLOBAL, ERROR_MESSAGE_FIELD, "string")], [
  "string",
]);
const HTTP = surface("HttpError", ERROR_GLOBAL, [field("HttpError", "status", "int")], [
  "string",
  "int",
]);
const IO = surface("IoError", ERROR_GLOBAL, [], ["string"]);
const BOX = surface("Box", null, [field("Box", "n", "int")], ["int"]);

function table(): ClassTable {
  return buildClassTable([ERROR, HTTP, IO, BOX]);
}

function graphNamed(name: string, classes: ClassTable): CFGFunction {
  const graph = new CFGFunction(name);
  graph.classes = classes;
  graph.recoversThrows = true;
  return graph;
}

function allocated(block: CFGBlock, classes: ClassTable, className: string): CFGInstruction {
  const node = irNewObject();
  node.props[CLASS_ID_PROP] = classes.shapeIdOf(className)!;
  node.props[VALUE_CLASS_PROP] = classes.shapeIdOf(className)!;
  return block.addNode(node);
}

function constructed(block: CFGBlock, className: string): CFGInstruction {
  const callee = block.addNode(irLoadGlobal(className));
  return block.addNode(irGenericCall(callee, [block.addNode(irConstant("boom"))]));
}

function raises(classes: ClassTable, thrown: (block: CFGBlock) => CFGInstruction[]): CFGFunction {
  const graph = graphNamed("risky", classes);
  const block = graph.addBlock();
  for (const value of thrown(block)) recordPendingThrow(block, value);
  block.addNode(irReturn(block.addNode(irConstant(0))));
  graph.rebuildUses();
  return graph;
}

function catchesInto(classes: ClassTable, held: (block: CFGBlock) => CFGInstruction[]) {
  const graph = graphNamed("tera_program", classes);
  const block = graph.addBlock();
  const taken = takePendingThrow(block);
  const merged = addPhi(block, [taken, ...held(block)]);
  const read = block.addNode(irGenericGetProp(merged, ERROR_MESSAGE_FIELD));
  block.addNode(irReturn(read));
  graph.rebuildUses();
  return { graph, taken, merged };
}

function reports(classes: ClassTable, thrown: (block: CFGBlock) => CFGInstruction) {
  const graph = graphNamed("tera_program", classes);
  const block = graph.addBlock();
  const value = thrown(block);
  const report = block.addNode(irCallBuiltin(THROW_BUILTIN, [value], {}));
  block.addNode(irReturn(block.addNode(irConstant(0))));
  graph.rebuildUses();
  return { graph, value, report };
}

function cellNodesOf(module: ModuleIR): CFGInstruction[] {
  return module.units.flatMap((unit) =>
    unit.graph.blocks.flatMap((block) => block.nodes.filter((node) => carriesPendingThrow(node))),
  );
}

const declaredOn = (nodes: CFGInstruction[]) => [
  ...new Set(nodes.map((node) => `${node.props[FIELD_TYPE_PROP]}/${node.props[FIELD_SCALAR_PROP]}`)),
];

beforeEach(() => resetIRNodeIds());

describe("lowerErrorSurface", () => {
  it("retypes the pending cell to the class every throw raises", () => {
    const classes = table();
    const raiser = raises(classes, (block) => [allocated(block, classes, "HttpError")]);
    const { graph } = catchesInto(classes, () => []);
    const module = moduleFromGraphs([raiser, graph]);

    lowerErrorSurface(module, classes);

    expect(declaredOn(cellNodesOf(module))).toEqual([`HttpError/${SCALAR_POINTER}`]);
  });

  it("retypes the pending cell to the ancestor two sibling subclasses share", () => {
    const classes = table();
    const raiser = raises(classes, (block) => [
      allocated(block, classes, "HttpError"),
      allocated(block, classes, "IoError"),
    ]);
    const { graph } = catchesInto(classes, () => []);
    const module = moduleFromGraphs([raiser, graph]);

    lowerErrorSurface(module, classes);

    expect(declaredOn(cellNodesOf(module))).toEqual([`${ERROR_GLOBAL}/${SCALAR_POINTER}`]);
  });

  it("stamps the held class on a merge of the cell and a locally raised error", () => {
    const classes = table();
    const { graph, merged } = catchesInto(classes, (block) => {
      const local = allocated(block, classes, "HttpError");
      markThrownValue(local);
      return [local];
    });

    lowerErrorSurface(moduleFromGraphs([graph]), classes);

    expect(merged.props[VALUE_CLASS_PROP]).toBe(classes.shapeIdOf("HttpError"));
  });

  it("stamps the shared ancestor when the merge mixes two subclasses", () => {
    const classes = table();
    const { graph, merged } = catchesInto(classes, (block) => {
      const local = allocated(block, classes, "IoError");
      markThrownValue(local);
      return [local];
    });
    const raiser = raises(classes, (block) => [allocated(block, classes, "HttpError")]);

    lowerErrorSurface(moduleFromGraphs([raiser, graph]), classes);

    expect(merged.props[VALUE_CLASS_PROP]).toBe(classes.shapeIdOf(ERROR_GLOBAL));
  });

  it("reads the shape off a construction no pass has lowered yet", () => {
    const classes = table();
    const raiser = raises(classes, (block) => [constructed(block, "HttpError")]);
    const { graph } = catchesInto(classes, () => []);
    const module = moduleFromGraphs([raiser, graph]);

    lowerErrorSurface(module, classes);

    expect(declaredOn(cellNodesOf(module))).toEqual([`HttpError/${SCALAR_POINTER}`]);
  });

  it("hands the throw builtin the text the interpreter names the error by", () => {
    const classes = table();
    const { graph, value, report } = reports(classes, (block) => {
      const raised = allocated(block, classes, "HttpError");
      markThrownValue(raised);
      return raised;
    });

    lowerErrorSurface(moduleFromGraphs([graph]), classes);

    const display = report.inputs[0]!;
    expect(display.type).toBe(IR_GENERIC_ADD);
    expect(display.inputs[0]!.props.value).toBe(ERROR_DISPLAY_PREFIX);
    expect(propertyNameOf(display.inputs[1]!)).toBe(ERROR_MESSAGE_FIELD);
    expect(display.inputs[1]!.inputs[0]).toBe(value);
  });

  it("leaves the cell alone for a module that raises text", () => {
    const classes = table();
    const raiser = raises(classes, (block) => [block.addNode(irConstant("negative"))]);
    const { graph } = catchesInto(classes, () => []);
    const module = moduleFromGraphs([raiser, graph]);

    expect(lowerErrorSurface(module, classes)).toBe(0);
    expect(declaredOn(cellNodesOf(module))).toEqual([`string/${SCALAR_STRING}`]);
  });

  it("leaves the cell alone for a raised class that is no kind of error", () => {
    const classes = table();
    const raiser = raises(classes, (block) => [allocated(block, classes, "Box")]);
    const module = moduleFromGraphs([raiser]);

    expect(lowerErrorSurface(module, classes)).toBe(0);
    expect(declaredOn(cellNodesOf(module))).toEqual([`string/${SCALAR_STRING}`]);
  });

  it("leaves the cell alone when an error is handed somewhere other than a member read", () => {
    const classes = table();
    const graph = graphNamed("tera_program", classes);
    const block = graph.addBlock();
    const taken = takePendingThrow(block);
    block.addNode(irCallBuiltin(PRINT_BUILTIN, [taken], {}));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    graph.rebuildUses();
    const raiser = raises(classes, (block) => [allocated(block, classes, "HttpError")]);
    const module = moduleFromGraphs([raiser, graph]);

    expect(lowerErrorSurface(module, classes)).toBe(0);
    expect(declaredOn(cellNodesOf(module))).toEqual([`string/${SCALAR_STRING}`]);
  });

  it("carries the error itself for a module whose rejections travel through promises", () => {
    const classes = table();
    const raiser = raises(classes, (block) => [allocated(block, classes, "HttpError")]);
    raiser.isAsync = true;
    const module = moduleFromGraphs([raiser]);

    lowerErrorSurface(module, classes);

    expect(declaredOn(cellNodesOf(module))).toEqual([`HttpError/${SCALAR_POINTER}`]);
    expect(classes.thrownType()).toBe("HttpError");
  });

  it("leaves the cell alone when the program declares no error class at all", () => {
    const classes = buildClassTable([BOX]);
    const raiser = raises(classes, (block) => [block.addNode(irConstant("negative"))]);
    const module = moduleFromGraphs([raiser]);

    expect(lowerErrorSurface(module, classes)).toBe(0);
    expect(declaredOn(cellNodesOf(module))).toEqual([`string/${SCALAR_STRING}`]);
  });

  it("admits a module whose caught error shares a register slot with an unrelated value", () => {
    const classes = table();
    const graph = graphNamed("tera_program", classes);
    const block = graph.addBlock();
    const taken = takePendingThrow(block);
    block.addNode(irGenericGetProp(taken, ERROR_MESSAGE_FIELD));
    const slot = addPhi(block, [taken, block.addNode(irConstant(7))]);
    block.addNode(irCallBuiltin(PRINT_BUILTIN, [slot], {}));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    graph.rebuildUses();
    const raiser = raises(classes, (block) => [allocated(block, classes, "HttpError")]);
    const module = moduleFromGraphs([raiser, graph]);

    lowerErrorSurface(module, classes);

    expect(declaredOn(cellNodesOf(module))).toEqual([`HttpError/${SCALAR_POINTER}`]);
    expect(slot.props[VALUE_CLASS_PROP]).toBeUndefined();
  });

  it("carries a merge whose other arm is a slot no path has defined yet", () => {
    const classes = table();
    const graph = graphNamed("tera_program", classes);
    const block = graph.addBlock();
    const taken = takePendingThrow(block);
    const slot = addPhi(block, [taken, block.addNode(irConstant(undefined))]);
    block.addNode(irGenericGetProp(slot, ERROR_MESSAGE_FIELD));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    graph.rebuildUses();
    const raiser = raises(classes, (block) => [allocated(block, classes, "HttpError")]);

    lowerErrorSurface(moduleFromGraphs([raiser, graph]), classes);

    expect(slot.props[VALUE_CLASS_PROP]).toBe(classes.shapeIdOf("HttpError"));
  });
});
