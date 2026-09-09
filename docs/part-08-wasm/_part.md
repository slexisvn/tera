# Part VIII — The graph becomes WebAssembly   ⟨I · · J · N⟩

> **Status:** written

**What arrived.** From Part VII: one optimized `CFGFunction` per function, in canonical-phi
SSA, typed by the analysis cached under `typeInferenceAnalysisId`, with a `frameState` edge on
every node that can give up, and the warm `AnalysisManager` the middle end returned
([Ch 50 § what-leaves](../part-07-optimization/50-inlining-and-tail-calls.md)). The graph is
target-neutral. It does not know whether it is about to become WebAssembly bytes handed to
`WebAssembly.Instance`, or C, or x64 machine code inside a PE file.

**What leaves.** An `OptimizedCode` closure the interpreter installs in place of the bytecode —
and behind it, a wasm module the host instantiated, a wrapper that marshals every heap value
across a boundary, and a way back out of both:

1. **A `Uint8Array` of wasm module bytes**, magic and version and up to five length-prefixed
   sections, written by 309 lines of TypeScript with no assembler and no library
   ([Ch 52 § no-toolchain](52-emitting-webassembly-by-hand.md)). `report` from the running
   example is 419 bytes across one block.
2. **A calling convention nobody declared.** Every heap value the compiled function touches is
   *copied* into linear memory before the call and copied back after it, and the compiler's
   representation table is the only thing that says which of eight untyped bytes is a number
   and which is a pointer ([Ch 53 § every-slot-is-an-f64](53-the-boundary-is-the-wall.md)).
3. **A way back.** A snapshot region at the bottom of linear memory, an `env.deopt` import, and
   a materializer that can rebuild an interpreter frame the optimizer deleted
   ([Ch 54 § the-snapshot](54-deoptimizing-out-of-wasm-and-when-the.md)).

## The structural hinge

Part VIII and Part IX are the **same graph taking two roads**, and the whole of both parts
follows from one difference that is not a mode, not a compiler flag and not a fork in the
control flow of the optimizer. It is the absence of one string from one `Set`.

`wasmTarget` declares four capabilities — `deopt`, `osr`, `tagged-values`, `float-text`
(`src/optimizing/backends/wasm/target.ts:5-11`). `cTarget` declares seven, and the two sets
overlap in exactly one: `float-text` ([Ch 51 § capabilities-decide-which-passes-exist]).
`deopt` is on one side and not the other, and everything else is a consequence.

**The JIT may guess, because a failed guess deoptimizes into the interpreter.** A speculative
type here is a *licence*, held on the strength of a guard that is still executing
([Ch 49](../part-07-optimization/49-speculative-types-are-not-facts.md)). The licence is real
and it is paid for in this part: twelve lines of emitted wasm per guard, a snapshot region
sized to the largest frame state in the function, a second copy of every entry check written
in JavaScript, a dependency registry, and a materializer that knows how to re-execute
arithmetic ([Ch 54 § what-leaves]).

**The native compiler may not, because there is nothing underneath it.** On that road
`speculationLowering` deletes seven of the eight guard opcodes,
`frame-state-elision` nulls every frame state, and `capabilityCheck` refuses any node that
would still have needed one ([Ch 51 § frame-state-elision], [Ch 51 § the-final-check]). Every
guard has to become either a proof or a refusal, and Part IX is the nine chapters of paying
for that.

The two roads do not diverge in *meaning*. Both answer the same thing for `12.5 % 4.0`. They
diverge in *cost*, and in one place this part measures exactly: the native road lowers a
fractional `%` into a call to a tera function the compiler wrote and appended to the program,
while the JIT road — where the prelude is the empty string
([Ch 51 § lowering-to-tera-not-to-c]) — leaves the node generic and asks the interpreter at run
time ([Ch 53 § runtime-stubs]).

## What this stage owes everything downstream

- **One pipeline function, two callers.** `targetLegalizationPipeline(target, options)`
  (`src/optimizing/target/legalization.ts`) returns one array of `TransformPass<CFGFunction>`,
  run by the same `PassManager` the middle end used, with ordinals restarting at `#0`
  ([Ch 51 § the-second-pipeline]). **Forty passes for `wasmTarget`, forty-one for a target
  without tagged values** — three passes exist only for an untagged target and two only for a
  tagged one, spliced in and out at one `?:` each. Every ordering fact this part establishes is
  inherited unchanged by Part IX, because it is the same array.
