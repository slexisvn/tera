# 69. The assembler   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** Fragments, symbols, fixups and a relaxation loop that terminates because
encodings only ever grow — plus an encoder validated byte for byte against GNU as.

**What arrived.** A `MachineFunction` whose every operand holds a physical register or a
resolved-relative stack slot, with prologue and epilogue in place, plus a
`MachineDataPool` of interned constants and the module's heap tables.

**What leaves.** An `McModule`: sections of fragments with final addresses, a symbol table,
patched bytes where a fixup could be resolved and a `McRelocation` where it could not, and
`module.afterLayout` callbacks already run. [Ch 70] wraps that in a container.

**New ideas.** Assembly, and why it is a separate stage from selection; a fragment; a symbol
and its binding; a fixup and a relocation (full primer — the distinction is the chapter's
hinge); branch relaxation and a monotone fixed point; instruction encoding, opcode bytes,
prefixes, ModRM and SIB; sign extension and why a byte immediate is a different opcode.

**Length.** 14 pages

## Anchors

- `src/optimizing/mc/fragment.ts` — the three fragment kinds: `McBytesFragment` (fixed
  bytes + fixups), `McInstructionFragment` (a `MachineInstruction`, a `form` index, and the
  bytes that form currently encodes to), `McAlignFragment` (zero-size until layout);
  `bytesFragment`, `instructionFragment`, `alignFragment`, `paddingFor`, `fixupsOf`,
  `writableBytesOf`.
- `src/optimizing/mc/section.ts` — `McSection` (`kind`, `permissions`, `alignment`,
  `padding`, `add`, `require`, `size`, `contents`), `SectionKind`
  (`text`/`rodata`/`data`/`bss`/`debug`), `isLoadable`, `zeroPadding`,
  `assignFragmentAddresses`, `fragmentOwners`.
- `src/optimizing/mc/symbol.ts` — `McSymbolTable` (`reference`, `define`, `lookup`,
  `addressOf`), `McSymbol`, `SymbolBinding`, `SymbolKind`, `UndefinedSymbolError`. Note that
  a symbol is defined at a **fragment**, so its address is whatever that fragment's address
  turns out to be.
- `src/optimizing/mc/assembler.ts` — `assembleFunction`, `assembleRoutine`, `assembleData`,
  `AssembledFunction` (`section`, `entry`, `end`, `prologue`, `lines`, `instructions`),
  `anchor` (a zero-length `bytesFragment([])` — the trick that makes "the address just here"
  nameable), `place`, `locate`, `sectionFor`, `isUninitialized`, the section-name constants.
- `src/optimizing/mc/fixup.ts` — `FixupKind` (a string), `FixupAnchor`
  (`absolute` | `imageRelative` | `fieldRelative` | `instructionStart` | `instructionEnd`),
  `McFixup`, `FixupModel`, `relocationTypeOf`, `fixup`, `encoded`, `EncodedInstruction`.
- `src/optimizing/mc/layout.ts` — `layoutModule`, `assignAddresses`, `relaxPass`,
  `relaxFragment`, `applyFixups`, **`bindsAtLayout`**, `fixupValue`, `anchorBias`,
  `LayoutMode` (`"image" | "object"`), `LayoutResult` (`passes`, `relaxations`, `size`).
- `src/optimizing/mc/module.ts` — `McModule.section`, `nonEmptySections`, `symbols`,
  `relocations`, **`afterLayout`**, `relocationsBySection`.
- `src/optimizing/backends/x64/mc/opcodes.ts` — `OpcodeGroup` and its thirteen form slots
  (`rm`, `mr`, `mi`, `mi8`, `m1`, `ai`, `m`, `mc`, `o`, `oi`, `rmi`, `rmi8`, `none`, plus
  `branch`), `OpcodeForm` (`bytes`, `mandatory`, `rexW`, `extension`, `immediateBytes`),
  `BranchForm`, `WIDTHS`, `sized`, `put`, `addArithmetic`/`addShifts`/`addUnary`/`addMoves`/
  `addSse`/`addControl`, `opcodeGroup(mnemonic, signature)`, `conditionCodeOf`,
  `CONDITION_CODES`.
