# 56. Legality, and the art of refusing well   ⟨ I · N ⟩

> **Status:** outline

**Thesis.** With no `Box` and no deopt, a value that cannot be given one scalar is not
converted — it is refused, in a sentence a programmer can act on.

**What arrived.** A `CFGFunction` legalized for one native `AotBackend`: no frame
states, no guards, `graph.emits` and `graph.capabilities` stamped, and — from chapter
55's module pass — `graph.stringEscapes` and `graph.wideText` carrying whole-program
answers.

**What leaves.** Either an `AotLegality` — a per-value `AotScalar` map, a root-slot
numbering, a set of `AotStringBuffer`s, a parameter/return scalar list and a constant
list, everything the emitter needs and nothing it must recompute — or an
`AotSkippedFunction` whose `reason` is one English sentence.

**New ideas.** *An analysis whose output is a diagnostic*; *demand* (what a use
requires of a value, as opposed to what the value is); *join over uses*; *quiet NaN
payload*; *the holding domain* vs the checker type.

**Length.** 14 pages

## Anchors

- `src/optimizing/analyses/aot-legality.ts` — 1,995 lines, the largest file under
  `src/optimizing/analyses/` by a factor of four. Exports to name:
  `analyzeAotLegality`, `aotLegalityAnalysisId`, `aotLegalityAnalysis`, `AotLegality`,
  `AotLegalityResult` (an ok/reason union, not a throw), `AotStringBuffer`,
  `StringEscapeSummary`, `StringEscapeModel`, `StringBufferRules`, `StringBufferWalk`,
  `summarizeStringEscapes`, `mergedTextInputs`, `rootSlotsOf`, `isRootedPointer`,
  `undeclaredParameterOf`, `undeclaredParameterReason`, `builtinOperandScalar`,
  `holdsOwnText`, `codeSymbolOf`, `isAbsenceConstant`, `int32ConstantOf`,
  `AOT_OPCODES`, `AOT_BUILTINS`, `AOT_PRINTABLE`, `AOT_CHAR_AT`, `AOT_INT_TO_STRING`,
  `AOT_FLOAT_TO_STRING`, `CODE_TARGET_PROP`, `SPREAD_CALL_REASON`.
- The absence machinery inside it: `absenceScalarOf` (lines 1322-1336),
  `absenceDemandOf` (1362-1381), `declaredScalarAt`, `passedScalarOf`,
  `sharedAbsenceScalarOf`, `carriesAbsence`, `absenceFlavourIsNamed`, and the two
  refusals in `checkConstant` (1528-1550).
- `src/optimizing/metadata/printed-values.ts` — `AbsenceValue { text, bits, reference }`,
  `ABSENCE_BY_HELD` (the whole model, two entries), `ABSENCE_VALUES`,
  `absenceValueOf`, `declaredAbsenceText`, `absenceTextOf`, `referenceAbsenceTextOf`,
  `heldAsReference`, `joinedAbsenceText`, `NULL_TEXT`, `UNDEFINED_TEXT`,
  `ABSENCE_COMPARISON = "loose=="`, `BITS_COMPARISON = "bits=="`.
- `src/optimizing/target/float64.ts` — `FLOAT64_NULL_BITS = 0x7ff8_0000_0000_0001n`
  and `FLOAT64_UNDEFINED_BITS = 0x7ff8_0000_0000_0002n`, plus the IEEE constants the
  rest of this part reads (`FLOAT64_MANTISSA_BITS`, `FLOAT64_EXPONENT_BIAS`,
  `FLOAT64_LIMBS`, `FLOAT64_DECIMAL_BYTES`).
- `src/optimizing/types/scalar.ts` — `carriesAbsence(scalar)`, defined by asking
  `aotScalarOf(nullableNumericType(smiType()))` rather than by naming a kind.
- `src/optimizing/types/lattice.ts:147-149` — `heldNumericType`: an `int` that admits
  absence is *held* as a `double`, because that is where the payload fits.
