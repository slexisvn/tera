# Part V — The program gets hot   ⟨I · B · J⟩

> **Status:** outline

**Length.** 2 pages

## What this stage owes everything downstream

- Parts III and IV left one artifact: a `RegisterCompiledFunction` with an instruction
  array, a constant pool, a register count — and a `feedbackSlotCount` that nothing has
  used yet. Part V is where that number acquires meaning.
- **The one thing this part owes the rest of the book:** every speculation the optimizing
  compiler makes in Parts VI–VIII is *paid for here*. The JIT never observes a running
  program. It reads a `FeedbackVector` and an `InlineCache` chain that the interpreter and
  the baseline compiler filled in, and it trusts them enough to emit code that is wrong if
  they lied. `FeedbackNexus` (`src/feedback/nexus/index.ts`) is the whole width of that
  contract — nine methods, and everything the optimizer knows about the program's runtime
  behaviour arrives through them.
- The ahead-of-time compiler (Part IX) reads **none** of this. It is handed the same
  `RegisterCompiledFunction` and must prove from types what the JIT is allowed to guess
  from observation. That asymmetry — *guess and check* versus *prove or refuse* — is the
  book's spine, and Part V is the half of it that guesses.
- Two structural facts established here are load-bearing later:
  - A feedback slot's state only ever moves **up** the lattice
    (`FeedbackSlot._advanceLattice`, `src/feedback/vector/index.ts`). Nothing demotes a
    site. A program that is briefly polymorphic during warm-up stays polymorphic.
  - There is no global cache invalidation. Every cached IC handler re-checks map id, map
    version and deprecation *on every hit*
    (`FieldHandler.matches`, `src/feedback/ic/index.ts`).

## Which of the four tiers this part constrains

| | interpreter | baseline | JIT | native |
| --- | --- | --- | --- | --- |
| **33** Feedback | records | records | reads | — |
| **34** Inline caches | uses | uses | reads the *vector*, not the IC | — |
| **35** Back edges & tiering | polls | polls | is the destination | — |
| **36** The baseline compiler | shares its frame | is the subject | tiers up from it | — |
| **37** On-stack replacement | enters from | enters from | is the destination | — |

Badge convention (`CONVENTIONS.md` §12): `⟨I · B · J · N⟩`; each chapter heading carries
only the letters it binds. **No chapter in Part V binds N.** A native binary has no
feedback vector, no inline cache, no back-edge poll and no tier to move to.

## The chapters

- **33. Feedback: what the interpreter learns** — slots are allocated at bytecode-generation
  time as trailing operands, typed on first execution by a scan of the instruction stream,
  and advance through a four-state lattice that only moves up.
- **34. Inline caches** — a per-site handler chain keyed `funcName#fnId:slot`, in which
  *absence* is a stronger claim than presence, and the prototype handlers pin an entire
  chain by object identity.
- **35. Back edges: safepoints, budgets, and the tiering policy** — one hook does two
  unrelated jobs, and the loop budget is a product of bytecode length, not an iteration
  count.
- **36. The baseline compiler** — a compiler whose output is a JavaScript source string,
  whose frame is register-compatible with the interpreter's, and whose hottest trick is
  adding two tagged values without untagging them.
- **37. On-stack replacement** — an invocation counter cannot help a program with one long
  loop, so entering a loop already in flight means making its header the function's entry.

## What the running example can and cannot reach

> `docs/example/stats.tera` never gets hot. `Series.mean` runs a five-element and a
> four-element loop, twice; `report` and `label` are each called twice. Nothing in the file
> crosses `baselineThreshold` (8) or `jitThreshold` (50), and no loop comes within three
> orders of magnitude of the loop budget. Part V therefore reaches the tiers the way the
> engine's own instrument does — by lowering the thresholds:
>
> ```
> node dist/cli.js --always-opt --trace-opt docs/example/stats-poly.tera
> ```
>
> `stats-poly.tera` calls `report` three times, which is enough for `--always-opt`
> (baseline 2, JIT 3) to walk one function through all three managed tiers in one run. For
> on-stack replacement no threshold helps — a five-iteration loop cannot be entered
> mid-flight — so [Ch 37 § worked-example] verifies through
> `tests/e2e/optimizing/baseline-osr.test.ts` instead, and says so.

## What leaves this part

A `RegisterCompiledFunction` carrying:

- `feedbackVector` — one `FeedbackSlot` per allocated slot, each holding an `icState`, the
  map ids / call targets / elements kinds it observed, and an `isStable` flag;
- `osrCache` — bytecode offset → compiled OSR entry, or `null` for "asked and refused";
- `baselineCode` — a JavaScript function, possibly with `_call0`/`_call1`/`_call2`;
- `callMode` — the dispatch decision, one of five constants (`updateCallMode`).

Part VI takes the first of these and builds SSA from it.
