# 60. A runtime written in its own language   ⟨I · – · – · N⟩

Compile `docs/example/stats.tera` to C and read the forward declarations. Sixteen of them
name functions the user never wrote:

```c
static const tera_char * _fixed_text(double p0, int32_t p1);
static unsigned char * _FixedText(unsigned char *p0);
static void _FixedText_add(unsigned char *p0, const tera_char *p1);
static unsigned char * _FixedDigits(unsigned char *p0);
static int32_t _FixedDigits_div(unsigned char *p0, int32_t p1, int32_t p2);
static int32_t _FixedDigits_mod(unsigned char *p0, int32_t p1, int32_t p2);
static void _FixedDigits_put(unsigned char *p0, int32_t p1, int32_t p2);
static void _FixedDigits_trim(unsigned char *p0);
static void _FixedDigits_scale(unsigned char *p0, int32_t p1);
static void _FixedDigits_bump(unsigned char *p0, int32_t p1);
static void _FixedDigits_shrink(unsigned char *p0, int32_t p1);
static int32_t _FixedDigits_digit(unsigned char *p0, int32_t p1);
static int32_t _FixedDigits_width(unsigned char *p0);
static void _FixedDigits_load(unsigned char *p0, double p1);
static const tera_char * _FixedDigits_render(unsigned char *p0, const tera_char *p1, int32_t p2);
static const tera_char * _FixedDigits_format(unsigned char *p0, double p1, int32_t p2);
```
— the C emitted for `docs/example/stats.tera`, `stats.c:1209-1224`

The next declaration in the file is `const tera_char * report(unsigned char *p0)`, which the
user did write. Nothing in the output distinguishes the two. Same calling convention, same
`unsigned char *` receiver, same root-frame prologue, same `AotScalar`-derived parameter
types. The only difference is `static`: the generated helpers are internal to the module and
`report` and `Series_mean` are not.

That is because they are not a runtime library in the usual sense. They are not C, they are
not TypeScript, and they are not compiler builtins. They are **tera source** — text,
generated on demand, appended to the user's entry module, re-parsed and re-typechecked
alongside the user's own declarations, and then inlined, narrowed, boxed and
register-allocated by exactly the passes that compiled `Series.mean`. In the IR, `_FixedDigits.shrink`
carries a `CheckSmi` from [Ch 55](55-the-same-graph-with-no-way-out.md)'s declared-parameter
guards. `_FixedText.add` gets a producer buffer `sb0` and a copy back into object text from
[Ch 59 § the-pass-that-takes-its-own-advice](59-strings-without-a-runtime-tag.md). The
runtime is subject to its own compiler, including its refusals.

The payoff is arithmetic. There are three native backends — `c`, `x64`, `riscv64`. Written
in C, this runtime would need a C implementation plus two hand-written assembly ports, or a
libc dependency the x64 backends deliberately do not have. Written in tera, it is one
implementation and zero backend work, and the day a fourth backend appears it gets
`to_fixed` for free.

**What arrived.** From
[Ch 59 § what-leaves](59-strings-without-a-runtime-tag.md): a program whose string values
have been assigned storage classes — rodata constants, per-producer static buffers,
object-owned inline text — with the string-boxing pass having already copied any produced
string that outlives a call into a heap object, `graph.stringEscapes` carrying the
whole-program retention summary, and `graph.wideText` carrying the module's UTF-8/UTF-16
answer. All of that was about *strings the program already has*. This chapter is about the
functions that produce them.

## What a runtime usually is

The shape a reader expects is a library: `libm.so`, `msvcrt`, a `runtime.o` the linker pulls
in, or a set of compiler intrinsics the back end knows how to expand. Either way the runtime
is written in a different language from the program, compiled by a different compiler, and
joined to the program at link time.

Count what arrives as tera source here instead. `to_fixed`. `Math.exp`, `Math.log`,
`Math.sin`, `Math.cos`. `parse_float`, `parse_int` and `Number(text)`. The `%` operator on
floats. `substring` and `last_index_of`. `Map` and `Set`, in every key/value instantiation a
program actually uses. `Error`. `JSON.parse`. Ten kinds of facility, four of them behind the
`SOURCE_PRELUDES` table in `src/optimizing/prelude/index.ts` and the rest concatenated
alongside it in `preludeText`.

None of them exists on the interpreter road. The interpreter has a real `to_fixed`, a real
`Map`, a real `Math.exp`, because it is a JavaScript engine and those are already there.
`node dist/cli.js --print-bytecode docs/example/stats.tera | grep -c "_FixedDigits"` prints
`0`. The prelude is a thing the *native* compiler needs and only it.

## The mechanism in 33 lines

The whole dispatch is one file of thirty-three lines, in two halves. The table:

```ts
interface SourcePrelude {
  readonly emit: (roots: readonly ASTNode[]) => string;
  readonly adopt?: (roots: readonly ASTNode[]) => unknown;
  readonly lowered?: readonly string[];
}

const SOURCE_PRELUDES: readonly SourcePrelude[] = [
  { emit: fixedTextPrelude, adopt: rewriteFixedTexts },
  { emit: textMethodPrelude, adopt: rewriteTextMethods },
  { emit: mathTranscendentalPrelude, adopt: rewriteMathTranscendentals },
  { emit: floatModPrelude, lowered: [FLOAT_MOD_FN] },
];
```
— `src/optimizing/prelude/index.ts:10-21`

and the three functions that read it:

```ts
export const LOWERED_PRELUDE_FUNCTIONS: ReadonlySet<string> = new Set<string>(
  SOURCE_PRELUDES.flatMap((prelude) => prelude.lowered ?? []),
);

export function sourcePreludes(roots: readonly ASTNode[]): string {
  return SOURCE_PRELUDES.map((prelude) => prelude.emit(roots)).join("");
}

export function adoptSourcePreludes(roots: readonly ASTNode[]): void {
  for (const prelude of SOURCE_PRELUDES) prelude.adopt?.(roots);
}
```
— `src/optimizing/prelude/index.ts:23-33`

A `SourcePrelude` is a triple. **`emit(roots)`** answers a string: the tera source this
program needs, or `""`. Its only input is an array of AST roots, because it is asked before
anything has been checked — there are no types yet, no module graph, no IR. **`adopt(roots)`**
mutates the AST afterwards to point call sites at what `emit` declared. **`lowered`** names
functions that no source rewrite will ever call, because an IR pass will call them instead;
`float-mod` is the only entry that uses it.

`sourcePreludes` and `adoptSourcePreludes` are the two loops, and they are the whole
extension point: adding a runtime facility means adding one row to `SOURCE_PRELUDES`.

