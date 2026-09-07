# 82. The inventory: dead, broken, unfinished, measured worse, never runs   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** A compiler's real state is a list, not a claim — and the list has five kinds of
entry, not one.

**What arrived.** Eighty-one chapters, each carrying its own honesty markers, plus [Ch 81]'s
rule that the first message names a symptom. This chapter is the collection.

**What leaves.** `appendix/d-inventory.md`, and a method: how to read a codebase's history
from the codebase, without trusting its notes.

**New ideas.** None. One piece of *vocabulary* is introduced and must be stated plainly
because the whole chapter turns on it: the five markers are not severities. `Dead` and
`Never runs` are cheap; `Broken` is urgent; `Measured worse` is a *success* recorded so
nobody redoes it; `Unfinished` is a plan. Confusing them is how an inventory becomes a
mood.

**Length.** 14 pages

## Anchors

- `src/bytecode/register/compiler/statements.ts:668` — `compileLabeledStatement`, after the
  fix. It patches **only** the breaks (`:681-683`), to `afterLabel` — the one target it
  owns. For the label itself it records a pending name, `this._pendingLoopLabels`, and only
  when `labelsLoop(body)` (`:675`); if the label collected continue jumps and no loop ever
  claimed the list, it throws `Label '<name>' does not name a loop` (`:684-686`). The claim
  happens in `enterLoop` (`src/bytecode/register/compiler/helpers.ts:131`), which drains
  `_pendingLoopLabels` and points `_labeledContinues[label]` at the loop's own
  `continueJumps` array (`:140-143`); `exitLoop` (`:147`) then patches labelled and
  unlabelled continues in the same loop, at the same latch (`:153-154`).
  `compileContinueStatement` (`:654`) is untouched by the fix: it still emits
  `this.func.emit(bytecode.ROP_JUMP, 0)` and pushes the index, into
  `_labeledContinues[node.label]` when there is a label and `_continueJumps` when there is
  not. Compare `compileBreakStatement` (`:551`) — the same shape, and correct from the
  start, because the construct that created its list also owned its target.
- `src/optimizing/passes/checks.ts:141` — `rangeAnalysisAndBoundsCheckElimination`, and its
  three routes to `bounded = true`: a dominating `IR_INT32_COMPARE`/`IR_FLOAT64_COMPARE`
  with `<`/`<=` on a predecessor's `IR_BRANCH` whose `trueBlock` is this block
  (`:648-671`); `detectInductionVariable` plus `findLoopGuard` (`:673-687`); and a known
  `arrayLengthNodes` range strictly above the index range (`:689-702`). Also
  `eliminateRedundantChecks` (`:71`), which does fire, and the `remarks.missed` sentences
  at `:640` and `:722` — the pass explains its own failures.
- `src/gc/gc.ts` — `PRETENURE_SIZE_THRESHOLD` (`:22`), `GCHeader.forwarding` (`:32`,
  initialised at `:139`), `checkSafepoint` (`:176`), `incrementalMarkingStep` (`:371`),
  `finishIncrementalMarking` (`:382`), `writeBarrier` (`:426`), `needsCollection`,
  `minorGC`, `_roots`, `bindRoots`.
- `src/gc/incremental-marker.ts` — the complete tri-colour SATB+Dijkstra marker:
  `COLOR_WHITE/GREY/BLACK`, `IncrementalMarker` (`startMarking`, `step(budgetMs)`,
  `writeBarrier(holder, newRef, oldRef)`, `finishMarking`, `isMarking`, `reset`,
  `worklist`, `totalMarked`, `stepsRun`, `timeBudgetMs`). 131 lines, fully tested,
  reachable only through `GenerationalGC.checkSafepoint`.
- `src/objects/heap/js-collections.ts:249` — `EphemeronHashTable`: `_probe` (open
  addressing on `id * 0x9E3779B9`, linear probing, `EPH_DELETED` tombstones), `_rehash`,
  `EPH_LOAD_FACTOR`. A hash table keyed on heap id. There is no ephemeron algorithm in it —
  no weak keys, no second marking fixpoint, no interaction with `IncrementalMarker`.
