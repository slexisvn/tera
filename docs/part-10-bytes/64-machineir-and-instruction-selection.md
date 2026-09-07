# 64. MachineIR and instruction selection   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** A target-independent instruction list whose opcodes are strings, a twelve-step
pipeline verified after every step, and a fusion protocol that is two-sided.

**What arrived.** A `CFGFunction` in canonical phi SSA, an `AotLegality` that has already
admitted every opcode in it and assigned every value an `AotScalar` and every escaping heap
value a root slot, and the dominance analysis's reverse postorder block layout.

**What leaves.** A `MachineFunction` — blocks of `MachineInstruction`s over virtual
registers, with phis eliminated into copies, arguments marshalled to ABI locations, root
stores emitted, and stack slots reserved but not yet laid out. Chapter 65 schedules it.

**New ideas.** Instruction selection; a virtual register; an operand's *role* and its
*access width* as distinct from the register's width; a destructive (two-address)
instruction and a tied operand; a parallel copy and why phi elimination needs one; a
critical edge; a calling convention's argument locations (primer, deepened in [Ch 68
§ two-abis]); operand folding / fusion.

**Length.** 14 pages

## Anchors

- `src/optimizing/machine/ir.ts` — `MachineInstruction` (opcode string + `MachineOperand[]`
  + `InstructionFlags`), `MachineBlock`, `MachineFunction` (`createBlock`, `createVirtual`,
  `createSlot`, `createIncomingSlot`, `insertAfter`, `references`, `externals`,
  `outgoingBytes`, `hasCalls`, `roots`, `rootFrame`), `VirtualRegister`, `StackSlot`
  (`"local" | "incoming"`), `RegisterOperand`, `ImmediateOperand`, `SymbolOperand`,
  `LabelOperand`, `MemoryOperand`, `MachineAddress`, the constructors `def`/`use`/`imm`/
  `sym`/`label`/`mem`/`address`/`instruction`, `explicitOperandsOf`, `registerOperandsOf`,
  `definedOperandsOf`, `usedOperandsOf`, `copiedRegisters`, `physicalNameOf`,
  `slotOffsetOf`, `MachineDataPool.intern`.
- `src/optimizing/machine/pipeline.ts` — `compileMachineFunction`, the whole back end in
  under forty lines; `CompiledMachineFunction`; the local `verify` closure gated on
  `options.verifyEachPass` and feeding `options.machineTracer`.
- `src/optimizing/machine/select.ts` — `selectMachineFunction`, the `Selector` class
  (`run`, `planFusion`, `planTargetFusion`, `reserveRoots`, `emitRoot`, `bindPhis`,
  `bindParameters`, `registerFor`, `valueRegister`, `incoming`, `guard`, `linkBlocks`,
  `successorFor`, `edgeTarget`, `emitPhiCopies`, `emitCall`, `contextFor`), the `STRUCTURAL`
  set, `MachineSelectionError`, `emittedOpcodesOf`, `fusedConditionOf`, `fusedInputOf`.
