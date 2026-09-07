# 68. Frames, prologues, and two ABIs   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** One boolean flag is the entire difference between the System V and Windows
argument conventions, and there is no frame pointer anywhere in this compiler.

**What arrived.** A fully allocated `MachineFunction` — physical registers everywhere, stack
slots created but all still at offset zero, `fn.outgoingBytes` recording the widest outgoing
argument area any call site needed, `fn.hasCalls` and `fn.rootFrame` set, and an `Allocation`
naming the callee-saved registers the scan actually used.

**What leaves.** A `FrameLayout` with a final `frameSize`, every `StackSlot.offset` resolved
against the stack pointer, and prologue and epilogue instructions spliced into the entry
block and before every `ret`. Every `MemoryOperand` that names a slot now has an address
[Ch 69].

**New ideas.** A calling convention (full primer here; the sketch was in [Ch 64
§ abi-marshalling]); a stack frame; a frame pointer, and what code looks like without one;
caller-saved versus callee-saved (recalled from [Ch 66]); shadow space; stack alignment at a
call; a guard page and stack probing; the canonical frame address (forward reference to
[Ch 71]).

**Length.** 12 pages

## Anchors

- `src/optimizing/target/abi.ts` — `CallingConvention` (`argumentRegisters` keyed by
  register class, `returnRegisters`, `callerSaved`, `calleeSaved`,
  **`sharedArgumentPositions`**, `shadowSpaceBytes`, `stackArgumentSlotBytes`), `RuntimeAbi`
  (`pointerWidthBytes`, `stackAlignmentBytes`, `entryStackAdjustBytes`, `stackProbeBytes`,
  `framePointer`, `stackPointer`, `savedOnCall`), `argumentLocations`,
  `outgoingArgumentBytes`, `calleeFrameBytes`, `ArgumentLocation`,
  `STACK_GUARD_GRANULE_BYTES = 1 << 12`.
- `src/optimizing/backends/x64/abi.ts` — `x64Abi`, `SPECS` (the two rows that differ),
  `ALLOCATABLE_GPR`, `ALLOCATABLE_FPR`, `x64IntegerArgumentNames`, `x64IntegerReturnName`.
  SysV: six integer argument registers, eight float, `sharedArgumentPositions: false`,
  `shadowSpaceBytes: 0`. Win64: four integer, four float,
  `sharedArgumentPositions: true`, `shadowSpaceBytes: 32`, and ten of the sixteen `xmm`
  registers callee-saved.
- `src/optimizing/machine/frame.ts` — `layoutFrame`, `FrameLayout`, `SavedRegister`,
  `alignUp`. Sixty-eight lines, and the entire frame model.
- `src/optimizing/machine/lowering-base.ts` — `MachineLoweringBase.prologue` / `epilogue`
  and the `probeStack` threshold; the `prologue: true` flag stamped on exactly the
  frame-*establishing* instructions and not on the probe.