- `src/optimizing/backends/riscv64/mc/target.ts` — 27 lines. `riscv64McTarget.encode` is
  `(node) => { throw new UnsupportedInstructionError(TARGET, node.opcode); }`. Everything
  around it is real: `riscv64FixupModel`, `riscvPadding` emitting `0x00000013` (`nop`),
  `functionAlignment: 4`.
- `src/optimizing/mc/formats/elf64.ts:452` — `elf64Executable(...)` declares
  `carriesDebug: false`; `elf64Object` at `:441` declares `true`; `pe.ts:759` and `:773`
  both declare `true`. `describeLines` in `src/optimizing/machine/backend.ts:70` returns
  early when the writer says false.
- `src/optimizing/backends/x64/backend.ts:57` — `macho: null` in the object-format table,
  beside working `elf` and `coff` entries; `src/optimizing/backends/x64/format.ts:31`
  fully describes the `macho` format, and `:57` maps `"darwin"` to it.
- `src/feedback/ic/index.ts:1426` — `InlineCacheManager`, its `hiddenClassToICs` index,
  `registerHiddenClassUsage` (`:1448`), `invalidateForHiddenClass` (`:1457`),
  `invalidateDeprecatedMaps` (`:1473`). Nothing in `src/` calls
  `registerHiddenClassUsage`, so `hiddenClassToICs` is always empty and both invalidators
  always return `0`.
- `src/optimizing/backends/wasm/codegen.ts:4169-4188` — the `runtimeStub` import, whose
  signature is `(stubId, frameStateId, a0..a7)`; and `emitRuntimeStubCall` at `:2232`,
  whose `for (let i = 0; i < 8; i++)` silently drops `node.inputs[8]` and beyond.
- `src/frontend/parser/index.ts:1041` — `if (this.lazy && this.depth > 0 &&
  this.check(TokenType.Punctuator, "{"))`, the gate on the whole lazy-parse chain.
- `src/deopt/deoptimizer.ts:173` — `IC_FAILURE_REASONS`, a `Set` of six strings, referenced
  nowhere else.
- `src/optimizing/passes/intrinsic-cse.ts:70` — `meetPredecessors`, a complete
  meet-over-predecessors with `cloneState`/`intersectStates`, called by nothing.
- `src/optimizing/ir/index.ts:132` — `CFGInstruction.rep`, set from `props._rep` at `:147`,
  copied in `clone.ts:36` and `:131`, re-derived in `text.ts:387`, propagated in
  `ic-lowering.ts:134` — and read by nothing that decides anything.
- `src/optimizing/options.ts:122` — `splitLiveRanges: false`; and
  `src/optimizing/backends/wasm/codegen.ts:1061` — the `TERA_INPLACE` environment gate.
- `src/optimizing/machine/verifier.ts` and `src/optimizing/pipeline.ts:291`
  (`verifyAfterPass`) — the two verifiers that exist. There is no third:
  `grep -rn verify src/bytecode/` returns nothing.

## Worked example

`docs/example/labeled.tera`, in two commands. It terminates, so run it unbounded.

```bash
node dist/cli.js docs/example/labeled.tera
node dist/cli.js --print-bytecode docs/example/labeled.tera 2>&1 | grep -n "Jump"
```

```
1
2
3
5
6
7
```

```
49:    34  JumpIfTrue r65 r0
61:    46  JumpIfTrue r64 r1
71:    56  JumpIfFalse r58 r3
72:    57  Jump r64
78:    63  Jump r41
79:    64  Jump r29
```

Instruction 57 is `continue outer`. Instructions 63 and 64 are the inner and outer loop
back edges. 57 jumps to 64, the outer latch, which is why the program skips `0` and `4` and
then stops. It used to read `Jump r0` — a jump to the first instruction of the script — and
the program printed `1 2` forever. (The disassembler prints a jump operand in register
style, so `r64` here means offset 64, and the chapter says so once.)

