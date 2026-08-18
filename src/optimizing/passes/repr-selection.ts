import * as ir from "../ir/index.js";
import { isInt32 } from "../target/integer.js";
import {
  REP_BOOL,
  REP_FLOAT64,
  REP_HANDLE,
  REP_INT32,
  REP_TAGGED_NUMBER,
  type Representation,
} from "../types/representation.js";

type ReprNode = ir.CFGInstruction;
type ReprBlock = ir.CFGBlock;
type ReprGraph = ir.CFGFunction;

function nodeFromIr(value: ir.CFGInstruction): ReprNode {
  return value;
}

const isInt32Producer = (opcode: string): boolean =>
  ir.resultClassOf(opcode) === ir.RESULT_INT32;
const isBoolProducer = (opcode: string): boolean =>
  ir.resultClassOf(opcode) === ir.RESULT_BOOL;
const isFloat64Producer = (opcode: string): boolean =>
  ir.resultClassOf(opcode) === ir.RESULT_FLOAT64;
const isTaggedNumberProducer = (opcode: string): boolean =>
  ir.resultClassOf(opcode) === ir.RESULT_TAGGED_NUMBER;
const isHandleProducer = (opcode: string): boolean =>
  ir.resultClassOf(opcode) === ir.RESULT_HANDLE || isOverloadableArithmetic(opcode);
const isInt32Consumer = (opcode: string): boolean =>
  ir.operandClassOf(opcode) === ir.RESULT_INT32;
const isFloat64Consumer = (opcode: string): boolean =>
  ir.operandClassOf(opcode) === ir.RESULT_FLOAT64;
const isNumericUnlessOverloaded = (opcode: string): boolean =>
  ir.overloadOf(opcode) === ir.OVERLOAD_NUMERIC;
const isOverloadableArithmetic = (opcode: string): boolean =>
  ir.overloadOf(opcode) !== ir.OVERLOAD_NONE;

export function producesNumber(node: ReprNode): boolean {
  if (
    isInt32Producer(node.type) ||
    isFloat64Producer(node.type) ||
    isBoolProducer(node.type) ||
    isTaggedNumberProducer(node.type)
  )
    return true;
  if (node.type === ir.IR_CHECK_SMI || node.type === ir.IR_CHECK_NUMBER)
    return true;
  if (node.type === ir.IR_LOAD_ELEMENT)
    return (
      node.props.elementRep === "int32" || node.props.elementRep === "float64"
    );
  if (node.type === ir.IR_CONSTANT)
    return (
      typeof node.props.value === "number" ||
      typeof node.props.value === "boolean"
    );
  return false;
}

