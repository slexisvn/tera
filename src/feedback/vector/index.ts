import { tracer } from "../../core/tracing/index.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";

export const FEEDBACK_PROPERTY = "property";
export const FEEDBACK_BINARY_OP = "binary_op";
export const FEEDBACK_UNARY_OP = "unary_op";
export const FEEDBACK_CALL = "call";
export const FEEDBACK_ALLOCATION = "allocation";
export const FEEDBACK_BRANCH = "branch";

export const IC_UNINITIALIZED = "uninitialized";
export const IC_MONOMORPHIC = "monomorphic";
export const IC_POLYMORPHIC = "polymorphic";
export const IC_MEGAMORPHIC = "megamorphic";

const MAX_POLYMORPHIC_ENTRIES = 4;
const STABILITY_SETTLE_THRESHOLD = 50;

const LATTICE_ORDER = {
  [IC_UNINITIALIZED]: 0,
  [IC_MONOMORPHIC]: 1,
  [IC_POLYMORPHIC]: 2,
  [IC_MEGAMORPHIC]: 3,
} as const;

export type FeedbackKind =
  | typeof FEEDBACK_PROPERTY
  | typeof FEEDBACK_BINARY_OP
  | typeof FEEDBACK_UNARY_OP
  | typeof FEEDBACK_CALL
  | typeof FEEDBACK_ALLOCATION
  | typeof FEEDBACK_BRANCH
  | string;

export type ICState =
  | typeof IC_UNINITIALIZED
  | typeof IC_MONOMORPHIC
  | typeof IC_POLYMORPHIC
  | typeof IC_MEGAMORPHIC;

export type InlineDecision = { kind: string; reason: string };
export type SerializedFeedbackSlot = {
  kind: FeedbackKind;
  icState: ICState;
  maps: number[];
  mapVersions?: number[];
  offsets: number[];
  protoDepths?: number[];
  typeCounts: Record<string, number>;
  lhsTypeCounts: Record<string, number>;
  rhsTypeCounts: Record<string, number>;
  callTargetCounts: Record<string, number>;
  callTargetIds?: Array<number | string>;
  callTargetKeys?: string[];
  callTargetVersions?: number[];
  callArgCounts?: Record<string, number>;
  callReceiverMaps?: number[];
  callReceiverMapVersions?: number[];
  inlineDecisions?: InlineDecision[];
  totalCallCount?: number;
  allocationSiteHCs?: number[];
  arrayAccessCount?: number;
  arrayLengthAccessCount?: number;
  integerIndexCount?: number;
  elementsKindCounts?: Record<string, number>;
  isStable?: boolean;
  stableSinceCount?: number;
  lastTransitionTimestamp?: number;
  totalRecordCount?: number;
};
export type SerializedFeedbackVector = {
  slotCount: number;
  createdAt: number;
  loopBudget?: number;
  loopBudgetExhausted?: boolean;
  slots: Array<SerializedFeedbackSlot | null>;
};
export type CallTargetProfile = {
  id: number | string;
  key: string;
  ref: RegisterCompiledFunction;
  version: number | null;
  count: number;
};

export class FeedbackSlot {
  kind: FeedbackKind;
  icState: ICState;
  maps: number[];
  mapVersions: number[];
  offsets: number[];
  protoDepths: number[];
  _mapIndex: Map<number, number>;
  typeCounts: Map<string, number>;
  lhsTypeCounts: Map<string, number>;
  rhsTypeCounts: Map<string, number>;
  callTargetCounts: Map<string, number>;
  callTargetIds: Array<number | string>;
  callTargetKeys: string[];
  callTargetVersions: number[];
  _callTargetIndex: Map<string, number>;
  _callTargetObjectKeys: WeakMap<object, string>;
  _nextCallTargetObjectKey: number;
  callArgCounts: Map<number, number>;
  callReceiverMaps: number[];
  callReceiverMapVersions: number[];
  _receiverMapIndex: Map<number, number>;
  inlineDecisions: InlineDecision[];
  callTargetRef: RegisterCompiledFunction | null;
  callTargetRefs?: Map<string, RegisterCompiledFunction>;
  totalCallCount: number;
  allocationSiteHCs: Set<number>;
  arrayAccessCount: number;
  arrayLengthAccessCount: number;
  integerIndexCount: number;
  elementsKindCounts: Map<string, number>;
  mapCounts?: Map<number, number>;
  isStable: boolean;
  stableSinceCount: number;
  lastTransitionTimestamp: number;
  totalRecordCount: number;
  takenCount?: number;
  notTakenCount?: number;