- `src/optimizing/machine/frame-code.ts` — `insertFrameCode`, `calledSymbolsOf` (the
  prologue's own calls are registered as externals so the linker path finds them).
- `src/optimizing/backends/x64/lowering.ts` — `X64Lowering.adjustStack` (one `subq`/`addq`,
  tied), `callStackProbe` (two instructions), `frameSlotAccess`, `enterRoots`/`leaveRoots`.
- `src/optimizing/backends/riscv64/lowering.ts` — `RiscvLowering.adjustStack` (an `addi`, or
  `li` + `add` when the delta does not fit a 12-bit immediate), `callStackProbe` (four
  instructions — see § the-riscv-two-step), `frameSlotAccess`.
- `src/optimizing/backends/riscv64/abi.ts` — `savedOnCall: registers.select(["ra"])`,
  `entryStackAdjustBytes: 0`, `sharedArgumentPositions: false`, `shadowSpaceBytes: 0`.

## Worked example

`report(s: Series) -> string` — one pointer parameter, one call, one root slot — compiled
twice from the same selector output:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-asm
node dist/cli.js compile docs/example/stats.tera --emit source --platform linux -o /tmp/sysv
sed -n '/^report:/,/^\tret/p' /tmp/sysv/stats.s
sed -n '/^report:/,/^\tret/p' /tmp/stats-asm/stats.s
```

Two columns, side by side. SysV: `subq $8, %rsp`, `.cfi_def_cfa_offset 16`, and the argument
arrives in `%rdi` (`movq %rdi, %rax`). Win64: `subq $40, %rsp`,
`.cfi_def_cfa_offset 48`, and the argument arrives in `%rcx` (`movq %rcx, %rax`). Everything
between the two — the root store, the call to `Series_label`, the root-frame unwind — is
byte-for-byte the same instruction sequence with different registers. The 40 is 32 bytes of
shadow space plus one 8-byte root-frame slot; the 8 is that same slot with no shadow space.
The frame diagram in this chapter is generated from those two slot layouts, not drawn by
hand.

For the stack probe, `stats.tera` cannot reach: no function in it builds a frame past one
4 KiB guard page. That section uses the synthetic frames in
`tests/optimizing/machine/frame-code.test.ts` and says so.

## Outline

- [ ] **§ what-a-convention-is** — Primer. A calling convention is a contract nobody can
      check: which registers carry which arguments, which register carries the result, which
      registers a callee may destroy, how the stack is aligned at the moment of the `call`,
      and who cleans up. Establish that in this compiler the contract is *data* — a
      `CallingConvention` record — and that both selection [Ch 64 § abi-marshalling] and
      frame layout read the same record.
- [ ] **§ one-boolean** — Establish the chapter's thesis in code. `argumentLocations` walks
      the parameter classes and asks, for each, which index into that class's argument
      register list to use: `sharedArgumentPositions ? position : consumed.get(classId) ?? 0`.
      With `false` (SysV) the integer and float files are counted **independently**, so
      `f(int, float, int)` puts the ints in `rdi`, `rsi` and the float in `xmm0`. With `true`
      (Win64) the *argument position itself* is the index into whichever file, so the same
      call puts them in `rcx`, `xmm1`, `r8` — and `rdx`/`xmm0`/`xmm2` go unused. That is the
      whole difference, expressed as one ternary.
- [ ] **§ shadow-space-and-outgoing** — Establish the second difference and where it lives.
      A stacked argument's offset is `shadowSpaceBytes + stacked * stackArgumentSlotBytes`,
      so on Win64 the first stacked argument is at +32. `outgoingArgumentBytes` answers zero
      only when there are no stacked arguments *and* the convention has no shadow space, so
      a Win64 caller always reserves 32 bytes even for a one-argument call.
      `Selector.emitCall` keeps `fn.outgoingBytes` as a running **maximum** across every call
      site, so one region at the bottom of the frame serves all of them and the stack
      pointer never moves between calls.
- [ ] **§ layoutFrame** — Walk the sixty-eight lines. The slot order, bottom to top:
      outgoing argument area (rounded to pointer width), then local slots each aligned to its
      own alignment, then saved registers each aligned to its class's `saveBytes` (8 for a
      GPR, 16 for an `xmm`). Establish which registers get saved: the union of
      `allocation.usedCalleeSaved`, the scratch registers `rewriteAllocations` had to use
      that happen to be callee-saved, and — if `fn.hasCalls` — everything in `abi.savedOnCall`.
- [ ] **§ the-alignment-fold** — Establish `entryStackAdjustBytes` as the single number that
      encodes "what the call instruction already pushed". On x64 it is 8 (the return
      address); on riscv64 it is 0 (the return address is in `ra`). The frame size is then
      `alignUp(cursor + entryStackAdjustBytes, stackAlignmentBytes) - entryStackAdjustBytes`
      — round the *whole* thing including what the caller pushed, then subtract it back out,
      so `%rsp` is 16-byte aligned at the next `call`. One expression, both machines, no
      per-target alignment code.
- [ ] **§ incoming-slots-rebased** — Establish the ordering constraint. `createIncomingSlot`
      is called during *selection*, long before the frame size is known, and stores the ABI
      offset (0, 8, 16… above the return address) in `offset`. `layoutFrame` finishes by
      rewriting every incoming slot to `frameSize + entryStackAdjustBytes + offset`. That is
      why `StackSlot.offset` is the one mutable field in an otherwise readonly record, and
      why `slotOffsetOf(addr)` — `displacement + slot.offset` — is read at *encode* time and
      not before.
- [ ] **§ no-frame-pointer** — *Why the obvious design fails*, inverted: the obvious design
      is a frame pointer, and this compiler does not have one. `RuntimeAbi.framePointer`
      exists (`rbp`, `s0`) and is used only to keep `rbp` out of the allocation order
      (`X64_GPR_RESERVED`). Establish what that buys: one more allocatable register, no
      push/mov/pop in every prologue, and — the reason that matters most here — an unwind
      description that never needs `DW_CFA_def_cfa_register`, because the CFA is always
      `%rsp + k` for a constant `k` that only the prologue changes [Ch 71 § one-reading].
      Establish what it costs: every stack reference is `%rsp`-relative, so nothing may
      change `%rsp` mid-function — which is exactly why the outgoing area is a maximum
      rather than a per-call push sequence, and why variable-sized stack allocation is not
      expressible at all.
- [ ] **§ savedOnCall** — Establish the asymmetry between the two machines. x64's
      `savedOnCall` is `[]`: the return address is on the stack already, put there by `call`,
      and nothing else must be preserved just because the function calls. riscv64's is
      `["ra"]`: `jal` writes the return address into a *register*, so any function that calls
      anything must spill `ra` to its own frame — which is why `report` on riscv64 opens
      `addi sp, sp, -16` / `sd ra, 8(sp)`. Show both prologues.
- [ ] **§ prologue-and-epilogue** — Establish the composition in `MachineLoweringBase`.
      `prologue(frame)` is `probeStack(frameSize)` ++ `adjustStack(-frameSize)` ++ one
      `frameSlotAccess(saved, true)` per saved register ++ `enterRoots(frame)`; `epilogue` is
      the mirror without the probe. Establish `insertFrameCode`: the epilogue is inserted
      before **every** instruction with `flags.returns`, not only the last, and the prologue
      is unshifted onto the entry block; any symbol the prologue calls is added to
      `fn.externals` so the routine gets pulled into the image [Ch 70 § closure].
- [ ] **§ prologue-flag** — Establish the single most consequential line in the pass:
      `prologue` marks `flags.prologue = true` on the frame-*establishing* instructions only
      — the stack adjust and the register saves — and deliberately **not** on the probe call
      or on `enterRoots`. Two readers depend on that: the scheduler treats a `prologue`
      instruction as a region boundary [Ch 65 § regions], and the unwind writers pattern-match
      exactly this list [Ch 71 § one-reading]. Forward the consequence: the probe is present
      in the code and absent from every unwind description, deliberately.
- [ ] **§ stack-probing** — Establish the guard page. An OS grows a thread stack by trapping
      on a guard page; a frame larger than one page can step *over* the guard and fault on
      unmapped memory instead. `probeStack` emits a probe when
      `frameSize + pointerWidthBytes > stackProbeBytes` — the `+ pointerWidthBytes` is the
      return address the `call` already pushed, so a frame one word short of a page still
      counts. `STACK_GUARD_GRANULE_BYTES` is 4096 on both machines. The probe routine itself
      is written in the target's own instructions [Ch 60] and walks down granule by granule
      touching each page and the deepest address.
- [ ] **§ the-riscv-two-step** — Establish why the two backends' probes differ in length.
      x64's is two instructions: load the size into a register, `call`. riscv64's is four:
      `mv t0, ra` / `li a?, bytes` / `call` / `mv ra, t0` — because `jal` clobbers `ra`, and
      at the moment the probe runs `ra` still holds *this* function's return address and the
      frame that would hold it has not been allocated yet. A machine detail that follows
      directly from § savedOnCall.
- [ ] **§ diagram** — A fixed-width ASCII frame diagram for `Series_mean` on Win64, offsets
      taken from the emitted assembly rather than drawn: outgoing area 0–31, root-frame slot
      at 32, `%rbx` at 40, `%xmm6` at 48, `%xmm7` at 64, `%rsi` at 80, `%rdi` at 88, `%r12`
      at 96, `%r13` at 104, frame size 120, return address at 120, incoming arguments above.

## Honesty items

- > **Unfinished.** There are **two** frame models in the tree, and only one of them is this
  chapter's. `layoutFrame` computes a compiled function's frame from its slots and never
  pushes. The hand-written runtime routines built with `MachineRoutineBuilder` —
  `src/optimizing/backends/x64/heap.ts` (three call sites) and
  `src/optimizing/backends/x64/text-overflow.ts` — use a push-based prologue and size it with
  `calleeFrameBytes(abi, savedRegisters)` from `src/optimizing/target/abi.ts`, which aligns
  `shadowSpaceBytes + (1 + savedRegisters) * pointerWidthBytes` and subtracts the pushes back
  out. The consequence is carried into [Ch 71]: `assembleRoutine` returns `prologue: []` and
  `populate` only collects compiled `parts` into the unwind list, so **no hand-written
  runtime routine has an unwind description in any format** — pinned by
  `tests/optimizing/backends/x64/assembly.test.ts` > `"leaves a routine whose prologue it
  cannot read undescribed"`. Cost of finishing: give `MachineRoutineBuilder` a
  `flags.prologue` and teach `prologueEffectOf` `pushq`, or move the runtime routines onto
  `layoutFrame`.
- > **Unenforced.** `layoutFrame` guarantees `frameSize` keeps `%rsp` aligned at a call, but
  nothing checks that the *function* never adjusts `%rsp` again. The invariant that makes
  every `%rsp`-relative slot address correct — "only the prologue and epilogue move the stack
  pointer" — is upheld by convention across two backends and asserted by no verifier.
  `validateOperands` checks a memory operand names a slot the frame owns; it cannot check
  that the slot's offset is still meaningful. Cost of finishing: a post-frame-code machine
  verifier rule that no non-`prologue` instruction defines `abi.stackPointer`.
- > **Unenforced.** `argumentLocations` is `Object.freeze`d and derived from the convention,
  but nothing checks that a target's `callerSaved` list actually contains its
  `argumentRegisters` and `returnRegisters`. If it did not, `Selector.emitCall` would not
  mark the argument registers clobbered and the allocator would keep a value in one across a
  call.
- > **Unfinished.** `RuntimeAbi.framePointer` is required by the type but is used only to
  reserve the register out of the allocation order. There is no frame-pointer mode to fall
  back to, so a target that genuinely needs one — variable-length stack allocation, `alloca`,
  a debugger that walks `rbp` chains — cannot be added without new code in `layoutFrame`,
  `frame-code.ts` and both unwind writers.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-asm
node dist/cli.js compile docs/example/stats.tera --emit source --platform linux -o /tmp/sysv
sed -n '/^report:/,/^\tret/p' /tmp/sysv/stats.s
sed -n '/^report:/,/^\tret/p' /tmp/stats-asm/stats.s
node dist/cli.js compile docs/example/stats.tera --emit source --target riscv64 -o /tmp/rv
npx vitest run --project unit tests/optimizing/machine/frame.test.ts tests/optimizing/machine/frame-code.test.ts
```

`sed -n '/^report:/,/^\tret/p' /tmp/rv/stats.s` shows the riscv64 column: `addi sp, sp, -16`
then `sd ra, 8(sp)`.

## Tests that pin this

- Slot ordering and alignment: `tests/optimizing/machine/frame.test.ts` >
  `"packs local slots above the outgoing argument area"`,
  `"aligns a slot to its own alignment"`,
  `"rounds the frame so the stack stays aligned at a call"`,
  `"gives every preserved register its own slot"`,
  `"reserves the registers the ABI says a caller must preserve itself"`,
  `"resolves incoming argument slots above the frame and the return address"`,
  `"leaves an empty leaf function without a frame"`.
- The two conventions: `tests/optimizing/backends/x64/assembly.test.ts` >
  `"reserves Win64 shadow space and no more than needed on SysV"`,
  `"keeps the stack pointer aligned for a call"`,
  `"reads the first integer argument out of the argument register"`.
- Frame alignment across every target: `tests/optimizing/machine/pipeline.test.ts` >
  `"aligns the frame so the stack pointer is aligned at a call"`,
  `"places every local slot inside the frame it reserved"`.
- Probing, run once per backend (`"x64 sysv"`, `"x64 win64"`, `"riscv64"`) —
  `tests/optimizing/machine/frame-code.test.ts` >
  `"x64 sysv leaves a frame that cannot skip the guard page unprobed"`,
  `"x64 sysv probes a frame that reaches past one guard page"`,
  `"x64 sysv probes before it lowers the stack pointer"`,
  `"riscv64 probes a frame the return address alone pushes past the page"`,
  `"x64 win64 keeps the probe out of the unwind description"`,
  `"x64 sysv keeps the frame allocation a single unwind step"`,
  `"hands the probe routine the frame it is about to allocate"`,
  `"riscv64 carries the return address across the probe call"`,
  `"x64 sysv registers every runtime routine its prologue calls"`,
  `"offers a probe routine on every machine target that asks for one"`.
- The probe routine's own behaviour: `tests/optimizing/backends/x64/stack-probe.test.ts` >
  `"reads the frame size out of the register the prologue loads it into"`, plus the
  per-ABI rows `"… walks down from the stack pointer to the frame it was asked for"`,
  `"… steps by the granule the ABI says a guard page covers"`,
  `"… touches every page it steps over and the deepest address itself"`,
  `"… never writes a register the caller passes arguments in"`.