export function representationSelection(graph: ReprGraph): number {
  const nodeRep = new Map<number, Representation>();

  for (const param of graph.parameters) {
    nodeRep.set(param.id, REP_HANDLE);
  }

  type Demand =
    | typeof REP_INT32
    | typeof REP_FLOAT64
    | typeof REP_TAGGED_NUMBER
    | typeof REP_HANDLE
    | null;

  const joinDemand = (a: Demand, b: Demand): Demand => {
    if (a === null) return b;
    if (b === null) return a;
    if (a === b) return a;
    if (a === REP_HANDLE || b === REP_HANDLE) return REP_HANDLE;
    if (a === REP_TAGGED_NUMBER || b === REP_TAGGED_NUMBER)
      return REP_TAGGED_NUMBER;
    return REP_FLOAT64;
  };

  const demandOfUse = (use: ReprNode): Demand => {
    if (use.type === ir.IR_CHECK_SMI) return REP_INT32;
    if (use.type === ir.IR_CHECK_NUMBER) return REP_FLOAT64;
    if (use.type === ir.IR_GENERIC_MOD || use.type === ir.IR_GENERIC_COMPARE)
      return REP_TAGGED_NUMBER;
    return REP_HANDLE;
  };

  const nodeDemand = new Map<number, Demand>();
  const demandWorklist: ReprNode[] = [];
  const demandQueued = new Set<number>();

  const enqueueDemand = (node: ReprNode): void => {
    if (demandQueued.has(node.id)) return;
    demandQueued.add(node.id);
    demandWorklist.push(node);
  };

  for (const param of graph.parameters) enqueueDemand(param);
  for (const block of graph.blocks) {
    for (const node of block.nodes) enqueueDemand(node);
  }

  while (demandWorklist.length > 0) {
    const node = demandWorklist.pop()!;
    demandQueued.delete(node.id);

    let demand: Demand = null;
    for (const use of node.uses) {
      demand = joinDemand(
        demand,
        use.type === ir.IR_PHI
          ? (nodeDemand.get(use.id) ?? null)
          : demandOfUse(use),
      );
      if (demand === REP_HANDLE) break;
    }

    if (demand === (nodeDemand.get(node.id) ?? null)) continue;
    nodeDemand.set(node.id, demand);
    if (node.type === ir.IR_PHI) {
      for (const input of node.inputs) enqueueDemand(input);
    }
  }

  const acceptsUnboxedNumber = (node: ReprNode): boolean =>
    (nodeDemand.get(node.id) ?? null) !== REP_HANDLE;

  const unboxedRepForDemand = (node: ReprNode): Representation => {
    const demand = nodeDemand.get(node.id) ?? null;
    if (demand === REP_INT32) return REP_INT32;
    if (demand === REP_FLOAT64) return REP_FLOAT64;
    return REP_HANDLE;
  };

  const boxSourceType = (rep: Representation): string => {
    if (rep === REP_INT32) return "int32";
    if (rep === REP_FLOAT64) return "float64";
    if (rep === REP_BOOL) return "bool";
    return "tagged-number";
  };

  const isProvablyNumericOperand = (inp: ReprNode): boolean => {
    const rep = nodeRep.get(inp.id);
    if (
      rep === REP_INT32 ||
      rep === REP_FLOAT64 ||
      rep === REP_TAGGED_NUMBER ||
      rep === REP_BOOL
    )
      return true;
    if (producesNumber(inp)) return true;
    if (inp.type === ir.IR_PARAMETER)
      return (
        inp.uses &&
        inp.uses.some(
          (u: ReprNode) =>
            u.type === ir.IR_CHECK_SMI || u.type === ir.IR_CHECK_NUMBER,
        )
      );
    return false;
  };

  const constantRep = (value: ir.IRMetadataValue): Representation => {
    if (typeof value === "boolean") return REP_BOOL;
    if (typeof value === "number") {
      return isInt32(value) ? REP_INT32 : REP_FLOAT64;
    }
    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      typeof value === "object"
    )
      return REP_HANDLE;
    return REP_HANDLE;
  };

  const joinIncomingReps = (
    inputs: ReprNode[],
    unknownIsHandle: boolean,
  ): Representation | null => {
    let known = false;
    let hasHandle = false;
    let hasTaggedNumber = false;
    let hasFloat64 = false;
    let hasInt32 = false;
    let hasBool = false;

    for (const inp of inputs) {
      const rep = nodeRep.get(inp.id);
      if (rep === undefined) {
        if (!unknownIsHandle) continue;
        hasHandle = true;
      } else if (rep === REP_HANDLE) hasHandle = true;
      else if (rep === REP_TAGGED_NUMBER) hasTaggedNumber = true;
      else if (rep === REP_FLOAT64) hasFloat64 = true;
      else if (rep === REP_INT32) hasInt32 = true;
      else if (rep === REP_BOOL) hasBool = true;
      known = true;
    }

    if (!known) return unknownIsHandle ? REP_HANDLE : null;
    if (hasHandle) return REP_HANDLE;
    if (hasBool && (hasTaggedNumber || hasFloat64 || hasInt32))
      return REP_HANDLE;
    if (hasTaggedNumber) return REP_TAGGED_NUMBER;
    if (hasFloat64) return REP_FLOAT64;
    if (hasInt32) return REP_INT32;
    if (hasBool) return REP_BOOL;
    return REP_HANDLE;
  };

  const mergePhiRep = (inputs: ReprNode[]): Representation =>
    joinIncomingReps(inputs, true) as Representation;

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (isInt32Producer(node.type)) {
        nodeRep.set(node.id, REP_INT32);
      } else if (isBoolProducer(node.type)) {
        nodeRep.set(node.id, REP_BOOL);
      } else if (isFloat64Producer(node.type)) {
        nodeRep.set(node.id, REP_FLOAT64);
      } else if (node.type === ir.IR_CONSTANT) {
        nodeRep.set(node.id, constantRep(node.props.value));
      } else if (node.type === ir.IR_CHECK_SMI) {
        nodeRep.set(node.id, REP_INT32);
      } else if (node.type === ir.IR_CHECK_NUMBER) {
        const inRep = nodeRep.get(node.inputs[0]?.id);
        let needsFloat = inRep !== REP_INT32 && inRep !== REP_BOOL;
        for (const use of node.uses) {
          if (isFloat64Consumer(use.type)) {
            needsFloat = true;
            break;
          }
        }
        nodeRep.set(node.id, needsFloat ? REP_FLOAT64 : REP_INT32);
      } else if (node.type === ir.IR_PHI) {
        nodeRep.set(node.id, mergePhiRep(node.inputs));
      } else if (node.type === ir.IR_BOX) {
        nodeRep.set(
          node.id,
          node.props.toType === "handle"
            ? REP_HANDLE
            : node.props.fromType === "handle"
              ? REP_HANDLE
              : REP_TAGGED_NUMBER,
        );
      } else if (node.type === ir.IR_UNBOX) {
        nodeRep.set(
          node.id,
          node.props.toType === "float64"
            ? REP_FLOAT64
            : node.props.toType === "bool"
              ? REP_BOOL
              : REP_INT32,
        );
      } else if (node.type === ir.IR_LOAD_ELEMENT) {
        if (node.props.elementRep === "int32") nodeRep.set(node.id, REP_INT32);
        else if (node.props.elementRep === "float64")
          nodeRep.set(node.id, REP_FLOAT64);
        else nodeRep.set(node.id, REP_HANDLE);
      } else if (
        node.type === ir.IR_LOAD_FIELD ||
        node.type === ir.IR_POLYMORPHIC_LOAD
      ) {
        nodeRep.set(
          node.id,
          acceptsUnboxedNumber(node) ? REP_TAGGED_NUMBER : REP_HANDLE,
        );
      } else if (
        node.type === ir.IR_CHECK_MAP ||
        node.type === ir.IR_CHECK_ARRAY ||
        node.type === ir.IR_CHECK_ELEMENTS_KIND ||
        node.type === ir.IR_CHECK_BOUNDS
      ) {
        const inputRep = nodeRep.get(node.inputs[0]?.id);
        nodeRep.set(node.id, inputRep || REP_HANDLE);
      } else if (node.type === ir.IR_NEG) {
        const inputRep = nodeRep.get(node.inputs[0]?.id);
        nodeRep.set(
          node.id,
          inputRep === REP_INT32 || inputRep === REP_BOOL
            ? REP_INT32
            : REP_FLOAT64,
        );
      } else if (
        isTaggedNumberProducer(node.type) ||
        (isNumericUnlessOverloaded(node.type) &&
          node.inputs.every(isProvablyNumericOperand))
      ) {
        nodeRep.set(node.id, REP_TAGGED_NUMBER);
      } else if (
        node.type === ir.IR_GENERIC_CALL ||
        node.type === ir.IR_CALL_KNOWN_FUNCTION
      ) {
        nodeRep.set(node.id, unboxedRepForDemand(node));
      } else if (isOpaqueIntrinsicResult(node)) {
        nodeRep.set(node.id, REP_HANDLE);
      } else if (isHandleProducer(node.type)) {
        const operandsNumeric =
          !isOverloadableArithmetic(node.type) ||
          node.inputs.every(isProvablyNumericOperand);
        nodeRep.set(
          node.id,
          operandsNumeric ? unboxedRepForDemand(node) : REP_HANDLE,
        );
      } else {
        nodeRep.set(node.id, REP_HANDLE);
      }
    }
  }

  for (const param of graph.parameters) {
    let rep = nodeRep.get(param.id) || REP_HANDLE;
    for (const use of param.uses) {
      if (
        use.type === ir.IR_CHECK_MAP ||
        use.type === ir.IR_CHECK_ARRAY ||
        use.type === ir.IR_CHECK_ELEMENTS_KIND
      ) {
        rep = REP_HANDLE;
        break;
      }
      if (use.type === ir.IR_CHECK_NUMBER || isFloat64Consumer(use.type))
        rep = REP_FLOAT64;
      else if (use.type === ir.IR_CHECK_SMI || isInt32Consumer(use.type))
        rep = rep === REP_FLOAT64 ? REP_FLOAT64 : REP_INT32;
    }
    nodeRep.set(param.id, rep);
  }

  const reflowPhiRepresentations = (): void => {
    const blockParams: ReprNode[] = [];
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (node.type === ir.IR_PHI) blockParams.push(node);
      }
    }

    const reflowWorklist: ReprNode[] = [];
    const reflowQueued = new Set<number>();
    const enqueueReflow = (param: ReprNode): void => {
      if (reflowQueued.has(param.id)) return;
      reflowQueued.add(param.id);
      reflowWorklist.push(param);
    };

    for (const param of blockParams) {
      nodeRep.delete(param.id);
      enqueueReflow(param);
    }

    while (reflowWorklist.length > 0) {
      const param = reflowWorklist.pop()!;
      reflowQueued.delete(param.id);
      const rep = joinIncomingReps(param.inputs, false);
      if (rep === null || rep === nodeRep.get(param.id)) continue;
      nodeRep.set(param.id, rep);
      for (const use of param.uses) {
        if (use.type === ir.IR_PHI) enqueueReflow(use);
      }
    }

    for (const param of blockParams) {
      if (!nodeRep.has(param.id)) nodeRep.set(param.id, REP_HANDLE);
    }
  };

  reflowPhiRepresentations();

  const returnedValues: ReprNode[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === ir.IR_RETURN && node.inputs[0])
        returnedValues.push(node.inputs[0]);
    }
  }
  const returnRep = joinIncomingReps(returnedValues, true) as Representation;

  let insertCount = 0;

  const getExpectedInputRep = (
    consumer: ReprNode,
    inputIndex: number,
  ): Representation | null => {
    if (isInt32Consumer(consumer.type)) return REP_INT32;
    if (isFloat64Consumer(consumer.type)) return REP_FLOAT64;
    if (consumer.type === ir.IR_RETURN) return returnRep;
    if (consumer.type === ir.IR_CHECK_SMI) return REP_INT32;
    if (consumer.type === ir.IR_CHECK_NUMBER) return REP_FLOAT64;
    if (consumer.type === ir.IR_BRANCH) return REP_BOOL;
    if (
      consumer.type === ir.IR_STORE_FIELD ||
      consumer.type === ir.IR_STORE_ELEMENT
    ) {
      if (consumer.type === ir.IR_STORE_FIELD && inputIndex === 1)
        return (
          nodeRep.get(consumer.inputs[inputIndex]?.id) || REP_TAGGED_NUMBER
        );
      if (consumer.type === ir.IR_STORE_ELEMENT && inputIndex === 1)
        return REP_INT32;
      if (consumer.type === ir.IR_STORE_ELEMENT && inputIndex === 2) {
        if (consumer.props.elementRep === "int32") return REP_INT32;
        if (consumer.props.elementRep === "float64") return REP_FLOAT64;
        return REP_HANDLE;
      }
    }
    if (consumer.type === ir.IR_LOAD_ELEMENT && inputIndex === 1) return REP_INT32;
    if (consumer.type === ir.IR_CHECK_BOUNDS && inputIndex === 0) return REP_INT32;
    if (consumer.type === ir.IR_TYPEOF) return REP_HANDLE;
    if (consumer.type === ir.IR_CHECK_CALL_TARGET) return REP_HANDLE;
    if (consumer.type === ir.IR_NOT)
      return nodeRep.get(consumer.inputs[inputIndex]?.id) || REP_HANDLE;
    if (consumer.type === ir.IR_NEG) {
      const inputRep = nodeRep.get(consumer.inputs[inputIndex]?.id);
      if (inputRep === REP_HANDLE || inputRep === REP_TAGGED_NUMBER)
        return inputRep;
      return inputRep === REP_INT32 || inputRep === REP_BOOL
        ? REP_INT32
        : REP_FLOAT64;
    }
    if (consumer.type === ir.IR_GENERIC_COMPARE) return REP_HANDLE;
    if (
      consumer.type === ir.IR_GENERIC_BITAND ||
      consumer.type === ir.IR_GENERIC_BITOR ||
      consumer.type === ir.IR_GENERIC_BITXOR ||
      consumer.type === ir.IR_GENERIC_SHL ||
      consumer.type === ir.IR_GENERIC_SHR ||
      consumer.type === ir.IR_GENERIC_USHR ||
      consumer.type === ir.IR_GENERIC_BITNOT
    ) {
      return REP_FLOAT64;
    }
    if (
      consumer.type === ir.IR_GENERIC_MOD ||
      (isNumericUnlessOverloaded(consumer.type) &&
        consumer.inputs.every(isProvablyNumericOperand))
    ) {
      return REP_TAGGED_NUMBER;
    }
    if (
      isOverloadableArithmetic(consumer.type) ||
      consumer.type === ir.IR_GENERIC_CALL ||
      consumer.type === ir.IR_CALL_KNOWN_FUNCTION ||
      consumer.type === ir.IR_GENERIC_GET_PROP ||
      consumer.type === ir.IR_GENERIC_SET_PROP ||
      consumer.type === ir.IR_GENERIC_DELETE_PROP ||
      consumer.type === ir.IR_GENERIC_GET_INDEX ||
      consumer.type === ir.IR_GENERIC_SET_INDEX ||
      consumer.type === ir.IR_NEW_ARRAY ||
      consumer.type === ir.IR_MAKE_CLOSURE ||
      consumer.type === ir.IR_STORE_CONTEXT_SLOT ||
      consumer.type === ir.IR_STORE_GLOBAL
    ) {
      return nodeRep.get(consumer.inputs[inputIndex]?.id) || REP_HANDLE;
    }
    if (consumer.type === ir.IR_PHI) {
      return nodeRep.get(consumer.id) || REP_HANDLE;
    }
    return null;
  };

  const makeConversion = (
    input: ReprNode,
    producerRep: Representation,
    expectedRep: Representation,
    frameState: ReprNode["frameState"],
  ): ReprNode | null => {
    if (producerRep === REP_INT32 && expectedRep === REP_TAGGED_NUMBER) {
      const boxNode = nodeFromIr(ir.irBox(input, "int32"));
      boxNode.frameState = frameState;
      nodeRep.set(boxNode.id, REP_TAGGED_NUMBER);
      insertCount++;
      return boxNode;
    }
    if (producerRep === REP_FLOAT64 && expectedRep === REP_TAGGED_NUMBER) {
      const boxNode = nodeFromIr(ir.irBox(input, "float64"));
      boxNode.frameState = frameState;
      nodeRep.set(boxNode.id, REP_TAGGED_NUMBER);
      insertCount++;
      return boxNode;
    }
    if (producerRep === REP_BOOL && expectedRep === REP_INT32) {
      return null;
    }
    if (producerRep === REP_INT32 && expectedRep === REP_BOOL) {
      return null;
    }
    if (
      (producerRep === REP_TAGGED_NUMBER || producerRep === REP_HANDLE) &&
      expectedRep === REP_BOOL
    ) {
      const unboxNode = nodeFromIr(ir.irUnbox(input, "bool"));
      unboxNode.frameState = frameState;
      nodeRep.set(unboxNode.id, REP_BOOL);
      insertCount++;
      return unboxNode;
    }
    if (
      (producerRep === REP_TAGGED_NUMBER || producerRep === REP_HANDLE) &&
      expectedRep === REP_INT32
    ) {
      const unboxNode = nodeFromIr(ir.irUnbox(input, "int32"));
      unboxNode.frameState = frameState;
      nodeRep.set(unboxNode.id, REP_INT32);
      insertCount++;
      return unboxNode;
    }
    if (
      (producerRep === REP_TAGGED_NUMBER || producerRep === REP_HANDLE) &&
      expectedRep === REP_FLOAT64
    ) {
      const unboxNode = nodeFromIr(ir.irUnbox(input, "float64"));
      unboxNode.frameState = frameState;
      nodeRep.set(unboxNode.id, REP_FLOAT64);
      insertCount++;
      return unboxNode;
    }
    if (
      expectedRep === REP_HANDLE &&
      (producerRep === REP_INT32 ||
        producerRep === REP_FLOAT64 ||
        producerRep === REP_TAGGED_NUMBER ||
        producerRep === REP_BOOL)
    ) {
      const boxNode = nodeFromIr(ir.irBox(input, boxSourceType(producerRep)));
      boxNode.props.toType = "handle";
      boxNode.frameState = frameState;
      nodeRep.set(boxNode.id, REP_HANDLE);
      insertCount++;
      return boxNode;
    }
    return null;
  };

  const insertBeforeTerminator = (block: ReprBlock, node: ReprNode): void => {
    node.block = block;
    const terminator = block.getTerminator();
    const index = terminator ? block.nodes.indexOf(terminator) : -1;
    block.nodes.splice(index >= 0 ? index : block.nodes.length, 0, node);
  };

  for (const block of graph.blocks) {
    for (const phi of block.phis) {
      const expectedRep = nodeRep.get(phi.id) || REP_HANDLE;
      for (let i = 0; i < phi.inputs.length; i++) {
        const input = phi.inputs[i];
        const producerRep = nodeRep.get(input.id);
        if (!producerRep || producerRep === expectedRep) continue;
        const conversion = makeConversion(
          input,
          producerRep,
          expectedRep,
          phi.frameState,
        );
        if (!conversion) continue;
        const predecessor = block.predecessors[i];
        const insertionBlock =
          input.type === ir.IR_CONSTANT && input.block && input.block !== block
            ? input.block
            : predecessor ?? block;
        insertBeforeTerminator(insertionBlock, conversion);
        phi.replaceInput(i, conversion);
      }
    }
  }

  for (const block of graph.blocks) {
    const result: ReprNode[] = [];
    for (const node of block.nodes) {
      if (node.type === ir.IR_PHI) {
        result.push(node);
        continue;
      }
      const pending: ReprNode[] = [];
      for (let i = 0; i < node.inputs.length; i++) {
        const input = node.inputs[i];
        const producerRep = nodeRep.get(input.id);
        const expectedRep = getExpectedInputRep(node, i);

        if (!expectedRep || !producerRep || producerRep === expectedRep)
          continue;

        const conversion = makeConversion(
          input,
          producerRep,
          expectedRep,
          node.frameState,
        );
        if (!conversion) continue;
        node.replaceInput(i, conversion);
        pending.push(conversion);
      }

      for (const p of pending) {
        p.block = block;
        result.push(p);
      }
      result.push(node);
    }
    block.nodes = result;
  }

  const nodeById = new Map<number, ReprNode>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      nodeById.set(node.id, node);
    }
  }
  for (const param of graph.parameters) {
    nodeById.set(param.id, param);
  }

  for (const [nodeId, rep] of nodeRep) {
    const node = nodeById.get(nodeId);
    if (node) node.props._rep = rep;
  }

  return insertCount;
}

function isOpaqueIntrinsicResult(node: ReprNode): boolean {
  if (node.type !== ir.IR_CALL_INTRINSIC) return false;
  const returns = node.props.returns;
  if (returns === "T" || returns === "any") return true;
  if (typeof returns === "string" && returns.startsWith("Reactive")) return true;
  const effects = node.props.declaredEffects;
  return Array.isArray(effects) && effects.length === 1 && effects[0] === "reactive-read";
}