- `src/optimizing/backends/x64/mc/encoding.ts` — `emitPrefixes`, `extensionBits`,
  `forcesRex`, `emitModRm`, `modrm`, `sib`, `scaleBits`, `emitImmediate`, `emitAbsolute`,
  `rmRegister`, `RmOperand`, the `REX_*` constants.
- `src/optimizing/backends/x64/mc/target.ts` — `x64McTarget`, `encodeInstruction`,
  `encodeBinary`, `encodeImmediate`, `encodeBranch`, `signatureOf`, `rmOf`, `physicalOf`,
  `requireForm`, `branchFormsOf`, `branchTargetOf`, `emitForm`.
- `src/optimizing/backends/x64/mc/padding.ts` — `x64Padding` and the `NOPS` table.
- `tests/helpers/gnu-assembler.ts` — `gnuToolchain`, `detect`, `itAssembles`,
  `assembleText`, `hex`, `extractSection`, `linkAndRun`, `decodedLinesOf`,
  `decodedLinesOfImage`, `inspectElf`, `inspectPe`, `dumpObject`, `itReadsElf`,
  `itDumpsObjects`.

## Worked example

`imull $3, %esi, %eax`. tera's first encoder emitted six bytes — `69 c6 03 00 00 00`, the
`rmi` form with a 32-bit immediate. GNU as emits three — `6b c6 03`, the `rmi8` form, which
sign-extends a byte. Nothing was *wrong*; the differential harness simply refused to call
that agreement. The `rmi8` slot was added to the `imull`/`imulq` entries and
`encodeInstruction` now prefers it whenever `fitsSigned(value, 8)`.

```bash
npx vitest run --project full tests/optimizing/backends/x64/mc/encoding.test.ts
```

That run also assembles the whole body of every hand-written runtime routine — `tera_alloc`,
`tera_enter_roots`, the string and float printers — and compares it with gas byte for byte,
zeroing out the bytes a relocation covers.

## Outline

- [ ] **§ why-a-separate-stage** — Establish the boundary. Selection produced instructions
      whose operands are registers, immediates, **labels** and **symbols**; none of those is
      a number yet. The assembler's job is exactly to turn "the address of `.L3`" into a
      displacement, and it cannot do that until every instruction's size is settled — which
      depends on the displacements. That circularity is the chapter.
- [ ] **§ three-fragments** — Establish the fragment as the unit of address assignment.
      *Bytes*: fixed content and fixups, used for data, DWARF records, unwind records, and —
      at zero length — as an **anchor** whose only job is to name a position. *Instruction*:
      carries the `MachineInstruction` itself plus a `form` index, and can be re-encoded.
      *Align*: size zero until layout, then `paddingFor(address, alignment)`. Establish that
      only the align fragment's size changes at address assignment and only the instruction
      fragment's size changes at relaxation.
- [ ] **§ sections-and-symbols** — Establish `McSection` as an ordered fragment list with a
      kind that fixes its permissions, and `McSymbolTable` as a name→fragment map where
      `reference` creates an undefined entry and `define` fills it in. Show `assembleFunction`
      using anchors three ways: `entry` before the first instruction, one per block label so
      a branch can name it, and `end` after the last — the last two are what [Ch 71] measures
      function length with. Show `assembleData` choosing `.rodata` / `.data` / `.bss` from
      `writable` and "is every item a zero run".
- [ ] **§ fixups** — Primer, and the chapter's hinge. A **fixup** is a note the encoder leaves
      behind: "the four bytes at offset 4 of this instruction should hold the distance to
      symbol `S`". A **relocation** is the same note written into the output file for someone
      else to apply. Whether a fixup becomes a patched number or a relocation is decided by
      one function. Establish the five anchors and what each measures from: `absolute` (the
      symbol's address), `imageRelative` (minus the image base), `fieldRelative` (minus the
      address of the fixup field itself — added for DWARF FDEs, which measure `pc_begin` from
      the field), `instructionStart` and `instructionEnd` (x86's PC-relative displacements are
      measured from the end of the instruction).