- **A capability is consulted three different ways.** It splices passes into and out of the
  array; it turns one pass into a no-op or a scythe (`deopt`, read exactly once in a pass body,
  by `elideFrameStates`); and it is asked **per value**, not per target —
  `select-integer` and `select-float` are questions about a target *and* the scalar kind of one
  particular merged value, which is why x64 if-converts a diamond merging an integer and leaves
  the one merging a double alone ([Ch 51 § select-twice-illegal]).
- **Refusal is a first-class outcome, and it has three kinds.** `CompileRejection`
  (`src/optimizing/target/jit.ts:8-13`) is `unsupported | speculation | malformed`, and they
  are not severities — they are three different futures for one struct, read by three different
  people ([Ch 51 § refusal-is-an-outcome], [Ch 54 § when-the-jit-says-no]). `malformed` means
  the compiler is wrong and disables optimization permanently; the other two set a cooldown.
  Part IX turns the identical `BackendLoweringError` into a sentence on a user's terminal
  ([Ch 56 § warning-note-and-error](../part-09-ahead-of-time/56-legality-and-the-art-of-refusing-well.md)).
- **Refusals are total, cheap, and up front.** `WasmCodegen.compileRejection` walks every block
  and every node once and answers before a single byte is written
  ([Ch 52 § what-is-refused]). That is what makes it defensible for this backend to have a
  *domain* rather than a relooper: a refused function is not a failed compilation, it is a
  function that keeps running in the tier below while the twenty next to it get faster.
- **The boundary cost model.** Per activation, object code pays a recursive graph walk in, a
  walk back restricted to slots whose kind cannot change, one call across the boundary for
  every operation the backend could not compile — and, if any single one of those can re-enter
  the interpreter, one more call for **every** heap access in the function
  ([Ch 53 § staleheapaccess]). Numeric code pays none of it. Everything Part XIII says about
  tier agreement rests on the copy-in/copy-back rule established here.
- **`nodeValueRep` is the only type information in the system, and it is never written down.**
  Linear memory has no tags. A slot holding `15.7` and a slot holding a string are both eight
  bytes of double, and the first object copied into a bare function lands at address `8`, which
  as a double is indistinguishable from the integer eight. Getting the table wrong is a wrong
  answer with no diagnostic ([Ch 53 § a-second-interpreter]).

## Which of the four machines this constrains

| Ch | Title | Badge | Why |
| --- | --- | --- | --- |
| 51 | [Legalizing for a target](51-legalizing-for-a-target.md) | ⟨· · J · N⟩ | one pipeline function, both compiling roads, forty passes against forty-one |
| 52 | [Emitting WebAssembly by hand](52-emitting-webassembly-by-hand.md) | ⟨· · J⟩ | the encoder exists once and only wasm uses it |
| 53 | [The boundary is the wall](53-the-boundary-is-the-wall.md) | ⟨I · · J⟩ | `executeRuntimeStub` is a **second interpreter**, over IR nodes |
| 54 | [Deoptimizing out of wasm](54-deoptimizing-out-of-wasm-and-when-the.md) | ⟨I · · J⟩ | `interpreter.resumeAt` receives a `RegisterFrame` rebuilt from linear memory |

**The baseline compiler ⟨B⟩ is not constrained by this part at all.** It emits JavaScript from
bytecode and never sees a `CFGFunction` ([Ch 36 § why-emit-source]). It appears here only as
the tier a JIT refusal falls back to. The interpreter ⟨I⟩ appears twice, and both times as a
*destination*: chapter 53's runtime stubs re-enter it to perform one IR node, and chapter 54's
bailout hands it a frame to resume. The native compiler ⟨N⟩ appears in chapter 51 only, and
appears there *differently* — it gets three passes the JIT never runs and loses two the JIT
always runs.

## The chapters

**51 is the shared chapter, and it belongs to both parts.** Forty-one entries, most of which are
not trying to make anything better: they are making the program *expressible*. `GenericGetProp`
is a perfectly good IR node and no target has an instruction for it. The first two-thirds of the
array is one idea repeated nineteen times ([Ch 51 § surface-lowering-tour]), and its shared
acceptance test is never "did it get faster" but "is there anything left a backend would have to
refuse". Two entries run to a fixpoint rather than once, and the chapter states exactly what
makes a fixpoint over *rewrites* terminate when nothing bounds the graph
([Ch 51 § untilstable]). Ordinal `#13` is where the roads physically part: a three-entry map on
`target.speculation.kind`, in which wasm's answer is literally `() => 0`
([Ch 51 § speculation-lowering-three-strategies]). The chapter's thesis is arithmetic — the
middle end took `Series.mean` from twenty-six nodes to twenty, and legalization puts sixteen
back — and its honesty is that a dozen real ordering dependencies are recorded by five test
titles and nothing else ([Ch 51 § order-as-executable-claim]).

