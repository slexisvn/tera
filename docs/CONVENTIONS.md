# Conventions

Rules for writing this book. They exist because the engine has a hard no-comment rule —
26 comment lines in 120,822 — so this book is the only prose that describes it. That
makes accuracy the whole job.

There is no build step and no generator. Every rule below is enforced by a human
reviewer, which means each one is written to be cheap to check.

## The running example

1. **One program, one file, in the tree.** `docs/example/stats.tera` and its named
   variations are the source of every listing. No chapter invents a snippet to make a
   point. If a stage needs a different shape, it gets a variation file that also runs in
   `tests/e2e/docs/book-examples.test.ts`.
2. **Say when the example cannot reach.** `stats.tera` will never exercise the arena
   collector, the generational write barrier, riscv64's stack probe, proxies or WeakMaps.
   A chapter in that position states the limit in its opener rather than contriving a
   ninth variation.

## Quoting the code

3. **Excerpts are at most 20 lines** and always carry a caption naming file and lines:
   `— offside.ts:46-111`. Anything longer is described and linked, never pasted. Short
   excerpts are what make a stale quote cheap to re-check.
4. **The code's names win.** Never rename a concept for the book's convenience. Where a
   name is actively misleading — `loopUnrolling` peels guards and never unrolls,
   `EphemeronHashTable` implements no ephemeron algorithm — say so once in the chapter
   that meets it, then keep using the code's name.
5. **Refusals and diagnostics are quoted verbatim.** In this engine the user-facing
   sentence is the most accurate available specification of a limit. Where the first
   message names a downstream symptom rather than the cause — a recurring pattern here —
   show both messages.

## Being honest

6. **Five honesty markers.** Each names a file and a symbol and says what finishing it
   would cost. Every one is also copied by hand into `appendix/d-inventory.md`.

   - `> **Dead.**` — present in the tree, unreachable.
   - `> **Never runs.**` — reachable, but nothing calls it.
   - `> **Broken.**` — present, and produces a wrong answer.
   - `> **Measured worse.**` — complete, correct, tested, and switched off because the
     numbers said so.
   - `> **Unfinished.**` — present, incomplete.

7. **Invariant → enforcement → test.** Name the invariant, show what enforces it (a
   verifier, an assertion, a `satisfies` constraint, a derived table), then the test that
   pins it. If nothing enforces it, earn a `> **Unenforced.**` callout. This book may be
   the comment layer the codebase lacks; it may not become a second source of truth.
8. **Behavioural claims cite a test by verbatim title**, e.g.
   `[t: tests/frontend/lexer.test.ts > "unindent does not match any outer indentation level"]`.
   In a zero-comment codebase a test title *is* the design document. A claim that cannot
   be pinned to a test is marked `[unpinned]` rather than quietly asserted.
9. **No unmeasured performance language.** A pass is "not measured", never "cheap".
   There is no benchmark harness in this tree, so every number states where it came from
   and that it was taken one case per fresh process.

## Teaching

10. **`> **New idea.**` primers.** This book's reader can program but has not built a
    compiler. The first time a chapter needs basic blocks, SSA, a phi, dominance, a
    lattice, a fixpoint, IEEE-754 bit layout, a calling convention or a relocation, it
    gets a short boxed primer *at that point*. Concepts are never assumed, and never
    front-loaded into a theory chapter — that would break the one-program spine.
11. **Chapters hand over.** Every chapter opens with **What arrived** (the exact artifact
    the previous stage produced) and closes with **What leaves**. A chapter that cannot
    state both is in the wrong place and gets moved.
12. **Tier badges** on every chapter heading, and on any section that binds only some of
    the four machines: `⟨I · B · J · N⟩` for interpreter, baseline, JIT, native.
    Pipeline order makes "which of the four does this constrain?" harder to answer than
    an engine-per-part order would; the badge closes that gap for free.
13. **Every chapter ends with "Verify it yourself"** — three to six exact commands that
    reproduce its central claim. If the central claim cannot be reproduced from a command,
    the chapter says why in one sentence. These commands are also the book's defence
    against rot: a stale chapter is discovered by running it.
14. **Two privileged but optional sections**, used only where the tree records real
    material: *"Why the obvious design fails"* (stage the design a reader would reach for
    first, then the program that breaks it) and *"What was tried and rejected"*. Neither
    is ever mandatory — a mandatory template is exactly what makes a book invent failures.
15. **Bugs are told as engineering**: observable symptom, mechanism, fix, regression test,
    and the general rule it produced. A war story with no general rule is cut.

## Mechanics

16. **Diagrams are Mermaid fences.** GitHub renders them natively, so there is nothing to
    build. Control-flow graphs, dominator trees, the pass pipeline, the tier state machine
    and the promise/microtask cycle are ```mermaid blocks; reusable ones live in
    `figures/*.mmd`. **Byte layouts are fixed-width ASCII tables**, so a moved offset is
    visible in a diff. No decorative figures.
17. **Cross-reference by number and slug** — `[Ch 48 § speculative-taint]` — never "see
    above" or "as discussed earlier". Chapters must survive reordering and must be
    readable out of sequence on any of the three reading paths.
18. **Terminology is fixed by `GLOSSARY.md`.** This matters unusually much here, because
    the same English word means different things in two engines: a *handle* in the JIT is
    a wasm linear-memory offset, while an AOT root slot is deliberately **not** a handle;
    and *map* / *hidden class* / *shape* / *class-table entry* name four different things
    across the tiers.
19. **Sibling repositories are boundaries, not chapters.** `mlfw`, `query_engine`,
    `quantc`, `reactive` and the `peta`/`petahub` package manager appear only where a
    value crosses into them, described by their interface — what `taggedToNative` sends
    and what `nativeToTagged` receives — never by their internals.

## File layout

Chapter numbers are **global and stable (01–83)**. Part directories are grouping only, so
a chapter can move between parts without a rename. Chapter files are
`NN-kebab-title.md`; each part carries a `_part.md` opener stating what that stage owes
everything downstream.