  constructor(kind: FeedbackKind) {
    this.kind = kind;
    this.icState = IC_UNINITIALIZED;
    this.maps = [];
    this.mapVersions = [];
    this.offsets = [];
    this.protoDepths = [];
    this._mapIndex = new Map();
    this.typeCounts = new Map();
    this.lhsTypeCounts = new Map();
    this.rhsTypeCounts = new Map();
    this.callTargetCounts = new Map();
    this.callTargetIds = [];
    this.callTargetKeys = [];
    this.callTargetVersions = [];
    this._callTargetIndex = new Map();
    this._callTargetObjectKeys = new WeakMap();
    this._nextCallTargetObjectKey = 1;
    this.callArgCounts = new Map();
    this.callReceiverMaps = [];
    this.callReceiverMapVersions = [];
    this._receiverMapIndex = new Map();
    this.inlineDecisions = [];
    this.callTargetRef = null;
    this.totalCallCount = 0;
    this.allocationSiteHCs = new Set();
    this.arrayAccessCount = 0;
    this.arrayLengthAccessCount = 0;
    this.integerIndexCount = 0;
    this.elementsKindCounts = new Map();
    this.isStable = false;
    this.stableSinceCount = 0;
    this.lastTransitionTimestamp = 0;
    this.totalRecordCount = 0;
  }

  get lhsTypes(): Map<string, number> {
    return this.lhsTypeCounts;
  }

  get rhsTypes(): Map<string, number> {
    return this.rhsTypeCounts;
  }

  get callTargets(): Map<string, number> {
    return this.callTargetCounts;
  }

  _advanceLattice(newState: ICState): boolean {
    const currentOrder = LATTICE_ORDER[this.icState];
    const newOrder = LATTICE_ORDER[newState];
    if (newOrder > currentOrder) {
      const prevState = this.icState;
      this.icState = newState;
      this.lastTransitionTimestamp = Date.now();
      this.stableSinceCount = 0;
      this.isStable = false;
      tracer.feedbackRecord(0, this.kind, `${prevState} → ${this.icState}`);
      return true;
    }
    return false;
  }

  _checkStability(): void {
    this.stableSinceCount++;
    if (this.stableSinceCount >= STABILITY_SETTLE_THRESHOLD && !this.isStable) {
      this.isStable = true;
    }
  }

  recordPropertyAccess(
    hiddenClassId: number,
    offset: number,
    mapVersion = 0,
    protoDepth = 0,
  ): void {
    this.totalRecordCount++;
    const idx = this._mapIndex.get(hiddenClassId);
    if (idx !== undefined) {
      this.mapVersions[idx] = mapVersion;
      this.offsets[idx] = offset;
      this.protoDepths[idx] = protoDepth;
      this._checkStability();
      return;
    }

    if (this.icState === IC_UNINITIALIZED) {
      this._advanceLattice(IC_MONOMORPHIC);
    } else if (this.maps.length < MAX_POLYMORPHIC_ENTRIES) {
      this._advanceLattice(IC_POLYMORPHIC);
    } else {
      this._advanceLattice(IC_MEGAMORPHIC);
      return;
    }
    const newIdx = this.maps.length;
    this._mapIndex.set(hiddenClassId, newIdx);
    this.maps.push(hiddenClassId);
    this.mapVersions.push(mapVersion);
    this.offsets.push(offset);
    this.protoDepths.push(protoDepth);
  }

