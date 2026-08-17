import { getPayload, type HeapPayload, type TaggedValue } from "../../core/value/index.js";

export interface SymbolKeyed {
  symbolProperties: Map<HeapPayload, TaggedValue> | null;
}

export function readSymbolProperty(
  owner: SymbolKeyed,
  taggedSym: TaggedValue,
): TaggedValue | undefined {
  if (!owner.symbolProperties) return undefined;
  return owner.symbolProperties.get(getPayload(taggedSym));
}

export function writeSymbolProperty(
  owner: SymbolKeyed,
  taggedSym: TaggedValue,
  value: TaggedValue,
): void {
  if (!owner.symbolProperties) owner.symbolProperties = new Map();
  owner.symbolProperties.set(getPayload(taggedSym), value);
}

export function removeSymbolProperty(owner: SymbolKeyed, taggedSym: TaggedValue): boolean {
  if (!owner.symbolProperties) return true;
  return owner.symbolProperties.delete(getPayload(taggedSym));
}

export function ownsSymbolProperty(owner: SymbolKeyed, taggedSym: TaggedValue): boolean {
  if (!owner.symbolProperties) return false;
  return owner.symbolProperties.has(getPayload(taggedSym));
}
