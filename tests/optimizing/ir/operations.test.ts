import { describe, expect, it } from "vitest";
import * as ops from "../../../src/optimizing/ir/operations.js";
import * as ir from "../../../src/optimizing/ir/index.js";
import { deadCodeElimination } from "../../../src/optimizing/passes/dce.js";

const declaredOpcodes = Object.entries(ops)
  .filter(([name, value]) => name.startsWith("IR_") && typeof value === "string")
  .map(([name, value]) => [name, value as string] as const);

const constructors: ReadonlyArray<readonly [string, ir.CFGInstruction]> = (() => {
  const value = () => ir.irConstant(1);
  const block = new ir.CFGFunction("arity").addBlock();
  return [
    ["irConstant", ir.irConstant(1)],
    ["irParameter", ir.irParameter(0)],
    ["irCheckMap", ir.irCheckMap(value(), 1)],
    ["irCheckSmi", ir.irCheckSmi(value())],
    ["irCheckNumber", ir.irCheckNumber(value())],
    ["irCheckArray", ir.irCheckArray(value())],
    ["irCheckElementsKind", ir.irCheckElementsKind(value(), 1)],
    ["irCheckBounds", ir.irCheckBounds(value(), value())],
    ["irCheckCallTarget", ir.irCheckCallTarget(value(), 1)],
    ["irInt32Add", ir.irInt32Add(value(), value())],
    ["irInt32Not", ir.irInt32Not(value())],
    ["irInt32Ushr", ir.irInt32Ushr(value(), value())],
    ["irFloat64Pow", ir.irFloat64Pow(value(), value())],
    ["irInt32Compare", ir.irInt32Compare("<", value(), value())],
    ["irLoadField", ir.irLoadField(value(), 0)],
    ["irStoreField", ir.irStoreField(value(), 0, value())],
    ["irLoadElement", ir.irLoadElement(value(), value())],
    ["irStoreElement", ir.irStoreElement(value(), value(), value())],
    ["irLoadArrayLength", ir.irLoadArrayLength(value())],
    ["irPolymorphicLoad", ir.irPolymorphicLoad(value(), [], [])],
    ["irPolymorphicStore", ir.irPolymorphicStore(value(), [], [], value())],
    ["irGenericGetProp", ir.irGenericGetProp(value(), "p")],
    ["irGenericSetProp", ir.irGenericSetProp(value(), "p", value())],
    ["irGenericGetIndex", ir.irGenericGetIndex(value(), value())],
    ["irGenericSetIndex", ir.irGenericSetIndex(value(), value(), value())],
    ["irLoadGlobal", ir.irLoadGlobal("g")],
    ["irStoreGlobal", ir.irStoreGlobal("g", value())],
    ["irLoadLocal", ir.irLoadLocal(0)],
    ["irStoreLocal", ir.irStoreLocal(0, value())],
    ["irLoadContextSlot", ir.irLoadContextSlot(0)],
    ["irStoreContextSlot", ir.irStoreContextSlot(0, value())],
    ["irNewObject", ir.irNewObject()],
    ["irNewRegex", ir.irNewRegex(0)],
    ["irMakeClosure", ir.irMakeClosure(0, null, [])],
    ["irTypeOf", ir.irNot(value())],
    ["irNeg", ir.irNeg(value())],
    ["irBox", ir.irBox(value(), "int32")],
    ["irUnbox", ir.irUnbox(value(), "int32")],
    ["irReturn", ir.irReturn(value())],
    ["irBranch", ir.irBranch(value(), block, block)],
    ["irJump", ir.irJump(block)],
    ["irDeoptimize", ir.irDeoptimize("why")],
  ];
})();

