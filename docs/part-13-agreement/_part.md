# Part XIII — Agreement, refusal, and honest state

> **Status:** outline

**Tier badge convention in this part.** Every chapter heading carries `⟨I · B · J · N⟩`;
a dash replaces a tier the chapter does not constrain. Part XIII is the only part where
three of the four chapters carry the full badge with no dash. That is the point of the
part: the subject is not any one machine, it is the relation between all four.

## What arrived

Everything. This is the only part with no single incoming artifact, because every earlier
part hands it one:

- a `RegisterCompiledFunction` with a feedback vector and a `disableOptimization` flag
  [Ch 21 § dispatch-loop, Ch 33];
- generated JavaScript with the same accumulator protocol [Ch 36];
- a `WebAssembly.Instance` with a `runtimeStub` import, a `deopt` import, a
  `FrameStateBuilder`, and a `Dependency[]` registered against
  `src/deopt/dependencies.ts` [Ch 52, Ch 54];
- an `ELF64`/`PE32+` file that can neither deoptimize nor ask a question at run time
  [Ch 70];
- and, from Part XII, the instruments that make all four observable: `--print-bytecode`,
  `--print-ir`, `--trace-deopt`, `--verify`, `--opt-bisect`, and the `differential`
  helper in `tests/helpers/tiers.ts` [Ch 77, Ch 78, Ch 79].

## What this stage owes everything downstream

Downstream is *the reader of the program's output*, and the debt is one sentence:
**four machines, one answer.** Everything in this part is an obligation that follows from
it.

- **The answer must be identical, not merely similar.** `differential` in
  `tests/helpers/tiers.ts` compares `runNative` results with `toEqual` across `oracle`,
  `baseline`, `jit` and `osr`; `peAgrees` in `tests/helpers/aot-agreement.ts` compares the
  native binary's *stdout bytes* against the interpreter's. Nothing in the tree compares
  anything looser than that.
- **A machine that cannot answer must say so, in a sentence a person can act on.** Not a
  crash, not a wrong number, not silence. Refusal is a first-class result, and its
  wording is the specification of the limit [Ch 81].
- **Every bet must be revocable, and every revocation must land.** A frame state
  [Ch 40] is how a bet is taken back; a `Dependency` [Ch 34, Ch 39, Ch 54] is how the
  runtime promises to say when a bet stops paying. Neither is optional in a tier that
  speculates, and both are absent in the tier that cannot.
- **The record of what is not finished must be a list, not a mood.** A compiler that
  claims to be done is a compiler nobody can plan around [Ch 82].

## The chapters

| Chapter | What it settles | Tiers | Pages |
| --- | --- | --- | --- |
| 80. The Agreement Contract | Seven mechanisms taught separately, argued as one design | `⟨I · B · J · N⟩` | 12 |
| 81. Refusal as a First-Class Answer | The catalogue of declines, and why they license aggression elsewhere | `⟨I · – · J · N⟩` | 12 |
| 82. The inventory: dead, broken, unfinished, measured worse, never runs | The tree's real state, in five kinds of entry | `⟨I · B · J · N⟩` | 14 |
| 83. Epilogue: the same program, four ways | One answer, four cost structures | `⟨I · B · J · N⟩` | 8 |

## The spine through this part

`docs/example/stats.tera` is run four ways and its answer compared, which is the whole of
[Ch 83]. Three variations do the arguing:

- `docs/example/stats-deopt.tera` — the only file in the example set that makes a
  registered dependency visible *and* then breaks it, in two lines of `--trace-deopt`
  output. It is [Ch 80]'s spine.
- `docs/example/stats-refused.tera` — a refusal that cascades: one function declines, then
  its caller, then the entry. It is [Ch 81]'s spine.
- `docs/example/labeled.tera` — the bug, told as engineering. It compiled to `Jump r0` and
  printed `1 2` forever; it now prints `1 2 3 5 6 7` and stops, because a label is handed to
  the loop that owns the latch instead of being resolved where it is written. It is
  [Ch 82]'s spine, and the reason [Ch 78]'s missing bytecode verifier is an inventory item
  rather than a nice-to-have: one pass over `func.instructions` would have caught it.

## What leaves

Nothing. This is the end of the pipeline and the end of the book. What leaves the reader
with is three things: the sentence that makes four machines one engine, the list of
sentences with which each of them says no, and the honest list of what is not built.

## What this part cannot reach

`stats.tera` never deoptimizes, never megamorphises, never allocates enough to collect,
and never touches the arena, the write barrier or the event loop. Every claim in this part
about *those* mechanisms is made from a variation file, a probe written in the chapter, or
a named test — and each chapter says which.

There is also no benchmark harness in this tree. [Ch 83] is a table of *artifacts and
counts*, not of speeds: the engine's own `--stats` reports `totalCompileTimeMs: 0` and
`totalExecTimeMs: 0` for `stats.tera`, because the program is too small to register on its
timers. The chapter says so rather than inventing numbers.
