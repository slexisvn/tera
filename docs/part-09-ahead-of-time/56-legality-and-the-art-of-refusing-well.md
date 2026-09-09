# 56. Legality, and the art of refusing well   ⟨ I · N ⟩

Every value in every graph now needs exactly one `AotScalar`, and it needs it forever.
There is no `Box`, no conversion node, no tagged word, and no guard that could fail into an
interpreter — chapter 55 spent its whole length establishing why. So when a value cannot be
given one storage class, the compiler has no third move. It does not widen the value, it
does not insert a check, and it does not quietly emit something plausible. It refuses that
function, and it says why in an English sentence that names the program's shape rather than
the compiler's internals.

That refusal is not an error path bolted onto an analysis. It *is* the analysis.
`analyzeAotLegality` returns `{ ok: true, legality }` or `{ ok: false, reason }` — a
discriminated union, never a throw — and the file that computes it holds forty-nine
distinct places where it can decide to write a sentence instead of an answer. At 1,995
lines it is the largest file in `src/optimizing/analyses/` by a factor of five over the next
one, and fourth largest in `src/optimizing/` behind `wasm/codegen.ts` (4,860),
`c/emit.ts` (2,591) and `builder/ir-builder.ts` (2,272). A compiler that can fall back to an
interpreter can answer "I don't know" by not compiling, silently, in a trace line nobody
reads. A compiler that produces a file has to explain itself to a person.

The running example reaches this chapter through its refusing variation.
`docs/example/stats-refused.tera` declines one function, then the function that calls it,
then the program entry, and prints three different messages about one problem. The two
repaired versions of that file are *not* in the example set — a file whose purpose is to
stop failing is not a program the book runs — so they appear only as commands under "Verify
it yourself" (`docs/CONVENTIONS.md` rules 1 and 2). The same applies to the small probes in
§ warning-note-and-error and § the-cascade.

**What arrived.** From [Ch 55 § then-per-function-then-again]: a `CFGFunction` legalized for
one native `AotBackend` — no frame states, no guards, `graph.emits` and `graph.capabilities`
stamped from the backend, `graph.textBufferBytes` set, and `graph.stringEscapes` and
`graph.wideText` carrying whole-module answers stamped back on with `aotLegalityAnalysisId`
invalidated so this analysis reads them fresh.

**What leaves.** Either an `AotLegality` — a per-value scalar map, a root-slot numbering, a
set of `AotStringBuffer`s, a parameter and return scalar list and a constant list,
everything the emitter needs and nothing it must recompute — or an `AotSkippedFunction`
whose `reason` is one English sentence.

## An analysis that writes prose

`analyzeAotLegality` is registered like any other analysis. It has an id, it is invalidated
when the graph changes, and the manager caches it:

```ts
export function analyzeAotLegality(
  graph: CFGFunction,
  types: TypeInference,
  aliasing: PointsToResult,
): AotLegalityResult {
  return new LegalityAnalyzer(graph, types, aliasing).analyze();
}

export const aotLegalityAnalysisId = analysisId<AotLegalityResult>("aot-legality");

export const aotLegalityAnalysis: AnalysisPass<CFGFunction, AotLegalityResult> = {
  id: aotLegalityAnalysisId,
  run: (graph, analyses) =>
    analyzeAotLegality(
      graph,
      analyses.get(typeInferenceAnalysisId),
      analyses.get(pointsToAnalysisId),
    ),
};
```
— `src/optimizing/analyses/aot-legality.ts:1977-1995`

Two inputs, both analyses of Part VII: the type inference of
[Ch 48 § the-type-solver] and the points-to result of [Ch 42 § points-to]. Nothing else.

What makes it a different *kind* of thing from every analysis in Part VII is its answer.
`DominatorTree` answers a fact. `TypeInference` answers a fact. `PointsToResult` answers a
fact. This one answers a fact *or a sentence*:

```ts
export type AotLegalityResult =
  | { readonly ok: true; readonly legality: AotLegality }
  | { readonly ok: false; readonly reason: string };
```
— `src/optimizing/analyses/aot-legality.ts:842-844`

> **New idea. An analysis whose output is a diagnostic.** An analysis normally computes
> something the compiler will use — a relation, a map, a lattice element. Its failure mode
> is "no useful information", and the caller responds by being conservative. This one's
> failure mode is *a decision not to compile*, and the caller has to relay it to a human
> being. That changes what the analysis is allowed to know: it cannot say "no scalar for
> v34", because `v34` is not a thing the person who wrote the program has ever seen. It has
> to say what the *program* did. So an analysis of this kind carries a second obligation
> nothing else in the compiler carries — the vocabulary of its output is the user's, not
> the compiler's — and that obligation is most of why this file is 1,995 lines.

The mechanism is one private method and a field:

```ts
  private fail(reason: string): void {
    if (this.failure === null) this.failure = reason;
  }
```
— `src/optimizing/analyses/aot-legality.ts:967-969`

**First failure wins.** Not the last, not the most severe, not a list — the first one the
walk reaches, and every later `fail` is dropped. That is a real design choice with a real
cost: a function with three unrelated problems is reported once and fixed three times.
It is also what makes the sentences readable, because a legality walk that kept going after
its first refusal would produce a cascade of derived complaints about values whose scalars
were never assigned. There are forty-nine `this.fail(...)` sites in the file and exactly one
of them can ever be seen per function.

The evidence base for the rest of this chapter is
`tests/optimizing/analyses/aot-legality.test.ts` — 1,236 lines, 94 tests, almost all of them
asserting a specific sentence or a specific scalar for a hand-built graph.

## What it actually computes

Four outputs, one walk.

```ts
export interface AotLegality {
  readonly returnScalar: AotScalar;
  readonly declaredReturn: boolean;
  readonly parameterScalars: readonly AotScalar[];
  readonly constants: readonly CFGInstruction[];
  readonly stringBuffers: readonly AotStringBuffer[];
  scalarOf(value: CFGInstruction): AotScalar;
  absenceComparesAsNumber(node: CFGInstruction): boolean;
  comparesBits(node: CFGInstruction): boolean;
  comparesReferences(node: CFGInstruction): boolean;
  stringBufferOf(value: CFGInstruction): AotStringBuffer | null;
  codeSignatureOf(value: CFGInstruction | undefined): DeclaredSignature | null;
}
```
— `src/optimizing/analyses/aot-legality.ts:828-840`

