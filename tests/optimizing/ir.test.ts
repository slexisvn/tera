import { describe, it, expect, beforeEach } from "vitest";
import {
  CFGValue,
  CFGInstruction,
  CFGBlock,
  CFGFunction,
  IRNode,
  IRBlock,
  IRGraph,
  irConstant,
  irParameter,
  irInt32Add,
  irInt32Sub,
  irInt32Mul,
  irInt32Div,
  irInt32Mod,
  irFloat64Add,
  irFloat64Sub,
  irFloat64Mul,
  irFloat64Div,
  irInt32Compare,
  irFloat64Compare,
  irLoadField,
  irStoreField,
  irGenericAdd,
  irGenericCall,
  irCheckMap,
  irCheckSmi,
  irCheckNumber,
  irCheckArray,
  irCheckBounds,
  irCheckCallTarget,
  irCallKnownFunction,
  irCheckElementsKind,
  irReturn,
  irBranch,
  irJump,
  irDeoptimize,
  irBox,
  irUnbox,
  irNot,
  irNeg,
  irNewObject,
  irNewArray,
  irNewRegex,
  irLoadLocal,
  irStoreLocal,
  irLoadGlobal,
  irStoreGlobal,
  irLoadArrayLength,
  irLoadElement,
  irStoreElement,
  irPolymorphicLoad,
  irPolymorphicStore,
  irInt32Shl,
  irInt32Shr,
  irInt32And,
  irInt32Or,
  irInt32Xor,
  irInt32Ushr,
  irInt32Not,
  irFloat64Pow,
  irGenericSub,
  irGenericMul,
  irGenericDiv,
  irGenericMod,
  irGenericCompare,
  irGenericGetProp,
  irGenericSetProp,
  irGenericGetIndex,
  irGenericSetIndex,
  irGenericBitand,
  irGenericBitor,
  irGenericBitxor,
  irGenericShl,
  irGenericShr,
  irGenericUshr,
  irGenericPow,
  irGenericBitnot,
  irGenericInstanceof,
  irGenericIn,
  irRequiresFrameState,
  IR_CONSTANT,
  IR_PARAMETER,
  IR_INT32_ADD,
  IR_RETURN,
  IR_BRANCH,
  IR_JUMP,
  IR_DEOPTIMIZE,
  IR_BLOCK_PARAM,
  IR_CHECK_MAP,
  IR_CHECK_SMI,
  IR_STORE_FIELD,
  IR_LOAD_FIELD,
  IR_GENERIC_CALL,
  IR_NEW_OBJECT,
  IR_NEW_ARRAY,
  EFFECT_NONE,
  EFFECT_GUARD,
  EFFECT_READ,
  EFFECT_WRITE,
  EFFECT_CALL,
  EFFECT_ALLOC,
  EFFECT_TERMINATOR,
  resetIRNodeIds,
} from "../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

