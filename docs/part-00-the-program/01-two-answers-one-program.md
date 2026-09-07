# 1. Two Answers, One Program   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Twenty-four lines, four machines, and one flow fact about the length of an
array decide whether a program answers, answers *differently*, or is refused outright —
which is the book's whole subject, before any machinery.

**What arrived.** Nothing. This is the first chapter. The reader brings the ability to
program and no compiler background.

**What leaves.** Three things: `docs/example/queue.tera` and the two answers it produces;
a map of the four tiers naming what they share (one bytecode, one object model, one set of
type facts) and what they must agree on (the answer); and the instruments — `differential()`,
the tier badges, the five honesty markers, "Verify it yourself".

**New ideas.** *Tier* (one engine, four machines for the same bytecode). *Speculation
versus proof* (a guess you can undo versus a fact you must establish). *Flow fact /
narrowing* (what a test proves about a value, and where that proof stops holding).
*Partial operation* (`shift()` answers `int | undefined`, and why that is the honest type).
*Differential testing* (compare tiers against each other, not against a golden file).
*Refusal as an answer* (a compiler that says no is not a compiler that failed).

**Length.** 14 pages

## Anchors

- `src/frontend/checker/length-bounds.ts` — the transfer function. `provenTakes(body)` is
  the only export; the work is in the private class `Bounds`. `guarded()` reads a length
  test and writes a count; `takes()` spends one and adds the callee to the proven set;
  `adds()` repays one; `apart()` runs a nested function or loop body in an isolated count
  and forgets everything it consumed; `merge()` folds branch arms with `leastRemaining`
  (a `Math.min`, because the count is a *lower* bound). `RUNS_REPEATEDLY`,
  `CARRIES_ITS_OWN_SCOPE` and `RUNS_LATER` are the three tables that decide when a region
  is untrustworthy.
- `src/core/indexing.ts` — the arithmetic, 62 lines and shared with the optimizer.
  `provenCount(op, bound, negated)` turns a test into a number: `> n` proves `n+1`,
  `>= n` and `== n` prove `n`, `!= 0` proves `1`, anything else proves nothing.
  `COMPLEMENT` handles the refuted arm. `TAKES_ONE_ELEMENT = {pop, shift}` and
  `ADDS_ONE_ELEMENT = {push, unshift}` are the entire model of what changes a length.
- `src/frontend/checker/binder.ts` — the wiring. `BoundProgram.provenTakes` is computed
  once, over the whole program body, at bind time (`provenTakes: provenTakes(program.body)`).
  A fact about the *shape* of the source, not about a scope.
- `src/frontend/checker/infer.ts` — the consumer, at `inferCall`: if
  `bound.provenTakes.has(node.callee)` then `removeNullish(answered, bound.env)`, else the
  declared answer stands. One `if`, and it is the entire narrowing.
- `src/frontend/checker/type-system.ts` — `Binding`, the record a name resolves to.
  The field `filled?: boolean` used to live here; the working tree deletes it. The
  chapter's history beat is this one line.
- `src/api/engine.ts` — `class Engine`, `EngineOptions`, and the AOT gate.
  `compileInRuntime(source, options, aot)` sets `const mode = aot ? STRICT_TYPECHECK : this.typecheckMode`,
  and `if (mode === STRICT_TYPECHECK && this.diagnostics.length > 0) throw new TypecheckError(...)`.
  `compileAot` and `compileAotModule` are the two doors into it. `runNative`,
  `runModuleGraphNative`, `collectFunctions` are the interpreter-side entries.
- `tests/helpers/tiers.ts` — the instrument. `TIERS` names seven configurations by
  threshold (`oracle` pins both thresholds at `1e12`; `jit` at 30/3; `eager` at 3/2/3).
  `differential(source, {tiers})` runs the oracle, then every named tier, and
  `expect(...).toEqual(expected)`. `PRINTS_INSTEAD_OF_ANSWERING` is the guard rail that
  throws when a source ends in `print(` — the helper compares answers, not stdout.
  `differentialModules` does the same across files; `tierUp` returns one function's
  compiled artifact.
