# 19. The Jump Nobody Patched   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Single-pass code generation with backpatching is the oldest trick in the book,
and it fails *silently* — because an unpatched jump is not a malformed instruction, it is
a perfectly valid one whose target is the program's first instruction.

**What arrived.** From [Ch 18]: straight-line expression code, an accumulator convention,
a `registerCount` high-water mark, and the two short-circuit jumps `&&` / `||` / `?:` /
`??` / `?.` already patch for themselves.

**What leaves.** A complete control-flow shape — loops, conditionals, `switch`, `try`,
labelled statements — expressed only as absolute instruction indices in operand 0 of
`Jump`, `JumpIfTrue`, `JumpIfFalse` and `TryStart`. Everything downstream that wants a
control-flow graph ([Ch 38]) has to rediscover it from those numbers.

**New ideas.** backpatching (emit a placeholder, remember where, fill it in later);
a back edge, and why `target < pc` is the entire test; single-pass code generation, and
what a second pass would have bought.

**Length.** 14 pages

## Anchors

- `src/bytecode/register/compiler/statements.ts` (690 lines) — `statementMethods`.
  `compileStatement`'s 25-case dispatch (218), `compileLetDeclaration` (283),
  `compileIfStatement` (326), `_bodyMayCapture` (341), `compileWhileStatement` (385),
  `compileForStatement` (406), `compileReturnStatement` (455), `compileBlock` (477),
  `compileSwitchStatement` (490), `compileBreakStatement` (551),
  `compileTryStatement` (561), `compileThrowStatement` (637),
  `compileDoWhileStatement` (642), `compileContinueStatement` (654),
  `compileLabeledStatement` (668), and `_collectInterfaceDeclarations` (205).
  The state it swaps: `_breakJumps`, `_continueJumps`, `_finallyBlocks`,
  `_labeledBreaks`, `_labeledContinues`, `_pendingLoopLabels`.
- `src/bytecode/register/compiler/helpers.ts:116-157` — `LoopContext`, `LoopJumpOwner`,
  `enterLoop` (131) and `exitLoop` (147). Every loop in the compiler enters and leaves
  through this pair, and it is where the labelled-`continue` fix lives: `enterLoop`
  installs fresh `breakJumps` / `continueJumps` arrays *and* drains
  `_pendingLoopLabels` (140-143), so any label wrapped around this loop is now owned by
  this loop's context; `exitLoop` patches both lists and restores the enclosing ones.
- `src/bytecode/register/ops/bytecode.ts` — `emit` returns
  `this.instructions.length - 1` (line 572); `patchJump(instrIndex, target)` is a
  one-line `this.instructions[instrIndex]!.operands[0] = target` (595-597). Those two
  lines are the whole mechanism.
- `src/bytecode/register/ops/register-effects.ts` — `ControlEffect`
  (`next` | `jump` | `branch` | `terminate` | `enter-handler` | `leave-handler`),
  `CONTROL_TARGET_OPERAND = 0`, `controlTargetOf`, `jumpTargetOf`, `handlerTargetOf`.
  This is the downstream reader that has to trust operand 0.
- `src/bytecode/register/interpreter/index.ts` — the three control cases:
  `ROP_JUMP` (1775-1784), `ROP_JUMP_IF_FALSE` (1786-1798), `ROP_JUMP_IF_TRUE` (1800+).
  Each does `if (target < frame.pc) { loopCounter++; … onBackEdge(…) }` and then
  `frame.pc = target`. Absolute, and a back edge is defined by arithmetic alone.
- `tests/bytecode/register/compiler.test.ts` — the `while`, `for`, `do-while`,
  `break and continue` and `if statements` describes.

## Worked example

`docs/example/labeled.tera` — seven lines, one `continue outer`, and one jump that took a
handover to patch.

```bash
node dist/cli.js docs/example/labeled.tera
node dist/cli.js --print-bytecode --filter '<script>' docs/example/labeled.tera > labeled.txt 2>&1
grep -n -B2 -A2 'Jump r64' labeled.txt
```

The first prints `1 2 3 5 6 7`, one per line, and exits 0. The third prints, verbatim:

```
    55  TestLooseEqual r4 r2
    56  JumpIfFalse r58 r3
    57  Jump r64
    58  LdaGlobal [9] (print)
    59  Star r3
```