**(a) `scalarOf(value)`** — the per-value `AotScalar` assignment, and the thing everything
else is derived from. It throws rather than answering null, because by the time anything
calls it the analysis has already said `ok: true`: `legality admitted v${value.id} without
a scalar type` (`:958`) is an assertion about the analysis, not a diagnostic about the
program.

**(b) root slots** — `rootSlotsOf` (`:852-863`), a dense numbering of every pointer-scalar
value that has a use, which chapter 61's shadow stack is built from.

**(c) string buffers** — `stringBuffers` and `stringBufferOf`, deciding which static buffer
each produced string lives in, which is chapter 59's subject.

**(d) the signature** — `parameterScalars`, `returnScalar` and `constants`, which is
literally what the emitter writes a C prototype or a machine prologue from.

These are not four passes. The same node walk answers all four, because each depends on the
scalar assignment: a value is *rooted* exactly when its scalar is `SCALAR_POINTER`, it needs
a *buffer* exactly when its scalar is `SCALAR_STRING`, and the signature is the scalars of
the parameters and of whatever the returns produce. Splitting them would mean computing the
assignment three more times, and — worse — three chances to compute it differently.

## Where a scalar comes from

The assignment is one method, and the order of its `??` chain is the design:

```ts
  private require(value: CFGInstruction, context: string): AotScalar | null {
    const cached = this.scalars.get(value);
    if (cached !== undefined) return cached;
    const scalar =
      value.type === IR_RUNTIME_BASE
        ? SCALAR_POINTER
        : this.laidOutScalarOf(value) ??
          this.answeredScalarOf(value) ??
          aotScalarOf(this.types.typeOf(value)) ??
          this.mergedReferenceOf(value);
    if (scalar === null) {
      this.fail(`value has an unsupported type in ${context}`);
      return null;
    }
    this.scalars.set(value, scalar);
    return scalar;
  }
```
— `src/optimizing/analyses/aot-legality.ts:985-1001`

Read the chain from the top.

**Cached.** The map is seeded before the walk. `checkSignature` (`:1820-1843`) runs first and
writes a scalar for every parameter from the declared signature, and `inferReturnScalar`
(`:1953`) prefers the declared return over the returned type. So a declared type is not a
*candidate* in this chain — it is already the answer by the time the chain runs. That is the
ordering rule, and it matters: **the declared type wins over the inferred one, because the
declared type is what the layout was built from.** A field's offset, an array's stride and a
callee's calling convention were all computed from the declaration in chapter 57's passes;
an inferred type that disagreed would produce a graph that reads the right value out of the
wrong byte.
`[t: tests/optimizing/analyses/aot-legality.test.ts > "takes scalar types from the declared signature"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "infers a return type when the signature declares none"]`

**A stamped layout.** `laidOutScalarOf` (`:975-983`) reads two props an earlier pass wrote:
`VALUE_SCALAR_PROP` on any value, and `FIELD_SCALAR_PROP` on a `LoadField`. Both are stamped
by chapter 57's class-member lowering, which knows the shape the field belongs to. The one
exclusion is `SCALAR_TEXT` — a field holding a thousand-byte inline text is not the scalar
of the *value* you get by loading it, which is chapter 59's distinction.
`[t: tests/optimizing/analyses/aot-legality.test.ts > "gives an element access the width the array was shaped with"]`

**A callee's answered type.** `answeredScalarOf` (`:1410-1416`) reads the callee's declared
return through `calleeDeclaredSignature`, and takes it only in two cases: when it is
`SCALAR_CODE`, or when the declared return admits null. Otherwise it defers to the lattice,
because the lattice knows more about a concrete number than a type name does.

**The lattice, last.** `aotScalarOf(this.types.typeOf(value))` — the two-line mapping of
[Ch 55 § seven-scalars-against-six-representations]. It is the fallback, not the source of
truth, and it answers `null` for an object with no map, which is how an unlayoutable value
reaches `fail`.

**A phi of pointers.** `mergedReferenceOf` (`:1003-1008`) is the one repair: a phi whose
lattice type is `Object` and whose every input is a pointer is a pointer, even where the
join lost the map. Without it, a merge of two differently-shaped objects would refuse.

## Two absence values, one payload each

`null` and `undefined` are distinct in tera, they print differently, and the interpreter
tells them apart by a tag code. There are no tag codes here. The model that replaces them is
sixteen lines:

```ts
export interface AbsenceValue {
  readonly text: string;
  readonly bits: bigint;
  readonly reference: boolean;
}

const ABSENCE_BY_HELD: ReadonlyMap<unknown, AbsenceValue> = new Map<unknown, AbsenceValue>([
  [null, { text: NULL_TEXT, bits: FLOAT64_NULL_BITS, reference: true }],
  [undefined, { text: UNDEFINED_TEXT, bits: FLOAT64_UNDEFINED_BITS, reference: false }],
]);

export const ABSENCE_VALUES: readonly AbsenceValue[] = [...ABSENCE_BY_HELD.values()];

export function absenceValueOf(held: unknown): AbsenceValue | null {
  return ABSENCE_BY_HELD.get(held) ?? null;
}
```
— `src/optimizing/metadata/printed-values.ts:19-34`

Two entries, three fields each. `text` is the word to print. `bits` is the 64-bit pattern.
`reference` says whether this flavour is the one a null *pointer* stands for.

```ts
export const FLOAT64_NULL_BITS = 0x7ff8_0000_0000_0001n;
export const FLOAT64_UNDEFINED_BITS = 0x7ff8_0000_0000_0002n;
```
— `src/optimizing/target/float64.ts:36-37`

> **New idea. Quiet NaN payload.** IEEE-754 says a double is a NaN when its eleven exponent
> bits are all ones and its 52-bit mantissa is not zero. That leaves the mantissa entirely
> unconstrained: the top mantissa bit distinguishes *quiet* NaNs from *signalling* ones, and
> the remaining 51 bits are a payload no arithmetic depends on — 2^51 distinct values for
> each sign bit, all of which compare, print and propagate as "not a number". Spending two
> of them to mean `null` and `undefined` is safe for a reason that is worth stating exactly:
> the exponent field being all ones is what *makes* a bit pattern a NaN, so **no finite
> number has that pattern**, whatever it is. The trick is not "these values are unlikely".
> It is "these values are unreachable by arithmetic on real numbers".