The one-line diagnosis was visible from the anchors: `compileLabeledStatement` patched
`_labeledBreaks[label]` and not `_labeledContinues[label]`. The one-line patch would have
been wrong, because a labeled `continue` must jump to the labelled loop's **continue
target** — the point the loop's own `_continueJumps` are patched to — and
`compileLabeledStatement` cannot know it, because the loop compiler swaps `_continueJumps`
in and out around the body and restores it before returning. So the fix that shipped is
structural, and it moves the label rather than the target: the labelled statement declares
the label pending, the next `enterLoop` claims it and aliases `_labeledContinues[label]` to
its own `continueJumps`, and `exitLoop` patches the two lists as one. A label that no loop
claims is a compile error now instead of a jump to zero.

That is the general rule, and it is why the section below keeps its name: **a jump can only
be patched by the construct that owns its target.** A labelled statement owns the
instruction after itself and nothing else — which is exactly why `break outer` was correct
from the first day, in the same function, sharing every line of the mechanism except the
patch.

And the argument the chapter still makes: **none of this should have needed a reader.**
A bytecode verifier — the one [Ch 78] says does not exist — would have rejected an
unconditional backward jump to offset 0 out of a loop body in a single pass over
`func.instructions`, at compile time, before the file ran once. That is the point of the
whole chapter: the inventory's entries are related, and the cheapest entry to close (a
verifier) is the one that would have prevented the most expensive one (a wrong answer).

## Outline

- [ ] **§ five-kinds** — Establish the taxonomy before the list, and establish that it is
      not a severity ordering. Read `docs/CONVENTIONS.md` rule 6 aloud: each marker names a
      file and a symbol and says what finishing it would cost. Then the distinction that
      matters most: `Measured worse` is not a failure. It is a *finished, correct, tested*
      feature that lost an A/B, recorded so nobody spends a week rebuilding it.
- [ ] **§ broken-labeled-continue** — The chapter's spine, and the only entry here that is
      closed. The slug stays: it names the bug, and [Ch 19] and [Ch 83] cite it. All five
      parts rule 15 asks for. Symptom (`1 2` forever), mechanism (`Jump r0`), the one-line
      diagnosis and why the one-line patch would have been wrong, the structural fix that
      shipped (`_pendingLoopLabels` declared by the label, claimed by `enterLoop`, patched
      by `exitLoop`), the four unit tests and the e2e test that pin it, and the general
      rule: **a jump can only be patched by the construct that owns its target.** Note that
      `break outer` was always correct and shares every line of the mechanism except the
      patch — which is why the bug went unnoticed, and which is the same fact the rule
      states. Then the sentence the section exists for: this is what it costs to take an
      entry off the list — a fix, a chapter rewritten, and the entry moved to
      `appendix/d-inventory.md` § Closed rather than deleted. Cross-reference [Ch 19].
- [ ] **§ broken-tier-divergence** — The second `Broken`, and the more serious one, because
      it is a *wrong answer with no crash*. An `int[]` comparison that returns early from
      inside a `while` starts answering `0` after roughly fifty calls with the optimizing
      tier on, and answers correctly under `--no-opt`. Give the 27-line reproducer, give
      both outputs, and be explicit that
      `tests/e2e/optimizing/decimal-formatter.test.ts > "prints what toFixed prints, at
      every tier"` passes — the shipped regression test does not cover this shape. State
      the method for closing it (`--opt-bisect` plus per-pass `--verify`, [Ch 77]) and
      state that nobody has run it.
- [ ] **§ dead-lazy-parse** — The most instructive `Dead` entry, because every part of it
      works. Six sites implement lazy function parsing end to end: `LazyFunctionDeclaration`
      (`src/frontend/ast/index.ts:354`), the parser gate
      (`src/frontend/parser/index.ts:1041`), semantic lowering
      (`src/frontend/checker/semantic-lowering.ts:100`), the bytecode compiler
      (`compiler/functions.ts:933`), hoisting (`compiler/scope.ts:372`) and
      `Engine.compileLazy` (`src/api/engine.ts:1611`, which even bumps `version` and
      invalidates a `DEP_CALL_TARGET`). The gate requires `this.check(TokenType.Punctuator,
      "{")`. **tera has no braces around a function body** — it is an offside language
      [Ch 5] — so the path cannot fire on any tera source. Establish the general lesson:
      this is what a feature ported from a brace-language ancestor looks like six months
      later. Cost of removing: six sites plus five `RegisterCompiledFunction` fields
      (`isLazy`, `lazySource`, `lazyBodyStart`, `lazyBodyEnd`, `lazyParams`). Cost of
      *finishing*: change one gate to accept an indented body, then discover whether the
      version-bump invalidation is right.
