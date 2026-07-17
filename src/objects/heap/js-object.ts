import {
  HiddenClass,
  ROOT_HIDDEN_CLASS,
  PropertyDescriptor,
} from "../maps/hidden-class.js";
import { tracer } from "../../core/tracing/index.js";
import {
  dependencyRegistry,
  DEP_MAP,
  DEP_PROTO_VALIDITY,
} from "../../deopt/dependencies.js";
import {
  type HeapPayload,
  getPayload,
  isNull,
  isUndefined,
  strictEqual,
  toDisplayString,
} from "../../core/value/index.js";
import type {
  RuntimeFunctionPayload,
  TaggedValue,
} from "../../core/value/index.js";
import type {
  OrderedHashMap,
  OrderedHashSet,
  EphemeronHashTable,
} from "./js-collections.js";
import { storeBarrierForTaggedValue } from "../../gc/write-barrier.js";
import type { GCObject } from "../../gc/incremental-marker.js";
import { payloadGCObject } from "./gc-payload.js";

const MAX_IN_OBJECT_PROPERTIES = 10;
const SLACK_TRACKING_CALL_COUNT = 7;
let totalMigrations = 0;

type LookupResult = {
  found: boolean;
  value: TaggedValue | AccessorPair | undefined;
  owner: JSObject | null;
  descriptor: PropertyDescriptor | null;
  depth: number;
};

type DefinePropertyDescriptor = {
  kind?: "data" | "accessor";
  writable?: boolean;
  enumerable?: boolean;
  configurable?: boolean;
  value?: TaggedValue | AccessorPair;
};

type OwnPropertyDescriptorResult = {
  value: TaggedValue | undefined;
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
  kind: "data" | "accessor";
};

type ConstructorShape = {
  slackCounter?: number;
  slackExpectedProperties?: number;
  slackTrackingComplete?: boolean;
};

type StoredPropertyValue = TaggedValue | AccessorPair | undefined;

function isAccessorPair(value: StoredPropertyValue): value is AccessorPair {
  return value instanceof AccessorPair;
}

function dataValue(value: StoredPropertyValue): TaggedValue | undefined {
  return isAccessorPair(value) ? undefined : value;
}

export class AccessorPair {
  get: TaggedValue | undefined;
  set: TaggedValue | undefined;

  constructor(getter?: TaggedValue, setter?: TaggedValue) {
    this.get = getter;
    this.set = setter;
  }
}

export class JSObject {
  hiddenClass: HiddenClass;
  slots: StoredPropertyValue[];
  overflowProperties: Map<string, StoredPropertyValue> | null;
  prototype: JSObject | null;
  constructorRef: TaggedValue | RuntimeFunctionPayload | null;
  symbolProperties: Map<HeapPayload, TaggedValue> | null;
  gcHeader: GCObject["gcHeader"] | null;
  _mapData?: OrderedHashMap;
  _setData?: OrderedHashSet;
  _weakMapData?: EphemeronHashTable;
  _primitiveValue?: TaggedValue;
  _frozen?: boolean;
  _sealed?: boolean;
  _nonExtensible?: boolean;

  constructor(hiddenClass?: HiddenClass | null) {
    this.hiddenClass = hiddenClass || ROOT_HIDDEN_CLASS;
    this.hiddenClass.incrementObjectCount();
    const propCount = this.hiddenClass.propertyCount;
    this.slots = propCount > 0 ? new Array<StoredPropertyValue>(propCount) : [];
    this.overflowProperties = null;
    this.prototype = null;
    this.constructorRef = null;
    this.symbolProperties = null;
    this.gcHeader = null;
  }

  getSymbolProperty(taggedSym: TaggedValue): TaggedValue | undefined {
    if (!this.symbolProperties) return undefined;
    return this.symbolProperties.get(getPayload(taggedSym));
  }

  setSymbolProperty(taggedSym: TaggedValue, value: TaggedValue): void {
    if (!this.symbolProperties) this.symbolProperties = new Map();
    this.symbolProperties.set(getPayload(taggedSym), value);
  }

