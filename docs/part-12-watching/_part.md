# Part XII — Watching the program

> **Status:** outline

**Tiers this part constrains.** ⟨**I** · **B** · **J** · **N**⟩ — all four. This is the
only part of the book that touches every machine at once, because its subject is not a
stage of the pipeline but the *instruments* pointed at all of them: the CLI that
configures the engine, the REPL and debugger that drive tier zero, the visualizer that
records the shared middle end for both the JIT and the native compiler, the bisect counter
that lives inside the pass manager, and the verifiers and test harness that decide whether
any of it is true.

## What this stage owes everything downstream

Every chapter before this one made a claim about a representation: this is what the tokens
look like, this is what the graph looks like after `licm`, these are the bytes the encoder
wrote. Those claims are only worth reading because they can be *reproduced*, and every one
of them was reproduced by something in this part.

That gives this part an unusual debt. It owes the rest of the book four things:

- **A way to see each representation.** `--print-ast`, `--print-bytecode`, `--print-ir`,
  `--print-module-graph`, `--print-after-all` and `--trace` are how every listing in
  chapters 4 through 72 was produced. They are not a debugging convenience bolted on
  afterwards; they are the book's evidence.
- **A way to change the engine's mind.** `--no-opt`, `--always-opt`, `--opt-threshold`,
  `--baseline-threshold`, `--max-deopt`, `--no-osr` and `--allow-natives-syntax` are what
  make a tier-transition reproducible on demand rather than a matter of waiting for a
  counter to trip.
- **A way to localize a wrong answer.** `OptBisect` reduces "one of thirty-odd passes
  broke this" to "this named pass, on this named function", in a logarithmic number of
  compiles.
- **A way to state an invariant executably.** In a codebase with a hard no-comment rule, a
  verifier and a test title are the only places an invariant can be written down where it
  cannot go stale silently.

## What this part hands to Part XIII

The argument Part XIII opens with. Chapter 79 establishes that the engine's correctness
case is *differential* — the same program run every way must answer the same thing — and
also establishes the exact shape of the hole in that argument: a harness can pass
vacuously, a tier can be excluded, and a whole class of miscompile lives below the level
the cheap test tiers can see. Chapter 80's agreement contract is the answer to that, and it
only reads as an answer if the reader has already met the apparatus and its limits here.

## Chapters

| # | Chapter | Tiers | Pages |
| --- | --- | --- | --- |
| 73 | [The shell: a CLI as instrument](73-the-shell-a-cli-as-instrument.md) | ⟨**I** · **B** · **J** · **N**⟩ | 12 |
| 74 | [The REPL](74-the-repl.md) | ⟨**I** · B · J · N⟩ | 12 |
| 75 | [The debugger](75-the-debugger.md) | ⟨**I** · B · J · N⟩ | 14 |
| 76 | [The visualizer: replaying every pass](76-the-visualizer-replaying-every-pass.md) | ⟨**I** · B · **J** · **N**⟩ | 14 |
| 77 | [Bisecting Your Own Compiler](77-bisecting-your-own-compiler.md) | ⟨I · B · **J** · **N**⟩ | 10 |
| 78 | [Verifiers Everywhere](78-verifiers-everywhere.md) | ⟨**I** · **B** · **J** · **N**⟩ | 12 |
| 79 | [How we know any of this is true](79-how-we-know-any-of-this-is.md) | ⟨**I** · **B** · **J** · **N**⟩ | 16 |

## Reading the tier badge

`⟨I · B · J · N⟩` names the four machines in order — interpreter, baseline, JIT, native.
A **bold** letter marks a tier the chapter or section actually constrains.

Two badges in this part need a note.

- Chapters 74 and 75 bold only the interpreter. Both tools *can* be given engine flags that
  turn the higher tiers on — `buildEngineOptions` is shared by `run`, `repl` and `debug`
  alike — but a debug session sets `DebugController.forceInterpreter` by default, which
  pins execution to tier zero. That is the honest limit, and chapter 75 says what it costs.
- Chapter 76 leaves the baseline compiler unbold. The visualizer records frontend stages,
  bytecode, middle-end and lowering passes, machine functions and AOT module stages. There
  is no baseline stage, because the baseline compiler emits JavaScript directly from
  bytecode and has no intermediate representation to record.

## What the running example cannot reach here

`docs/example/stats.tera` drives almost all of this part: it is what every CLI listing in
chapter 73 is taken from, it compiles clean under `--verify`, and it is the program the
debugger walks in chapter 75. Three things it cannot reach, each handled by a named
variation or a different file:

- **A deoptimization.** `stats.tera` never tiers up far enough to bail out. Chapter 73's
  `--trace` section uses `docs/example/stats-deopt.tera`, which produces the two
  `[DEOPT]` lines quoted there and in [Ch 76 § deopt-back-linking].
- **A refusal.** `stats.tera` compiles for every registered AOT target. Chapter 73's
  discussion of exit statuses uses `docs/example/stats-refused.tera`.
- **A `differential` comparison.** Chapter 79's harness *refuses* `stats.tera` outright,
  because the file ends in `print` and the harness compares what a program answers rather
  than what it printed. That refusal is not an inconvenience to work around — it is the
  chapter's central point, and it is reproduced there.

`docs/example/labeled.tera` appears in this part only by name, and it is safe to run: the
labeled `continue` that once re-entered the inner loop forever now leaves it, because a
labelled statement registers its label as pending and the loop that owns the latch claims
it (`enterLoop`, `src/bytecode/register/compiler/helpers.ts:131-145`). The example test
runs it like every other file in `docs/example/` — `"labeled.tera resumes the outer loop
instead of restarting the program"`.

## Cross-references

- The pass manager whose bisect gate chapter 77 reads: [Ch 41 § the-pass-manager].
- The frame states chapter 78's validator checks and chapter 75's snapshotter reads:
  [Ch 40 § frame-states].
- The tiering policy every flag in chapter 73 perturbs: [Ch 35 § when-to-tier-up].
- The refusal vocabulary chapter 73 surfaces as an exit status: [Ch 56 § what-aot-declines]
  and [Ch 81 § refusal-as-an-answer].
- The miscompile chapter 79 closes on, and the tier that caught it:
  [Ch 65 § scheduling-regions].
- The honesty items raised here are copied into
  [Appendix D § inventory](../appendix/d-inventory.md).