- [ ] **§ dead-the-short-list** — The remaining `Dead` entries, one paragraph each, each
      naming file, symbol and removal cost: `ROP_TEST_FEEDBACK` (`bytecode.ts:76`, named
      `"TestFeedback"` at `:254`, given an effect entry at `register-effects.ts:181` and a
      `case` in `baseline/compiler.ts:384` — and emitted by nothing in
      `compiler/`); `DescriptorArray` (`objects/maps/hidden-class.ts:198`, constructed only
      by its own `clone`, and by `tests/objects/maps/hidden-class.test.ts`);
      `CFGInstruction.rep` (carried through four files, read by no decision);
      `IC_FAILURE_REASONS` (`deopt/deoptimizer.ts:173`, one occurrence);
      `intrinsic-cse.ts`'s `meetPredecessors` (a complete dataflow meet, one occurrence);
      `PRETENURE_SIZE_THRESHOLD` (`gc/gc.ts:22`, one occurrence — `allocate` takes a
      `pretenure` boolean instead); `GCHeader.forwarding` (declared, initialised, never
      read — a field left over from a copying collector this tree does not have, and the
      same fossil [Ch 61] found on the AOT side).
- [ ] **§ never-runs-the-stranded-marker** — The most expensive `Never runs`, and worth its
      own section because the code is *good*. `IncrementalMarker` is a complete tri-colour
      incremental marker with both a SATB and a Dijkstra write barrier, a time budget, and
      sixteen passing tests. `GenerationalGC.checkSafepoint` is the only thing that would
      drive it (`incrementalMarkingStep` when `_incrementalMajorGCActive`), and
      `checkSafepoint` has exactly one occurrence in `src/` — its own definition. So the
      marker never steps in a real run; major collection goes through the stop-the-world
      path. Cost of finishing: call `checkSafepoint` from the interpreter's back-edge
      handler and the baseline's [Ch 35] — which is precisely the seam the value-heap sweep
      bug [Ch 31] already taught the tree to be careful about.
- [ ] **§ never-runs-the-rest** — `Engine.runAgingCycle` (`api/engine.ts:1948`): a public
      method with no caller anywhere in `src/`, `tests/` or `tools/`, which means
      `ageCode`'s whole code-flushing policy is unexercised in a normal run.
      `AdaptiveTieringPolicy.shouldOSR` (`runtime/tiering/adaptive.ts:172`) and the
      interpreter's unassigned `shouldOSR?` hook (`interpreter/index.ts:198`).
      `InlineCacheManager.registerHiddenClassUsage` (`feedback/ic/index.ts:1448`): nothing
      populates `hiddenClassToICs`, so `invalidateForHiddenClass` and
      `invalidateDeprecatedMaps` always return `0` — and the only caller of the latter is
      inside `runAgingCycle`, which itself never runs. Two dead things pointing at each
      other is the shape to notice.
- [ ] **§ measured-worse** — Three entries, and the section that argues the marker is a
      *result*. Live-range splitting: `CompilerOptions.splitLiveRanges` defaults to `false`
      (`options.ts:122`); the machinery is complete (`linear-scan.ts:143`
      `splitPositionFor`, `:160` `splitAt`, `liveness.ts:139` `splittableAt`); two of the
      three Wimmer split rules measured as regressions [Ch 67]. The address-range nursery
      [Ch 62]: measured worse than the young list that shipped. In-place object marshalling
      behind `TERA_INPLACE` (`wasm/codegen.ts:1061`): measured as roughly equal to whole-
      graph serialization, i.e. not the fix. State the convention this section exists to
      protect: rule 9 forbids unmeasured performance language, so a feature that lost an
      A/B must be recorded *with where the number came from* or the next reader rebuilds it.
