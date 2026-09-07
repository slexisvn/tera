# Part X — The graph becomes bytes

> **Status:** outline

**Tier badge convention in this part.** Every chapter heading carries
`⟨I · B · J · N⟩`; a dash replaces a tier the chapter does not constrain. Part X is the
only part of the book whose badge is the same on every chapter — `⟨– · – · – · N⟩`. The
interpreter never sees a machine instruction; the baseline compiler emits JavaScript
source; the optimizing JIT emits WebAssembly, whose registers, frames and relocations are
the *host's* problem. Everything in this part exists because exactly one of the four tiers
has to answer the question "what bytes?" for itself.

## What arrived

A `CFGFunction` in canonical phi SSA that has already been proved compilable by
`aot-legality.ts` — every value carries an `AotScalar`, every parameter a declared type,
every heap value that lives across a call a root slot — plus the reverse postorder the
dominance analysis computed. That is the boundary [Ch 63] hands over. Nothing after this
point may reject a program: the legality analysis has already said yes.

## What this stage owes everything downstream

Everything downstream is *the operating system loader*. There is no linker, no assembler,
no `cc` on the exe path, no runtime image to fix things up later. So the debts are unusually
literal:

- **A total function from admitted opcodes to instructions.** `emittedOpcodesOf(lowering)`
  is what `aot-legality.ts` consulted when it admitted the graph; if selection then has no
  rule for an opcode it admitted, `Selector.run` throws
  `"<target> has no lowering for admitted opcode <type>"` — a compiler bug, never a user
  diagnostic.
- **Correct code, with no safety net.** The JIT can deoptimize; a native binary cannot.
  A miscompile here is an access violation in a shipped executable, not a bailout.
- **Bytes a third-party tool agrees with.** The encoder is checked against GNU `as`
  byte for byte; the containers against `readelf` and `objdump`; the unwind tables against
  `objdump --dwarf=frames`.
- **Addresses that do not exist yet.** Line tables, unwind tables, branch displacements and
  `.eh_frame_hdr`'s search table all need final addresses, which relaxation only settles at
  the end. `McModule.afterLayout` is the single seam that makes that expressible.

## The chapters

| Chapter | What it settles | Pages |
| --- | --- | --- |
| 64. MachineIR and instruction selection | The instruction list, its verifier, and the two-sided fusion protocol | 14 |
| 65. The Branch in the Middle of a Block | List scheduling, and the miscompile that redefined "region" | 12 |
| 66. Linear scan register allocation | Positions, intervals, spilling, rewriting, coalescing | 20 |
| 67. Splitting: A Feature That Was Measured and Left Off | The clever version, A/B'd, and switched off | 12 |
| 68. Frames, prologues, and two ABIs | One boolean between SysV and Win64; no frame pointer anywhere | 12 |
| 69. The assembler | Fragments, fixups, relaxation, and an encoder validated against gas | 14 |
| 70. Object files and self-linked executables | ELF and PE written by hand, with no linker | 12 |
| 71. Telling the debugger and the unwinder | One prologue reading, three descriptions | 14 |

## The spine through this part

`docs/example/stats.tera` is carried the whole way. Three of its functions do most of the
work:

- `report(s: Series) -> string` — one parameter, one call, one root slot. Small enough to
  print whole, and it is the same function on both ABIs, which is what makes [Ch 68] a
  two-column diff rather than an argument.
- `Series.mean()` — the `while` loop, and the only place in the example where register
  pressure is real: a float accumulator, an integer index, a receiver, and eight
  callee-saved registers spilled around the root-frame call.
- The string concatenation in `Series.label()` — three object allocations, each lowered
  through `SelectionContext.guard()`, and therefore each a conditional branch sitting in the
  middle of a machine block. That is the shape [Ch 65] is about.

## What leaves

An `ELF64` or `PE32+` file on disk that the loader runs, plus — on the object path — a
relocatable `.o`/`.obj` and a C header, and on the assembly path a `.s` file that GNU `as`
accepts. [Ch 72] takes the same middle end to riscv64 and to C, which is where it becomes
visible how much of Part X is target-independent and how much is not.

## What this part cannot reach

`stats.tera` never spills more virtuals than the target reserves scratch registers for, so
`OutOfScratchRegistersError` is described but not demonstrated from the example. It never
builds a frame past one guard page, so the stack probe is present in the prologue code and
absent from every listing taken from it — [Ch 68] uses a synthetic frame from
`tests/optimizing/machine/frame-code.test.ts` for that one section, and says so.
