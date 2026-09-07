# 71. Telling the debugger and the unwinder   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** One reading of the prologue produces three different descriptions of the same
frame, and all three need addresses that do not exist until after relaxation.

**What arrived.** From [Ch 70]: a container that has said *whether* it will carry each kind
of metadata — `elf64Executable` with `carriesDebug: false` and a `PT_GNU_EH_FRAME` slot it
will fill if a `.eh_frame_hdr` section exists; `peExecutable` and both object writers with
`carriesDebug: true`, and PE with an exception data directory pointing at whatever section is
named `.pdata`. Plus, from [Ch 69], `AssembledFunction` — `entry`, `end`, `prologue`, `lines`
— and `McModule.afterLayout`, the one seam through which a producer can see final addresses.

**What leaves.** A finished x64 pipeline: `CFGFunction` → legalization → legality →
`compileMachineFunction` → `assembleFunction` → an ELF or PE image whose `.eh_frame`,
`.eh_frame_hdr`, `.pdata`/`.xdata` and `.debug_line` are all populated and all agree with the
machine code, checked by `objdump`. One target, every stage exercised, nothing refused —
which is exactly the baseline [Ch 72] removes one variable at a time from.

**New ideas.** Stack unwinding, and why a program that never throws still needs it; the
**canonical frame address** (CFA) and call frame information (full primer — the chapter's
spine); DWARF as *two* bytecodes, one for line numbers and one for frames; a DIE and an
abbreviation table; a binary-search table in a segment; DWARF register numbers as a
convention distinct from the ABI's own numbering; back-patching a reserved fixed-width field.
Fixups, relocations and `afterLayout` are already in hand from [Ch 69].

**Length.** 14 pages

## Anchors

- `src/optimizing/machine/lowering-base.ts` — `prologue` (223-232), the eight lines this whole
  chapter reads back. Note that only `establishing` — the stack adjust and the register saves
  — gets `flags.prologue = true`; `probeStack(...)` before it and `enterRoots(frame)` after it
  do not.
- `src/optimizing/mc/assembler.ts` — `assembleFunction` (66-90) collecting
  `if (node.flags.prologue === true) prologue.push(fragment)`, plus the `entry` and `end`
  anchors that give a function its length; `assembleRoutine` (129) returning `prologue: []`.
- `src/optimizing/backends/x64/unwind.ts` — `prologueEffectOf` (120-122),
  `prologueStepsOf` (124-134), `allocationEffect` (101-108), `saveEffect` (110-118),
  `x64CfiTarget` (77-86); `WIN64_REGISTER_NUMBERS` (29-46), `XMM_REGISTER_NUMBERS` (48-50),
  `DWARF_REGISTER_NUMBERS` (52-73), `DWARF_RETURN_ADDRESS = 16`, `DWARF_FIRST_XMM = 17`;
  `windowsCode` (144-172), `windowsCodesOf`, `unwindInfoBytes` (184-193), `describedSize`
  (195-199), `appendWin64Unwind` (212-250), `appendX64EhFrame` (252-264);
  `UWOP_ALLOC_LARGE`/`UWOP_ALLOC_SMALL`/`UWOP_SAVE_NONVOL`/`UWOP_SAVE_XMM128_FAR`,
  `SMALL_ALLOC_LIMIT = 128`, `RUNTIME_FUNCTION_BYTES = 12`.
- `src/optimizing/mc/dwarf/eh-frame.ts` — `PrologueEffect`, `PrologueStep`,
  `FrameDescription`, `CfiTarget`, `EhFrameTarget`; `describeSteps` (111-130) and `CfaChange`;
  `cieBytes` (67-94), `frameInstructions` (132-153), `cfiDirectives` (155-166), `fdeFragment`
  (168-181), `patchFrame` (183-195), `headerFragment` (197-205), `patchHeader` (207-224),
  `appendEhFrame` (226-251); `CIE_AUGMENTATION = [0x7a, 0x52, 0x00]` (`"zR"`),
  `DW_EH_PE_PCREL_SDATA4`, `DW_EH_PE_DATAREL_SDATA4`, `DW_CFA_ADVANCE_LOC4`,
  `DW_CFA_DEF_CFA`, `DW_CFA_DEF_CFA_OFFSET`, `DW_CFA_OFFSET`, `TABLE_ENTRY_BYTES = 8`.
