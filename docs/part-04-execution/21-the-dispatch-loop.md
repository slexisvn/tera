# 21. The dispatch loop   ⟨I⟩

> **Status:** outline

**Thesis.** `runFrame` is a `while` over `frame.pc` with a `try` around every single
instruction, and the two boolean fields on the frame that let `getReg` skip the accessor
path — `hasUpvalues` and `hasTDZ` — are the whole performance story of tier zero.

**What arrived.** A `RegisterCompiledFunction` from Part III: `instructions`, `constants`,
`registerCount`, `paramCount`, `localNames`, `uninitializedLocalSlots`, `selfBindingSlot`,
and a `feedbackVector` that is still `null`.

**What leaves.** A `TaggedValue` return, and — as a side effect nobody asked for but every
later part depends on — a populated `FeedbackVector` and warm inline caches. Also
`loopCounter`, handed to `tieringPolicy.recordLoopIterations` in the `finally`.

**New ideas.** Register machine vs stack machine (recap, one line); *accumulator*;
*program counter*; *dispatch*; *frame*; *upvalue cell*; *temporal dead zone*; *host
language* (the JavaScript that the interpreter itself is written in) — this last one is
load-bearing for the whole part and gets its primer here.

**Length.** 14 pages

## Anchors

- `src/bytecode/register/interpreter/frame.ts` — `RegisterFrame` (the fourteen fields),
  `RegisterValue`, `TDZ_UNINITIALIZED`, `isTDZUninitialized`, `throwIfTDZ`,
  `ExceptionHandlerRecord`, `SuspendedFrameRoots`, `getReg`, `setReg`,
  `getOrCreateUpvalueCell`, `closeUpvalues`, `closeUpvaluesFrom`, and the
  `directRegisters` getter. 141 lines — the smallest file in the part and the most quoted.
- `src/bytecode/register/interpreter/index.ts` — `RegisterInterpreter`, `runFrame`
  (line 1386), the `switch (op)` and its `default:` throw, `interpretCall`,
  `callFunction`, `updateCallMode` and the five `CALL_*` modes, `takeCatchPC`,
  `onBackEdge`, `_maybeSweepHeapPayloads`, `constantRuntimeValue`, `wrapConstant`,
  `missingGlobalMessage`.
- `src/bytecode/register/interpreter/helpers.ts` — `getBinaryOperands` (the one place
  binary feedback is recorded), `RegisterException`, `asThrownValue`,
  `errorToTaggedValue`, `INTERPRETER_ONLY_OPS`, `requiresInterpreterOnly`.
- `src/bytecode/register/interpreter/handlers.ts` — `handleLdaProp`, `handleStaProp`,
  `handleLdaIndex`, `handleStaIndex`, `handleLdaKeyedSlice`, `handleNew`,
  `handleDefineAccessor`, `handleInstanceof`, `handleIn`, `handleDeleteProp`: the ten
  opcodes lifted out of the switch. Named here, opened in [Ch 24 § lda-prop].
- `src/optimizing/baseline/compiler.ts` — `emitOp` cases for `ROP_LDA_REG` / `ROP_STAR`,
  which emit bare `r[n]` when the function has no closures and an `_ouv.has(n)` guard when
  it does. This is the compiled tier that `hasUpvalues` exists to serve.
- `tests/bytecode/register/interpreter.test.ts` — 858 lines of opcode-level unit tests.

## Worked example

