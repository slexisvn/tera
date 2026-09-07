# 70. Object files and self-linked executables   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** The compiler writes an ELF and a PE that run, with no linker — and the two
formats disagree about almost everything, including whether the executable carries debug
information at all.

**What arrived.** An `McModule` from [Ch 69 § afterLayout]: sections of fragments, a symbol
table, `McRelocation`s for the fixups that could not be patched, and `afterLayout` thunks
queued. One correction to that handover — the module arrives **not yet laid out**.
`layoutModule` is called *from inside* the container writer (`elf64Object.image`,
`layoutElf64Executable`, `layoutPeExecutable`), so this chapter's first act is to choose the
`LayoutMode` and the base address that chapter 69's fixed point then runs against.

**What leaves.** A file on disk that the operating system loader runs: an `ET_EXEC` ELF64
with seven program headers and **zero** section headers, or a PE32+ with ten sections, an
`.idata` import directory and an exception directory. On the object path, a `.o`/`.obj` plus
a C header; on the toolchain path, a `.c`/`.s` plus a synthesized `main.c`. [Ch 71] goes back
and fills in the four sections this chapter only agreed to carry: `.eh_frame`,
`.eh_frame_hdr`, `.pdata`/`.xdata` and `.debug_line`.

**New ideas.** Object file versus executable image; **section versus segment** (full primer —
it is the chapter's hinge); the section header table and the program header table as two
independent descriptions of the same bytes; virtual address, RVA and image base; page
alignment and the file-offset ≡ virtual-address modulo page rule; symbol binding and the
symbol table's local-before-global ordering; an import table and an indirect call through it;
the DOS stub; ASLR, and why stripping base relocations forgoes it. *Relocation* and *symbol*
themselves were primed in [Ch 69 § fixups] and are used here, not re-taught.

**Length.** 12 pages

## Anchors

- `src/optimizing/mc/formats/container.ts` — the whole boundary, fourteen lines:
  `McObjectWriter` and `McExecutableWriter`, each an `extension`, a **`carriesDebug`**
  boolean, and one `image(module, target[, entrySymbol])`.
- `src/optimizing/mc/formats/elf64.ts` — `writeElf64Object` (235-361),
  `layoutElf64Executable` (363-375), `writeElf64Executable` (377-436), `elf64Object` (438),
  `elf64Executable` (449); `orderedSymbols`, `symbolTableBytes`, `relocationTableBytes`,
  `sectionFlags`, `segmentFlags`, `programHeaderCount`, `unwindHeaderOf`, `symbolTypeOf`,
  `StringTable`, `writeElfHeader`, `writeSectionHeader`; the constants `ET_REL`/`ET_EXEC`,
  `SHT_PROGBITS`/`SHT_NOBITS`/`SHT_SYMTAB`/`SHT_STRTAB`/`SHT_RELA`, `PT_LOAD`,
  `PT_GNU_EH_FRAME = 0x6474e550`, `STB_LOCAL`/`STB_GLOBAL`, `STT_FUNC`/`STT_OBJECT`,
  `DEFAULT_BASE_ADDRESS = 0x400000`, `DEFAULT_PAGE_SIZE = 0x1000`.
- `src/optimizing/mc/formats/pe.ts` — `PeImportTable` (179-245) and its `resolve(imageBase)`,
  `definePeImports`, `importAddressSymbol` (`__imp_` + name), `thunkTable`,
  `hintNameFragment`, `spanOf`; `dosStub` (254), `writeDosHeader`, `writeCoffHeader`,
  `writeOptionalHeader`, `writeSectionHeader`, `sectionCharacteristics`, `sectionNameBytes`,
  `CoffStringTable`, `alignmentCharacteristics`, `storageClassOf`, `storedAddendOf`,
  `relocatedContents`, `writeCoffObject` (675-754), `layoutPeExecutable` (437),
  `writePeExecutable` (449-550), `coffObject`, `peExecutable`;
  `IMAGE_FILE_RELOCS_STRIPPED`, `IMPORT_DIRECTORY_INDEX = 1`,
  `EXCEPTION_DIRECTORY_INDEX = 3`, `IMPORT_ADDRESS_TABLE_INDEX = 12`,
  `DEFAULT_IMAGE_BASE = 0x400000`, `DEFAULT_SECTION_ALIGNMENT = 0x1000`,
  `DEFAULT_FILE_ALIGNMENT = 0x200`.
- `src/optimizing/backends/x64/backend.ts` — the `CONTAINERS` table (40-58) pairing each
  `ObjectFormatName` with writers: `elf` → `elf64Object`/`elf64Executable`, `coff` →
  `coffObject`/`peExecutable(PE_MACHINE_AMD64, WINDOWS_IMPORTS)`, and **`macho: null`**.
- `src/optimizing/backends/x64/windows.ts` — `WINDOWS_IMPORTS` (46-48): one library,
  `kernel32.dll`, seven functions, passed through `withoutThreadEntryPoints`; `importedCall`
  (70-72), which turns `__imp_WriteFile` into `mem(8, { symbol })`; `windowsIo`,
  `WINDOWS_PROGRAM_ENTRY = "_start"`.
- `src/optimizing/machine/backend.ts` — `populate` (176-215) and the order it builds a module
  in; `closeOverRoutines` (148-164) and `requiredRoutines` (166-174); `objectImage` (217) and
  `executableImage` (237-260); `entryPart` (262-293) with `PRINTABLE_RESULTS`; `outputsOf`
  (295-301); `NativeMachineCodeSupport`, `NativeProgramImage`; `createNativeBackend.link`
  (364-448), where the header, `moduleInitTable` and assembly text are assembled.
- `src/optimizing/machine/heap-data.ts` — `heapImageOf`, `heapData` (113-125), `classData`,
  `contextDatum`, `reserved`/`storage`/`table`/`padded`.
- `src/optimizing/target/runtime-layout.ts` — `TERA_HEAP_RESERVE_BYTES = 1 << 30` (112),
  `TERA_CONTEXT` (119), `TERA_ARRAYS` (224-230), `TERA_CLASS_RECORD`, `TERA_CLASS_FIELDS`,
  `TERA_STATIC_ROOTS`, `TERA_STATIC_ROOT_COUNT`, `withoutThreadEntryPoints` (193-199).
- `src/optimizing/target/entry.ts` — `programEntryShape`, `defaultDelivery`,
  `missingEntryReason`, `EntryDelivery` (`"print" | "exit"`), `EntryResult`.
- `src/cli/compile.ts` — `mainSource` (118-130), `deliveryLines` (100-105),
  `moduleInitLines` (107-116), `linkWithCompiler` (277-318), `usesToolchain` (221-239),
  `requireHostToolchain` (210-219), `writeDirect` (259-275), `FORMATS`, `MAIN_NAME`.
- `src/optimizing/target/symbols.ts` — `moduleInitTable` (17-26), `MODULE_INIT_TABLE`.
- `tests/helpers/elf-runner.ts` — `detect` (41-46): a Linux-x64 host runs the ELF directly,
  a Windows host runs it through `wsl.exe`. That is what makes the worked example below
  reproducible on one machine.

## Worked example

`stats.tera` written twice in one session — once as an ELF64 executable, once as a PE32+ —
both run, both printing exactly what the interpreter prints:

```bash
node dist/cli.js docs/example/stats.tera
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe
node dist/cli.js compile docs/example/stats.tera --platform linux -o /tmp/stats.elf
cp /tmp/stats.elf ./stats.elf && wsl.exe -e bash -c "chmod +x ./stats.elf && ./stats.elf"
```

All four print `latency mean=15.70` / `throughput mean=898.19`. The two files agree about
nothing else: 397,492 bytes against 28,714 (ELF pads every section out to a page, because its
file offset *is* its virtual address minus the base; PE packs sections at a 512-byte file
alignment and lets the loader spread them out), 7 program headers and 0 section headers
against 0 program headers and 10 section headers, and — the fact this chapter is built
around — the PE carries `.debug_line`, `.debug_abbrev` and `.debug_info` while the ELF
carries none of them.

## Outline

- [ ] **§ object-files** — Establish the two artifacts and the one boundary.
      > **New idea.** An **object file** is code with holes in it: addresses are all zero or
      relative, and a table of relocations says what to write into each hole once someone
      decides where things go. An **executable image** is the same code with the holes filled
      and a description of how to map it into memory. A linker turns the first into the
      second. This chapter's subject is a compiler that skips that step.
      Establish `container.ts` as the entire seam: an `extension`, a `carriesDebug` flag, one
      `image()`. Establish that the *backend* picks the pair — `CONTAINERS` in
      `backends/x64/backend.ts`, keyed by `ObjectFormatName` — and that `macho` is `null`
      there, so "x64 on macOS" is a name the type admits and a writer that does not exist.
      Then `outputsOf`: a backend advertises `assembly` always, `object` only when
      `support.object` is non-null, `executable` only when `support.program` is, which is
      exactly what `tera targets` prints. Close on the correction to [Ch 69]'s handover:
      `layoutModule` runs *inside* `image()`, so the container chooses the `LayoutMode` (which
      decides through `bindsAtLayout` whether each fixup becomes a number or a relocation) and
      the base address (which every patched byte then depends on) — and
      `layoutElf64Executable` raises every section to `pageSize` before calling it.
- [ ] **§ sections-versus-segments** — Primer, and the chapter's hinge.
      > **New idea.** A **section** is a named region a *tool* cares about — `.text`,
      `.rodata`, `.debug_line`. A **segment** is a region the *kernel* maps: a file range, an
      address, a length, and read/write/execute. ELF carries two independent tables over the
      same bytes: the section header table, for linkers and debuggers, and the program header
      table, for the loader. An object file needs only sections; an executable needs only
      segments.
      Establish that `sectionFlags` (`SHF_ALLOC`/`SHF_WRITE`/`SHF_EXECINSTR`) and
      `segmentFlags` (`PF_R`/`PF_W`/`PF_X`) are two encodings of one `McSection.permissions`,
      and that this is the only place in the tree where the same fact is deliberately written
      twice in two vocabularies. Contrast PE up front: one table, every header carrying both
      a file offset and an RVA, so the loader and `objdump` read the same row.
- [ ] **§ the-modulo-page-trick** — Establish the constraint and how the writer gets it for
      free. A loader maps pages, so a segment's file offset and virtual address must agree
      modulo the page size. `writeElf64Executable` does not compute that: every section was
      already raised to `pageSize` alignment before layout, and `fileOffset` is *defined* as
      `section.address - base`. The congruence is an identity, not an adjustment. Establish
      the base-address arithmetic that makes it hold — `layoutElf64Executable` starts layout
      at `base + ELF_HEADER_BYTES + ELF_PROGRAM_HEADER_BYTES * programHeaderCount(sections)`,
      so nothing is laid out on top of the headers. Then one `PT_LOAD` per section, in source
      order, with no merging of same-permission neighbours — six of them for `stats.tera`.
      Name the price in the same breath: fourteen times the file size of the PE, all of it
      page padding, and a `.bss` segment written with `p_filesz` 0 and `p_memsz` 0x5736a.
- [ ] **§ symtab-and-rela** — Establish ELF's symbol table by its two ordering rules and where
      each is enforced. (1) **Index 0 is a reserved null entry** — `symbolTableBytes` opens
      with `out.fill(ELF_SYMBOL_BYTES, 0)`, and every index computed elsewhere is
      `position + 1`. (2) **Locals come first** — `orderedSymbols` concatenates locals then
      the rest, and the `.symtab` header's `sh_info` is `localCount + 1`, the index of the
      first non-local, which is the only thing telling a linker where the boundary is. Show
      the other two header fields doing real work: `sh_link` naming the string table,
      `st_shndx` naming the defining section, and `st_value` computed as
      `fragment.address - section.address` because an object's sections are all based at zero.
      Then relocations: one `.rela<name>` per section that has any, `sh_link` to `.symtab`,
      `sh_info` to the section being patched, `r_info` packed as `(symbolIndex << 32) | type`,
      and — the difference that will matter in § coff-is-not-pe — an **explicit addend**
      field. Verify against `readelf -SW`: `.symtab` with `Lk 10 Inf 684`.
- [ ] **§ an-executable-with-no-section-table** — The sharpest fact in the chapter; state it
      flatly. `writeElf64Executable` calls
      `writeElfHeader(out, ET_EXEC, options, entry, ELF_HEADER_BYTES, headerCount, 0, 0, 0)` —
      the last three arguments are `e_shoff`, `e_shnum` and `e_shstrndx`, and all three are
      zero. There is no section header table, no `.shstrtab`, no `.symtab`, in a file that
      runs perfectly. Establish the two consequences. First, every tool that works through
      sections is blind to it (`objdump -h`, `nm`, a debugger's symbol loader). Second, and
      this is the thesis: **a debug section cannot be found even if its bytes are present**,
      so `elf64Executable` declares `carriesDebug: false`, `populate`'s `describes` parameter
      *is* `writer.carriesDebug`, and `appendDebugLine` is therefore never called on this
      path — the DWARF is not written and then hidden, it is never produced. Contrast
      `peExecutable`, `elf64Object` and `coffObject`, all three `carriesDebug: true`.
      Close with the refusal both writers share: an image with any surviving relocation throws
      `"executable has unresolved symbols: …"`, because there is nobody downstream to fix one.
- [ ] **§ pt-gnu-eh-frame** — Establish the one program header that is not a `PT_LOAD`.
      `programHeaderCount` is `sections.length + (unwindHeaderOf(sections) ? 1 : 0)`, and
      `unwindHeaderOf` matches a section named literally `.eh_frame_hdr`. That extra header
      re-describes the same bytes with type `PT_GNU_EH_FRAME` and the *section's own*
      alignment rather than the page size. Establish what it buys and why it has to exist
      here: a program with no section table still has to be unwindable, and once sections are
      gone a segment is the only channel left. Forward to [Ch 71 § eh-frame-hdr], which
      supplies the bytes. Note the asymmetry to be picked up in
      § mz-to-data-directories: Windows answers the same question with a *data directory
      slot*, not a segment type.
- [ ] **§ closure** — Establish what actually ends up in the module, and in what order.
      `populate` adds the heap data first, then every required runtime routine as a **local**
      symbol, then each compiled part as local or global by `part.internal`, then queues the
      unwind and line-table thunks. The interesting half is *which* routines. Each part
      carries a `runtime` list built in `createEmitter.emit` by looking every name in
      `compiled.fn.externals` up in `target.runtime` — a miss is
      `"<target> has no runtime routine for <name>"`, a compiler bug. `closeOverRoutines` then
      walks those seeds transitively through each routine's own `fn.externals`, so pulling in
      `tera_alloc` pulls in `tera_collect`, which pulls in the mark and sweep passes.
      Establish the one difference between the two images: `executableImage` adds the program
      entry's externals to the seed set before closing, because `_start` calls
      `VirtualAlloc`-shaped routines nothing else references. This is where [Ch 68
      § prologue-and-epilogue]'s stack-probe `fn.externals` edge lands.
- [ ] **§ mz-to-data-directories** — Walk the PE header top to bottom, because every field in
      it is a decision. The **DOS stub**: `writeDosHeader` writes `MZ`, a page count, a stack
      pointer, and at offset 0x3c the `e_lfanew` pointer to the PE signature; `dosStub()`
      assembles fourteen bytes of real-mode code — `int 21h` function 9 to print, function 4Ch
      to exit — around `"This program cannot be run in DOS mode.\r\r\n$"`, back-patching the
      message's own offset into the code with `writeInteger(code, 3, code.length, 2)`. The
      **COFF characteristics**: `IMAGE_FILE_RELOCS_STRIPPED | EXECUTABLE_IMAGE |
      LARGE_ADDRESS_AWARE`, and the trade that first flag makes — no `.reloc` section means no
      base relocations, which means the image must load at `0x400000` or not at all, which
      means no ASLR. A self-linking compiler with no relocation writer cannot have it both
      ways. The **section characteristics**: `sectionCharacteristics` derives
      `CNT_CODE`/`CNT_INITIALIZED_DATA`/`CNT_UNINITIALIZED_DATA` and the three `MEM_*` bits
      from the same permissions ELF encoded twice, and gives a non-loadable (debug) section
      `MEM_DISCARDABLE` instead. The **data directories**: sixteen fixed `(rva, size)` slots,
      of which this writer fills three — index 1 the import directory, index 12 the import
      address table, and index 3 the **exception directory**, present only when a section
      named `.pdata` is. Verify all of it against one `objdump -p`.
- [ ] **§ idata** — Establish how a binary with no linker calls `WriteFile`. `PeImportTable`'s
      constructor builds the whole import directory out of ordinary `McBytesFragment`s in an
      `.idata` section: one 20-byte directory entry per library plus a null terminator, an
      import lookup table, an import address table, hint/name entries, and the DLL name
      string. Establish the trick that wires it to code — for each function it calls
      `module.symbols.define(importAddressSymbol(name), table[position], "local", "object")`,
      so `__imp_WriteFile` is a *symbol sitting on the IAT thunk*, and `importedCall` in
      `windows.ts` is nothing but `mem(8, { symbol: "__imp_WriteFile" })`: a RIP-relative
      indirect call, no thunk, no stub, no import library. Establish that `resolve(imageBase)`
      back-fills every RVA and returns the two directory spans, and that it runs at the top of
      `writePeExecutable` rather than through `McModule.afterLayout` — it does not need the
      seam, because `layoutPeExecutable` has already returned by then. Close on the surface
      itself: seven kernel32 entry points, filtered through `withoutThreadEntryPoints`, which
      *throws* rather than returns if the list ever names a thread-creation call. That refusal
      is a design boundary, and [Ch 81] states it as one.
- [ ] **§ the-heap-image** — Establish what `heapData` appends and why it is the first thing
      `populate` adds. Six items: the `tera_context` record (writable, and carrying content
      because `contextDatum` pre-sets `arenaReserved`, so it lands in `.data`); the five
      `TERA_ARRAYS` storages — roots, marks, young list, remembered set, statics — all
      writable and all zero, so `isUninitialized` sends them to `.bss`; and three read-only
      tables in `.rodata` describing every class's reference-field offsets plus the static
      root list. Establish the payoff as a one-line argument about file size: the arena is
      asked for from the operating system at run time, not carved out of the image, so
      `TERA_HEAP_RESERVE_BYTES = 1 << 30` costs four bytes in `.data` and nothing anywhere
      else. Check it against the worked example — 0x57372 bytes of `.bss` present in the
      address space and absent from both files.
- [ ] **§ coff-is-not-pe** — Establish that the object writer is a different program from the
      image writer, and enumerate the four places COFF forced a different decision.
      (1) **Symbol indices are 0-based** (`indexOfSymbol.set(name, position)`), because COFF
      has no mandatory null symbol; ELF's are 1-based. (2) **There is no addend field**, so
      `relocatedContents` pre-applies every relocation into the section bytes, and
      `storedAddendOf` adds the fixup's own size back for a non-absolute kind — undoing
      exactly the `anchorBias` [Ch 69 § bindsAtLayout] subtracted. (3) **Alignment lives in
      the section characteristics**, four bits at `IMAGE_SCN_ALIGN_SHIFT`, so
      `alignmentCharacteristics` throws for any request at or above 0x2000; an ELF section
      header has a full 8-byte alignment field and can ask for anything. (4) **Long section
      names go through a string table**: `sectionNameBytes` writes eight bytes inline or `/N`
      into a `CoffStringTable` — which is why a PE *executable* still carries a COFF string
      table (`symbolCount: 0`, `symbolTableOffset: cursor`) purely so that `.debug_abbrev`,
      thirteen characters, has a name at all.
- [ ] **§ why-not-just-call-the-linker** — *Why the obvious design fails*, then the design
      that is kept anyway. Stage the obvious one: stop at `.o` and shell out to `ld`. The tree
      keeps that road — it is `--link=cc`, it is `linkWithCompiler`, and it is the *only* road
      for the `c` and `riscv64` targets. Then show its cost in the compiler's own words:
      `requireHostToolchain` refuses `--target riscv64 --emit exe` on a Windows host with
      "linux-riscv64 is not this machine (windows-x64), so the C compiler here cannot link the
      result; emit source and link with a cross toolchain instead", while
      `--target x64 --platform linux -o stats.elf` succeeds on that same machine in the same
      minute, because nothing outside the process is involved. General rule: a compiler that
      writes its own container cross-compiles by changing a table entry; one that borrows a
      linker inherits the linker's platform. Close by walking the borrowed path in full, since
      [Ch 72] depends on it: `linkWithCompiler` writes the backend's files to a temp
      directory, adds `main.c` from `mainSource`, and runs `cc <sources> main.c -o out -lm`.
      `mainSource` makes three decisions — include the generated header; emit
      `tera_module_init()` calling each surviving module initializer if there are any; and
      shape the call by the entry's *scalar*, through `deliveryLines`
      (`return (int)entry();` for an `exit` delivery, `printf("%s\n", …)` for a string,
      `printf("%d\n", …)` for an int, `printf("%.17g\n", …)` otherwise). Establish that
      `stats.tera`'s generated `main.c` is four lines, because `tera_program` returns `int`
      and `defaultDelivery` therefore makes it the exit status while `print` does the talking.

## Honesty items

- > **Never runs.** `moduleInitTable` (`src/optimizing/target/symbols.ts:17`) emits a
  `tera_module_inits[]` function-pointer table into the generated header, and is unit tested,
  but nothing reads it. On the toolchain path `mainSource` (`src/cli/compile.ts:118`) writes
  its own `tera_module_init()` calling each symbol directly. Cost of finishing: delete the
  table, or make `mainSource` walk it; either is a few lines, and
  `tests/optimizing/target/symbols.test.ts` moves with it.
- > **Unfinished.** Module initializers are dropped on the self-linked executable path.
  `startModules` (`src/optimizing/drivers/aot.ts:242`) normally splices the init calls into
  the entry graph and reports `moduleInits: []`; when it refuses — a module that can throw
  while it loads — the driver hands the backend a non-empty `moduleInits` instead.
  `createNativeBackend.link` uses that list only for the header's `initTable`, and the
  `format === "executable"` branch returns the image alone and emits no header. So an
  imported module's top level silently does not run in a self-linked binary, in exactly the
  case where the IR path already gave up. Cost of finishing: thread `moduleInits` through
  `executableImage` and have `NativeProgramImage.programEntry` call them before the entry.
- > **Unfinished.** `CONTAINERS.macho` is `null` (`backends/x64/backend.ts:57`), so
  `ObjectFormatName` admits a format with no object writer and no program image; `outputsOf`
  then reports `["assembly"]` for it and every other path refuses. Cost of finishing: a third
  pair of writers beside ELF and PE. Carried in [Ch 82] and `appendix/d-inventory.md`.
- > **Unenforced.** `writeElf64Executable` emits one `PT_LOAD` per section and never merges
  adjacent sections with equal permissions, so the loader is asked for six mappings where two
  would do and the file pays a page of padding for each. Nothing checks the count and nothing
  measures the cost; the one number this book has is 397,492 bytes of ELF against 28,714 of
  PE for the same program, taken from the worked example above.
- > **Unenforced.** Both writers default to image base `0x400000`, and PE makes that
  mandatory with `IMAGE_FILE_RELOCS_STRIPPED`. Nothing checks that the laid-out image fits
  where it insists on being loaded; the failure mode is a loader error with no diagnostic
  from the compiler.
- > **Unenforced.** `writeCoffObject` passes `virtualSize: 0` and `address: 0` into every
  section header — correct for a relocatable object, and indistinguishable in the source from
  a field nobody filled in, because one `writeSectionHeader` serves both writers.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe
node dist/cli.js compile docs/example/stats.tera --platform linux -o /tmp/stats.elf
readelf -h /tmp/stats.elf && readelf -lW /tmp/stats.elf
objdump -h /tmp/stats.exe && objdump -p /tmp/stats.exe
node dist/cli.js compile docs/example/stats.tera --target c --keep-temps -o /tmp/stats-c.exe
npx vitest run --project unit tests/optimizing/mc/formats/elf64.test.ts tests/optimizing/mc/formats/pe.test.ts
```

`readelf -h` prints `Number of section headers: 0` — that is
§ an-executable-with-no-section-table in one line — and `readelf -lW` prints six `LOAD`s and
one `GNU_EH_FRAME`, each with `Offset` congruent to `VirtAddr`. `objdump -h /tmp/stats.exe`
lists `.debug_line`, `.debug_abbrev` and `.debug_info` in the PE, which the ELF executable
cannot carry; `objdump -p` prints the stripped-relocations characteristic, the three filled
data directories and the seven `kernel32.dll` imports. The `--target c --keep-temps` run
prints the temp directory holding the four-line `main.c`. The container tests skip their
binutils half without `objdump` on `PATH`; the ELF executable itself can only be *run* on a
Linux x64 host or through `wsl.exe`, which is what `tests/helpers/elf-runner.ts` detects.

## Tests that pin this

- ELF header and segment placement: `tests/optimizing/mc/formats/elf64.test.ts` >
  `"starts with the elf identification for a 64 bit little endian file"`,
  `"marks an object as relocatable and an image as executable"`,
  `"refuses to write an executable that still has unresolved symbols"`,
  `"places loadable segments so the file offset matches the virtual address page"`.
- ELF read back by binutils: `tests/optimizing/mc/formats/elf64.test.ts` >
  `"produces an object header binutils accepts"`, `"names every section it writes"`,
  `"publishes defined functions as global symbols"`,
  `"records the call to an undefined symbol as a plt relocation"`,
  `"describes an executable with one loadable executable segment"`,
  `"disassembles back to the instructions it was given"`.
- PE headers, image base and imports: `tests/optimizing/mc/formats/pe.test.ts` >
  `"opens with a dos header that points at the pe signature"`,
  `"keeps a dos stub that refuses to run under dos"`,
  `"pins the image base by stripping relocations"`,
  `"records the entry point rva of an entry that is not first in the text"`,
  `"places the first section one page after the image base"`,
  `"refuses to write an executable that still has unresolved symbols"`,
  `"aims an indirect call at the address table slot of the import"`.
- PE read back by binutils: `tests/optimizing/mc/formats/pe.test.ts` >
  `"produces a header binutils reads as a 64 bit windows image"`,
  `"names every section it writes"`,
  `"describes a console subsystem image with stripped relocations"`,
  `"publishes every imported function under its dll"`.
- COFF's four differences: `tests/optimizing/mc/formats/pe.test.ts` >
  `"leaves the field of a call to an undefined symbol empty"`,
  `"measures the addend of a displacement an immediate follows from the field end"`,
  `"publishes a defined function as external and its labels as static"`,
  `"names a symbol it never defines external and section-less"`; and
  `tests/e2e/optimizing/x64/windows-object.test.ts` >
  `"asks the linker for the alignment each section was built with"`,
  `"produces a header binutils reads as a 64 bit coff object"`.
- Objects a real linker accepts: `tests/e2e/optimizing/x64/native-object.test.ts` >
  `"emits a relocatable object next to the header"`,
  `"publishes the compiled function as a global symbol"`,
  `"keeps a pulled in runtime routine local to the object"`,
  `"puts float constants in a read only data section"`,
  `"rounds without leaving any undefined symbol behind"`,
  `"relocates a reference into the data section"`,
  `"relocates a call to another compiled function"`,
  `"links into a program that computes what the functions promise"`.
  The COFF mirror of the same list is
  `tests/e2e/optimizing/x64/windows-object.test.ts` >
  `"keeps a pulled in runtime routine static in the object"`,
  `"carries an unwind record for every function it emits"`.
- The transitive routine closure of § closure is pinned only indirectly, by
  `"rounds without leaving any undefined symbol behind"` in both object tests — a routine the
  closure missed shows up as an undefined symbol. Nothing pins `closeOverRoutines` directly.
  [unpinned]
- Executables that run with no linker at all:
  `tests/e2e/optimizing/x64/native-executable.test.ts` >
  `"exits with a computed constant"`, `"runs a loop"`,
  `"calls another compiled function"`,
  `"uses the integer division runtime routine"`,
  `"prints an integer result when asked to"`,
  `"prints a string an entry built without reading input"`; and
  `tests/e2e/optimizing/x64/windows-executable.test.ts` >
  `"echoes text through kernel32 file handles"`,
  `"runs accessors, statics, super and for-of in one native program"`,
  `"runs a static field initializer before the program body"`.
- The entry contract of `entryPart`/`programEntryShape`:
  `tests/e2e/optimizing/x64/native-executable.test.ts` >
  `"makes the top level of the file the entry when none is named"`,
  `"names the function it could not find"`,
  `"refuses an entry that takes parameters"`,
  `"refuses a float result it has no way to print"`,
  `"refuses to make a string result the exit status"`.
- The heap image staying out of the file:
  `tests/e2e/optimizing/x64/windows-executable.test.ts` >
  `"keeps the arena out of the file so the image does not grow with it"`,
  `"keeps the statics block out of the file as well"`; and
  `tests/e2e/optimizing/aot/os-heap.test.ts` >
  `"asks the OS for memory instead of reserving an arena in the image"`,
  `"writes the requested reserve size into the context the program starts with"`,
  `"keeps a reserve far larger than the bytes the image carries"`,
  `"reaches the operating system through kernel32 alone"`.
- The unused init table: `tests/e2e/optimizing/aot/modules.test.ts` >
  `"omits the table when no module init survives"`,
  `"lists only init functions that actually lowered"`,
  `"never lists the entry module"` pin what feeds `moduleInitTable`. Nothing pins a consumer,
  because there is none.
- That both containers agree with the interpreter on the example itself:
  `tests/e2e/docs/book-examples.test.ts` > the parametrised
  `"${file} prints what the book says it prints"` and
  `"stats.tera is the twenty-four lines the book claims"`.
