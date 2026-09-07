# 60. A runtime written in its own language   ⟨I · – · – · N⟩

> **Status:** outline

**Thesis.** Most of tera's native runtime is not C and not TypeScript: it is generated
tera source appended to the user's entry module, re-parsed and re-typechecked with the
user's own program, then inlined, narrowed and register-allocated by exactly the passes
that compiled the user's code.

**What arrived.** A program whose string values have been assigned storage classes —
rodata constants, per-producer static buffers, object-owned inline text — with the
string-boxing pass having already copied any produced string that outlives a call into a
heap object, and the wide-text analysis having decided which members may count characters.
Everything above is about *strings the program already has*. This chapter is about the
functions that produce them, and the fact that those functions are written in tera.

**What leaves.** A single entry module whose AST now contains, in addition to the user's
declarations, every generated class and function the program demanded — `_FixedDigits`,
`_FixedText`, `_m_exp`, `_pn_round`, `TeraMapTextInt`, `Error` — with every call site
already rewritten to name them. Chapter 61 receives this as ordinary user code: it
allocates ordinary objects (`_FixedDigits().cells` is an `int[]` on the heap) and therefore
needs the arena, the shadow stack and the collector like any other object graph. The
prelude is *why* `stats.tera` — five floats and two `Series` — reaches the allocator at all.

**New ideas.** Source-level lowering (a runtime library written in the compiled language
rather than in the host language, and what that buys over a builtin); demand-driven code
generation; correct rounding and what "correctly rounded" means for decimal↔binary
conversion; a bignum limb and why the base is chosen for the *product* to stay in a word
(base 10⁴ for `to_fixed`, base 2¹⁵ for `parse_float`); the sticky bit; round-half-even
versus ECMAScript's round-half-up; fdlibm and the IEEE-754 high word (primer: the layout,
then why every branch in fdlibm is a comparison against one); an *oracle* — the reference
implementation a compiler is judged against, and the fact that here it is V8, not the
mathematical answer.

**Length.** 16 pages

## Anchors

- `src/optimizing/prelude/index.ts` — the whole mechanism in 33 lines. `SourcePrelude`
  (`emit` / `adopt?` / `lowered?`), the `SOURCE_PRELUDES` array (four entries, in order:
  `fixedTextPrelude`+`rewriteFixedTexts`, `textMethodPrelude`+`rewriteTextMethods`,
  `mathTranscendentalPrelude`+`rewriteMathTranscendentals`, `floatModPrelude` with
  `lowered: [FLOAT_MOD_FN]` and *no* adopt), `sourcePreludes` (concatenate),
  `adoptSourcePreludes` (rewrite the calls), `LOWERED_PRELUDE_FUNCTIONS`.
- `src/api/engine.ts:446-467` — `preludeText` fixing the concatenation order
  (`numbers` → `collections` → `errorPrelude` → `json` → `sourcePreludes`), `preludeFor`,
  `adoptPreludeCalls`. `src/api/engine.ts:1400-1414` is the load: `build(...)` is called
  **twice** — once to get `built.entry.source`, then again on
  `` `${built.entry.source}\n${prelude}` `` — so the prelude is text before it is a module
  graph. `mentionsCollections` (line 381), `namesTheEntryCanSpell` (401), `moduleRoots`
  (432), `collectionPreludeFor` (436), `jsonShapesFor` (441). `compileAotInRuntime`
  (line 950) is the single-file path and does the same thing with `[parsed]` for both roots.
- `src/optimizing/prelude/errors.ts` — 31 lines, and the clearest statement of the
  suppression rule: `errorPrelude` returns `""` unless the program *names* `Error`
  (`namesError`) **and** returns `""` if any root *declares* it (`declaresError`). A
  user's `class Error` wins outright.
