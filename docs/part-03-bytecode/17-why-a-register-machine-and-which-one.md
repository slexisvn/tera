# 17. Why a register machine, and which one   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Stack versus register is the famous question and the accumulator is the third
answer; what this chapter actually settles is that the opcode set is a *contract* four
tiers must agree on, not an implementation detail of the interpreter that happens to be
reused.

**What arrived.** From [Ch 14] and [Ch 15]: an AST that has been parsed, checked, run
through `analyzeEffects`, and carries `implicitAwait` flags and `_paramInfo` / `_returnType`
type *text*. Nothing about registers exists yet.

**What leaves.** The vocabulary the next three chapters emit into: 90 `ROP_*` constants,
`RegisterInstruction` (one opcode plus an untyped `number[]`), `RegisterCompiledFunction`
(the unit of compilation and of tiering), and `register-effects.ts` — the one table that
says what each operand position *means*.

**New ideas.** bytecode and a virtual machine; stack machine vs register machine vs
accumulator machine; opcode, operand, mnemonic, disassembler; constant pool; feedback slot
(named here, spent in [Ch 33]).

**Length.** 16 pages

## Anchors

- `src/bytecode/register/ops/bytecode.ts` — the whole instruction set. 90 `export const ROP_*`
  numbered `0x01`–`0x92` (verified by count), `ROPCODE_NAMES` mapping every one of the 90
  to a mnemonic (verified: no constant is missing a name), `rOpcodeName`,
  `RegisterInstruction`, `RegisterCompiledFunction`, `CompiledFunctionIdAllocator`,
  `withCompiledFunctionIdAllocator` / `withCompiledFunctionSourceName` /
  `withCompiledFunctionModuleSpec` (three ambient wrappers), `callConstructsCoroutine`.
  Also the `disassemble()` that `--print-bytecode` prints — lines 599-657.
- `src/bytecode/register/ops/register-effects.ts` — `RegisterEffects`
  (`reads`, `writes`, `windows`, `readsFrom`, `capturesLocals`, `control`), the
  `REGISTER_EFFECTS` map (90 entries, one per declared opcode), `registerEffectsOf`,
  `controlEffectOf`, `jumpTargetOf`, `handlerTargetOf`, `forEachRegisterRead`,
  `forEachRegisterWrite`, `closureCaptures`, `closureCapturedSlots`. The six named
  shapes — `ACCUMULATOR_ONLY`, `READS_FIRST`, `READS_FIRST_TWO`, `LOADS_FIRST`,
  `MOVES_FIRST_TO_SECOND`, `READS_CALLEE_AND_ARGUMENTS`,
  `READS_CALLEE_AND_NAMED_ARGUMENTS` — are the classification the chapter tours by.
- `src/bytecode/register/compiler/index.ts` — `RegisterBytecodeCompiler`, its
  `compile(ast)` entry (line 137), and the four `Object.assign` mixin installs at
  lines 189-192. Read here only to name the producer; [Ch 18] opens it.
- `tests/bytecode/register/ops/register-effects.test.ts` — 26 tests. In a zero-comment
  tree this file *is* the operand-role specification.
- `src/cli/main.ts` — `buildEngineOptions` lines 88-92: `--print-bytecode` installs
  `options.onCompile = fn => console.log(fn.disassemble())`, gated by
  `matchesFilter` (line 44), which is a plain `name.includes(filter)` substring test.

## Worked example