`[t: tests/optimizing/prelude/index.test.ts > "carries nothing for a program that asks for none of them"]`
`[t: tests/optimizing/prelude/index.test.ts > "carries every helper a program that asks for several of them needs"]`
`[t: tests/optimizing/prelude/index.test.ts > "answers a prelude the parser can read back"]`
`[t: tests/optimizing/prelude/index.test.ts > "names the remainder helper, which no source call reaches"]`

## Emit and adopt

The pair has to be two functions, and the reason is a chicken-and-egg problem in the module
loader.

```ts
    const built = build(options.entrySource);
    const prelude = aot ? preludeFor(built) : "";
    const graph =
      prelude.length === 0
        ? built
        : build(`${built.entry.source}
${prelude}`);
    if (aot) adoptPreludeCalls(graph);
```
— `src/api/engine.ts:1406-1413`

`build` is a closure over `buildModuleGraph`. It is called **twice**. The first call exists
only to obtain `built.entry.source` and the parsed roots that `preludeFor` inspects; the
second call re-runs the whole loader on the entry source with the prelude text appended. So
the entry module of every AOT compile is parsed twice, and the prelude is *text* before it is
ever a module. `compileAotInRuntime` (`src/api/engine.ts:955-996`) does the same thing on the
single-file path, with `compileInRuntime` called once to probe and once to compile.

`emit` therefore cannot rewrite anything: at the time it runs, the nodes it would rewrite
belong to a graph that is about to be thrown away. `adopt` runs on the *second* graph, after
the prelude's declarations are real, and rewrites the call sites there. Hence
`adoptPreludeCalls` (`:462-468`), which calls `adoptSourcePreludes([graph.entry.ast])`.

That argument is the first sight of a limit that runs through the whole chapter. Look at what
each slot of `preludeText` is given:

```ts
function preludeText(
  roots: readonly ASTNode[],
  entry: readonly ASTNode[],
  collections: string,
  json: string,
): string {
  const numbers = parseNumberPrelude(roots, json.length > 0);
  return `${numbers}${collections}${errorPrelude(roots)}${json}${sourcePreludes(entry)}`;
}
```
— `src/api/engine.ts:446-453`

`preludeFor` (`:456-460`) passes `moduleRoots(graph)` — every module — as `roots`, and
`[graph.entry.ast]` — the entry alone — as `entry`. So the number readers, the collections,
`Error` and the JSON shapes are demanded from the whole program, while all four
`SOURCE_PRELUDES` are demanded from the entry module only. See § honesty-items for what that
costs, and § the-user-wins for the property it buys.

## Appended, not prepended

*Why the obvious design fails.* The obvious design is to put the runtime first, the way a C
compiler processes `#include` before the translation unit. Both loading paths do the
opposite: `` `${built.entry.source}\n${prelude}` `` on the module path, and
`` `${source}\n${prelude}` `` on the single-file path. The runtime goes at the **end**.

Prepending fails for the reason `emit` takes AST roots in the first place. The prelude is a
function of the program, and the program is the thing being read; you cannot put the answer
in front of the question without parsing the question twice in the *other* order and then
splicing text into the middle of a file whose line numbers the diagnostics already refer to.
Appending keeps every span in the user's source at the offset the user's editor shows.

It has a cost, and the cost is a trap. tera's top level is executable: statements at module
level run in source order. Appending means **the prelude's top-level statements run after the
user's whole program has already run** — which for a compiled program means after `main` has
returned. A module-level table in prelude source is therefore read before its initializer
runs.

Three recorded casualties. A `_fixed_cells: int[] = []` declared at prelude module level made
the compiled binary read a null array. The 2/π and π/2 tables that fdlibm's argument
reduction needs had to be moved *inside* the function that reads them —
`src/optimizing/prelude/math-transcendentals.ts:386-387` emits them as ordinary locals,

```ts
    `  ipio2: int[] = [${TWO_OVER_PI.join(", ")}]`,
    `  pio2: float[] = [${HALF_PI_PIECES.map(float).join(", ")}]`,
```
— `src/optimizing/prelude/math-transcendentals.ts:386-387`

so a sixty-four-entry table is rebuilt on every call rather than being read before it exists.
And fdlibm's `npio2_hw` fast-path table was not ported at all (§ what-writing-in-tera-cost).

The general rule: **prelude state lives in a class the caller constructs, or in a local.
Never at module level.** `_FixedDigits` is that rule — its `cells` array is a field
initialized in a constructor the caller calls, not a module variable.

`[t: tests/optimizing/prelude/math-transcendentals.test.ts > "declares every table inside the function that reads it"]`

## Demand-driven

The prelude is a function of the program in the strong sense: nothing is emitted that the
program did not ask for, and the asking is read off the AST four different ways.

> **New idea. Demand-driven code generation.** Most compilers decide what a program needs
> from *types*, after checking. These `emit` functions run before there is a checker result,
> so they must answer from syntax alone. That makes them deliberately conservative in one
> direction: a shape they cannot recognize gets no prelude and the function is refused later
> with a plain message, which is a worse outcome than compiling but never a wrong one.

A **member call** — `fixedTextPrelude` looks for a `CallExpression` whose callee is a
non-computed `MemberExpression` with property `to_fixed` (`callsMember`,
`src/optimizing/prelude/fixed-text.ts:279-285`). A **namespace call** —
`mathTranscendentalPrelude` looks for the same shape with the receiver spelled as the bare
identifier `Math` and exactly one argument (`namespaceCall`,
`src/optimizing/prelude/math-transcendentals.ts:715-728`). A **bare identifier** —
`errorPrelude` looks for `Identifier("Error")` anywhere (`namesError`,
`src/optimizing/prelude/errors.ts:11-12`), so `throw Error("x")` demands the class and
`print("Error: nope")` does not. An **operator** — `floatModPrelude` looks for a
`BinaryExpression` or `CompoundAssignmentExpression` whose `op` is `%`
(`src/optimizing/prelude/float-mod.ts:12-17`).

There is a second axis, and it is what keeps a program that calls `Math.exp` from carrying
751 lines of argument reduction. Each entry in `TRANSCENDENTALS` names the helpers it needs:

```ts
const TRANSCENDENTALS: readonly Transcendental[] = [
  { member: "exp", fn: "_m_exp", needs: [POWER_OF_TWO], source: expSource },
  { member: "log", fn: "_m_log", needs: [POWER_OF_TWO, EXPONENT_OF], source: logSource },
  { member: "sin", fn: "_m_sin", needs: CIRCULAR_HELPERS, source: sinSource },
  { member: "cos", fn: "_m_cos", needs: CIRCULAR_HELPERS, source: cosSource },
];
```
— `src/optimizing/prelude/math-transcendentals.ts:704-709`

