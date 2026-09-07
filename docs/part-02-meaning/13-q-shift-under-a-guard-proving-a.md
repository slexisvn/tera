# 13. `q.shift()` Under a Guard: Proving a Partial Operation Total   ⟨— · — · J · N⟩

> **Status:** outline

**Thesis.** A refinement about mutable state must name what kills it; a lexically scoped
boolean is the wrong shape for any fact an operation inside the scope can falsify — so the
guard has to hand over a *number*, and every take has to spend one.

**What arrived.** From [Ch 12 § what-leaves-and-where-it-lands]: an `ObjectShape` per class
in `env.interfaces`, so `this.items` has the type `string[]` and `arrayMethodSignature` can
answer for `.shift()` at all. From [Ch 11]: a type for every expression. From [Ch 8]: a
`SemanticProgram` whose `Block` nodes carry `testRole` (`"guard"` for an `if`, `"loop"` for
a `while`/`for`) and `otherwise` — the two fields this whole chapter reads.

**What leaves.** `BoundProgram.provenTakes: ReadonlySet<ASTNode>` — a set of *callee* nodes,
computed by `provenTakes(program.body)` in `bindProgram` (`binder.ts:323`) before any name is
bound. `inferCall` (`infer.ts:406-410`) consults it and, for a member in that set only,
answers `removeNullish(returns)` instead of `element | undefined`. Ch 14 receives the same
`BoundProgram` and adds the effect analysis on top of it.

**New ideas.** A partial operation and a total one; a *refinement* (flow-sensitive typing);
why "narrowing" as a boolean cannot describe a mutable container; a *transfer function* and
the walk that applies it; the difference between "not proven" and "proven false".

**Length.** 14 pages

## Anchors

- `src/core/indexing.ts` — 62 lines, the shared vocabulary. `COMPLEMENT` (10 entries,
  including `loose==`/`loose!=`), `PROVEN_COUNT` (8 entries, one arrow function per
  operator), `provenCount(op, bound, negated)` at line 55 clamping to `Math.max(0, …)`,
  and the two membership sets `TAKES_ONE_ELEMENT = {pop, shift}` and
  `ADDS_ONE_ELEMENT = {push, unshift}` at lines 61-62. Named here because
  `src/optimizing/passes/array-methods.ts:678-679` calls the *same* `provenCount` from the
  middle end ([Ch 46]) — one table, two consumers, no second spelling of `>= 1`.
- `src/frontend/checker/length-bounds.ts` — 290 lines, the whole analysis. Module tables
  `MIRRORED` (4 entries), `KEPT_WHEN` (`&&`/`and` → `false`, `||`/`or` → `true`),
  `RUNS_LATER` (arrow and function expressions), `CARRIES_ITS_OWN_SCOPE` (Function, Model,
  Class), `RUNS_REPEATEDLY` (For, and Block when `testRole === "loop"`). Free functions
  `countedName`, `literalCount`, `countedSubject`, `countedSubjects`, `memberCall`,
  `leastRemaining`. The `Bounds` class: fields `counts: Map<string, number>`,
  `trail: Restore[]`, `undoable`, `taken: Set<string>`; methods `statements`, `statement`,
  `entered`, `chain`, `merge`, `deferred`, `guarded`, `expression`, `takes`, `adds`,
  `apart`, `forget`, `write`, `mark`, `changedSince`, `rollBack`. Exported entry
  `provenTakes(body)` at line 286.
- `src/frontend/checker/semantic-ast.ts` — `branchChain` (line 208), `alwaysExits`
  (line 228, `body.some(node => LEAVES_THE_BODY.has(node.kind))` over `{Return, Jump}`),
  `ownExpressions` (line 249) and its `gather` helper with the `within` flag that stops at
  the first nested `SemanticNode`. `BlockNode.testRole` / `BlockNode.otherwise` at 113-114.
- `src/frontend/checker/infer.ts` — `narrowScope` (line 475) and `nullishComparisonSubject`;
  `inferCall`'s `bound.provenTakes.has(node.callee)` at 408-410; `arrayMethodSignature`
  (line 664) where `pop`/`shift` get `unionType([element, "undefined"])` at line 669 and
  `push`/`unshift` get `int` at 668; the `ConditionalExpression` case at 112-117 that
  narrows both arms.