describe("CFGInstruction", () => {
  describe("addInput / replaceInput", () => {
    it("tracks uses bidirectionally", () => {
      const a = irConstant(1);
      const b = irConstant(2);
      const add = irInt32Add(a, b);
      expect(add.inputs).toEqual([a, b]);
      expect(a.uses).toContain(add);
      expect(b.uses).toContain(add);
    });

    it("replaceInput updates use lists correctly", () => {
      const a = irConstant(1);
      const b = irConstant(2);
      const c = irConstant(3);
      const add = irInt32Add(a, b);
      add.replaceInput(1, c);
      expect(add.inputs[1]).toBe(c);
      expect(b.uses).not.toContain(add);
      expect(c.uses).toContain(add);
    });

    it("replaceInput removes old from uses and adds new", () => {
      const a = irConstant(10);
      const b = irConstant(20);
      const c = irConstant(30);
      const node = irInt32Add(a, b);
      const sub = irInt32Sub(node, c);
      sub.replaceInput(0, a);
      expect(node.uses).not.toContain(sub);
      expect(a.uses).toContain(sub);
    });
  });

  describe("effect inference", () => {
    it("terminators get EFFECT_TERMINATOR", () => {
      const ret = irReturn(irConstant(0));
      expect(ret.effectKind).toBe(EFFECT_TERMINATOR);
    });

    it("stores get EFFECT_WRITE", () => {
      const obj = irConstant({});
      const val = irConstant(1);
      const store = irStoreField(obj, 0, val);
      expect(store.effectKind).toBe(EFFECT_WRITE);
    });

    it("loads get EFFECT_READ", () => {
      const obj = irConstant({});
      const load = irLoadField(obj, 0);
      expect(load.effectKind).toBe(EFFECT_READ);
    });

    it("guards get EFFECT_GUARD", () => {
      const val = irConstant(1);
      const check = irCheckSmi(val);
      expect(check.effectKind).toBe(EFFECT_GUARD);
    });

    it("calls get EFFECT_CALL", () => {
      const callee = irConstant("fn");
      const call = irGenericCall(callee, [irConstant(1)]);
      expect(call.effectKind).toBe(EFFECT_CALL);
    });

    it("allocations get EFFECT_ALLOC", () => {
      expect(irNewObject().effectKind).toBe(EFFECT_ALLOC);
      expect(irNewArray([irConstant(1)]).effectKind).toBe(EFFECT_ALLOC);
    });

    it("pure arithmetic gets EFFECT_NONE", () => {
      const add = irInt32Add(irConstant(1), irConstant(2));
      expect(add.effectKind).toBe(EFFECT_NONE);
    });
  });

  describe("irRequiresFrameState", () => {
    it("check nodes require frame state", () => {
      expect(irRequiresFrameState(irCheckSmi(irConstant(1)))).toBe(true);
      expect(irRequiresFrameState(irCheckNumber(irConstant(1)))).toBe(true);
      expect(irRequiresFrameState(irCheckMap(irConstant(1), 42))).toBe(true);
      expect(irRequiresFrameState(irCheckArray(irConstant(1)))).toBe(true);
    });

    it("overflow-capable arithmetic requires frame state unless noOverflow", () => {
      const add = irInt32Add(irConstant(1), irConstant(2));
      expect(irRequiresFrameState(add)).toBe(true);
      add.props.noOverflow = true;
      expect(irRequiresFrameState(add)).toBe(false);
    });

    it("pure nodes do not require frame state", () => {
      expect(irRequiresFrameState(irConstant(1))).toBe(false);
      expect(irRequiresFrameState(irFloat64Add(irConstant(1), irConstant(2)))).toBe(false);
    });
  });
});

describe("CFGBlock", () => {
  describe("addNode / terminator", () => {
    it("tracks terminator when adding return", () => {
      const block = new CFGBlock(0);
      const ret = irReturn(irConstant(42));
      block.addNode(ret);
      expect(block.getTerminator()).toBe(ret);
      expect(block.isTerminated()).toBe(true);
    });

    it("non-terminator nodes do not make block terminated", () => {
      const block = new CFGBlock(0);
      block.addNode(irInt32Add(irConstant(1), irConstant(2)));
      expect(block.isTerminated()).toBe(false);
    });

    it("sets node.block on addNode", () => {
      const block = new CFGBlock(0);
      const node = irConstant(1);
      block.addNode(node);
      expect(node.block).toBe(block);
    });
  });

  describe("addParam", () => {
    it("creates BlockParam and adds to params and nodes", () => {
      const block = new CFGBlock(0);
      const param = block.addParam([]);
      expect(param.type).toBe(IR_BLOCK_PARAM);
      expect(block.params).toContain(param);
      expect(block.nodes).toContain(param);
      expect(param.block).toBe(block);
    });

    it("multiple params get sequential indices", () => {
      const block = new CFGBlock(0);
      const p0 = block.addParam();
      const p1 = block.addParam();
      expect(p0.props.index).toBe(0);
      expect(p1.props.index).toBe(1);
    });
  });

  describe("addSuccessor / predecessor", () => {
    it("connects two blocks bidirectionally", () => {
      const b0 = new CFGBlock(0);
      const b1 = new CFGBlock(1);
      b0.addSuccessor(b1);
      expect(b0.successors).toContain(b1);
      expect(b1.predecessors).toContain(b0);
    });

    it("does not duplicate on repeated addSuccessor", () => {
      const b0 = new CFGBlock(0);
      const b1 = new CFGBlock(1);
      b0.addSuccessor(b1);
      b0.addSuccessor(b1);
      expect(b0.successors.filter(b => b === b1)).toHaveLength(1);
    });

    it("edge args roundtrip through setEdgeArgs/getEdgeArgs", () => {
      const b0 = new CFGBlock(0);
      const b1 = new CFGBlock(1);
      const v = irConstant(99);
      b0.addSuccessor(b1, [v]);
      expect(b0.getEdgeArgs(b1)).toEqual([v]);
      const v2 = irConstant(100);
      b0.setEdgeArgs(b1, [v2]);
      expect(b0.getEdgeArgs(b1)).toEqual([v2]);
    });
  });
});

