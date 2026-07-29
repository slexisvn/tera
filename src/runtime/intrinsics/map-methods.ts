import {
  mkUndefined,
  mkBool,
  isFunction,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import {
  wrapValueIterator,
  wrapEntryIterator,
} from "../iteration/iterator.js";
import { INSTANCE_TYPE_MAP } from "../../objects/maps/hidden-class.js";
import { getCollectionData } from "./collection-data.js";
import { argOrUndefined } from "../builtins/index.js";

type MapData = {
  get(key: TaggedValue): TaggedValue | undefined;
  set(key: TaggedValue, value: TaggedValue): void;
  has(key: TaggedValue): boolean;
  delete(key: TaggedValue): boolean;
  clear(): void;
  iterateEntries(): IterableIterator<[TaggedValue, TaggedValue]>;
  iterateKeys(): IterableIterator<TaggedValue>;
  iterateValues(): IterableIterator<TaggedValue>;
};

type InterpreterLike = {
  callFunctionValue(fn: TaggedValue, args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
};

type BuiltinMethod = {
  name: string;
  call(args: TaggedValue[], thisValue: TaggedValue, interpreter?: InterpreterLike): TaggedValue;
};

function getMapData(thisValue: TaggedValue): MapData {
  return getCollectionData<MapData>(
    thisValue,
    "_mapData",
    INSTANCE_TYPE_MAP,
    "Map",
  );
}

export const MAP_METHODS = {
  get: {
    name: "Map.prototype.get",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const map = getMapData(thisValue);
      const key = argOrUndefined(args, 0);
      const val = map.get(key);
      return val !== undefined ? val : mkUndefined();
    },
  },

  set: {
    name: "Map.prototype.set",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const map = getMapData(thisValue);
      const key = argOrUndefined(args, 0);
      const value = args.length > 1 ? args[1] : mkUndefined();
      map.set(key, value);
      return thisValue;
    },
  },

  has: {
    name: "Map.prototype.has",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const map = getMapData(thisValue);
      const key = argOrUndefined(args, 0);
      return mkBool(map.has(key));
    },
  },

  delete: {
    name: "Map.prototype.delete",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const map = getMapData(thisValue);
      const key = argOrUndefined(args, 0);
      return mkBool(map.delete(key));
    },
  },

  clear: {
    name: "Map.prototype.clear",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      getMapData(thisValue).clear();
      return mkUndefined();
    },
  },

  forEach: {
    name: "Map.prototype.forEach",
    call(args: TaggedValue[], thisValue: TaggedValue, interpreter?: InterpreterLike) {
      const map = getMapData(thisValue);
      const callback = args[0];
      if (!isFunction(callback)) throw new Error("TypeError: callback is not a function");
      for (const [key, value] of map.iterateEntries()) {
        interpreter!.callFunctionValue(callback as TaggedValue, [value, key, thisValue], mkUndefined());
      }
      return mkUndefined();
    },
  },

  entries: {
    name: "Map.prototype.entries",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const map = getMapData(thisValue);
      return wrapEntryIterator(map.iterateEntries());
    },
  },

  keys: {
    name: "Map.prototype.keys",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const map = getMapData(thisValue);
      return wrapValueIterator(map.iterateKeys());
    },
  },

  values: {
    name: "Map.prototype.values",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const map = getMapData(thisValue);
      return wrapValueIterator(map.iterateValues());
    },
  },
} as Record<string, BuiltinMethod>;