`docs/example/stats.tera`, the loop inside `Series.mean` (lines 6-12). One iteration,
traced opcode by opcode.

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --trace docs/example/stats.tera | grep '^\[INTERP\] mean' | sed -n '15,32p'
```

The first command gives the operand meanings (`LdaNamedProperty r3 [2] (length) r1`); the
second gives the executed stream. The tracer prints opcode and operands only — **not** the
accumulator — so the chapter's accumulator column is reconstructed by hand from the
disassembly, and the chapter says that in one sentence rather than implying the engine
prints it.

## Outline

- [ ] **`runFrame` in fifteen lines.** Push name onto `callStack`, push frame onto
      `activeFrames`, `while (frame.pc < instructions.length)`, `frame.pc++` *before* the
      switch, `break` to fall through, `continue` for a taken jump, `finally` pops both.
      Establish: pc is incremented first, so every jump target is an absolute index and
      `continue` skips the increment.
- [ ] **The frame is fourteen fields.** Walk `RegisterFrame`'s constructor:
      `registers` filled with `CODE_UNDEFINED`, TDZ slots overwritten with the
      `TDZ_UNINITIALIZED` sentinel, `acc = CODE_UNDEFINED`, `thisValue`, `closureEnv`,
      `originalArgs`, `exceptionHandlers = null`, `locals` aliased to `registers`,
      `suspendable = isAsync || isGenerator`. Establish: parameters are just registers
      `0..paramCount-1`, copied in a loop, and surplus arguments are dropped.
- [ ] **`getReg` is three implementations wearing one signature.** In order:
      `hasUpvalues && openUpvalues?.has(idx)` → cell read; then `hasTDZ && val ===
      TDZ_UNINITIALIZED` → `VMReferenceError` naming `localNames[idx]`; then the plain
      array read. Establish: both booleans are *false for almost every function*, so the
      common path is one array index plus two failed branch predictions.
- [ ] **`directRegisters` states the invariant the compiled tiers rely on.** The getter
      returns `registers` exactly when neither boolean is set — which is the condition
      under which `BaselineCompiler` is allowed to emit bare `r[n]`. Establish the
      invariant, then admit nothing reads the getter (honesty item below).
- [ ] **Fast and slow paths on `ROP_ADD`.** Four tiers inside one case:
      `areBothSmi` → integer add with an explicit `SMI_MIN/SMI_MAX` range re-check;
      `areBothNumber` → `mkDouble`; `applyBinaryOverload("add", ...)`; then
      `toPrimitive` on both sides and a string-or-number decision. Establish: the range
      re-check is why `mkSmi` can stay unchecked ([Ch 22 § mksmi-is-unchecked]).
- [ ] **Feedback is recorded in exactly one place.** `getBinaryOperands` reads
      `frame.acc` as left and a register as right, and — only if the vector exists, is not
      `saturated`, and the slot is not already `isStable` — calls
      `slot.recordBinaryOp(getTag(left), getTag(right))`. Establish: the interpreter pays
      for feedback only until the slot stops changing. Forward to [Ch 33].
- [ ] **Why property and index opcodes were lifted into `handlers.ts`.** Ten cases became
      ten one-line calls. State what the split bought (a switch that fits on a screen, and
      handlers reusable by [Ch 24]) and what it cost (an `InterpreterLike` structural type
      duplicating the interpreter's surface, `handlers.ts:77-101`).
- [ ] **Jumps and the back edge.** `ROP_JUMP` / `ROP_JUMP_IF_FALSE` / `ROP_JUMP_IF_TRUE`
      all do the same three things when `target < frame.pc`: bump `loopCounter`, call
      `onBackEdge`, and return the OSR result if it is non-null. Establish: the back edge
      is the only polling point in tier zero — it carries tiering ([Ch 35]), OSR
      ([Ch 37]) and the handle sweep ([Ch 31 § back-edge-sweep]) at once.
- [ ] **A tera call is a host JS call.** `interpretCall` builds a `RegisterFrame` and
      calls `interpreter.runFrame(callFrame)` — ordinary recursion in the host language.
      Establish: there is no explicit stack, no depth counter, and no engine-level limit.
      Show the observed failure: `Maximum call stack size exceeded` on stderr, exit 1, no
      tera function name and no bytecode offset.
- [ ] **What `callStack` is actually for.** It is pushed and popped on every frame, and
      the only reader is `src/debugger/runtime.ts:327` (`runtime.callStack.slice()`) for
      the debugger's stack snapshot. Establish: it is not an error-reporting mechanism,
      which is why the RangeError above carries no tera context.
- [ ] **The `default:` case.** `Unknown register opcode 0x..` naming `rOpcodeName(op)`,
      `pc - 1` and the function. Establish: the switch is not exhaustively typed; an
      opcode added to `bytecode.ts` and not to `runFrame` fails at run time, not at build
      time — an `> **Unenforced.**` invariant.

## Honesty items

- > **Never runs.** `RegisterFrame.directRegisters`
  (`src/bytecode/register/interpreter/frame.ts:82-85`). A getter with no callers anywhere
  in `src/` or `tests/`. It documents the condition the baseline compiler's bare-`r[n]`
  emission depends on, but nothing consults it and nothing checks that the baseline's
  condition and this getter's condition stay in agreement. Finishing it means either
  deleting it or routing `BaselineCompiler`'s `hasClosures` decision through it.
- > **Unenforced.** The opcode switch in `runFrame` has no exhaustiveness check. A new
  `ROP_*` constant in `src/bytecode/register/ops/bytecode.ts` compiles cleanly and throws
  `Unknown register opcode` the first time it executes. A `satisfies Record<Opcode,
  Handler>` table or a `never`-typed `default` would move this to build time.
- > **Unfinished.** `ExceptionHandlerRecord`
  (`src/bytecode/register/interpreter/frame.ts:9-14`) declares `finallyPC`, `endPC` and
  `stackDepth`. `ROP_TRY_START` only ever writes `catchPC` (`index.ts:2168-2173`) and
  `takeCatchPC` only ever reads `catchPC`. The other three fields are never written and
  never read; `finally` is lowered as a second `TryStart` instead ([Ch 27 §
  double-trystart]).
- > **Unenforced.** There is no stack-depth guard. `interpretCall` recurses in the host
  language, so recursion depth is bounded by the Node process's stack and surfaces as a
  host `RangeError` with no tera frame. A depth counter on `RegisterInterpreter` beside
  `activeFrames.length` would cost one comparison per call.

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --trace docs/example/stats.tera | grep '^\[INTERP\] mean' | head -32
node dist/cli.js --trace-feedback docs/example/stats-poly.tera | head -8
printf 'fn down(n: int) -> int:\n  if n <= 0:\n    return 0\n  return 1 + down(n - 1)\nprint(down(1000000))\n' > /tmp/deeprec.tera
node dist/cli.js --no-opt /tmp/deeprec.tera; echo "exit=$?"
npx vitest run --project unit tests/bytecode/register/interpreter.test.ts
```

