# Part VI — Bytecode becomes SSA   ⟨· · J · N⟩

> **Status:** written

**What arrived.** A `RegisterCompiledFunction` from Part III, and — for the JIT road only —
the `feedbackVector` Part V filled. Register bytecode is a *machine*: `r3` is a box, a box
holds three different values at three points in a function, and "which definition does this
read see?" has no answer without walking the program. Part VI is the three chapters in which
that question is answered once, into the data structure, so that nothing downstream ever asks
it again.

**What leaves.** One artifact, shared by exactly two of the four machines: a `CFGFunction`
holding `CFGBlock`s of `CFGInstruction`s in canonical phi SSA, a frozen table describing what
each of the ninety-eight opcodes does, and a `FrameState` hanging off every node that can give
up.

## What this stage owes everything downstream

- **A definition per value.** After this part, `v13 = GenericAdd v3, v12` names its operands
  by object identity, not by register slot. Reaching definitions are never recomputed by any
  pass in Parts VII through X.
- **A schedule.** Values are pinned to a block and to an index in that block's node list, and
  that index *is* the schedule. There is no scheduler in the middle end; every pass is
  responsible for keeping program order legal. The one scheduler in the tree,
  `src/optimizing/machine/schedule.ts`, runs on MachineIR long afterwards
  ([Ch 65 § why-schedule-at-all]).
- **One structural authority.** `OPERATIONS` (`src/optimizing/ir/operations.ts`) answers
  effects, terminator-ness, pinning, arity, result class, operand class, memory-access kind,
  opaque memory, speculation role, pointer identity, removability and type transfer for all
  ninety-eight opcodes, and twenty files in `src/` read it rather than switching on an opcode
  themselves ([Ch 38 § the-operation-table]). Five entries compute their effects from the
  node rather than from the table, and the accessors answer conservatively for those instead
  of making each caller decide ([Ch 38 § effects-that-depend-on-the-node]).
- **A way back.** A frame state on each deoptimizing node describes the interpreter frame the
  compiled code no longer has, so speculation is reversible. Part V bought the speculation;
  this part pays for the undo.
- **A text form.** `printIR` and `parseIR` round-trip byte for byte on a single function,
  which is what lets every pass fixture from Part VII onward be text in, text out rather than
  a hand-built graph ([Ch 38 § the-fixture-workflow]).

## The chapters

| # | Title | Badge | What it lands |
| --- | --- | --- | --- |
| 38 | [A control-flow graph, not a sea of nodes](38-a-control-flow-graph-not-a-sea.md) | ⟨· · J · N⟩ | the data structure, the frozen operation table, and the text form |
| 39 | [Building SSA from bytecode](39-building-ssa-from-bytecode.md) | ⟨· · J · N⟩ | the single forward walk that produces it, and the loop-header problem |
| 40 | [Frame states: describing a frame you no longer have](40-frame-states-describing-a-frame-you-no.md) | ⟨I · · J · N⟩ | the second use graph, and the rule it forces on every later pass |

**38** establishes the vocabulary — block, instruction, phi, use, effect — that Parts VII
through X spend their whole length manipulating. Its load-bearing sections are
[Ch 38 § canonical-phi-ssa] (a phi's input list is positionally parallel to its block's predecessor
list, and that parallelism is the *sole* source of truth about which value arrives on which
edge), [Ch 38 § the-def-use-multiset] (one `uses` entry per input edge, so `add(v, v)` records `v`
twice), and [Ch 38 § why-the-obvious-design-fails], which states the trade against a sea of nodes.

**39** is one walk over `mean`'s forty-three bytecodes with no dominator computation
([Ch 39 § one-walk-no-dominators]), and the one genuinely hard problem inside it: a loop header must
place its phis *before* the values on the back edge exist ([Ch 39 § the-problem-a-loop-header-has],
[Ch 39 § closing-the-back-edge]). It is also where Part V's vector is spent — a monomorphic property
hint becomes `CheckMap` + `LoadField` with a generic fallback beside it and a runtime
dependency registered ([Ch 39 § feedback-becomes-speculation]) — and where the two roads first
diverge: on the native tier only, every recoverable call is followed by a pending-throw test,
so exceptions become ordinary branches ([Ch 39 § exceptions-with-no-exception-edges]).