  recordUnaryOp(operandTag: string): void {
    this.totalRecordCount++;
    const prev = this.typeCounts.get(operandTag) || 0;
    this.typeCounts.set(operandTag, prev + 1);
    if (prev === 0) this._recordTypeShape(this.typeCounts.size);
    this._checkStability();
  }

  recordBranch(taken: boolean): void {
    this.totalRecordCount++;
    if (taken) {
      this.takenCount = (this.takenCount || 0) + 1;
    } else {
      this.notTakenCount = (this.notTakenCount || 0) + 1;
    }
    this._checkStability();
  }

  getBranchBias(): "unknown" | "likely-true" | "likely-false" | "mixed" {
    const taken = this.takenCount || 0;
    const notTaken = this.notTakenCount || 0;
    if (taken === 0 && notTaken === 0) return "unknown";
    if (taken > notTaken * 10) return "likely-true";
    if (notTaken > taken * 10) return "likely-false";
    return "mixed";
  }

  recordReturnType(tag: string): void {
    this.totalRecordCount++;
    const key = `return:${tag}`;
    const prev = this.typeCounts.get(key) || 0;
    this.typeCounts.set(key, prev + 1);
  }

  hasOnlySmiReturns(): boolean {
    for (const [k] of this.typeCounts) {
      if (k.startsWith("return:") && k !== "return:smi") return false;
    }
    return this.typeCounts.has("return:smi");
  }

  hasOnlyNumberReturns(): boolean {
    for (const [k] of this.typeCounts) {
      if (
        k.startsWith("return:") &&
        k !== "return:smi" &&
        k !== "return:double"
      )
        return false;
    }
    return (
      this.typeCounts.has("return:smi") || this.typeCounts.has("return:double")
    );
  }

  recordBinaryOp(lhsTag: string, rhsTag: string): void {
    this.totalRecordCount++;
    const lhsPrev = this.lhsTypeCounts.get(lhsTag) || 0;
    this.lhsTypeCounts.set(lhsTag, lhsPrev + 1);

    const rhsPrev = this.rhsTypeCounts.get(rhsTag) || 0;
    this.rhsTypeCounts.set(rhsTag, rhsPrev + 1);

    const combinedKey = `${lhsTag}|${rhsTag}`;
    const prev = this.typeCounts.get(combinedKey) || 0;
    this.typeCounts.set(combinedKey, prev + 1);

    if (prev === 0) this._recordTypeShape(this.typeCounts.size);
    this._checkStability();
  }

  _recordTypeShape(shapeCount: number): void {
    if (shapeCount === 1 && this.icState === IC_UNINITIALIZED) {
      this._advanceLattice(IC_MONOMORPHIC);
    } else if (
      shapeCount <= MAX_POLYMORPHIC_ENTRIES &&
      this.icState === IC_MONOMORPHIC
    ) {
      this._advanceLattice(IC_POLYMORPHIC);
    } else if (shapeCount > MAX_POLYMORPHIC_ENTRIES) {
      this._advanceLattice(IC_MEGAMORPHIC);
    }
  }