- [ ] **§ bindsAtLayout** — Establish the object-versus-image split as a single predicate.
      `bindsAtLayout(entry, fragment, module, owners, mode)`: an undefined symbol never binds;
      in `"image"` mode every defined symbol binds, because there is no linker and no one else
      to fix it up; in `"object"` mode only a **local** symbol defined in the **same section**
      binds, because a linker may move sections relative to each other and may replace a
      global. Everything else becomes a `McRelocation` — with `addend - anchorBias(...)`, so
      the relocation records the value measured from the field rather than from the
      instruction end that x86's encoding implies.
- [ ] **§ relaxation** — Establish the fixed point. `layoutModule` assigns addresses, runs a
      relax pass, and repeats until a pass widens nothing; then it runs `afterLayout` and
      applies fixups. `relaxFragment` steps `form` upward while any fixup either does not
      bind at layout or binds to a value that does not fit, re-encoding at each step.
      Establish termination: `form` only ever increases, `target.formsOf(node)` bounds it, and
      each widening only ever grows the fragment — so addresses only move outward, a
      displacement that fit can stop fitting (which the next pass handles) but a widened form
      is never narrowed. Contrast with the shrinking design, which does not obviously
      terminate. State the observable consequence: a branch to an undefined symbol relaxes to
      the widest form immediately, because `bindsAtLayout` says no.
- [ ] **§ afterLayout** — Establish the single seam for "needs final addresses". `McModule`
      carries an `afterLayout` array of thunks, run after the fixed point and **before**
      fixups are applied. Everything in [Ch 71] hangs off it — DWARF advance operands, FDE
      deltas, the `.eh_frame_hdr` table, Win64 unwind-code offsets — and so does PE's import
      table resolution [Ch 70]. Establish the design rule it encodes: a producer that needs
      final addresses reserves fixed-size space up front and patches it later, rather than
      participating in relaxation.
- [ ] **§ the-opcode-table** — Establish the x86-64 table as one map from mnemonic to
      `OpcodeGroup`, where a group carries every *form* the instruction has and — the point
      made in [Ch 65 § latency-in-the-encoding-table] — its scheduling effect in the same
      entry. Show `addArithmetic` generating four widths × six operations × five forms from
      one three-column table, with `WIDTHS` supplying the `b`/`w`/`l`/`q` suffix, the `rexW`
      bit, and the `0x66` operand-size prefix as `mandatory`.
- [ ] **§ signature-keying** — Establish the escape hatch for instructions whose encoding
      depends on which register *file* each operand is in. `signatureOf(operands)` joins the
      register class ids, and `opcodeGroup(mnemonic, signature)` looks up
      `"movq:fpr,gpr"` before falling back to `"movq"` — so `movq %rax, %xmm0` (`66 0f 6e`,
      `rm`) and `movq %xmm0, %rax` (`66 0f 7e`, `mr`) are two different table entries under
      one mnemonic. Same for `movd`.
- [ ] **§ rex** — Establish the REX prefix. `extensionBits` sets `REX_R` from the `reg`
      field's fourth bit, `REX_B` from the r/m register or the memory base, `REX_X` from the
      index; `REX_W` comes from the form. Then the case that is not about extended registers
      at all: `forcesRex` — a one-byte access to `sil`, `dil`, `spl` or `bpl` requires a REX
      prefix *with no bits set* (a bare `0x40`), because without it those encodings mean
      `ah`, `ch`, `dh`, `bh`. Pin it.
- [ ] **§ modrm-and-sib** — Establish the addressing byte and the three traps
      `emitModRm` encodes. (1) **`rsp` cannot be an index register** — the index field's
      value 4 means "no index", so the code throws rather than emitting something that means
      something else. (2) **A base whose low three bits are `rsp`'s forces a SIB byte**, even
      with no index — same reason, from the other side. (3) **A base whose low three bits are
      `rbp`'s cannot use the zero-displacement form**, because `mod=00, rm=101` means
      RIP-relative; so `anchored` is false there and an explicit `disp8` of zero is emitted.
      Add the symbol case: a `MachineAddress` with a symbol and no base becomes
      `mod=00, rm=101` — RIP-relative — plus a `X64_PC_RELATIVE_32` fixup, which is how every
      float constant and every `tera_context` field is reached. A fixed-width ASCII table of
      the ModRM and SIB bit fields belongs here.