  deleteSymbolProperty(taggedSym: TaggedValue): boolean {
    if (!this.symbolProperties) return true;
    return this.symbolProperties.delete(getPayload(taggedSym));
  }

  hasSymbolProperty(taggedSym: TaggedValue): boolean {
    if (!this.symbolProperties) return false;
    return this.symbolProperties.has(getPayload(taggedSym));
  }

  visitReferences(callback: (value: GCObject) => void): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot === undefined) continue;
      if (isAccessorPair(slot)) continue;
      const payload = payloadGCObject(getPayload(slot));
      if (payload) callback(payload);
    }
    if (this.overflowProperties) {
      for (const val of this.overflowProperties.values()) {
        if (val === undefined) continue;
        if (isAccessorPair(val)) continue;
        const payload = payloadGCObject(getPayload(val));
        if (payload) callback(payload);
      }
    }
    if (this.prototype && this.prototype.gcHeader) {
      callback(this.prototype);
    }
  }

  setPrototype(proto: JSObject | null): void {
    this.prototype = proto;
    this.hiddenClass.invalidate("setPrototype");
  }

  getPrototype(): JSObject | null {
    return this.prototype;
  }

  lookupPrototypeChain(name: string): LookupResult {
    let current: JSObject | null = this;
    let depth = 0;
    while (current) {
      if (current.hiddenClass.isDeprecated) current.migrateInstance();
      const desc = current.hiddenClass.lookupProperty(name);
      if (desc) {
        if (desc.offset < current.slots.length) {
          return {
            found: true,
            value: current.slots[desc.offset],
            owner: current,
            descriptor: desc,
            depth,
          };
        }
        const overflow = current.overflowProperties ? current.overflowProperties.get(name) : undefined;
        if (overflow !== undefined) {
          return {
            found: true,
            value: overflow,
            owner: current,
            descriptor: desc,
            depth,
          };
        }
      }
      current = current.prototype;
      depth++;
    }
    return {
      found: false,
      value: undefined,
      owner: null,
      descriptor: null,
      depth: -1,
    };
  }

  getPrototypeValidityVersion(): number {
    return this.hiddenClass.prototypeValidityCell.version;
  }

  invalidatePrototypeDependents(reason: string): string {
    const oldProtoVersion = this.hiddenClass.prototypeValidityCell.version;
    this.hiddenClass.prototypeValidityCell.version++;
    dependencyRegistry.invalidate(
      DEP_PROTO_VALIDITY,
      this.hiddenClass.id,
      oldProtoVersion,
      reason,
    );
    return reason;
  }

  needsMigration(): boolean {
    return (
      this.hiddenClass.isDeprecated && this.hiddenClass.migrationTarget !== null
    );
  }

  migrateInstance(): boolean {
    if (!this.needsMigration()) return false;

    const oldHC = this.hiddenClass;
    const targetHC = oldHC.migrationTarget!;
    const oldSlots = [...this.slots];
    const oldOverflow: Map<string, StoredPropertyValue> =
      this.overflowProperties ? new Map(this.overflowProperties) : new Map<string, StoredPropertyValue>();

    this.slots = [];
    this.overflowProperties = null;

    for (const [name, newDesc] of targetHC.properties) {
      const oldDesc = oldHC.lookupProperty(name);
      let value: TaggedValue | undefined = undefined;

      if (oldDesc) {
        if (
          oldDesc.offset < MAX_IN_OBJECT_PROPERTIES &&
          oldDesc.offset < oldSlots.length
        ) {
          value = dataValue(oldSlots[oldDesc.offset]);
        } else {
          value = dataValue(oldOverflow.get(name));
        }
      }

      if (newDesc.offset < MAX_IN_OBJECT_PROPERTIES) {
        while (this.slots.length <= newDesc.offset) {
          this.slots.push(undefined);
        }
        this.slots[newDesc.offset] = value;
      } else {
        if (!this.overflowProperties) this.overflowProperties = new Map();
        this.overflowProperties.set(name, value);
      }
    }

    oldHC.decrementObjectCount();
    this.hiddenClass = targetHC;
    targetHC.incrementObjectCount();

    totalMigrations++;
    tracer.log(
      "hidden-class",
      `Object migrated HC${oldHC.id} → HC${targetHC.id}`,
    );
    return true;
  }

  ensureMigrated(): void {
    if (this.hiddenClass.isDeprecated) {
      this.migrateInstance();
    }
  }

  hasOwnProperty(name: string): boolean {
    return this.hiddenClass.hasProperty(name);
  }

  getProperty(name: string): TaggedValue | undefined {
    this.ensureMigrated();
    const desc = this.hiddenClass.lookupProperty(name);
    if (desc) {
      if (desc.offset < MAX_IN_OBJECT_PROPERTIES) {
        return dataValue(this.slots[desc.offset]);
      }
      const val = this.overflowProperties ? this.overflowProperties.get(name) : undefined;
      return dataValue(val);
    }
    return undefined;
  }

  setProperty(name: string, value: TaggedValue): boolean {
    this.ensureMigrated();
    const desc = this.hiddenClass.lookupProperty(name);
    if (desc) {
      if (!desc.writable) {
        return false;
      }
      if (desc.offset < MAX_IN_OBJECT_PROPERTIES) {
        this.slots[desc.offset] = value;
      } else {
        if (!this.overflowProperties) this.overflowProperties = new Map();
        this.overflowProperties.set(name, value);
      }
      storeBarrierForTaggedValue(this, value);
      dependencyRegistry.invalidate(
        DEP_MAP,
        this.hiddenClass.id,
        this.hiddenClass.version,
        `store:${name}`,
      );
      this.invalidatePrototypeDependents(`store:${name}`);
      return true;
    }

    const oldHC = this.hiddenClass;
    const hadTransition = oldHC.transitions.has(name);
    this.hiddenClass.decrementObjectCount();
    const newHC = this.hiddenClass.transition(name);
    if (!newHC) {
      oldHC.incrementObjectCount();
      return false;
    }
    if (!hadTransition && oldHC.objectCount > 1) {
      oldHC.invalidate(`add:${name}`);
    }
    this.hiddenClass = newHC;
    this.hiddenClass.incrementObjectCount();

    const newDesc = newHC.lookupProperty(name);
    if (!newDesc) return false;
    if (newDesc.offset < MAX_IN_OBJECT_PROPERTIES) {
      while (this.slots.length <= newDesc.offset) {
        this.slots.push(undefined);
      }
      this.slots[newDesc.offset] = value;
    } else {
      if (!this.overflowProperties) this.overflowProperties = new Map();
      this.overflowProperties.set(name, value);
    }
    storeBarrierForTaggedValue(this, value);
    return true;
  }

  deleteProperty(name: string): boolean {
    const desc = this.hiddenClass.lookupProperty(name);
    if (!desc) {
      return true;
    }
    if (!desc.configurable) {
      return false;
    }

    const oldHC = this.hiddenClass;
    this.hiddenClass.decrementObjectCount();
    const newHC = this.hiddenClass.deleteProperty(name);
    if (!newHC) {
      this.hiddenClass.incrementObjectCount();
      return false;
    }
    oldHC.invalidate(`delete:${name}`);

    const oldSlots = [...this.slots];
    const oldProperties: Map<string, StoredPropertyValue> =
      this.overflowProperties ? new Map(this.overflowProperties) : new Map<string, StoredPropertyValue>();

    this.slots = [];
    this.overflowProperties = null;

    for (const [key, newDesc] of newHC.properties) {
      let oldValue: TaggedValue | undefined = undefined;
      const prevParent = newHC.parent;
      if (prevParent) {
        const prevDesc = prevParent.lookupProperty(key);
        if (prevDesc) {
          if (prevDesc.offset < oldSlots.length) {
            oldValue = dataValue(oldSlots[prevDesc.offset]);
          } else {
            oldValue = dataValue(oldProperties.get(key));
          }
        }
      }

      if (newDesc.offset < MAX_IN_OBJECT_PROPERTIES) {
        while (this.slots.length <= newDesc.offset) {
          this.slots.push(undefined);
        }
        this.slots[newDesc.offset] = oldValue;
      } else {
        if (!this.overflowProperties) this.overflowProperties = new Map();
        this.overflowProperties.set(key, oldValue);
      }
    }

    this.hiddenClass = newHC;
    this.hiddenClass.incrementObjectCount();
    return true;
  }

  defineProperty(name: string, descriptor: DefinePropertyDescriptor): boolean {
    const kind = descriptor.kind || "data";
    const writable =
      descriptor.writable !== undefined ? descriptor.writable : true;
    const enumerable =
      descriptor.enumerable !== undefined ? descriptor.enumerable : true;
    const configurable =
      descriptor.configurable !== undefined ? descriptor.configurable : true;
    const value = descriptor.value;

    const existing = this.hiddenClass.lookupProperty(name);
    const oldHC = this.hiddenClass;

    if (existing) {
      if (!existing.configurable) {
        if (kind !== existing.kind) return false;
        if (writable && !existing.writable) return false;
        if (enumerable !== existing.enumerable) return false;
        if (configurable) return false;
      }
    }

    this.hiddenClass.decrementObjectCount();
    const newHC = this.hiddenClass.transitionWithAttributes(
      name,
      kind,
      writable,
      enumerable,
      configurable,
    );
    if (!newHC) {
      this.hiddenClass.incrementObjectCount();
      return false;
    }
    oldHC.invalidate(`define:${name}`);

    this.hiddenClass = newHC;
    this.hiddenClass.incrementObjectCount();

    const newDesc = newHC.lookupProperty(name);
    if (!newDesc) return false;
    if (value !== undefined) {
      if (newDesc.offset < MAX_IN_OBJECT_PROPERTIES) {
        while (this.slots.length <= newDesc.offset) {
          this.slots.push(undefined);
        }
        this.slots[newDesc.offset] = value;
      } else {
        if (!this.overflowProperties) this.overflowProperties = new Map();
        this.overflowProperties.set(name, value);
      }
    }

    return true;
  }

  getOwnPropertyDescriptor(
    name: string,
  ): OwnPropertyDescriptorResult | undefined {
    const desc = this.hiddenClass.lookupProperty(name);
    if (!desc) return undefined;

    let value: TaggedValue | undefined;
    if (desc.offset < MAX_IN_OBJECT_PROPERTIES) {
      value = dataValue(this.slots[desc.offset]);
    } else {
      value = dataValue(this.overflowProperties ? this.overflowProperties.get(name) : undefined);
    }

    return {
      value: value,
      writable: desc.writable,
      enumerable: desc.enumerable,
      configurable: desc.configurable,
      kind: desc.kind,
    };
  }

  getOwnPropertyNames(): string[] {
    return this.hiddenClass.getPropertyNames();
  }

  getPropertyByOffset(offset: number): TaggedValue | undefined {
    if (offset < MAX_IN_OBJECT_PROPERTIES) {
      return dataValue(this.slots[offset]);
    }
    if (this.overflowProperties) {
      for (const [name, desc] of this.hiddenClass.properties) {
        if (desc.offset === offset) {
          return dataValue(this.overflowProperties.get(name));
        }
      }
    }
    return undefined;
  }

  setPropertyByOffset(offset: number, value: TaggedValue): boolean {
    if (offset < MAX_IN_OBJECT_PROPERTIES) {
      this.slots[offset] = value;
      dependencyRegistry.invalidate(
        DEP_MAP,
        this.hiddenClass.id,
        this.hiddenClass.version,
        `store-offset:${offset}`,
      );
      return true;
    }
    for (const [name, desc] of this.hiddenClass.properties) {
      if (desc.offset === offset) {
        if (!this.overflowProperties) this.overflowProperties = new Map();
        this.overflowProperties.set(name, value);
        dependencyRegistry.invalidate(
          DEP_MAP,
          this.hiddenClass.id,
          this.hiddenClass.version,
          `store:${name}`,
        );
        return true;
      }
    }
    return false;
  }

  getMapId(): number {
    return this.hiddenClass.id;
  }

  keys(): string[] {
    return this.hiddenClass.getEnumerablePropertyNames();
  }

  values(): Array<TaggedValue | undefined> {
    const result: Array<TaggedValue | undefined> = [];
    for (const name of this.keys()) {
      result.push(this.getProperty(name));
    }
    return result;
  }

  entries(): Array<[string, TaggedValue | undefined]> {
    const result: Array<[string, TaggedValue | undefined]> = [];
    for (const name of this.keys()) {
      result.push([name, this.getProperty(name)]);
    }
    return result;
  }

  preventExtensions(): void {
    const oldHC = this.hiddenClass;
    this.hiddenClass.decrementObjectCount();
    this.hiddenClass = this.hiddenClass.transitionToPreventExtensions();
    oldHC.invalidate("preventExtensions");
    this.hiddenClass.incrementObjectCount();
  }

  seal(): void {
    const oldHC = this.hiddenClass;
    this.hiddenClass.decrementObjectCount();
    this.hiddenClass = this.hiddenClass.transitionToSealed();
    oldHC.invalidate("seal");
    this.hiddenClass.incrementObjectCount();
  }

  freeze(): void {
    const oldHC = this.hiddenClass;
    this.hiddenClass.decrementObjectCount();
    this.hiddenClass = this.hiddenClass.transitionToFrozen();
    oldHC.invalidate("freeze");
    this.hiddenClass.incrementObjectCount();
  }

  toString(): string {
    const entries: string[] = [];
    for (const [name, desc] of this.hiddenClass.properties) {
      let val: TaggedValue | undefined;
      if (desc.offset < MAX_IN_OBJECT_PROPERTIES) {
        val = dataValue(this.slots[desc.offset]);
      } else {
        val = dataValue(this.overflowProperties ? this.overflowProperties.get(name) : undefined);
      }
      entries.push(`${name}: ${val === undefined ? "undefined" : toDisplayString(val)}`);
    }
    return `{ ${entries.join(", ")} }`;
  }
}