- `src/frontend/checker/type-checker.ts` — `checkStatements` (line 63) and its
  `branchChain` loop, `checkBranchChain`, `joinBranches` (line 85), `refuteGuard`
  (line 127), `refine` (line 131), `blockScope` (line 137), `checkVar`'s `widens` write at
  line 549, `declaredTargetType`'s `?.widens` read at line 1471, `remedyFor` /
  `operandRemedyFor` / `adviceWhen` (1257-1272), and the constant `ABSENCE_ADVICE`
  (line 1402).
- `src/frontend/checker/type-system.ts` — `Binding.widens?: TypeName` (line 30),
  `assignableType(binding)` returning `binding.widens ?? binding.type` (line 42),
  `removeNullish` (line 482).
- `src/frontend/checker/binder.ts` — line 34 declares `provenTakes` on `BoundProgram`;
  line 323 computes it. Note the position: *before* `bindNode` runs, so the analysis sees
  only the semantic tree, never a scope.
- `data/tera-language-spec.ts:6620-6632` — the spec's own `pop` and `shift` return `"any"`.
  The `element | undefined` type is not from the spec; `arrayMethodSignature` shadows it.

## Worked example

`docs/example/queue.tera` — the book's cold open, paid off here.

```
fn drain(q: int[]) -> int:
  total = 0
  while q.length > 0:
    a = q.shift()
    b = q.shift()
    total += a + b
  return total
```
— `docs/example/queue.tera:1-7`

```bash
node dist/cli.js docs/example/queue.tera          # prints 10
node dist/cli.js check docs/example/queue.tera
```

```
C:\...\docs\example\queue.tera:6:18: error: Operator '+' cannot be applied to 'int' and
'int | undefined' (the value may be absent: guard it before use, or spell a fallback with ??)
```

Column 18 is `b`, not `a`. The guard `q.length > 0` proved *one*; `a` spent it; `b` has
nothing left. Change the guard to `>= 2` and both takes pass:

```bash
node dist/cli.js check -e 'q: int[] = [1,2,3,4]
if q.length >= 2:
  a: int = q.shift()
  b: int = q.shift()
  print(a + b)'
```
→ silent.

The four titles from `tests/frontend/checker/type-checker.test.ts` read as the
specification: *"takes as many as the guard counted"*, *"counts a take back off the guard's
count"*, *"counts what a take put back"*, and the refusal *"proves nothing about a take a
nested loop repeats"*.

## Outline

- [ ] **New idea: a partial operation.** Primer — `shift()` answers an element *or* nothing,
      so its honest type is `element | undefined`. Establish where that type is minted:
      `arrayMethodSignature` (`infer.ts:669`), not the language spec, whose `shift` returns
      `"any"` (`data/tera-language-spec.ts:6628`). Establish the stakes: the interpreter
      hands back the JavaScript `undefined` and `2 + undefined` is `NaN`; the native
      compiler has no `undefined` to hand back ([Ch 55]), so it must refuse or be proven
      wrong. This chapter is where the proof happens or does not.
- [ ] **New idea: refinement.** Primer — a *refinement* is a place where the type of a name
      is narrower than its declaration because control flow got you here. Establish the
      simplest instance in the tree, `narrowScope` (`infer.ts:475-497`): an equality test
      against a `null` or `undefined` literal, `nullishComparisonSubject` accepting the
      literal on **either** side, the `negated` parameter flipping polarity so the same
      function serves both the taken and the untaken arm, and `subjectName` allowing a
      dotted name (`this.items`) as well as an identifier. Then the write:
      `child.locals.set(name, { ...binding, type: next, widens: binding.widens ?? binding.type })`.
- [ ] **The `widens` field is the undo button.** Establish `Binding.widens`
      (`type-system.ts:30`) and `assignableType` (`:42`) answering `widens ?? type` — so a
      *read* sees the narrowed type but an *assignment* is checked against the pre-narrowing
      one. Establish the two writers: `narrowScope` and `joinBranches`
      (`type-checker.ts:109`), both using the same `outer.widens ?? outer.type` idiom so
      re-narrowing never loses the original. Establish the reader that closes the loop,
      `declaredTargetType`'s `lookup(scope, name)?.widens` (`:1471`). Pin with
      *"lets an assignment widen a narrowed binding back to its declared type"*.