```
bit  63 62                 52 51 50                                        0
    +--+---------------------+--+------------------------------------------+
    | S|      exponent       | Q|                 payload                  |
    +--+---------------------+--+------------------------------------------+
       |  11 bits, all ones  |  |               51 bits                    |
       |    for any NaN      |  +-- quiet bit, 1 for a quiet NaN
       |                     |
null       0x7ff8_0000_0000_0001    S=0  exponent=0x7ff  Q=1  payload=1
undefined  0x7ff8_0000_0000_0002    S=0  exponent=0x7ff  Q=1  payload=2
```

The invariant is asserted directly, over both values, by shifting the exponent out and
masking the mantissa:
`[t: tests/optimizing/metadata/printed-values.test.ts > "keeps every payload a quiet NaN, so no finite number is read as absent"]`.
That they are two *different* payloads, so a compiled program can still print the right
word, is
`[t: tests/optimizing/metadata/printed-values.test.ts > "gives each one its own float64 payload"]`
and
`[t: … > "tells null and undefined apart by the text they print"]`.

Now the asymmetry, which is the part that generates refusals. The trick works in a number
because a double has 2^51 spare bit patterns. It does not work in a *pointer*, because a
reference position holds one address and the only address available to mean "nothing" is
zero. There is exactly one of those, so it can stand for exactly one absence, and the model
gives it to `null` — `reference: true` on the null entry and only on the null entry:
`[t: tests/optimizing/metadata/printed-values.test.ts > "marks only the flavour a null reference stands for as reference-held"]`
asserts that the filtered list is `[absenceValueOf(null)]` exactly. The x64 backend spends
it: `[t: tests/optimizing/backends/x64/absence.test.ts > "gives an absent reference the null pointer instead of a number"]`.

So: a number position can carry both absences. A reference position can carry one. Every
refusal in the next two sections is a consequence of those two sentences.

## Demand is a join over uses

Here is the central mechanism of the chapter, and the thing that makes the absence model
work at all.

A bare `null` in a program is nothing in particular. It has no type worth speaking of, no
width, and no natural storage class. Asking "what scalar is this constant?" is the wrong
question. The analysis asks a different one: **what does every use of it require?**

```ts
  private absenceScalarOf(node: CFGInstruction, absence: AbsenceValue): AotScalar | null {
    if (node.uses.length === 0) return SCALAR_VOID;
    if (this.answersNowhere(node)) return this.declaredReturnScalar() ?? SCALAR_FLOAT64;
    let joined: AotScalar | null = null;
    for (const use of node.uses) {
      const demanded = this.absenceDemandOf(use, node);
      if (demanded === null) continue;
      if (joined !== null && joined !== demanded) return null;
      joined = demanded;
    }
    if (joined !== null) return joined;
    if (node.uses.every((use) => use.type === IR_RETURN) && this.voidReturn) {
      return SCALAR_VOID;
    }
    return absence.reference ? SCALAR_POINTER : SCALAR_FLOAT64;
  }
```
— `src/optimizing/analyses/aot-legality.ts:1322-1337`

Two guards, one loop, two fallbacks.

The loop is the join. Each use is asked what it demands; uses that demand nothing are
skipped; and the moment two uses demand *different* scalars, the whole thing answers `null`
— which the caller turns into a sentence. This is a join over a two-element domain with no
top: agreement, or failure.

`absenceDemandOf` (`:1362-1381`) is the transfer function, and it is a five-way case:

- `IR_STORE_FIELD` demands the field's stamped scalar.
- `IR_STORE_ELEMENT` demands the array element's.
- `IR_RETURN` demands the declared return's.
- `IR_CALL_KNOWN_FUNCTION` demands the callee's declared parameter type at that position.
- anything else falls back to `declaredScalarAt` — the declared type at that operand
  position — and then, failing that, to whatever the *other* operands are: if every other
  operand is itself an absence, `sharedAbsenceScalarOf` decides; if any other operand is
  numeric, `SCALAR_FLOAT64`.

Every one of those answers is filtered through `carriesAbsence` (`:1357-1360`), which is
three lines and worth reading, because it is the whole absence model as code: a `float64`
demand stays `float64`; any *reference* demand becomes `SCALAR_POINTER`; and everything else
answers `null`, meaning this use demands nothing an absence can be.

> **New idea. Demand.** Type inference flows *forwards*: a definition has a type, and its
> uses inherit consequences of it. Demand flows *backwards*: a use requires something of its
> operand, and the definition inherits the requirement. Part VII's solver was the first kind
> ([Ch 48 § the-type-solver]) — it started at constants and parameters and propagated to
> results. This is the second. The two are not competitors; they answer different questions.
> "What is this value?" is forwards. "What does this value have to be, for the code that
> reads it to work?" is backwards, and for a value that is nothing in particular, only the
> backwards question has an answer. The same shape appears again in
> [Ch 48 § the-soundness-rule]'s warning that demand is not proof — that a value narrowed
> because no consumer asked for the wide form is narrowed on no evidence. Here demand is
> not being used as evidence about the value; it is being used to *choose* a storage class
> for a value that has none. That is legitimate exactly because the choice is free.

The guards and fallbacks are the edge cases, and each is pinned. A constant nothing uses
gets `SCALAR_VOID` and no storage at all
`[t: tests/optimizing/analyses/aot-legality.test.ts > "leaves an unused absence constant without a representation"]`.
A constant whose only uses are returns from a void function is likewise nothing
`[t: … > "leaves a void function answering undefined alone"]`.
And when the loop finds no demand at all, the flavour's own default applies — pointer for
`null`, double for `undefined` — which is why `undefined` in a numeric position carries its
payload intact
`[t: … > "carries undefined as a number, so its payload survives"]`
and `null` in the same position does the same
`[t: … > "carries null as a number the same way"]`.

## When the join conflicts

`return null` from that loop becomes one of two sentences, and both are worth reading
character by character because they are the clearest instance in the tree of a refusal
written for a programmer:

```ts
      const scalar = this.absenceScalarOf(node, absence);
      if (scalar === null) {
        this.fail(
          `${absence.text} is read here both as a number and as a reference, and one ` +
            `constant cannot be both; keep this part interpreted`,
        );
        return;
      }
```
— `src/optimizing/analyses/aot-legality.ts:1530-1537`

> `null is read here both as a number and as a reference, and one constant cannot be both;
> keep this part interpreted`

And its sibling, four lines further down, for a value that is `undefined` held where a
pointer lives:

> `undefined is held here as a reference, where it cannot be told apart from null; use null,
> or keep this part interpreted`

Neither sentence contains the word *scalar*, or *lattice*, or *IR*, or a value number. Each
names what the program did ("is read here both as a number and as a reference"), why that
cannot be compiled ("one constant cannot be both"), and a way forward. The second one even
names the *specific edit*: use `null`, because `null` is the flavour the reference position
can carry. Compare the sentence a naive implementation writes — `cannot unify float64 with
pointer at v34` — which is true, useless, and about the compiler.

That is the design rule, and it is the one this chapter exists to state: **the refusal names
the program's shape, not the compiler's internals.**

The second refusal's guard is four conditions, and the last two are what keep it from firing
on programs that are fine:

```ts
      if (
        !absence.reference &&
        isReferenceScalar(scalar) &&
        !this.answersNowhere(node) &&
        !this.absenceFlavourIsNamed(node, absence)
      ) {
```
— `src/optimizing/analyses/aot-legality.ts:1538-1543`

`absenceFlavourIsNamed` (`:1499-1512`) asks every use whether the *declared type* at that
position names this absence and no other. If a field is declared `Series | undefined`, then
storing `undefined` into it is unambiguous — there is nothing else the null pointer could
mean there — and the refusal does not fire.
`[t: tests/optimizing/analyses/aot-legality.test.ts > "accepts undefined held as a reference the declared type names as the only absence"]`.
Declare it `Series | null | undefined` and the same store is refused, because now one
pointer would have to mean two things
`[t: … > "refuses it where the declared type admits both, so one pointer means two things"]`.
Declare it `Series` and it is refused for the other reason — the type names no absence at
all to read the pointer as
`[t: … > "refuses it where the declared type names no absence to read it as"]`.
And `null` in a reference position is always fine, because that is the one the address is
spent on
`[t: … > "still accepts null held as a reference"]`.

Four tests, one graph shape, one declaration changed between them. That is the whole
absence model, tested the way [Ch 49 § the-three-tests-that-draw-the-line] tests
provenance.

## The holding domain, not the type

*(Bug as engineering.)*

**Symptom.** `fn pick(n: int) -> int | undefined` compiled, ran, and printed `0` for the
absent case where the interpreter printed `undefined`. No diagnostic, exit 0 on both.

**Mechanism.** The code that renders a number as text has to decide *which word* to print
when the payload is one of the two NaNs, and it asked the checker type. But a value has more
than one checker type in scope at the point of a render: the type of the expression in that
branch (`undefined`), the declared type of the variable it flowed into (`int | undefined`),
and the declared return of the function it came out of. The renderer read whichever it
reached first, and for a merge of two branches it reached one that did not name the absence
being held.

**Fix.** Ask the value that *holds the payload*, not the type anyone wrote down:

```ts
export function absenceTextOf(
  value: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable,
  types: TypeInference,
  seen: Set<CFGInstruction> = new Set<CFGInstruction>(),
): string | null {
  if (seen.has(value)) return null;
  seen.add(value);
  if (value.type === IR_CONSTANT) return absenceValueOf(value.props.value)?.text ?? null;
  const declared = declaredAbsenceText(declaredTypeNameOf(value, graph, classes, types));
  if (declared !== null) return declared;
  return value.type === IR_PHI ? joinedAbsenceText(value, graph, classes, types, seen) : null;
}
```
— `src/optimizing/metadata/printed-values.ts:85-98`

Three cases in a fixed order. A constant answers its own flavour, because a constant *is*
the payload. A value with a declared type answers `declaredAbsenceText`, which returns a
word only when the type names **exactly one** absence — `named.length === ONE_NAME` at
`:40`, so `int | null | undefined` answers nothing rather than guessing
`[t: tests/optimizing/metadata/printed-values.test.ts > "answers nothing when a type admits both, since the two cannot be told apart"]`.
A phi recurses into its arms through `joinedAbsenceText` (`:43-58`), which answers a word
only if every arm agrees
`[t: … > "spells the absence when every branch carries the same one"]`
and answers nothing if they do not, because neither word would be right
`[t: … > "answers nothing when the branches disagree, since neither word is right"]`.
The `seen` set is not decoration: a loop-carried phi is its own ancestor, and without it the
recursion does not terminate
`[t: … > "answers the word the entering branch carries rather than recursing forever"]`.

**Regression test.**
`[t: tests/e2e/optimizing/aot/absent-number-text.test.ts > "spells out the undefined a declared return admits the way the interpreter does"]`
— one of seven cases in a `RENDERED` table, each compiled to a real PE executable and
compared against the interpreter's stdout character for character. The titles are generated
as `` `${name} the way the interpreter does` ``, so they do not appear as literal strings in
the file.

**General rule.** The question a lowering asks is always *"what domain currently holds this
value"*, never *"what did the checker call it"*. The two coincide most of the time, which is
exactly what makes the gap hard to see.

The same rule appears in the lattice as a two-line function:

```ts
export function heldNumericType(type: LatticeType): LatticeType {
  return isNumericKind(type) && acceptsNull(type) ? nullableNumericType(doubleType()) : type;
}
```
— `src/optimizing/types/lattice.ts:147-149`

An `int` that admits absence is **held as a double**, because a 32-bit word has no spare NaN
to put a payload in. The checker type is still `int | undefined`; the holding domain is
`float64`. `aotScalarOf` calls `heldNumericType` before it consults `SCALAR_BY_KIND`
(`src/optimizing/types/scalar.ts:69`), so every scalar in this chapter is a *held* type by
construction.
`[t: tests/optimizing/types/lattice.test.ts > "holds an integer that admits absence in a float"]`,
`[t: … > "keeps the absence the integer admitted"]` — the widening must not lose the
nullability — and
`[t: … > "leaves an integer that is always present alone"]`, which is what keeps ordinary
`int` arithmetic in 32-bit registers.

