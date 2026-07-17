import {
  FeedbackSlot,
  FeedbackVector,
  type CallTargetProfile,
  IC_MEGAMORPHIC,
  IC_MONOMORPHIC,
  IC_POLYMORPHIC,
} from "../vector/index.js";
import {
  anyType,
  arrayType,
  booleanType,
  doubleType,
  joinTypes,
  nullishType,
  numberType,
  objectType,
  smiType,
  stringType,
} from "../../optimizing/types/lattice.js";
import type { LatticeType } from "../../optimizing/types/lattice.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";

export const FEEDBACK_HINT_GENERIC = "generic";
export const FEEDBACK_HINT_MONOMORPHIC = "monomorphic";
export const FEEDBACK_HINT_POLYMORPHIC = "polymorphic";
export const FEEDBACK_HINT_MEGAMORPHIC = "megamorphic";

type FeedbackHint =
  | typeof FEEDBACK_HINT_GENERIC
  | typeof FEEDBACK_HINT_MONOMORPHIC
  | typeof FEEDBACK_HINT_POLYMORPHIC
  | typeof FEEDBACK_HINT_MEGAMORPHIC;

export type BinaryOpHint = {
  slot: FeedbackSlot | null;
  inputType: LatticeType;
  state: string;
  stable: boolean;
};

export type PropertyHint = {
  slot: FeedbackSlot | null;
  kind: FeedbackHint;
  stable?: boolean;
  objectType?: LatticeType;
  map?: number | null;
  mapVersion?: number | null;
  offset?: number | null;
  protoDepth?: number | null;
  maps?: number[];
  mapVersions?: number[];
  offsets?: number[];
  protoDepths?: number[];
};

export type ElementsHint = {
  slot: FeedbackSlot | null;
  kind: FeedbackHint;
  arrayType?: LatticeType;
  arrayAccess?: boolean;
  lengthAccess?: boolean;
  elementsKind?: string | null;
  observedKinds?: string[];
  stable?: boolean;
};

export type CallHint = {
  slot: FeedbackSlot | null;
  kind: FeedbackHint;
  target?: string | number | null;
  targets?: CallTargetProfile[] | null;
  targetVersion?: number | null;
  argCount?: number | null;
  receiverMap?: number | null;
  receiverMapVersion?: number | null;
  targetRef?: RegisterCompiledFunction | null;
  frequency: number;
  stable?: boolean;
};

export type BranchHint = {
  slot: FeedbackSlot | null;
  bias: string;
  stable: boolean;
};

const makeArrayType = arrayType as (elementsKind?: string | null) => LatticeType;
const makeObjectType = objectType as (mapId?: number | null) => LatticeType;
const mergeTypes = joinTypes as (left: LatticeType | null, right: LatticeType) => LatticeType;

export class FeedbackNexus {
  vector: FeedbackVector | null;

  constructor(vector: FeedbackVector | null) {
    this.vector = vector;
  }

  getSlot(index: number): FeedbackSlot | null {
    if (index < 0 || !this.vector) return null;
    return this.vector.getSlot(index);
  }

  binaryOp(index: number): BinaryOpHint {
    const slot = this.getSlot(index);
    return {
      slot,
      inputType: observedBinaryType(slot),
      state: slot ? slot.icState : FEEDBACK_HINT_GENERIC,
      stable: isStableSlot(slot),
    };
  }

  unaryOp(index: number): BinaryOpHint {
    const slot = this.getSlot(index);
    return {
      slot,
      inputType: observedUnaryType(slot),
      state: slot ? slot.icState : FEEDBACK_HINT_GENERIC,
      stable: isStableSlot(slot),
    };
  }

  property(index: number): PropertyHint {
    const slot = this.getSlot(index);
    if (!slot) return { slot: null, kind: FEEDBACK_HINT_GENERIC };
    if (slot.icState === IC_MONOMORPHIC) {
      return {
        slot,
        kind: FEEDBACK_HINT_MONOMORPHIC,
        objectType: objectHintType(slot),
        map: slot.getMonomorphicMap(),
        mapVersion: slot.getMonomorphicMapVersion(),
        offset: slot.getMonomorphicOffset(),
        protoDepth: slot.getMonomorphicProtoDepth(),
        stable: isStableSlot(slot),
      };
    }
    if (slot.icState === IC_POLYMORPHIC) {
      return {
        slot,
        kind: FEEDBACK_HINT_POLYMORPHIC,
        maps: slot.getPolymorphicMaps() || [],
        mapVersions: slot.getPolymorphicMapVersions() || [],
        offsets: slot.getPolymorphicOffsets() || [],
        protoDepths: slot.getPolymorphicProtoDepths() || [],
        stable: isStableSlot(slot),
      };
    }
    if (slot.icState === IC_MEGAMORPHIC) {
      return { slot, kind: FEEDBACK_HINT_MEGAMORPHIC, stable: false };
    }
    return { slot, kind: FEEDBACK_HINT_GENERIC, stable: isStableSlot(slot) };
  }