- `src/optimizing/target/artifact.ts` — `AotSkippedFunction { name, reason, missing? }`.
- `src/cli/compile.ts:73-86` — `warnSkipped` (`tera compile: warning: skipped '<name>'
  (<reason>)`) and `noteLeftOut` (`tera compile: note: '<name>' is not in the binary,
  and nothing the program runs calls it (<reason>)`). Two functions, one shape of data,
  two very different meanings.
- `src/optimizing/drivers/aot.ts:148-194` — `dropUnresolvedCallers`, the cascade;
  `AotLinkError` and `AotUndeclaredParameterError`.
- `tests/optimizing/analyses/aot-legality.test.ts` — 1,236 lines, 94 tests, the
  chapter's evidence base.
- `tests/e2e/optimizing/aot/absent-number-text.test.ts` — the seven `RENDERED` cases.
- `tests/optimizing/metadata/printed-values.test.ts`,
  `tests/optimizing/backends/x64/absence.test.ts`,
  `tests/optimizing/backends/c/emit.test.ts` (the `describe("what the C backend emits
  for an absent number")` block).

## Worked example

`docs/example/stats-refused.tera` — one function returning `string` on one path and
`float` on the other. Compiling it prints three lines, and they are three different
messages about one problem:

```
$ node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe
tera compile: warning: skipped 'describe' (x64-windows backend cannot emit: function returns a string but its return type is not a string)
tera compile: warning: skipped 'tera_program' (calls unavailable function describe)
tera compile: x64-windows backend cannot emit: entry function tera_program could not be lowered to native code: it calls describe, skipped because x64-windows backend cannot emit: function returns a string but its return type is not a string
$ echo $?
1
```

The first names the cause; the second is `dropUnresolvedCallers` at work; the third is
`selectEntry` failing because the cascade reached the entry. Then the fix the first
message asks for — declare the return type — and what happens:

```
$ node dist/cli.js compile /tmp/refused-fix1.tera -o /tmp/rf1.exe   # only `-> string` added
tera compile: 16:10 Type 'float' is not assignable to return type 'string'
```

The AOT refusal named a *symptom* ("its return type is not a string"); the checker
names the *cause* (two branches, two types). Both messages are needed, which is why
`docs/CONVENTIONS.md` rule 5 requires showing both. Two lines fix it — annotate
`-> string` and make the second `return` produce one:

```
$ node dist/cli.js compile /tmp/refused-fix2.tera -o /tmp/rf2.exe && /tmp/rf2.exe
latency mean=15.70
15.70
```

## Outline

- [ ] **§ an-analysis-that-writes-prose** — Establish what kind of thing
      `analyzeAotLegality` is. It is registered as an ordinary analysis
      (`aotLegalityAnalysisId`, invalidated like any other), it returns a discriminated
      union rather than throwing, and roughly two-thirds of its bulk is the text of its
      failures. Contrast with every analysis in Part VII, whose output is a fact.
      **`> **New idea.** An analysis whose output is a diagnostic** — and the reason it
      must be one: the JIT can answer "I don't know" by not compiling, silently; a
      compiler producing a file has to explain itself to a person.
      State the honest scale: 1,995 lines, the largest file in `src/optimizing/analyses/`,
      fourth largest in `src/optimizing/` behind `wasm/codegen.ts` (4,860),
      `c/emit.ts` (2,591) and `builder/ir-builder.ts` (2,272).
- [ ] **§ what-it-actually-computes** — Four outputs, one walk. (a) `scalarOf(value)`
      for every value — the per-value `AotScalar` assignment; (b) `rootSlotsOf` — a
      dense numbering of every `SCALAR_POINTER` value that has a use, which chapter 61's
      shadow stack is built from; (c) `stringBuffers` / `stringBufferOf` — which static
      buffer each produced string lives in, chapter 59's subject; (d)
      `parameterScalars` / `returnScalar` / `constants` — the emitter's signature.
      Establish that these are not four passes: the same node walk answers all four,
      because each depends on the scalar assignment.
- [ ] **§ where-a-scalar-comes-from** — The assignment rules, in the order the analysis
      tries them: a declared signature (`declaredScalarAt`, `passedScalarOf`); a
      stamped layout (`FIELD_SCALAR_PROP`, `ARRAY_ELEMENT_SCALAR_PROP`, set by chapter
      57's passes); a callee's answered type; and only last `aotScalarOf(types.typeOf(v))`
      off the lattice. Establish the ordering rule: **the declared type wins over the
      inferred one, because the declared type is what the layout was built from.**
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "takes scalar types from the
      declared signature"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "infers a return type when the
      signature declares none"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "gives an element access the
      width the array was shaped with"]`