## Comparing absences

Two comparison operators exist in this compiler that no programmer ever writes, and both
exist because of the payload trick.

```ts
export const ABSENCE_COMPARISON = "loose==";
export const BITS_COMPARISON = "bits==";
```
— `src/optimizing/metadata/printed-values.ts:12-13`

`loose==` compares two values *as absence flags*: is either of them one of the two payloads?
That is what makes `null == undefined` answer true in a compiled binary the way it does in
the interpreter, even though the two are different bit patterns.

`bits==` compares the whole 64-bit word as an integer. It exists because an ordinary float
equality **cannot find a NaN**: IEEE-754 says a NaN is equal to nothing, itself included, so
`x == undefined` is false even when `x` *is* the undefined payload. Searching an array for
an absent element therefore needs a comparison that ignores float semantics entirely.

Both are produced in one place, and it is the twelve lines of `index_of`'s element test:

```ts
function sameElement(
  site: Site,
  block: CFGBlock,
  element: CFGInstruction,
  wanted: CFGInstruction,
): CFGInstruction {
  const plain = append(block, comparison(site.model.element, element, wanted), site.stamp);
  if (!carriesAbsence(site.model.element)) return plain;
  const missing = testsAbsent(site, block, element);
  const alike = append(block, irGenericCompare(BITS_COMPARISON, element, wanted), site.stamp);
  const both = append(block, irInt32And(missing, alike), site.stamp);
  return append(block, irInt32Or(plain, both), site.stamp);
}
```
— `src/optimizing/passes/array-methods.ts:159-171`

If the element scalar cannot carry an absence, the ordinary comparison is the whole answer
and the pass returns early. If it can, the test becomes *ordinary equality, or (both are
absent and their bits agree)*. `testsAbsent` (`:154-157`) builds the `loose==` against a
null constant; the `bits==` is line 168.

Which of the two readings the legality analysis admits is decided by
`absenceComparesAsNumber` (`:1397-1404`): find the operand that is *not* an absence
constant, and ask whether it is a `float64`. If both operands are absences, ask about all of
them.

- an absence against a number reads as a number
  `[t: tests/optimizing/analyses/aot-legality.test.ts > "reads an absence against a number as a number"]`
- an absence against a string reads as a reference
  `[t: … > "reads an absence against a string as a reference"]`
- two absences read as numbers when one of them has no reference form to take
  `[t: … > "reads two absences as numbers when one of them has no reference to be"]`
- and a `bits==` over a reference is refused, because a pointer carries no number whose bits
  there would be anything to compare
  `[t: … > "refuses one over a reference, which carries no number to read bits from"]`

The x64 lowering of `loose==` is the model made concrete: it tests each operand against
every payload the language has, reduces those to one flag per operand, and answers from the
flags rather than from the payloads
`[t: tests/optimizing/backends/x64/absence.test.ts > "tests each operand against every absence payload the language has"]`.

## Root slots and string buffers fall out

Both have their own chapters. What belongs here is *why they live in this file*, and the
answer is that both are questions about scalars.

```ts
export function isRootedPointer(legality: AotLegality, value: CFGInstruction): boolean {
  if (value.type === IR_RUNTIME_BASE) return false;
  if (value.uses.length === 0) return false;
  return legality.scalarOf(value) === SCALAR_POINTER;
}
```
— `src/optimizing/analyses/aot-legality.ts:846-850`

A value needs a garbage-collection root exactly when its scalar is `SCALAR_POINTER`, with
two exclusions: the runtime base (which is not a heap object) and a value nothing uses
(which cannot be live across anything)
`[t: tests/optimizing/analyses/aot-legality.test.ts > "leaves a value nothing uses unrooted"]`.
`rootSlotsOf` (`:852-863`) then numbers what survives, from zero, with no gaps —
`slots.set(value, slots.size)` is the entire allocator —
`[t: … > "gives each rooted value a slot of its own"]`,
`[t: … > "numbers the slots from zero without a gap"]`.
Chapter 61's shadow stack is a frame of exactly that many words.

The string-buffer machinery is the same walk asking which values have `SCALAR_STRING`, and
it is much larger because the question it has to answer is not "does this need a buffer" but
"can two strings share one" — `StringBufferRules` (`:529`) plus the whole-module
`summarizeStringEscapes` (`:752`) that chapter 55's driver stamps back on.
[Ch 61 § one-slot-per-value] and [Ch 59 § the-lifetime-proof] are the two chapters; the
point here is that neither could be a separate analysis, because both would have to
recompute the scalar assignment to ask their own question.

## The shape of a refusal

Nearly every sentence in this file has three parts. Take the string-constant refusal, which
is the clearest instance because all three are literal:

```ts
      const room = characterCapacity(this.graph.textBufferBytes);
      if (value.length > room) {
        this.fail(
          `string constant is longer than the ${room} characters a compiled string holds; ` +
            `raise it with --text-size, or keep this part interpreted`,
        );
```
— `src/optimizing/analyses/aot-legality.ts:1517-1522`

*What the program did* — a string constant longer than the buffer. *Why that cannot be
compiled* — the compiled string holds `room` characters, a number computed from this build's
actual `--text-size`, not a constant pasted into the sentence. *At least one way out* — two
of them, and the first names the flag.

The closing clause is a deliberate contract, and it is the reason a refusal here is not an
error: **there is always a way out, because the interpreter always exists.** A function this
compiler declines still runs. That is the sentence chapter 1 opened the book on, arriving
from the other direction.

The counter-example that proves the rule is the one message that goes further and offers a
concrete edit:

```ts
    : `parameter '${name}' has no declared type; declare it (for example '${name}: int'), ` +
        `or keep this part interpreted`;
```
— `src/optimizing/analyses/aot-legality.ts:904-905`

`undeclaredParameterReason` writes the parameter's own name into a sample annotation. Its
sibling arm does the same for a rest parameter, with the spread spelled out —
`declare the type its arguments have (for example '...${name}: int')`.
`[t: tests/optimizing/analyses/aot-legality.test.ts > "refuses a parameter whose type the source never declared"]`,
`[t: … > "names the rest parameter when a gathered argument has no declared type"]`.

Now count the endings, because the contract is not kept everywhere.