  recordCallTarget(
    targetName: string,
    compiledFn: RegisterCompiledFunction | null = null,
    argCount = 0,
    receiverMapId: number | null = null,
    receiverMapVersion: number | null = null,
    inlineDecision: InlineDecision | null = null,
  ): void {
    this.totalRecordCount++;
    this.totalCallCount++;
    const targetId = compiledFn ? compiledFn.id : `builtin:${targetName}`;
    const targetVersion = compiledFn ? compiledFn.version : 0;
    const key = this._callTargetKey(targetName, compiledFn);
    const prev = this.callTargetCounts.get(key) || 0;
    this.callTargetCounts.set(key, prev + 1);
    this.callArgCounts.set(
      argCount,
      (this.callArgCounts.get(argCount) || 0) + 1,
    );

    const existingIdx = this._callTargetIndex.get(key);
    if (existingIdx === undefined) {
      const newIdx = this.callTargetIds.length;
      this._callTargetIndex.set(key, newIdx);
      this.callTargetKeys.push(key);
      this.callTargetIds.push(targetId);
      this.callTargetVersions.push(targetVersion);
    } else {
      this.callTargetVersions[existingIdx] = targetVersion;
    }

    if (receiverMapId !== null && receiverMapId !== undefined) {
      const receiverIdx = this._receiverMapIndex.get(receiverMapId);
      if (receiverIdx === undefined) {
        const newIdx = this.callReceiverMaps.length;
        this._receiverMapIndex.set(receiverMapId, newIdx);
        this.callReceiverMaps.push(receiverMapId);
        this.callReceiverMapVersions.push(receiverMapVersion || 0);
      } else {
        this.callReceiverMapVersions[receiverIdx] = receiverMapVersion || 0;
      }
    }

    if (inlineDecision)
      this.recordInlineDecision(inlineDecision.kind, inlineDecision.reason);

    if (compiledFn && this.callTargetIds.length === 1)
      this.callTargetRef = compiledFn;

    if (compiledFn) {
      if (!this.callTargetRefs) this.callTargetRefs = new Map();
      this.callTargetRefs.set(key, compiledFn);
    }

    if (this.icState === IC_UNINITIALIZED) {
      this._advanceLattice(IC_MONOMORPHIC);
    } else if (
      this.callTargetIds.length > 1 &&
      this.icState === IC_MONOMORPHIC
    ) {
      this._advanceLattice(IC_POLYMORPHIC);
      this.callTargetRef = null;
    } else if (this.callTargetIds.length > MAX_POLYMORPHIC_ENTRIES) {
      this._advanceLattice(IC_MEGAMORPHIC);
      this.callTargetRef = null;
    }
    this._checkStability();
  }

  _callTargetKey(targetName: string, compiledFn: RegisterCompiledFunction | null): string {
    if (!compiledFn) {
      return `builtin:${targetName}`;
    }
    let key = this._callTargetObjectKeys.get(compiledFn);
    if (!key) {
      key = `fn:${this._nextCallTargetObjectKey++}`;
      this._callTargetObjectKeys.set(compiledFn, key);
    }
    return key;
  }

  recordInlineDecision(kind: string, reason: string): void {
    this.inlineDecisions.push({ kind, reason });
    if (this.inlineDecisions.length > 16) this.inlineDecisions.shift();
  }
  recordAllocationSite(hiddenClassId: number): void {
    this.totalRecordCount++;
    this.allocationSiteHCs.add(hiddenClassId);
  }

  recordArrayAccess(
    isArrayObj: boolean,
    isIntegerIndex: boolean,
    elementsKind: string | null = null,
  ): void {
    this.totalRecordCount++;
    if (isArrayObj) this.arrayAccessCount++;
    if (isIntegerIndex) this.integerIndexCount++;
    if (isArrayObj && isIntegerIndex) {
      if (elementsKind) {
        const prev = this.elementsKindCounts.get(elementsKind) || 0;
        this.elementsKindCounts.set(elementsKind, prev + 1);
      }
      if (this.icState === IC_UNINITIALIZED) {
        this._advanceLattice(IC_MONOMORPHIC);
      } else if (
        this.elementsKindCounts.size > 1 &&
        this.icState === IC_MONOMORPHIC
      ) {
        this._advanceLattice(IC_POLYMORPHIC);
      } else if (this.elementsKindCounts.size > MAX_POLYMORPHIC_ENTRIES) {
        this._advanceLattice(IC_MEGAMORPHIC);
      }
      this._checkStability();
    } else {
      this._advanceLattice(IC_MEGAMORPHIC);
    }
  }

  recordArrayLengthAccess(
    isArrayObj: boolean,
    elementsKind: string | null = null,
  ): void {
    this.totalRecordCount++;
    if (!isArrayObj) {
      this._advanceLattice(IC_MEGAMORPHIC);
      return;
    }

    this.arrayLengthAccessCount++;
    if (elementsKind) {
      const prev = this.elementsKindCounts.get(elementsKind) || 0;
      this.elementsKindCounts.set(elementsKind, prev + 1);
    }
    if (this.icState === IC_UNINITIALIZED) {
      this._advanceLattice(IC_MONOMORPHIC);
    } else if (
      this.elementsKindCounts.size > 1 &&
      this.icState === IC_MONOMORPHIC
    ) {
      this._advanceLattice(IC_POLYMORPHIC);
    } else if (this.elementsKindCounts.size > MAX_POLYMORPHIC_ENTRIES) {
      this._advanceLattice(IC_MEGAMORPHIC);
    }
    this._checkStability();
  }