`mathTranscendentalPrelude` (`:733-743`) unions the `needs` of the functions actually called
and emits `HELPERS.filter((helper) => needed.has(helper.name))` and nothing else. A program
that calls only `Math.exp` gets `_m_pow2` and `_m_exp`. Only `sin` and `cos` name
`CIRCULAR_HELPERS`, which is all nine, so only they pull in `_m_rem_pio2`.
`collectionRequestsAcross` does the same for key/value instantiations, and
`parseNumberPrelude` for the three readers.

The back half of demand runs much later, in the AOT driver:

```ts
function unusedHelpers(
  lowered: readonly { readonly graph: CFGFunction }[],
): readonly string[] {
```
— `src/optimizing/drivers/aot.ts:458-460`

It collects every callee name in the lowered module and returns the members of
`LOWERED_PRELUDE_FUNCTIONS` that nobody called. Those are dropped. A `lowered` prelude is
emitted from a syntactic guess (`%` appears somewhere) and only kept if the IR lowering
actually produced a call to it.

`[t: tests/optimizing/prelude/math-transcendentals.test.ts > "carries only the function the program asked for"]`
`[t: tests/optimizing/prelude/math-transcendentals.test.ts > "carries the helpers that function needs and no others"]`
`[t: tests/optimizing/prelude/math-transcendentals.test.ts > "carries the argument reduction only the circular functions need"]`
`[t: tests/optimizing/prelude/math-transcendentals.test.ts > "leaves a member of the same name on something that is not Math alone"]`
`[t: tests/optimizing/prelude/index.test.ts > "leaves out a helper a source rewrite already points calls at"]`
`[t: tests/optimizing/prelude/requests.test.ts > "asks only for the set a program builds"]`
`[t: tests/optimizing/prelude/float-mod.test.ts > "does not mistake a division or a multiplication for a remainder"]`

## The user wins

Because the prelude is *text pasted into the user's module*, a name collision is not a link
error and not a shadowing rule. It is a redeclaration in the user's own file, reported
against the user's own program, and the whole design rests on that never happening. Every
prelude therefore stands down when the user has spelled the name first.

`errors.ts` is the clearest statement, because it is one line:

```ts
export function errorPrelude(roots: readonly ASTNode[]): string {
  const anyRoot = (spelled: Spelling): boolean => roots.some((root) => holds(root, spelled));
  if (!anyRoot(namesError) || anyRoot(declaresError)) return "";
```
— `src/optimizing/prelude/errors.ts:22-24`

Named nowhere, emit nothing. Declared anywhere — in *any* module of the graph, not just the
entry — emit nothing. A user's `class Error` wins outright, and the program that uses it
compiles.

`fixedTextPrelude` does the same through `callSites`, which returns `[]` when any class
anywhere declares a `to_fixed` method (`declaresAnywhere` at `fixed-text.ts:294-297`, `callSites` at `:299-302`). Since
`fixedTextPrelude` and `rewriteFixedTexts` both go through `callSites`, suppression at emit
time is automatically suppression at rewrite time — there is no way for the two to disagree.
`collection-surface`'s `namedConstruction` (`:88-95`) makes the same check at the IR level,
returning the collection name only when `graph.classes?.shapeOf(name) === null`.

`text-methods.ts` needs a third answer, because two of its members are ambiguous rather than
merely taken. An array also has `last_index_of`, and the AST cannot tell a string receiver
from an array receiver. So `TextMethod` carries `sharedName`, and the two halves come apart:
`textMethodPrelude` (`:120-131`) *does* carry the function even where a class declares that
member, while `rewritableSites` (`:112-118`) rewrites only sites whose method is not
`sharedName` and whose member no class declared. The rewrite for a shared name is deferred to
`lowerTextMethodCalls` (`src/optimizing/passes/text-method-calls.ts:76-91`), a legalization
pass that can ask `producedType(receiver, types, graph.classes).kind !== TypeKind.String` and
therefore knows what the AST could not.

`[t: tests/optimizing/prelude/errors.test.ts > "stands aside for a program that declares the class itself"]`
`[t: tests/optimizing/prelude/errors.test.ts > "stands aside when any root declares the class"]`
`[t: tests/optimizing/prelude/errors.test.ts > "declares nothing for a program that spells the name only as text"]`
`[t: tests/optimizing/prelude/fixed-text.test.ts > "stands aside for a class that declares the member itself"]`
`[t: tests/optimizing/prelude/text-methods.test.ts > "leaves the call sites of a member an array also carries to the receiver's type"]`
`[t: tests/optimizing/prelude/text-methods.test.ts > "still carries a shared member's function where a class declares that same member"]`

## Prelude one: collections

`src/optimizing/prelude/collections.ts` is 371 lines of TypeScript that generate a hash table
in tera, parameterised over three key kinds (`string`, `int`, `float`) and three value kinds.
Read it as a data structure and it is an open-addressed table with a linear probe, plus a
separate insertion-order log.

The probe is `at(key)` (`:146-162`). The `taken` column is three-valued: `0` empty, `1` live,
`2` tombstone. The loop steps while `taken[slot] != 0` and stops only on an actually empty
slot, so a tombstone keeps a probe chain intact after a delete:

```
  public at(key: string) -> int:
    slot: int = this.hashed(key)
    while this.taken[slot] != 0:
      if this.taken[slot] == 1:
        if this.slots[slot] == key:
          return slot
      slot = (slot + 1) & this.mask
    return slot
```
— the tera source `lookup("string")` generates; the template is `src/optimizing/prelude/collections.ts:146-161`

Insertion order is a second, independent structure: `order` holds the keys in the order they
were first inserted, `spot` maps a table slot to its index in `order`, and `live` marks which
`order` entries are still real. `delete` (`removal`, `:228-242`) is therefore O(1) — set
`taken[slot] = 2`, set `live[spot[slot]] = 0` — and `keys()` (`listing`, `:244-257`) still
answers in insertion order by walking `order` and skipping the dead.

Two structures need two resize policies, which is why one policy cannot serve both. `admit`
(`:214-226`) calls `rebuild()` when `used * 2 > mask`, where `used` counts slots ever touched
including tombstones. `rebuild` (`:163-191`) rehashes into fresh arrays and sets
`used = filled`, so it clears tombstones unconditionally, but it only *doubles* the mask when
`filled * 4 > mask` — a table full of tombstones is rehashed at the same size. Separately,
`delete` calls `compact()` when `dead * 2 > order.length`, and `compaction` (`:193-212`)
rewrites `order` and `live` and then repairs every `spot`. The probe table resizes on
occupancy; the order log compacts on deadness; the two counters are not the same counter.