export function presizeInstanceSlots(
  obj: JSObject,
  ctor?: ConstructorShape | null,
): void {
  if (!ctor) return;
  const expected = ctor.slackExpectedProperties;
  if (!expected) return;
  if (obj.slots.length < expected) obj.slots.length = expected;
}

export function recordConstruction(
  ctor: ConstructorShape | null | undefined,
  obj: JSObject,
): void {
  if (!ctor) return;
  if (ctor.slackCounter === undefined) {
    ctor.slackCounter = SLACK_TRACKING_CALL_COUNT;
    ctor.slackExpectedProperties = 0;
    ctor.slackTrackingComplete = false;
  }
  const count = obj.hiddenClass.propertyCount;
  const inObjectUsed =
    count < MAX_IN_OBJECT_PROPERTIES ? count : MAX_IN_OBJECT_PROPERTIES;
  if (!ctor.slackTrackingComplete) {
    const expected = ctor.slackExpectedProperties ?? 0;
    if (inObjectUsed > expected) {
      ctor.slackExpectedProperties = inObjectUsed;
    }
    ctor.slackCounter--;
    if (ctor.slackCounter <= 0) ctor.slackTrackingComplete = true;
  }
  if (obj.slots.length > inObjectUsed) obj.slots.length = inObjectUsed;
}

export function getMigrationStats(): { totalMigrations: number } {
  return { totalMigrations };
}

export function resetMigrationStats(): void {
  totalMigrations = 0;
}