`docs/example/stats.tera`, method `Series.mean` — 43 instructions, read straight through.

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
```

Header line, verbatim from that run:
`=== mean (params=0, locals=2, registers=5, constants=4) ===`.
Instruction 14 prints `JumpIfFalse r32 r3`, instruction 31 prints `Jump r4`, and
instruction 8 prints `LdaNamedProperty r4 [1] (values) r0`. There is no register 32; there
is no register 4 at instruction 31 that matters; and the trailing `r0` on instruction 8 is
feedback slot 0. The disassembler prints `r` in front of every operand it does not
specially case — see the `else { parts.push(\`r${op}\`) }` fallback at
`bytecode.ts:649`. This one screenful is the chapter's whole argument about untyped
operands.

## Outline

- [ ] **What a bytecode is, and why one exists here.** Establish: source is not executed;
      a compact intermediate form is, and it is produced once per function. Ground it in
      the header line above — `params`, `locals`, `registers`, `constants` are the four
      numbers a frame needs. `> **New idea.**` bytecode / virtual machine.
- [ ] **Three machine shapes.** Establish the actual design space before naming the
      choice: a stack machine (`push a; push b; add`), a register machine
      (`add r3, r1, r2`), and the accumulator machine this engine picked (one implicit
      destination, `Ldar`/`Star` to move in and out). Show the same `a + b` in all three.
      `> **New idea.**` accumulator.
- [ ] **Why the obvious design fails.** The reader's first instinct is a pure
      three-address register machine, and it is a defensible one. Stage it, then show what
      it costs *this* tree: every arithmetic opcode would need a third operand, and the
      baseline compiler's generated JavaScript (`src/optimizing/baseline/compiler.ts`,
      `emitOp`) would have to name a destination register in every string it builds. The
      accumulator is why `ROP_ADD` is two operands (`reg`, `feedbackSlot`) and why
      `emitOp`'s `ROP_BITAND` case is one line: `t=r[${o[0]}];acc=$.bitand(acc,t,${o[1]});`.
      Land the trade honestly: what it buys is encoding size and emitter simplicity; what
      it costs is the shuffle traffic [Ch 18] measures.
- [ ] **`RegisterInstruction`: an opcode and an untyped `number[]`.** Establish the single
      most consequential representational fact in the part —
      `constructor(opcode, ...operands)` with `operands: RegisterOperand[]` and
      `RegisterOperand = number`. Nothing in the type system distinguishes a register index
      from a constant-pool index from a feedback-slot index from a jump target. Cross to
      `[Ch 17 § the-effects-table]` for the only thing that does.
- [ ] **A tour of the 90 opcodes by family.** Not a table dump — Appendix A is the table.
      Establish the shape of the set by walking the eleven families and saying what each
      family's existence implies:
      loads/stores (`LdaConst`, `Ldar`, `Star`, `Mov`, `LdaGlobal`, `StaGlobal`);
      property and index (`LdaNamedProperty` … `LdaKeyedSlice`, `DefineClassMember`);
      arithmetic and comparison (`Add`…`Exp`, `TestEqual`…`TestGreaterThanOrEqual`,
      plus both `TestLooseEqual` and `TestEqual` — two equalities, [Ch 25]);
      control (`Jump`, `JumpIfFalse`, `JumpIfTrue`, `Return`, `Throw`, `TryStart`, `TryEnd`);
      calls (nine: `Call`, `CallMethod`, `Construct`, `CallNamed`, `CallMethodNamed`,
      `CallWithSpread`, `CallSpreadNamed`, `CallMethodSpreadNamed`, `CallIntrinsic`);
      allocation (`CreateObject`, `CreateArray`, `NewRegex`);
      closures (`LdaUpvalue`, `StaUpvalue`, `MakeClosure`, `CloseUpvalues`);
      iteration and suspension (`GetIterator`, `IterNext`, `IterDone`, `IterValue`,
      `Await`, `Yield`);
      classes (`SetPrototype`, `DefineAccessor`, `AssertClassContracts`);
      spread/rest (`RestArgs`, `SpreadArray`, `CopyProperties`, `ArrayRest`, `ObjectRest`,
      `LoadArguments`); and one opcode with no built-in meaning at all —
      `ROP_MATMUL` (`@`), whose interpreter case is
      `frame.acc = applyBinaryOverload("matmul", left, right, this)` with no numeric
      fallback (`interpreter/index.ts:1563-1571`), i.e. an operator reserved for whatever
      library defines the overload. Contrast `ROP_DIV` immediately below it, which tries
      the overload and *then* falls back to `toNumberValue(left) / toNumberValue(right)`.
- [ ] **The Ignition lineage, and four deliberate divergences.** Establish that the
      mnemonics are V8 Ignition's on purpose — `Ldar`, `Star`, `LdaNamedProperty`,
      `StaKeyedProperty`, `TestLessThan`, `Construct`, `Exp` are Ignition spellings — so a
      reader who knows V8 can read this listing, and so can a reader who then goes to read
      V8. Then the four places it diverges, each with the evidence:
      (1) an instruction is an **object**, not a byte in a stream, so there is no operand
      encoding at all — `RegisterInstruction` holds a JS array;
      (2) therefore **no `Wide`/`ExtraWide` prefixes** — verified: the string "Wide" does
      not occur in `bytecode.ts`, and there are no prefix opcodes among the 90;
      (3) therefore **no operand-size scaling** — an operand is a JS number, so a
      65 536th register and a 3rd register cost the same;
      (4) jump targets are **absolute instruction indices**, not relative offsets —
      `patchJump(instrIndex, target)` writes `operands[0] = target`
      (`bytecode.ts:595`) and the interpreter does `frame.pc = target`
      (`interpreter/index.ts:1782`), never `pc +=`. Say plainly what each divergence buys
      (a debuggable, printable, splice-able instruction list) and what it costs (no
      serialized bytecode, no on-disk code cache, and one whole class of bug — [Ch 19]).
- [ ] **`RegisterCompiledFunction` is two things at once.** Establish the dual role:
      *compilation unit* (`instructions`, `constants`, `localNames`, `localTypes`,
      `localBindingKinds`, `uninitializedLocalSlots`, `registerCount`, `paramCount`,
      `feedbackSlotCount`, `upvalues`, `sourceMap`, `declaredSignature`) and *tiering
      record* (`invocationCount`, `baselineCode`, `optimizedCode`, `osrCache`,
      `deoptCount`, `dependencyDeoptCount`, `compileFailureCount`,
      `optimizationCooldownUntil`, `lastCompileFailureReason`, `version`,
      `disableOptimization`, `optimizedDependencies`, `codeAge`, `lastExecutionTime`).
      This is why Part V has nowhere else to put its state, and why an inner function is
      a constant-pool entry rather than a separate table: a nested function must be
      independently tierable. Show `addConstant`'s asymmetry — primitives are deduplicated
      through `_constantIndex`, objects deliberately are not (so two identical inner
      functions get two slots and two tiering records).
- [ ] **Identity: `id`, and the allocator that hands it out.** Establish why compilation
      needs an ambient counter at all: `CompiledFunctionIdAllocator`,
      `withCompiledFunctionIdAllocator`, and the `static nextId` mirror in the constructor
      that keeps the class-level counter and the default allocator in step
      (`bytecode.ts:457-467`). `getICKey(name, slot)` builds `"name#id:slot"` — the string
      the inline caches of [Ch 34] are keyed by. Note the two other ambients installed by
      `compile()` for the same reason: `sourceName` and `moduleSpec`.
- [ ] **The effects table.** {#the-effects-table} Establish the chapter's real payload:
      because operands are untyped, *something* has to say which positions are registers.
      `register-effects.ts` is that something. Walk the six shapes and what each encodes —
      `READS_FIRST` for every binary operator (so the trailing feedback slot is *not* read
      as a register), `LOADS_FIRST` for `Star` (a write, never a read),
      `MOVES_FIRST_TO_SECOND` for `Mov`, `READS_CALLEE_AND_ARGUMENTS` with
      `windows: [{base:1, count:2}]` for a call's contiguous argument window,
      `readsFrom: 2` for `LdaKeyedSlice`'s variable-length index list, and
      `capturesLocals: true` for `MakeClosure`, whose captured slots must be read out of
      the *callee's* `upvalues` rather than its own operands.
- [ ] **Who actually reads the table — and who does not.** Establish this precisely,
      because it is the chapter's sharpest honesty item. Verified consumers are four files,
      all under `src/optimizing/builder/`: `ir-builder.ts` (`closureCapturedSlots`,
      `jumpTargetOf`, `handlerTargetOf`), `register-liveness.ts` (all seven exports),
      `throw-recovery.ts`, `inline.ts`. That is one shared middle end serving ⟨J⟩ and ⟨N⟩.
      The interpreter and the baseline compiler read operand positions by hand in their own
      `switch` statements and import nothing from this file.
- [ ] **The invariant tests are the design document.** Invariant → enforcement → test, three
      times over: *every declared opcode is modelled* (enforced by a runtime scan over
      `Object.entries(ops)`, not by a type); *a control target is never also a register*
      (enforced only by a test); *no opcode both reads and writes the same operand index*
      (enforced only by a test). Establish that the first is a real completeness check the
      type system cannot express, and that the other two are conventions with no runtime
      teeth.
- [ ] **The coverage matrix.** Close on measured numbers, not adjectives: 90 declared;
      89 with an interpreter `case`; 71 with a baseline `emitOp` case; 75 with an
      `ir-builder` case; 90 with a `register-effects` entry. Then the two anomalies below.

## Honesty items

- > **Dead.** `ROP_TEST_FEEDBACK` (`0x55`, mnemonic `TestFeedback`) in
  `src/bytecode/register/ops/bytecode.ts:76`. It has a name in `ROPCODE_NAMES`, an
  `ACCUMULATOR_ONLY` entry in `REGISTER_EFFECTS`, and a `case` in
  `src/optimizing/baseline/compiler.ts:384` that returns the empty string — and nothing
  anywhere emits it. Verified: no `ROP_TEST_FEEDBACK` reference exists under
  `src/bytecode/register/compiler/` or `src/optimizing/backends/`, and the interpreter has
  no `case` for it, so were one to appear it would hit the `default:` at
  `interpreter/index.ts:2449` and raise
  `Unknown register opcode 0x55 (TestFeedback)`. Cost of finishing: either delete four
  lines across two files, or decide what it was for and give it a producer.
- > **Never runs.** `ROP_MOV` (`0x04`, `Mov`). Four consumers handle it —
  `interpreter/index.ts:1430`, `baseline/compiler.ts:198`, `builder/ir-builder.ts:649`,
  `builder/inline.ts:406` — and no producer emits it. Verified: `ROP_MOV` does not occur
  anywhere under `src/bytecode/register/compiler/`. Note that `inline.ts:406` *consumes*
  `Mov` while splicing a callee's instructions; since no callee can contain one, that
  branch is unreachable too. Its `MOVES_FIRST_TO_SECOND` effect is nonetheless pinned by
  a test, which is the only reason the register/register move semantics are written down
  at all. Cost of finishing: nothing, if the intent is that [Ch 18]'s
  `Ldar r; Star r'` pair is always used instead — but then say so and delete it.
- > **Unenforced.** Nothing checks that the interpreter's hand-written operand reads agree
  with `REGISTER_EFFECTS`. `forEachRegisterRead` says `ROP_CALL` reads
  `operands[1] … operands[1]+operands[2]-1`; `interpreter/index.ts` re-derives the same
  window by hand; a change to one is not a type error in the other. The 26 tests in
  `register-effects.test.ts` pin the table against itself, never against the interpreter.
  Cost of enforcing: a differential test that runs each opcode through both and compares
  the touched-slot sets — or moving the interpreter onto the table, which is the real fix
  and a much larger one.
- > **Unfinished.** `RegisterEffects.writes` is populated for exactly two opcodes
  (`ROP_STAR` via `LOADS_FIRST`, `ROP_MOV` via `MOVES_FIRST_TO_SECOND`). Every other
  opcode that produces a value writes the accumulator, which the table does not model at
  all — there is no `writesAccumulator` field. `register-liveness.ts` therefore cannot ask
  the table about accumulator liveness and does not try. State it; do not call it a bug.

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --print-bytecode --filter report docs/example/stats.tera
node dist/cli.js --print-bytecode --filter '<script>' docs/example/stats.tera
npx vitest run --project unit tests/bytecode/register/ops/register-effects.test.ts
npx vitest run --project unit tests/bytecode/register/ops/bytecode.test.ts
```

The second command is the smallest proof that operand positions are conventions:
`report` is `return s.label()`, and it prints `CallMethod r1 r0 r0 r1` — where the
second `r0` is an argument-window base that means nothing because the third operand,
the count, is `0`.

## Tests that pin this

- `tests/bytecode/register/ops/register-effects.test.ts > "models every opcode the instruction set declares"`
  — the completeness invariant, enforced by scanning `Object.entries(ops)` at run time.
- `tests/bytecode/register/ops/register-effects.test.ts > "skips the feedback slot that trails a binary operand"`
  — `readsOf(ROP_ADD, 4, 9)` is `[4]`: the trailing operand is not a register.
- `tests/bytecode/register/ops/register-effects.test.ts > "expands the argument window of a call"`
  — `readsOf(ROP_CALL, 1, 5, 3, 0)` is `[1, 5, 6, 7]`: base plus count, not four operands.
- `tests/bytecode/register/ops/register-effects.test.ts > "expands both windows of a call with named arguments"`
- `tests/bytecode/register/ops/register-effects.test.ts > "reads every trailing index register of a keyed slice"`
  — the `readsFrom` mechanism, for the one variable-arity opcode.
- `tests/bytecode/register/ops/register-effects.test.ts > "separates the source and destination of a move"`
  — the only written-down semantics `ROP_MOV` has.
- `tests/bytecode/register/ops/register-effects.test.ts > "never reads or writes the operand that carries a control target"`
- `tests/bytecode/register/ops/register-effects.test.ts > "gives no opcode both a read and a write of the same operand"`
- `tests/bytecode/register/ops/register-effects.test.ts > "keeps the handler of a try apart from the target of a jump"`
  — why `jumpTargetOf` and `handlerTargetOf` are two functions over the same operand 0.
- `tests/bytecode/register/ops/register-effects.test.ts > "reports no effects for an opcode outside the instruction set"`
  — the table answers `null` rather than guessing.
- `tests/bytecode/register/ops/bytecode.test.ts > "deduplicates primitive constants, returns same index"`
- `tests/bytecode/register/ops/bytecode.test.ts > "does NOT deduplicate object constants (each gets new slot)"`
  — the asymmetry that gives every inner function its own tiering record.
- `tests/bytecode/register/ops/bytecode.test.ts > "generates and caches IC keys per feedback slot"`
- `tests/bytecode/register/ops/bytecode.test.ts > "produces readable output with constants, locals, and instructions"`
  — the disassembler, i.e. the format every listing in this book is quoted from.
- `tests/bytecode/register/compiler.test.ts > "returns readable disassembly string"`