- [ ] **Where a refinement is applied, three times.** Establish the three sites, all in
      `type-checker.ts`: `blockScope` (`:137`) refines the *child* scope on entry, first by
      refuting every `otherwise` test then by asserting the block's own; `refuteGuard`
      (`:127`) refines the *enclosing* scope after a guard whose body `alwaysExits`; and
      `joinBranches` (`:85`) recombines the arms of a chain with `widenType`. Then the
      fourth, in `infer.ts:112-117`: a `ConditionalExpression` narrows both arms
      independently before joining.
- [ ] **Shallow on purpose.** Establish that `alwaysExits` is
      `body.some(kind ∈ {Return, Jump})` — a top-level scan of one statement list, no
      nesting, no reachability. Establish that this shallowness is what makes
      *"reads a member after a guard that returns"*, *"…that throws"* and *"…that
      continues"* all one rule (`Jump` covers `break`, `continue` and `throw` after
      lowering), and name what it costs: a guard whose body returns only inside a nested
      `if` is not seen. **Why the obvious design fails** goes here — a real reachability
      analysis needs a CFG, and the checker walks a statement list ([Ch 16 § single-pass]).
- [ ] **What `narrowScope` deliberately does not do.** Establish the list, honestly: it
      matches only `!=`/`==`/`!==`/`===` against a nullish *literal*; it does **not** recurse
      through `and`/`or`; it does not look at `.length`; it does not refine a member
      expression whose object is itself narrowed. Demonstrate the first gap — `if a != null
      and b != null:` still reports `Cannot access member 'n' on nullable type 'P | null'`.
      Establish the contrast that motivates the rest of the chapter: `countedSubjects` in
      `length-bounds.ts` **does** recurse through `and`/`or`, by a table. The two refinements
      in this engine have different shapes because they answer different questions.
- [ ] **New idea: proven false is not the same as not proven.** Primer, then the table.
      Establish `KEPT_WHEN` (`length-bounds.ts:28-33`): a fact survives an `and` when you
      took the branch (`negated === false`), and survives an `or` when you refuted it
      (`negated === true`) — De Morgan, written as a two-row map, and `countedSubjects`
      recursing into both operands exactly when `KEPT_WHEN.get(op) === negated`. Everything
      else contributes nothing rather than contributing a falsehood. Pin with
      *"takes one under a guard that also checks something else"*.
- [ ] **The boolean the guard threw away.** The centrepiece. Establish that `q.length > 0`
      does not mean "non-empty" but "at least one", and that `q.length >= 3` means "at least
      three" — a *number*, which a boolean loses. Establish `provenCount(op, bound, negated)`
      (`core/indexing.ts:55`): `COMPLEMENT` applied first when `negated`, then `PROVEN_COUNT`
      turning each surviving operator into a count — `>` gives `bound + 1`, `>=` and `==`
      give `bound`, `!=` gives 1 only when the bound is 0 — then `Math.max(0, …)` so a
      nonsense bound proves nothing. Establish that an unknown operator answers 0, not
      `null`: **absence of proof is not proof**. Pin with the seven titles in
      `tests/core/indexing.test.ts`.
- [ ] **Both operand orders, one function.** Establish `countedSubject`
      (`length-bounds.ts:84-96`): `countedName` on the left, else on the right; `literalCount`
      on whichever side is left over; and `MIRRORED` flipping the operator when the count was
      on the *right*, so `0 < q.length` reads as `q.length > 0`. Pin with *"takes one under a
      guard written the other way round"*.
- [ ] **New idea: a transfer function.** Primer — a walk over statements in source order
      carrying a state that each construct transforms. Establish `Bounds` as exactly that,
      with one piece of state: `counts: Map<string, number>` mapping an array's *name text*
      to how many elements are still provably there. Establish `guarded` (`:203`) writing a
      count only when it is larger than what is held (`if (held >= counted.proven) continue`),
      so *"keeps a count already proven when a weaker guard follows"* and *"keeps the larger
      count when one test names the array twice"* fall out of one comparison.
- [ ] **Spending and refunding.** Establish `expression` (`:210-220`): walk children first,
      then classify the node with `memberCall`; `TAKES_ONE_ELEMENT` routes to `takes`,
      `ADDS_ONE_ELEMENT` to `adds`. Establish `takes` (`:222-228`) doing three things in
      order — record the name in `taken`, add the *callee node* to the `proven` set when
      `left >= 1`, then decrement with a floor at 0. Establish `adds` (`:230-233`) refunding
      **only if the array already has a count**: a `push` on an array nobody guarded proves
      nothing, which is *"never lets put backs alone prove a take"*. Note the granularity
      that matters downstream: `proven` holds the `node.callee` — the `q.shift` member
      expression — not the call, because that is what `inferCall` has in hand.