Then the field nobody would guess at:

```ts
function marker(key: KeyKind, value: ValueKind | null): string {
  return `holds_${key}_${value ?? "member"}`;
}
```
— `src/optimizing/prelude/collections.ts:68-70`

`fields` (`:105-120`) emits `public holds_string_int: int` as the first member of
`TeraMapTextInt`, and it is never read. It exists because tera's dispatch is **structural**
([Ch 57 § structural-not-nominal](57-objects-without-a-runtime-type.md)): two generated
classes with identical member lists are one shape, so without the marker `TeraMapTextInt` and
`TeraMapTextFloat` — whose `cells` differ only in element type — would merge into one dispatch
cone and a `get` would land in the wrong table. One unused int field per class buys structural
distinctness.

Collections are one of the four slots `preludeText` feeds from *all* module roots, and
`shapeModuleCollections` / `lowerCollectionSurface` rewire `Map()`'s `LoadGlobal` to the
generated class at the IR level, so a `Map` built inside an imported module compiles.

`[t: tests/optimizing/prelude/requests.test.ts > "keeps the key kind the literal spells"]`
`[t: tests/optimizing/prelude/requests.test.ts > "follows a variable that holds a constructed class"]`
`[t: tests/optimizing/prelude/requests.test.ts > "follows a parameter that declares the class"]`
`[t: tests/optimizing/prelude/requests.test.ts > "falls back to the primitive values when it cannot name what is stored"]`
`[t: tests/e2e/optimizing/aot/collections.test.ts > "shapes a class-valued map when the program is compiled as a module"]`

There is a ceiling, and it is an escape gate. A generated table is a synthetic class the
compiler knows the layout of; hand it to something that would need a run-time type and the
function is refused:
`[t: tests/e2e/optimizing/aot/collections.test.ts > "declines a listing that is printed rather than iterated"]`
and
`[t: tests/e2e/optimizing/aot/collections.test.ts > "declines a map that escapes to a call"]`.

## Prelude two: parse-number

`src/optimizing/prelude/parse-number.ts` is 657 lines and its subject is one word.

> **New idea. Correct rounding.** For any decimal string there is exactly one double nearest
> to the value it denotes (with ties broken to even). That double is not a quality target;
> it is *the* answer, and anything else is a wrong answer. It is also surprisingly hard to
> reach: accumulate the digits in floating point and scale by `10 ** exponent` and you have
> introduced two rounding errors, either of which can land you on the neighbouring double.

The recorded miscompiles this prelude replaced are all of that shape.
`parse_float("493.08965445287464")` answered `493.0896544528746` on x64 — one digit short,
one ULP off — because digits were accumulated in floating point and scaled by an inexact
power of ten. `1e300` came back as `1.0000000000000002e+300`. And the C backend's `parse_int`
went through `strtol`, which saturates, so anything past 2147483647 clamped instead of
answering what the interpreter answers. All three are now pinned as agreement tests against
the interpreter:
`[t: tests/e2e/optimizing/aot/parse-number.test.ts > "answers parse_float the way the interpreter does for values that round to the nearest double"]`
and
`[t: tests/e2e/optimizing/aot/parse-number.test.ts > "answers parse_float the way the interpreter does for values at the edges of the exponent range"]`.

The algorithm is Clinger's. First the fast path (`fastPath`, `:303-314`):

```
  if cut == 0 and nd <= 15 and exponent >= -22 and exponent <= 22:
```

Fifteen significant digits fit exactly in a double's 53-bit mantissa, and `10 ** 22` is the
largest power of ten that is itself exactly representable, so under those bounds one multiply
or one divide is exactly rounded and there is nothing else to do. `cut == 0` says no digits
were dropped.

Outside the fast path the reader builds an exact rational. `ratio` (`:316-336`) accumulates
the digit string into a bignum `num` in base 2¹⁵ — four decimal digits at a time, because
`chunk * scale` must stay inside a signed 32-bit word — and puts the decimal exponent into
`num` or into `den`. `binade` (`:338-356`) probes the answer's binary exponent from
`_pn_bits(num) - _pn_bits(den)`. `divide` (`:358-381`) does shift-and-subtract division until
it has produced exactly 53 bits of quotient, leaving a remainder.

> **New idea. The sticky bit.** Rounding needs to know not just whether the discarded part is
> above, below or exactly at half, but — when it is exactly at half by what you kept — whether
> anything was thrown away earlier that would tip it over. `DIGIT_LIMIT = 800` caps how many
> digits are read; `cut` records whether any were dropped past that cap. It is one bit that
> remembers "there was more".

```
  _pn_shift(rest, 1)
  order = _pn_compare(rest, divisor)
  up: int = 0
  if order > 0:
    up = 1
  else if order == 0:
    if cut == 1:
      up = 1
    else if _pn_odd(q) == 1:
      up = 1
```
— the tera source `rounding()` generates; the template is `src/optimizing/prelude/parse-number.ts:383-404`

Double the remainder, compare with the divisor. Greater: round up. Equal: round up if the
sticky bit says something was dropped, otherwise round up only if the quotient is odd — which
is round-half-even, IEEE-754's default.

`Number(text)` is a **separate specification** and had its own silent miscompile. It is
ECMAScript `ToNumber`, not `parseFloat`: the whole string must match, `""` is `0`, and `0x`,
`0o`, `0b` prefixes are radix markers. `readerFor` in the surface pass
(`src/optimizing/passes/parse-number-surface.ts:23-28`) routes to `_number_of` rather than
`_parse_float` when the builtin carried `WHOLE_TEXT_PROP`.

One more link back to [Ch 59](59-strings-without-a-runtime-tag.md). These readers index text
by character — `char_code_at` on every digit — and doing that on non-ASCII text is exactly
what `INDEXES_CHARACTERS` refuses. But the readers are deliberately reading *bytes*, and they
are correct in bytes because every character they care about is ASCII. So a module stage
stamps them:

```ts
export function markNumberTextBytewise(module: ModuleIR): number {
  let marked = 0;
  for (const unit of module.units) {
    if (!NUMBER_TEXT_READERS.has(unit.graph.name)) continue;
```
— `src/optimizing/passes/parse-number-surface.ts:56-60`