- `src/runtime/tiering/defaults.ts` — `DEFAULT_TIERING_POLICY`: `baselineThreshold: 8`,
  `jitThreshold: 50`, `loopOsrThreshold: 30`, `maxDeoptCount: 3`. The numbers on the map.
- `src/optimizing/baseline/compiler.ts` — `class BaselineCompiler`. Line 86 is
  `new Function("args", "tv", "$", "pc", "env", body)`: tier 1 emits JavaScript *source*
  and lets the host compile it.
- `tests/frontend/checker/type-checker.test.ts` — `describe("advice on a value that may be absent")`
  and the `ABSENCE` regex that pins the remedy sentence.

## Worked example

`docs/example/queue.tera`, nine lines, run three ways on one page.

```
fn drain(q: int[]) -> int:
  total = 0
  while q.length > 0:
    a = q.shift()
    b = q.shift()
    total += a + b
  return total

print(drain([1, 2, 3, 4]))
```

| Way | Command | Answer |
| --- | --- | --- |
| interpreter | `node dist/cli.js docs/example/queue.tera` | `10` |
| checker, run path, strict | `node dist/cli.js --typecheck strict docs/example/queue.tera` | refused, exit 1 |
| ahead of time | `node dist/cli.js compile docs/example/queue.tera -o queue.exe` | refused, exit 1 |

Both refusals are the same sentence, verbatim (`docs/CONVENTIONS.md` rule 5):

```
6:18 Operator '+' cannot be applied to 'int' and 'int | undefined'
  (the value may be absent: guard it before use, or spell a fallback with ??)
```

`while q.length > 0` proves the *first* `shift()` is total. It proves nothing about the
second. The interpreter never asks; the native compiler cannot avoid asking.

The oracle side of the same instrument, for contrast with the diff:
`node dist/cli.js --no-opt docs/example/queue.tera` also prints `10`, and so does
`--always-opt` — three tiers agree, and the fourth declines to exist.

## Outline

- [ ] **§ the-cold-open** — Show `queue.tera`, the interpreter's `10`, and the compiler's
      refusal, before explaining anything. Establish that this is not a bug report: it is
      the book's subject. Establish the reading contract — every command in a grey box was
      run.
- [ ] **§ what-shift-answers** — Establish that `shift()` on `int[]` answers
      `int | undefined`, that this is the honest type for a partial operation, and that the
      alternative (answer `0`, or trap) turns an empty-queue `a + b` into a silent wrong
      number. `> **New idea.**` partial operation and option type. Cite
      `tests/e2e/optimizing/aot/drain-absence.test.ts` for what an empty take actually
      does in a binary.
- [ ] **§ what-a-guard-proves** — `q.length > 0` narrows the first `shift()` and nothing
      else. Walk `provenCount(">", 0)` → `1`, then `takes()` spending it to `0`, then the
      second `shift()` finding nothing left. `> **New idea.**` flow fact, and the
      difference between "true here" and "true from here on".
- [ ] **§ why-the-obvious-design-fails** *(Why the obvious design fails)* — Stage the
      design a reader reaches for first: a boolean on the binding, set by the guard.
      That was `Binding.filled` in `src/frontend/checker/type-system.ts`, generated by the
      guard and killed by nothing — including by the very call that falsifies it. Show the
      shape of the bug, then the general rule it produced: *a refinement about mutable
      state must name what kills it; carry the quantity and spend it.* Note the date
      (2026-09-06) and that the working tree deletes the field.
- [ ] **§ two-answers-then-and-now** — The historical divergence: with the sticky boolean,
      the odd-length `drain([1, 2, 3])` printed `NaN` from the interpreter and `0` from the
      binary, because the checker typed `b` as `int` and AOT emitted integer arithmetic
      over absence. Today the same program is refused. **But the divergence is still
      reachable** — see the honesty items: `splice` is not in `TAKES_ONE_ELEMENT` and
      reproduces both answers on today's tree. Establish that a book about agreement must
      be able to show a live disagreement, and that this one is it.
- [ ] **§ the-four-machines** — The map. Register interpreter
      (`src/bytecode/register/interpreter/`), baseline compiler emitting JavaScript
      (`src/optimizing/baseline/compiler.ts`, `new Function(...)`), optimizing JIT emitting
      WebAssembly (`src/optimizing/backends/wasm/`), AOT native compiler emitting ELF/PE
      (`src/optimizing/backends/{x64,riscv64,c}/`). One mermaid diagram, the real
      thresholds from `DEFAULT_TIERING_POLICY`. `> **New idea.**` tier, threshold, back edge.