- [ ] **Arms are alternatives, not a sequence.** Establish `chain` (`:170-186`): every arm
      starts from the same `counts` (a `mark()`/`rollBack()` pair around each), its result is
      captured by `changedSince`, and an arm whose body `alwaysExits` is dropped from the
      merge. Establish the else-path: when the last arm has a test, the *refuted* guard is
      itself a source of counts, which is how *"proves what the refuted guard leaves when
      every arm exits"* and *"takes one in the arm where an emptiness guard did not hold"*
      work — `if q.length == 0: return` leaves at least one behind. Establish `merge` (`:188`)
      folding with `leastRemaining`, where `undefined` is absorbing: **the worst arm wins**.
      Pin with *"starts each arm from the same count"* and *"carries the worst arm into what
      follows the branch"*.
- [ ] **The trail.** Establish the undo machinery, because it is the only stateful part:
      `write` pushes a `Restore` only while `undoable > 0`, `mark` increments and returns a
      trail length, `changedSince` reads the names touched since a mark and then reads their
      *current* values, `rollBack` pops in reverse and decrements. Establish why a snapshot
      copy of the map was not used — nested chains, and only touched names need carrying.
- [ ] **Three ways to lose a count.** Establish `apart` (`:235-252`) — swap in empty state,
      walk, collect the names taken from, restore, and *propagate the consumed names to the
      caller* — and then its three callers. (1) `RUNS_LATER` in `expression`: an arrow or
      function expression may run at any time, so `names.map(n => q.shift())` forgets `q`.
      (2) `CARRIES_ITS_OWN_SCOPE` via `deferred` (`:195-201`): a nested `fn`, a `model`, or
      every member of a `class`. (3) `RUNS_REPEATEDLY` via `statement` (`:145-155`): a `while`
      or `for` body may run any number of times, so whatever it took is forgotten *after* the
      loop as well as inside it. Establish the subtlety that makes the loop case correct
      rather than merely conservative: the loop's own test is re-applied *inside* the
      `apart`, which is why *"proves a take under the loop's own count on every round"*
      passes while *"proves nothing about a take that follows a loop which took one"* does
      not.
- [ ] **A push inside a closure does not repay.** Establish that `apart` propagates only
      `taken`, never `counts` — so a `push` inside a nested function or a loop cannot refund
      anything outside it, while a `shift` inside one destroys the count outside it. The
      asymmetry is deliberate: a take is a fact about the array, a put back is a fact about a
      code path that may not run. Pin with *"does not let a put back inside a nested function
      repay a take"*, *"does not let a put back inside a loop repay a take that follows"*,
      *"does not let a put back inside a lambda repay a take"* and *"leaves the count alone
      across a loop that only puts back"*.
- [ ] **Handing the answer to the checker.** Establish the join: `bindProgram` computes
      `provenTakes(program.body)` at `binder.ts:323` — before any binding exists — and
      `inferCall` reads `bound.provenTakes.has(node.callee)` at `infer.ts:408`. Establish
      that this is the *only* consumer, and that the narrowing is `removeNullish` applied to
      the already-instantiated return type. Establish why membership must be per-node and not
      per-name: the two `q.shift()` calls in `queue.tera` are the same text, the same
      receiver, the same member, and get different answers.
- [ ] **The sentence at the end.** Establish `remedyFor` / `operandRemedyFor`
      (`type-checker.ts:1261-1272`): the advice `(the value may be absent: …)` is appended
      **only when removing the nullish part would have made the program legal** — via
      `adviceWhen(compatible(present, expected))` and `binaryOperatorSemantics(...).valid`.
      A `string` where an `int` was wanted gets no absence advice. Pin with *"leaves a
      mismatch that absence does not explain without the advice"*.
- [ ] **What leaves.** Restate: one set of AST nodes, one call site in `inferCall`, and the
      same `provenCount` table waiting in the middle end ([Ch 46]) to do the same arithmetic
      on SSA instead of syntax.

## Honesty items