**40 is this part's load-bearing chapter**, and the one the rest of the book leans on hardest.
Its subject is a single consequence: because a frame state's slots hold pointers to nodes in
the SSA graph, the graph has a *second, invisible* use relation, and `node.uses.length === 0`
is not a test for death ([Ch 40 § the-second-use-graph]). Every pass in Parts VII through X runs
under that rule; `src/optimizing/ir/editor.ts` exists as a class rather than three free
functions because of it; and [Ch 40 § the-bug-that-taught-it] and
[Ch 40 § the-second-bug-behind-the-first] are the two defects that established it. The chapter also
measures which validator runs where ([Ch 40 § what-checks-this-and-what-does-not]) and finds the
gap: the per-pass verifier `--verify` installs is `validateGraphInvariants`, which does not
look at frame states at all.

## Which of the four machines this constrains

- **Interpreter ⟨I⟩** — untouched by the IR itself. It appears in chapter 40 only as the
  *destination*: a frame state describes an interpreter frame, and deoptimization rebuilds
  one. That is why 40 carries an `I` in its badge and 38 and 39 do not.
- **Baseline ⟨B⟩** — untouched entirely. `src/optimizing/baseline/compiler.ts` imports nothing
  from `src/optimizing/ir/`; it goes from bytecode straight to JavaScript source
  ([Ch 36 § why-emit-source]). This is the only part of the book the baseline compiler skips
  completely.
- **JIT ⟨J⟩** — builds this IR through `buildIR`, keeps every frame state, and validates the
  result twice: once at the end of `optimizer.ts`'s `build()`, and again at the top of the
  wasm backend's `compile`, where a failure becomes a compile *rejection* rather than an
  exception.
- **Native ⟨N⟩** — builds the *same* IR through the *same* `buildIR`, reaches the *same*
  `build()` and the *same* validation with frame states intact, and only then, during backend
  legalization, runs `frame-state-elision` and sets every frame state to `null` — because no
  native target declares the `deopt` capability. On that road, and only after that pass, the
  second use graph is empty and the two liveness predicates collapse into the naive one. That
  is not a licence to write the naive one: the passes are shared, and a pass written for the
  native road runs on the JIT road too.

## What this part deliberately is not

- **Not a sea of nodes.** There are no floating values with effect-chain edges and no
  scheduling phase. [Ch 38 § why-the-obvious-design-fails] states what that buys and what it
  costs.
- **Not an optimizer.** Not one value is folded here. Part VII does that, and [Ch 41] is the
  pass manager that runs it.
- **Not typed.** `CFGInstruction.props` is an untyped bag ([Ch 38 § the-props-bag]); the
  lattice types live in the operation table's transfer functions
  ([Ch 38 § transfer-functions]) and are computed on demand by an analysis in Part VII.

## Where the running example cannot reach

`Series.mean` is the listing for all three chapters — forty-three bytecodes, one loop, two
phis at the header — and it is enough for everything 38 and 39 describe. It is not enough for
40: `stats.tera` never tiers up, so it never has a frame state that is *used*. Chapter 40
works from `docs/example/stats-deopt.tera`, the variation whose whole purpose is to invalidate
a guard after two hundred and one calls, and says so in its opener.

## Verify it yourself

```bash
# mean's graph: B3 is the loop header, v3 and v4 are its two phis, and every
# node that can give up carries !fs. Both thresholds are needed - stats.tera
# never gets hot on its own, so plain --print-ir prints nothing at all.
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter mean docs/example/stats.tera

# the bytecode it was built from: registers, and no definitions
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# every pass's output on the native road, starting with the builder's own graph
# printed as pass #-1
node dist/cli.js compile docs/example/stats.tera -o stats.exe --print-after-all | head -20

# a frame state actually used, end to end
node dist/cli.js --trace-deopt docs/example/stats-deopt.tera

npx vitest run --project unit tests/optimizing/ir tests/optimizing/builder \
  tests/optimizing/validation/graph-validator.test.ts
```

## What Part VII receives

Whichever of the two graphs it was handed — frame states intact on both roads at this point —
plus the operation table and the text form. The first thing Part VII needs is a way to run
thirty-odd passes over a mutable graph while tracking which analyses each one invalidated,
which is [Ch 41]'s subject; the frame-state index [Ch 40 § the-index-and-what-it-costs]
describes is one of the two things that pass manager's `maintain` hook rebuilds.
