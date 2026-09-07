# 16. Warnings as Errors: The Day the AOT Gate Flipped   ⟨— · — · — · N⟩

> **Status:** outline

**Thesis.** Strict mode adds no checks — `TypeChecker.strict` picks a word in one field — so
the entire ahead-of-time contract is one caller deciding that a non-empty diagnostics array
means refuse; and flipping that switch on a suite that already existed is the cheapest
exhaustive test a checker will ever get.

**What arrived.** From [Ch 15 § what-leaves]: a `ModuleCheckResult` whose `diagnostics` field
spans every module in the program, each entry tagged with its `module` and `path`. Plus the
four things every earlier chapter in this part deposited on the way through — `_paramInfo`
and `_returnType` written back onto the AST ([Ch 11]), `ClassSurface[]` ([Ch 12]), canonical
type text ([Ch 9]).

**What leaves.** For three tiers: an AST, unchanged, plus advice printed to stderr. For the
fourth: either the same AST or a `TypecheckError` and no binary. Ch 17 receives the AST and
does not care which mode produced it — the checker is not in the bytecode compiler's input
path at all.

**New ideas.** Diagnostic severity as policy rather than fact; *soundness* versus
*completeness* in one paragraph, since this is the chapter where the checker's incompleteness
becomes a refusal; property-based / fuzz testing over a specification table.

**Length.** 10 pages

## Anchors

- `src/frontend/checker/diagnostics.ts` — 27 lines, the entire severity model.
  `TypecheckMode = "off" | "warn" | "strict"`, `Diagnostic` (line, column, message,
  severity), `TypecheckError` (which joins its diagnostics into the `Error` message), and
  `diagnostic(line, column, message, strict)` whose whole body is
  `severity: strict ? "error" : "warning"`.
- `src/frontend/checker/type-checker.ts` — `strict: boolean` (line 46), assigned in the
  constructor (line 53), and read at **exactly one place**: `add()` (line 1253),
  `this.diagnostics.push(diagnostic(line, column, message, this.strict))`. Also
  `isUnknownish` (1058-1070) with 33 call sites in this file, and `check()` (line 57)
  returning the array.
- `src/frontend/checker/index.ts:74` —
  `mode === "off" ? [] : new TypeChecker(bound, mode === "strict").check()`. The three modes
  collapse to two booleans: run or not, and error or warning.
- `src/api/engine.ts` — `STRICT_TYPECHECK` (line 143); `typecheckMode` defaulting to
  `"warn"` (line 765); and the gate, twice, identically:
  `const mode = aot ? STRICT_TYPECHECK : this.typecheckMode` (lines 1187 and 1388) followed
  by `if (mode === STRICT_TYPECHECK && this.diagnostics.length > 0) throw new
  TypecheckError(this.diagnostics)` (lines 1205-1207 and 1426-1428). Note line 1192:
  `if (aot || mode !== "off")` — an AOT compile checks even when the caller said `off`.
- `src/cli/spec.ts` — `TYPECHECK_FLAG` (line 123), and where it is *not*: the flag lives in
  the run command's flag set, so `tera compile --typecheck warn` answers
  `unknown option '--typecheck' for 'compile'`.
- `src/frontend/ast/index.ts` — `adoptContextualSignature` (line 300) writing `_paramInfo`
  (line 322) and `_returnType` (line 323) back onto the node; `declaredParamInfo` (line 297)
  reading them.
- `src/bytecode/register/compiler/functions.ts` — `declaredSignatureOf` (line 165) and
  `innerFunc.declaredSignature = …` (line 715). This is the only route by which any checker
  output reaches the optimizing tiers.
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` — 1,400+ lines, 23 tests, one linear
  congruential generator seeded `0xdecafbad` (line 22). `expectDiagnosticsInSource`
  (line 45) is the position invariant; `expectNoDiagnostics` and `expectDiagnostic`
  (271-297) both call `checkSource(source, "strict")`. Both `TERA_BUILTINS` and
  `TERA_CHART_METHODS` are enumerated, so the spec table is the corpus.

## Worked example

One of the nine bugs, chosen because it is the direct consequence of [Ch 13]'s narrowing.

*The program.* A linked node whose `next` field is assigned a value and later cleared:

```
class Node:
  public constructor(v: int):
    this.v = v
    this.next = null
a = Node(1)
a.next = Node(2)
a.next = null
```

*Before.* The write to `a.next` was checked against the type the field had been *narrowed*
to by the previous store — `Node` — so `a.next = null` was rejected. Under `warn` this was a
line of advice on a program that ran perfectly; under the gate it was a refusal to compile.

*After.* `declaredMemberType` (`infer.ts:234`) supplies the declared type for an assignment
target, the same shape as the `widens` field does for locals ([Ch 13 § the-widens-field]).

```bash
node dist/cli.js check -e 'class Node:
  public constructor(v: int):
    this.v = v
    this.next = null