**52 is the encoder, and its subject is an absence.** WebAssembly has no `goto`: it has
`block`, `loop`, `if` and `br <depth>`, where the depth counts *outward* and a branch can leave
a scope but never enter one ([Ch 52 § no-goto]). So the last thing the emitter does is rebuild
the graph's arbitrary edges as a nesting of scopes — reverse postorder to decide what is emitted
when, a label stack to convert a target block into a branch depth, and a post-dominator tree to
find where two arms of a branch rejoin ([Ch 52 § order-and-labels],
[Ch 52 § finding-the-merge]). There is a second absence beside it: the module has **no Data
section and no Memory section**, so it cannot write a single byte into its own memory before it
runs, which is why every string, object and closure the code needs arrives as an integer the
JavaScript side filled in ([Ch 52 § constants-arrive-as-pointers]). The chapter closes on one
function, `toInteger`, which pays thirty instructions rather than use the one-instruction
conversion the format provides, because that instruction *traps* and a trap has no frame state
([Ch 52 § tointeger]). The rule it leaves is the part's rule: **a wrong-but-total answer is a
silent miscompile; a slow-but-total answer is a design.**

**53 is the cost model, and it is the chapter that explains the JIT's performance.** tera's
heap is made of JavaScript objects; wasm linear memory is one `ArrayBuffer`. There is no pointer
from the second into the first, so everything crosses by copy — with an identity map so a graph
is walked as a graph rather than as a tree, a per-pass cycle set, and a depth guard at 512 that
turns a would-be stack overflow into a *defined* bailout ([Ch 53 § allocatetagged]). The
copy-back is allowed to update a value and never to change its kind, which is one `switch` with
no `else` in it and the most load-bearing absence in the file ([Ch 53 § copy-back]).
`RUNTIME_STUB_NODES` has forty-two members, and **the length is the argument**: every generic
arithmetic, comparison, property and index operation is there, all four call opcodes are there,
and so is `IR_UNBOX` ([Ch 53 § the-list-is-the-lesson]). *The JIT compiles numbers.* And eleven
lines decide the rest: if **any** node **anywhere** in a function can re-enter the interpreter,
**every** heap access in that function becomes a stub call ([Ch 53 § staleheapaccess]) — a
deliberate choice, with a program in the tree that answers wrong without it.

**54 is what buys the licence.** Its difficulty is specific: a JavaScript host has no API to
read a wasm local, so everything a bailout will need must be pushed into linear memory by the
wasm code itself before it calls out ([Ch 54 § the-problem]). That produces a snapshot format
whose slot numbers are a **running counter, not a name** — decodable only because the writer and
the reader call one shared function ([Ch 54 § the-snapshot]) — and the reader's sharpest
decision, four lines with no assignment in them: a value whose representation says pointer and
whose address this activation cannot resolve is recorded as **nothing**, because a deopt that
invents a value is worse than one that gives up ([Ch 54 § reading-it-back]). The catch block is
an ordered list where the order is the correctness argument, and committing before resuming is
the condition, not the optimization ([Ch 54 § catching-it]). The chapter ends on three tiering
declines that were built on chapter 53's arithmetic, shipped, and then *deleted* when the
arithmetic changed underneath them ([Ch 54 § declines-that-were-reverted]) — and on the
statement of what the JIT's contract actually is: not "fast", but **"indistinguishable"**.

## What this part deliberately is not

- **Not a relooper.** There is no algorithm that structures any reducible graph by duplicating
  blocks. There is a merge resolver that answers `null`, a label lookup that answers `-1`, and a
  `failEmit` that throws the function away ([Ch 52 § what-is-refused]).
- **Not a register allocator.** WebAssembly lets a function declare as many locals as it likes
  and solves the register problem itself, so `analyzeGraph` is *naming*, not allocating — no
  spilling, no live ranges, no interference graph ([Ch 52 § locals]).
- **Not the only reader of the pipeline in chapter 51.** Two of its passes,
  `legalizeOperations` and `ifConversion`, cannot do anything at all on the JIT road, and one
  builtin — `Math.sign` — is permanently untierable because of it
  ([Ch 51 § neither-fires-on-wasm]).

## Where the running example cannot reach

`docs/example/stats.tera` reaches the shallow end of this part and no further, and the chapters
say so in their openers rather than contriving a ninth spine file
([Conventions § 2](../CONVENTIONS.md)).

- **`Series.mean` never reaches wasm.** It is `this.values.length` and `this.values[i]`, and
  `holdsTheReceiver` refuses a property access through the constant `this` — twice over, on its
  first two nodes. `Series.label` goes with it. The only function of the running example that
  compiles is `report`, at **419 bytes, one block and two runtime stubs**, and one block is the
  encoder's *fast path*, which skips every scope, label, merge resolver and phi update in
  chapter 52.