  hasOnlyArrayAccesses(): boolean {
    return (
      this.arrayAccessCount > 0 &&
      this.arrayAccessCount === this.integerIndexCount &&
      this.icState !== IC_MEGAMORPHIC
    );
  }

  hasOnlyArrayLengthAccesses(): boolean {
    return (
      this.arrayLengthAccessCount > 0 &&
      this.arrayAccessCount === 0 &&
      this.icState !== IC_MEGAMORPHIC
    );
  }

  getObservedElementsKinds(): string[] {
    return [...this.elementsKindCounts.keys()];
  }

  getMonomorphicElementsKind(): string | null {
    if (this.icState === IC_MONOMORPHIC && this.elementsKindCounts.size === 1) {
      return this.elementsKindCounts.keys().next().value ?? null;
    }
    return null;
  }

  isMonomorphic(): boolean {
    return this.icState === IC_MONOMORPHIC;
  }
  isPolymorphic(): boolean {
    return this.icState === IC_POLYMORPHIC;
  }
  isMegamorphic(): boolean {
    return this.icState === IC_MEGAMORPHIC;
  }

  getMonomorphicMap(): number | null {
    if (this.icState === IC_MONOMORPHIC && this.maps.length === 1)
      return this.maps[0];
    return null;
  }

  getMonomorphicOffset(): number | null {
    if (this.icState === IC_MONOMORPHIC && this.offsets.length === 1)
      return this.offsets[0];
    return null;
  }

  getMonomorphicMapVersion(): number | null {
    if (this.icState === IC_MONOMORPHIC && this.mapVersions.length === 1)
      return this.mapVersions[0];
    return null;
  }

  getMonomorphicProtoDepth(): number {
    if (this.icState === IC_MONOMORPHIC && this.protoDepths.length === 1)
      return this.protoDepths[0];
    return 0;
  }

  getPolymorphicMaps(): number[] | null {
    if (this.icState === IC_POLYMORPHIC) return this.maps;
    return null;
  }

  getPolymorphicOffsets(): number[] | null {
    if (this.icState === IC_POLYMORPHIC) return this.offsets;
    return null;
  }

  getPolymorphicMapVersions(): number[] | null {
    if (this.icState === IC_POLYMORPHIC) return this.mapVersions;
    return null;
  }

  getPolymorphicProtoDepths(): number[] | null {
    if (this.icState === IC_POLYMORPHIC) return this.protoDepths;
    return null;
  }

  getMonomorphicCallTarget(): number | string | null {
    if (this.callTargetIds.length === 1) {
      return this.callTargetIds[0];
    }
    return null;
  }

  getMonomorphicCallTargetRef(): RegisterCompiledFunction | null {
    if (this.callTargetIds.length === 1) return this.callTargetRef;
    return null;
  }

  getMonomorphicCallTargetVersion(): number | null {
    if (this.callTargetVersions.length === 1) return this.callTargetVersions[0];
    return null;
  }

  getPolymorphicCallTargets(): CallTargetProfile[] | null {
    if (!this.isPolymorphic() || !this.callTargetRefs) return null;
    const targets: CallTargetProfile[] = [];
    for (const [key, ref] of this.callTargetRefs) {
      if (ref) {
        const idx = this._callTargetIndex.get(key);
        const id = idx !== undefined ? this.callTargetIds[idx] : key;
        const version = idx !== undefined ? this.callTargetVersions[idx] : null;
        const count = this.callTargetCounts.get(key) || 0;
        targets.push({ id, key, ref, version, count });
      }
    }
    targets.sort((a, b) => b.count - a.count);
    return targets.length >= 2 ? targets : null;
  }

