import { JSObject } from "./js-object.js";
import { JSArray } from "./js-array.js";
import { JSProxy } from "../exotic/js-proxy.js";
import type { HiddenClass } from "../maps/hidden-class.js";
import {
  OrderedHashMap,
  OrderedHashSet,
  EphemeronHashTable,
} from "./js-collections.js";
import {
  getInitialMap,
  INSTANCE_TYPE_MAP,
  INSTANCE_TYPE_SET,
  INSTANCE_TYPE_WEAKMAP,
} from "../maps/hidden-class.js";
import { bindWriteBarrierGC } from "../../gc/write-barrier.js";
import type { TaggedValue } from "../../core/value/index.js";

type BoundGC = {
  allocate<T extends object>(object: T, pretenure?: boolean): T;
  rememberedSet: { record(holder: object): void };
  isIncrementalMarkingActive(): boolean;
  incrementalWriteBarrier(holder: object, newRef: object): void;
};

export type CollectionObject = JSObject & {
  _mapData?: OrderedHashMap;
  _setData?: OrderedHashSet;
  _weakMapData?: EphemeronHashTable;
  _primitiveValue?: TaggedValue;
};

let _gc: BoundGC | null = null;

export function bindGC(gc: BoundGC | null): void {
  _gc = gc;
  bindWriteBarrierGC(gc);
}

export function createJSObject(
  hiddenClass?: HiddenClass | null,
  pretenure = false,
): JSObject {
  const obj = new JSObject(hiddenClass);
  if (_gc) {
    _gc.allocate(obj, pretenure);
  }
  return obj;
}

export function createJSArray(
  elements?: Array<TaggedValue | undefined>,
): JSArray {
  const arr = new JSArray(elements);
  if (_gc) {
    _gc.allocate(arr);
  }
  return arr;
}

export function createJSMap(): CollectionObject {
  const obj = new JSObject(getInitialMap(INSTANCE_TYPE_MAP)) as CollectionObject;
  obj._mapData = new OrderedHashMap();
  if (_gc) _gc.allocate(obj);
  return obj;
}

export function createJSSet(): CollectionObject {
  const obj = new JSObject(getInitialMap(INSTANCE_TYPE_SET)) as CollectionObject;
  obj._setData = new OrderedHashSet();
  if (_gc) _gc.allocate(obj);
  return obj;
}

export function createJSWeakMap(): CollectionObject {
  const obj = new JSObject(
    getInitialMap(INSTANCE_TYPE_WEAKMAP),
  ) as CollectionObject;
  obj._weakMapData = new EphemeronHashTable();
  if (_gc) _gc.allocate(obj);
  return obj;
}

export function createJSPrimitiveWrapper(
  instanceType: string,
  primitiveValue: TaggedValue,
): CollectionObject {
  const obj = new JSObject(getInitialMap(instanceType)) as CollectionObject;
  obj._primitiveValue = primitiveValue;
  if (_gc) _gc.allocate(obj);
  return obj;
}

export function createJSProxy(target: TaggedValue, handler: TaggedValue): JSProxy {
  const proxy = new JSProxy(target, handler);
  if (_gc) {
    _gc.allocate(proxy);
  }
  return proxy;
}