- `src/optimizing/mc/dwarf/line-table.ts` — `SourceLine`, `SourceUnit`, `DebugLineTarget`,
  `PendingAdvance`; `FileTable` (90-104), `LineProgram` (106-167) with `add`, `advance`,
  `locate`, `restart`; `headerBytes` (178-195), `abbrevBytes` (197-216),
  `compileUnitBytes` (225-260), `appendDebugLine` (262-305);
  `DWARF_VERSION = 4`, `DW_LNS_FIXED_ADVANCE_PC`, `ADVANCE_BYTES = 2`,
  `ADVANCE_LIMIT = 0xffff`, `DW_TAG_COMPILE_UNIT`, `DW_LANG_C99`, `PRODUCER = "tera"`.
- `src/optimizing/mc/dwarf/leb128.ts` — `uleb128`, `sleb128`, twenty-five lines.
- `src/optimizing/machine/cfi-text.ts` — `annotateCfi` (22-39), `CfiAnnotation`, the `SILENT`
  constant, `prologueOf`, `PrologueReader`, `CFI_START`, `CFI_END`.
- `src/optimizing/machine/line-text.ts` — `SourceFiles` and its `.file` directives,
  `annotateLines` and its duplicate suppression.
- `src/optimizing/machine/backend.ts` — `describeLines` (70-78) and `populate` (176-215):
  both metadata producers are pushed onto `module.afterLayout`, and `describes` *is*
  `writer.carriesDebug`. `NativeMachineCodeSupport.unwind` (84-88) and `debugLines` (89).
- `src/optimizing/backends/x64/backend.ts` — `X64_DEBUG_LINES` (26-29), `ehFrameFor` (62-66),
  and the dispatch `unwind: format === "coff" ? appendWin64Unwind : ehFrameFor(format)` (82).
- `src/optimizing/backends/riscv64/unwind.ts` — `riscvCfiTarget` (`initialCfaOffset: 0`,
  `returnAddressAtEntry: null`), `INTEGER_ORDER`/`FLOAT_ORDER` generating DWARF numbers by
  position, and riscv64's own `prologueEffectOf` reading `addi sp, sp, -N` and `sd`/`fsd`.
- `src/optimizing/backends/x64/assembly.ts:74-91` and
  `src/optimizing/backends/riscv64/assembly.ts:62-77` — the two call sites where
  `annotateCfi` and `annotateLines` become text.
- `src/api/engine.ts:973-980` — `` `${source}\n${prelude}` ``, the concatenation behind the
  line-number defect in the honesty list.

## Worked example

`Series.mean`'s flagged prologue — a stack adjustment plus one store per callee-saved
register, five of them on SysV and seven on Win64 — read once by `prologueStepsOf` and
emitted three ways. The ELF object's FDE, read back by GNU `objdump`:

```
00000090 000000000000003c 00000094 FDE cie=00000000 pc=0000000000001e40..0000000000001fee
  DW_CFA_advance_loc4: 4 to 0000000000001e44
  DW_CFA_def_cfa_offset: 80
  DW_CFA_advance_loc4: 5 to 0000000000001e49
  DW_CFA_offset: r3 (rbx) at cfa-56
  DW_CFA_advance_loc4: 5 to 0000000000001e4e
  DW_CFA_offset: r12 (r12) at cfa-48
```

— and the machine code the deltas are measured against, `4` for `sub $0x48,%rsp` and `5` for
each `mov %rN,k(%rsp)`. The same reading of the same method, built for Win64 — a larger frame
and two more saves, because [Ch 68 § savedOnCall] gives the two ABIs different callee-saved
sets — becomes `.cfi_def_cfa_offset 128` / `.cfi_offset 3, -88` on the assembly path, and a
`UWOP_ALLOC_SMALL` plus seven save codes, written in reverse, in the PE's `.xdata`. The
instruction *between* the flagged ones — `call tera_enter_roots` at `0x1e63` — appears in none
of the three, and neither would a stack probe: neither carries `flags.prologue`.