  getMonomorphicCallArgCount(): number | null {
    if (this.callArgCounts.size === 1) {
      return Number(this.callArgCounts.keys().next().value);
    }
    return null;
  }

  getMonomorphicReceiverMap(): number | null {
    if (this.callReceiverMaps.length === 1) return this.callReceiverMaps[0];
    return null;
  }

  getCallFrequency(targetName: string): number {
    return this.callTargetCounts.get(targetName) || 0;
  }

  getDominantType(): string | null {
    let maxCount = 0;
    let dominant: string | null = null;
    for (const [key, count] of this.typeCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominant = key;
      }
    }
    return dominant;
  }

  reset(): void {
    this.icState = IC_UNINITIALIZED;
    this.maps = [];
    this.mapVersions = [];
    this.offsets = [];
    this.protoDepths = [];
    this._mapIndex.clear();
    this.typeCounts.clear();
    this.lhsTypeCounts.clear();
    this.rhsTypeCounts.clear();
    this.callTargetCounts.clear();
    this.callTargetIds = [];
    this.callTargetKeys = [];
    this.callTargetVersions = [];
    this._callTargetIndex.clear();
    this._callTargetObjectKeys = new WeakMap();
    this._nextCallTargetObjectKey = 1;
    this.callArgCounts.clear();
    this.callReceiverMaps = [];
    this.callReceiverMapVersions = [];
    this._receiverMapIndex.clear();
    this.inlineDecisions = [];
    this.callTargetRef = null;
    this.totalCallCount = 0;
    this.allocationSiteHCs = new Set();
    this.arrayAccessCount = 0;
    this.arrayLengthAccessCount = 0;
    this.integerIndexCount = 0;
    this.elementsKindCounts.clear();
    this.isStable = false;
    this.stableSinceCount = 0;
    this.lastTransitionTimestamp = 0;
    this.totalRecordCount = 0;
  }

  serialize(): SerializedFeedbackSlot {
    return {
      kind: this.kind,
      icState: this.icState,
      maps: [...this.maps],
      mapVersions: [...this.mapVersions],
      offsets: [...this.offsets],
      protoDepths: [...this.protoDepths],
      typeCounts: Object.fromEntries(this.typeCounts),
      lhsTypeCounts: Object.fromEntries(this.lhsTypeCounts),
      rhsTypeCounts: Object.fromEntries(this.rhsTypeCounts),
      callTargetCounts: Object.fromEntries(this.callTargetCounts),
      callTargetIds: [...this.callTargetIds],
      callTargetKeys: [...this.callTargetKeys],
      callTargetVersions: [...this.callTargetVersions],
      callArgCounts: Object.fromEntries(this.callArgCounts),
      callReceiverMaps: [...this.callReceiverMaps],
      callReceiverMapVersions: [...this.callReceiverMapVersions],
      inlineDecisions: [...this.inlineDecisions],
      totalCallCount: this.totalCallCount,
      allocationSiteHCs: [...this.allocationSiteHCs],
      arrayAccessCount: this.arrayAccessCount,
      arrayLengthAccessCount: this.arrayLengthAccessCount,
      integerIndexCount: this.integerIndexCount,
      elementsKindCounts: Object.fromEntries(this.elementsKindCounts),
      isStable: this.isStable,
      stableSinceCount: this.stableSinceCount,
      lastTransitionTimestamp: this.lastTransitionTimestamp,
      totalRecordCount: this.totalRecordCount,
    };
  }

  static deserialize(data: SerializedFeedbackSlot): FeedbackSlot {
    const slot = new FeedbackSlot(data.kind);
    slot.icState = data.icState;
    slot.maps = data.maps;
    slot.mapVersions = data.mapVersions || [];
    slot.offsets = data.offsets;
    slot.protoDepths = data.protoDepths || [];
    slot._mapIndex = new Map();
    for (let i = 0; i < slot.maps.length; i++)
      slot._mapIndex.set(slot.maps[i], i);
    slot.typeCounts = new Map(Object.entries(data.typeCounts));
    slot.lhsTypeCounts = new Map(Object.entries(data.lhsTypeCounts));
    slot.rhsTypeCounts = new Map(Object.entries(data.rhsTypeCounts));
    slot.callTargetCounts = new Map(Object.entries(data.callTargetCounts));
    slot.callTargetIds = data.callTargetIds || [];
    slot.callTargetKeys =
      data.callTargetKeys || slot.callTargetIds.map((id: number | string) => String(id));
    slot.callTargetVersions = data.callTargetVersions || [];
    slot._callTargetIndex = new Map();
    for (let i = 0; i < slot.callTargetKeys.length; i++)
      slot._callTargetIndex.set(slot.callTargetKeys[i], i);
    slot._callTargetObjectKeys = new WeakMap();
    slot._nextCallTargetObjectKey = slot.callTargetKeys.length + 1;
    slot.callArgCounts = new Map(
      Object.entries(data.callArgCounts || {}).map(([key, value]) => [
        Number(key),
        Number(value),
      ]),
    );
    slot.callReceiverMaps = data.callReceiverMaps || [];
    slot.callReceiverMapVersions = data.callReceiverMapVersions || [];
    slot._receiverMapIndex = new Map();
    for (let i = 0; i < slot.callReceiverMaps.length; i++)
      slot._receiverMapIndex.set(slot.callReceiverMaps[i], i);
    slot.inlineDecisions = data.inlineDecisions || [];
    slot.totalCallCount = data.totalCallCount || 0;
    slot.allocationSiteHCs = new Set(data.allocationSiteHCs || []);
    slot.arrayAccessCount = data.arrayAccessCount || 0;
    slot.arrayLengthAccessCount = data.arrayLengthAccessCount || 0;
    slot.integerIndexCount = data.integerIndexCount || 0;
    slot.elementsKindCounts = new Map(
      Object.entries(data.elementsKindCounts || {}),
    );
    slot.isStable = data.isStable || false;
    slot.stableSinceCount = data.stableSinceCount || 0;
    slot.lastTransitionTimestamp = data.lastTransitionTimestamp || 0;
    slot.totalRecordCount = data.totalRecordCount || 0;
    return slot;
  }

  toString(): string {
    const parts = [
      `FeedbackSlot(${this.kind}, state=${this.icState}, stable=${this.isStable})`,
    ];
    if (this.maps.length > 0) {
      parts.push(`  maps: [${this.maps.join(", ")}]`);
    }
    if (this.mapVersions.length > 0) {
      parts.push(`  versions: [${this.mapVersions.join(", ")}]`);
    }
    if (this.typeCounts.size > 0) {
      const entries = [];
      for (const [k, v] of this.typeCounts) entries.push(`${k}:${v}`);
      parts.push(`  types: {${entries.join(", ")}}`);
    }
    if (this.callTargetCounts.size > 0) {
      const entries = [];
      for (const [k, v] of this.callTargetCounts) entries.push(`${k}:${v}`);
      parts.push(`  calls: {${entries.join(", ")}}`);
    }
    if (this.elementsKindCounts.size > 0) {
      const entries = [];
      for (const [k, v] of this.elementsKindCounts) entries.push(`${k}:${v}`);
      parts.push(`  elements: {${entries.join(", ")}}`);
    }
    return parts.join("\n");
  }
}

