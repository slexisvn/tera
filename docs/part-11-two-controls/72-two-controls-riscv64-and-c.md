# 72. Two Controls: riscv64 and C   ⟨I · B · J · **N**⟩

> **Status:** outline

**Thesis.** The cleanest way to see which problems belong to code generation and which
belong to compilation is to read the two backends that opt out of different halves — one
that keeps the whole machine layer and cannot write a byte, and one that keeps everything
above the machine layer and has no machine layer at all.

**What arrived.** From [Ch 70 § object-files-and-self-linked-executables] and
[Ch 71 § telling-the-debugger-and-the-unwinder]: a finished x64 pipeline —
`CFGFunction` → `targetLegalizationPipeline` → `aotLegalityAnalysisId` →
`compileMachineFunction` (select, schedule, two-address, liveness, linear scan, frame,
peephole) → `assembleFunction` → an ELF or PE image with `.eh_frame`/`.pdata` and
`.debug_line`. One target, every stage exercised, nothing refused.

**What leaves.** A derived capability matrix over all four registered AOT backends
(`c`, `x64-linux`, `x64-windows`, `riscv64`), and a demonstrated split: the emit surface
is `41 / 41 / 41 / 40` opcodes, differing by exactly one — `Select`. Everything else that
looked target-specific in Part X was compilation.

**New ideas.** *Control* (in the experimental sense: a run with one variable removed);
*condition-code register* vs. *comparison-into-a-register*; *three-address vs.
two-address instruction form*; *memory operand / addressing mode*; *stack probe and guard
page*; *code unit vs. character*. Each gets a `> **New idea.**` primer at first use. Basic
blocks, SSA, phi, dominance, calling convention and relocation are all already in hand
from Parts VI and X.

**Length.** 14 pages

## Anchors

- `src/optimizing/backends/riscv64/lowering.ts` — `RiscvLowering`, and the three overrides
  that define this control: `effectOf` (lines 265-268, returns `{ latency }` or `{}` and
  never a flag), `fusedInputOf` (lines 371-373, `return null` with no parameters at all),
  `callStackProbe` (lines 430-442, `mv`/`li`/`call`/`mv` around the link register). Also
  `LATENCIES`, `INT_CONDITIONS`, `FLOAT_CONDITIONS`, `INT_BINARY`, `INT_SHIFT`,
  `INT_HELPERS`, `emitIntCondition`, `selectBranch`, `elementPlace`.
- `src/optimizing/backends/riscv64/backend.ts` — `createRiscvBackend`, `riscv64Backend`,
  `RISCV_HEADER_PREAMBLE`; the whole control is one field: `machineCode: null`.
- `src/optimizing/backends/riscv64/mc/target.ts` — `riscv64McTarget`: a complete `McTarget`
  whose `encode` throws `UnsupportedInstructionError`, imported by nothing.
- `src/optimizing/backends/riscv64/mc/fixups.ts` — `riscv64FixupModel`, the seven fixup
  kinds and their ELF relocation numbers, with `apply` throwing.
- `src/optimizing/backends/riscv64/assembly.ts` — `RiscvAssemblyWriter.operandText`
  (lines 37-42), the 12-bit stack-offset refusal.
- `src/optimizing/backends/riscv64/abi.ts` — `riscvAbi`, `savedOnCall: registers.select(["ra"])`,
  `entryStackAdjustBytes: 0`.
- `src/optimizing/backends/riscv64/target.ts` — `riscvTarget`,
  `capabilitySet("terminating-throw", "float-text")` — two capabilities, against seven.
- `src/optimizing/backends/riscv64/context.ts` — `contextAddress`, `contextField`,
  `contextWidthOf`: the whole backend's only route to the runtime context.
- `src/optimizing/backends/riscv64/heap.ts` — `riscvHeapRoutines`: ten routines, including
  `collect` and `take` and *not* `minor` or `write_barrier`.
- `src/optimizing/backends/riscv64/runtime.ts` — `riscvRuntimeRoutines`, and
  `riscvProgramEntry` (line 530), which nothing calls.
