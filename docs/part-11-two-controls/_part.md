# Part XI — Two controls

> **Status:** outline

**Tiers this part constrains.** ⟨I · B · J · **N**⟩ — native only. Nothing here touches
the interpreter, the baseline compiler or the JIT. Everything here is downstream of the
shared middle end, which means everything here is a statement about *where the middle end
stops and a target begins*.

## What this stage owes everything downstream

Part X carried one function all the way to bytes on one machine: x64, with a register
allocator, a scheduler, an encoder, an object writer and an executable writer behind it.
Read alone, Part X cannot tell you which of those stages was *necessary* and which was
*x64*. Nothing in it fails, so nothing in it draws a line.

This part draws the line by removing things. It reads the two backends in the tree that
each opt out of a different half of the pipeline, and then asks what still worked:

- **riscv64** keeps the whole machine layer — selection, scheduling, two-address
  lowering, liveness, linear scan, frame layout, peephole — and drops the encoder. It has
  no condition-code register, no memory operands, no `Select`, a return address that lives
  in a register, byte text instead of UTF-16, and a non-generational collector. It emits
  assembly text and nothing else.
- **c** keeps everything *above* the machine layer — the same legalization pipeline, the
  same legality analysis, the same runtime-layout offsets, the same refusal sentences —
  and drops the machine layer entirely. No MachineIR, no registers, no ABI
  (`cTarget.abi === null`), no scheduling, no object writer. It goes from CFG straight to
  C source.

Between them they answer the question Part X could not: **which problems belong to code
generation, and which belong to compilation.** Anything both controls still do is
compilation. Anything only x64 does is code generation. Anything only riscv64 does is a
machine's opinion.

The measured version of that claim, which chapter 72 opens with: the C emitter and the
x64 lowering each handle **41** IR opcodes; riscv64 handles **40**. The single difference
across all three, across the whole surface, is `Select`.

## What this part hands to Part XII

A capability matrix that is *derived*, not asserted — every row read out of
`aotBackends()`, `emitsOf()` and `target.capabilities` rather than written down by hand —
and a working habit for the rest of the book: when a stage looks essential, find the
target that skips it.

## Chapters

| # | Chapter | Tiers | Pages |
| --- | --- | --- | --- |
| 72 | [Two Controls: riscv64 and C](72-two-controls-riscv64-and-c.md) | ⟨I · B · J · **N**⟩ | 14 |

## Reading the tier badge

`⟨I · B · J · N⟩` names the four machines in order — interpreter, baseline, JIT, native.
A **bold** letter marks a tier the chapter or section actually constrains. A chapter whose
badge shows one bold letter is a chapter that cannot change how the other three behave.

## What the running example cannot reach here

`docs/example/stats.tera` compiles cleanly for all four registered AOT targets, so it
demonstrates the *agreements* in this part perfectly — the write barrier appearing in
`stats-c` and `stats-x64` and not in `stats-rv`, the character typedef differing, the
collector differing — but it never trips a refusal. Every refusal quoted in chapter 72 is
raised with a named three-line variation compiled beside it, and each is reproduced by a
command in that chapter's "Verify it yourself".

## Cross-references

- The machine layer this part measures against: [Ch 64 § machineir-and-instruction-selection]
  through [Ch 71 § telling-the-debugger-and-the-unwinder].
- The legalization pipeline both controls share: [Ch 56 § what-aot-declines].
- The collector whose two spellings this part compares: [Ch 61 § the-arena-the-shadow-stack]
  and [Ch 62 § generations-without-moving].
- The honesty items raised here are copied into [Appendix D § inventory](../appendix/d-inventory.md).