- [ ] **§ two-absence-values-one-payload-each** — The model, which is twelve lines:
      `ABSENCE_BY_HELD` maps `null → { "null", 0x7ff8000000000001n, reference: true }`
      and `undefined → { "undefined", 0x7ff8000000000002n, reference: false }`.
      **`> **New idea.** Quiet NaN payload** — an IEEE-754 double has 2^51 distinct NaN
      bit patterns; two of them are spent here, and *no finite number can be mistaken
      for one*. Show the byte layout as a fixed-width table (sign / 11 exponent bits /
      quiet bit / 51 payload bits) with the two constants marked. Establish why the
      trick works in a number and not in a pointer: a reference position holds one
      address, so `0` can stand for exactly one absence, and the model gives it to
      `null` (`reference: true`).
      `[t: tests/optimizing/metadata/printed-values.test.ts > "keeps every payload a quiet
      NaN, so no finite number is read as absent"]`
      `[t: tests/optimizing/metadata/printed-values.test.ts > "marks only the flavour a null
      reference stands for as reference-held"]`
- [ ] **§ demand-is-a-join-over-uses** — The chapter's central mechanism.
      `absenceScalarOf(node, absence)` does not ask what the constant *is* — a bare
      `null` is nothing in particular. It asks every use what it *demands*
      (`absenceDemandOf`: a field store demands the field's scalar; an element store the
      element's; a return the declared return's; a known call the parameter's; anything
      else falls back to the other operands' scalars) and joins:

      ```ts
      let joined: AotScalar | null = null;
      for (const use of node.uses) {
        const demanded = this.absenceDemandOf(use, node);
        if (demanded === null) continue;
        if (joined !== null && joined !== demanded) return null;
        joined = demanded;
      }
      ```

      — src/optimizing/analyses/aot-legality.ts:1326-1332

      **`> **New idea.** Demand** — information flowing *backwards* from uses to
      definitions, the mirror of the type inference of Part VII, which flowed forwards
      from definitions. Note the three fallbacks after the loop: no uses at all →
      `SCALAR_VOID`; only returns from a void function → `SCALAR_VOID`; otherwise the
      flavour's own default.
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "carries undefined as a number,
      so its payload survives"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "leaves an unused absence constant
      without a representation"]`
- [ ] **§ when-the-join-conflicts** — `return null` from the loop above becomes one
      sentence:

      > `null is read here both as a number and as a reference, and one constant cannot
      > be both; keep this part interpreted`

      and its sibling, for a value that is `undefined` held where a pointer lives:

      > `undefined is held here as a reference, where it cannot be told apart from null;
      > use null, or keep this part interpreted`

      Establish the design rule this is the clearest case of: **the refusal names the
      program's shape, not the compiler's internals.** Neither sentence contains the
      word "scalar", "lattice" or "IR". Contrast with the sentence a naive
      implementation writes ("cannot unify float64 with pointer at v34").
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "refuses it where the declared
      type admits both, so one pointer means two things"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "refuses it where the declared
      type names no absence to read it as"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "accepts undefined held as a
      reference the declared type names as the only absence"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "still accepts null held as a
      reference"]`
- [ ] **§ the-holding-domain-not-the-type** — *Bugs are told as engineering.*
      **Symptom:** `fn pick(n: int) -> int | undefined` printed `0` for the absent case
      instead of `undefined`. **Mechanism:** the code that renders a number as text asked
      the *checker type* what word to print. The checker type of the returned value in
      that branch is `undefined`; the type of the *variable* is `int | undefined`; and
      the renderer was reading whichever it reached first. **Fix:** `absenceTextOf`
      (`src/optimizing/metadata/printed-values.ts:85-98`) asks the value that holds the
      payload — constant → its own flavour, phi → `joinedAbsenceText` over the arms, a
      value with a declared type → `declaredAbsenceText` of that type, which answers
      only when the type names *exactly one* absence. **Regression test:**
      `[t: tests/e2e/optimizing/aot/absent-number-text.test.ts > "spells out the undefined a
      declared return admits the way the interpreter does"]`. **General rule:** the
      question a lowering asks is always "what domain currently *holds* this value",
      never "what did the checker call it". `heldNumericType` is the same rule as a
      lattice function: an `int` that admits absence is held as a `double`, because a
      32-bit word has no spare NaN.
      `[t: tests/optimizing/types/lattice.test.ts > "holds an integer that admits absence in
      a float"]`
      `[t: tests/optimizing/types/lattice.test.ts > "keeps the absence the integer admitted"]`
- [ ] **§ comparing-absences** — Two operators exist because of the payload trick and
      neither is spelled in source. `ABSENCE_COMPARISON = "loose=="` compares two values
      as absence *flags* (is either payload one of the two?) rather than as bit patterns,
      so `null == undefined` is true the way the interpreter says. `BITS_COMPARISON =
      "bits=="` compares the whole 64-bit word, and exists because an ordinary float
      equality cannot find a NaN — which is why `index_of` over an array holding an
      absence needed a new opcode. Establish `absenceComparesAsNumber` as the rule that
      picks between reading an absence as a number or as a reference.
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "reads an absence against a
      number as a number"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "reads an absence against a
      string as a reference"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "refuses one over a reference,
      which carries no number to read bits from"]`
      `[t: tests/optimizing/backends/x64/absence.test.ts > "tests each operand against every
      absence payload the language has"]`
- [ ] **§ root-slots-and-string-buffers-fall-out** — Brief, because both have their own
      chapters, but establish *why they live here*: both are questions about scalars.
      `isRootedPointer` is exactly `scalarOf(value) === SCALAR_POINTER` plus two
      exclusions (`IR_RUNTIME_BASE`, and a value nothing uses); `rootSlotsOf` numbers
      what survives from zero with no gaps. The string-buffer machinery is the same walk
      asking which values have `SCALAR_STRING`. Forward-reference
      [Ch 61 § one-slot-per-value] and [Ch 59 § the-lifetime-proof].
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "gives each rooted value a slot
      of its own"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "numbers the slots from zero
      without a gap"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "leaves a value nothing uses
      unrooted"]`
- [ ] **§ the-shape-of-a-refusal** — Anatomy of the sentences, as a catalogue with the
      pattern named. Nearly every one has three parts: *what the program did* ("`f`
      stores a string of 40 characters in `name`"), *why it cannot be compiled* ("which
      holds 15"), and *at least one way out* ("shorten it, or keep this part
      interpreted"). Establish the closing clause as a deliberate contract: there is
      **always** a way out, because the interpreter always exists. Count the endings and
      say so. Then the counter-example that proves the rule:
      `undeclaredParameterReason` says "declare it (for example 's: int')" — it offers
      a concrete edit, and is the only message that does.
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "refuses a parameter whose type
      the source never declared"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "names the rest parameter when a
      gathered argument has no declared type"]`
- [ ] **§ warning-note-and-error** — Three outcomes, and the driver decides which by
      *reachability*, not by severity. `warnSkipped` fires from the `AotLinkError` path:
      the build failed and these are why. `noteLeftOut` fires on a *successful* build:
      the function is not in the binary and nothing that runs calls it, so the program
      is complete without it. And an `AotUndeclaredParameterError` is thrown before any
      lowering, because the compiler cannot even begin. Establish the design claim:
      **the same `AotSkippedFunction` is a warning, a note, or nothing, depending on
      whether the program needs it.** Show `docs/example/stats-closure.tera`'s
      `--emit source` note beside `stats-refused.tera`'s warnings.
- [ ] **§ the-cascade** — `dropUnresolvedCallers` as a worklist: build a
      symbol → callers map, drop every function referencing an undefined symbol, then
      every caller of a dropped function, to a fixpoint. Establish why the second
      message reads worse than the first (`calls unavailable function describe` names
      the missing callee, not the reason) and that this is exactly the recurring pattern
      `docs/CONVENTIONS.md` rule 5 exists for. Note the `missing` field on
      `AotSkippedFunction`, which carries the original name so a better message *could*
      be assembled — see § honesty-items.
- [ ] **§ refusing-well** — Close on the general rule, stated once. A compiler with a
      fallback tier has a third option besides "compile it" and "reject the program":
      **compile what it can and say, in the user's vocabulary, what it left behind.**
      Every sentence in this file is that option being paid for. Hand over to chapter 57,
      whose refusals are all about layout.

## Honesty items

- `> **Unfinished.**` — `AotSkippedFunction.missing` is set by `dropUnresolvedCallers`
  (`src/optimizing/drivers/aot.ts:175-179`) and read by nothing. The information needed
  to write "`tera_program` calls `describe`, which was skipped because …" is captured
  and then discarded; the user sees two disconnected lines instead. Cost to finish: one
  join in `warnSkipped` (`src/cli/compile.ts:73-77`) over the skipped list, roughly ten
  lines, no new data.
- `> **Broken.**` — `docs/example/stats-poly.tera` cannot be compiled at all, and the
  reason is not polymorphism: `fn report(s)` has no declared parameter type, so
  `requireDeclaredParameters` throws `AotUndeclaredParameterError` before legality is
  ever consulted. The message is good (`report: parameter 's' has no declared type;
  declare it (for example 's: int'), or keep this part interpreted`) but the file is
  listed in `docs/example/README.md` as chapter 57's example and does not reach it. Cost
  to fix the *example*: declare an interface both classes conform to and annotate `s` —
  two lines. Cost to fix the *compiler*: infer the parameter from call sites the way
  `adoptInferredTypes` already does for some shapes, which is a real design question,
  not a patch.
- `> **Unenforced.**` — the closing clause "or keep this part interpreted" is a contract
  the book states and nothing checks. There is no test asserting that every string
  passed to `this.fail(...)` ends that way, and several (`unsupported builtin ${name}`,
  `duplicate symbol ${symbol}`, `unsupported property ${name}`) do not. Cost: a lint
  test over the file's string literals, or a `fail(what, remedy)` two-argument helper —
  the second is a ~60-site mechanical change.
- `> **Unfinished.**` — `SCALAR_VOID` has no entry in `SCALAR_WIDTHS`
  (`src/optimizing/types/scalar.ts:56-63`), so `scalarWidth(SCALAR_VOID)` throws
  `no storage width for void`. That is correct — a void has no storage — but it is
  enforced by a thrown `Error` reaching the user rather than by the type system, and
  `isStorableScalar` exists precisely to filter it out beforehand. Every caller must
  remember to call it. Cost: split `AotScalar` into `StorableScalar | typeof
  SCALAR_VOID` and let the compiler check the callers.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe; echo "exit=$?"
node dist/cli.js compile docs/example/stats-poly.tera -o /tmp/poly.exe; echo "exit=$?"
node dist/cli.js compile docs/example/stats-closure.tera --emit source --target c -o /tmp/closure-c
npx vitest run --project unit tests/optimizing/analyses/aot-legality.test.ts
npx vitest run --project unit tests/optimizing/metadata/printed-values.test.ts
npx vitest run --project native tests/e2e/optimizing/aot/absent-number-text.test.ts
```

## Tests that pin this

- `tests/optimizing/analyses/aot-legality.test.ts` > `"carries undefined as a number, so its payload survives"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"carries null as a number the same way"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"accepts undefined held as a reference the declared type names as the only absence"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses it where the declared type admits both, so one pointer means two things"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses it where the declared type names no absence to read it as"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"still accepts null held as a reference"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"leaves an unused absence constant without a representation"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"leaves a void function answering undefined alone"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"takes scalar types from the declared signature"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"infers a return type when the signature declares none"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses a parameter whose type the source never declared"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the rest parameter when a gathered argument has no declared type"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the unsupported opcode it found"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"rejects a global whose value is used, and names it"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"reads an absence against a number as a number"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"reads an absence against a string as a reference"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"reads two absences as numbers when one of them has no reference to be"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses one over a reference, which carries no number to read bits from"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"gives each rooted value a slot of its own"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"numbers the slots from zero without a gap"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"leaves a value nothing uses unrooted"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"refuses a merge of a possibly absent value into a whole-number return"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"accepts the same merge where the return type can say absent"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the property when nothing spreads what it read"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"blames the spread instead when the read is spread into a call"`
- `tests/optimizing/metadata/printed-values.test.ts` > `"tells null and undefined apart by the text they print"`
- `tests/optimizing/metadata/printed-values.test.ts` > `"gives each one its own float64 payload"`
- `tests/optimizing/metadata/printed-values.test.ts` > `"keeps every payload a quiet NaN, so no finite number is read as absent"`
- `tests/optimizing/metadata/printed-values.test.ts` > `"marks only the flavour a null reference stands for as reference-held"`
- `tests/optimizing/metadata/printed-values.test.ts` > `"answers nothing when a type admits both, since the two cannot be told apart"`
- `tests/optimizing/metadata/printed-values.test.ts` > `"spells the absence when every branch carries the same one"`
- `tests/optimizing/metadata/printed-values.test.ts` > `"answers nothing when the branches disagree, since neither word is right"`
- `tests/optimizing/metadata/printed-values.test.ts` > `"answers the word the entering branch carries rather than recursing forever"`
- `tests/optimizing/types/lattice.test.ts` > `"holds an integer that admits absence in a float"`
- `tests/optimizing/types/lattice.test.ts` > `"keeps the absence the integer admitted"`
- `tests/optimizing/types/lattice.test.ts` > `"leaves an integer that is always present alone"`
- `tests/e2e/optimizing/aot/absent-number-text.test.ts` > `"spells out an integer a drain did not find the way the interpreter does"`
- `tests/e2e/optimizing/aot/absent-number-text.test.ts` > `"spells out the null a declared return admits the way the interpreter does"`
- `tests/e2e/optimizing/aot/absent-number-text.test.ts` > `"spells out the undefined a declared return admits the way the interpreter does"`
- `tests/e2e/optimizing/aot/absent-number-text.test.ts` > `"keeps rendering the integer a drain did find the way the interpreter does"`
- `tests/e2e/optimizing/aot/absent-number-text.test.ts` > `"spells out an integer a drain did not find through the C backend"`
- `tests/optimizing/backends/c/emit.test.ts` > `"prints a text of its own for every absence payload"`
- `tests/optimizing/backends/c/emit.test.ts` > `"decides the printed text before it reads the exponent out of the payload"`
- `tests/optimizing/backends/x64/absence.test.ts` > `"tests each operand against every absence payload the language has"`
- `tests/optimizing/backends/x64/absence.test.ts` > `"gives an absent reference the null pointer instead of a number"`
- `dropUnresolvedCallers`, `warnSkipped` and `noteLeftOut` — **[unpinned]**. No test
  names any of the three; the cascade is exercised only through the CLI.
