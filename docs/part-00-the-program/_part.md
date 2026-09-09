# Part 0 — The Program   ⟨I · B · J · N⟩

> **Status:** written

**What this part is.** Three chapters before any machinery: the program, the language
it is written in, and every shape that program will take. Nothing here is a stage of the
pipeline. Everything here is what the pipeline is *for*.

## What this stage owes everything downstream

Part 0 hands four things forward, and every later part depends on all four.

1. **A program that is in the tree and runs.** `docs/example/stats.tera` is 24 lines and
   is pinned at that length by a test. Every listing in the remaining 80 chapters comes
   from it or from one of its seven named variations. No chapter invents a snippet
   (`docs/CONVENTIONS.md` rule 1), so if this part picks the wrong program the whole book
   is stuck with it.
2. **A reason to care about agreement.** `queue.tera` is nine lines the four tiers do not
   agree about. Part XIII returns to it as a contract (`[Ch 80 § the-agreement-contract]`)
   and as a refusal (`[Ch 81 § refusal-as-a-first-class-answer]`); Part II pays off the
   mechanism (`[Ch 13 § spending-and-refunding]`). Without chapter 1 those chapters have no
   stakes.
3. **Enough tera to read a listing.** Colon-and-indent blocks, `name: type = value` with
   no binding keyword, `fn`/`class`/`interface`, `for x of` versus `for k in`, slices and
   `@`. A reader who cannot read the surface cannot follow the tree, the bytecode or the
   IR.
4. **A map of the fourteen forms.** Chapter 3 shows one line of `stats.tera` in every
   representation the engine produces and captions each with the chapter that explains it.
   That map is what makes pipeline order navigable: a reader who opens the book at chapter
   48 can find out what a `Phi` is by going back one page in chapter 3.

## Which of the four tiers this part constrains

All four, but not equally, and the asymmetry is the book's structural hinge.

| Tier | What Part 0 fixes |
| --- | --- |
| **I** — register interpreter | The answer. Whatever the interpreter prints is the oracle every other tier is measured against (`tests/helpers/tiers.ts`, `oracle`). |
| **B** — baseline (bytecode → JavaScript) | Nothing of its own. It must reproduce the interpreter's answer exactly. |
| **J** — optimizing JIT (→ WebAssembly) | It may guess, because a failed guess deoptimizes back into I. Chapter 1 states the licence; Part VIII spends it. |
| **N** — native (→ ELF / PE) | It may not guess, because there is nothing under it. Where J inserts a guard, N must prove the fact or refuse the program. Chapter 1 is the first refusal. |

The three chapters carry the badge `⟨I · B · J · N⟩` because each constrains all four.
From Part I onward most chapters constrain fewer, and say which in the heading.

## The chapters

- **1. Two Answers, One Program** — `queue.tera`: the interpreter answers, the compiler
  refuses, and once upon a time the binary answered something else. The tier map, the
  `differential()` instrument, and how to read the book.
- **2. What tera looks like** — the surface syntax, taught only as far as `stats.tera`
  and the seven variations need it, plus every deviation from JavaScript that bites later.
- **3. One program, fourteen forms** — `total += this.values[i]` rendered as source,
  tokens, AST, semantic AST, checked AST, bytecode, feedback, baseline JavaScript, SSA,
  optimized SSA, wasm, MachineIR, assembly and ELF.

## What Part I receives

A checked, running program; a reader who can read it; and a diagram of where every later
chapter sits. Part I (`[Ch 4 § characters-to-tokens]`) starts at the first character of
`stats.tera` and does not assume anything Part 0 did not establish.