  elements(index: number): ElementsHint {
    const slot = this.getSlot(index);
    if (!slot) return { slot: null, kind: FEEDBACK_HINT_GENERIC };
    const kinds = slot.getObservedElementsKinds();
    const elementsKind = slot.getMonomorphicElementsKind();
    const arrayAccess = slot.hasOnlyArrayAccesses();
    const lengthAccess = slot.hasOnlyArrayLengthAccesses();
    return {
      slot,
      kind:
        slot.icState === IC_MEGAMORPHIC
          ? FEEDBACK_HINT_MEGAMORPHIC
          : elementsKind
            ? FEEDBACK_HINT_MONOMORPHIC
            : FEEDBACK_HINT_POLYMORPHIC,
      arrayType: makeArrayType(elementsKind),
      arrayAccess,
      lengthAccess,
      elementsKind,
      observedKinds: kinds,
      stable: isStableSlot(slot),
    };
  }

  call(index: number): CallHint {
    const slot = this.getSlot(index);
    if (!slot)
      return {
        slot: null,
        kind: FEEDBACK_HINT_GENERIC,
        target: null,
        targets: null,
        frequency: 0,
      };
    if (slot.icState === IC_MONOMORPHIC) {
      return {
        slot,
        kind: FEEDBACK_HINT_MONOMORPHIC,
        target: slot.getMonomorphicCallTarget(),
        targetVersion: slot.getMonomorphicCallTargetVersion(),
        argCount: slot.getMonomorphicCallArgCount(),
        receiverMap: slot.getMonomorphicReceiverMap(),
        receiverMapVersion:
          slot.callReceiverMapVersions.length === 1
            ? slot.callReceiverMapVersions[0]
            : null,
        targetRef: slot.getMonomorphicCallTargetRef(),
        frequency: slot.totalCallCount,
        stable: isStableSlot(slot),
      };
    }
    if (slot.icState === IC_POLYMORPHIC) {
      return {
        slot,
        kind: FEEDBACK_HINT_POLYMORPHIC,
        targets: slot.getPolymorphicCallTargets() || [],
        argCount: slot.getMonomorphicCallArgCount(),
        frequency: slot.totalCallCount,
        stable: isStableSlot(slot),
      };
    }
    if (slot.icState === IC_MEGAMORPHIC) {
      return {
        slot,
        kind: FEEDBACK_HINT_MEGAMORPHIC,
        target: null,
        targets: null,
        frequency: slot.totalCallCount,
        stable: false,
      };
    }
    return {
      slot,
      kind: FEEDBACK_HINT_GENERIC,
      target: null,
      targets: null,
      frequency: slot.totalCallCount,
      stable: isStableSlot(slot),
    };
  }

  branch(index: number): BranchHint {
    const slot = this.getSlot(index);
    return {
      slot,
      bias: slot ? slot.getBranchBias() : "unknown",
      stable: isStableSlot(slot),
    };
  }

  returnType(index: number): LatticeType {
    const slot = this.getSlot(index);
    if (!slot) return anyType();
    if (slot.hasOnlySmiReturns()) return smiType();
    if (slot.hasOnlyNumberReturns()) return numberType();
    return anyType();
  }
}

function isStableSlot(slot: FeedbackSlot | null): boolean {
  return (
    !!slot &&
    (slot.isStable ||
      (slot.totalRecordCount > 0 && slot.icState === IC_MONOMORPHIC))
  );
}

function observedBinaryType(slot: FeedbackSlot | null): LatticeType {
  if (!slot) return anyType();
  let type: LatticeType | null = null;
  for (const tag of slot.lhsTypeCounts.keys())
    type = mergeTypes(type, typeFromFeedbackTag(tag));
  for (const tag of slot.rhsTypeCounts.keys())
    type = mergeTypes(type, typeFromFeedbackTag(tag));
  return type || anyType();
}

function observedUnaryType(slot: FeedbackSlot | null): LatticeType {
  if (!slot) return anyType();
  let type: LatticeType | null = null;
  for (const tag of slot.typeCounts.keys())
    type = mergeTypes(type, typeFromFeedbackTag(tag));
  return type || anyType();
}

function objectHintType(slot: FeedbackSlot): LatticeType {
  const elementsKind = slot.getMonomorphicElementsKind();
  if (elementsKind) return makeArrayType(elementsKind);
  return makeObjectType(slot.getMonomorphicMap());
}

function typeFromFeedbackTag(tag: string): LatticeType {
  if (tag === "smi") return smiType();
  if (tag === "double") return doubleType();
  if (tag === "number") return numberType();
  if (tag === "string") return stringType();
  if (tag === "boolean") return booleanType();
  if (tag === "null" || tag === "undefined") return nullishType();
  return anyType();
}