- [ ] **§ unfinished-bce** — The most interesting `Unfinished`, because the fix is not a
      patch. `rangeAnalysisAndBoundsCheckElimination` has three complete, correct routes to
      `bounded = true`, and on tera source none of them fires: the builder wraps every index
      in a `CheckSmi`, so the dominating-comparison test compares against the *check node*
      rather than the index node, the induction-variable detector does not see through it,
      and the array's length is not a known range. Establish why the obvious patch — look
      through `CheckSmi` — is not obviously sound: after [Ch 49], a `CheckSmi`'s narrowing
      is speculative, and AOT deletes the check, so a bound proved *through* the check may
      not survive the tier it was proved for. The honest cost is a soundness review that
      asks, for each of the three routes, whether the proof holds after the guard is
      removed. Cross-reference [Ch 46], whose title already says the pass cannot fire.
- [ ] **§ unfinished-a-name-without-an-algorithm** — `EphemeronHashTable`. Read its
      `_probe`: it is open addressing on a heap id with linear probing and tombstones — a
      perfectly good hash table with no weakness in it. There is no ephemeron fixpoint, no
      key-liveness rule, and no call into the marker; the value in a `WeakMap` entry keeps
      nothing alive and nothing is collected on the key's account. Rule 4 of
      `docs/CONVENTIONS.md` applies exactly here: say it once, then keep using the code's
      name. Cost of finishing: an ephemeron pass in whichever marker ships — which means
      § never-runs-the-stranded-marker has to be closed first.
- [ ] **§ unfinished-the-quiet-limits** — Three limits that are unenforced rather than
      absent. (1) The runtime-stub import takes `a0..a7`; `emitRuntimeStubCall` loops
      `i < 8` and drops everything past `inputs[7]` with no check — a node with nine inputs
      would call the stub with a silently truncated argument list. (2)
      `riscv64McTarget.encode` throws `UnsupportedInstructionError` for every opcode, so
      riscv64 emits assembly only; the fixup model and padding around it are real, which is
      what makes it `Unfinished` rather than `Dead`. (3) `elf64Executable` declares
      `carriesDebug: false`, so a self-linked ELF binary carries `.debug_line` for nothing —
      the ELF *object* and both PE images do carry it. Give the cost of each: an assertion;
      an encoder; an ELF section table in the executable writer [Ch 70].
- [ ] **§ unfinished-the-missing-verifier** — The entry that ties the chapter together.
      There are two verifiers in the tree — `validateMachineFunction`
      (`machine/verifier.ts`) and `verifyAfterPass` (`pipeline.ts:291`) — and both are
      gated on `CompilerOptions.verifyEachPass`, which defaults to `false`. There is **no
      bytecode verifier at all**: `grep -rn verify src/bytecode/` is empty. Establish what
      one would check (every jump operand in range; every register below `registerCount`;
      every constant index in range; the accumulator defined before use on every path;
      `TryStart`/`TryEnd` balanced) and what it would have caught (§ broken-labeled-continue,
      in the compiler, at compile time, in one pass). Cost of finishing: a hundred lines and
      a decision about whether it runs always or under a flag. Cross-reference [Ch 78].
- [ ] **§ how-to-read-a-codebase** — The method, and the section a reader can reuse on
      their own tree. Three techniques, each with the command that runs it.
      (1) **Single-occurrence grep.** A symbol that appears once in `src/` is defined and
      never used; six of this chapter's entries were found that way. Show the loop.
      (2) **Read the tests that exist only to assert a rejection.** 366 test titles in
      `tests/` begin `rejects`, `refuses`, `declines`, `cannot` or `does not` — each one is
      a boundary someone decided to draw, and a boundary is a design document [Ch 81].
      Show the grep. (3) **Distrust notes and memory over code.** Two entries in the
      previous edition of this list are now wrong: one was fixed and the note was not
      updated; one was believed fixed because a regression test passed, and the test
      covered a different shape (§ broken-tier-divergence). The rule: **an entry leaves the
      inventory when a command reproduces nothing, not when a note says so** — which is
      the same rule [Ch 80 § divergence-ledger] states for the divergence table, and the
      reason rule 13 requires every chapter to end with commands.