Instruction 57 is `continue outer`, and 64 is the outer loop's latch — `64  Jump r29`,
the back edge to `29  Ldar r15`, where the outer `for-of` steps its iterator. Instruction
57 holds that number for a reason worth the chapter: not because the label wrote it
there, but because the labelled loop *claimed the label* and patched it on the way out.

Until the fix, instruction 57 read `Jump r0`. Nothing had patched it, `0` is a legal
target, and instruction 0 of `<script>` is `LdaConst [0] (1)` — the first instruction of
the program. So `continue outer` re-entered neither loop: it restarted the whole script,
rebuilt `rows`, and printed `1 2` forever.

## Outline

- [ ] **The problem, stated once.** Establish why a forward jump is hard and a backward one
      is not: when the emitter reaches `if x:` it must emit "jump past the body" before it
      has emitted the body, so it does not yet know where the body ends. `> **New idea.**`
      backpatching, in its classical form — emit a placeholder, remember the *index* of the
      instruction you emitted, come back and overwrite it.
- [ ] **The two lines that implement it.** `emit` returning `instructions.length - 1`
      (bytecode.ts:572) and `patchJump` writing `operands[0]` (595). Establish the
      consequence that makes this chapter possible: `patchJump` has no idea whether the
      instruction it is writing to is a jump, no idea whether it has been patched already,
      and no idea whether every jump has been patched at all. It is an array store.
- [ ] **Absolute targets, and what a back edge is.** Establish the divergence [Ch 17]
      flagged, now with its consequences visible. Targets are instruction indices, so
      `patchJump(j, this.func.instructions.length)` — patch to *the next instruction to be
      emitted* — is the idiom used everywhere. Then the pay-off in the interpreter: a back
      edge is exactly `target < frame.pc` (interpreter/index.ts:1778), which is what drives
      `loopCounter` and `onBackEdge`, which is [Ch 35]'s tiering trigger and [Ch 37]'s OSR
      poll. And then the cost, which is this chapter's whole subject: **the placeholder
      value `0` is a legal target.** `> **New idea.**` back edge.
- [ ] **`if` and `if/else`.** The two smallest shapes, read whole (`compileIfStatement`,
      326-339): one patch when there is no `else`, two when there is, and the `else` case's
      `jumpToEnd` emitted *before* patching `jumpToElse` so the fall-through lands after
      it. Point out that `JumpIfFalse` carries a feedback slot in operand 1 — a branch is a
      feedback site ([Ch 33 § branch-bias]).
- [ ] **`while`, `for`, `do-while`.** Establish the three loop shapes side by side and the
      one thing that differs: where `continue` lands. `while` hands `exitLoop` a
      `continueTarget` that is the index *after* the body (385-404). `for` hands it
      `updateStart`, so `continue` still runs the update (406-453). `do-while` needs no
      forward patch for its back edge at all — it emits
      `JumpIfTrue loopStart, fb` with the target already known (649), the only loop
      instruction in the compiler that is born patched. Draw all three as a mermaid
      flowchart, one figure, three subgraphs.
- [ ] **`_breakJumps` / `_continueJumps`: save, swap, restore.** Establish the idiom, and
      the one place it lives: `enterLoop` stashes the enclosing lists on a `LoopContext`
      and installs fresh arrays; the body is compiled (during which
      `compileBreakStatement` and `compileContinueStatement` push jump indices into
      whichever arrays are current); `exitLoop` patches both lists and restores what it
      saved (helpers.ts:131-157). This is the same explicit save/restore discipline
      [Ch 18 § four-mixins] found around nested functions, applied to control flow — and
      it is one function pair, called by all five loop lowerings: `while` (385), `for`
      (406), `do-while` (642), and `compileForInStatement` (1238) /
      `compileForOfStatement` (1335) in `functions.ts`. Note the asymmetry that matters
      later: `compileSwitchStatement` swaps `_breakJumps` **only** (495-497), by hand and
      not through `enterLoop`, because `continue` inside a `switch` must belong to the
      enclosing loop.
- [ ] **`switch` is linear compare-and-dispatch.** Read `compileSwitchStatement` (490-549)
      and establish what it is *not*: no jump table, no binary search, no hash. It emits
      one `TestEqual` + `JumpIfTrue` per case in source order, then an unconditional jump
      to the default (or past the end), then all the bodies contiguously so fall-through is
      free, then patches every dispatch jump to its body. Two feedback slots per case. Say
      the complexity honestly — dispatch is O(number of cases) — and do **not** call it
      slow; nothing here was measured ([Conventions §9]).