- `src/optimizing/backends/c/emit.ts` — `CFunctionEmitter` (line 1888), its
  `handlers()` table (lines 2106-2171), `emitNumericFunction` (line 2579),
  `cEmittedOpcodes` (lines 2588-2591), `cContextField`, `cClassTable`, `C_HEAP_SUPPORT`,
  `C_SOURCE_PREAMBLE`, `C_PRINT_HELPERS`, `TERA_MINOR_SYMBOL`'s body (line 1578).
- `src/optimizing/backends/c/backend.ts` — `cBackend`: `outputs: ["assembly"]`,
  `platform: null`, `emits: cEmittedOpcodes()`,
  `loweringPipeline: (options) => targetLegalizationPipeline(cTarget, options)`,
  `link` writing a `.h` and a `.c`; `CBackendEmitError`.
- `src/optimizing/backends/c/target.ts` — `cTarget`: `abi: null`, and the seven-capability
  set that makes it the most capable target in the tree.
- `src/optimizing/machine/lowering-base.ts` — `MachineLoweringBase`: the 45 abstract
  members both native backends fill in, plus the defaults that decide this chapter —
  `conditionalMove()` returning `null` (lines 148-150), `effectOf` returning
  `UNMODELLED_EFFECT` (152-154), `probeStack` (217-221) and `prologue` (223-232).
- `src/optimizing/target/runtime-layout.ts` — `declareRecord` (52-91), `TERA_CONTEXT`
  (119-148), `TERA_CLASS_RECORD`, `TERA_ROOTS`/`TERA_MARKS`/`TERA_YOUNG`/`TERA_REMEMBERED`,
  `TERA_ROOT_SLOT_SHIFT`, `TERA_MARK_FLAG`/`TERA_OLD_FLAG`/`TERA_REMEMBERED_FLAG`,
  `perThreadContextFields`, `requireContextStorage`, `contextStorageFault`.
- `src/optimizing/target/legalization.ts` — `targetLegalizationPipeline`: the 43 named
  passes both controls run (four of them gated on `tagged-values`, which no AOT target
  has), ending in `operation-legalization`, `dead-code-elimination` and `capability-check`.
- `src/optimizing/passes/operation-legalization.ts` — `legalizeOperations`, `expandSelect`,
  `EXPANSIONS`, `ValueLegality`, `illegalIn`; the two independent gates
  (`graph.emits` and the per-node `admissible` predicate).
- `src/optimizing/passes/if-conversion.ts` — `valuesTargetSelects`, which turns a scalar
  into a `select-integer`/`select-float` capability question.
- `src/optimizing/target/capabilities.ts` — `Capability`, `capabilitySet`; the ten names.
- `src/optimizing/target/model.ts` — `TargetModel`, `MachineTargetModel`,
  `isMachineTarget` (57-59): the type-level version of this chapter's split.
- `src/optimizing/machine/backend.ts` — `createNativeBackend`, `outputsOf` (295-301),
  `NativeBackendError`, and the three refusals it raises for a missing encoder, object
  container or executable container.
- `src/optimizing/machine/pipeline.ts` — `compileMachineFunction` (30-69): the eleven
  stages the C backend does not run.
- `src/optimizing/backends/x64/backend.ts` — `CONTAINERS` (40-58), with `macho: null`.
- `src/optimizing/backends/index.ts` — `createBackendRegistry`: the four AOT ids.
- `src/cli/targets.ts` — `aotBackends`, `architectures`, `emitsOf`, `linksItself`,
  `targetsReport`: the matrix, derived rather than written down.

## Worked example

`docs/example/stats.tera`, compiled unchanged for all three AOT targets, plus two
three-line variations for the beats `stats.tera` cannot reach.

```bash
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats-c   --target c       --emit source
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats-x64 --target x64     --emit source
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats-rv  --target riscv64 --emit source
```

Four artefacts come out of that, and each carries one section of this chapter:

