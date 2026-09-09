# Part V — The program gets hot   ⟨I · B · J⟩

> **Status:** written

**What arrived.** From Parts III and IV: a `RegisterCompiledFunction` per function, and a
running interpreter that has already produced the answer. Two of that object's fields have
been carried this far unused — `feedbackSlotCount`, a number the bytecode compiler wrote and
nothing has read, and the tiering block (`invocationCount`, `baselineCode`, `optimizedCode`,
`osrCache`, `deoptCount`, `callMode`, `version`, `codeAge`) that Part III handed over empty.
Part V is where all of them acquire meaning.

**What leaves.** The same object, with four fields filled and one decision cached:

1. **`feedbackVector`** — one `FeedbackSlot` per allocated index, each carrying an `icState`
   from a four-point order that only ever moves up, the maps and versions and offsets and
   proto depths the site observed, tag-shape counts, call targets keyed by object identity,
   elements kinds, branch counts, an `isStable` flag, and a `loopBudget` of `3000 ×` the
   instruction count.
2. **`baselineCode`** — a JavaScript function with `_isBaseline` set and three reachable fast
   entry points, closed over one `BaselineRuntime`.
3. **`osrCache`** — `Map<number, OsrEntry | null>` keyed by bytecode offset, where `null`
   means *asked once, refused, never ask again*.
4. **`callMode`** — the cached dispatch decision, and the most over-claimed field in the
   engine: [Ch 35 § callmode] measures what it actually decides.

## What this stage owes everything downstream

- **Every speculation the optimizing compiler makes in Parts VI–VIII is paid for here.** The
  JIT never observes a running program. It reads a `FeedbackVector` that the interpreter and
  the baseline compiler filled in, and it trusts it enough to emit code that is wrong if it
  lied. `FeedbackNexus` (`src/feedback/nexus/index.ts:93-258`) is the entire width of that
  contract: seven hint queries — `binaryOp`, `unaryOp`, `property`, `elements`, `call`,
  `branch`, `returnType` — plus `getSlot`. Everything the optimizer knows about the program's
  runtime behaviour arrives through those eight functions.
- **The standard of evidence is one observation.** `isStableSlot`
  (`src/feedback/nexus/index.ts:260-266`) counts a slot as stable if it is monomorphic with a
  single record; the vector's own stricter `isSettled` — stable *and* fifty records — has no
  caller in `src/`. [Ch 33 § the-nexus] measures the gap, and Part VII spends it.
- **The ahead-of-time compiler reads none of this.** It is handed the same
  `RegisterCompiledFunction` and must prove from types what the JIT is allowed to guess from
  observation. *Guess and check* versus *prove or refuse* is the book's spine, and Part V is
  the half that guesses.
- **Nothing is invalidated globally.** There is no epoch anybody must remember to bump. Every
  cached inline-cache handler re-checks map id, map version and deprecation on every hit
  ([Ch 34 § no-global-invalidation]), and the rule that comes out of it — *a cached fact must
  carry its own falsification* — is reused by the dependency registry in [Ch 54].
- **Two artifacts, two address spaces.** The feedback vector and the inline caches are filled
  by the same instructions and read by nobody in common: the optimizer reads the vector and
  never touches a cache; the program reads the caches and never touches the vector. Confusing
  them is the easiest mistake in this part, so [Ch 33] and [Ch 34] are deliberately separate
  chapters rather than one.

## Which of the four tiers this part constrains

| Ch | Badge | interpreter | baseline | JIT | native |
| --- | --- | --- | --- | --- | --- |
| **33** Feedback | ⟨I · B · J⟩ | records | records | reads | — |
| **34** Inline caches | ⟨I · B⟩ | uses | uses | reads the *vector*, not the cache | — |
| **35** Back edges & tiering | ⟨I · B · J⟩ | polls | polls | is the destination | — |
| **36** The baseline compiler | ⟨I · B · J⟩ | shares its frame | is the subject | tiers up from it | — |
| **37** On-stack replacement | ⟨I · B · J⟩ | enters from | enters from | is the destination | — |

**No chapter in Part V binds N.** A native binary has no feedback vector, no inline cache, no
back-edge poll and no tier to move to. That column is empty for five chapters running, and it
is the longest stretch of the book where the fourth machine is simply absent.

## The chapters

- [**33. Feedback: what the interpreter learns**](33-feedback-what-the-interpreter-learns.md)
  — slots are allocated at bytecode-generation time as trailing operands and printed by the
  disassembler as if they were registers ([Ch 33 § reading-the-disassembly]); a slot's *kind* is
  decided by a scan of the instruction stream, not by the recorder that writes it
  ([Ch 33 § typing-the-vector]); the state advances through a four-point lattice that only moves up
  ([Ch 33 § the-lattice]); four maps is the limit ([Ch 33 § four-is-the-limit]); and one slot the compiler
  allocates is never written at all ([Ch 33 § the-slot-that-was-never-allocated]).
