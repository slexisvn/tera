import { getPayload } from "../../core/value/index.js";
import type { HeapPayload, TaggedValue } from "../../core/value/index.js";
import type { GCObject } from "../../gc/incremental-marker.js";
import type { PropertyDescriptor } from "../maps/hidden-class.js";

type ProxyHiddenClass = {
  id: number;
  version: number;
  isDeprecated: boolean;
  properties: Map<string, PropertyDescriptor>;
  lookupProperty(): null;
  hasProperty(): false;
  incrementObjectCount(): void;
  decrementObjectCount(): void;
};

export const PROXY_HIDDEN_CLASS: ProxyHiddenClass = {
  id: -100,
  version: 0,
  isDeprecated: false,
  properties: new Map(),
  lookupProperty() {
    return null;
  },
  hasProperty() {
    return false;
  },
  incrementObjectCount() {},
  decrementObjectCount() {},
};

export class JSProxy {
  hiddenClass: ProxyHiddenClass;
  target: TaggedValue;
  handler: TaggedValue;
  prototype: null;
  gcHeader: GCObject["gcHeader"] | null;
  isProxy: true;

  constructor(target: TaggedValue, handler: TaggedValue) {
    this.hiddenClass = PROXY_HIDDEN_CLASS;
    this.hiddenClass.incrementObjectCount();
    this.target = target;
    this.handler = handler;
    this.prototype = null;
    this.gcHeader = null;
    this.isProxy = true;
  }

  visitReferences(callback: (value: GCObject) => void): void {
    for (const val of [this.target, this.handler]) {
      const payload = getPayload(val);
      if (payload && typeof payload === "object" && "gcHeader" in payload && payload.gcHeader) {
        callback(payload);
      }
    }
  }

  getMapId(): number {
    return this.hiddenClass.id;
  }
}

export function isJSProxyObject(obj: HeapPayload): obj is JSProxy {
  return (
    obj instanceof JSProxy ||
    !!(obj && typeof obj === "object" && (obj as JSProxy).isProxy === true)
  );
}