Every character-counting node inside a `_pn_*` function gets `BYTEWISE_PROP = true`, and
[Ch 59 § two-refusals-not-one](59-strings-without-a-runtime-tag.md)'s analysis steps aside for
it entirely. A program can read a number out of text and still hold Vietnamese elsewhere
`[t: tests/e2e/optimizing/aot/parse-number.test.ts > "still counts characters elsewhere in a program that reads a number"]`.

`[t: tests/optimizing/prelude/parse-number.test.ts > "scales a mantissa by exact powers of two only"]`
`[t: tests/optimizing/prelude/parse-number.test.ts > "builds a power of ten by exact single steps"]`
`[t: tests/optimizing/prelude/parse-number.test.ts > "keeps every limb product inside a signed 32-bit word"]`
`[t: tests/optimizing/prelude/parse-number.test.ts > "reads a whole text the way Number does, prefixes and all"]`

## Prelude three: fixed-text

`stats.tera`'s only prelude demand is the `.to_fixed(2)` on line 15, so this is the one the
running example actually compiles.

ECMAScript's `toFixed` is specified on the **exact** value of the double, rounded half-up at
the requested digit. That rules out the obvious implementation immediately:
`Math.round(x * 10 ** d)` performs the rounding on a *product* that has already been rounded,
and the classic witness is `(2.675).toFixed(2)`, whose exact value is
2.67499999999999982236431605997495353221893310546875 and which must therefore answer `"2.67"`
even though the decimal you typed looks like a tie.

So `formatting()` (`src/optimizing/prelude/fixed-text.ts:205-262`) works on the exact value,
in three moves.

**Decompose.** Halve or double `x` until it is an integer below 2⁵³, counting steps into
`exponent`. That is exact — every step is a multiply by two — and it yields
`x = mantissa · 2^exponent` with `mantissa` an exact integer.

**Load.** `load()` (`:168-186`) splits the 53-bit mantissa into four 16-bit chunks by exact
`Math.floor(rest / 65536.0)` divisions, then feeds them into a decimal bignum with
`scale(65536)` and `bump(chunk)`. The bignum is base 10⁴ in an `int[]`
(`LIMB_DIGITS = 4`, `LIMB_BASE = 10000`), and the base is chosen so that the *product* stays
in a word: `cell * factor + carry` with `cell < 10⁴` and a factor of 65536 is under 2³¹
`[t: tests/optimizing/prelude/parse-number.test.ts > "keeps every limb product inside a signed 32-bit word"]`.

**Scale.** Now `mantissa · 2^exponent` must be turned into digits. When `exponent` is
positive that is repeated `scale(2)`. When it is negative — the interesting case — the
identity is

```
    M / 2^k  =  M · 5^k / 10^k
```

so the only division needed is by a power of ten, and in a base-10⁴ bignum that is a digit
shift (`shrink`, `:109-135`) rather than a division at all. Multiplying by 5^k is done in
steps of `FIVE_STEP = 6`, because 5⁶ = 15625 is the largest power of five whose product with a
limb below 10⁴ still fits the word. Rounding then reads exactly one dropped digit —
`carried: int = this.digit(drop - 1)`, `if carried >= 5: this.bump(1)` — which is round-half-up
on the exact value, as specified.

The escape hatches match the spec too: NaN and the infinities answer their names, a `digits`
outside 0–100 throws `toFixed() digits argument must be between 0 and 100`, and
`|x| >= 1e21` returns `sign + x.to_string()` because that is what `toFixed` does.

`[t: tests/optimizing/prelude/fixed-text.test.ts > "declares the formatter for a program that asks for fixed digits"]`
`[t: tests/optimizing/prelude/fixed-text.test.ts > "parses back into classes the compiler can see"]`
`[t: tests/optimizing/prelude/fixed-text.test.ts > "turns the member call into a call on the formatter"]`
`[t: tests/optimizing/prelude/fixed-text.test.ts > "keeps the receiver as the value being formatted"]`
`[t: tests/optimizing/prelude/fixed-text.test.ts > "asks for no digits when the call names none"]`
`[t: tests/e2e/optimizing/aot/fixed-text.test.ts > "compiles a program that formats a number"]`
`[t: tests/e2e/optimizing/aot/fixed-text.test.ts > "compiles a report that formats numbers inside a loop"]`
`[t: tests/e2e/optimizing/aot/fixed-text.test.ts > "leaves the formatter out of a program that never asks for it"]`

## What writing in tera cost

*What was tried and rejected.* Writing a runtime in the language being compiled means the
runtime is subject to every restriction the compiler imposes on user code. Four of those bit
hard enough to change the design, and each produced a rule.

**(1) Module-level state does not exist yet when the prelude runs.** Covered in
§ appended-not-prepended: `_fixed_cells: int[] = []` at module level made the compiled binary
read a null array, because the prelude's top level runs after the user's. Rule: prelude state
lives in a constructed object or a local.

**(2) String accumulation in a loop is refused.** `render()` builds its answer one digit at a
time. Written as `out = out + digit`, that is a producer whose value lives across the loop
back edge, and [Ch 59 § the-proof](59-strings-without-a-runtime-tag.md) refuses it. So
`_FixedText` exists — a class whose whole body is a `string` field and an `add` method:

```ts
function textClass(): readonly string[] {
  return [
    `class ${TEXT_CLASS}:`,
    `  public ${TEXT_FIELD}: string`,
    "  public constructor():",
    `    this.${TEXT_FIELD} = ""`,
    `  public ${ADD}(piece: string) -> void:`,
    `    this.${TEXT_FIELD} = this.${TEXT_FIELD} + piece`,
  ];
}
```
— `src/optimizing/prelude/fixed-text.ts:51-59`

That is precisely what the refusal message tells a user to do — "copy it into an object
field". The runtime takes its own compiler's advice, and the C it becomes is the proof:

```c
static void _FixedText_add(unsigned char *p0, const tera_char *p1) {
  static tera_char sb0[8192];
  ...
  const tera_char *v0 = (tera_char *)(p0 + 8);
  const tera_char *v1 = tera_str_append(tera_str_set(sb0, 8192, v0), 8192, p1);
  tera_str_set((tera_char *)(p0 + 8), 512, v1);
```
— `stats.c:1387-1396`, elided at the root-frame prologue

Read the field's inline text, append into the producer buffer, copy the result back into the
field. The accumulator survives the loop because it lives in storage the object owns.

**(3) `/` in tera is float division, even between two ints.** `lower: int = k / 2` stored
1.5, and every `Math.exp` answer came out a factor of two wrong. The fix is `Math.trunc(k / 2)`
everywhere, and it is also why `_FixedDigits` has `div` and `mod` methods at all:

```
  public div(value: int, by: int) -> int:
    return Math.floor(value / by)
  public mod(value: int, by: int) -> int:
    return value % by
```
— the source `storage()` generates, `src/optimizing/prelude/fixed-text.ts:70-73`

A declared `(int, int) -> int` signature is how a `GenericMod` — which no backend emits — is
narrowed away before legalization sees it. The type annotation is not documentation; it is
the lowering.

**(4) A checker builtin cannot smuggle the prelude across modules.** The obvious fix for the
entry-module limit is to declare `_fixed_text` as an ambient signature so an imported module
can call it. That was tried. It made an imported module call an entry-module function — a
call shape nothing else in the compiler produces — and the string-lifetime analysis crashed
with `Cannot read properties of null (reading 'producer')`. Reverted. The real fix is the one
`collection-surface` and `parse-number-surface` already use: rewrite in IR against a
program-wide class global, not in the AST.

**Removed prior art.** fdlibm's `__ieee754_rem_pio2` carries a table, `npio2_hw`, whose only
job is to let the medium-range branch skip its second correction step for arguments whose
high word exactly matches a multiple of π/2. It is not ported;
`src/optimizing/prelude/math-transcendentals.ts` has no `npio2` symbol and the generated
`_m_rem_pio2` always performs the correction (`:592-599`). Always taking the longer path is
bit-identical to taking it conditionally, so this is a deletion rather than a gap — but it is
worth recording as removed prior art so that a reader comparing the port with fdlibm line by
line does not conclude something is missing. `[unpinned]` — no test in the tree exercises the
exact-multiple-of-π/2 inputs the table was for; what is pinned is the general agreement,
`[t: tests/e2e/optimizing/aot/math-transcendentals.test.ts > "answer the same values the host does when interpreted"]`.

## Prelude four: fdlibm

`Math.exp`, `log`, `sin` and `cos` are a port of fdlibm, the reference libm every serious
implementation descends from. Porting it into tera runs into one obstacle on nearly every
line.

> **New idea. IEEE-754 double layout, and the high word.** A double is 64 bits: 1 sign bit,
> an 11-bit exponent stored biased by 1023, and a 52-bit fraction whose leading 1 is implied.
> The **high word** is the top 32 bits — sign, whole exponent, and the top 20 bits of the
> fraction. It is a single integer that answers "roughly how big is this, and is it special",
> which is why fdlibm's branches are almost all integer comparisons against a hex constant:
> `if(hx >= 0x40862E42)` means "at least 709.78", the point where `exp` overflows.

tera has no way to read a double's bits. Two substitutions carry the entire port.

**(a) A high-word comparison becomes a float comparison.** `wordDouble`
(`src/optimizing/prelude/math-transcendentals.ts:36-40`) builds the double whose high word is
a given hex constant, in TypeScript, at prelude-generation time:

```ts
const bits = new DataView(new ArrayBuffer(8));

function wordDouble(word: number): number {
  bits.setUint32(0, word >>> 0);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
}
```
— `src/optimizing/prelude/math-transcendentals.ts:34-40`

`EXP_LIMIT = wordDouble(0x40862e42)` (`:101`) is then spelled into the generated tera as a
decimal literal, and the tera source compares against it as a float. The comparison is the
same comparison; only the notation moved.

**(b) The high word itself is computable exactly.** Not every fdlibm branch is a magnitude
test — the argument reduction needs `ix` as an integer to shift and index with. So
`_m_exponent` finds the binary exponent `e` with a ten-step binary ladder over `POWER_STEPS`
(`src/optimizing/prelude/spelling.ts:1`), and then:

```ts
function highWord(): readonly string[] {
  return [
    `fn ${HIGH_WORD}(v: float) -> int:`,
    `  e: int = ${EXPONENT_OF}(v)`,
    `  m: float = v / ${POWER_OF_TWO}(e)`,
    `  return (e + ${EXPONENT_BIAS}) * ${MANTISSA_WORD_SCALE} + ` +
      `Math.trunc((m - 1.0) * ${float(MANTISSA_WORD_SCALE)})`,
  ];
}
```
— `src/optimizing/prelude/math-transcendentals.ts:308-316`

Four lines, no bit access. `v / 2^e` is the mantissa in [1, 2); subtracting 1 and scaling by
2²⁰ gives the top 20 fraction bits; `(e + 1023) · 2²⁰` places the biased exponent above them.
The result fits an int32 for every finite double, which is what makes it usable as a tera
`int`. With `ix` in hand, fdlibm's integer tests port verbatim — and that is what made `sin`
and `cos` reachable at all, because their argument reduction is written entirely in terms of
the high word.

Two more constraints are worth naming because they show the same pattern. fdlibm's final
scaling step is `__HI(y) += k<<20`, adding to the exponent field in place; here it becomes
`y * 2^k`, which must be **split in two** — `y · 2^⌊k/2⌋ · 2^⌈k/2⌉` — or `2^k` itself
overflows at the top of `exp`'s range. And AOT refuses a non-finite constant
([Ch 56 § where-a-scalar-comes-from](56-legality-and-the-art-of-refusing-well.md)), so an
infinity has to be produced from runtime values: `(x * 1e300) * 1e300` for the overflow case,
and in `float-mod.ts` a NaN is spelled

```
  undefined_here: float = (left - left) / (right - right)
```
— `src/optimizing/prelude/float-mod.ts:30`

which is 0/0 computed from the arguments, because you cannot write `NaN`.

## The oracle

There is one input where the port is deliberately wrong, and it is the point the whole part
turns on.

A faithful transcription of fdlibm's `e_exp.c` answers `Math.exp(1) = 2.7182818284590455`.
V8 answers `2.718281828459045` — `Math.E` exactly, one ULP lower. Both are defensible; only
one is *this engine's* answer, because the interpreter is a JavaScript engine and the AOT
binary's specification is that it agrees with the interpreter. So `expSource` opens with a
special case:

```ts
const INTERPRETER_EXP_OF_ONE = Math.E;

function expSource(): readonly string[] {
  return [
    "fn _m_exp(x: float) -> float:",
    "  if x != x:",
    "    return x + x",
    "  if x == 1.0:",
    `    return ${float(INTERPRETER_EXP_OF_ONE)}`,
```
— `src/optimizing/prelude/math-transcendentals.ts:103-111`

> **New idea. An oracle.** A compiler is judged against a reference implementation, not
> against mathematics. That reference is called the *oracle*, and choosing it is a design
> decision with consequences. Here the oracle is the interpreter, which means the native
> binary is correct exactly when it agrees with V8 — and where V8 is one ULP off fdlibm, the
> compiled program is required to be one ULP off fdlibm too. The alternative — being right
> about mathematics and wrong about the other three tiers — would break the property this
> whole book is about.