- [ ] **§ what-the-list-is-for** — Close in half a page. An inventory is not an apology.
      It is what makes the rest of the book usable: a reader who wants to contribute now
      has a ranked list of tractable work, and a reader who wants to trust a claim now
      knows exactly which claims are not being made.

## Honesty items

Every item below is also an item *of* this chapter; the section that discusses it is named.

- > **Broken.** The optimizing tier answers differently from `--no-opt` on an `int[]`
  comparison that returns early from inside a `while`. Reproduced 2026-09-07; reproducer in
  Verify it yourself. No file or symbol can be named yet — that is what makes it expensive.
  § broken-tier-divergence.
- > **Dead.** The lazy-parse chain, six sites, gated on a `{` tera source never contains.
  § dead-lazy-parse.
- > **Dead.** `ROP_TEST_FEEDBACK`, `DescriptorArray`, `CFGInstruction.rep`,
  `IC_FAILURE_REASONS`, `meetPredecessors`, `PRETENURE_SIZE_THRESHOLD`,
  `GCHeader.forwarding`. § dead-the-short-list.
- > **Never runs.** `GenerationalGC.checkSafepoint` (`src/gc/gc.ts:176`), which strands a
  complete `IncrementalMarker`. § never-runs-the-stranded-marker.
- > **Never runs.** `Engine.runAgingCycle` (`src/api/engine.ts:1948`),
  `AdaptiveTieringPolicy.shouldOSR` (`src/runtime/tiering/adaptive.ts:172`),
  `InlineCacheManager.registerHiddenClassUsage` (`src/feedback/ic/index.ts:1448`).
  § never-runs-the-rest.
- > **Measured worse.** `CompilerOptions.splitLiveRanges` (`src/optimizing/options.ts:122`),
  the address-range nursery, and `TERA_INPLACE`
  (`src/optimizing/backends/wasm/codegen.ts:1061`). § measured-worse.
- > **Unfinished.** `rangeAnalysisAndBoundsCheckElimination`
  (`src/optimizing/passes/checks.ts:141`) cannot fire on tera source; the fix is a
  soundness review, not a patch. § unfinished-bce.
- > **Unfinished.** `EphemeronHashTable` (`src/objects/heap/js-collections.ts:249`) is a
  hash table with no ephemeron algorithm. § unfinished-a-name-without-an-algorithm.
- > **Unfinished.** `riscv64McTarget.encode`
  (`src/optimizing/backends/riscv64/mc/target.ts:23`) throws for every opcode;
  `x64/backend.ts:57` sets `macho: null` beside a complete `format.ts` description of the
  format. § unfinished-the-quiet-limits.
- > **Unfinished.** `elf64Executable` (`src/optimizing/mc/formats/elf64.ts:452`) declares
  `carriesDebug: false`. § unfinished-the-quiet-limits.
- > **Unenforced.** `emitRuntimeStubCall`
  (`src/optimizing/backends/wasm/codegen.ts:2247`) loops `i < 8` with no guard against a
  node having more inputs. § unfinished-the-quiet-limits.
- > **Unenforced.** There is no bytecode verifier. § unfinished-the-missing-verifier.
- > **Unenforced.** Both verifiers that do exist are gated on
  `CompilerOptions.verifyEachPass`, default `false` (`src/optimizing/options.ts:129`).
  § unfinished-the-missing-verifier.

## Verify it yourself

