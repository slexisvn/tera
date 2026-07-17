import * as ir from "../ir/index.js";
import { tracer } from "../../core/tracing/index.js";
import { replaceGraphFrameStateValue } from "./frame-state-values.js";

type SinkNode = ir.CFGInstruction;
type SinkBlock = ir.CFGBlock;
type SinkGraph = ir.CFGFunction;

type EscapeAnalysis = {
  fullyEscapes: boolean;
  escapePoints: SinkNode[];
  safeUses: Set<SinkNode>;
  fieldStores: Map<ir.IRMetadataValue, SinkNode>;
  propStores: Map<ir.IRMetadataValue, SinkNode>;
};

type VirtualState = {
  fields: Map<ir.IRMetadataValue, SinkNode | undefined>;
  props: Map<ir.IRMetadataValue, SinkNode | undefined>;
};

type SunkAllocationState = {
  fields: Map<ir.IRMetadataValue, SinkNode | undefined>;
  props: Map<ir.IRMetadataValue, SinkNode | undefined>;
};

function getSunkAllocations(
  node: SinkNode,
): Map<number, SunkAllocationState> {
  const existing = node.props.sunkAllocations;
  if (existing instanceof Map) {
    return existing as Map<number, SunkAllocationState>;
  }
  const created = new Map<number, SunkAllocationState>();
  node.props.sunkAllocations = created;
  return created;
}

export function allocationSinking(graph: SinkGraph): { sunkCount: number } {
  let sunkCount = 0;

  for (const block of graph.blocks) {
    const allocations: SinkNode[] = [];
    for (const node of block.nodes) {
      if (node.type === ir.IR_NEW_OBJECT) {
        allocations.push(node);
      }
    }

    for (const alloc of allocations) {
      const analysis = analyzeEscape(alloc);
      if (!analysis) continue;
      if (analysis.fullyEscapes || analysis.escapePoints.length === 0) continue;

      const onlyEscapesOnDeopt = analysis.escapePoints.every(
        (ep) => ep.type === ir.IR_DEOPTIMIZE,
      );

      if (onlyEscapesOnDeopt) {
        sinkToDeoptOnly(alloc, analysis, graph);
        sunkCount++;
        tracer.log(
          "JIT",
          `AllocationSinking: eliminated allocation v${alloc.id} - escapes only on deopt`,
        );
      }
    }
  }

  return { sunkCount };
}

function analyzeEscape(alloc: SinkNode): EscapeAnalysis {
  const safeUses = new Set<SinkNode>();
  const escapePoints: SinkNode[] = [];
  let fullyEscapes = false;
  const fieldStores = new Map<ir.IRMetadataValue, SinkNode>();
  const propStores = new Map<ir.IRMetadataValue, SinkNode>();

  for (const use of alloc.uses) {
    if (use.type === ir.IR_GENERIC_SET_PROP && use.inputs[0] === alloc) {
      safeUses.add(use);
      propStores.set(use.props.propName, use);
    } else if (use.type === ir.IR_GENERIC_GET_PROP && use.inputs[0] === alloc) {
      safeUses.add(use);
    } else if (use.type === ir.IR_CHECK_MAP && use.inputs[0] === alloc) {
      safeUses.add(use);
      for (const checkUse of use.uses) {
        if (checkUse.type === ir.IR_STORE_FIELD && checkUse.inputs[0] === use) {
          safeUses.add(checkUse);
          fieldStores.set(checkUse.props.offset, checkUse);
        } else if (
          checkUse.type === ir.IR_LOAD_FIELD &&
          checkUse.inputs[0] === use
        ) {
          safeUses.add(checkUse);
        } else {
          escapePoints.push(checkUse);
        }
      }
    } else if (use.type === ir.IR_DEOPTIMIZE) {
      escapePoints.push(use);
    } else if (use.type === ir.IR_RETURN) {
      escapePoints.push(use);
    } else {
      fullyEscapes = true;
      break;
    }
  }

  if (fullyEscapes) {
    return {
      fullyEscapes: true,
      escapePoints: [],
      safeUses,
      fieldStores,
      propStores,
    };
  }

  return {
    fullyEscapes: false,
    escapePoints,
    safeUses,
    fieldStores,
    propStores,
  };
}

function sinkToDeoptOnly(
  alloc: SinkNode,
  analysis: EscapeAnalysis,
  graph: SinkGraph,
): void {
  const virtualState = buildVirtualState(analysis);

  for (const deoptNode of analysis.escapePoints) {
    if (deoptNode.type !== ir.IR_DEOPTIMIZE) continue;
    getSunkAllocations(deoptNode).set(alloc.id, {
      fields: new Map(virtualState.fields),
      props: new Map(virtualState.props),
    });
    deoptNode.inputs = deoptNode.inputs.filter((input) => input !== alloc);
  }

  removeAllocation(alloc, analysis, graph);
}

function buildVirtualState(analysis: EscapeAnalysis): VirtualState {
  const fields = new Map<ir.IRMetadataValue, SinkNode | undefined>();
  const props = new Map<ir.IRMetadataValue, SinkNode | undefined>();

  for (const [offset, storeNode] of analysis.fieldStores) {
    fields.set(offset, storeNode.inputs[1]);
  }
  for (const [propName, storeNode] of analysis.propStores) {
    props.set(propName, storeNode.inputs[1]);
  }

  return { fields, props };
}

function removeAllocation(
  alloc: SinkNode,
  analysis: EscapeAnalysis,
  graph: SinkGraph,
): void {
  const toDelete = new Set<number>([alloc.id]);

  for (const use of analysis.safeUses) {
    toDelete.add(use.id);
  }

  alloc.inputs.forEach((inp) => {
    if (inp) inp.uses = inp.uses.filter((u) => u !== alloc);
  });

  for (const use of analysis.safeUses) {
    if (use.type === ir.IR_GENERIC_GET_PROP || use.type === ir.IR_LOAD_FIELD) {
      const replacement = findStoredValue(use, analysis);
      if (replacement) {
        for (const user of use.uses) {
          for (let j = 0; j < user.inputs.length; j++) {
            if (user.inputs[j] === use) {
              user.inputs[j] = replacement;
              replacement.uses.push(user);
            }
          }
        }
        replaceGraphFrameStateValue(graph, use, replacement);
      }
    }
  }

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!toDelete.has(node.id)) continue;
      for (const input of node.inputs) {
        if (input?.uses) input.uses = input.uses.filter((use) => use !== node);
      }
      node.uses = [];
      node.inputs = [];
    }
  }

  alloc.uses = alloc.uses.filter((use) => !analysis.escapePoints.includes(use));

  for (const graphBlock of graph.blocks) {
    graphBlock.nodes = graphBlock.nodes.filter((n) => !toDelete.has(n.id));
  }
}

function findStoredValue(
  loadNode: SinkNode,
  analysis: EscapeAnalysis,
): SinkNode | undefined | null {
  if (loadNode.type === ir.IR_LOAD_FIELD) {
    const offset = loadNode.props.offset;
    const storeNode = analysis.fieldStores.get(offset);
    return storeNode ? storeNode.inputs[1] : null;
  }
  if (loadNode.type === ir.IR_GENERIC_GET_PROP) {
    const propName = loadNode.props.propName;
    const storeNode = analysis.propStores.get(propName);
    return storeNode ? storeNode.inputs[1] : null;
  }
  return null;
}
