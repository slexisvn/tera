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
    why: "Knowing the shape turns a dictionary lookup into a fixed field offset. It matches an allocation whose every use is a map guard feeding a field store, and a map guard is something only feedback produces — so it has nothing to match ahead of time.",
    tier: "jit",
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
    why: "It trades code size for a branch-free loop body. Its budget is forced to zero when the graph can deoptimize, so it is effectively AOT-only — and zero again at -O none and -O baseline, where even AOT gives it nothing to spend.",
    tier: "aot",
    source: "src/optimizing/passes/unswitching.ts",
  },
  "redundant-checks": {
    what: "Removes a check that a dominating check already made.",
    why: "Guards are cheap individually and ruinous in a loop. Dominance is what makes the removal sound. It pairs map, smi, number and elements-kind guards, and ahead of time the only one of those that exists is the single guard per declared parameter — one guard is never redundant with itself, so it finds nothing to pair.",
    tier: "jit",
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
    why: "An object that never escapes does not need to exist, and a fresh one per iteration goes too — see the \"Object per iteration\" sample. What it will not fold is an object a loop phi carries in from the iteration before: a deopt frame would then have to rebuild a different object than the one the allocation makes, and a frame records one rebuild per allocation site. That is what keeps the object in \"Object in a loop\" alive on both tiers — the loop-carried local, not the field reads.",
    tier: "both",
    source: "src/optimizing/passes/escape-analysis.ts",
  },
  "allocation-sinking": {
    what: "Moves an allocation down to the paths that actually need it.",
    why: "JIT-only: it is sound only because a deoptimization can rematerialize the object that was never built. AOT has nowhere to rematerialize into. It reads explicit Deoptimize nodes, so an allocation whose only deopt exposure is the frame state hanging off a guard is not one it can move — escape analysis is what handles those.",
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
    why: "Peeling alone changes nothing. The win only appears once redundant-check elimination runs after it — which is why the two always appear as a pair, and why both are JIT-only: the one guard AOT emits sits in the entry block, which is in no loop to peel it out of.",
    tier: "jit",
    source: "src/optimizing/passes/loop-opts.ts",
  },
  "dead-store-elimination": {
    what: "Removes a store nothing can observe.",
    why: "Escape analysis usually creates these by turning field reads into SSA values, leaving the writes with no readers. It runs on both tiers, but it only tracks field, element and global stores — ahead of time, where property writes stay generic until lowering, a global overwritten before anyone reads it is the shape that reaches it.",
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
    why: "Where a tagged value becomes an untagged double or int32, and where the boxing that pays for it goes. Only targets that carry tagged values run it, which in this tool means wasm alone — the native backends were never tagged, so they have nothing to unbox.",
    tier: "jit",
    source: "src/optimizing/passes/repr-selection.ts",
  },
  "representation-check": {
    what: "Verifies that every value ended up with a representation its users accept.",
    why: "A representation mismatch silently returns a handle index as a number, so it is checked rather than trusted. It runs beside representation-selection, on tagged targets only.",
    tier: "jit",
    source: "src/optimizing/passes/repr-selection.ts",
  },
  "speculation-lowering": {
    what: "Turns a speculative assumption into a proven type, or into a generic operation that handles any input.",
    why: "The JIT does not need this: it speculates by deoptimizing to the interpreter, so its strategy for this pass does nothing at all. A target with no interpreter to fall back to has to settle every assumption here instead.",
    tier: "aot",
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
  "callee-signatures": {
    what: "Resolves which function a call site really reaches, and stamps its signature onto the call.",
    why: "A call with a known callee can be checked, inlined and given a fixed argument layout; a generic one cannot.",
    tier: "both",
    source: "src/optimizing/passes/class-member-lowering.ts",
  },
  "callee-returns": {
    what: "Answers what a resolved call returns, so the value gets a type instead of any.",
    why: "Type inference stops at a call it cannot see through, and every pass after it inherits that blind spot.",
    tier: "both",
    source: "src/optimizing/passes/class-member-lowering.ts",
  },
  "element-member-lowering": {
    what: "Turns a member access on a known element type into a direct field load or call.",
    why: "The same fixed-offset trick as class members, applied to the element type an array was proved to hold.",
    tier: "both",
    source: "src/optimizing/passes/class-member-lowering.ts",
  },
  "array-allocation-shapes": {
    what: "Gives an array literal a concrete element type and layout.",
    why: "An array whose elements are all int32 can be stored unboxed; without the shape every slot stays tagged.",
    tier: "both",
    source: "src/optimizing/passes/array-shapes.ts",
  },
  "builtin-domains": {
    what: "Faults a builtin call whose argument cannot be proved inside the range the builtin accepts.",
    why: "char_code_at past the end and repeat with a negative count have no answer. The JIT deoptimizes instead, so only untagged targets need the explicit check.",
    tier: "aot",
    source: "src/optimizing/passes/builtin-domains.ts",
  },
  "array-access-lowering": {
    what: "Rewrites a generic index read or write into LoadElement or StoreElement once the element type is known.",
    why: "GenericGetIndex has to ask what it is indexing at runtime; LoadElement is an address computation.",
    tier: "both",
    source: "src/optimizing/passes/array-shapes.ts",
  },
  "array-method-lowering": {
    what: "Replaces an array method call with the operation or known function behind it.",
    why: "push, map and friends are ordinary calls in the graph until something proves the receiver is an array.",
    tier: "both",
    source: "src/optimizing/passes/array-methods.ts",
  },
  "object-literal-shapes": {
    what: "Turns the property stores that follow a NewObject into a declared shape.",
    why: "A literal built field by field looks like a dictionary; naming the shape is what allows fixed offsets.",
    tier: "both",
    source: "src/optimizing/passes/object-literal-shapes.ts",
  },
  "object-surface": {
    what: "Lowers Object.keys and Object.values into the loops that produce them.",
    why: "They are library calls at the source level and plain iteration underneath.",
    tier: "both",
    source: "src/optimizing/passes/object-surface.ts",
  },
  "collection-surface": {
    what: "Lowers Map and Set operations onto their concrete representation.",
    why: "The collection surface is a small language of its own; this is where it stops being calls.",
    tier: "both",
    source: "src/optimizing/passes/collection-surface.ts",
  },
  "json-surface": {
    what: "Lowers JSON.stringify into the concrete conversion for the shape being written.",
    why: "There is no general serializer to call: each shape gets the code its own fields need.",
    tier: "both",
    source: "src/optimizing/passes/json-surface.ts",
  },
  "math-surface": {
    what: "Folds Math.PI and Math.E to constants and lowers min, max and pow.",
    why: "A constant is worth more than a call: everything downstream can fold through it.",
    tier: "both",
    source: "src/optimizing/passes/math-surface.ts",
  },
  "global-builtin-lowering": {
    what: "Turns a call to a global builtin into the operation it stands for.",
    why: "Until this runs the builtin is a LoadGlobal plus a generic call, which no later pass can reason about.",
    tier: "both",
    source: "src/optimizing/passes/global-builtin-lowering.ts",
  },
  "string-coercion": {
    what: "Inserts the conversion a string concatenation needs on the operand that is not a string.",
    why: "GenericAdd decides at runtime whether it is adding or concatenating; naming the coercion settles it here.",
    tier: "both",
    source: "src/optimizing/passes/string-coercion.ts",
  },
  "string-split-lowering": {
    what: "Rewrites split, slice and char_code_at into slices of the string that already exists.",
    why: "Slicing beats copying, and the result usually never outlives the call that made it.",
    tier: "both",
    source: "src/optimizing/passes/string-split.ts",
  },
  "boolean-text": {
    what: "Replaces the text conversion of a boolean with the two constant strings it can produce.",
    why: "There are only two answers; there is no reason to call a formatter for them.",
    tier: "both",
    source: "src/optimizing/passes/boolean-text.ts",
  },
  "static-reflection": {
    what: "Folds typeof and instanceof once inference already knows the answer.",
    why: "A reflection question the compiler can answer should not survive into the running program.",
    tier: "both",
    source: "src/optimizing/passes/static-reflection.ts",
  },
  "iterator-lowering": {
    what: "Rewrites the iterator protocol into the loop that walks the underlying value.",
    why: "IteratorInit, Next and Done are a protocol; over a known array they are an index and a length compare.",
    tier: "both",
    source: "src/optimizing/passes/iterator-lowering.ts",
  },
  "heap-iteration": {
    what: "Stamps element types and lowers iterators over and over until neither finds anything left.",
    why: "Each one feeds the other: a stamped element type reveals an iterator to lower, and lowering reveals more types.",
    tier: "both",
    source: "src/optimizing/target/legalization.ts",
  },
  "named-argument-lowering": {
    what: "Reorders named arguments into the positional order the callee declares.",
    why: "A machine call has positions, not names, and the mapping is known once the callee is.",
    tier: "both",
    source: "src/optimizing/passes/named-argument-lowering.ts",
  },
  "name-callee-constants": {
    what: "Gives every function constant a name a call site can refer to.",
    why: "A call to an unnamed constant has no symbol to emit; naming it is what makes the call linkable.",
    tier: "aot",
    source: "src/optimizing/drivers/aot.ts",
  },
  "name-function-values": {
    what: "Names function values that are stored or passed around rather than called directly.",
    why: "Same reason as callee constants, for the values that reach a call indirectly.",
    tier: "aot",
    source: "src/optimizing/drivers/aot.ts",
  },
  "drop-function-bindings": {
    what: "Removes the module-level bindings that only existed to hold a function.",
    why: "Once each function is a symbol, the variable that named it is dead weight.",
    tier: "aot",
    source: "src/optimizing/metadata/global-variables.ts",
  },
  "declare-global-variables": {
    what: "Declares the statics that module-level variables were turned into.",
    why: "The lowering created the addresses; this is what actually emits their definitions.",
    tier: "aot",
    source: "src/optimizing/metadata/global-variables.ts",
  },
  "module-start": {
    what: "Builds the entry that runs the top level of each module in order.",
    why: "A linked binary has one entry point, so module initialisation has to become an explicit sequence.",
    tier: "aot",
    source: "src/optimizing/drivers/aot.ts",
  },
  "promote-run-once-globals": {
    what: "Turns a global whose initialiser provably runs once into a constant.",
    why: "Startup work the compiler can do is startup work the binary does not have to.",
    tier: "aot",
    source: "src/optimizing/drivers/aot.ts",
  },

  declined: {
    what: "The optimizer was given this function and handed back no graph.",
    why: "Not every function can be compiled: async functions and generators are turned down outright, whatever their feedback says. The function keeps running in the interpreter.",
    tier: "jit",
  },
  codegen: {
    what: "The artifact the backend produced.",
    why: "The end of the road: the C, assembly or object bytes a linker turns into a binary.",
    tier: "aot",
  },
  "executed-graph": {
    what: "The optimized graph the engine actually compiled and ran, the first time this function got hot.",
    why: "Every other stage on this screen comes from optimizing the function again after the program finished, by which time feedback has changed. This is the one graph whose value numbers match what the runtime reports — a deopt event points here.",
    tier: "jit",
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