> **Broken.** The analysis keys on *name text* (`subjectName`, so an identifier or a dotted
> name), and `Bounds` has no aliasing story at all. Given
> `if q.length >= 2: alias = q; alias.shift(); a: int = q.shift(); b: int = q.shift()`
> the checker is silent — the take against `alias` never decrements `q` — and the program
> prints `NaN`. `takes` records `alias` in `this.taken`, but nothing connects the two names.
> Cost of fixing: either a may-alias analysis over the semantic tree (which the single-pass
> checker has no framework for), or the blunt version — forget every count whenever any
> array-typed name is assigned from another. The blunt version is cheap and would refuse
> `docs/example/stats.tera`-shaped code that is fine today.

> **Unfinished.** `narrowScope` (`infer.ts:481`) matches only `BinaryExpression` with an
> `==`/`!=`/`===`/`!==` operator against a `null`/`undefined` literal. It does not recurse
> through `&&`/`||`, so `if a != null and b != null:` narrows neither — reproduced below.
> `length-bounds.ts` already has the table this needs (`KEPT_WHEN`), which is why the gap is
> visible: two refinements in one checker, one of which learned De Morgan and one of which
> did not. Cost: lifting `countedSubjects`' recursion shape into `narrowScope`, plus a
> decision about what an `||` arm may assume.

> **Unfinished.** `literalCount` requires a `Literal` of kind `number`, so
> `if q.length >= n:` — a guard against a variable — proves nothing, even when `n` is a
> `const`-shaped binding the checker already knows is `2`. The middle-end twin has the same
> restriction (`boundOf` in `passes/array-methods.ts:665` demands `IR_CONSTANT`).

> **Unfinished.** `TAKES_ONE_ELEMENT` and `ADDS_ONE_ELEMENT` name four members. `splice`,
> `concat`, `length = n`, a subscript store past the end, and every collection method in
> [Ch 60]'s prelude change a length and are invisible to `Bounds`. `splice` in particular is
> a *take* that is not counted — the same unsoundness class as the aliasing item above.

> **Unenforced.** Nothing checks that `Bounds`' notion of "an operation that shortens an
> array" agrees with the runtime's. `TAKES_ONE_ELEMENT` is shared with
> `passes/array-shapes.ts:296` and `passes/class-member-lowering.ts:272`, which is a real
> constraint, but no test asserts that the set is exhaustive over the array surface in
> `data/tera-language-spec.ts`.

> **Unenforced.** `provenTakes` is computed once in `bindProgram` over `program.body` and
> stored on `BoundProgram`. Nothing prevents a later phase from mutating the AST nodes it
> holds; the set is identity-keyed on `ASTNode` objects, so a node replaced rather than
> mutated silently loses its proof. No test covers a rewrite between binding and inference.

## Verify it yourself

```bash
node dist/cli.js docs/example/queue.tera
node dist/cli.js check docs/example/queue.tera
node dist/cli.js check -e 'q: int[] = [1,2,3,4]
if q.length >= 2:
  a: int = q.shift()
  b: int = q.shift()
  print(a + b)'
node dist/cli.js check -e 'class P:
  public constructor():
    this.n = 1
a: P | null = P()
b: P | null = P()
if a != null and b != null:
  print(a.n)'
npx vitest run --project unit tests/frontend/checker/length-bounds.test.ts
npx vitest run --project unit tests/core/indexing.test.ts
```

The first prints `10`; the second reports `6:18 Operator '+' cannot be applied to 'int' and
'int | undefined' …`; the third is silent — one changed operator, and the same two takes are
legal. The fourth reports `Cannot access member 'n' on nullable type 'P | null'` at the
*use*, which is the `&&` gap named above. The two suites are 30 and 20 tests.

## Tests that pin this

`tests/frontend/checker/length-bounds.test.ts` — 30 tests, the analysis in isolation
(`provenTakes` called directly, asserting line numbers):

