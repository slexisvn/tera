export type PassTier = "both" | "jit" | "aot";

export type PassNote = {
  readonly what: string;
  readonly why: string;
  readonly tier: PassTier;
  readonly source?: string;
  readonly rerun?: string;
};

const RERUNS: readonly (readonly [string, string])[] = [
  ["-early", "An early run, before the heavy passes: it cleans up what the IR builder left behind."],
  ["-after-escape", "A second run: escape analysis just turned field accesses into plain values, which opens folding this pass could not see before."],
  ["-after-late-escape", "A run after the late escape analysis, for the same reason: new scalars mean new opportunities."],
  ["-after-unreachable", "A run after unreachable blocks were deleted, because dropping a predecessor can make a phi trivial."],
  ["-after-peeling", "A run right after loop-check peeling, which is the whole point of peeling: the peeled guard makes the in-loop copy redundant."],
  ["-late", "A late run, once earlier passes have simplified enough for it to find more."],
];

export const PASS_NOTES: Record<string, PassNote> = {
  tokenize: {
    what: "Splits the text into tokens, tracking indentation so the offside rule can close blocks.",
    why: "Tera has no braces: the lexer is where a change in indentation becomes a real block boundary.",
    tier: "both",
    source: "src/frontend/lexer/offside.ts",
  },
  parse: {
    what: "Builds the abstract syntax tree from the token stream.",
    why: "Everything downstream reads the tree, never the text. The tree is where syntax stops mattering.",
    tier: "both",
    source: "src/frontend/parser/language.ts",
  },
  typecheck: {
    what: "Runs the checker over the source and reports diagnostics.",
    why: "AOT always checks in strict mode, so a program that compiles ahead of time must satisfy the checker first.",
    tier: "both",
    source: "src/frontend/checker/index.ts",
  },
  bytecode: {
    what: "Register bytecode for one function, as the interpreter will execute it.",
    why: "This is tier 0. Every later tier optimizes exactly these semantics, and a deopt lands back here.",
    tier: "both",
    source: "src/bytecode/register/ops/bytecode.ts",
  },
  "ir-builder": {
    what: "The SSA graph as the builder produced it from bytecode plus feedback, before any pass ran.",
    why: "The baseline every later diff is measured against. Speculation the feedback justified is already here as guards.",
    tier: "both",
    source: "src/optimizing/builder/ir-builder.ts",
  },

  "parameter-type-guards": {
    what: "Inserts a guard for each parameter whose type was declared.",
    why: "A declared type is a promise the caller might break; the guard is where that promise becomes checkable.",
    tier: "both",
    source: "src/optimizing/passes/parameter-guards.ts",
  },
  "allocation-shape": {
    what: "Specializes allocations to a concrete hidden-class shape.",
    why: "Knowing the shape turns a dictionary lookup into a fixed field offset.",
    tier: "both",
    source: "src/optimizing/passes/allocation-shape.ts",
  },
  "ic-lowering": {
    what: "Turns inline-cache sites into map guards plus direct field access.",
    why: "The cache learned one shape while the program ran; this is where that observation becomes speculative code. AOT has no such observation to lower.",
    tier: "jit",
    source: "src/optimizing/passes/ic-lowering.ts",
  },
  "trivial-phi-elimination": {
    what: "Replaces a phi whose inputs all agree with that single value.",
    why: "SSA construction emits phis eagerly. Most turn out to have one real input, and every one left standing blocks later matching.",
    tier: "both",
    source: "src/optimizing/passes/dce.ts",
  },
  "dead-phi-elimination": {
    what: "Deletes phis nothing reads.",
    why: "A phi keeps its inputs alive; dropping it can free a whole chain of values.",
    tier: "both",
    source: "src/optimizing/passes/dce.ts",
  },
  "builtin-method-lowering": {
    what: "Replaces a builtin method call with the operation it really performs.",
    why: "Type inference has to prove the receiver's type first — that is why this pass requires the type-inference analysis.",
    tier: "both",
    source: "src/optimizing/passes/builtin-method-lowering.ts",
  },
  licm: {
    what: "Hoists loop-invariant computations out of the loop.",
    why: "Work that does not depend on the induction variable should run once, not once per iteration. Watch the diff: nothing is added or deleted, values simply move to the preheader.",
    tier: "both",
    source: "src/optimizing/passes/loop-opts.ts",
  },
  "loop-unswitching": {
    what: "Duplicates a loop for each side of a condition that does not change inside it.",
    why: "It trades code size for a branch-free loop body. Its budget is forced to zero when the graph can deoptimize, so it is effectively AOT-only.",
    tier: "aot",
    source: "src/optimizing/passes/unswitching.ts",
  },
  "redundant-checks": {
    what: "Removes a check that a dominating check already made.",
    why: "Guards are cheap individually and ruinous in a loop. Dominance is what makes the removal sound.",
    tier: "both",
    source: "src/optimizing/passes/checks.ts",
  },
  "type-narrowing": {
    what: "Narrows a value's type along the edge where a test proved something about it.",
    why: "Narrower types let later passes drop checks and pick cheaper representations.",
    tier: "both",
    source: "src/optimizing/passes/type-narrowing.ts",
  },
  sccp: {
    what: "Sparse conditional constant propagation: folds constants and prunes branches that cannot be taken.",
    why: "One walk over the lattice does constant folding and unreachable-code discovery together, which is strictly stronger than either alone.",
    tier: "both",
    source: "src/optimizing/passes/sccp.ts",
  },
  "algebraic-simplification": {
    what: "Rewrites expressions into cheaper equivalents.",
    why: "Canonical shapes make later passes match more often — GVN in particular.",
    tier: "both",
    source: "src/optimizing/passes/simplify.ts",
  },
  "load-elimination": {
    what: "Replaces a load with the value a previous store or load already produced.",
    why: "Needs points-to and mod-ref: without them any call in between could have clobbered the memory.",
    tier: "both",
    source: "src/optimizing/passes/load-elimination.ts",
  },
  "escape-analysis": {
    what: "Finds allocations that never escape and replaces their fields with plain SSA values.",
    why: "An object that never escapes does not need to exist. This is the difference between allocating in a loop and not.",
    tier: "both",
    source: "src/optimizing/passes/escape-analysis.ts",
  },
  "allocation-sinking": {
    what: "Moves an allocation down to the paths that actually need it.",
    why: "JIT-only: it is sound only because a deoptimization can rematerialize the object that was never built. AOT has nowhere to rematerialize into.",
    tier: "jit",
    source: "src/optimizing/passes/allocation-sinking.ts",
  },
  "intrinsic-cse": {
    what: "Shares repeated reads of the same intrinsic.",
    why: "Intrinsic reads look opaque to plain GVN, so they get their own pass.",
    tier: "both",
    source: "src/optimizing/passes/intrinsic-cse.ts",
  },
  gvn: {
    what: "Global value numbering with partial redundancy elimination.",
    why: "Two computations with the same value number are the same computation. PRE also catches the case where it is redundant on only some paths, by splitting critical edges.",
    tier: "both",
    source: "src/optimizing/passes/gvn.ts",
  },
  "bounds-check-elimination": {
    what: "Range analysis proves an index is in bounds and removes the check.",
    why: "A loop's own induction range is usually enough of a proof.",
    tier: "both",
    source: "src/optimizing/passes/checks.ts",
  },
  "strength-reduction": {
    what: "Replaces an expensive operation with a cheaper one of equal value.",
    why: "Multiplication by a constant becomes shifts and adds. Expect the node count to rise here — cheaper is not the same as fewer.",
    tier: "both",
    source: "src/optimizing/passes/simplify.ts",
  },
  "loop-check-peeling": {
    what: "Peels a guard out of the loop so the in-loop copy becomes redundant.",
    why: "Peeling alone changes nothing. The win only appears once redundant-check elimination runs after it — which is why the two always appear as a pair.",
    tier: "both",
    source: "src/optimizing/passes/loop-opts.ts",
  },
  "dead-store-elimination": {
    what: "Removes a store nothing can observe.",
    why: "Escape analysis usually creates these by turning field reads into SSA values, leaving the writes with no readers.",
    tier: "both",
    source: "src/optimizing/passes/dead-stores.ts",
  },
  "dead-code-elimination": {
    what: "Removes values nothing uses.",
    why: "Almost every other pass leaves debris; this is the pass that sweeps it.",
    tier: "both",
    source: "src/optimizing/passes/dce.ts",
  },
  "unreachable-block-elimination": {
    what: "Drops blocks no edge reaches.",
    why: "SCCP proves branches dead; this is what actually deletes the blocks behind them.",
    tier: "both",
    source: "src/optimizing/passes/dce.ts",
  },

  "representation-selection": {
    what: "Picks a machine representation for every value.",
    why: "Where a tagged value becomes an untagged double or int32, and where the boxing that pays for it goes.",
    tier: "both",
    source: "src/optimizing/passes/repr-selection.ts",
  },
  "representation-check": {
    what: "Verifies that every value ended up with a representation its users accept.",
    why: "A representation mismatch silently returns a handle index as a number, so it is checked rather than trusted.",
    tier: "both",
    source: "src/optimizing/passes/repr-selection.ts",
  },
  "speculation-lowering": {
    what: "Turns a speculative assumption into a concrete guard plus a deopt exit.",
    why: "This is the moment speculation becomes machine-checkable. Everything before it was only an intention.",
    tier: "jit",
    source: "src/optimizing/passes/speculation-lowering.ts",
  },
  "frame-state-elision": {
    what: "Drops frame states no guard can use.",
    why: "Frame states are what makes deopt possible and they keep values alive; the ones nothing can deopt to are pure cost.",
    tier: "both",
    source: "src/optimizing/passes/frame-state-elision.ts",
  },
  "if-conversion": {
    what: "Replaces a small diamond with a branch-free Select.",
    why: "Target-gated: only emitted where the backend really has a conditional move.",
    tier: "both",
    source: "src/optimizing/passes/if-conversion.ts",
  },
  "operation-legalization": {
    what: "Rewrites operations the target cannot emit into ones it can.",
    why: "A target without Select gets a diamond back instead of a refusal to compile.",
    tier: "both",
    source: "src/optimizing/passes/operation-legalization.ts",
  },
  "capability-check": {
    what: "Refuses the function when it needs something the target does not provide.",
    why: "Better an honest decline naming the capability than a binary that misbehaves.",
    tier: "aot",
    source: "src/optimizing/passes/capability-check.ts",
  },
  "string-boxing": {
    what: "Copies a produced string into a one-field box when it must outlive the call that made it.",
    why: "String storage has three classes; this is the one that keeps a returned string alive across a call.",
    tier: "aot",
    source: "src/optimizing/passes/string-boxing.ts",
  },
  "global-variable-lowering": {
    what: "Turns module-level variables into fixed statics.",
    why: "AOT has no global cell map to look names up in, so they must become addresses.",
    tier: "aot",
    source: "src/optimizing/passes/global-variable-lowering.ts",
  },
  "class-member-lowering": {
    what: "Resolves class member access to a fixed field offset or a direct call.",
    why: "Structural typing means the shape is known statically; there is nothing to look up at runtime.",
    tier: "both",
    source: "src/optimizing/passes/class-member-lowering.ts",
  },
  "generator-iteration": {
    what: "Rewrites the consumer side of the iterator protocol for a split generator.",
    why: "A generator becomes a frame plus a step function, so its callers have to stop speaking the protocol.",
    tier: "aot",
    source: "src/optimizing/passes/generator-iteration.ts",
  },
  "print-expansion": {
    what: "Expands print into the concrete conversions and runtime calls it needs.",
    why: "print is one builtin at the source level and a different sequence per argument type underneath.",
    tier: "aot",
    source: "src/optimizing/passes/print-expansion.ts",
  },
  "spread-calls": {
    what: "Turns a spread call into a fixed argument list.",
    why: "Machine calls have a fixed arity; the spread has to be resolved before selection.",
    tier: "both",
    source: "src/optimizing/passes/spread-calls.ts",
  },
  "zero-divisor": {
    what: "Guards a division whose divisor cannot be proved non-zero.",
    why: "Integer division by zero traps on real hardware. Only untagged targets run it — wasm never sees this pass.",
    tier: "aot",
    source: "src/optimizing/passes/zero-divisor.ts",
  },

  "instruction-selection": {
    what: "Turns SSA nodes into machine instructions with virtual registers.",
    why: "The first point where the target's real instruction set appears.",
    tier: "aot",
    source: "src/optimizing/machine/select.ts",
  },
  scheduling: {
    what: "Reorders independent instructions inside a region to hide latency.",
    why: "Regions end at any branch, and a guard puts one mid-block — which is why chain-bound loops gain nothing here.",
    tier: "aot",
    source: "src/optimizing/machine/schedule.ts",
  },
  "two-address-lowering": {
    what: "Rewrites three-operand form into the destructive two-operand form x64 actually has.",
    why: "Adds the copies the register allocator will then try to coalesce away.",
    tier: "aot",
    source: "src/optimizing/machine/two-address.ts",
  },
  "register-allocation": {
    what: "Linear-scan allocation over live intervals, plus the spills and reloads it needs.",
    why: "Virtual registers become real ones here; everything above this line pretended registers were free.",
    tier: "aot",
    source: "src/optimizing/machine/linear-scan.ts",
  },
  "frame-code": {
    what: "Inserts the prologue and epilogue for the frame layout that was just decided.",
    why: "The same prologue drives the unwind tables, so this is also where .eh_frame and .pdata come from.",
    tier: "aot",
    source: "src/optimizing/machine/frame-code.ts",
  },
  peephole: {
    what: "Local rewrites after allocation: dead moves, folded compares, redundant round trips.",
    why: "Allocation and frame insertion both leave patterns only a post-RA pass can see.",
    tier: "aot",
    source: "src/optimizing/machine/peephole.ts",
  },

  "uniquify-graph-names": {
    what: "Gives every function in the module a unique name.",
    why: "Symbols are global in a linked binary; two functions called `helper` would collide.",
    tier: "aot",
    source: "src/optimizing/drivers/aot.ts",
  },
  "module-captures": {
    what: "Turns captures of module-level bindings into globals.",
    why: "There is no enclosing scope to capture from once each function becomes a symbol.",
    tier: "aot",
    source: "src/optimizing/metadata/module-captures.ts",
  },
  "closure-conversion": {
    what: "Converts closures into explicit environment objects passed as arguments.",
    why: "AOT has no code pointers with attached state; a closure has to become data plus a known callee.",
    tier: "aot",
    source: "src/optimizing/metadata/closure-conversion.ts",
  },
  "promise-surface": {
    what: "Rewrites Promise.resolve/.then/.catch/.all into synthetic async functions.",
    why: "Compiling the surface away means the coroutine machinery only has to handle one shape.",
    tier: "aot",
    source: "src/optimizing/passes/promise-surface.ts",
  },
  "argument-specialization": {
    what: "Clones a function per distinct function-valued argument.",
    why: "Monomorphisation is how higher-order code compiles without code pointers.",
    tier: "aot",
    source: "src/optimizing/passes/function-argument-specialization.ts",
  },
  "adopt-inferred-types": {
    what: "Writes inferred argument types back onto the specialized clones.",
    why: "A clone that knows its argument types can be compiled; the generic original could not.",
    tier: "aot",
    source: "src/optimizing/passes/inferred-types.ts",
  },
  "split-generators": {
    what: "Splits `fn*` into a frame object and a `$step` function.",
    why: "Reuses the coroutine machinery: a generator is a resumable frame with an explicit state.",
    tier: "aot",
    source: "src/optimizing/passes/generators.ts",
  },
  "module-inlining": {
    what: "Inlines calls bottom-up across the whole module on a cost model.",
    why: "AOT sees every callee at once, so it inlines on real sizes instead of on call-site feedback.",
    tier: "aot",
    source: "src/optimizing/passes/inlining.ts",
  },
  "error-surface": {
    what: "Lowers thrown Errors to the text they report.",
    why: "A thrown Error is carried as its message; `.message` becomes a slice of it.",
    tier: "aot",
    source: "src/optimizing/passes/error-surface.ts",
  },
  codegen: {
    what: "The artifact the backend produced.",
    why: "The end of the road: the C, assembly or object bytes a linker turns into a binary.",
    tier: "aot",
  },
};

export function noteFor(pass: string | null): PassNote | null {
  if (pass === null) return null;
  const direct = PASS_NOTES[pass];
  if (direct !== undefined) return direct;
  for (const [suffix, rerun] of RERUNS) {
    if (!pass.endsWith(suffix)) continue;
    const base = PASS_NOTES[pass.slice(0, -suffix.length)];
    if (base !== undefined) return { ...base, rerun };
  }
  return null;
}