```bash
node dist/cli.js compile docs/example/stats.tera --platform linux --emit obj -o /tmp/stats.o
objdump --dwarf=frames /tmp/stats.o | grep -A 14 "pc=$(nm /tmp/stats.o | awk '$3=="Series_mean"{print $1}')"
```

## Outline

- [ ] **§ what-unwinding-is-for** — Primer, and the motivation the reader needs before any
      byte format.
      > **New idea.** **Unwinding** is walking back up the stack from a point in a function to
      its callers, without having been prepared for it in advance. It needs, for every
      address in the program, an answer to two questions: where is my caller's stack pointer,
      and where did I put the registers I was allowed to clobber? The **canonical frame
      address** (CFA) is the fixed reference point every answer is phrased against — by
      convention on x86-64, the value `%rsp` had immediately *before* the `call` that entered
      this function.
      Establish why a language with no `try` still needs it: `gdb`'s backtrace, a profiler's
      sampling, and a crash report all unwind. Establish the shape of the problem — the
      answer changes as the prologue runs, so the description is not a fact but a *program
      over addresses*.
- [ ] **§ one-reading** — Establish the single source all three descriptions come from, and
      the flag that defines it. `MachineLoweringBase.prologue` builds `establishing` — the
      stack adjustment plus one store per saved register — and sets `flags.prologue = true` on
      exactly those, then returns `[...probeStack(...), ...establishing, ...enterRoots(frame)]`
      with the first and third groups unflagged. `assembleFunction` collects the flagged
      fragments in order into `AssembledFunction.prologue`. `prologueStepsOf` then walks that
      list through `prologueEffectOf`, which is two pattern matches: `allocationEffect` wants
      `subq $N, %rsp` with `N > 0` and slot-aligned; `saveEffect` wants a `movq`/`movups` to
      `k(%rsp)` with no index, a slot-aligned displacement, and a register the tables know.
      Establish the all-or-nothing contract: **any** instruction it cannot read makes
      `prologueStepsOf` return `null`, and the function is then described by nothing — not
      described wrongly, not described partially. Establish the two consequences the reader
      should carry: the stack probe and the root-frame call are invisible to every consumer by
      construction [Ch 68 § prologue-flag], and `assembleRoutine` hands back `prologue: []`,
      so the hand-written runtime routines are undescribed too.
- [ ] **§ three-consumers-one-closure** — Establish the plumbing, which is four lines in
      `populate`. Both producers are *appended to `module.afterLayout`* rather than run:
      `module.afterLayout.push(support.unwind(module, unwound, image))` and, inside
      `describeLines`, `module.afterLayout.push(appendDebugLine(module, target, described))`.
      Establish why the two-phase shape is forced: each producer must **reserve** its bytes
      before layout — so that the sections have sizes and the fixed point has something to
      converge on — and **fill** them after, when `fragment.address` is finally a number.
      Establish the design rule this encodes, stated once here for the whole chapter: a
      producer that needs final addresses never participates in relaxation; it writes
      fixed-width zeroes and patches them. Then the dispatch: `ehFrameFor` gives ELF
      `appendX64EhFrame` with `withHeader = image === "executable"`, coff gets
      `appendWin64Unwind` for *both* images, and `debugLines` is a plain `DebugLineTarget`
      that runs only when `writer.carriesDebug`.