| what | `/tmp/stats-c/stats.c` | `/tmp/stats-x64/stats.s` | `/tmp/stats-rv/stats.s` |
| --- | --- | --- | --- |
| `tera_minor` present | yes (line 386) | yes (called at 248) | **no** |
| `tera_write_barrier` mentions | 12 | 19 | **0** |
| `typedef … tera_char` | `uint16_t` | `uint16_t` | **`unsigned char`** |
| `"latency"` stored as | `uint16_t` array | `.short 0x6c, 0x61, …` | **`.asciz "latency"`** |

`tera_minor` is the chapter's centrepiece: the same algorithm, from the same table, read
side by side as C (`/tmp/stats-c/stats.c:386`, generated by `emit.ts:1578`) and as x64
assembly (`/tmp/stats-x64/stats.s`, generated by `minor()` in `backends/x64/heap.ts:597`).
`tera_context.remembered_count == 2048u` in one is `cmpq $2048, %rax` after
`movq tera_context+96(%rip), %rax` in the other — and 96 is
`TERA_CONTEXT.offsetOf("rememberedCount")`, counted by `declareRecord`.

For `Select` and the stack probe, two variations:

```bash
# a float diamond: kept by c, expanded by BOTH x64 and riscv64
node dist/cli.js compile /tmp/bookdemo/scale.tera -o /tmp/scale-x64 --target x64 --emit source
# a frame past one guard page: probed on x64, refused on riscv64
node dist/cli.js compile /tmp/bookdemo/bigframe.tera -o /tmp/big-rv --target riscv64 --emit source
```

## Outline

- [ ] **1. What a control is for.** Establish the method before the material: Part X read
  one target end to end and every stage in it looked load-bearing, because nothing was
  removed. Name the two removals — riscv64 drops the encoder and keeps the machine layer;
  c drops the machine layer and keeps everything above it — and state the test: anything
  both still do is compilation.
  `> **New idea.** Control.`

- [ ] **2. One pipeline, four targets, one missing opcode.** Establish that the shared
  surface is *measured*, not asserted. `cBackend.emits = cEmittedOpcodes()` reads the set
  off `CFunctionEmitter.prototype`; `createNativeBackend` sets
  `emits: emittedOpcodesOf(lowering)`, which is `new Set([...lowering.rules()])`. Neither
  is a hand-written list, so neither can drift from the handlers. Show the counts —
  c 41, x64 41, riscv64 40 — and the single difference, `IR_SELECT` (`= "Select"`,
  `ir/operations.ts:103`). Show `graph.emits = backend.emits` at `drivers/aot.ts:769` and
  the two readers: the legality analysis (`aot-legality.ts:1598`,
  `unsupported opcode ${node.type}`) and `legalizeOperations`.

- [ ] **3. riscv64 answers latencies, because there is nothing else to answer.**
  Establish what a scheduler needs from a target and what riscv64 can supply.
  `MachineLoweringBase.effectOf` defaults to `UNMODELLED_EFFECT`
  (`readsFlags`, `writesFlags`, `barrier` all true — schedule nothing). x64 overrides it
  with `opcodeEffectOf`, a per-mnemonic table with real flag facts. riscv64 overrides it
  with `LATENCIES.get(node.opcode)` and returns `{}` for anything else: a comparison on
  RISC-V writes a *register* (`slt`, `feq.d`), so there is no flag resource to serialise
  on. Consequence: `readResourcesOf`/`writeResourcesOf` in `machine/schedule.ts` never see
  `FLAGS` for riscv64, and the dependence graph is registers, memory and order only.
  `> **New idea.** Condition-code register.`

- [ ] **4. `fusedInputOf` returns null, unconditionally.** Establish addressing modes by
  their absence. x64's `fusedInputOf` folds a load or a scaled index into its ALU consumer
  (`foldedLoadOf`, `scaleOf`). riscv64's is `fusedInputOf(): CFGInstruction | null { return null; }`
  — it does not even take the node. Show what that costs in `elementPlace`: `slli` to
  scale, `add` to the base, then a plain `ld`/`fld`, where x64 writes one
  `movsd (%rax,%rcx,8)`. Note the *gain* recorded in the tree: three-address forms mean
  no destructive copies at all, pinned by a test that counts `flags.tied` on both targets.
  `> **New idea.** Memory operand / addressing mode.`
  `> **New idea.** Three-address vs. two-address form.`