- [ ] **`try` / `catch` / `finally`, and the two nested handlers.** Establish why `finally`
      needs two `TryStart`s (561-610): an outer handler that runs the finalizer and
      rethrows, an inner one that runs the catch. Establish that the finalizer body is
      compiled **three times** for a `try/catch/finally` — normal path, exceptional path,
      and once per enclosing `return` — and that this duplication is the alternative to a
      subroutine-return opcode the set does not have.
- [ ] **`return` unwinds by hand.** `compileReturnStatement` (455-475) is the clearest
      statement of that trade: with `_finallyBlocks` non-empty, it parks the return value in
      a temp, then walks the stack of pending finalizers *backwards*, emitting `TryEnd` and
      re-compiling each finalizer's statements, and — the subtle part — sets
      `this._finallyBlocks = saved.slice(0, i)` before each one so a `return` *inside* a
      finalizer does not re-run the finalizers it is already inside. Then `Ldar retReg`,
      `Return`.
- [ ] **`_bodyMayCapture` decides whether a loop needs `CloseUpvalues`.** Establish the
      analysis (341-383): a recursive structural walk for any function-shaped node, with
      the result memoised onto the AST node as `_mayCapture`. If true, the loop emits
      `ROP_CLOSE_UPVALUES iterationScopeBase` at the continue target, where
      `iterationScopeBase` is `this.func.registerCount` captured *before* the loop
      (386, 409). Say what it is for here — one instruction, one operand — and hand the
      semantics to [Ch 20 § close-upvalues], which has the two-answer example.