- [ ] **§ cfa-steps** — Establish the abstraction that makes three formats one function.
      `describeSteps(effects, target)` turns the effect list into `CfaChange[]`: an
      `allocate` raises a running `cfaOffset` and emits `{ kind: "cfa", offset }`; a `save`
      emits `{ kind: "saved", register, slots }` where `slots = (cfaOffset - offset) /
      slotBytes` — the register's distance *below* the CFA, in slots, which is what every
      format wants and what the raw displacement is not. Establish `CfiTarget` as the five
      numbers that make it target-independent: `stackPointer`, `returnAddress`,
      `initialCfaOffset`, `returnAddressAtEntry`, `slotBytes` — and contrast x64 (CFA is
      `%rsp + 8` at entry, because `call` pushed the return address) with riscv64
      (`initialCfaOffset: 0`, `returnAddressAtEntry: null`, because `jal` leaves it in `ra`).
      Establish the three refusals, all returning `null`: an unnameable register, a register
      number above `0x3f` (which would not fit `DW_CFA_offset`'s six-bit operand), and a
      distance that is non-positive or not a whole number of slots.
- [ ] **§ debug-line-as-a-program** — Establish DWARF's line table as a bytecode, not a table.
      > **New idea.** `.debug_line` holds a program for a tiny state machine whose registers
      are (address, file, line, column, is_stmt). Running it emits one row per `DW_LNS_copy`;
      the emitted rows *are* the table. A compiler never writes rows, it writes the program
      that produces them.
      Walk `LineProgram.add`: one sequence per function, opening with an extended
      `DW_LNE_set_address` whose operand is *zeroes plus a relocation* against the function
      symbol — the only place in the line table that names a symbol — then per row a
      `locate()` that emits `set_file` / `set_column` / `advance_line` only for the fields
      that changed, an `advance()`, and a `DW_LNS_copy`; closing with an advance to
      `unit.end` and `DW_LNE_end_sequence`. Show the header `headerBytes` writes — version 4,
      `opcode_base` 13 with the twelve standard lengths, an empty directory table, and a file
      table built by `FileTable` in first-seen order. Show one decoded sequence from
      `objdump --dwarf=rawline`, five statements long.
- [ ] **§ fixed-width-advance** — Establish the single decision that shapes the whole line
      table, and its cost. DWARF's normal address advance, `DW_LNS_advance_pc`, takes a ULEB128
      operand — variable width. A variable-width operand cannot be back-patched, because
      writing a larger number would move every byte after it, which would move every address,
      which would change the numbers. So `advance()` emits `DW_LNS_FIXED_ADVANCE_PC` (opcode
      9), reserves exactly `ADVANCE_BYTES = 2`, and records a `PendingAdvance { at, from, to }`;
      the returned thunk writes `to.address - from.address` into that slot after layout.
      Establish the price, and quote it: a delta above `ADVANCE_LIMIT = 0xffff` throws
      `RangeError("debug line advance of N bytes does not fit")` — so a single function
      containing 64KB of code between two statement boundaries fails the *build*, not the
      debugger. Establish that the same reservation trick appears three more times in this
      chapter (`DW_AT_high_pc`, `advance_loc4`, the `.eh_frame_hdr` table) and that this is
      the first and clearest instance.
- [ ] **§ one-die** — Establish the minimum viable `.debug_info`. `abbrevBytes` declares
      exactly one abbreviation: a `DW_TAG_compile_unit` with `DW_CHILDREN_no` and seven
      attributes — producer (`"tera"`), language (`DW_LANG_C99`), name, comp_dir (empty),
      low_pc, high_pc, stmt_list. `compileUnitBytes` emits one instance of it: `low_pc` a
      relocation against the first function's symbol, `high_pc` a `DW_FORM_data8` **length**
      patched after layout as `last.end.address - first.entry.address`, `stmt_list` a section
      offset that is always 0 because there is only ever one unit. Establish what this buys
      and what it does not: `objdump --dwarf=decodedline` and `addr2line` work, because they
      need the CU to find the line program; `gdb`'s `info functions`, breakpoints by name,
      parameter values and types do not, because there are no `DW_TAG_subprogram` children
      and no type DIEs at all. Establish the structural assumption in `high_pc`: it is a
      *span*, so it silently requires every described function to be contiguous in one
      `.text`, which `assembleFunction` happens to guarantee and nothing checks.
- [ ] **§ eh-frame-cie-and-fde** — Establish `.eh_frame`'s two record kinds and the one CIE
      this compiler ever writes. The **CIE** (`cieBytes`) carries version 1, the augmentation
      string `"zR"` — `z` meaning "augmentation data follows, with a length", `R` meaning
      "that data is one byte giving the pointer encoding" — a code alignment factor of 1, a
      data alignment factor of `-slotBytes`, the return-address column, and then
      `DW_EH_PE_pcrel|sdata4` as the encoding of every FDE's `pc_begin`. Its initial
      instructions are the frame at entry: `DW_CFA_def_cfa rsp, 8` plus, on x64,
      `DW_CFA_offset r16 at cfa-8` for the return address `call` pushed. Then the **FDE**
      (`fdeFragment`): a fixed head of four zeroed words plus one augmentation-length byte,
      followed by one `DW_CFA_advance_loc4` — a *four-byte* delta, again chosen for
      patchability — per CFA change. `patchFrame` fills all of it after layout: the
      back-pointer to the CIE as `record.address + 4 - cie.address`, the range length, and
      each delta measured to `step.fragment.address + step.fragment.size` — the address
      *after* the instruction takes effect, which is the only reading of "when did the frame
      change" that is correct. Establish the fixup: `pc_begin` uses `X64_FIELD_RELATIVE_32`,
      because a pc-relative FDE pointer is measured from the field, not from an instruction
      end [Ch 69 § fixups].
- [ ] **§ eh-frame-hdr** — Establish the search structure and where it lives. `headerFragment`
      reserves four encoding bytes plus two words plus eight bytes per frame; `patchHeader`
      fills in the pointer to the CIE, the frame count, and a table of
      `(function start, FDE address)` pairs, **sorted by function address**, each stored
      relative to the header's own address (`DW_EH_PE_datarel|sdata4`). Establish why: an
      unwinder given a program counter has to find the right FDE among hundreds, and a sorted
      table gives it a binary search instead of a scan through variable-length records.
      Establish the wiring — `appendEhFrame` creates the section only when
      `withHeader` is true, i.e. for executables; [Ch 70 § pt-gnu-eh-frame] then finds it by
      name and emits the extra program header. Close the loop the two chapters share: this is
      the only metadata an ELF executable with no section table can still expose.
- [ ] **§ pdata-and-xdata** — Cross to Windows, and establish that it solves the same problem
      with the opposite shape. `.pdata` is a flat array of 12-byte `RUNTIME_FUNCTION` records
      — start RVA, end RVA, unwind-info RVA — which `appendWin64Unwind` emits as a
      `bytesFragment` of zeroes with **three image-relative fixups**, one per field; the array
      is found through the exception data directory [Ch 70 § mz-to-data-directories] and is
      required to be sorted, which it is because functions are assembled in order. `.xdata`
      holds one `UNWIND_INFO` per function: version, prologue size, code count, and the codes
      themselves. Establish the three surprises in `unwindInfoBytes`. (1) The codes are
      **emitted in reverse** — `[...codes].reverse()` — because the runtime replays them from
      the end of the prologue backwards. (2) Each code's `offset` byte is the offset of the
      *end* of its instruction, computed in the `afterLayout` thunk, and `prologueSize` is the
      maximum of those. (3) The record's size must be reserved before any of that is known, so
      `describedSize` computes it from the code shapes alone and pads the slot count to an even
      number. Then the encoding itself: `UWOP_ALLOC_SMALL` for a frame up to
      `SMALL_ALLOC_LIMIT = 128` bytes with `slots - 1` packed into the four info bits,
      `UWOP_ALLOC_LARGE` with a following word otherwise, `UWOP_SAVE_NONVOL` with a slot index,
      and `UWOP_SAVE_XMM128_FAR` with a two-word byte offset for vector saves.
- [ ] **§ two-tables-that-disagree** — Establish the trap, with a fixed-width table. x64 has
      two register numberings and this file holds both. They agree on `rax` 0 and `rbx` 3 and
      disagree everywhere in between and after:

      ```
      register   Win64   DWARF        register   Win64   DWARF
      --------   -----   -----        --------   -----   -----
      rax            0       0        rdi            7       5
      rcx            1       2        r8..r15     8..15   8..15
      rdx            2       1        ret addr       -      16
      rbx            3       3        xmm0           0      17
      rsp            4       7        xmm1           1      18
      rbp            5       6        ...
      rsi            6       4        xmm15         15      32
      ```

      Establish the three separate hazards this creates: the vector file restarts at 0 in
      Win64 and continues at `DWARF_FIRST_XMM = 17` in DWARF, so the same `xmm6` is `6` in
      `.xdata` and `23` in `.eh_frame`; the return address has a DWARF column (16) and no
      Win64 number at all; and `saveEffect` accepts a register found in *either* table, so a
      register nameable to one consumer and not the other would be admitted by the reader and
      rejected by `windowsCode`, which returns `null` and drops the whole function's
      description. Establish that nothing derives one table from the other and nothing checks
      that they cover the same register set — the honesty item below.
- [ ] **§ cfi-directives** — Establish the third consumer, which writes no bytes at all.
      `annotateCfi(fn, target, read)` collects the flagged instructions straight out of the
      `MachineFunction` (not out of an `AssembledFunction`, because there is none on this
      path), reads them with the same `prologueEffectOf`, runs the same `describeSteps` through
      `cfiDirectives`, and returns a map from instruction to the directive lines that follow
      it. Establish the identical all-or-nothing behaviour via the `SILENT` constant: no
      prologue, an unreadable instruction, or an undescribable step, and the function gets no
      `.cfi_startproc` either — the writer then emits a balanced zero. Show the two directives
      it can produce, `.cfi_def_cfa_offset N` and `.cfi_offset reg, -slots*slotBytes`, and
      point out that the *assembler* builds `.eh_frame` from them, so this path outsources the
      byte format entirely. Establish why that matters for [Ch 72]: riscv64 has no machine
      code encoder, so `.cfi_*` is the only frame description it can produce — and it produces
      a correct one, `.cfi_offset 1, -8` for the saved `ra`, from the same shared code.
      Pair it with `annotateLines`, twenty lines that emit `.file N "path"` once and `.loc N
      line column` whenever the position changes.
- [ ] **§ telling-the-debugger** — Close with the honest matrix, because "which output carries
      which" is a question this chapter has been generating answers to for fourteen pages.

      ```
      output                  .eh_frame  .eh_frame_hdr  .pdata/.xdata  .debug_*  .cfi_*/.loc
      ---------------------   ---------  -------------  -------------  --------  -----------
      x64 ELF object              yes          no             no          yes         no
      x64 ELF executable          yes         yes             no          NO          no
      x64 COFF object              no          no            yes          yes         no
      x64 PE executable            no          no            yes          yes         no
      x64 assembly (.s)            no          no             no           no        yes
      riscv64 assembly (.s)        no          no             no           no        yes
      C source                     no          no             no           no         no
      ```

      Establish the one entry that surprises: the ELF *executable* is the only container that
      loses debug information, and it loses it to [Ch 70 § an-executable-with-no-section-table]
      — no section header table means nothing can find a `.debug_line`, so `carriesDebug` is
      `false` and `appendDebugLine` is never called. Verify it in one line
      (`grep .debug_line` over the image finds nothing) and state the cost of fixing it: a
      section header table in `writeElf64Executable`, which is [Ch 82]'s entry. Establish the
      second surprise for completeness: the C backend emits no `#line` directives, so a
      program compiled through `--target c` has no source-level debugging at any point.

## Honesty items

- > **Unfinished.** `appendDebugLine` describes functions and nothing else. `abbrevBytes`
  declares a single `DW_TAG_compile_unit` abbreviation with no children, so `.debug_info`
  contains no `DW_TAG_subprogram`, no parameters, no locals and no types. `addr2line` works;
  `gdb` can set a breakpoint by file and line and cannot name a frame, print a parameter, or
  see a type. Cost of finishing: a subprogram DIE per `SourceUnit` (the data is already in
  hand — `symbol`, `entry`, `end`), then a type encoding for `AotScalar`.
- > **Broken.** Line numbers on prelude-generated code name the user's file at lines the user's
  file does not have. `Engine.compileAotModule` compiles `` `${source}\n${prelude}` ``
  (`src/api/engine.ts:975-977`), so the `.to_fixed` prelude's functions carry positions in the
  *concatenated* text under the entry module's name. For `stats.tera` — twenty-five lines —
  `objdump --dwarf=decodedline` reports a row at `stats.tera:204`, inside `_fixed_text`.
  Nothing is wrong in `line-table.ts`; the position it is handed is already wrong. Cost of
  fixing: give each prelude its own source name and let `FileTable` intern more than one.
- > **Unenforced.** `WIN64_REGISTER_NUMBERS` and `DWARF_REGISTER_NUMBERS` are two hand-written
  maps over the same sixteen general registers, and nothing derives, cross-checks or even
  compares their key sets. `saveEffect` admits a register present in *either*, so a divergence
  shows up as `windowsCode` returning `null` and one function silently losing its unwind
  record — not as an error. Cost: one test asserting the two key sets are equal, plus a
  decision about `rip`, which only DWARF numbers.
- > **Unenforced.** `layoutModule`'s fixed point runs before `afterLayout`, so every producer
  in this chapter must reserve a fixed-size field and patch it. Nothing checks that a
  producer's reserved size matches what it later writes: `describedSize` and
  `unwindInfoBytes` compute the `.xdata` record's length independently, and `appendWin64Unwind`
  copies with `bytes[at] ?? 0` — silently truncating if the second ever exceeds the first.
  Same shape in `headerFragment`/`patchHeader`. Cost: an assertion at each patch site.
- > **Unfinished.** `ADVANCE_LIMIT = 0xffff`. Choosing `DW_LNS_fixed_advance_pc` to make
  back-patching possible caps the distance between consecutive described statements at 64KB,
  and exceeding it throws `RangeError` out of an `afterLayout` thunk — a build failure with no
  file, function or line in the message. Cost of finishing: emit a `DW_LNE_set_address` to
  restart the sequence when the delta would overflow.
- > **Never runs.** `appendWin64Unwind` is registered as `NativeMachineCodeSupport["unwind"]`,
  whose signature is `(module, functions, image)`, but it declares only two parameters and
  ignores the third. The `image` distinction that `appendX64EhFrame` uses to decide whether to
  emit an `.eh_frame_hdr` therefore has no COFF counterpart, correctly — but the unused third
  argument is invisible at the call site, and TypeScript accepts it silently.
- > **Unfinished.** Hand-written runtime routines carry no frame description on any path:
  `assembleRoutine` returns `prologue: []` (`mc/assembler.ts:129`) and `annotateCfi` answers
  `SILENT` for them. A backtrace taken inside `tera_alloc` or `tera_collect` — which is where a
  crash is most likely — stops at the routine. Cost of finishing: flag the routines' own
  prologues, which means `MachineRoutineBuilder` growing a notion of one.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --platform linux --emit obj -o /tmp/stats.o
objdump --dwarf=frames /tmp/stats.o | grep -A 14 "pc=$(nm /tmp/stats.o | awk '$3=="Series_mean"{print $1}')"
objdump --dwarf=rawline /tmp/stats.o | head -45
node dist/cli.js compile docs/example/stats.tera --platform linux -o /tmp/stats.elf && readelf -lW /tmp/stats.elf | grep GNU_EH_FRAME
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && objdump -x /tmp/stats.exe | grep -A 4 "Function Table"
npx vitest run --project full tests/e2e/optimizing/x64/native-unwind.test.ts
```

The `--dwarf=frames` line prints the FDE in § worked-example; `--dwarf=rawline` prints the
line-number program with its `Advance PC by fixed size amount` operands, which is
§ fixed-width-advance made visible. `readelf -lW | grep GNU_EH_FRAME` is the whole of
§ eh-frame-hdr's payoff on a file with no sections at all. To see the third description, add
`node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/statssrc` and
`grep -n "cfi_" /tmp/statssrc/stats.s`. Everything using `objdump` needs binutils on `PATH`;
without it `--project full` skips the `itDumpsObjects` and `itReadsElf` cases and the
descriptions go unchecked against any third party.

## Tests that pin this

- Reading the prologue: `tests/optimizing/machine/cfi-text.test.ts` >
  `"reads a callee-saved integer register out of a movq"`,
  `"reads a vector register out of the movups that spills it"`,
  `"names no effect for a vector spill that is not made through the stack pointer"`,
  `"names no effect for a store the prologue does not make"`,
  `"names no effect for a spill that is not slot aligned"`,
  `"describes each prologue instruction it can read"`,
  `"says nothing about an instruction outside the prologue"`,
  `"describes nothing when the function has no prologue"`,
  `"describes nothing when one prologue instruction cannot be read"`.
- The probe's absence, which § one-reading turns on:
  `tests/optimizing/machine/frame-code.test.ts` > the parametrised
  `"${name} keeps the probe out of the unwind description"` and
  `"${name} keeps the frame allocation a single unwind step"`, alongside
  `"${name} probes before it lowers the stack pointer"`.
- CFA arithmetic: `tests/optimizing/mc/dwarf/eh-frame.test.ts` >
  `"counts the return address pushed by a call into the x64 frame"`,
  `"places a saved register below the canonical frame address"`,
  `"keeps the return address in a register on riscv"`,
  `"numbers riscv float registers above the integer file"`,
  `"measures every save against the frame the prologue has built so far"`,
  `"names a vector register the prologue saved"`,
  `"refuses a register it cannot name"`,
  `"prints one directive per prologue instruction"`,
  `"answers nothing when a step cannot be described"`, plus
  `"encodes unsigned values in seven-bit digits"` and
  `"encodes signed values with a sign-extended final digit"` for `leb128.ts`.
- The line table: `tests/optimizing/mc/dwarf/line-table.test.ts` >
  `"writes no section when nothing carries a position"`,
  `"agrees with its own unit and header length fields"`,
  `"ends every function with its own sequence"`,
  `"relocates the start of each sequence against the function it describes"`,
  `"advances by the distance the code actually took"`,
  `"describes the whole program in one compile unit"`,
  `"keeps its sections out of anything the loader maps"`.
- `.eh_frame` in a real image: `tests/optimizing/backends/x64/eh-frame.test.ts` >
  `"opens with the canonical version 1 augmented cie"`,
  `"describes every compiled function with an fde that points back at the cie"`,
  `"relocates each fde onto the function it describes"`,
  `"advances the frame address in step with the prologue it describes"`,
  `"hands the unwinder a searchable header segment"`,
  `"sorts the search table and lands every row inside the frames it indexes"`.
- Win64 tables: `tests/optimizing/backends/x64/unwind.test.ts` >
  `"points the exception directory at a non-empty .pdata"`,
  `"describes each function with a version 1 unwind record"`; and
  `tests/e2e/optimizing/x64/windows-object.test.ts` >
  `"carries an unwind record for every function it emits"`.
- A third party agreeing with all of it:
  `tests/e2e/optimizing/x64/native-unwind.test.ts` >
  `"decodes our .eh_frame into the prologue we emitted"`,
  `"agrees with the machine code about where a register was saved"`,
  `"hands the executable a GNU_EH_FRAME segment"`,
  `"emits call frame directives the assembler accepts"`.
- Line information surviving into each container:
  `tests/optimizing/backends/x64/debug-lines.test.ts` >
  `"names the file once and marks the line of each statement"`,
  `"marks no line when the program was never given a file name"`,
  `"repeats a mark only when the line changes"`,
  `"decodes back to the statements it came from"`, the parametrised
  `"names the same lines from %s"` over a coff object, an elf object and a pe executable,
  `"still runs the executable it described"`, and — the matrix's one **no** —
  `"leaves an elf executable alone, since it carries no section table"`.
- The assembly path on both targets:
  `tests/optimizing/backends/x64/assembly.test.ts` >
  `"describes its prologue with call frame directives"`,
  `"leaves a routine whose prologue it cannot read undescribed"`; and
  `tests/optimizing/backends/riscv64/assembly.test.ts` >
  `"describes its prologue with call frame directives"`,
  `"balances every opened frame description"`.
- The prelude line-number defect is pinned by nothing. [unpinned]