- [ ] **5. No `Select`, so the legalizer builds a diamond — and there are two ways to
  earn one.** The chapter's sharpest worked example. `MachineLoweringBase.conditionalMove()`
  returns `null` by default; x64 overrides it, riscv64 does not, so `IR_SELECT` never
  enters riscv64's `rules()` and never enters its `emits`. Then show that
  `legalizeOperations` has *two* independent gates: `!legal.has(node.type)` (the opcode
  set — riscv64) and `admissible.get(node.type)?.(node) === false` (the capability
  predicate `valuesTargetSelects` — x64 on a *float* select, because x64 declares
  `select-integer` and not `select-float`). Land it on one 6-line program compiled three
  ways: c keeps `v3 ? (double)v2 : (double)v0`, x64 emits `jl .Lscale_2` and a join,
  riscv64 emits `blt a1, a0, .Lscale_2` and the same join. Same pass, same source, three
  answers, two different reasons. Then `expandSelect` itself: `splitBlockBefore`, two new
  blocks, `addPhi`, `connect` — a `Select` is just a phi that had not been spread out yet.

- [ ] **6. The return address is a register, so the probe has to carry it.** Establish
  guard pages and stack probes, then the ABI difference that shows through.
  `probeStack(frameSize)` in `MachineLoweringBase` fires when
  `frameSize + pointerWidthBytes > stackProbeBytes` (`STACK_GUARD_GRANULE_BYTES = 1 << 12`),
  identically on both. x64's `callStackProbe` is two instructions
  (`movl $9688, %r11d` / `call tera_probe_stack`) because `call` pushed the return address
  onto the stack, and `x64Abi` therefore has `savedOnCall: []` and
  `entryStackAdjustBytes: 8`. riscv64's is four (`mv t1, ra` / `li t2, n` /
  `call tera_probe_stack` / `mv ra, t1`) because `riscvAbi` has
  `savedOnCall: registers.select(["ra"])` and the probe runs *before* the frame that would
  hold `ra` exists. Note the second consequence in `layoutFrame`:
  `if (fn.hasCalls) for (const register of abi.savedOnCall) preserved.add(register)`.
  `> **New idea.** Guard page and stack probe.`

- [ ] **7. Byte text instead of UTF-16, and where it stops.** riscv64's capability set
  omits `utf16-text`, so `cTypedefs` in `machine/backend.ts:376-380` emits
  `typedef unsigned char tera_char;` where c and x64 emit `typedef uint16_t tera_char;`,
  and `materialize` interns `asciiData(text)` where x64 interns UTF-16 code units. Show
  the two data forms as a fixed-width byte table. Then the boundary: `storesCodeUnits`
  (`analyses/wide-text.ts:204-206`) reads the same capability, and a program that counts
  characters of non-ASCII text is refused on riscv64 alone, verbatim. Establish the
  distinction the refusal turns on.
  `> **New idea.** Code unit vs. character.`

- [ ] **8. No generational heap, and the capability nothing reads.** `riscvHeapRoutines`
  offers ten routines and neither `minor` nor `write_barrier`; `stats.tera` compiled for
  riscv64 contains `tera_collect` and no `tera_minor`, against 12 barrier mentions in the
  C output and 19 in the x64 assembly. Then the honest part: `"generational-heap"` appears
  in `src/` only in the two `capabilitySet(...)` calls that declare it. No pass, no
  analysis and no emitter reads it. The correspondence between "declares the capability"
  and "emits the barrier" is held by one e2e test and nothing else.

- [ ] **9. Why the obvious design fails.** Stage the reading a reader arrives with: *the C
  backend is the shortcut, the real backends are the x64 pair, and riscv64 is somewhere in
  between.* Then break it with three facts from the tree. (a) The C backend is the *most
  capable* target: seven capabilities to x64-windows's six and riscv64's two — it is the
  only one that selects floats. (b) All three raise byte-identical refusals for a program
  the middle end will not lower, differing only in the prefix that names them, because the
  refusal comes from the shared legality analysis and not from any backend. (c) riscv64 is
  a *complete* code generator — selection, scheduling, allocation, frames, CFI — that
  cannot produce a single byte of machine code. Capability, completeness and reach are
  three different axes, and the naive reading collapses them into one.