- [ ] **§ what-they-share** — One bytecode, one object model, one set of type facts, one
      middle end. Establish that the shared middle end is why the book is in pipeline order
      rather than one part per engine.
- [ ] **§ the-hinge** — What they must agree on: the answer. And the asymmetry that
      produces two roads out of the middle end — the JIT may guess because a failed guess
      deoptimizes into the interpreter; the native compiler may not, because there is
      nothing under it. Forward-reference `[Ch 54 § deoptimizing-out-of-wasm]` and
      `[Ch 55 § the-same-graph-with-no-way-out]`.
- [ ] **§ the-instrument** — `differential()` in `tests/helpers/tiers.ts`. Read the seven
      `TIERS` entries as *thresholds, not switches*. Explain why the helper refuses a source
      ending in `print(` (`PRINTS_INSTEAD_OF_ANSWERING`): comparing stdout would have let a
      tier that returns the wrong value pass. Establish that this one helper is the book's
      evidence base and appears in every later part.
- [ ] **§ the-gate** — Where refusal actually happens: `Engine.compileInRuntime` with
      `aot = true` forces `STRICT_TYPECHECK` regardless of `EngineOptions.typecheck`, so
      the AOT road always runs the checker in strict mode and throws `TypecheckError` on
      the first diagnostic. Three doors reach it — `tera compile`, `tera check`, and
      `--typecheck strict` — and all three print the same sentence and exit 1.
- [ ] **§ how-to-read-this-book** — Tier badges `⟨I · B · J · N⟩` on every heading; the
      five honesty markers plus `> **Unenforced.**`; "Verify it yourself" as the anti-rot
      mechanism; excerpts capped at 20 lines with file and line captions; behavioural
      claims carrying a verbatim test title or `[unpinned]`. The three reading paths from
      `docs/README.md` (front end 1–3, 4–16, 73–75; JIT road 1–3, 17–24, 33–40, 41–54, 80;
      AOT road 1–3, 9–16, 38–50, 55–72, 81).
- [ ] **§ what-leaves** — The program, the map, the instruments. Hand to chapter 2, which
      teaches enough of the surface to read the next thousand pages of listings.

## Honesty items

- `> **Broken.**` — `TAKES_ONE_ELEMENT` and `ADDS_ONE_ELEMENT` in
  `src/core/indexing.ts` model `pop`/`shift`/`push`/`unshift` and nothing else, but
  `data/tera-language-spec.ts` also defines `splice`, which changes a length. The
  length-bounds analysis therefore still narrows an absence away that a `splice` has made
  real. Measured on this tree: a five-line function under `if q.length > 0` that calls
  `q.splice(0, 1)` and then `q.shift()` prints `NaN` from the interpreter and `0` from the
  native binary, and `tera check` accepts it silently and exits 0. This is the same class
  of divergence as the `Binding.filled` bug, through a different door. Fixing it costs a
  `provenCount`-style transfer rule for `splice` (its second argument is a delete count,
  and its rest arguments are inserts) plus a decision about what to do when either is not
  a literal — most likely `NEVER_PROVEN`.
- `> **Unenforced.**` — nothing checks that `TAKES_ONE_ELEMENT ∪ ADDS_ONE_ELEMENT` is the
  complete set of length-changing array members. The transfer function's exactness rests
  entirely on that closure; no test imports either constant, and no `satisfies` constraint
  ties them to the array surface in `data/tera-language-spec.ts`. The item above is what
  that gap costs.
- `> **Never runs.**` — `Engine.diagnostics` in the default `warn` mode. The checker runs,
  produces the diagnostic, stores it on the field — and nothing in `src/` ever reads it
  outside the strict-mode throw at `src/api/engine.ts`. `node dist/cli.js --typecheck warn
  docs/example/queue.tera` prints `10` and not one word about the absence. The only reader
  in the tree is a test. Reporting it costs one loop in `src/cli/main.ts`'s `runProgram`,
  and a decision about whether a warning should change the exit code.