describe("CFGFunction", () => {
  describe("addBlock", () => {
    it("first block becomes entry", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      expect(graph.entry).toBe(b0);
    });

    it("subsequent blocks do not change entry", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      graph.addBlock();
      expect(graph.entry).toBe(b0);
    });

    it("blocks get sequential ids", () => {
      const graph = new CFGFunction("test");
      const b0 = graph.addBlock();
      const b1 = graph.addBlock();
      expect(b0.id).toBe(0);
      expect(b1.id).toBe(1);
    });
  });

  describe("addParameter", () => {
    it("creates parameter node and increments count", () => {
      const graph = new CFGFunction("test");
      const p = graph.addParameter(0);
      expect(p.type).toBe(IR_PARAMETER);
      expect(graph.parameterCount).toBe(1);
      expect(graph.parameters).toContain(p);
    });
  });

  describe("addDependency", () => {
    it("deduplicates identical dependencies", () => {
      const graph = new CFGFunction("test");
      graph.addDependency("map", 42, 1);
      graph.addDependency("map", 42, 1);
      expect(graph.dependencies).toHaveLength(1);
    });

    it("keeps distinct dependencies", () => {
      const graph = new CFGFunction("test");
      graph.addDependency("map", 1, 1);
      graph.addDependency("map", 2, 1);
      expect(graph.dependencies).toHaveLength(2);
    });
  });

  describe("rebuildUses", () => {
    it("reconstructs use lists from inputs", () => {
      const graph = new CFGFunction("test");
      const block = graph.addBlock();
      const a = irConstant(1);
      const b = irConstant(2);
      const add = irInt32Add(a, b);
      block.addNode(a);
      block.addNode(b);
      block.addNode(add);
      a.uses = [];
      b.uses = [];
      graph.rebuildUses();
      expect(a.uses).toContain(add);
      expect(b.uses).toContain(add);
    });
  });

  describe("dump", () => {
    it("produces readable output with block and node info", () => {
      const graph = new CFGFunction("myFn");
      const b0 = graph.addBlock();
      const c = irConstant(42);
      b0.addNode(c);
      const ret = irReturn(c);
      b0.addNode(ret);
      const output = graph.dump();
      expect(output).toContain("myFn");
      expect(output).toContain("B0");
      expect(output).toContain("Return");
    });
  });
});