- [ ] **10. The C backend has no machine layer at all.** Establish what
  `compileMachineFunction` does by listing the eleven stages c never runs
  (`selectMachineFunction`, `scheduleMachineCode`, `lowerTwoAddress`, `assignPositions`,
  `computeLiveness`, `allocateRegisters`, `rewriteAllocations`, `layoutFrame`,
  `insertFrameCode`, `placeLoopHeadersAfterBodies`, `coalesceRoundTrips`,
  `peepholeMachineCode`) and what replaces them: `emitNumericFunction` walking
  `reversePostOrder(graph)` and defining one `const` per node. `cTarget.abi === null`, so
  `isMachineTarget(cTarget)` is false by construction — the type system already knows.
  Note what c does *not* delegate to the host: float text goes through `tera_f64_to_str`,
  not `printf("%f")`, because [Ch 45 § exact-float-text] fixed the rounding and libc would
  undo it.

- [ ] **11. One layout declaration keeps two collectors from drifting.** The chapter's
  invariant → enforcement → test beat. *Invariant:* every backend addresses the runtime
  context, the class records and the root/mark/young/remembered arrays at the offsets one
  file computes. *Enforcement:* `declareRecord` in `target/runtime-layout.ts` derives every
  offset by `alignUp` and throws on a duplicate field name; the C backend spells fields by
  name through `cContextField` and builds the struct in declaration order through
  `cContextType()` (which throws for a field with no declared C type); riscv64 spells them
  by offset through `contextField(base, name)`, and x64 through its own `contextField`.
  *Tests:* one per side. Show the arithmetic once — `rememberedCount` at 96, appearing as
  `tera_context+96(%rip)` in the x64 assembly for `tera_minor` — as a fixed-width offset
  table.

- [ ] **12. The matrix, derived and honest.** Close with the four registered AOT backends
  as `targetsReport()` and `target.capabilities` actually answer, not as a wish list.
  Every cell reproducible from the commands below. Name the three holes the matrix exposes:
  `CONTAINERS.macho === null` (a complete `ObjectFormat`, `operatingSystemOf`, `MACOS_SYSCALLS`
  and `sysvIo` wiring with no container writer and no registered backend);
  x64-linux without `timers` where x64-windows has them; and riscv64's `emits` column
  saying `source` because `machineCode: null` — a claim the CLI makes deliberately, pinned
  by a test whose title says so.

  | target | platform | emits | capabilities | opcodes |
  | --- | --- | --- | --- | --- |
  | `c` | any | source | float-text, generational-heap, select-float, select-integer, terminating-throw, timers, utf16-text | 41 |
  | `x64-linux` | linux/x64 | exe obj source | float-text, generational-heap, select-integer, terminating-throw, utf16-text | 41 |
  | `x64-windows` | windows/x64 | exe obj source | float-text, generational-heap, select-integer, terminating-throw, timers, utf16-text | 41 |
  | `riscv64` | linux/riscv64 | source | float-text, terminating-throw | 40 |

## Honesty items

- > **Dead.** `riscv64McTarget` — `src/optimizing/backends/riscv64/mc/target.ts:16-27`.
  A complete `McTarget` (endianness, pointer width, alignment, `formsOf`, `riscvPadding`,
  and the seven-kind `riscv64FixupModel` with real ELF relocation numbers) whose `encode`
  throws `UnsupportedInstructionError(TARGET, node.opcode)` and which no file in `src/` or
  `tests/` imports. `createRiscvBackend` passes `machineCode: null` instead. Finishing it
  means writing the RV64GC instruction encoder — every mnemonic the lowering emits, in
  R/I/S/B/U/J form — plus `riscv64FixupModel.apply`, which today throws
  `riscv64 cannot yet apply ${kind}`. The relocation table and the fixup anchors are
  already there.