Two details make the special case honest rather than a fudge. First, `x = 1` really is the
only disagreement; the constant is not papering over a systematic error. Second, and more
usefully, `INTERPRETER_EXP_OF_ONE` is `Math.E` — the host's own constant, read at
prelude-generation time, not a literal typed by hand. So the test that pins it

```
    expect(mathTranscendentalPrelude(roots("print(Math.exp(1.0))"))).toContain(
      `    return ${Math.E}`,
    );
```
— `tests/optimizing/prelude/math-transcendentals.test.ts:117-119`

compares the generated source against the running host. If a future V8 changes what
`Math.exp(1)` answers, the *test* fails and someone looks at it — rather than the binary
silently drifting away from the interpreter it is supposed to match.
`[t: tests/optimizing/prelude/math-transcendentals.test.ts > "answers what the interpreter answers for the one input fdlibm rounds differently"]`
`[t: tests/e2e/optimizing/aot/math-transcendentals.test.ts > "leaves the Math functions a backend carries natively alone"]`

## What the prelude hands on

The artifact for the next chapter is a single entry module whose AST now contains, in
addition to the user's declarations, every generated class and function the program demanded
— `_FixedText`, `_FixedDigits`, `_fixed_text`, `_m_exp`, `_pn_round`, `TeraMapTextInt`,
`Error` — with every call site already rewritten to name them. Chapter 61 receives it as
ordinary user code, because that is exactly what it now is.

And it receives one thing more: a reason to have a collector. `docs/example/stats.tera` is
five floats and two `Series` objects. On its own it would never trouble an allocator. But
`_FixedDigits().cells` is an `int[]` on the heap that grows by `push` inside a loop
(`put`, `fixed-text.ts:74-77`), `_FixedText.text` is a string field rewritten on every digit,
`_pn_round` copies three more `int[]`s in `divide()` (`parse-number.ts:358-381`), and a
`TeraMapTextInt` owns four parallel `int[]`s. The prelude is why a twenty-four-line program
that constructs exactly two objects of its own reaches `tera_alloc` on every formatted
number, and therefore why
[Ch 61 § what-arrived](61-the-arena-the-shadow-stack-and-why.md) has an object graph to
describe.

## Honesty items

> **Unfinished.** All four `SOURCE_PRELUDES` are **entry-module only**, on both halves.
> `preludeFor` (`src/api/engine.ts:456-460`) passes `[graph.entry.ast]` as the `entry`
> argument, so `sourcePreludes` never sees an imported module's AST; and
> `adoptPreludeCalls` (`:462-468`) calls `adoptSourcePreludes([graph.entry.ast])`, so no
> imported call site is rewritten. The consequence is four different refusals for the same
> cause, three of which name a downstream symptom rather than it. Verified on this tree, one
> compile per fresh process, with a two-file project whose entry only imports:
>
> ```
> to_fixed in an imported module   ->  unsupported property to_fixed
> substring in an imported module  ->  unsupported property substring
> float % in an imported module    ->  unsupported opcode GenericMod
> Math.exp in an imported module   ->  Math.exp is part of the runtime rather than of the
>                                      program, so there is nothing to compile for it; keep
>                                      this part interpreted
> ```
>
> The same programs compile and run when the entry module spells the construct. Cost of
> finishing: move each rewrite from the AST to IR the way
> `src/optimizing/passes/collection-surface.ts` (`shapeModuleCollections`) and
> `src/optimizing/passes/parse-number-surface.ts` (`lowerParseNumbers`) already do — both
> reach every module because they rewire a callee to a program-wide class or function global,
> and both are why `Map` and `parse_float` work in an imported module while `to_fixed` does
> not. Pinned by
> `[t: tests/e2e/optimizing/aot/fixed-text.test.ts > "stands down where the formatting lives in an imported module"]`,
> which asserts the *limit*, not the fix; the other three are `[unpinned]`.

> **Unfinished.** `float-mod.ts` is described as the design the other three should adopt: no
> `adopt`, an IR pass (`lowerFloatRemainder`, `src/optimizing/passes/float-mod.ts:34`) doing
> the rewrite instead. Half of that is true. The *lowering* does reach every module — put a
> `%` in the entry and a `%` in an imported module and both compile. But the *emit* still
> only reads the entry, so with no `%` in the entry `_float_mod` is never declared,
> `lowerFloatRemainder` hits its `signature === undefined` guard at `:35` and returns 0, and
> the imported module is refused with `unsupported opcode GenericMod`. An IR-level rewrite is
> only half a fix; the demand test has to move too. Cost: give `SourcePrelude.emit` the whole
> module graph rather than the entry, which is a one-argument change in `preludeFor` and a
> re-audit of every `emit` for name collisions across modules.

> **Unenforced.** The rule that produced a null-array read in a compiled binary — "prelude
> state must not live at module level" — has no checker anywhere. It is respected by
> convention in all four preludes and by nothing else. Cost of enforcing: a scan in
> `sourcePreludes` (`src/optimizing/prelude/index.ts:27-29`) rejecting any top-level
> `VariableDeclaration` in the emitted text, roughly ten lines, since the text is parseable
> by construction
> `[t: tests/optimizing/prelude/index.test.ts > "answers a prelude the parser can read back"]`.

> **Unenforced.** `preludeText` (`src/api/engine.ts:446-453`) fixes the concatenation order by
> hand — `numbers`, `collections`, `errorPrelude`, `json`, `sourcePreludes` — while
> `SOURCE_PRELUDES` fixes only the order of the last four. Nothing checks that two preludes do
> not emit the same name, and the one real dependency in the set is expressed as a boolean
> argument rather than as structure: JSON forces the number readers by passing
> `json.length > 0` into `parseNumberPrelude` at `:452`. Cost of enforcing: a duplicate-name
> assertion over the concatenated text, or an explicit `requires` field on `SourcePrelude`.

> **Unenforced.** `text-methods.ts`'s `sharedName` flag has no relationship to the set of
> members arrays actually carry; it is a hand-maintained boolean on two entries
> (`src/optimizing/prelude/text-methods.ts:25` and `:50`). Add a third `TextMethod` whose
> member name an array also has, forget the flag, and `rewriteTextMethods` will rewrite an
> array receiver's call into a `string`-typed helper. Nothing derives the flag from
> `data/tera-language-spec.ts`, and nothing cross-checks it. Cost: derive it.

