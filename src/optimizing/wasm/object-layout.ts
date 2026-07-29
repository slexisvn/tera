import {
  PACKED_SMI,
  PACKED_DOUBLE,
  HOLEY_SMI,
  HOLEY_DOUBLE,
  PACKED_TAGGED,
  HOLEY_TAGGED,
} from "../../objects/elements/elements-kind.js";
import type { ElementsKindName } from "../../objects/elements/elements-kind.js";
import type * as ir from "../ir/index.js";

export const ELEMENTS_KIND_IDS: Map<ElementsKindName, number> = new Map([
  [PACKED_SMI, 1],
  [PACKED_DOUBLE, 2],
  [PACKED_TAGGED, 3],
  [HOLEY_SMI, 4],
  [HOLEY_DOUBLE, 5],
  [HOLEY_TAGGED, 6],
]);

export function elementsKindId(kind: ElementsKindName): number {
  return ELEMENTS_KIND_IDS.get(kind) || 0;
}

export function elementsKindName(value: ir.IRMetadataValue): ElementsKindName | null {
  return typeof value === "string" && ELEMENTS_KIND_IDS.has(value as ElementsKindName)
    ? value as ElementsKindName
    : null;
}