- > **Never runs.** `riscvProgramEntry` — `src/optimizing/backends/riscv64/runtime.ts:530`.
  Builds `_start`: reserve the arena, call the entry, `li a7, exit`, `ecall`. Nothing
  references it, because a `NativeProgramImage` is only reachable through
  `NativeMachineCodeSupport`, and riscv64 has none. It becomes live the moment the encoder
  above exists.

- > **Never runs.** `isMachineTarget` — `src/optimizing/target/model.ts:57-59`. Exported,
  and pinned by four tests, but no code in `src/` calls it. The distinction it names — a
  target with both an ABI and a register file, versus one that only emits source — is
  instead enforced structurally, by `cBackend` not going through `createNativeBackend` at
  all.

- > **Unfinished.** `RiscvAssemblyWriter.operandText` —
  `src/optimizing/backends/riscv64/assembly.ts:37-42`. Any stack slot beyond a signed
  12-bit displacement is refused with
  `riscv64 stack offset ${offset} does not fit a 12 bit immediate` rather than materialised
  into a scratch register, the way `adjustStack` and `displaced` already do elsewhere in
  the same backend. Measured threshold: a program with 40 array locals assembles; 60 fails
  at offset 2856. **This makes the riscv64 stack probe unreachable from any compiled
  program** — the probe fires only above 4088 bytes of frame, and every such frame holds a
  slot the writer refuses first. `RiscvLowering.callStackProbe` and `probeStack` in
  `riscv64/heap.ts` are therefore exercised only by unit tests that build a frame directly.
  Finishing it is the same fix three times: route slot addresses through `displaced`.

- > **Unfinished.** `CONTAINERS.macho` — `src/optimizing/backends/x64/backend.ts:57`, `null`.
  Everything around it exists: `objectFormat("macho")` with the `__TEXT,__text` directives
  and the `_` symbol prefix, `operatingSystemOf("macho") === "macos"`,
  `hostObjectFormat("darwin")`, `X64_MACOS_SYSCALLS`, and
  `PLATFORM_IO.macho = (abi) => sysvIo(abi, MACOS_SYSCALLS)`. What is missing is a Mach-O
  object and executable writer, and a `registry.register(createX64Backend({ format: "macho" }))`
  line — `createBackendRegistry` registers only `c`, `x64-linux`, `x64-windows` and
  `riscv64`, so the `null` branch is unreachable today.

- > **Unfinished.** `sysvIo` — `src/optimizing/backends/x64/runtime.ts:490`. `PlatformIo`
  declares `now?` and `wait?` as optional; `windowsIo` supplies both, `sysvIo` supplies
  neither. `x64Target` therefore withholds `"timers"` from x64-linux, and
  `drivers/aot.ts:720-733` refuses every `await sleep(…)` with
  `sleep needs a monotonic clock and a blocking wait, which the x64-linux backend does not provide`
  — a program that compiles on Windows and not on Linux, from the same source and the same
  architecture. Finishing it is `clock_gettime` and `nanosleep` as two syscall sequences.

- > **Unenforced.** The `"generational-heap"` capability —
  `src/optimizing/target/capabilities.ts:9`, declared by `cTarget` and `x64Target`. Nothing
  in `src/` reads it. Whether a backend emits `tera_write_barrier` is decided separately,
  inside each backend's own emitter, and the two facts are correlated only by
  `tests/e2e/optimizing/aot/arena-collector.test.ts`. A backend could declare the
  capability and emit no barrier, or emit a barrier without declaring it, and only that one
  test would notice.

- > **Unenforced.** `cEmittedOpcodes` — `src/optimizing/backends/c/emit.ts:2588-2591`.
  It reads the emit surface by calling `handlers()` on
  `Object.create(CFunctionEmitter.prototype)` — an object with no fields, no `graph` and no
  `legality`. It works because `handlers()` only closes over `this` for its arrow bodies
  and reads nothing during construction. Nothing tests that property, and the first line in
  `handlers()` that touches an instance field would make `cBackend.emits` throw at module
  load. The native side has no equivalent hazard: `emittedOpcodesOf(lowering)` is given a
  real instance.