- [**34. Inline caches**](34-inline-caches.md) — five caches behind one site key
  `funcName#fnId:slot` ([Ch 34 § the-five-caches-behind-one-site]), handlers that re-verify
  everything they assumed on every hit ([Ch 34 § what-each-handler-verifies]), two prototype
  handlers that pin a whole chain by object identity ([Ch 34 § the-two-prototype-handlers]), and the
  chapter's central asymmetry: proving a property is *absent* is a stronger claim than proving
  it present ([Ch 34 § absence-is-a-stronger-claim]).
- [**35. Back edges: safepoints, budgets, and the tiering policy**](35-back-edges-safepoints-budgets-and-the-tiering.md)
  — one hook doing two unrelated jobs ([Ch 35 § one-hook-two-jobs]); a loop budget that is a product
  of bytecode length rather than an iteration count ([Ch 35 § the-budget-is-not-a-counter]); two
  entirely unrelated policy objects behind one factory ([Ch 35 § the-two-policies]); and the same
  tiering rule written out three independent times, two of whose fallbacks already disagree
  ([Ch 35 § why-not-one]).
- [**36. The baseline compiler**](36-the-baseline-compiler.md) — a compiler whose output is a
  JavaScript source string ([Ch 36 § why-emit-source]), a `switch(pc)` that recovers goto in a
  language that has none ([Ch 36 § goto-in-a-language-without-goto]), a frame the interpreter would
  recognise register for register ([Ch 36 § a-frame-the-interpreter-would-recognise]), and one
  arithmetic trick — adding two tagged values without untagging them — that multiplication
  cannot borrow ([Ch 36 § tagged-arithmetic], [Ch 36 § why-multiplication-cannot]).
- [**37. On-stack replacement**](37-on-stack-replacement.md) — an invocation counter cannot
  see a program that is one call to one long loop ([Ch 37 § what-a-counter-cannot-see]), so entering
  a loop already in flight means making its header the function's entry
  ([Ch 37 § making-the-header-the-entry]). The compile-time half is the first graph rewrite in the
  book ([Ch 37 § the-transform-step-by-step]), and it is where the engine gives something up:
  resume precision ([Ch 37 § resume-precision-is-lost]).

## What the running example cannot reach here

`docs/example/stats.tera` never gets hot. `Series.mean` runs a five-element and a
four-element loop, once each; `report` and `label` are called twice apiece. Nothing crosses
`baselineThreshold` (8) or `jitThreshold` (50), and no loop comes within three orders of
magnitude of its budget. `stats.tera` is still the listing for everything that happens *while
cold* — [Ch 33] and [Ch 34] measure its nine inline-cache sites and its eleven feedback slots
from the real trace — but the three tiering chapters need a program the spine cannot supply,
so they reach for one of two things and say which in their openers:

- **Lowered thresholds on a variation.** `node dist/cli.js --always-opt --trace-opt
  docs/example/stats-poly.tera` walks `report` through all three managed tiers in one run,
  because `stats-poly.tera` calls it three times and `--always-opt` sets baseline 2, JIT 3.
- **A probe program outside the example set.** For on-stack replacement no threshold helps —
  a five-iteration loop cannot be entered mid-flight — so [Ch 37] works from a nine-line
  `hotloop.tera` that lives in its § verify-it-yourself and in
  `tests/e2e/optimizing/baseline-osr.test.ts`, which runs the same experiment from inside the
  engine. Per [Conventions § 1 and § 2](../CONVENTIONS.md) that program appears as a
  *command* rather than as a book listing beside `stats.tera`, and [Ch 37]'s opener states
  the limit: a file whose whole purpose is to be entered mid-loop has no stable printed
  output for `tests/e2e/docs/book-examples.test.ts` to pin.

## Verify it yourself

```bash
# 27 feedback records for stats.tera, 41 for stats-poly.tera. Every line says
# `Slot #0` whatever the real slot is - [Ch 33 § typing-the-vector] names why.
node dist/cli.js --trace-feedback docs/example/stats.tera | grep -c '^\[FB\]'
node dist/cli.js --trace-feedback docs/example/stats-poly.tera | grep -c '^\[FB\]'

# Nine inline-cache sites, all monomorphic; fourteen for stats-poly, one of them not.
node dist/cli.js --trace-ic docs/example/stats.tera
node dist/cli.js --trace-ic docs/example/stats-poly.tera | grep polymorphic

# All three managed tiers in one run, by lowering the thresholds rather than
# by contriving a hotter program.
node dist/cli.js --always-opt --trace-opt docs/example/stats-poly.tera

npx vitest run --project unit tests/feedback tests/runtime/tiering
npx vitest run --project e2e tests/e2e/optimizing/baseline-osr.test.ts
```

## What Part VI receives

The `feedbackVector`, and nothing else from this part. [Ch 38 § what-a-register-cannot-tell-you]
takes the `RegisterCompiledFunction` and builds the control-flow graph that every remaining
part of the book stands on; [Ch 39 § feedback-becomes-speculation] is where the vector is read
through `FeedbackNexus` and a monomorphic hint becomes a guard and a fixed-offset load. The
inline caches do not cross into Part VI at all. `baselineCode` does not either — the baseline
compiler is the one tier that never sees SSA.