export const DEFAULT_LOOP_BUDGET = 1000;

export class FeedbackVector {
  slots: Array<FeedbackSlot | null>;
  createdAt: number;
  loopBudget: number;
  loopBudgetExhausted: boolean;

  constructor(slotCount: number) {
    this.slots = [];
    for (let i = 0; i < slotCount; i++) {
      this.slots.push(null);
    }
    this.createdAt = Date.now();
    this.loopBudget = DEFAULT_LOOP_BUDGET;
    this.loopBudgetExhausted = false;
  }

  decrementLoopBudget(amount = 1): boolean {
    this.loopBudget -= amount;
    if (this.loopBudget <= 0 && !this.loopBudgetExhausted) {
      this.loopBudgetExhausted = true;
      return true;
    }
    return false;
  }

  resetLoopBudget(): void {
    this.loopBudget = DEFAULT_LOOP_BUDGET;
    this.loopBudgetExhausted = false;
  }

  initSlot(index: number, kind: FeedbackKind): void {
    if (!this.slots[index]) {
      this.slots[index] = new FeedbackSlot(kind);
    }
  }

  getSlot(index: number): FeedbackSlot | null {
    return this.slots[index];
  }

  slotCount(): number {
    return this.slots.length;
  }

  resetSlot(index: number): void {
    const slot = this.slots[index];
    if (slot) {
      slot.reset();
    }
  }

