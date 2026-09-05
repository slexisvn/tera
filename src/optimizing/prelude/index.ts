import type { ASTNode } from "../../frontend/ast/index.js";
import { fixedTextPrelude, rewriteFixedTexts } from "./fixed-text.js";
import { FLOAT_MOD_FN, floatModPrelude } from "./float-mod.js";
import {
  mathTranscendentalPrelude,
  rewriteMathTranscendentals,
} from "./math-transcendentals.js";
import { rewriteTextMethods, textMethodPrelude } from "./text-methods.js";

interface SourcePrelude {
  readonly emit: (roots: readonly ASTNode[]) => string;
  readonly adopt?: (roots: readonly ASTNode[]) => unknown;
  readonly lowered?: readonly string[];
}

const SOURCE_PRELUDES: readonly SourcePrelude[] = [
  { emit: fixedTextPrelude, adopt: rewriteFixedTexts },
  { emit: textMethodPrelude, adopt: rewriteTextMethods },
  { emit: mathTranscendentalPrelude, adopt: rewriteMathTranscendentals },
  { emit: floatModPrelude, lowered: [FLOAT_MOD_FN] },
];

export const LOWERED_PRELUDE_FUNCTIONS: ReadonlySet<string> = new Set<string>(
  SOURCE_PRELUDES.flatMap((prelude) => prelude.lowered ?? []),
);

export function sourcePreludes(roots: readonly ASTNode[]): string {
  return SOURCE_PRELUDES.map((prelude) => prelude.emit(roots)).join("");
}

export function adoptSourcePreludes(roots: readonly ASTNode[]): void {
  for (const prelude of SOURCE_PRELUDES) prelude.adopt?.(roots);
}
