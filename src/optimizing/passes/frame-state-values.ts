import type { FrameState, FrameValue } from "../../deopt/frame-state.js";

type ValueWithId = {
  id?: number;
};

type ReplaceValue = (next: FrameValue) => void;
type FrameStateVisitor = (value: FrameValue | null | undefined, replace: ReplaceValue) => void;

type FrameStateNode = {
  frameState?: FrameState | null;
};

type FrameStateBlock = {
  nodes: FrameStateNode[];
};

type FrameStateIndexLocation = {
  replace: ReplaceValue;
};

type FrameStateGraph = {
  blocks: FrameStateBlock[];
  _frameStateIndex?: Map<FrameValue, FrameStateIndexLocation[]> | null;
};

export function visitFrameStateValues(
  frameState: FrameState | null | undefined,
  visitor: FrameStateVisitor,
  seen = new Set<FrameState>(),
): void {
  if (!frameState || seen.has(frameState)) return;
  seen.add(frameState);

  for (const [slot, value] of frameState.localValues || []) {
    visitor(value, (next) => frameState.localValues?.set(slot, next));
  }

  const stackValues = frameState.stackValues || [];
  for (let i = 0; i < stackValues.length; i++) {
    visitor(stackValues[i], (next) => {
      stackValues[i] = next;
    });
  }

  visitor(frameState.thisValue, (next) => {
    frameState.thisValue = next;
  });

  visitFrameStateValues(frameState.callerFrameState, visitor, seen);
}

export function visitGraphFrameStateValues(
  graph: FrameStateGraph,
  visitor: FrameStateVisitor,
): void {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.frameState) {
        visitFrameStateValues(node.frameState, visitor);
      }
    }
  }
}

export function replaceGraphFrameStateValue(
  graph: FrameStateGraph,
  oldNode: FrameValue,
  newNode: FrameValue,
): void {
  if (graph._frameStateIndex) {
    const locations = graph._frameStateIndex.get(oldNode);
    if (!locations) return;
    for (const { replace } of locations) replace(newNode);
    graph._frameStateIndex.delete(oldNode);
    let newLocations = graph._frameStateIndex.get(newNode);
    if (!newLocations) {
      newLocations = [];
      graph._frameStateIndex.set(newNode, newLocations);
    }
    for (const loc of locations) {
      newLocations.push({ replace: loc.replace });
    }
    return;
  }
  visitGraphFrameStateValues(graph, (value, replace) => {
    if (value === oldNode) replace(newNode);
  });
}

export function buildFrameStateIndex(graph: FrameStateGraph): void {
  const index = new Map<FrameValue, FrameStateIndexLocation[]>();
  const record: FrameStateVisitor = (value, replace) => {
    if (!value || typeof value !== "object") return;
    if ((value as ValueWithId).id === undefined) return;
    let locs = index.get(value);
    if (!locs) {
      locs = [];
      index.set(value, locs);
    }
    locs.push({ replace });
  };
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.frameState) {
        visitFrameStateValues(node.frameState, record);
      }
    }
  }
  graph._frameStateIndex = index;
}

export function clearFrameStateIndex(graph: FrameStateGraph): void {
  graph._frameStateIndex = null;
}

export function markFrameStateValues<T extends ValueWithId>(
  frameState: FrameState,
  liveNodes: Set<number>,
  worklist: T[],
): void {
  visitFrameStateValues(frameState, (value) => {
    const candidate = value as T | null | undefined;
    if (candidate && candidate.id !== undefined && !liveNodes.has(candidate.id)) {
      liveNodes.add(candidate.id);
      worklist.push(candidate);
    }
  });
}
