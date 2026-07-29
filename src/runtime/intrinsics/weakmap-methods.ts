import {
  mkUndefined,
  mkBool,
  isObject,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import { INSTANCE_TYPE_WEAKMAP } from "../../objects/maps/hidden-class.js";
import { getCollectionData } from "./collection-data.js";
import { argOrUndefined } from "../builtins/index.js";

type WeakMapData = {
  get(key: TaggedValue): TaggedValue | undefined;
  set(key: TaggedValue, value: TaggedValue): void;
  has(key: TaggedValue): boolean;
  delete(key: TaggedValue): boolean;
};

type BuiltinMethod = {
  name: string;
  call(args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
};

function getWeakMapData(thisValue: TaggedValue): WeakMapData {
  return getCollectionData<WeakMapData>(
    thisValue,
    "_weakMapData",
    INSTANCE_TYPE_WEAKMAP,
    "WeakMap",
  );
}

export const WEAKMAP_METHODS = {
  get: {
    name: "WeakMap.prototype.get",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const wm = getWeakMapData(thisValue);
      const key = argOrUndefined(args, 0);
      const val = wm.get(key);
      return val !== undefined ? val : mkUndefined();
    },
  },

  set: {
    name: "WeakMap.prototype.set",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const wm = getWeakMapData(thisValue);
      const key = argOrUndefined(args, 0);
      if (!isObject(key)) throw new Error("TypeError: Invalid value used as weak map key");
      const value = args.length > 1 ? args[1] : mkUndefined();
      wm.set(key, value);
      return thisValue;
    },
  },

  has: {
    name: "WeakMap.prototype.has",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const wm = getWeakMapData(thisValue);
      const key = argOrUndefined(args, 0);
      return mkBool(wm.has(key));
    },
  },

  delete: {
    name: "WeakMap.prototype.delete",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const wm = getWeakMapData(thisValue);
      const key = argOrUndefined(args, 0);
      return mkBool(wm.delete(key));
    },
  },
} as Record<string, BuiltinMethod>;