- `src/optimizing/machine/lowering.ts` — `SelectionContext`, `SelectionFork`,
  `SelectionHandler`, `MachineLowering` (the target's whole obligation, one interface).
- `src/optimizing/machine/lowering-base.ts` — `MachineLoweringBase.rules()` (the
  opcode→handler table), `readOf`/`writeOf`, `selectReturn`, `prologue`/`epilogue`,
  `probeStack`, `call`.
- `src/optimizing/machine/verifier.ts` — `validateMachineFunction`, `MachineStage`,
  `MachineValidationError`, `validateBlockLinks`, `validateOperands`, `validateTiedForm`,
  `validateNoVirtualsRemain`, `validateReachingDefs`, `upwardExposedUses`,
  `definedVirtuals`.
- `src/optimizing/machine/parallel-copy.ts` — `sequenceParallelCopies`, `ParallelCopy`
  (43 lines, and the only cycle-breaking code in the back end).
- `src/optimizing/backends/x64/lowering.ts` — `X64Lowering.fusedInputOf`, `foldedLoadOf`,
  `foldedMemoryOf`, `heldOperand`, `selectFloatBinary`, `selectIntBinary`,
  `foldedImmediate`, `emitIntImmediate`, `selectIntAdd`, `selectScaledAdd`,
  `selectNewObject`, `fusesFlagsOf`, and the module-level `reachesWithoutCode`, `scaleOf`,
  `immediateFormOf`, `loadedScalarOf`, `isIntegerConstant`, and the tables
  `FOLDED_MEMORY_SCALARS`, `COMMUTATIVE`, `EMITS_NOTHING`, `ADDRESS_SCALES`.
- `src/optimizing/infra/dispatch.ts` — `buildDispatch`, a `Map` from key to handler; later
  entries silently overwrite earlier ones (see Honesty items).

## Worked example

`docs/example/stats.tera`, selected for x64 and printed as assembly:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-asm
```

The fusion beat uses `b.w * b.h` from
`tests/optimizing/backends/x64/folding.test.ts` — the shape where the fold must search
*all* candidate inputs, because picking the first load and then failing the adjacency test
silently gives the fold up. The soundness beat uses the same file's
`'refuses to fold a load that a store stands between'`.

## Outline

- [ ] **§ one-instruction-type** — Establish that there is no per-target opcode enum:
      `MachineInstruction` is `{opcode: string, operands: MachineOperand[], flags}` plus a
      mutable `position` and a nullable `source`. Show what that buys (a target adds
      mnemonics without touching the shared layer; `printIR`-style text falls out) and what
      it costs (a typo is a runtime `UnsupportedInstructionError` at encode time, not a type
      error). The five operand kinds — register, immediate, symbol, label, memory — and the
      fact that `MachineAddress` is base + index + scale + displacement + *slot* + *symbol*,
      i.e. it can name a frame slot or a data label that has no address yet.
- [ ] **§ role-and-width** — Establish the two-axis operand model. `RegisterOperand` carries
      a `role` (`"def" | "use"`) and a `width` **separate from** `register.width`. The
      access width may be *narrower* than the register (`sete` writes one byte into a
      four-byte virtual); it may never be wider. Name the invariant here; the verifier
      section enforces it.
- [ ] **§ tied-operands** — Establish destructive form: `flags.tied` means operand 0 is a
      `def`, operand 1 is the `use` that must end up in the same register, and operand 2 is
      the real second source. This is how a three-address IR is written for a two-address
      machine before anything knows which register that is. `explicitOperandsOf(node,
      {dropTiedSource: true})` is what the encoder calls so it sees the machine's own
      operand count.
- [ ] **§ implicit-operands** — Establish `flags.implicitFrom`, the index at which explicit
      operands stop. A call carries its target plus every caller-saved register as a `def`
      so the allocator sees the clobber; the encoder must not try to encode those. One
      number, two readers with opposite needs.
- [ ] **§ twelve-steps** — Walk `compileMachineFunction` end to end and name the twelve
      steps in order: `selectMachineFunction`, `scheduleMachineCode` [Ch 65],
      `lowerTwoAddress`, `assignPositions`, `computeLiveness`, `allocateRegisters`,
      `rewriteAllocations`, `layoutFrame`, `insertFrameCode` [Ch 68],
      `placeLoopHeadersAfterBodies`, `coalesceRoundTrips`, `peepholeMachineCode` [Ch 66].
      Establish that this function *is* the back end and that its shape — a `verify` closure
      called between every step — is the reason a broken invariant is attributed to a pass
      rather than discovered in a disassembly.
- [ ] **§ verifier-three-traps** — Invariant → enforcement → test, three times, each an
      invariant that looks true and is not. (1) A def and a use of the same virtual need not
      have the same width; only `operand.width > register.width` is an error. (2) Tied
      operands must hold the same register **by name**, not be the same object —
      `physicalNameOf(destination) !== physicalNameOf(source)`, because `rewriteAllocations`
      hands out distinct `PhysicalRegister` objects. (3) An address's base is pointer-width
      while the enclosing `MemoryOperand.width` is the *access* size; a verifier that
      compared them would reject every correct load. Plus the fourth, which is not a trap
      but the real work: `validateReachingDefs` runs a backward `solveMonotone` over
      `setLattice<VirtualRegister>` and reports every virtual live *into the entry block* as
      `"read on a path that never defines it"`.
- [ ] **§ dispatch-table** — Establish selection as a table, not a matcher.
      `buildDispatch(lowering.rules())` builds one `Map<string, SelectionHandler>`;
      `Selector.run` skips `STRUCTURAL` nodes (`IR_PARAMETER`, `IR_PHI`, `IR_CONSTANT` —
      these are bound, not emitted) and fused conditions, then dispatches. No tree matching,
      no cost model, no burg tables. Say why that is defensible when the middle end has
      already canonicalised, and where it is visibly weaker than a matcher (nothing
      contracts an add-of-multiply except the ad-hoc `fusedInputOf` hook).
- [ ] **§ phis-become-copies** — *Why the obvious design fails.* Establish that a phi cannot
      be an instruction on a machine. Show the naive fix — emit `dst := src` at the end of
      each predecessor — and the two programs that break it: a swap (`x,y = y,x` as two
      phis, where sequential copies clobber), and a critical edge (a predecessor with two
      successors feeding a block with two predecessors, where there is no block to put the
      copies in). Then the code: `edgeTarget` splits the edge *lazily*, only when the
      successor actually has phis and the predecessor actually has more than one successor,
      and caches the split block per `"pred->succ"` key so a doubled edge shares it;
      `emitPhiCopies` builds the copy set and hands it to `sequenceParallelCopies`, which
      orders the chain, detects the cycle, and mints one temporary per cycle.
- [ ] **§ parallel-copy** — Read `sequenceParallelCopies` closely; it is 43 lines and does
      the whole job. Establish the algorithm as "repeatedly emit any copy whose destination
      nothing still needs to read; when none is left and work remains, you are inside a
      cycle, so save one value to a temp and continue". Pin every behaviour to a test title.
- [ ] **§ abi-marshalling** — Establish that argument placement happens *here*, in target-
      independent code: `bindParameters` asks `argumentLocations(convention, classes)` where
      each parameter arrived and emits either a copy out of the argument register or a
      `loadIncoming` from a fresh `createIncomingSlot(location.offset, width)`;
      `emitCall` does the mirror image, records `outgoingBytes` as a running maximum, and
      pushes a `def` of every `callerSaved` register onto the call. Forward to [Ch 68] for
      what `sharedArgumentPositions` and `shadowSpaceBytes` mean.
- [ ] **§ root-stores** — Establish the seam with the collector: `reserveRoots` asks
      `rootSlotsOf(legality, values)` which values need a shadow-stack slot, allocates one
      `rootFrame` slot of `TERA_ROOT_ENTRY_BYTES` and sets `fn.hasCalls = true`; `emitRoot`
      is then called after *every* selected node, after every phi copy, and after every
      parameter bind, and does nothing unless that value has a slot. Cross-reference
      [Ch 61 § shadow-stack].
- [ ] **§ guard-fork** — Establish `SelectionContext.guard(name)`: it creates two blocks
      (`taken`, `rejoin`), links three edges, and hands the handler `enterTaken` /
      `enterRejoin`. This is how inline allocation is lowered — fast path in the *original*
      block, `ja` to the slow path, `jmp` to the rejoin. State plainly the consequence that
      chapter 65 is built on: **a machine block can contain a conditional branch that is not
      its terminator, and that branch carries no `flags.terminator`.**
- [ ] **§ fusion-two-sided** — Establish the protocol in both directions.
      `planFusion` handles flag fusion (`fusesFlagsOf`: a compare immediately before its
      sole consumer); `planTargetFusion` handles operand folding (`fusedInputOf`). In both
      cases the selector adds the producer to `fusedConditions` and **skips emitting it**,
      and records `fusionOf.set(consumer, producer)` so `isSoleUseOfTerminator` can answer.
      State the rule that a real miscompile established: **whatever `fusedInputOf` claims,
      the handler must consume — unconditionally.** Then the miscompile itself:
      `fusedInputOf` claimed a load feeding `IR_INT32_MUL`, the selector skipped it, and
      `selectIntBinary` took the *immediate* path because the other operand was a constant,
      so `ctx.registerOf(load)` minted a virtual that is read and never defined. Both halves
      of the fix: `foldedLoadOf` refuses when any input is an integer constant, and
      `selectIntBinary` only looks for an immediate when `fusedInputOf(ctx)` returned null.
      `foldedMemoryOf` now throws `"<type> was folded but is not a load"` rather than
      returning null, so the next mismatch is a loud compiler error.
- [ ] **§ adjacency-as-alias-analysis** — Establish `reachesWithoutCode(block, from, to)`:
      a load may be folded into a consumer only if every IR node strictly between them in
      the block is in `EMITS_NOTHING` (`IR_CONSTANT`, `IR_PARAMETER`, `IR_PHI`). That
      geometric adjacency test is the *entire* alias analysis at this layer — it is what
      stops a load moving across a store, and it is deliberately much stronger than
      necessary. Then the two refinements: search **all** inputs, not the first load
      (`b.w * b.h`); and non-commutative consumers may only fold `inputs.slice(1)`, with
      float compares excluded because the selector may swap their operands.
- [ ] **§ folding-measured** — *What was tried and rejected*, or rather what was kept
      without a speed claim. State the measurement honestly: folding removes an instruction
      but **wall time does not move** on any measured shape, taken one case per fresh
      process on the user's Windows machine; claim it as code quality and decode bandwidth,
      not speed. Contrast with the immediate form, which exists because
      `immediateFormOf(mnemonic)` asks the *encoder's own table* (`rmi` → three-operand,
      `mi`/`mi8` → destructive) rather than keeping a second list of mnemonics.

## Honesty items

- > **Dead.** `src/optimizing/machine/lowering-base.ts:162` registers
  `[IR_LOAD_GLOBAL, () => undefined]` in `MachineLoweringBase.rules()`, and line 184
  registers `[IR_LOAD_GLOBAL, (ctx) => this.selectCodeAddress(ctx)]` in the same array.
  `buildDispatch` builds a `Map` from those entries, so the later one wins and the no-op
  handler can never be reached. Cost of finishing: delete one line — but first confirm no
  target relies on `IR_LOAD_GLOBAL` reaching a no-op, which requires reading both backends'
  `selectCodeAddress`.
- > **Unenforced.** `validateMachineFunction` runs only when
  `CompilerOptions.verifyEachPass` is true, and `compilerOptions()` defaults it to `false`
  (`src/optimizing/options.ts`). Every invariant in § verifier-three-traps is therefore
  unchecked on a normal `tera compile`; you have to pass `--verify`. The chapter must not
  say "verified after every step" without this sentence next to it.
- > **Unenforced.** The fusion contract — "whatever `fusedInputOf` claims, the handler must
  consume" — has no checker. `foldedMemoryOf` throwing catches the case where the handler
  consumes something that is not a load; the case that actually shipped a miscompile (the
  handler consuming *nothing*) is caught only by `validateReachingDefs`, i.e. only under
  `--verify`. Cost of finishing: a per-node assertion in `Selector.run` that every value in
  `fusionOf` was read by its consumer.
- > **Unfinished.** `RiscvLowering.fusedInputOf` (`src/optimizing/backends/riscv64/
  lowering.ts:371`) returns `null` unconditionally, so no operand folding of any kind
  happens on riscv64. That is a reasonable default for a load/store machine, but the
  scaled-index and immediate folds have direct riscv equivalents (`sh2add`, `addi`) and are
  simply not written. See [Ch 72 § riscv-lowering].

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-asm
grep -n "ja \.L_fixed_text_0_alloc_0$" -A 3 /tmp/stats-asm/stats.s
node dist/cli.js compile docs/example/stats.tera --verify -o /tmp/stats.exe && /tmp/stats.exe
npx vitest run --project unit tests/optimizing/machine/verifier.test.ts
npx vitest run --project unit tests/optimizing/machine/parallel-copy.test.ts
npx vitest run --project unit tests/optimizing/backends/x64/folding.test.ts
```

## Tests that pin this

- Access width: `tests/optimizing/machine/verifier.test.ts` >
  `"accepts a sub-register view of a wider virtual"` and
  `"rejects a virtual read wider than it was created"`.
- Tied operands by name: `tests/optimizing/machine/verifier.test.ts` >
  `"accepts tied operands that name the same register through distinct objects"`,
  `"rejects tied operands that ended up in different registers"`,
  `"rejects a tied instruction that is not in destructive form"`.
- Reaching definitions: `tests/optimizing/machine/verifier.test.ts` >
  `"rejects a virtual read on a path that never defines it"`,
  `"accepts a definition that reaches the use through a predecessor"`,
  `"rejects a definition that reaches only one of two incoming paths"`.
- Structural invariants: `tests/optimizing/machine/verifier.test.ts` >
  `"rejects a successor edge with no matching predecessor edge"`,
  `"rejects a branch to a block the function does not own"`,
  `"rejects a memory operand naming a stack slot from another frame"`,
  `"rejects a virtual that survived allocation"`.
- Parallel copies: `tests/optimizing/machine/parallel-copy.test.ts` >
  `"orders a chain so no source is clobbered before it is read"`,
  `"breaks a two-register swap with a temporary"`,
  `"breaks a three-register rotation"`,
  `"fans one source out to several destinations"`,
  `"keeps a cycle that also has an entering chain correct"`,
  `"drops copies whose destination is its own source"`.
- Target independence of selection: `tests/optimizing/machine/pipeline.test.ts` >
  `"selects the same block structure for every target"`,
  `"needs no destructive copies on a three address target"`,
  `"compiles a select whether or not the target has a conditional move"`,
  `"moves incoming parameters out of the argument registers before use"`,
  `"drops blocks the dominator tree cannot reach"`.
- Operand folding: `tests/optimizing/backends/x64/folding.test.ts` >
  `"masks with the constant as an immediate rather than loading it"`,
  `"uses the wide immediate form when the constant does not fit a byte"`,
  `"accumulates straight out of the array element"`,
  `"multiplies one field by the other without loading both"`,
  `"refuses to fold a load that a store stands between"`.
- Scaled-address fusion: `tests/optimizing/backends/x64/assembly.test.ts` >
  `"folds a scaled multiply into the address the add computes"`,
  `"folds a scaled multiply with a constant into the displacement"`,
  `"leaves a scale the address mode cannot express alone"`,
  `"fuses an integer comparison into a conditional jump"`,
  `"compares against a constant without loading it into a register"`.
- Two-address lowering and the tied contract:
  `tests/optimizing/machine/linear-scan.test.ts` >
  `"copies the first source into the destination and ties the operand"`,
  `"leaves an already destructive instruction alone"`,
  `"rejects a tied instruction that is not in destructive form"`.
