import {
  HiddenClass,
  ROOT_HIDDEN_CLASS,
} from "../maps/hidden-class.js";
import {
  dependencyRegistry,
  DEP_ELEMENTS_KIND,
  DEP_MAP,
} from "../../deopt/dependencies.js";
import {
  type HeapPayload,
  getPayload,
  getTag,
  isNull,
  isUndefined,
  mkUndefined,
  strictEqual,
  toDisplayString,
  toString,
  toNumber,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import { storeBarrierForTaggedValue } from "../../gc/write-barrier.js";
import type { GCObject } from "../../gc/incremental-marker.js";
import { payloadGCObject } from "./gc-payload.js";
import {
  type ElementsKindName,
  inferElementsKind,
  makeHoleyElementsKind,
  mergeElementsKind,
} from "../elements/elements-kind.js";

const MAX_IN_OBJECT_PROPERTIES = 10;

type ArrayCallback<T> = (
  value: TaggedValue | undefined,
  index: number,
  array: JSArray,
) => T;

export class JSArray {
  elements: Array<TaggedValue | undefined>;
  elementsKind: ElementsKindName;
  hiddenClass: HiddenClass;
  slots: Array<TaggedValue | undefined>;
  overflowProperties: Map<string, TaggedValue | undefined>;
  symbolProperties: Map<HeapPayload, TaggedValue> | null;
  gcHeader: GCObject["gcHeader"] | null;

  constructor(elements?: Array<TaggedValue | undefined>) {
    this.elements = elements ? [...elements] : [];
    this.elementsKind = inferElementsKind(this.elements);
    this.hiddenClass = ROOT_HIDDEN_CLASS;
    this.hiddenClass.incrementObjectCount();
    this.slots = [];
    this.overflowProperties = new Map();
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

  hasSymbolProperty(taggedSym: TaggedValue): boolean {
    if (!this.symbolProperties) return false;
    return this.symbolProperties.has(getPayload(taggedSym));
  }

  visitReferences(callback: (value: GCObject) => void): void {
    for (let i = 0; i < this.elements.length; i++) {
      const el = this.elements[i];
      if (el === undefined) continue;
      const payload = payloadGCObject(getPayload(el));
      if (payload) callback(payload);
    }
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot === undefined) continue;
      const payload = payloadGCObject(getPayload(slot));
      if (payload) callback(payload);
    }
    for (const val of this.overflowProperties.values()) {
      if (val === undefined) continue;
      const payload = payloadGCObject(getPayload(val));
      if (payload) callback(payload);
    }
  }

  getIndex(index: number): TaggedValue | undefined {
    if (index >= 0 && index < this.elements.length) {
      return this.elements[index];
    }
    return undefined;
  }

  setIndex(index: number, value: TaggedValue): void {
    const oldLength = this.elements.length;
    const makesHole = index > oldLength;
    const oldKind = this.elementsKind;
    this.elementsKind = mergeElementsKind(this.elementsKind, value, makesHole);
    if (oldKind !== this.elementsKind) {
      dependencyRegistry.invalidate(
        DEP_ELEMENTS_KIND,
        oldKind,
        null,
        `elements-kind:${oldKind}->${this.elementsKind}`,
      );
    }
    if (index >= this.elements.length) {
      for (let i = this.elements.length; i < index; i++) {
        this.elements.push(undefined);
      }
      this.elements[index] = value;
    } else {
      this.elements[index] = value;
    }
    storeBarrierForTaggedValue(this, value);
  }

  getLength(): number {
    return this.elements.length;
  }

  setLength(len: number): void {
    if (len < this.elements.length) {
      this.elements.length = len;
    } else {
      if (len > this.elements.length) {
        const oldKind = this.elementsKind;
        this.elementsKind = makeHoleyElementsKind(this.elementsKind);
        if (oldKind !== this.elementsKind) {
          dependencyRegistry.invalidate(
            DEP_ELEMENTS_KIND,
            oldKind,
            null,
            `elements-kind:${oldKind}->${this.elementsKind}`,
          );
        }
      }
      while (this.elements.length < len) {
        this.elements.push(undefined);
      }
    }
  }

  push(...values: TaggedValue[]): number {
    const oldKind = this.elementsKind;
    let newKind = this.elementsKind;
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      newKind = mergeElementsKind(newKind, value);
      this.elements.push(value);
      storeBarrierForTaggedValue(this, value);
    }
    if (newKind !== oldKind) {
      this.elementsKind = newKind;
      dependencyRegistry.invalidate(
        DEP_ELEMENTS_KIND,
        oldKind,
        null,
        `elements-kind:${oldKind}->${newKind}`,
      );
    }
    return this.elements.length;
  }

  pop(): TaggedValue | undefined {
    if (this.elements.length === 0) return undefined;
    return this.elements.pop();
  }

  shift(): TaggedValue | undefined {
    if (this.elements.length === 0) return undefined;
    return this.elements.shift();
  }

  unshift(...values: TaggedValue[]): number {
    for (let i = 0; i < values.length; i++) {
      const oldKind = this.elementsKind;
      this.elementsKind = mergeElementsKind(this.elementsKind, values[i]!);
      if (oldKind !== this.elementsKind) {
        dependencyRegistry.invalidate(
          DEP_ELEMENTS_KIND,
          oldKind,
          null,
          `elements-kind:${oldKind}->${this.elementsKind}`,
        );
      }
    }
    if (values.length > 0) {
      this.elements = [...values, ...this.elements];
    }
    return this.elements.length;
  }

  splice(
    start: number,
    deleteCount?: number,
    ...items: TaggedValue[]
  ): Array<TaggedValue | undefined> {
    const len = this.elements.length;
    let actualStart =
      start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    let actualDeleteCount;
    if (deleteCount === undefined) {
      actualDeleteCount = len - actualStart;
    } else {
      actualDeleteCount = Math.min(Math.max(deleteCount, 0), len - actualStart);
    }

    const removed: Array<TaggedValue | undefined> = [];
    for (let i = 0; i < actualDeleteCount; i++) {
      removed.push(this.elements[actualStart + i]);
    }

    const tail = this.elements.slice(actualStart + actualDeleteCount);
    this.elements.length = actualStart;
    for (let i = 0; i < items.length; i++) {
      const oldKind = this.elementsKind;
      this.elementsKind = mergeElementsKind(this.elementsKind, items[i]!);
      if (oldKind !== this.elementsKind) {
        dependencyRegistry.invalidate(
          DEP_ELEMENTS_KIND,
          oldKind,
          null,
          `elements-kind:${oldKind}->${this.elementsKind}`,
        );
      }
      this.elements.push(items[i]!);
    }
    for (let i = 0; i < tail.length; i++) {
      this.elements.push(tail[i]);
    }

    return removed;
  }

  indexOf(target: TaggedValue, fromIndex?: number): number {
    const start =
      fromIndex !== undefined
        ? fromIndex < 0
          ? Math.max(this.elements.length + fromIndex, 0)
          : fromIndex
        : 0;
    for (let i = start; i < this.elements.length; i++) {
      const el = this.elements[i];
      if (strictEqual(el === undefined ? mkUndefined() : el, target)) return i;
    }
    return -1;
  }

  includes(target: TaggedValue, fromIndex?: number): boolean {
    return this.indexOf(target, fromIndex) !== -1;
  }

  find(predicate: ArrayCallback<boolean>): TaggedValue | undefined {
    for (let i = 0; i < this.elements.length; i++) {
      if (predicate(this.elements[i], i, this)) return this.elements[i];
    }
    return undefined;
  }

  findIndex(predicate: ArrayCallback<boolean>): number {
    for (let i = 0; i < this.elements.length; i++) {
      if (predicate(this.elements[i], i, this)) return i;
    }
    return -1;
  }

  forEach(callback: ArrayCallback<void>): void {
    for (let i = 0; i < this.elements.length; i++) {
      callback(this.elements[i], i, this);
    }
  }

  map(callback: ArrayCallback<TaggedValue | undefined>): JSArray {
    const result: Array<TaggedValue | undefined> = [];
    for (let i = 0; i < this.elements.length; i++) {
      result.push(callback(this.elements[i], i, this));
    }
    return new JSArray(result);
  }

  filter(predicate: ArrayCallback<boolean>): JSArray {
    const result: Array<TaggedValue | undefined> = [];
    for (let i = 0; i < this.elements.length; i++) {
      if (predicate(this.elements[i], i, this)) {
        result.push(this.elements[i]);
      }
    }
    return new JSArray(result);
  }

  reduce(
    callback: (
      accumulator: TaggedValue | undefined,
      value: TaggedValue | undefined,
      index: number,
      array: JSArray,
    ) => TaggedValue | undefined,
    initialValue?: TaggedValue,
  ): TaggedValue | undefined {
    let accumulator: TaggedValue | undefined;
    let startIndex: number;
    if (initialValue !== undefined) {
      accumulator = initialValue;
      startIndex = 0;
    } else {
      if (this.elements.length === 0) {
        throw new TypeError("Reduce of empty array with no initial value");
      }
      accumulator = this.elements[0];
      startIndex = 1;
    }
    for (let i = startIndex; i < this.elements.length; i++) {
      accumulator = callback(accumulator, this.elements[i], i, this);
    }
    return accumulator;
  }

  concat(
    ...arrays: Array<JSArray | Array<TaggedValue | undefined> | TaggedValue>
  ): JSArray {
    const result = [...this.elements];
    for (let i = 0; i < arrays.length; i++) {
      const other = arrays[i];
      if (other instanceof JSArray) {
        for (let j = 0; j < other.elements.length; j++) {
          result.push(other.elements[j]);
        }
      } else if (Array.isArray(other)) {
        for (let j = 0; j < other.length; j++) {
          result.push(other[j]);
        }
      } else {
        result.push(other);
      }
    }
    return new JSArray(result);
  }

  slice(start?: number, end?: number): JSArray {
    const len = this.elements.length;
    let s =
      start === undefined
        ? 0
        : start < 0
          ? Math.max(len + start, 0)
          : Math.min(start, len);
    let e =
      end === undefined
        ? len
        : end < 0
          ? Math.max(len + end, 0)
          : Math.min(end, len);
    const result: Array<TaggedValue | undefined> = [];
    for (let i = s; i < e; i++) {
      result.push(this.elements[i]);
    }
    return new JSArray(result);
  }

  join(separator?: string): string {
    const sep = separator !== undefined ? String(separator) : ",";
    const parts: string[] = [];
    for (let i = 0; i < this.elements.length; i++) {
      const el = this.elements[i];
      if (el === undefined || el === null) {
        parts.push("");
      } else {
        const tag = getTag(el);
        if (tag === "undefined" || tag === "null") {
          parts.push("");
        } else {
          parts.push(toString(el));
        }
      }
    }
    return parts.join(sep);
  }

  reverse(): this {
    this.elements.reverse();
    return this;
  }

  sort(
    compareFn?: (
      a: TaggedValue | undefined,
      b: TaggedValue | undefined,
    ) => number,
  ): this {
    if (compareFn) {
      this.elements.sort(compareFn);
    } else {
      this.elements.sort((a, b) => {
        const aStr = toDisplayString(a === undefined ? mkUndefined() : a);
        const bStr = toDisplayString(b === undefined ? mkUndefined() : b);
        if (aStr < bStr) return -1;
        if (aStr > bStr) return 1;
        return 0;
      });
    }
    return this;
  }

  getElementsKind(): ElementsKindName {
    return this.elementsKind;
  }

  getProperty(name: string): TaggedValue | number | undefined {
    if (name === "length") return this.elements.length;
    const desc = this.hiddenClass.lookupProperty(name);
    if (desc) {
      if (desc.offset < MAX_IN_OBJECT_PROPERTIES) {
        return this.slots[desc.offset];
      }
      return this.overflowProperties.get(name);
    }
    return undefined;
  }

  setProperty(name: string, value: TaggedValue): void {
    if (name === "length") {
      const len = toNumber(value);
      this.setLength(len);
      return;
    }
    const desc = this.hiddenClass.lookupProperty(name);
    if (desc) {
      if (desc.offset < MAX_IN_OBJECT_PROPERTIES) {
        this.slots[desc.offset] = value;
      } else {
        this.overflowProperties.set(name, value);
      }
      dependencyRegistry.invalidate(
        DEP_MAP,
        this.hiddenClass.id,
        this.hiddenClass.version,
        `array-store:${name}`,
      );
    } else {
      this.hiddenClass.decrementObjectCount();
      const newHC = this.hiddenClass.transition(name);
      if (newHC) {
        this.hiddenClass = newHC;
        this.hiddenClass.incrementObjectCount();
        const newDesc = newHC.lookupProperty(name);
        if (newDesc && newDesc.offset < MAX_IN_OBJECT_PROPERTIES) {
          while (this.slots.length <= newDesc.offset) {
            this.slots.push(undefined);
          }
          this.slots[newDesc.offset] = value;
        } else if (newDesc) {
          this.overflowProperties.set(name, value);
        }
      }
    }
  }

  getMapId(): number {
    return this.hiddenClass.id;
  }

  toString(): string {
    const items = this.elements.map((el) => {
      if (el === undefined || isUndefined(el)) return "undefined";
      if (isNull(el)) return "null";
      return `${getTag(el)}:${toDisplayString(el)}`;
    });
    return `[${items.join(", ")}]`;
  }
}