a = Node(1)
a.next = Node(2)
a.next = null
print(a.v)'
```
→ silent.

*The class of program it had been mistyping:* every mutable optional field — a linked list,
a cache slot, a parent pointer. None of them could be compiled ahead of time, and nobody
knew, because in `warn` mode a warning on a working program is easy to ignore.

## Outline

- [ ] **One field, one word.** Establish the smallest true statement about strict mode:
      `TypeChecker.strict` is read once, in `add()`, and its only effect is
      `severity: "error"` instead of `"warning"`. Show `diagnostics.ts` whole — 27 lines,
      under the 20-line excerpt rule if you cut the `TypecheckError` constructor. Establish
      what this rules out: there is no second analysis, no extra pass, no stricter
      assignability rule. Every diagnostic a strict compile reports was already being
      computed for every `tera run`.
- [ ] **New idea: severity is policy.** Primer — a type checker produces facts; whether a
      fact stops the build is a decision made elsewhere. Establish where "elsewhere" is:
      `engine.ts:1187` and `:1388`, two lines that read `aot ? STRICT_TYPECHECK :
      this.typecheckMode`, and the two `throw`s that follow. Establish the third line that
      completes the contract, `if (aot || mode !== "off")` at 1192 — an AOT compile checks
      even when the caller explicitly turned checking off. There is no way to reach the
      native backend without a clean diagnostics array.
- [ ] **Why the native tier and not the others.** Establish the reason from Part 0's thesis:
      the JIT may guess because it can deoptimize; the native compiler cannot. A `float |
      string` return has a representation in the interpreter's tagged value ([Ch 22]) and no
      representation in a machine register ([Ch 55]). So the checker is *optional advice*
      for three tiers and a *precondition* for the fourth, and the badge on this chapter is
      `⟨— · — · — · N⟩`.
- [ ] **Deleting the flag.** Establish what `--typecheck` used to do on `tera compile` and
      why it had to go: a flag that can only be set to the one value that already holds is
      not a flag. Establish the current surface — `TYPECHECK_FLAG` is on the run command,
      `tera compile --typecheck warn` answers
      `unknown option '--typecheck' for 'compile' (see 'tera help compile')`, and
      `node dist/cli.js help compile` lists no Types group. **What was tried and rejected**
      goes here in one beat: the flag was kept for one revision as a way to build a binary
      from a warning-carrying program, and removed because there is no such binary.
- [ ] **72 tests, half of them real.** Tell the flip as engineering. *Symptom* — turning the
      gate on made 72 e2e tests fail at once. *Triage* — roughly half were genuine type
      errors in terse test sources that should never have compiled; the other half were
      checker bugs on programs that ran correctly. Establish the general rule this produced,
      because it is the chapter's second thesis: **a warning-only checker accumulates bugs
      silently, because nothing forces anyone to read the output.** The gate did not find the
      bugs; the gate made someone read them.
- [ ] **The nine.** List them as an inventory, one line each, each naming the file that
      changed — they are told in full in the chapters that own them, and this is the index:
      `Error` missing from `data/tera-language-spec.ts`; a class with no constructor not
      inheriting its parent's signature (`binder.ts`, [Ch 12]); assignment to a field checked
      against the narrowed type (`declaredMemberType`, this chapter's worked example);
      `x == null` rejected once narrowing made the type non-nullable ([Ch 13]); array-method
      callbacks missing their index parameter and `sort`'s comparator typed `-> int`
      (`infer.ts`'s `arrayMethodSignature`, [Ch 11]); method type strings dropping parameter
      names and optionality (`classMethodType`, [Ch 12]); `splitTopLevel` not tracking `<>`
      so `Promise<int | int>` split into garbage and `await` stopped unwrapping
      (`src/core/type-text.ts`, [Ch 9]); `Math.floor` and friends returning `float` in a
      language with no float-to-int cast; and the scoping one — a bare assignment inside a
      function is a function local at run time, and the checker was binding it in the block
      scope, fixed by `Scope.boundary` ([Ch 8 § one-boundary-flag]).
- [ ] **What the checker actually hands downstream.** Establish the four artifacts and,
      for each, exactly who reads it — because after this chapter the checker is done and it
      matters what survived. `_paramInfo` / `_returnType` written back by
      `adoptContextualSignature` (`ast/index.ts:322-323`), read by `declaredSignatureOf`
      (`compiler/functions.ts:165`) and reaching only `RegisterCompiledFunction.declaredSignature`.
      `ClassSurface[]`, read by `buildClassTable` and only when `aot` ([Ch 57]). Canonical
      type text from `cleanType`, read by the lattice ([Ch 48]) and the symbol table
      ([Ch 74]). The `Diagnostic[]`, read only by `engine.ts`. Establish the consequence
      plainly: **the interpreter and the baseline compiler read none of it**. The bytecode
      compiler walks the raw AST.
- [ ] **New idea: soundness and completeness.** Primer, one paragraph, no theory chapter — a
      checker is *sound* if everything it accepts is safe, *complete* if everything safe is
      accepted. Establish which one this checker chose and why the choice is invisible until
      the gate flips: incompleteness under `warn` is a false alarm you ignore; incompleteness
      under the gate is a program you cannot build.
- [ ] **The honest inventory: `any` is a hole with 33 doors.** Establish `isUnknownish`
      (`type-checker.ts:1058-1070`): it resolves aliases, answers true for `any` and
      `unknown`, and then recurses — through union parts, through array elements, through
      tuple slots. So `int | any` is unknownish, and `any[][]` is unknownish. Establish that
      it is consulted 33 times in `type-checker.ts`, each an early `return` that suppresses a
      whole check. One `any` anywhere in a type disables checking for every expression it
      touches. This is deliberate — it is what keeps the gate from refusing every program
      that calls an untyped builtin — and it is the largest single gap.
- [ ] **The honest inventory: source order is semantics.** Establish that the checker walks
      `program.body` once, in order (`check()` → `checkStatements`), so a call to a function
      whose return type is *inferred* and whose declaration comes *later* in the file sees
      nothing and answers `any`. Demonstrate with the same program written twice: `fn use()
      -> int: return later()` above `fn later(): return "text"` is silent; swap the two and
      the checker reports `Type 'string' is not assignable to return type 'int'`. Establish
      the cost of fixing: a declaration-collection pre-pass, or the fixpoint [Ch 14]'s
      `analyzeEffects` already runs — and the reason it has not been paid, which is that the
      checker has no dependency order for value declarations, only for modules ([Ch 15]).
- [ ] **The honest inventory: two more.** Excess properties in an object literal are never
      reported — `p: P = { x: 1, y: 2 }` against `interface P: x: int` is silent, because
      `objectAssignable` checks that the required fields are present, not that no others are.
      And a bare `FunctionExpression` with no contextual type answers the string `"Function"`
      (`infer.ts:100-101`), which resolves to nothing structural, so nothing about its
      parameters or return is checked.
- [ ] **The cheapest exhaustive test.** Establish `tests/e2e/frontend/checker-spec-fuzz.test.ts`
      as the answer to "how do you keep a gate this load-bearing honest". One seeded LCG
      (`seed = 0xdecafbad`, `seed * 1664525 + 1013904223`), so a failure is reproducible.
      Every case goes through `checkSource(source, "strict")`. Establish the invariant that
      applies to *every* diagnostic regardless of what the case was testing —
      `expectDiagnosticsInSource` (line 45): integer line and column, line within the source,
      column within that line's length plus one, and severity exactly `"error"`. A checker
      that reports the right thing at the wrong place fails.
- [ ] **The corpus is the spec.** Establish that four of the 23 tests enumerate
      `data/tera-language-spec.ts` itself rather than sampling: *"covers every builtin and
      chart signature from the language spec"*, *"covers every pseudo type method and every
      kind method from the language spec"*, *"covers arity and named-argument contracts from
      the whole language spec"*, and *"resolves every declared field of record-returning
      builtins (nested + array element)"*. Establish the invariant that makes this work
      ([Ch 28]): the spec table is one source of truth, so a new builtin is checked the day
      it is added, with no test to write.
- [ ] **What leaves Part II.** Close the part. Restate the hinge from the part opener — the
      checker is optional for three tiers and load-bearing for the fourth — and hand Ch 17
      the raw AST, which is what the bytecode compiler has been going to walk all along.

## Honesty items

> **Unfinished.** `isUnknownish` suppresses 33 distinct checks in `type-checker.ts`. A single
> `any` in a union, an array element, or a tuple slot disables checking for every expression
> that type reaches. Cost of narrowing it: distinguishing "the user wrote `any`" from "the
> checker could not work it out", which needs a second sentinel type threaded through
> `TypeName` — and `TypeName` is a string ([Ch 9]).

> **Unfinished.** The checker is single-pass in source order. A call to a function declared
> later whose return type is inferred sees `any`; the identical program with the two
> declarations swapped reports the error. Reproduced in *Verify it yourself*. Cost: a
> declaration pre-pass that seeds every top-level signature before checking any body — which
> then needs a story for mutually inferred returns, i.e. a fixpoint.

> **Unenforced.** Excess properties in an object literal are never reported.
> `p: P = { x: 1, y: 2 }` against an interface declaring only `x` is silent. Nothing in
> `objectAssignable` or `checkObjectExpression` compares the literal's field set against the
> target's.

> **Unfinished.** A `FunctionExpression` with no expected type infers as the bare string
> `"Function"` (`infer.ts:101`), so neither its parameters nor its return value are checked
> anywhere. Arrow functions have a contextual path (`inferArrow`); `function` expressions do
> not.

> **Unenforced.** `TypeChecker.strict` is `public` and settable, and the invariant "the AOT
> path always runs strict" is enforced only by the two identical lines at `engine.ts:1187`
> and `:1388`. Nothing checks that a third AOT entry point, if one is added, repeats them.
> No test asserts that `compileAot` throws on a diagnostic-producing program *because* of
> the mode rather than incidentally.

> **Unenforced.** `engine.ts:1205` and `:1426` are the same four lines written twice. A
> divergence between the module path and the single-file path would not be caught: the
> module path also does `refuseRepeatedClassNames(graph)` and `buildClassTable(...)` *before*
> the throw, the single-file path does `buildClassTable` before it too — but the ordering of
> gate versus class-table construction is not pinned by any test.

## Verify it yourself

```bash
node dist/cli.js check docs/example/queue.tera
node dist/cli.js compile docs/example/queue.tera -o /tmp/queue.exe
node dist/cli.js compile docs/example/queue.tera --typecheck warn -o /tmp/queue.exe
node dist/cli.js check -e 'fn use() -> int:
  return later()
