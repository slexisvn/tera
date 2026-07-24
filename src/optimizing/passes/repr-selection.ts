import * as ir from "../ir/index.js";

export const REP_INT32 = "int32";
export const REP_FLOAT64 = "float64";
export const REP_TAGGED_NUMBER = "tagged-number";
export const REP_HANDLE = "handle";
export const REP_BOOL = "bool";

export type Representation =
  | typeof REP_INT32
  | typeof REP_FLOAT64
  | typeof REP_TAGGED_NUMBER
  | typeof REP_HANDLE
  | typeof REP_BOOL;

type ReprNode = ir.CFGInstruction;
type ReprBlock = ir.CFGBlock;
type ReprGraph = ir.CFGFunction;

function nodeFromIr(value: ir.CFGInstruction): ReprNode {
  return value;
}

const INT32_PRODUCERS = new Set([
  ir.IR_INT32_ADD,
  ir.IR_INT32_SUB,
  ir.IR_INT32_MUL,
  ir.IR_INT32_DIV,
  ir.IR_INT32_MOD,
  ir.IR_INT32_SHL,
  ir.IR_INT32_SHR,
  ir.IR_INT32_AND,
  ir.IR_LOAD_ARRAY_LENGTH,
  ir.IR_GENERIC_BITAND,
  ir.IR_GENERIC_BITOR,
  ir.IR_GENERIC_BITXOR,
  ir.IR_GENERIC_SHL,
  ir.IR_GENERIC_SHR,
  ir.IR_GENERIC_BITNOT,
]);

const BOOL_PRODUCERS = new Set([
  ir.IR_INT32_COMPARE,
  ir.IR_FLOAT64_COMPARE,
  ir.IR_GENERIC_COMPARE,
  ir.IR_CHECK_CALL_TARGET,
  ir.IR_NOT,
]);

const FLOAT64_PRODUCERS = new Set([
  ir.IR_FLOAT64_ADD,
  ir.IR_FLOAT64_SUB,
  ir.IR_FLOAT64_MUL,
  ir.IR_FLOAT64_DIV,
]);

const INT32_CONSUMERS = new Set([
  ir.IR_INT32_ADD,
  ir.IR_INT32_SUB,
  ir.IR_INT32_MUL,
  ir.IR_INT32_DIV,
  ir.IR_INT32_MOD,
  ir.IR_INT32_SHL,
  ir.IR_INT32_SHR,
  ir.IR_INT32_AND,
  ir.IR_INT32_COMPARE,
]);

const FLOAT64_CONSUMERS = new Set([
  ir.IR_FLOAT64_ADD,
  ir.IR_FLOAT64_SUB,
  ir.IR_FLOAT64_MUL,
  ir.IR_FLOAT64_DIV,
  ir.IR_FLOAT64_COMPARE,
]);

const NUMERIC_UNLESS_OVERLOADED = new Set([
  ir.IR_GENERIC_SUB,
  ir.IR_GENERIC_MUL,
  ir.IR_GENERIC_DIV,
  ir.IR_GENERIC_POW,
]);

const OVERLOADABLE_ARITHMETIC = new Set([
  ir.IR_GENERIC_ADD,
  ...NUMERIC_UNLESS_OVERLOADED,
]);

const TAGGED_NUMBER_PRODUCERS = new Set([
  ir.IR_GENERIC_MOD,
  ir.IR_GENERIC_USHR,
]);

const HANDLE_PRODUCERS = new Set([
  ...OVERLOADABLE_ARITHMETIC,
  ir.IR_GENERIC_GET_PROP,
  ir.IR_GENERIC_SET_PROP,
  ir.IR_GENERIC_GET_INDEX,
  ir.IR_GENERIC_SET_INDEX,
  ir.IR_LOAD_GLOBAL,
  ir.IR_LOAD_LOCAL,
  ir.IR_LOAD_CONST,
  ir.IR_NEW_OBJECT,
  ir.IR_NEW_ARRAY,
  ir.IR_CALL_BUILTIN,
  ir.IR_TYPEOF,
]);