- Historical, not current: labeled `continue` used to loop forever.
  `docs/example/labeled.tera` uses `continue outer`, and it now prints `1 2 3 5 6 7` and
  exits 0. The fix was to stop letting the labeled statement patch a target it does not
  own: it registers the label in `_pendingLoopLabels`
  (`src/bytecode/register/compiler/statements.ts:668-689`) and `enterLoop`
  (`helpers.ts:131-145`) hands it to the loop context that owns the latch. Named here
  because chapter 1 introduces the example set; told as engineering in
  `[Ch 19 § the-jump-nobody-patched]`.
- Historical, not current: the `NaN` / `0` divergence attributed to `Binding.filled` is
  **not** reproducible on this tree through a second `shift()`. Today that program is
  refused. The chapter must say so in the same breath it tells the story, or it becomes a
  second source of truth (`docs/CONVENTIONS.md` rule 7).

## Verify it yourself

```bash
# the interpreter answers
node dist/cli.js docs/example/queue.tera

# the same gate the compiler uses, opened by hand on the run path
node dist/cli.js --typecheck strict docs/example/queue.tera; echo "exit=$?"

# ahead of time: the same sentence, and no binary
node dist/cli.js compile docs/example/queue.tera -o /tmp/queue.exe; echo "exit=$?"

# a program that does compile, cross-built to a Linux ELF from any host
node dist/cli.js compile docs/example/stats.tera --target x64 --platform linux -o /tmp/stats-linux

# the transfer function, one take at a time
npx vitest run --project unit tests/frontend/checker/length-bounds.test.ts

# every example file prints what this book says it prints
npx vitest run --project e2e tests/e2e/docs/book-examples.test.ts
```

## Tests that pin this

- `tests/e2e/docs/book-examples.test.ts` > `"queue.tera runs in the interpreter but is refused ahead of time"`
  — the cold open itself: asserts the printed `10` and that the refusal contains
  `Operator '+' cannot be applied to 'int' and 'int | undefined'`.
- `tests/e2e/docs/book-examples.test.ts` > `"covers every example file, so a new one cannot be added untested"`
  — the guarantee that no chapter can quietly add a ninth variation.
- `tests/e2e/docs/book-examples.test.ts` > `"stats.tera is the twenty-four lines the book claims"`.
- `tests/e2e/docs/book-examples.test.ts` > `"labeled.tera resumes the outer loop instead of restarting the program"`
  — runs the file and asserts it prints `1 2 3 5 6 7`.
- `tests/frontend/checker/length-bounds.test.ts` > `"proves the first take and refuses the next"`
  — the exact `queue.tera` shape, asserting only line 3 is proven.
- `tests/frontend/checker/length-bounds.test.ts` > `"counts a put back towards the take that follows it"`
  — `push` repays what `shift` spent.
- `tests/frontend/checker/length-bounds.test.ts` > `"proves as many takes as the guard counted"`
  — `>= 2` licenses two takes, not one.
- `tests/frontend/checker/length-bounds.test.ts` > `"proves nothing about a take inside a nested function"`
  and > `"a take a loop may repeat"` › `"proves nothing about the take itself"` — why
  `apart()` exists.
- `tests/core/indexing.test.ts` > `"counts one more than a bound the count must exceed"`
  and > `"reads a negated test as its complement"` — `provenCount`'s arithmetic.
- `tests/frontend/checker/type-checker.test.ts` > `"stays quiet once a length test has ruled the absence out"`
  and > `"stays quiet once a fallback spells what an empty collection answers"` — the two
  ways out named in the remedy sentence.
- `tests/frontend/checker/type-checker.test.ts` > `"leaves a mismatch that absence does not explain without the advice"`
  — the advice is not glued to every diagnostic.
- `tests/e2e/optimizing/aot/drain-absence.test.ts` > `"answers undefined only after the last element is taken the way the interpreter does"`
  and > `"keeps a shift-driven queue answering every element the way the interpreter does"`
  — what a *correct* drain does in a native binary.
- `tests/e2e/language/types.test.ts` > `"supports off, warn, and strict modes"` — the only
  reader of `Engine.diagnostics` in warn mode anywhere in the tree.
