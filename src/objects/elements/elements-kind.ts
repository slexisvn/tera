import { getTag } from "../../core/value/index.js";

export const PACKED_SMI = "PACKED_SMI";
export const PACKED_DOUBLE = "PACKED_DOUBLE";
export const PACKED_TAGGED = "PACKED_TAGGED";
export const HOLEY_SMI = "HOLEY_SMI";
export const HOLEY_DOUBLE = "HOLEY_DOUBLE";
export const HOLEY_TAGGED = "HOLEY_TAGGED";

export const ElementsKind = Object.freeze({
  PACKED_SMI,
  PACKED_DOUBLE,
  PACKED_TAGGED,
  HOLEY_SMI,
  HOLEY_DOUBLE,
  HOLEY_TAGGED,
});

export type ElementsKindName = (typeof ElementsKind)[keyof typeof ElementsKind];

const VALUE_SMI = "smi";
const VALUE_DOUBLE = "double";
const VALUE_TAGGED = "tagged";

export function isHoleyElementsKind(kind: ElementsKindName): boolean {
  return kind === HOLEY_SMI || kind === HOLEY_DOUBLE || kind === HOLEY_TAGGED;
}

export function makeHoleyElementsKind(kind: ElementsKindName): ElementsKindName {
  if (kind === PACKED_SMI) return HOLEY_SMI;
  if (kind === PACKED_DOUBLE) return HOLEY_DOUBLE;
  return HOLEY_TAGGED;
}

export function classifyElementValue(value: RuntimeValue): string {
  const tag = getTag(value);
  if (tag === "smi") return VALUE_SMI;
  if (tag === "double") return VALUE_DOUBLE;
  return VALUE_TAGGED;
}

export function mergeElementsKind(
  currentKind: ElementsKindName,
  value: RuntimeValue,
  makesHole = false,
): ElementsKindName {
  const holey = makesHole || isHoleyElementsKind(currentKind);
  const valueKind = classifyElementValue(value);

  if (
    currentKind === PACKED_TAGGED ||
    currentKind === HOLEY_TAGGED ||
    valueKind === VALUE_TAGGED
  ) {
    return holey ? HOLEY_TAGGED : PACKED_TAGGED;
  }

  if (
    currentKind === PACKED_DOUBLE ||
    currentKind === HOLEY_DOUBLE ||
    valueKind === VALUE_DOUBLE
  ) {
    return holey ? HOLEY_DOUBLE : PACKED_DOUBLE;
  }

  return holey ? HOLEY_SMI : PACKED_SMI;
}

export function inferElementsKind(elements: RuntimeValue[]): ElementsKindName {
  let kind: ElementsKindName = PACKED_SMI;
  for (let i = 0; i < elements.length; i++) {
    if (elements[i] === undefined) {
      kind = makeHoleyElementsKind(kind);
    } else {
      kind = mergeElementsKind(kind, elements[i]);
    }
  }
  return kind;
}