- [ ] **The bug.** {#the-bug} The symptom first, from the disassembly above:
      `57  Jump r0`, a perfectly legal instruction pointing at the entry of the script.
      Then the mechanism. `compileLabeledStatement` used to initialise **both**
      `_labeledBreaks[label]` and `_labeledContinues[label]`; `compileBreakStatement` (551)
      and `compileContinueStatement` (654) both pushed `emit(ROP_JUMP, 0)` indices into
      them; and then the label patched **only** the breaks and `delete`d both lists. Every
      `continue outer` kept its placeholder. State the general rule this half produces:
      *a placeholder that is indistinguishable from a valid value cannot fail loudly.*
- [ ] **Why the one-line fix is wrong.** Stage the obvious patch — mirror the break-patch
      loop for continues — and show it cannot work. A labelled `continue` must land on the
      labelled *loop's* continue target, which is `continueTarget` for a `while`,
      `updateStart` for a `for`, the test for a `do-while`, and the iterator step for
      `for-of` / `for-in`. `compileLabeledStatement` does not know which loop it wrapped or
      where that point is, so there is no number for it to write. This is the chapter's
      real rule, and it is the stronger of the two: **a jump can only be patched by the
      construct that owns its target.** A labelled statement owns a label; it does not own
      a latch.
- [ ] **The fix: the label is handed to the loop.** {#the-fix} Read
      `compileLabeledStatement` (668-689) — twenty-two lines, two over the excerpt rule
      ([Conventions §3]), so quote it in the two halves that now differ in kind. The break
      half is unchanged and still patches itself, at `afterLabel` (680-683), because the
      label *does* own the instruction after itself. The continue half no longer resolves
      anything: it stores a sentinel array in `_labeledContinues[label]` and appends the
      label to `_pendingLoopLabels` (671-675), and only if `labelsLoop(body)` (84) says the
      label actually wraps a loop. `enterLoop` (helpers.ts:131-145) — the function every
      loop already called — then drains `_pendingLoopLabels` and points
      `_labeledContinues[label]` at the loop's own `continueJumps` array (140-143). So
      `compileContinueStatement` pushes a labelled continue straight into the loop's list,
      and `exitLoop` patches it with the unlabelled ones, to the target only the loop knew.
      Two consequences worth drawing out: the label never computes a target, and the
      sentinel makes the failure case *detectable* — if `_labeledContinues[label]` is still
      the sentinel and non-empty, no loop ever claimed the label, so the compiler throws
      `[RegCompiler] Label 'x' does not name a loop` (684-686) rather than emitting a jump
      nothing can patch. A silent hang became a compile error.
- [ ] **The regression tests.** Four in the compiler and one in the example suite, pinning
      four different things. That the labelled continue lands on the *outer* latch, in a
      `while` and in a `for-of`
      [t: tests/bytecode/register/compiler.test.ts > "backpatches labeled continue in a while loop to the outer loop latch"]
      [t: tests/bytecode/register/compiler.test.ts > "backpatches labeled continue in a for loop to the outer loop latch"].
      That its target is *past* the inner latch rather than equal to it
      [t: tests/bytecode/register/compiler.test.ts > "sends labeled continue past the inner loop rather than to the inner latch"]
      — the assertion the one-line fix would have failed. That a label naming no loop is
      refused
      [t: tests/bytecode/register/compiler.test.ts > "rejects a labeled continue whose label does not name a loop"].
      And that the program answers
      [t: tests/e2e/docs/book-examples.test.ts > "labeled.tera resumes the outer loop instead of restarting the program"],
      which runs `labeled.tera` and expects `["1","2","3","5","6","7"]`. Note that the
      first of those also asserts `insAt(func, outerLatch).operands[0]` is `0`: the
      legitimate zero target, asserted in the same test that proves the illegitimate one is
      gone.
- [ ] **The verifier that does not exist.** Close by arguing for the missing pass, and
      cost it. The fix above closed the hole for exactly one shape, by hand, at the one
      site that could see it; nothing generalises it. The invariant is one line —
      *no reachable `Jump`/`JumpIfTrue`/`JumpIfFalse`
      may still hold its placeholder* — but it is not checkable as written, because `0` is
      a legal target (`tests/bytecode/register/compiler.test.ts >
      "back-jump points to loop start"` asserts `operands[0]` is exactly `0` for a
      `while true` at script scope). So the check has to be structural, not value-based:
      emit placeholders as `-1`, or keep a per-function set of unpatched indices that
      `compile()` asserts is empty. Note that the engine *has* verifiers elsewhere and
      cares about them ([Ch 78]) — an SSA verifier per pass, a MachineIR verifier — and
      that the one tier with no verifier at all is the one every other tier reads from.
      `> **Unenforced.**`

## Honesty items

- > **Unenforced.** Nothing checks that every emitted jump was patched. `patchJump` is an
  array store with no bookkeeping, `emit` returns an index nobody is obliged to use, and
  `compile()` (`compiler/index.ts:143`) returns without inspecting the instruction list.
  This is the enforcement gap that made the labelled-`continue` bug a silent hang instead
  of a compile error ([Ch 19 § the-bug]); the fix closed it for that one shape, by hand
  ([Ch 19 § the-fix]), and for no other.
  Cost of enforcing: a placeholder sentinel (`-1`) plus one assertion at the end of
  `compile()`, or a `pendingJumps: Set<number>` on `RegisterCompiledFunction` that
  `emit`-with-placeholder adds to and `patchJump` removes from.
- > **Unfinished.** `compileBreakStatement` and `compileContinueStatement` both fall
  through silently when neither a labelled list nor an unlabelled list is present
  (`statements.ts:556-558`, `663-665`): a `break` outside any loop emits **nothing** and
  compiles clean. The checker may reject it earlier ([Ch 13]) but the bytecode compiler
  does not. [unpinned]
- > **Unfinished.** `compileTryStatement`'s no-finalizer branch (611-634) emits the catch
  body with no handler-pop on the normal path other than the `TryEnd` at 614, and its
  `handler === undefined` case (a bare `try` with neither `catch` nor `finally`) compiles
  to a `TryStart` whose catch target is the instruction right after the block — swallowing
  the exception and continuing. The `finalizer` branch handles the same case by emitting an
  explicit `ROP_THROW` (590). Two branches, two answers. [unpinned]

## Verify it yourself

```bash
node dist/cli.js docs/example/labeled.tera
node dist/cli.js --print-bytecode --filter '<script>' docs/example/labeled.tera > labeled.txt 2>&1
grep -n -B2 -A2 'Jump r64' labeled.txt
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
npx vitest run --project unit tests/bytecode/register/compiler.test.ts
npx vitest run --project e2e tests/e2e/language/control-flow.test.ts
```

The first prints `1 2 3 5 6 7` on six lines and exits 0; the third shows instruction 57
patched to 64, the outer loop's latch. The fourth command is the control: `mean`'s
`while` loop patches correctly —
instruction 14 is `JumpIfFalse r32 r3` (patched forward to 32, past the loop) and
instruction 31 is `Jump r4` (a back edge to the test at 4, and `4 < 31`, which is what
makes it a back edge to the interpreter).

## Tests that pin this

- `tests/bytecode/register/compiler.test.ts > "emits loop structure with condition check and back-jump"`
- `tests/bytecode/register/compiler.test.ts > "back-jump points to loop start"`
  — and note what it asserts: `operands[0]` is `0`. The legitimate target and the
  unpatched placeholder are the same number. This test is the best evidence in the tree
  that the missing verifier cannot be value-based.
- `tests/bytecode/register/compiler.test.ts > "compiles if without else"`
- `tests/bytecode/register/compiler.test.ts > "compiles if-else"`
- `tests/bytecode/register/compiler.test.ts > "patches jump targets correctly for if-else"`
- `tests/bytecode/register/compiler.test.ts > "patches jump target correctly for &&"`
- `tests/bytecode/register/compiler.test.ts > "compiles for loop with init, test, update"`
- `tests/bytecode/register/compiler.test.ts > "emits body before condition check"`
  — do-while.
- `tests/bytecode/register/compiler.test.ts > "compiles break in while loop"`
- `tests/bytecode/register/compiler.test.ts > "compiles continue in while loop"`
  — note the coverage shape: both assert only that a `Jump` was emitted, never that it was
  patched. The four tests below are the ones that assert a target.
- `tests/bytecode/register/compiler.test.ts > "backpatches labeled continue in a while loop to the outer loop latch"`
- `tests/bytecode/register/compiler.test.ts > "backpatches labeled continue in a for loop to the outer loop latch"`
- `tests/bytecode/register/compiler.test.ts > "sends labeled continue past the inner loop rather than to the inner latch"`
  — the one that fails against the one-line fix: it asserts the labelled continue's target
  is strictly greater than the inner loop's latch.
- `tests/bytecode/register/compiler.test.ts > "rejects a labeled continue whose label does not name a loop"`
  — the sentinel path, now a compile error rather than an unpatchable jump.
- `tests/bytecode/register/compiler.test.ts > "ternary emits both branches with correct jump structure"`
- `tests/bytecode/register/ops/bytecode.test.ts > "emit appends instruction and returns its index"`
- `tests/bytecode/register/ops/bytecode.test.ts > "patchJump updates operand[0] of target instruction"`
  — the whole mechanism, in two tests.
- `tests/bytecode/register/ops/register-effects.test.ts > "sends an unconditional jump to its target and nowhere else"`
- `tests/bytecode/register/ops/register-effects.test.ts > "names the target of either conditional jump"`
- `tests/bytecode/register/ops/register-effects.test.ts > "ends the path at a return and at a throw alike"`
- `tests/bytecode/register/ops/register-effects.test.ts > "opens a handler at a try and closes it at its end"`
- `tests/e2e/language/control-flow.test.ts > "runs labeled indentation blocks with labeled break"`
  — the labelled `break` half, which always worked.
- `tests/e2e/language/control-flow.test.ts > "resumes the labeled for-of from inside a nested loop"`
- `tests/e2e/language/control-flow.test.ts > "resumes the labeled while from inside a nested loop"`
- `tests/e2e/language/control-flow.test.ts > "resumes the labeled loop written as an indentation block"`
- `tests/e2e/language/control-flow.test.ts > "runs the loop's update before resuming a labeled for"`
  — the four loop shapes whose continue targets differ, which is why the label could not
  compute any of them.
- `tests/e2e/language/control-flow.test.ts > "keeps unlabeled continue bound to the innermost loop"`
  — the handover must not steal the unlabelled case.
- `tests/e2e/language/control-flow.test.ts > "runs Python-style if, while, for-of, and for-in blocks"`
- `tests/e2e/language/control-flow.test.ts > "catches thrown values and always runs finally"`
- `tests/e2e/language/control-flow.test.ts > "runs an offside switch with case and default"`
- `tests/e2e/docs/book-examples.test.ts > "labeled.tera resumes the outer loop instead of restarting the program"`
  — the example suite runs the file and expects `["1","2","3","5","6","7"]`. The variation
  that once had to be quarantined is now checked like every other one.