- `src/optimizing/prelude/fixed-text.ts` — the worked example. `FIXED_TEXT_MEMBER`
  (`to_fixed`), `FIXED_TEXT_FUNCTION` (`_fixed_text`), `FIXED_DIGITS_CLASS`
  (`_FixedDigits`), the private `_FixedText` accumulator class (`textClass`, lines 51-60),
  `storage`/`arithmetic`/`reading`/`loading`/`rendering`/`formatting` emitting the class
  body, and `callSites`/`declaresAnywhere` (299-302) doing the suppression.
  `rewriteFixedTexts` (308-316) moves the receiver into argument 0 and defaults the digits
  to `Literal(0)`. Constants: `LIMB_DIGITS = 4`, `LIMB_BASE = 10000`, `CHUNK_BITS = 16`,
  `MANTISSA_BITS = 53`, `FIVE_STEP = 6`, `MOST_DIGITS = 100`,
  `SHORTEST_TEXT_LIMIT = 1e21`, `RANGE_FAULT`.
- `src/optimizing/prelude/collections.ts` — 371 lines generating eight-ish classes on
  demand. `mapClassName`/`setClassName`/`pairClassName`, `marker()` (line 68) emitting the
  `holds_<key>_<value>` field that keeps structural dispatch from merging them, `table`,
  `fields` (the `taken` / `spot` / `order` / `live` columns), `lookup` (open addressing
  with `taken == 2` as the tombstone), `admit`, `removal`, `rebuild` (163), `compaction`
  (193), `listing`. `HASH_MULTIPLIER = 31`, `HASH_MASK = 1073741823`, `FIRST_MASK = 7`.
- `src/optimizing/prelude/requests.ts` — the demand side for collections:
  `collectionRequestsIn` / `collectionRequestsAcross`, and the identifier-following that
  lets a class-valued map be named.
- `src/optimizing/prelude/parse-number.ts` — 657 lines. `PARSE_FLOAT_FUNCTION`,
  `PARSE_INT_FUNCTION`, `NUMBER_OF_FUNCTION`, `NUMBER_TEXT_READERS`,
  `PARSE_NUMBER_FUNCTIONS`, `PARSE_NUMBER_SIGNATURE`; the `_pn_*` helper names (lines
  17-39); `LIMB_BITS = 15`, `EXACT_DIGITS = 15`, `EXACT_POWER = 22` (Clinger's fast-path
  bounds), `DIGIT_LIMIT = 800`, `MANTISSA_BITS = 53`; the generated blocks in order —
  `storage` (126), `arithmetic` (142), `shifting` (194), `floats` (267), `assembling` (406),
  `scanning` (432), `radix` (562), `reading` (513) — and inside them `fastPath` (303),
  `ratio` (316), `binade` (338), `divide` (358), `rounding` (383) with `cut` as the sticky
  bit and `_pn_odd` as the half-even tiebreak; `readsNumbers` / `parseNumberPrelude` (655).
- `src/optimizing/prelude/math-transcendentals.ts` — 751 lines. `wordDouble` (36) turning a
  hex high word into the double the tera source compares against; `POWER_OF_TWO`
  (`_m_pow2`) built from `POWER_STEPS`; `EXPONENT_OF` (`_m_exponent`), a two-directional
  binary ladder; `HIGH_WORD` (`_m_highword`, lines 308-316) — four lines that reconstruct
  the IEEE high word with no bit access:
  `(e + 1023) * 2**20 + Math.trunc((m - 1.0) * 2**20)`; `BIASED_EXPONENT`,
  `TRUNCATED_LOW`, `KERNEL_SIN`, `KERNEL_COS`, `KERNEL_REDUCE`, `REDUCE`; the `HELPERS` and
  `TRANSCENDENTALS` tables with their per-function `needs`; `INTERPRETER_EXP_OF_ONE`
  (line 103) and the `if x == 1.0` early return in `expSource` (110-111).
- `src/optimizing/prelude/text-methods.ts` — `TextMethod` with `member` / `fn` / `arity` /
  `defaults` / `sharedName`; `substring` filling in `STRING_TO_END`, `last_index_of`
  written as a backwards scan over `char_code_at`.