```bash
node dist/cli.js docs/example/labeled.tera; node dist/cli.js --print-bytecode docs/example/labeled.tera 2>&1 | grep -n "Jump"
for s in PRETENURE_SIZE_THRESHOLD IC_FAILURE_REASONS meetPredecessors checkSafepoint registerHiddenClassUsage runAgingCycle; do echo "$s: $(grep -rn "$s" src/ --include=*.ts | wc -l)"; done
grep -rhoE 'it\("(rejects|refuses|declines|cannot|does not)[^"]*"' tests/ | wc -l
cat > /tmp/bignum.tera <<'EOF'
fn compare(a: int[], b: int[]) -> int:
  i: int = a.length - 1
  while i >= 0:
    if a[i] != b[i]:
      if a[i] > b[i]:
        return 1
      return -1
    i -= 1
  return 0

fn halve(a: int[]) -> void:
  carry: int = 0
  i: int = a.length - 1
  while i >= 0:
    value: int = carry * 32768 + a[i]
    a[i] = value >> 1
    carry = value & 1
    i -= 1

left: int[] = [0, 0, 0, 0, 29824, 19521, 727]
right: int[] = [0, 0, 0, 24340, 10651, 23676, 700]
marks: string = ""
i: int = 53
while i >= 0:
  marks = marks + compare(right, left).to_string() + ","
  halve(left)
  i -= 1
print(marks)
EOF
node dist/cli.js --no-opt /tmp/bignum.tera; node dist/cli.js /tmp/bignum.tera
npx vitest run --project unit tests/gc/incremental-marker.test.ts tests/optimizing/passes/checks.test.ts
npx vitest run --project e2e tests/e2e/docs/book-examples.test.ts
```

The last two lines of the bignum block differ from each other. Under `--no-opt` the output
ends `...,1,1,1,1,`; with the optimizing tier on it ends `...,1,0,0,0,0,0,`.

## Tests that pin this

- `labeled.tera` is executed, and its output is the assertion:
  `tests/e2e/docs/book-examples.test.ts` >
  `"labeled.tera resumes the outer loop instead of restarting the program"`, which expects
  `["1", "2", "3", "5", "6", "7"]`, and `"covers every example file, so a new one cannot be
  added untested"` — which is what stops the file being quietly dropped from the set. The
  compiler-side pins are `tests/bytecode/register/compiler.test.ts` >
  `"backpatches labeled continue in a while loop to the outer loop latch"`,
  `"backpatches labeled continue in a for loop to the outer loop latch"`,
  `"sends labeled continue past the inner loop rather than to the inner latch"` and
  `"rejects a labeled continue whose label does not name a loop"` — the last of which pins
  the new refusal, not the old jump.
- Bounds-check elimination has no test that eliminates a bounds check.
  `tests/optimizing/passes/checks.test.ts` covers `eliminateRedundantChecks` —
  `"removes duplicate CheckMap on same object with same map"`,
  `"removes duplicate CheckSmi on same value"`,
  `"propagates checks through dominator tree"`,
  `"eliminates CheckMap in dominated block across StoreField"` — and covers range analysis
  only through its side effects: `"marks noOverflow on add with small constant ranges"`,
  `"folds always-true branch comparison"`, `"computes range for subtraction"`,
  `"bounds a parameter declared int by the int32 range"`,
  `"leaves a parameter with no declared type unbounded"`. The absence is the evidence.
- The stranded marker is complete and correct: `tests/gc/incremental-marker.test.ts` >
  `"marks reachable graph BLACK through transitive references"`,
  `"unreachable objects remain WHITE"`, `"handles cycles without infinite loop"`,
  `"step processes a subset and returns true while work remains"`,
  `"step returns false and sets markingComplete when done"`,
  `"SATB: pushes old WHITE ref when holder is BLACK"`,
  `"skips barrier when holder is not BLACK"`, `"skips barrier when not actively marking"`,
  `"does not push already-BLACK refs"`. Sixteen tests for code no run reaches.
- `EphemeronHashTable` is tested as a hash table, which is what it is:
  `tests/objects/heap/js-collections.test.ts` >
  `"set/get round-trips for object keys"`, `"rejects non-object keys"`,
  `"overwrite updates value"`, `"rehashes under load"`. No test asserts anything weak,
  because there is nothing weak to assert.
- The IC's invalidation index is exercised only by its own test:
  `tests/feedback/ic.test.ts` >
  `"registerHiddenClassUsage and invalidateForHiddenClass"`. It is the sole caller in the
  tree.
- The OSR policy method is exercised only by its own test:
  `tests/runtime/tiering/adaptive.test.ts` >
  `"shouldOSR returns false without optimized OSR entry"`.
- The tier divergence is **not** pinned by the test that looks like it should be:
  `tests/e2e/optimizing/decimal-formatter.test.ts` >
  `"prints what toFixed prints, at every tier"` passes. `[unpinned]` — no test in the tree
  covers the early-return-inside-a-while shape.