  resetAll(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot) {
        slot.reset();
      }
    }
    this.resetLoopBudget();
  }

  getSummaryStats(): Record<string, number> {
    let totalSlots = 0;
    let initializedSlots = 0;
    let stableSlots = 0;
    let monomorphicSlots = 0;
    let polymorphicSlots = 0;
    let megamorphicSlots = 0;
    let totalRecords = 0;

    for (let i = 0; i < this.slots.length; i++) {
      totalSlots++;
      const slot = this.slots[i];
      if (!slot) continue;
      initializedSlots++;
      totalRecords += slot.totalRecordCount;
      if (slot.isStable) stableSlots++;
      if (slot.icState === IC_MONOMORPHIC) monomorphicSlots++;
      else if (slot.icState === IC_POLYMORPHIC) polymorphicSlots++;
      else if (slot.icState === IC_MEGAMORPHIC) megamorphicSlots++;
    }

    return {
      totalSlots,
      initializedSlots,
      stableSlots,
      monomorphicSlots,
      polymorphicSlots,
      megamorphicSlots,
      totalRecords,
      createdAt: this.createdAt,
    };
  }

  serialize(): SerializedFeedbackVector {
    return {
      slotCount: this.slots.length,
      createdAt: this.createdAt,
      loopBudget: this.loopBudget,
      loopBudgetExhausted: this.loopBudgetExhausted,
      slots: this.slots.map((s) => (s ? s.serialize() : null)),
    };
  }

  static deserialize(data: SerializedFeedbackVector): FeedbackVector {
    const vec = new FeedbackVector(data.slotCount);
    vec.createdAt = data.createdAt;
    if (data.loopBudget !== undefined) {
      vec.loopBudget = data.loopBudget;
      vec.loopBudgetExhausted = data.loopBudgetExhausted || false;
    }
    for (let i = 0; i < data.slots.length; i++) {
      const slotData = data.slots[i];
      if (slotData) {
        vec.slots[i] = FeedbackSlot.deserialize(slotData);
      }
    }
    return vec;
  }

  static fromCompiledFunction(compiledFn: { feedbackSlotCount: number }): FeedbackVector {
    const vec = new FeedbackVector(compiledFn.feedbackSlotCount);
    return vec;
  }

  getPolymorphicProfile(slotIdx: number): Record<string, RuntimeValue> | null {
    const slot = this.slots[slotIdx];
    if (!slot) return null;
    return {
      icState: slot.icState,
      mapDistribution: slot.mapCounts
        ? [...slot.mapCounts.entries()].sort((a, b) => b[1] - a[1])
        : [],
      isStable: slot.isStable,
      totalRecords: slot.totalRecordCount,
    };
  }

  isSettled(slotIdx: number): boolean {
    const slot = this.slots[slotIdx];
    if (!slot) return false;
    return slot.isStable && slot.totalRecordCount >= 50;
  }

  getSlotsNeedingRefresh(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      if (
        slot.icState === IC_MEGAMORPHIC ||
        (!slot.isStable && slot.totalRecordCount > 0)
      ) {
        result.push(i);
      }
    }
    return result;
  }

  toString(): string {
    const lines = [`FeedbackVector(${this.slots.length} slots)`];
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot) {
        lines.push(`  [${i}] ${slot}`);
      } else {
        lines.push(`  [${i}] <empty>`);
      }
    }
    return lines.join("\n");
  }
}