- `src/optimizing/prelude/float-mod.ts` — 54 lines, and the odd one out: no `adopt`.
  `usesRemainder` scans for `%`; the pass `src/optimizing/passes/float-mod.ts`
  (`lowerFloatRemainder`, line 34) does the rewrite in *IR*, so it reaches every module.
  Note `undefined_here: float = (left - left) / (right - right)` — a NaN produced from
  runtime values because AOT refuses a non-finite constant.
- `src/optimizing/prelude/spelling.ts` — 6 lines: `POWER_STEPS` and `float()`, which is why
  every generated literal is `2.0` and not `2`.
- `src/optimizing/drivers/aot.ts:458-471` — `unusedHelpers`, the back half of demand: a
  `lowered` prelude function nothing ended up calling is dropped from the module.
- `src/optimizing/passes/collection-surface.ts` — `lowerCollectionSurface` (343),
  `shapeModuleCollections` (721): the IR-level rewrite that redirects `Map()`'s
  `LoadGlobal` to the generated class, and the reason `Map` works in an imported module
  while `to_fixed` does not.
- `src/optimizing/passes/parse-number-surface.ts` — `lowerParseNumbers` (30),
  `markNumberTextBytewise` (56).

## Worked example

`docs/example/stats.tera`, whose only prelude demand is the `.to_fixed(2)` on its last
line. Emit C and read the generated class as compiled code:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
grep -n "_FixedDigits_format\|_fixed_text\|Series_total" /tmp/stats-c/stats.c
```

`_FixedDigits_format` is a `static const tera_char *(unsigned char *, double, int32_t)` in
the same file, with the same calling convention and the same root-frame discipline, as
`Series_total`. Nothing in the C output distinguishes runtime from user program.

The counter-example is the same file with no compilation: `--print-bytecode` shows the
interpreter's view, and `_FixedDigits` is not in it — the interpreter has a real
`to_fixed`, so it never asks for one.

## Outline

- [ ] **§ what-a-runtime-usually-is** — Establish the shape the reader expects: a runtime
      library written in C, or a set of compiler builtins, linked into every binary. Then
      the count that makes the case here: `to_fixed`, `Math.exp/log/sin/cos`,
      `parse_float`/`parse_int`/`Number(text)`, `%` on floats, `substring`,
      `last_index_of`, `Map`, `Set`, `Error`, `JSON.parse` — every one of them arrives as
      tera source. Name the three backends (`c`, `x64`, `riscv64`) and state the payoff
      plainly: one implementation, three backends, zero backend work.
- [ ] **§ the-mechanism-in-33-lines** — Read `prelude/index.ts` end to end; it is short
      enough to quote almost whole under the 20-line rule if split. Establish the
      `SourcePrelude` triple: `emit(roots) -> string` decides *whether and what*,
      `adopt(roots)` rewrites the call sites, `lowered` names functions a later IR pass
      will call instead. Establish that `emit` is asked before anything is checked, so its
      only input is an AST.
- [ ] **§ emit-and-adopt** — Establish why the pair must be two functions and not one. The
      text is produced *before* the module graph exists (it has to be, it is concatenated
      into the entry source); the rewrite happens *after* the graph is built, on the AST of
      the re-parsed program. Show `preludeFor` and the double `build(...)` at
      `engine.ts:1400-1414`, and state the consequence: the entry module is parsed twice on
      every AOT compile. Then `adoptPreludeCalls` calling `adoptSourcePreludes` on
      `[graph.entry.ast]` only — the first hint of the entry-module-only limit.
- [ ] **§ appended-not-prepended** — *Why the obvious design fails.* The obvious design is
      to prepend the runtime, the way a C compiler includes a header. It is prepended in
      neither path: `` `${source}\n${prelude}` ``. State the reason and the trap it causes:
      because the prelude's statements run *after* the user's top level, **a module-level
      table in prelude source is read before its initializer runs**. Two recorded
      casualties — `_fixed_cells: int[] = []` at module level made the compiled binary read
      a null array; the 2/π and π/2 tables in `_m_rem_pio2` had to be declared *inside* the
      function that reads them, and `npio2_hw`'s fast-path table was deleted outright
      because always taking fdlibm's slow branch is bit-identical. General rule: **prelude
      state lives in a class the caller constructs, or in a local; never at module level.**
- [ ] **§ demand-driven** — Establish that the prelude is a function of the program. Four
      shapes of demand, each read from the code: a member call
      (`fixedTextPrelude` → `callsMember`), a namespace call
      (`mathTranscendentalPrelude` → `namespaceCall` keyed on the identifier `Math`), a
      bare identifier (`errorPrelude` → `namesError`), an operator (`floatModPrelude` →
      `usesRemainder`). Then the second axis — *which parts* — in
      `mathTranscendentalPrelude`: `TRANSCENDENTALS[i].needs` is a helper list, the union
      of the needed helpers is emitted and nothing else, so a program calling only
      `Math.exp` gets `_m_pow2` and not the 750 lines of argument reduction. Same idea in
      `collectionRequestsAcross` (only the key/value instantiations actually used) and in
      `parseNumberPrelude`. Close with the *back* half of demand: `unusedHelpers` in
      `drivers/aot.ts` drops a `lowered` helper the lowering never produced a call to.
- [ ] **§ the-user-wins** — Establish the suppression rule as a single principle: a prelude
      never shadows a name the user declared. `errorPrelude` bails when any root has
      `class Error`; `fixedTextPrelude`'s `callSites` returns `[]` when any class anywhere
      declares a `to_fixed` method; `text-methods.ts` carries `sharedName` for the members
      an array also has; `collection-surface`'s `namedConstruction` skips the rewrite when
      `classes.shapeOf(name)` is non-null. State why this is stronger than it looks: the
      prelude is *text pasted into the user's module*, so a collision is a redeclaration
      error in the user's own file, not a link error.
- [ ] **§ prelude-one-collections** — Read `collections.ts` as data structure. Establish
      open addressing with a linear probe, the three-valued `taken` column (0 empty,
      1 live, 2 tombstone), and the *separate* insertion-order machinery: `order` holds the
      keys in insertion order, `spot` maps slot → order index, `live` marks which order
      entries are still real. That is what lets `delete` be O(1) and `keys()` still answer
      in insertion order. Then the two independent resize policies — `rebuild()` rehashes
      (and only doubles when the live count justifies it, which is what clears tombstones)
      and `compact()` drops dead order entries once half are dead — and why one policy
      cannot serve both columns. Then the marker field: `holds_<key>_<value>: int` exists
      only because tera's dispatch is **structural**, so without it two generated classes
      with identical members merge into one cone and calls land in the wrong table
      [Ch 57 § structural-dispatch].
- [ ] **§ prelude-two-parse-number** — Establish correct rounding as a specification, not a
      quality bar: for a decimal string there is exactly one nearest double, and anything
      else is a miscompile. Then the recorded miscompiles this replaced —
      `parse_float("493.08965445287464")` gave `493.0896544528746` on x64 (digits
      accumulated in floating point, scaled by an inexact power of ten), `1e300` gave
      `1.0000000000000002e+300`, and the C backend's `strtol` saturated `parse_int` at
      2147483647. Then the algorithm: Clinger's fast path
      (`nd <= 15 and |exponent| <= 22` → one exact multiply or divide, `fastPath`),
      otherwise an exact base-2¹⁵ `num`/`den` bignum (`ratio`), a binade probe
      (`_pn_bits(num) - _pn_bits(den)`), shift-and-subtract division producing exactly 53
      bits, then `rounding()`: double the remainder, compare, and break the tie with `cut`
      — the sticky bit that records whether digits past `DIGIT_LIMIT` were dropped — or
      with `_pn_odd(q)` for round-half-even. Name the separate specification:
      `Number(text)` is `ToNumber`, not `parseFloat` (`_number_of` — whole-string match,
      hex/octal/binary prefixes, `""` → 0), and it was its own silent miscompile.
- [ ] **§ prelude-three-fixed-text** — The worked example, read as code. Establish that
      ECMAScript's `toFixed` wants round-half-up of the **exact** value of the double, so
      `Math.round(x * 10 ** d)` is wrong. Then `formatting()` line by line: decompose
      `x = mantissa · 2^exponent` by exact doubling/halving; `load()` splits the mantissa
      into four 16-bit chunks by exact division; the bignum is base 10⁴ in an `int[]` so
      `cell * factor + carry` stays inside a signed 32-bit word; and the trick that makes
      the whole thing work — **M / 2^k = M · 5^k / 10^k**, so the only division needed is by
      a power of ten, which in a decimal bignum is a digit shift (`shrink`). `FIVE_STEP = 6`
      because 5⁶ is the largest power of five whose product with a limb still fits.
      Rounding reads one dropped digit (`carried >= 5` → `bump(1)`). Non-finite and
      |x| ≥ 1e21 fall back to `x.to_string()`, exactly as the spec says.
- [ ] **§ what-writing-in-tera-cost** — *What was tried and rejected*, told as four traps,
      each with the general rule it produced. (1) **Module-level state segfaults** —
      see § appended-not-prepended. (2) **String accumulation in a loop is refused** by the
      AOT string-lifetime analysis [Ch 59 § lifetimes], so `_FixedText` exists purely to
      hold `this.text = this.text + piece` in an *object field* — which is precisely what
      the refusal message tells the user to do. The runtime takes its own compiler's
      advice. (3) **`/` in tera is float division even between ints**, so
      `lower: int = k / 2` stored 1.5 and every `exp` answer came out a factor of two off;
      hence `Math.trunc(k / 2)`, and hence `_FixedDigits.div`/`.mod` existing at all — a
      declared `(int, int) -> int` method is how `GenericMod`, which no backend emits, is
      narrowed away. (4) **A checker builtin cannot smuggle the prelude across modules**:
      declaring `_fixed_text` as an ambient signature made an imported module call an
      entry-module function, a call shape nothing else produces, and the string analysis
      crashed with `Cannot read properties of null (reading 'producer')`. Reverted.
- [ ] **§ prelude-four-fdlibm** — Establish the IEEE-754 double layout first
      (`> **New idea.**`: sign, 11-bit biased exponent, 52-bit fraction; the *high word* is
      the top 32 bits). Then the problem: fdlibm branches on the high word on nearly every
      line, and tera has no way to read a double's bits. Two substitutions carry the whole
      port. (a) A high-word *comparison* becomes a float comparison against a precomputed
      constant — `wordDouble(0x40862e42)` in TypeScript becomes a decimal literal in the
      generated tera. (b) The high word itself is *computable exactly*: `_m_exponent`
      finds `e` with a ten-step binary ladder over `POWER_STEPS`, then `_m_highword` is
      `(e + 1023) * 2**20 + Math.trunc((m - 1.0) * 2**20)`, which fits int32 for every
      finite double. With `ix` in hand fdlibm's integer tests port verbatim — and that is
      what made `sin` and `cos` reachable at all. Two more constraints worth naming:
      `__HI(y) += k<<20` becomes `y * 2^k`, which must be **split in two**
      (`y·2^⌊k/2⌋·2^⌈k/2⌉`) or `2^k` overflows at the top of `exp`'s range; and AOT refuses
      non-finite constants, so infinities are produced from runtime values
      (`(x * 1e300) * 1e300`, `(v - v) / (v - v)`).
- [ ] **§ the-oracle** — The chapter's closing idea, and the one input where the port is
      deliberately *wrong*. A faithful `e_exp.c` answers `Math.exp(1) = 2.7182818284590455`.
      V8 answers `2.718281828459045` — `Math.E`, one ULP lower. Over 10,000,000 random
      doubles plus dense grids plus all 4001 doubles adjacent to 1.0, **x = 1 is the only
      disagreement**, so `expSource` opens with `if x == 1.0: return 2.718281828459045`,
      spelled from `INTERPRETER_EXP_OF_ONE = Math.E`. Establish the general point the whole
      part rests on: a four-tier engine's specification is not mathematics, it is *the other
      three tiers*. The native binary is correct when it agrees with the interpreter; where
      the interpreter is one ULP off fdlibm, the compiled program must be one ULP off too.
      Pin it to `[t: tests/optimizing/prelude/math-transcendentals.test.ts > "answers what
      the interpreter answers for the one input fdlibm rounds differently"]` and state what
      it buys: if a future V8 changes this, the test fails rather than the binary drifting.
- [ ] **§ what-the-prelude-hands-on** — Close by restating the artifact for chapter 61.
      `_FixedDigits().cells` is a heap `int[]` that grows by `push` inside a loop;
      `_pn_round` builds two more; a `TeraMapTextInt` owns four parallel `int[]`s. The
      prelude is the reason `stats.tera` — a program with five floats in it — allocates at
      all, and therefore the reason the next chapter has a collector to describe.

## Honesty items

- > **Unfinished.** `rewriteFixedTexts` is reached only through
  `adoptSourcePreludes([graph.entry.ast])` (`src/api/engine.ts:467`), so `.to_fixed()`
  inside an *imported* module still declines with the old "unsupported property" message.
  Cost of finishing: move the rewrite from the AST to IR, the way
  `src/optimizing/passes/collection-surface.ts` (`shapeModuleCollections`) and
  `src/optimizing/passes/parse-number-surface.ts` (`lowerParseNumbers`) already do — both
  reach every module because they rewire a callee to a program-wide class global. Pinned
  by `[t: tests/e2e/optimizing/aot/fixed-text.test.ts > "stands down where the formatting
  lives in an imported module"]`, which asserts the *limit*, not the fix.
- > **Dead.** `src/optimizing/prelude/math-transcendentals.ts` deletes fdlibm's
  `npio2_hw` fast-path table rather than porting it, so `_m_rem_pio2` always takes the
  general branch. This is a deliberate deletion, verified bit-identical over 3.5M inputs
  including 100k exact multiples of π/2 — record it as removed prior art, not as a gap.
- > **Unenforced.** The rule "prelude state must not live at module level" — the one that
  produced a null-array read in a compiled binary — has no checker anywhere. It is
  respected by convention in all four preludes and by nothing else. Cost of enforcing: a
  scan in `sourcePreludes` rejecting any top-level `VariableDeclaration` in emitted text,
  roughly ten lines.
- > **Unenforced.** `preludeText` (`src/api/engine.ts:446-453`) fixes the concatenation
  order by hand — `numbers`, `collections`, `errorPrelude`, `json`, `sourcePreludes` —
  while `SOURCE_PRELUDES` fixes only the order of the last four. Nothing checks that two
  preludes do not emit the same name, and nothing checks that a prelude that depends on
  another (JSON forces `parseNumberPrelude` via the `required` flag at line 451) is
  emitted after it. Cost of enforcing: a duplicate-name assertion over the concatenated
  text, or make dependency an explicit field of `SourcePrelude`.
- > **Unfinished.** `float-mod.ts` is the only `SourcePrelude` with no `adopt`, relying on
  the IR pass `lowerFloatRemainder` instead — which is the *better* design (it reaches
  every module) and is used by exactly one of the four. Cost of converting the other three:
  each needs an IR-level surface pass and the checker signature that goes with it.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
grep -n "_FixedDigits_format\|_fixed_text\|_FixedText_add" /tmp/stats-c/stats.c
node dist/cli.js --print-bytecode docs/example/stats.tera | grep -c "_FixedDigits"
npx vitest run --project unit tests/optimizing/prelude/index.test.ts tests/optimizing/prelude/math-transcendentals.test.ts
npx vitest run --project unit tests/optimizing/prelude/fixed-text.test.ts tests/optimizing/prelude/errors.test.ts
node -e "console.log(Math.exp(1) === Math.E)"
```

The third command prints `0`: the interpreter has a real `to_fixed`, so the prelude exists
only on the AOT road. The last prints `true`, which is the disagreement with fdlibm that
§ the-oracle is about.

## Tests that pin this

- The mechanism: `tests/optimizing/prelude/index.test.ts` >
  `"carries nothing for a program that asks for none of them"`,
  `"carries every helper a program that asks for several of them needs"`,
  `"answers a prelude the parser can read back"`,
  `"points a call at the helper the prelude carries"`,
  `"leaves a program alone when only a lowering adopts its prelude"`,
  `"names the remainder helper, which no source call reaches"`,
  `"leaves out a helper a source rewrite already points calls at"`.
- Demand and suppression, `to_fixed`: `tests/optimizing/prelude/fixed-text.test.ts` >
  `"declares nothing for a program that never formats a number"`,
  `"declares the formatter for a program that asks for fixed digits"`,
  `"finds the call however deeply the program nests it"`,
  `"stands aside for a class that declares the member itself"`,
  `"declares the formatter once for several roots that call it"`,
  `"parses back into classes the compiler can see"`,
  `"turns the member call into a call on the formatter"`,
  `"keeps the receiver as the value being formatted"`,
  `"asks for no digits when the call names none"`,
  `"leaves a computed member alone"`.
- Suppression, `Error`: `tests/optimizing/prelude/errors.test.ts` >
  `"declares the error class for a program that constructs one"`,
  `"declares nothing for a program that spells the name only as text"`,
  `"stands aside for a program that declares the class itself"`,
  `"stands aside when any root declares the class"`,
  `"parses back into a class the compiler can see"`.
- Demand-driven helper selection: `tests/optimizing/prelude/math-transcendentals.test.ts` >
  `"stays empty for a program that calls none of them"`,
  `"carries only the function the program asked for"`,
  `"carries the helpers that function needs and no others"`,
  `"carries the argument reduction only the circular functions need"`,
  `"declares every table inside the function that reads it"`,
  `"leaves a member of the same name on something that is not Math alone"`,
  `"leaves a call given the wrong number of arguments alone"`.
- The oracle: `tests/optimizing/prelude/math-transcendentals.test.ts` >
  `"answers what the interpreter answers for the one input fdlibm rounds differently"`,
  and `tests/e2e/optimizing/aot/math-transcendentals.test.ts` >
  `"answer the same values the host does when interpreted"`,
  `"leaves the Math functions a backend carries natively alone"`.
- Exactness of the number reader: `tests/optimizing/prelude/parse-number.test.ts` >
  `"scales a mantissa by exact powers of two only"`,
  `"builds a power of ten by exact single steps"`,
  `"keeps every limb product inside a signed 32-bit word"`,
  `"reads a whole text the way Number does, prefixes and all"`,
  `"leaves a program that spells the readers itself alone"`.
- Compiled agreement: `tests/e2e/optimizing/aot/fixed-text.test.ts` >
  `"compiles a program that formats a number"`,
  `"compiles a report that formats numbers inside a loop"`,
  `"leaves the formatter out of a program that never asks for it"`,
  `"formats a number the entry module of a project asks for"`.
- Demand for collections: `tests/optimizing/prelude/requests.test.ts` >
  `"asks only for the set a program builds"`,
  `"keeps the key kind the literal spells"`,
  `"follows a variable that holds a constructed class"`,
  `"follows a parameter that declares the class"`,
  `"falls back to the primitive values when it cannot name what is stored"`.
- The escape gate that keeps a generated table from being printed:
  `tests/e2e/optimizing/aot/collections.test.ts` >
  `"declines a listing that is printed rather than iterated"`,
  `"declines a map that escapes to a call"`,
  `"shapes a class-valued map when the program is compiled as a module"`.
- Text methods and the shared-name rule: `tests/optimizing/prelude/text-methods.test.ts` >
  `"leaves the call sites of a member an array also carries to the receiver's type"`,
  `"still carries a shared member's function where a class declares that same member"`,
  `"fills the end a one-argument substring left out"`.
- The remainder helper: `tests/optimizing/prelude/float-mod.test.ts` >
  `"carries the helper for a program that spells a remainder"`,
  `"does not mistake a division or a multiplication for a remainder"`,
  `"declares the helper over two floats answering a float"`.