> **Unenforced.** "…, or keep this part interpreted" is a contract this book states and
> nothing checks. `src/optimizing/analyses/aot-legality.ts` has **49** `this.fail(...)`
> sites and the phrase appears **25** times in the file; only **11** of the 49 sites spell
> it inline, and while several of the rest delegate to a helper that does
> (`SPREAD_CALL_REASON` at `:308-311`, `undeclaredParameterReason`, one arm of
> `globalValueReason` at `:334-337`), a large group does not on any path:
> `unsupported opcode ${node.type}` (`:1600`), `unsupported builtin ${name}` (`:1774`),
> `function has no return` (`:1581`), `return without a value` (`:1651`),
> `references can only be compared for equality` (`:1645`),
> `value has no representation in ${context}` (`:1014`). The driver's own two are the same:
> `duplicate symbol ${symbol}` (`src/optimizing/drivers/aot.ts:876`) and
> `calls unavailable function ${name}` (`:177`). No test asserts the ending. Cost to close:
> a lint test over the file's string literals — cheap, and it would freeze the wording — or
> a two-argument `fail(what, remedy)` helper that appends the clause, which is a roughly
> 50-site mechanical change and the version that could not drift again.

> **Unfinished.** `SCALAR_VOID` has no entry in `SCALAR_WIDTHS`
> (`src/optimizing/types/scalar.ts:56-63`), so `scalarWidth(SCALAR_VOID)` throws
> `no storage width for void` (`:101-105`). That is *correct* — a void has no storage — but
> it is enforced by a thrown `Error` reaching the user rather than by the type system, and
> `isStorableScalar` (`:79-81`) exists precisely to filter it out beforehand. Every caller
> has to remember to call it; `requireStorable` (`aot-legality.ts:1010-1016`) is this file's
> disciplined wrapper and there is nothing making it the only door. Cost to close: split
> `AotScalar` into `StorableScalar | typeof SCALAR_VOID` and let the type checker find the
> callers that forgot.

## Warning, note, and error

Three outcomes, and the driver picks between them by **reachability, not severity**. The
same `AotSkippedFunction` — the same name, the same reason string — is a fatal warning, a
harmless note, or nothing at all, depending on whether the program needs it.

```ts
function warnSkipped(skipped: readonly AotSkippedFunction[]): void {
  for (const fn of skipped) {
    console.error(`tera compile: warning: skipped '${fn.name}' (${fn.reason})`);
  }
}

function noteLeftOut(skipped: readonly AotSkippedFunction[]): void {
  for (const fn of skipped) {
    console.error(
      `tera compile: note: '${fn.name}' is not in the binary, and nothing the program ` +
        `runs calls it (${fn.reason})`,
    );
  }
}
```
— `src/cli/compile.ts:73-86`

Two functions, one shape of data, two very different meanings. `warnSkipped` fires from one
place only — the `catch (error) { if (error instanceof AotLinkError) … }` around
`compileAotModule` (`:347-350`). The build has already failed; these are why. `noteLeftOut`
fires unconditionally on the line *after* that try block (`:351`), on a build that
succeeded.

Here is the same reason string on both sides of that line. A function that returns a string
where its return type is not one, called for its value:

```
$ node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe
tera compile: warning: skipped 'describe' (x64-windows backend cannot emit: function returns a string but its return type is not a string)
tera compile: warning: skipped 'tera_program' (calls unavailable function describe)
tera compile: x64-windows backend cannot emit: entry function tera_program could not be lowered to native code: it calls describe, skipped because x64-windows backend cannot emit: function returns a string but its return type is not a string
$ echo $?
1
```

And the identical refusal in a program that never uses the result — four lines saved as
`/tmp/cascade.tera`, an `odd(n)` whose value is discarded:

```
$ node dist/cli.js compile /tmp/cascade.tera -o /tmp/cascade.exe
tera compile: note: 'odd' is not in the binary, and nothing the program runs calls it (x64-windows backend cannot emit: function returns a string but its return type is not a string)
tera compile: wrote C:\Users\slexi\AppData\Local\Temp\cascade.exe
$ /tmp/cascade.exe
1
```

Same backend, same sentence in the parentheses, exit 0 and a working binary. `odd` was
refused; the call to it had already been removed as dead, so `caller` referenced no missing
symbol and the cascade never started. The compiler shipped the program and told you what it
left behind.

The third case is a whole-module property and not a per-function one, so it is thrown before
any lowering begins. `requireDeclaredParameters` (`src/optimizing/drivers/aot.ts:588-601`)
walks every unit before the first stage that could benefit and throws
`AotUndeclaredParameterError` if any parameter has no declared type. The compiler cannot
begin, because a parameter with no type has no scalar, so it has no register class, so the
function has no calling convention.

> **Broken.** `docs/example/stats-poly.tera` cannot be compiled at all, and the reason is
> not polymorphism. `fn report(s)` declares no parameter type, so
> `requireDeclaredParameters` throws before legality is ever consulted. Measured 2026-09-08:
>
> ```
> $ node dist/cli.js compile docs/example/stats-poly.tera -o /tmp/poly.exe
> tera compile: compiling ahead of time needs every parameter to have a declared type
>   report: parameter 's' has no declared type; declare it (for example 's: int'), or keep this part interpreted
> $ echo $?
> 1
> ```
>
> The message is good — it is the one message in the file that offers a concrete edit — but
> the file is listed in `docs/example/README.md` as chapter 57's structural-dispatch example
> and does not reach dispatch. Cost to fix the *example*: declare an interface both `Series`
> and `Constant` conform to and annotate `s`, two lines. Cost to fix the *compiler*: infer
> the parameter from its call sites the way `adopt-inferred-types` already does for some
> shapes, which is a real design question about how much a whole-program compiler may
> conclude from the calls it can see, not a patch.

## The cascade

When a function is skipped, the functions that called it are still compiled and still hold a
reference to a symbol that will not exist. `dropUnresolvedCallers`
([Ch 55 § dropping-the-callers-of-what-was-dropped]) closes that with a worklist, and it
records more than it prints:

```ts
    const missing = named.get(symbol);
    skipped.push({
      name: fn.name,
      reason: `calls unavailable function ${missing ?? symbol}`,
      ...(missing === undefined ? {} : { missing }),
    });
```
— `src/optimizing/drivers/aot.ts:174-179`