- **The loop chapter therefore borrows.** [Ch 52] rebuilds `total_of` from
  `docs/example/stats-deopt.tera` — the same counted loop in free-function form, called two
  hundred times, and therefore actually compiled: **1,159 bytes, four blocks, six stubs.**
- **A deopt needs the same file.** `stats.tera` never tiers up at default thresholds and never
  has a frame state that is *used*. All of [Ch 54]'s worked material is `stats-deopt.tera`.
- **A nine-operand stub call** needs a call that wide, and the spine has none, so
  [Ch 53 § the-eight-operand-limit] uses an inline `-e` program — which is how the wrong answer
  it documents was found.
- **If-conversion and `IR_SELECT`** cannot be shown on wasm at all, because
  `wasmTarget` selects neither integers nor floats; [Ch 51 § select-twice-illegal] shows the
  mechanism on the native targets and [Ch 51 § neither-fires-on-wasm] says plainly that none of
  it fires here.

## Verify it yourself

```bash
# report compiles at 419 bytes and one block; mean and label are refused on the receiver
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera 2>&1 \
  | grep -i "wasm\|stub\|CFG built"

# the loop chapter's listing: 1159 bytes, 4 blocks, 6 runtime stubs
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats-deopt.tera 2>&1 \
  | grep -i "wasm\|stub\|CFG built"

# stub count as a cost proxy: a closure, a map and a float format cost 28
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats-closure.tera 2>&1 \
  | grep -i "wasm\|stub"

# registration, a real in-wasm bailout, and the interpreter finishing the loop
node dist/cli.js --trace-deopt docs/example/stats-deopt.tera

# Math.sign reaches the backend as an IR_SELECT wasm has no case for
printf 'fn s(x):\n  return Math.sign(x) + 1\n\nfn driver(n):\n  t = 0\n  k = 0\n  while k < n:\n    t = s(k - 5)\n    k += 1\n  return t\n\nprint(driver(50))\n' > /tmp/sign.tera
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 /tmp/sign.tera 2>&1 | grep -i Select

# which targets exist, and which one writes its own bytes
node dist/cli.js targets

# the tagged/untagged splice and the pipeline's five ordering constraints, as assertions
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts
```

The first command prints `419 bytes, 1 blocks` and `Runtime stubs lowered: 2` for `report`, and
`graph not compilable: property access on this receiver` for both `label` and `mean`. The second
prints `1159 bytes, 4 blocks` and `Runtime stubs lowered: 6`. The `Math.sign` probe prints
`block 0 instruction 16 Select is not supported by wasm backend`. `pipeline-order.test.ts`
reports eleven passing tests.

Note that `--print-after-all` and `--verify` are **compile-only** flags: there is no way to dump
this pipeline's per-pass output on the JIT road, which is why [Ch 51]'s pass-by-pass evidence is
taken from a `tera compile` run against the C target and its wasm-only claims are pinned by unit
tests instead.

## What Part IX receives

Nothing from this part. That is the point of the hinge, and it is worth stating plainly:
**Part IX does not consume Part VIII's output — it consumes Part VII's, and runs chapter 51's
pipeline over it against a different `TargetModel`.**

What Part IX inherits is chapter 51 itself, read a second time with four capability answers
instead of four: `targetLegalizationPipeline` against `cTarget`, `x64Target` or
`riscv64Target`, where `speculationLowering` selects `prove-or-generic` instead of `() => 0`,
`elideFrameStates` nulls two hundred and six frame states rather than returning on its first
line, three passes appear that wasm never runs, `representation-selection` and
`representation-check` do not exist, and `capabilityCheck` at `#40` is a real gate rather than a
formality ([Ch 55 § a-target-describes-itself](../part-09-ahead-of-time/55-the-same-graph-with-no-way-out.md)).

Everything chapter 54 built then has nowhere to go. `env.deopt` does not exist, because there is
no host to import it from. The snapshot region does not exist, because there is no linear memory
and no frame state left to write into it. `executeRuntimeStub` does not exist, because there is
no interpreter in the process to re-enter. And so the six refusals this part ends on — all of
the form *when the fast path cannot be justified, stop being fast rather than stop being right*
— become, on the other road, a single question asked of every value in every function: **prove
it, or refuse the function and say why in a sentence a programmer can act on.** That is
[Ch 56 § refusing-well](../part-09-ahead-of-time/56-legality-and-the-art-of-refusing-well.md),
and it is what Part IX is for.