## Verify it yourself

```bash
# the generated runtime, indistinguishable from the user's program in the C output
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
sed -n '1209,1226p' /tmp/stats-c/stats.c
grep -n "_FixedDigits_format\|_fixed_text\|_FixedText_add" /tmp/stats-c/stats.c

# the interpreter has a real to_fixed, so it never asks for one: this prints 0
node dist/cli.js --print-bytecode docs/example/stats.tera | grep -c "_FixedDigits"

# the entry-module limit, three symptoms for one cause
mkdir -p /tmp/mod && printf 'fn rem(a: float, b: float) -> float:\n  return a %% b\n' > /tmp/mod/lib.tera
printf 'from lib import rem\n\nprint(rem(7.5, 2.0))\n' > /tmp/mod/main.tera
node dist/cli.js compile /tmp/mod/main.tera -o /tmp/mod/main.exe
printf 'from lib import rem\n\nx: float = 7.5 %% 2.0\nprint(x)\nprint(rem(9.5, 2.0))\n' > /tmp/mod/main2.tera
node dist/cli.js compile /tmp/mod/main2.tera -o /tmp/mod/main2.exe && /tmp/mod/main2.exe

# the oracle: the interpreter's exp(1) is Math.E, and fdlibm's is not
node -e "console.log(Math.exp(1) === Math.E)"

npx vitest run --project unit tests/optimizing/prelude/
```

The first `compile` of `/tmp/mod/main.tera` refuses with `unsupported opcode GenericMod`,
because the entry module never spells `%` and so `_float_mod` was never emitted. `main2.tera`
spells one `%` in the entry, and then both remainders — the entry's and the imported
module's — compile and the binary prints `1.5` twice. That pair is the honesty item above,
reduced to two commands.

The `--print-bytecode` line prints `0`. `node -e` prints `true`, which is § the-oracle's
disagreement with fdlibm.

## Tests that pin this

- The mechanism: `tests/optimizing/prelude/index.test.ts` > `"carries nothing for a program that asks for none of them"`, `"carries every helper a program that asks for several of them needs"`, `"answers a prelude the parser can read back"`, `"points a call at the helper the prelude carries"`, `"leaves a program alone when only a lowering adopts its prelude"`, `"names the remainder helper, which no source call reaches"`, `"leaves out a helper a source rewrite already points calls at"` — `emit`, `adopt`, `lowered`, and `unusedHelpers`.
- Demand and suppression for `to_fixed`: `tests/optimizing/prelude/fixed-text.test.ts` > `"declares nothing for a program that never formats a number"`, `"declares the formatter for a program that asks for fixed digits"`, `"finds the call however deeply the program nests it"`, `"stands aside for a class that declares the member itself"`, `"declares the formatter once for several roots that call it"`, `"parses back into classes the compiler can see"`.
- The rewrite: `tests/optimizing/prelude/fixed-text.test.ts` > `"turns the member call into a call on the formatter"`, `"keeps the receiver as the value being formatted"`, `"asks for no digits when the call names none"`, `"leaves a computed member alone"` — `rewriteFixedTexts` moving the receiver into argument 0 and defaulting the digits.
- Suppression for `Error`: `tests/optimizing/prelude/errors.test.ts` > `"declares the error class for a program that constructs one"`, `"declares nothing for a program that spells the name only as text"`, `"stands aside for a program that declares the class itself"`, `"stands aside when any root declares the class"`, `"parses back into a class the compiler can see"` — the user always wins.
- Helper selection: `tests/optimizing/prelude/math-transcendentals.test.ts` > `"stays empty for a program that calls none of them"`, `"carries only the function the program asked for"`, `"carries the helpers that function needs and no others"`, `"carries the argument reduction only the circular functions need"`, `"leaves a member of the same name on something that is not Math alone"`, `"leaves a call given the wrong number of arguments alone"` — the `needs` union.
- The module-level rule, as a property of the emitted text: `tests/optimizing/prelude/math-transcendentals.test.ts` > `"declares every table inside the function that reads it"`.
- The oracle: `tests/optimizing/prelude/math-transcendentals.test.ts` > `"answers what the interpreter answers for the one input fdlibm rounds differently"`, and `tests/e2e/optimizing/aot/math-transcendentals.test.ts` > `"answer the same values the host does when interpreted"`, `"leaves the Math functions a backend carries natively alone"`.
- Exactness of the number reader: `tests/optimizing/prelude/parse-number.test.ts` > `"scales a mantissa by exact powers of two only"`, `"builds a power of ten by exact single steps"`, `"keeps every limb product inside a signed 32-bit word"`, `"reads a whole text the way Number does, prefixes and all"`, `"leaves a program that spells the readers itself alone"`.
- The three replaced miscompiles, as agreement against the interpreter: `tests/e2e/optimizing/aot/parse-number.test.ts` > `"answers parse_float the way the interpreter does for values that round to the nearest double"`, `"answers parse_int the way the interpreter does for values at the edges of the exponent range"`, `"answers Number the way the interpreter does for spellings that are not plain decimals"` — three of the nine reader × group titles the file generates; `"reads a number the same way from an imported module"` is the one that shows an IR-level surface pass crossing a module boundary.
- Compiled agreement for `to_fixed`: `tests/e2e/optimizing/aot/fixed-text.test.ts` > `"compiles a program that formats a number"`, `"compiles a report that formats numbers inside a loop"`, `"leaves the formatter out of a program that never asks for it"`, `"formats a number the entry module of a project asks for"`, and the limit, `"stands down where the formatting lives in an imported module"`.
- Demand for collections: `tests/optimizing/prelude/requests.test.ts` > `"asks only for the set a program builds"`, `"keeps the key kind the literal spells"`, `"follows a variable that holds a constructed class"`, `"follows a parameter that declares the class"`, `"falls back to the primitive values when it cannot name what is stored"`.
- The collection ceiling: `tests/e2e/optimizing/aot/collections.test.ts` > `"declines a listing that is printed rather than iterated"`, `"declines a map that escapes to a call"`, `"shapes a class-valued map when the program is compiled as a module"`.
- Text methods and the shared-name rule: `tests/optimizing/prelude/text-methods.test.ts` > `"leaves the call sites of a member an array also carries to the receiver's type"`, `"still carries a shared member's function where a class declares that same member"`, `"fills the end a one-argument substring left out"`.
- The remainder helper: `tests/optimizing/prelude/float-mod.test.ts` > `"carries the helper for a program that spells a remainder"`, `"does not mistake a division or a multiplication for a remainder"`, `"declares the helper over two floats answering a float"`.