fn later():
  return "text"
print(use())'
node dist/cli.js check -e 'fn later():
  return "text"
fn use() -> int:
  return later()
print(use())'
npx vitest run --project e2e tests/e2e/frontend/checker-spec-fuzz.test.ts
```

The first two print the *same sentence*, once as advice and once as a refusal — that is the
whole of strict mode. The third answers
`tera: unknown option '--typecheck' for 'compile' (see 'tera help compile')`. The fourth is
silent and the fifth reports `Type 'string' is not assignable to return type 'int'` on the
identical program with its two declarations swapped. The suite is 23 tests, about 20 seconds.

## Tests that pin this

`tests/e2e/frontend/checker-spec-fuzz.test.ts` > `describe("checker fuzz invariants")` — all
23 run `checkSource(source, "strict")`, so every one of them also pins the position and
severity invariant:

- > "keeps assignment compatibility stable across scalar, union, and array types"
- > "fuzzes contextual arrays, spreads, tuple slots, nested indexes, and slices"
- > "fuzzes binary operator diagnostics in expressions and control-flow tests"
- > "fuzzes the typed expression surface that must not collapse to any"
- > "fuzzes the operator type matrix including equality, bitwise, membership, and tensor matmul"
- > "does not duplicate diagnostics while propagating expected types"
- > "fuzzes contextual arrow bodies from annotations and callback parameters"
- > "fuzzes function type spellings, nesting, and variance"
- > "fuzzes unary, logical, reassignment, compound assignment, and update rules"
- > "keeps call diagnostics on the offending argument or argument name"
- > "fuzzes explicit generic type arguments against argument and return checking"
- > "keeps object shape diagnostics on field values and preserves structural interface rules"
- > "keeps inference precise for loops, object members, functions, methods, and narrowing"
- > "fuzzes nullable member access, optional chaining, and symmetric narrowing"
- > "covers every builtin and chart signature from the language spec"
- > "covers every pseudo type method and every kind method from the language spec"
- > "covers arity and named-argument contracts from the whole language spec"
- > "resolves every declared field of record-returning builtins (nested + array element)"
- > "fuzzes random valid field access and keeps unknown record fields non-concrete"
- > "threads Signal/Portfolio handles into backtest and walk_forward"
- > "checks the quill product handle and its .price(...) method chain"
- > "types quant weight vectors, smoothed matrices, and scalar/array returns precisely"
- > "rejects bad params on quant builtins with a precise parameter diagnostic"

The fourth in that list — *"fuzzes the typed expression surface that must not collapse to
any"* — is the direct counterweight to the `isUnknownish` honesty item.

`tests/e2e/docs/book-examples.test.ts` > `describe("the two answers the book opens on")`:

- > "queue.tera runs in the interpreter but is refused ahead of time"
- > "stats-refused.tera runs in the interpreter but is declined by the backend"

The first is the gate itself: the same diagnostic, advice on one side and a refusal on the
other.

`tests/frontend/checker/type-checker.test.ts` — the two worked-example fixes:

- > "keeps a declared nullable field as declared"
- > "lets an assignment widen a narrowed binding back to its declared type"

That `TypeChecker.strict` has exactly one use, and that strict mode therefore adds no
checks: **[unpinned]** — the claim is a grep, not a test.

That an AOT compile checks even when `typecheck` is `"off"` (`engine.ts:1192`):
**[unpinned]**.