- [ ] **§ form-selection** — Establish `encodeImmediate`'s ladder, in order: the `m1`
      shift-by-one form when the value is 1; the sign-extended `mi8` byte form when
      `fitsSigned(value, 8)`; the accumulator form `ai` when the destination is `rax`; the
      `oi` register-embedded form (`movabsq`, `movl $imm,%reg`); and finally the general `mi`
      form. Then the three-operand case: `rmi8` before `rmi`, which is the `imull` fix.
      Establish that `explicitOperandsOf(node, {dropTiedSource: true})` is what makes a tied
      three-operand IR instruction look like a two-operand machine instruction here.
- [ ] **§ branches-and-forms** — Establish `formsOf` as "how many encodings does this node
      have", which is the number relaxation steps through. Only branches have more than one:
      `jcc` has a `rel8` and a `rel32` form, `jmp` has `eb` and `e9`, `call` has only `e8`.
      Everything else answers 1 and never relaxes.
- [ ] **§ padding** — Establish `x64Padding`: alignment gaps in `.text` are filled with the
      canonical multi-byte nops (up to 11 bytes each) rather than with `0x90` repeated,
      because the padding is inside an executable section and may be executed by a
      fall-through. Contrast `zeroPadding`, which every other section uses.
      `McSection.padding` is set by `assembleFunction` from `target.padding`.
- [ ] **§ the-differential-harness** — Establish the method, which is the chapter's real
      claim to correctness. `assembleText` writes the writer's own assembly text to a
      `.s` file, runs a real `cc` on it, extracts `.text` with `objcopy -O binary`, and hands
      back the bytes; the test compares them with `hex()` so a failure prints two byte
      strings rather than "expected true". Establish the three levels it is applied at: one
      instruction per case, the whole body of every runtime routine (with relocation-covered
      bytes zeroed by `outsideRelocations`), and every case concatenated into one block so
      *inter*-instruction effects like alignment cannot hide. Establish the discovery
      property: the `imull` case above was not a bug report, it was a diff.
- [ ] **§ toolchain-detection** — Establish why this is a separate test tier.
      `gnuToolchain` probes for `cc`/`gcc`/`clang` and `objcopy`/`llvm-objcopy` at import
      time, and `itAssembles` is `it.skipIf(gnuToolchain === null)`. The whole harness is
      gated on `TERA_NATIVE=full`, which is what `--project full` sets; `--project unit` and
      `--project native` skip every one of these. Say plainly what that means: the encoder's
      correctness argument runs only on a machine with a GNU toolchain.

## Honesty items

- > **Unenforced.** `FixupKind` is a bare `string` and `opcodeGroup`'s key is a bare
  `string`. A mnemonic a lowering emits but the table does not contain is an
  `UnsupportedInstructionError` at encode time — after selection, scheduling, allocation and
  frame layout have all succeeded. Nothing derives the encoder's coverage from
  `emittedOpcodesOf(lowering)`, which is the set the legality analysis already trusts.
  Cost of finishing: one test that intersects the two sets, plus a decision about the
  runtime routines' mnemonics, which are not in `rules()`.
- > **Unenforced.** `layoutModule`'s relaxation loop has no iteration cap. Termination rests
  on the argument in § relaxation — `form` is monotone and bounded by `formsOf` — which is
  true of every current target and checked by nothing. `RelaxationLimitError` exists but is
  thrown from `applyFixups`, i.e. only when a value still does not fit *after* the fixed
  point, not to bound the loop.
- > **Unfinished.** `x64McTarget.formsOf` returns 1 for every non-branch instruction, so
  nothing but a jump ever relaxes. Displacement-size selection for memory operands is done
  eagerly in `emitModRm` from the slot offset known at encode time — which is correct only
  because frame offsets are final before assembly begins [Ch 68 § incoming-slots-rebased].
  A target that wanted to shrink a `disp32` to a `disp8` after layout would need a second
  form here.