describe("operation property table", () => {
  it("declares an entry for every exported opcode constant", () => {
    const missing = declaredOpcodes
      .filter(([, opcode]) => !ops.isOpcode(opcode))
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  it("exposes exactly the declared opcodes and nothing else", () => {
    expect([...ops.ALL_OPCODES].sort()).toEqual(
      declaredOpcodes.map(([, opcode]) => opcode).sort(),
    );
  });

  it("never classifies one operation as both a tracked load and a tracked store", () => {
    const both = ops.ALL_OPCODES.filter(
      (opcode) => ops.isTrackedLoad(opcode) && ops.isTrackedStore(opcode),
    );

    expect(both).toEqual([]);
  });

  it("keeps opaque property access out of the tracked memory operations", () => {
    const overlapping = ops.ALL_OPCODES.filter(
      (opcode) =>
        ops.isOpaquePropertyAccess(opcode) &&
        (ops.isTrackedLoad(opcode) || ops.isTrackedStore(opcode)),
    );

    expect(overlapping).toEqual([]);
  });

  it("tracks the field, element and global accesses the alias analyses can resolve", () => {
    const tracked = ops.ALL_OPCODES.filter(
      (opcode) => ops.isTrackedLoad(opcode) || ops.isTrackedStore(opcode),
    );

    expect([...tracked].sort()).toEqual(
      [
        ops.IR_LOAD_FIELD,
        ops.IR_STORE_FIELD,
        ops.IR_LOAD_ELEMENT,
        ops.IR_STORE_ELEMENT,
        ops.IR_LOAD_GLOBAL,
        ops.IR_STORE_GLOBAL,
      ].sort(),
    );
  });

  it("counts an allocation site only when the operation touches nothing else", () => {
    const call = ir.irGenericCall(ir.irConstant(1), []);

    expect(ops.isAllocationSite(ops.IR_NEW_OBJECT)).toBe(true);
    expect(ops.isAllocationSite(ops.IR_NEW_ARRAY)).toBe(true);
    expect(ops.allocates(call)).toBe(true);
    expect(ops.isAllocationSite(call.type)).toBe(false);
  });


  it("types the previously-undeclared operations that fell back to any", () => {
    const context = {
      typeOf: () => ({ kind: "Any" }) as never,
      returnTypeOf: () => ({ kind: "Any" }) as never,
    };
    const ushr = ir.irInt32Ushr(ir.irConstant(1), ir.irConstant(2));

    expect(ops.transferType(ushr, context).kind).toBe(
      ops.transferType(ir.irGenericUshr(ir.irConstant(1), ir.irConstant(2)), context).kind,
    );
  });

  it("declares the arity each IR constructor actually builds", () => {
    const mismatches = constructors
      .filter(([, node]) => {
        const arity = ops.arityOf(node.type);
        return arity.kind === "fixed"
          ? node.inputs.length !== arity.count
          : node.inputs.length < arity.least;
      })
      .map(([name, node]) => `${name}: ${node.inputs.length} inputs`);

    expect(mismatches).toEqual([]);
  });

  it("keeps the effect classifications mutually exclusive", () => {
    const overlapping = constructors
      .filter(([, node]) => {
        const classes = [ops.isEffectFree(node), ops.isReadOnly(node), ops.isGuard(node)];
        return classes.filter(Boolean).length > 1;
      })
      .map(([name]) => name);

    expect(overlapping).toEqual([]);
  });




  it("stops requiring a frame state once overflow is proven impossible", () => {
    const add = ir.irInt32Add(ir.irConstant(1), ir.irConstant(2));
    expect(ops.canDeoptimize(add)).toBe(true);

    add.props.noOverflow = true;
    expect(ops.canDeoptimize(add)).toBe(false);
  });

  it("derives call effects from the effects the caller declared", () => {
    const unknown = ir.irCallBuiltin("whatever", []);
    const immutable = ir.irCallBuiltin("string.length", [], {
      declaredEffects: ["immutable-read"],
    });

    expect(ops.clobbersAllMemory(unknown)).toBe(true);
    expect(ops.isReadOnly(immutable)).toBe(true);
    expect(ops.readsMutableMemory(immutable)).toBe(false);
    expect(ops.canDeoptimize(immutable)).toBe(false);
  });

  it("derives the boolean-producing operations from their type transfers", () => {
    const boolean = ops.ALL_OPCODES.filter((opcode) => ops.alwaysProducesBoolean(opcode));

    expect([...boolean].sort()).toEqual(
      [
        ops.IR_NOT,
        ops.IR_INT32_COMPARE,
        ops.IR_FLOAT64_COMPARE,
        ops.IR_GENERIC_COMPARE,
        ops.IR_GENERIC_INSTANCEOF,
        ops.IR_GENERIC_IN,
        ops.IR_GENERIC_DELETE_PROP,
        ops.IR_CHECK_CALL_TARGET,
        ops.IR_ITERATOR_DONE,
      ].sort(),
    );
  });

  it("separates machine representation from lattice type for instanceof and in", () => {
    expect(ops.alwaysProducesBoolean(ops.IR_GENERIC_IN)).toBe(true);
    expect(ops.resultClassOf(ops.IR_GENERIC_IN)).toBe(ops.RESULT_CONTEXTUAL);
    expect(ops.resultClassOf(ops.IR_INT32_COMPARE)).toBe(ops.RESULT_BOOL);
  });



  it("drives dead code elimination: stores survive, unused loads and arithmetic do not", () => {
    const graph = new ir.CFGFunction("dce");
    const block = graph.addBlock();
    const object = ir.irNewObject();
    const stored = ir.irConstant(7);
    const store = ir.irStoreField(object, 0, stored);
    const unusedLoad = ir.irLoadField(object, 0);
    const unusedSum = ir.irInt32Add(ir.irConstant(1), ir.irConstant(2));
    const returned = ir.irConstant(0);
    for (const node of [object, stored, store, unusedLoad, unusedSum, returned]) {
      block.addNode(node);
    }
    block.addNode(ir.irReturn(returned));
    graph.rebuildUses();

    deadCodeElimination(graph);
    const survivors = block.nodes;

    expect(survivors).toContain(store);
    expect(survivors).toContain(object);
    expect(survivors).not.toContain(unusedLoad);
    expect(survivors).not.toContain(unusedSum);
  });

  it("keeps an unused call that declares unknown effects but drops a pure one", () => {
    const graph = new ir.CFGFunction("calls");
    const block = graph.addBlock();
    const receiver = ir.irConstant("s");
    const unknown = ir.irCallBuiltin("unknown", [receiver]);
    const pureCall = ir.irCallBuiltin("string.length", [receiver], {
      declaredEffects: ["immutable-read"],
    });
    const returned = ir.irConstant(0);
    for (const node of [receiver, unknown, pureCall, returned]) block.addNode(node);
    block.addNode(ir.irReturn(returned));
    graph.rebuildUses();

    deadCodeElimination(graph);

    expect(block.nodes).toContain(unknown);
    expect(block.nodes).not.toContain(pureCall);
  });

  it("turns a dispatch-map store into a memory write and a load into a read", () => {
    const load = new ir.CFGInstruction(ops.IR_DISPATCH_MAP, {});
    const store = new ir.CFGInstruction(ops.IR_DISPATCH_MAP, { isStore: true });

    expect(ops.writesMemory(load)).toBe(false);
    expect(ops.readsMemory(load)).toBe(true);
    expect(ops.writesMemory(store)).toBe(true);
  });
});