- > "proves the first take and refuses the next"
- > "counts a put back towards the take that follows it"
- > "never lets put backs alone prove a take"
- > "leaves a take on another array out of the count"
- > "counts both members that take one"
- > "counts a take that a larger expression encloses"
- > "keeps the larger count when one test names the array twice"
- > "keeps a count already proven when a weaker guard follows"
- > "proves as many takes as the guard counted"
- > "starts the count over at the guard, forgetting earlier takes"
- > "proves nothing about a take that came before the guard"
- > "re-proves a count that a loop had made unknown"
- > "proves nothing about the take itself"
- > "proves nothing about a take that follows a loop which took one"
- > "leaves the count alone across a loop that only puts back"
- > "counts a for loop the same way as a while loop"
- > "proves nothing after a loop whose own test took an element"
- > "proves a take under the loop's own count on every round"
- > "starts each arm from the same count"
- > "carries the worst arm into what follows the branch"
- > "keeps the count across a branch that takes nothing"
- > "proves what the refuted guard leaves when every arm exits"
- > "proves nothing about a take inside a nested function"
- > "does not let a put back inside a nested function repay a take"
- > "does not let a put back inside a loop repay a take that follows"
- > "forgets the count once a nested function may have taken from it"
- > "sees a take inside a class member the same way"
- > "counts a method's own guard against its own takes"
- > "proves nothing about a take inside a lambda the count encloses"
- > "does not let a put back inside a lambda repay a take"

`tests/core/indexing.test.ts` > `describe("provenCount")` — the operator table:

- > "counts one more than a bound the count must exceed"
- > "counts the bound itself when the count may equal it"
- > "counts the bound a count is equal to"
- > "counts one only from a count that differs from zero"
- > "reads a negated test as its complement"
- > "counts nothing from a negated test that leaves the count at zero"
- > "counts nothing from an operator it does not know"

`tests/frontend/checker/type-checker.test.ts` > `describe("taking one element after a guard
that the array holds some")` — the diagnostics the analysis produces or suppresses:

- > "takes the front of a queue a while loop guards"
- > "takes the back of a stack a while loop guards"
- > "takes one under a guard written the other way round"
- > "takes one under a guard that asks for at least one"
- > "takes one under a guard that asks for more than one"
- > "takes one in the arm where an emptiness guard did not hold"
- > "takes one under a guard that also checks something else"
- > "takes one off a field the method guarded"
- > "takes one under a guard that asks for an exact count"
- > "takes one under an exact-count guard written the other way round"
- > "takes one after a guard that throws unless the count is exact"
- > "takes one after a guard that throws unless the count is some other exact one"
- > "still refuses to take one after a guard that throws unless the array is empty"
- > "still refuses to take one in the arm where an exact-count guard did not hold"
- > "still refuses to take one after a guard that throws when the array holds some"
- > "still refuses to take one with nothing guarding the array"
- > "still refuses to take one when the guard counts another array"
- > "still refuses to take one when the guard says the array is empty"
- > "takes as many as the guard counted"
- > "keeps the largest count when one test names the array twice"
- > "counts a take back off the guard's count"
- > "counts what a take put back"
- > "counts takes on separate arms apart, not one after the other"
- > "counts the worst arm against a take that follows the branch"
- > "proves nothing about a take a nested loop repeats"
- > "proves nothing about a take inside a function the guard encloses"
- > "does not let a put back inside a nested function pay for another take"
- > "says how to mend an operand a take may not have filled"

`tests/frontend/checker/type-checker.test.ts` > `describe("nullable narrowing")` — the
`narrowScope` / `widens` half:

- > "reads a member after a guard that returns"
- > "reads a member after a guard that throws"
- > "reads a member after a guard that continues"
- > "reads a member in the else branch of a null check"
- > "reads a member in an else branch that no arm exits through"
- > "hands the last arm of an else-if chain every earlier refutation"
- > "carries narrowing through a run of guards"
- > "narrows a nullable string the same way it narrows a class"
- > "keeps narrowing for the statements after a guard at the top level"
- > "lets an assignment widen a narrowed binding back to its declared type"
- > "narrows a binding to what the assignment just gave it"
- > "joins what the branches leave behind"
- > "reads a member after a branch that assigns and one that returns"
- > "still refuses a member the branches leave nullable"
- > "still reports a member read when the guard does not exit"
- > "still reports a member read inside the branch where the value is null"
- > "leaves a loop condition alone, since a break can leave it true"

`tests/frontend/checker/type-checker.test.ts` > `describe("advice on a value that may be
absent")`:

- > "says how to answer for a take that a return type has no room for"
- > "says how to answer for a take a declared binding has no room for"
- > "stays quiet once a length test has ruled the absence out"
- > "stays quiet once a fallback spells what an empty collection answers"
- > "leaves a mismatch that absence does not explain without the advice"

The aliasing unsoundness in the first honesty item: **[unpinned]**.