- **A name that misleads.** `emits` on `AotBackend` is a set of IR opcode names, while
  `emits` in the `tera targets` table is `emitsOf(backend)` — a list of artefact kinds
  (`exe`, `obj`, `source`) derived from `backend.outputs`. Two different things one word
  apart. Say it once, then keep the code's names.

## Verify it yourself

```bash
# 1. The matrix, as the CLI derives it
node dist/cli.js targets

# 2. The running example, three ways — same program, three collectors, two text encodings
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats-c   --target c       --emit source
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats-x64 --target x64     --emit source
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats-rv  --target riscv64 --emit source
grep -c tera_write_barrier /tmp/stats-c/stats.c /tmp/stats-x64/stats.s /tmp/stats-rv/stats.s
grep -h "typedef .* tera_char" /tmp/stats-c/stats.h /tmp/stats-x64/stats.h /tmp/stats-rv/stats.h

# 3. The missing opcode: one float diamond, three answers
mkdir -p /tmp/bookdemo && printf 'fn scale(n: int) -> float:\n  acc: float = 5.5\n  if n < 0:\n    acc = 3.25\n  return acc\n\nprint(scale(-2))\nprint(scale(2))\n' > /tmp/bookdemo/scale.tera
node dist/cli.js compile /tmp/bookdemo/scale.tera -o /tmp/scale-c       --target c       --emit source
node dist/cli.js compile /tmp/bookdemo/scale.tera -o /tmp/scale-x64     --target x64     --emit source
node dist/cli.js compile /tmp/bookdemo/scale.tera -o /tmp/scale-riscv64 --target riscv64 --emit source
grep -n "v3 ? " /tmp/scale-c/scale.c        # kept:     const double v4 = v3 ? (double)v2 : (double)v0;
grep -n "jl .Lscale_2" /tmp/scale-x64/scale.s        # expanded: x64 has no select-float
grep -n "blt a1, a0, .Lscale_2" /tmp/scale-riscv64/scale.s   # expanded: riscv64 has no Select at all

# 4. The two refusals only riscv64 raises
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.o --target riscv64 --emit obj
#   tera compile: target 'riscv64' cannot emit obj (it emits source)
printf 'c = "Hu\xe1\xba\xbf"\nprint(c.length)\n' > /tmp/bookdemo/wide.tera
node dist/cli.js compile /tmp/bookdemo/wide.tera -o /tmp/wide-rv --target riscv64 --emit source
#   tera compile: note: 'tera_program' is not in the binary, and nothing the program runs
#   calls it (riscv64 backend cannot emit: string.length counts characters, and this text
#   holds some outside ASCII, which a compiled string stores as several bytes each; print
#   it, join it, compare it or search it for a substring, or keep this part interpreted)

# 5. The same refusal from every backend, differing only in the prefix
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/ref-c  --target c       --emit source
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/ref-rv --target riscv64 --emit source
#   … (C backend cannot emit: function returns a string but its return type is not a string)
#   … (riscv64 backend cannot emit: function returns a string but its return type is not a string)

# 6. The tests behind every claim above
npx vitest run --project unit \
  tests/optimizing/backends/riscv64 \
  tests/optimizing/backends/c \
  tests/optimizing/target/legalization.test.ts \
  tests/optimizing/target/runtime-layout.test.ts \
  tests/cli/targets.test.ts
npx vitest run --project native tests/e2e/optimizing/aot/arena-collector.test.ts -t "emits the barrier"
```

## Tests that pin this

**The riscv64 machine layer** — `tests/optimizing/backends/riscv64/assembly.test.ts`:

- `"computes element addresses explicitly because there is no scaled index mode"`
- `"uses the three address forms rather than destructive copies"`
- `"emits IEEE aware float comparisons without a parity fixup"`
- `"fuses a comparison into a conditional branch"`
- `"saves and restores the return address around a call"`
- `"does not reserve a frame for a leaf function that needs no stack"`
- `"names the character type after the byte it stores a character in"`
- `"emits a C header the same shape as the other AOT backends"`
- `"emits doubles into read only data and loads them pc relative"`
- `"describes its prologue with call frame directives"`
- `"refuses an object because it has no working encoder yet"`