The `reason` names the missing callee and nothing else. Read line 2 of the
`stats-refused.tera` output on its own and it is genuinely worse than line 1: *`tera_program`
calls an unavailable function called `describe`* tells you nothing about why `describe` is
unavailable, and a user who reads only that line has to scroll up. This is exactly the
recurring pattern `docs/CONVENTIONS.md` rule 5 exists for, which is why both messages are
quoted above rather than the first one.

The third field, `missing`, is what would let a better message be assembled — and, since the
outlines for this book were written, it is:

*(Bug as engineering — closed.)* **Symptom.** The information needed to write "`tera_program`
calls `describe`, which was skipped because …" was captured on `AotSkippedFunction.missing`
and thrown away; the user saw two disconnected lines. **Mechanism.** `missing` had no
reader anywhere in `src/`. **Fix.** `droppedCause` (`src/optimizing/target/entry.ts:56-73`)
walks the `missing` chain to a fixpoint, guarded by a `seen` set against a cycle, collecting
names, and returns `it calls ${calls.join(" -> ")}, skipped because ${cause.reason}` —
following the chain to arbitrary depth and joining the whole path with `->`. It is called
from `missingEntryReason` (`:75-86`), which is what `selectEntry`
(`src/cli/compile.ts:132-151`) throws when the cascade reached the entry. That is line 3 of
the output above, and reading it against line 2 shows the join: *it calls describe, skipped
because x64-windows backend cannot emit: function returns a string but its return type is
not a string.* **Regression test.**
`[t: tests/e2e/docs/book-examples.test.ts > "stats-refused.tera runs in the interpreter but is declined by the backend"]`
is the only test in the tree that exercises it, and it asserts the cause substring rather
than the join — so the join itself is **[unpinned]**. **General rule.** A record that names
*why* something was dropped is not enough; the record has to name *what it was dropped
because of*, as data, or no downstream message can reconstruct the chain.

The residual gap is narrower than the outline's and still real: the join happens in the
*entry* message only. `warnSkipped` still prints its own lines unjoined even though it is
handed the same list, so a cascade that never reaches the entry produces disconnected
warnings and no third line. Closing that is one call to `droppedCause` inside `warnSkipped`,
about ten lines and no new data.

## Refusing well

A compiler with no fallback tier has two options: compile the program, or reject it. tera
has a third, and this chapter is what paying for it looks like.

**Compile what you can, and say — in the user's vocabulary — what you left behind.**

That option only exists because a refused function still runs. The interpreter is not a
consolation prize here; it is the thing that makes a per-function refusal a *sound*
outcome rather than a hole in the program. A compiler with no interpreter under it would
have to reject `stats-refused.tera` whole, the way [Ch 1 § the-cold-open]'s `queue.tera` is
rejected whole by the checker — one grain coarser, and one worse answer for the person
holding it.

Everything in `aot-legality.ts` is that option being paid for. Forty-nine places where the
analysis stops and writes a sentence. A first-failure-wins rule so the sentence is the
useful one. A demand join whose failure mode is prose. An absence model small enough that
its two refusals can name the exact edit. And a `reason` field that travels from the
analysis, through the driver's skip list, through a worklist that decides who else is
affected, out to a warning or a note or an entry-point error — three different meanings for
one string, chosen by whether the program needs the function at all.

Chapter 57 is the same discipline against a harder subject. Every refusal in this chapter
was about a *value*; the ones in the next are about *layout* — what a class becomes when
there is no hidden class, no transition tree and no map word to read at run time, and what
happens to a program whose objects do not agree on a shape.

## What leaves

An `AotLegality` per admitted function: `scalarOf` for every value, `parameterScalars` and
`returnScalar` and `constants` for the signature, a root-slot numbering for chapter 61's
shadow stack, and a set of `AotStringBuffer`s for chapter 59's static storage — computed by
one walk, cached under `aotLegalityAnalysisId`, and complete enough that the emitter
recomputes none of it.

Or, for a function the analysis declined, an `AotSkippedFunction { name, reason, missing? }`
carrying one English sentence, which the driver's `dropUnresolvedCallers` may turn into more
of them, and which `tera compile` renders as a warning, a note, or the text of an
entry-point error depending on whether the program needed the function.

What the emitter still does not have is a *layout*. `scalarOf` says a value is
`SCALAR_POINTER`; it does not say what is at offset 8 of the thing it points at, or how many
bytes to allocate, or which of two classes answering the same method this receiver belongs
to. [Ch 57 § the-class-table] is where a class becomes a static record with no runtime shape
at all, and where the `FIELD_SCALAR_PROP` this chapter read off a `LoadField` is put there
in the first place.

## Verify it yourself

```bash
# three messages about one problem, in three different registers
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe; echo "exit=$?"

# the interpreter runs the same file: 15.7, unformatted, because describe returns a float there
node dist/cli.js docs/example/stats-refused.tera

# the fix the first message asks for, half done: the checker names the cause the AOT
# refusal named a symptom of. (Copy stats-refused.tera and add `-> string` to describe.)
node dist/cli.js compile /tmp/refused-fix1.tera -o /tmp/rf1.exe
# tera compile: 16:10 Type 'float' is not assignable to return type 'string'

# and done: also make the second return produce a string, with .to_fixed(2)
node dist/cli.js compile /tmp/refused-fix2.tera -o /tmp/rf2.exe && /tmp/rf2.exe
node dist/cli.js /tmp/refused-fix2.tera

# the same refusal as a note, on a build that succeeds. Save these four lines as
# /tmp/cascade.tera with an editor, not a heredoc:
#   fn odd(n: int):
#     if n > 0:
#       return "big"
#     return n
#   fn caller(n: int) -> int:
#     odd(n)
#     return n
#   print(caller(1))
node dist/cli.js compile /tmp/cascade.tera -o /tmp/cascade.exe && /tmp/cascade.exe

# the poly example is refused before legality, and not for polymorphism
node dist/cli.js compile docs/example/stats-poly.tera -o /tmp/poly.exe; echo "exit=$?"

# the closure example: half of it compiles, and the note names the half that did not
node dist/cli.js compile docs/example/stats-closure.tera --emit source --target c -o /tmp/closure-c
grep "^double" /tmp/closure-c/stats-closure.h

# 49 places this analysis can refuse; the promised closing clause appears 25 times
grep -c "this.fail(" src/optimizing/analyses/aot-legality.ts
grep -c "keep this part interpreted" src/optimizing/analyses/aot-legality.ts

# bits== is produced in exactly one place: index_of's per-element test
grep -rn "BITS_COMPARISON" src/

npx vitest run --project unit tests/optimizing/analyses/aot-legality.test.ts
npx vitest run --project unit tests/optimizing/metadata/printed-values.test.ts
npx vitest run --project native tests/e2e/optimizing/aot/absent-number-text.test.ts
```