## Tests that pin this

- `tests/bytecode/register/interpreter.test.ts > "sets params from args"` — parameters are
  registers `0..n`.
- `tests/bytecode/register/interpreter.test.ts > "limits param count to fn.paramCount"` —
  surplus arguments are dropped, not collected.
- `tests/bytecode/register/interpreter.test.ts > "setReg and getReg"` — the plain path.
- `tests/bytecode/register/interpreter.test.ts > "TDZ uninitialized slots throw on read"`
  and `> "TDZ slot becomes readable after setReg"` — the `hasTDZ` branch.
- `tests/bytecode/register/interpreter.test.ts > "throwIfTDZ throws on TDZ sentinel"` and
  `> "throwIfTDZ passes through normal values"`.
- `tests/bytecode/register/interpreter.test.ts > "ADD integers"`, `> "ADD doubles"`,
  `> "ADD strings"`, `> "ADD string + number coercion"`, `> "SUB overflow to double"` —
  the four `ROP_ADD` paths and the Smi range re-check.
- `tests/bytecode/register/interpreter.test.ts > "reads acc as left and register as right"`
  — `getBinaryOperands`' operand order.
- `tests/bytecode/register/interpreter.test.ts > "JUMP unconditional"`,
  `> "JUMP_IF_FALSE skips when false"`, `> "JUMP_IF_FALSE falls through when true"`,
  `> "JUMP_IF_TRUE jumps when true"`.
- `tests/bytecode/register/interpreter.test.ts > "implicit return"` — falling off the end
  returns `mkUndefined()` after `closeUpvalues()`.
- `tests/bytecode/register/interpreter.test.ts > "LDA_GLOBAL throws on undefined variable"`
  — `missingGlobalMessage`.
- No test pins the absence of a stack-depth limit, or the `default:` opcode throw.
  `[unpinned]`