**The stack probe and the link register** — `tests/optimizing/machine/frame-code.test.ts`:

- `"riscv64 carries the return address across the probe call"`
- `"hands the probe routine the frame it is about to allocate"`
- `"offers a probe routine on every machine target that asks for one"`

and `tests/optimizing/target/abi.test.ts`:

- `"saves the return address itself when the function calls"`
- `"has no return address pushed by the call instruction"`

and `tests/optimizing/backends/riscv64/stack-probe.test.ts`:

- `"steps by the granule the ABI says a guard page covers"`
- `"never writes the register the caller keeps its return address in"`

**`Select` and the two gates** — `tests/optimizing/target/legalization.test.ts`, under
`"the legalization pipeline asks the target which values it can select"`:

- `"expands a float select on a target that selects only integers"`
- `"keeps an integer select on that same target"`
- `"keeps a float select on a target that selects floats too"`
- `"expands an integer select on a target that selects neither"`

and `tests/optimizing/machine/pipeline.test.ts`:

- `"compiles a select whether or not the target has a conditional move"`

and `tests/e2e/optimizing/aot/if-conversion.test.ts`:

- `"selects in one C expression instead of branching"`
- `"converts a float diamond for a target that selects floats"`
- `"moves conditionally instead of branching on x64"`

**Target independence** — `tests/optimizing/machine/pipeline.test.ts`, under
`"target independence"`:

- `"selects the same block structure for every target"`
- `"needs no destructive copies on a three address target"`

**Flags, or their absence** — `tests/optimizing/backends/x64/effects.test.ts`:

- `"treats an opcode it does not model as reading, writing and blocking"`
- `"leaves a compare as the last thing to write the flags %s reads"` *(it.each over
  `clamp` and `total`)*
- `"still folds the compare into the conditional move"`

and `tests/optimizing/backends/x64/folding.test.ts`:

- `"accumulates straight out of the array element"`
- `"refuses to fold a load that a store stands between"`

**One layout declaration** — `tests/optimizing/target/runtime-layout.test.ts`:

- `"gives every record field a naturally aligned, non-overlapping slot"`
- `"declares the same context fields in the C backend, in the same order"`
- `"sizes the C backend storage from the same declarations"`
- `"names the same class tables in the C backend"`
- `"lays each class record out at the declared stride and field offsets"`

and `tests/optimizing/backends/riscv64/context.test.ts`:

- `"names the one symbol the whole backend reaches the context through"`
- `"addresses a field at the offset the shared layout declares"`
- `"carries the declared width so the caller can pick the load"`

**The collectors, and the capability that names them** —
`tests/e2e/optimizing/aot/arena-collector.test.ts`:

- `"emits the barrier from exactly the backends that declare a generational heap"`

**The matrix** — `tests/cli/targets.test.ts`:

- `"lists one row per architecture rather than one per platform pair"`
- `"reports the artifacts a target can emit"`
- `"claims only the artifacts a half-finished encoder can really produce"`
- `"says which architectures write an executable without a C compiler"`
- `"leaves out the backends that only run just in time"`

and `tests/optimizing/target/model.test.ts`, under
`"telling a machine target from one that only emits source"`:

- `"rejects a target with no ABI at all"`
- `"accepts a target that carries both an ABI and a register file"`

**Same surface, both controls** — `tests/e2e/optimizing/aot/feature-matrix.test.ts`, under
`"AOT language surface"`: `compiles ${feature} for the ${name} backend` runs over the same
58 features for `c` and `x64-windows` with `verifyEachPass` on. riscv64 is **not** in
`BACKENDS` there — its surface is pinned only by the assembly unit tests above.
[unpinned] for riscv64 against the full feature list.

**The C emitter's refusals** — `tests/optimizing/backends/c/emit.test.ts`:

- `"bails on an unsupported opcode and names it"`
- `"declines a graph whose parameter has no declared type, saying which parameter"`
- `"gives a reason a caller can put in front of a user rather than an empty string"`
- `"emits the same source for the same graph shape twice over"`
- `"puts the runtime helpers in a preamble rather than in each function's body"`