- > **Never runs.** `McSection.kind === "bss"` fragments are given addresses and sizes like
  any other, but `writeElf64Object` substitutes `new Uint8Array(0)` for their contents and
  `writeElf64Executable` skips them entirely. The `bytesFragment` contents built for a
  `.bss` datum by `assembleData` are therefore constructed and never written — which is
  correct (they are all zeroes, by `isUninitialized`) and wasteful in exact proportion to
  the reserved heap, which defaults to a gigabyte of address space.

## Verify it yourself

```bash
npx vitest run --project unit tests/optimizing/mc/layout.test.ts tests/optimizing/mc/assembler.test.ts
npx vitest run --project full tests/optimizing/backends/x64/mc/encoding.test.ts
node dist/cli.js compile docs/example/stats.tera --emit obj -o /tmp/stats.obj
objdump -h /tmp/stats.obj
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe
```

The `--project full` run is the one that needs `cc` and `objcopy`; without them every
`itAssembles` case is skipped and the encoder is unchecked.

## Tests that pin this

- Relaxation: `tests/optimizing/mc/layout.test.ts` >
  `"keeps a nearby forward jump in the short form"`,
  `"widens a forward jump that no longer reaches with a byte displacement"`,
  `"relaxes only once for a jump that crosses the byte boundary"`,
  `"resolves the displacement against the end of the branch"`,
  `"resolves a backward branch to a negative displacement"`,
  `"records a relocation for a symbol it cannot resolve"`,
  `"aligns each function to the target requirement"`.
- Fragments, symbols and sections: `tests/optimizing/mc/assembler.test.ts` >
  `"defines the function symbol at the fragment its first block starts on"`,
  `"opens the function with an alignment fragment so the entry lands on a boundary"`,
  `"gives the section the target's padding rather than leaving it zero-filled"`,
  `"defines a local label for every block so a branch can name it"`,
  `"references every symbol an encoded fixup names, so nothing links undefined by accident"`,
  `"shares one text section between two functions assembled into the same module"`,
  `"keeps the two functions' entries apart inside that shared section"`,
  `"binds the function locally when the caller asks for it"`.
- Data placement: `tests/optimizing/mc/assembler.test.ts` >
  `"puts a read-only datum in rodata"`,
  `"puts a writable datum that carries content in data"`,
  `"puts a writable datum that is nothing but zeroes in bss"`,
  `"keeps a read-only run of zeroes out of bss, which only holds writable storage"`,
  `"keeps a writable datum out of bss once one item carries content"`,
  `"raises each section to the widest alignment any of its data asked for"`,
  `"splits data across the sections their writability and content call for"`.
- Encoding traps: `tests/optimizing/backends/x64/mc/encoding.test.ts` >
  `"emits a bare rex prefix for legacy byte registers"`,
  `"omits the rex prefix for byte registers that do not need one"`,
  `"forces a displacement when the frame pointer is the base"`,
  `"inserts a sib byte when the stack pointer is the base"`,
  `"prefers the sign extended immediate form when the value fits a byte"`,
  `"prefers the accumulator form for wide immediates on rax"`,
  `"emits a rip relative operand for symbol addresses"`,
  `"encodes a call through a rip relative slot as an indirect call"`,
  `"keeps a call to a symbol a relative branch"`.
- The gas differential, including the case in § worked-example:
  `tests/optimizing/backends/x64/mc/encoding.test.ts` >
  `"agrees on multiply by an immediate into another register"`,
  `"agrees on multiply by a wide immediate into another register"`,
  `"agrees on add a loaded field"`, `"agrees on multiply by a loaded field"`,
  `"agrees on mask by a small immediate"`, `"agrees on mask by a wide immediate"`,
  `"agrees on the whole body of tera_alloc"`,
  `"agrees on every case emitted as one block"`.
- The whole object against gas: `tests/e2e/optimizing/x64/native-object.test.ts` >
  `"links into a program that computes what the functions promise"`, and the parametrised
  rows `"encodes %s to the same text bytes"`.
- The error hierarchy the encoder raises: `tests/optimizing/mc/errors.test.ts` >
  `"exports a constructor for every failure the assembler can raise"`,
  `"makes every failure catchable as one MachineCodeError"`,
  `"repeats every operand it was handed in the message it reports"`.