The three `stats-refused.tera` lines name `x64-windows` because that is this host; on Linux
they name `x86-64-sysv`. `refused-fix1.tera` and `refused-fix2.tera` are the two-line and
three-line edits of `docs/example/stats-refused.tera` described in the comments, made with
an editor outside the repository — they are deliberately not in the example set, because
`tests/e2e/docs/book-examples.test.ts` pins one expected output per file and a file whose
whole point is to stop being refused has two.

## Tests that pin this

- `tests/optimizing/analyses/aot-legality.test.ts` > `"takes scalar types from the declared signature"`
  — the declared type wins, because the layout was built from it.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"infers a return type when the signature declares none"`
  — and the lattice is the fallback, not the source of truth.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"gives an element access the width the array was shaped with"`
  — the stamped layout beating the inferred type.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"carries undefined as a number, so its payload survives"`
  and > `"carries null as a number the same way"`
  — the demand join's default when no use demands anything.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"leaves an unused absence constant without a representation"`
  and > `"leaves a void function answering undefined alone"`
  — the two `SCALAR_VOID` exits.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"accepts undefined held as a reference the declared type names as the only absence"`
  — `absenceFlavourIsNamed`: one absence in the declaration, so the pointer is unambiguous.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses it where the declared type admits both, so one pointer means two things"`
  — the same store, one word added to the declaration.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses it where the declared type names no absence to read it as"`
  — and one word removed.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"still accepts null held as a reference"`
  — the flavour the null address is spent on.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses a merge of a possibly absent value into a whole-number return"`
  and > `"accepts the same merge where the return type can say absent"`
  — the same rule at a return rather than a store.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses a parameter whose type the source never declared"`
  and > `"names the rest parameter when a gathered argument has no declared type"`
  — the one message that offers a concrete edit, in both its arms.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the unsupported opcode it found"`
  and > `"rejects a global whose value is used, and names it"`
  — two refusals that name the thing rather than the category.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the property when nothing spreads what it read"`
  and > `"blames the spread instead when the read is spread into a call"`
  — first-failure-wins, and why the walk order changes which sentence you get.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"reads an absence against a number as a number"`,
  > `"reads an absence against a string as a reference"`,
  > `"reads two absences as numbers when one of them has no reference to be"`,
  > `"refuses one over a reference, which carries no number to read bits from"`
  — `absenceComparesAsNumber` and `comparesBits`, four cases.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"gives each rooted value a slot of its own"`,
  > `"numbers the slots from zero without a gap"`, > `"leaves a value nothing uses unrooted"`
  — the root-slot numbering chapter 61 builds a frame from.
- `tests/optimizing/metadata/printed-values.test.ts` > `"tells null and undefined apart by the text they print"`
  and > `"gives each one its own float64 payload"`
  — two flavours, two payloads.
- `tests/optimizing/metadata/printed-values.test.ts` > `"keeps every payload a quiet NaN, so no finite number is read as absent"`
  — exponent `0x7ff`, mantissa non-zero, asserted over both values.
- `tests/optimizing/metadata/printed-values.test.ts` > `"marks only the flavour a null reference stands for as reference-held"`
  — the filtered list is exactly `[absenceValueOf(null)]`.
- `tests/optimizing/metadata/printed-values.test.ts` > `"answers nothing when a type admits both, since the two cannot be told apart"`
  — `declaredAbsenceText` refuses to guess between two named absences.
- `tests/optimizing/metadata/printed-values.test.ts` > `"spells the absence when every branch carries the same one"`,
  > `"answers nothing when the branches disagree, since neither word is right"`,
  > `"answers the word the entering branch carries rather than recursing forever"`
  — `joinedAbsenceText` over a phi, including the loop-carried case the `seen` set exists for.
- `tests/optimizing/types/lattice.test.ts` > `"holds an integer that admits absence in a float"`,
  > `"keeps the absence the integer admitted"`, > `"leaves an integer that is always present alone"`
  — `heldNumericType`, the general rule stated as a lattice function.
- `tests/e2e/optimizing/aot/absent-number-text.test.ts` > `"spells out an integer a drain did not find the way the interpreter does"`,
  > `"spells out the null a declared return admits the way the interpreter does"`,
  > `"spells out the undefined a declared return admits the way the interpreter does"`,
  > `"keeps rendering the integer a drain did find the way the interpreter does"`
  — four of the seven `RENDERED` cases, each a real PE executable compared to the
  interpreter's stdout. The titles are generated as `` `${name} the way the interpreter does` ``.
- `tests/e2e/optimizing/aot/absent-number-text.test.ts` > `"spells out an integer a drain did not find through the C backend"`
  — the same program on the second AOT backend.
- `tests/optimizing/backends/c/emit.test.ts` > `"prints a text of its own for every absence payload"`
  and > `"decides the printed text before it reads the exponent out of the payload"`
  — the order matters: a payload read as a float first would print `nan`.
- `tests/optimizing/backends/x64/absence.test.ts` > `"tests each operand against every absence payload the language has"`
  and > `"gives an absent reference the null pointer instead of a number"`
  — `loose==` and the one address `null` is spent on, in machine code.
- `tests/e2e/docs/book-examples.test.ts` > `"stats-refused.tera runs in the interpreter but is declined by the backend"`
  — the worked example's two halves, pinned together.
- `dropUnresolvedCallers`, `warnSkipped`, `noteLeftOut` and `droppedCause`'s `->` join —
  **[unpinned]**. No test names any of the four. The cascade is exercised only through the
  CLI, and the one e2e test that reaches it asserts the cause substring, not the join.