describe("IR factory functions", () => {
  describe("arithmetic", () => {
    it("binary ops wire two inputs", () => {
      const a = irConstant(3);
      const b = irConstant(4);
      for (const factory of [irInt32Add, irInt32Sub, irInt32Mul, irInt32Div, irInt32Mod]) {
        const node = factory(a, b);
        expect(node.inputs).toHaveLength(2);
      }
    });

    it("float64 ops wire two inputs", () => {
      const a = irConstant(1.5);
      const b = irConstant(2.5);
      for (const factory of [irFloat64Add, irFloat64Sub, irFloat64Mul, irFloat64Div]) {
        const node = factory(a, b);
        expect(node.inputs).toHaveLength(2);
      }
    });

    it("bitwise ops wire correctly", () => {
      const a = irConstant(0xFF);
      const b = irConstant(0x0F);
      expect(irInt32And(a, b).inputs).toHaveLength(2);
      expect(irInt32Or(a, b).inputs).toHaveLength(2);
      expect(irInt32Xor(a, b).inputs).toHaveLength(2);
      expect(irInt32Shl(a, b).inputs).toHaveLength(2);
      expect(irInt32Shr(a, b).inputs).toHaveLength(2);
      expect(irInt32Ushr(a, b).inputs).toHaveLength(2);
      expect(irInt32Not(a).inputs).toHaveLength(1);
    });
  });

  describe("comparisons", () => {
    it("int32Compare carries op", () => {
      const cmp = irInt32Compare("<", irConstant(1), irConstant(2));
      expect(cmp.props.op).toBe("<");
      expect(cmp.inputs).toHaveLength(2);
    });

    it("float64Compare carries op", () => {
      const cmp = irFloat64Compare(">=", irConstant(1.0), irConstant(2.0));
      expect(cmp.props.op).toBe(">=");
    });
  });

  describe("memory ops", () => {
    it("loadField carries offset", () => {
      const load = irLoadField(irConstant({}), 8);
      expect(load.props.offset).toBe(8);
      expect(load.inputs).toHaveLength(1);
    });

    it("storeField carries offset and value", () => {
      const store = irStoreField(irConstant({}), 4, irConstant(42));
      expect(store.props.offset).toBe(4);
      expect(store.inputs).toHaveLength(2);
    });

    it("loadElement carries elementsKind", () => {
      const arr = irConstant([]);
      const idx = irConstant(0);
      const load = irLoadElement(arr, idx, "PACKED_SMI", "int32", true);
      expect(load.props.elementsKind).toBe("PACKED_SMI");
      expect(load.props.elementRep).toBe("int32");
      expect(load.inputs).toHaveLength(2);
    });

    it("storeElement wires array, index, value", () => {
      const arr = irConstant([]);
      const idx = irConstant(0);
      const val = irConstant(1);
      const store = irStoreElement(arr, idx, val, "PACKED_SMI");
      expect(store.inputs).toHaveLength(3);
    });

    it("polymorphicLoad carries maps and offsets", () => {
      const obj = irConstant({});
      const load = irPolymorphicLoad(obj, [1, 2], [0, 4]);
      expect(load.props.maps).toEqual([1, 2]);
      expect(load.props.offsets).toEqual([0, 4]);
    });
  });

  describe("control flow", () => {
    it("branch carries trueBlock and falseBlock ids", () => {
      const b1 = new CFGBlock(1);
      const b2 = new CFGBlock(2);
      const br = irBranch(irConstant(1), b1, b2);
      expect(br.props.trueBlock).toBe(1);
      expect(br.props.falseBlock).toBe(2);
      expect(br.effectKind).toBe(EFFECT_TERMINATOR);
    });

    it("jump carries targetBlock id", () => {
      const target = new CFGBlock(5);
      const jmp = irJump(target);
      expect(jmp.props.targetBlock).toBe(5);
    });

    it("deoptimize carries reason", () => {
      const deopt = irDeoptimize("wrong-map");
      expect(deopt.props.reason).toBe("wrong-map");
      expect(deopt.effectKind).toBe(EFFECT_TERMINATOR);
    });
  });

  describe("call ops", () => {
    it("genericCall wires callee and args", () => {
      const callee = irConstant("fn");
      const call = irGenericCall(callee, [irConstant(1), irConstant(2)]);
      expect(call.inputs).toHaveLength(3);
      expect(call.props.argCount).toBe(2);
    });

    it("callKnownFunction carries target", () => {
      const target = { name: "foo" };
      const call = irCallKnownFunction(target, [irConstant(1)]);
      expect(call.props.target).toBe(target);
    });

    it("checkCallTarget carries expectedTarget", () => {
      const t = { name: "bar" };
      const node = irCheckCallTarget(irConstant("fn"), t);
      expect(node.props.expectedTarget).toBe(t);
    });
  });

  describe("box/unbox", () => {
    it("box carries fromType", () => {
      const box = irBox(irConstant(1), "int32");
      expect(box.props.fromType).toBe("int32");
      expect(box.inputs).toHaveLength(1);
    });

    it("unbox carries toType", () => {
      const unbox = irUnbox(irConstant(1), "float64");
      expect(unbox.props.toType).toBe("float64");
    });
  });

  describe("allocation", () => {
    it("newArray tracks element count", () => {
      const arr = irNewArray([irConstant(1), irConstant(2), irConstant(3)]);
      expect(arr.props.elementCount).toBe(3);
      expect(arr.inputs).toHaveLength(3);
    });

    it("newRegex carries constIdx", () => {
      const re = irNewRegex(7);
      expect(re.props.constIdx).toBe(7);
    });
  });

  describe("unary ops", () => {
    it("not wires single input", () => {
      const not = irNot(irConstant(1));
      expect(not.inputs).toHaveLength(1);
    });

    it("neg wires single input", () => {
      const neg = irNeg(irConstant(5));
      expect(neg.inputs).toHaveLength(1);
    });
  });
});