export function producesNumber(node: ReprNode): boolean {
  if (
    INT32_PRODUCERS.has(node.type) ||
    FLOAT64_PRODUCERS.has(node.type) ||
    BOOL_PRODUCERS.has(node.type) ||
    TAGGED_NUMBER_PRODUCERS.has(node.type)
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
      if (
        Number.isInteger(value) &&
        value >= -2147483648 &&
        value <= 2147483647
      )
        return REP_INT32;
      return REP_FLOAT64;
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
      if (INT32_PRODUCERS.has(node.type)) {
        nodeRep.set(node.id, REP_INT32);
      } else if (BOOL_PRODUCERS.has(node.type)) {
        nodeRep.set(node.id, REP_BOOL);
      } else if (FLOAT64_PRODUCERS.has(node.type)) {
        nodeRep.set(node.id, REP_FLOAT64);
      } else if (node.type === ir.IR_CONSTANT) {
        nodeRep.set(node.id, constantRep(node.props.value));
      } else if (node.type === ir.IR_CHECK_SMI) {
        nodeRep.set(node.id, REP_INT32);
      } else if (node.type === ir.IR_CHECK_NUMBER) {
        const inRep = nodeRep.get(node.inputs[0]?.id);
        let needsFloat = inRep !== REP_INT32 && inRep !== REP_BOOL;
        for (const use of node.uses) {
          if (FLOAT64_CONSUMERS.has(use.type)) {
            needsFloat = true;
            break;
          }
        }
        nodeRep.set(node.id, needsFloat ? REP_FLOAT64 : REP_INT32);
      } else if (node.type === ir.IR_PHI) {
        nodeRep.set(node.id, mergePhiRep(ir.blockParamIncoming(node)));
      } else if (node.type === ir.IR_BOX) {
        nodeRep.set(
          node.id,
          node.props.fromType === "handle" ? REP_HANDLE : REP_TAGGED_NUMBER,
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
        TAGGED_NUMBER_PRODUCERS.has(node.type) ||
        (NUMERIC_UNLESS_OVERLOADED.has(node.type) &&
          node.inputs.every(isProvablyNumericOperand))
      ) {
        nodeRep.set(node.id, REP_TAGGED_NUMBER);
      } else if (node.type === ir.IR_GENERIC_CALL) {
        nodeRep.set(node.id, unboxedRepForDemand(node));
      } else if (HANDLE_PRODUCERS.has(node.type)) {
        const operandsNumeric =
          !OVERLOADABLE_ARITHMETIC.has(node.type) ||
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
      if (use.type === ir.IR_CHECK_NUMBER || FLOAT64_CONSUMERS.has(use.type))
        rep = REP_FLOAT64;
      else if (use.type === ir.IR_CHECK_SMI || INT32_CONSUMERS.has(use.type))
        rep = rep === REP_FLOAT64 ? REP_FLOAT64 : REP_INT32;
    }
    nodeRep.set(param.id, rep);
  }

  let insertCount = 0;

  const getExpectedInputRep = (
    consumer: ReprNode,
    inputIndex: number,
  ): Representation | null => {
    if (INT32_CONSUMERS.has(consumer.type)) return REP_INT32;
    if (FLOAT64_CONSUMERS.has(consumer.type)) return REP_FLOAT64;
    if (consumer.type === ir.IR_RETURN)
      return nodeRep.get(consumer.inputs[inputIndex]?.id) || REP_HANDLE;
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
      (NUMERIC_UNLESS_OVERLOADED.has(consumer.type) &&
        consumer.inputs.every(isProvablyNumericOperand))
    ) {
      return REP_TAGGED_NUMBER;
    }
    if (
      OVERLOADABLE_ARITHMETIC.has(consumer.type) ||
      consumer.type === ir.IR_GENERIC_CALL ||
      consumer.type === ir.IR_GENERIC_GET_PROP ||
      consumer.type === ir.IR_GENERIC_SET_PROP ||
      consumer.type === ir.IR_GENERIC_GET_INDEX ||
      consumer.type === ir.IR_GENERIC_SET_INDEX ||
      consumer.type === ir.IR_NEW_ARRAY ||
      consumer.type === ir.IR_STORE_GLOBAL
    ) {
      return nodeRep.get(consumer.inputs[inputIndex]?.id) || REP_HANDLE;
    }
    if (consumer.type === ir.IR_PHI) {
      return nodeRep.get(consumer.id) || REP_HANDLE;
    }
    return null;
  };

  for (const block of graph.blocks) {
    const result: ReprNode[] = [];
    for (const node of block.nodes) {
      const pending: ReprNode[] = [];
      for (let i = 0; i < node.inputs.length; i++) {
        const input = node.inputs[i];
        const producerRep = nodeRep.get(input.id);
        const expectedRep = getExpectedInputRep(node, i);

        if (!expectedRep || !producerRep || producerRep === expectedRep)
          continue;

        if (producerRep === REP_INT32 && expectedRep === REP_TAGGED_NUMBER) {
          const boxNode = nodeFromIr(ir.irBox(input, "int32"));
          boxNode.frameState = node.frameState;
          nodeRep.set(boxNode.id, REP_TAGGED_NUMBER);
          node.replaceInput(i, boxNode);
          pending.push(boxNode);
          insertCount++;
        } else if (
          producerRep === REP_FLOAT64 &&
          expectedRep === REP_TAGGED_NUMBER
        ) {
          const boxNode = nodeFromIr(ir.irBox(input, "float64"));
          boxNode.frameState = node.frameState;
          nodeRep.set(boxNode.id, REP_TAGGED_NUMBER);
          node.replaceInput(i, boxNode);
          pending.push(boxNode);
          insertCount++;
        } else if (producerRep === REP_BOOL && expectedRep === REP_INT32) {
          nodeRep.set(input.id, REP_INT32);
        } else if (producerRep === REP_INT32 && expectedRep === REP_BOOL) {
          nodeRep.set(input.id, REP_BOOL);
        } else if (
          (producerRep === REP_TAGGED_NUMBER || producerRep === REP_HANDLE) &&
          expectedRep === REP_BOOL
        ) {
          const unboxNode = nodeFromIr(ir.irUnbox(input, "bool"));
          unboxNode.frameState = node.frameState;
          nodeRep.set(unboxNode.id, REP_BOOL);
          node.replaceInput(i, unboxNode);
          pending.push(unboxNode);
          insertCount++;
        } else if (
          (producerRep === REP_TAGGED_NUMBER || producerRep === REP_HANDLE) &&
          expectedRep === REP_INT32
        ) {
          const unboxNode = nodeFromIr(ir.irUnbox(input, "int32"));
          unboxNode.frameState = node.frameState;
          nodeRep.set(unboxNode.id, REP_INT32);
          node.replaceInput(i, unboxNode);
          pending.push(unboxNode);
          insertCount++;
        } else if (
          (producerRep === REP_TAGGED_NUMBER || producerRep === REP_HANDLE) &&
          expectedRep === REP_FLOAT64
        ) {
          const unboxNode = nodeFromIr(ir.irUnbox(input, "float64"));
          unboxNode.frameState = node.frameState;
          nodeRep.set(unboxNode.id, REP_FLOAT64);
          node.replaceInput(i, unboxNode);
          pending.push(unboxNode);
          insertCount++;
        }
      }

      for (const p of pending) {
        p.block = block;
        result.push(p);
      }
      result.push(node);
    }
    block.nodes = result;
  }

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
    const rep = joinIncomingReps(ir.blockParamIncoming(param), false);
    if (rep === null || rep === nodeRep.get(param.id)) continue;
    nodeRep.set(param.id, rep);
    for (const use of param.uses) {
      if (use.type === ir.IR_PHI) enqueueReflow(use);
    }
  }

  for (const param of blockParams) {
    if (!nodeRep.has(param.id)) nodeRep.set(param.id, REP_HANDLE);
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
