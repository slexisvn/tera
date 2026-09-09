# 59. Strings without a runtime tag   ⟨ N ⟩

In the interpreter a string is an object. It has a header, a length, a cached hash, a
representation tag saying whether it is a sequential string or a cons or a slice, and a
garbage collector that owns it and knows when to free it. Ask that object anything and it
answers.

A compiled tera program has none of that. A string value is eight bytes holding an address.
The characters at that address are code units terminated by a zero, and the length is
whatever a scan finds before the terminator. There is no header, no tag, and nothing at run
time that can ask a string where it lives or who owns it. That single removal is the whole
subject of this chapter, because it converts a run-time question into a compile-time
obligation with no fallback: **the compiler alone is responsible for the claim that the
bytes are still there when they are read.** Where it cannot make that claim, it refuses the
function.

The chapter has two halves and they are about different words in "string". The first half is
about *where* — three storage classes, a fourteen-line liveness proof that decides which one
a value gets, a whole-program fixpoint that supplies the facts the proof needs, and a
legalization pass that performs, automatically, exactly the remedy the refusal message
recommends. The second half is about *what a character is* — the choice of UTF-16 code
units, a UTF-8 table that is derived rather than written down, and a taint analysis whose
only job is to keep the set of refused operations as small as possible.

`docs/example/stats.tera` reaches all of the first half and compiles clean: its `label()`
method shows every storage class at once, including one string that has been boxed. It
cannot reach the second half, and it cannot reach a *refused* lifetime, because it contains
no non-ASCII character and nothing it builds outlives the storage behind it. Under
[Conventions § 2](../CONVENTIONS.md) those two beats are reproduced as commands in
"Verify it yourself" over named scratch programs, and never as listings beside the running
example. One of the two scratch programs is copied character for character out of
`tests/e2e/optimizing/string-ceiling.test.ts`, so it cannot rot silently.

**What arrived.** From [Ch 58 § what-leaves](58-making-the-program-static.md): a module of
ordinary functions and ordinary structs. No `MakeClosure`, no `LoadContextSlot` or
`StoreContextSlot`, no `Await`, no `Yield`, no parameter holding a function, and exactly one
indirect call in the whole program — `tera_drain` reading a `SCALAR_CODE` field off a queued
frame. Every value in that module carries an `AotScalar` assigned by
[Ch 56 § where-a-scalar-comes-from](56-legality-and-the-art-of-refusing-well.md). For the
ones whose scalar is `SCALAR_STRING`, nobody has yet said where the characters are.

## A string is an address and nothing else

`SCALAR_STRING` has a width of eight bytes (`SCALAR_WIDTHS`,
`src/optimizing/types/scalar.ts:56-63`) and a C spelling of `const tera_char *`
(`C_STRING`, `src/optimizing/target/c-types.ts:15`). It occupies one general-purpose
register on both machine targets. That is the entire run-time representation.

> **New idea. Lifetime, and a dangling pointer.** A value's *lifetime* is the span of
> program time during which the storage holding it still holds it. An address outlives its
> storage's lifetime the moment something else is written there; reading it afterwards
> yields whatever is there now, silently and without any error, and that is a *dangling
> pointer*. Nothing in the machine detects it. In a language with a garbage collector the
> collector is what makes lifetimes irrelevant: it keeps storage alive exactly as long as
> some reference names it. Compiled tera has a collector for objects
> ([Ch 61](61-the-arena-the-shadow-stack-and-why.md)) but strings are not objects to it —
> the address is not a reference the collector understands, and there is no header on the
> other end for it to mark. So string lifetimes are argued statically, ahead of time, by a
> compiler pass, or they are not argued at all.

The consequence to hold on to for the rest of the chapter: because the address carries no
ownership information, every question about a string's storage must be answered before the
program runs. A tagged runtime can afford to be wrong and fix it later; this one cannot be
wrong at all.

## Three storage classes

The compiler has exactly three places to put characters. All three appear in the twenty
lines of C that `Series.label()` becomes.

```
 class            spelling in C                      lifetime               size
 ---------------  ---------------------------------  ---------------------  ----------------
 rodata           static const tera_char v0[]        whole program          one per literal
 producer buffer  static tera_char sb<n>[]           until sb<n> is rewritten  --text-size
 object text      inline bytes inside the object     as long as the object  1024 bytes fixed
```

Rodata is the easy one: a distinct string literal becomes a `static const` array of code
units with its terminator, and it is immutable for the life of the process.

A **producer buffer** is the interesting one. It is a function-`static` array, one per
*producer*, where a producer is an IR node — a string `+`, or an AOT string builtin, or a
line of input — and not a function. Its size is `DEFAULT_TEXT_BUFFER_BYTES`,
`1 << 14` = 16 KB (`src/optimizing/types/scalar.ts:33`), which at two bytes to the code unit
is 8192 code units and therefore 8191 characters after the terminator. Every time its
producer runs it is overwritten from the start.

**Object text** is different in kind. A declared `string` field is not a pointer into
somebody else's storage; it is `TEXT_STORAGE_BYTES` = 1024 bytes of characters laid out
*inside* the object, so it lives exactly as long as the object does. `fieldScalarOf`
(`src/optimizing/metadata/class-table.ts:474-485`) performs that rewrite in one line —
`return scalar === SCALAR_STRING ? SCALAR_TEXT : scalar;` — and `defineArray` (line 600)
does the same for an array element.

The storage class is chosen by the compiler and named in the diagnostic; a programmer never
writes it down. There is exactly one knob, and it is not a per-value one:

```
  --text-size <bytes>           bytes each produced string may take, two to a character (default: 16k, 8191 characters)
```
— `node dist/cli.js help compile`

Note what that sentence is careful to say: **bytes each *produced* string may take.**
`--text-size` sizes producer buffers. It does not size object text, which is fixed at 1024
bytes by `TEXT_STORAGE_BYTES` and is bounded per field by the class table. The compiler
enforces the distinction in two separate places with two separate messages —
`checkConstant` (`src/optimizing/analyses/aot-legality.ts:1513-1527`) measures a constant
against `characterCapacity(this.graph.textBufferBytes)`:

```
$ node dist/cli.js compile longstr.tera --text-size 512 -o long.exe
tera compile: warning: skipped 'tera_program' (x64-windows backend cannot emit: string constant is longer than the 255 characters a compiled string holds; raise it with --text-size, or keep this part interpreted)
```

while `checkTextStore` (`:1484-1497`) measures a constant stored into a field against
`characterCapacity(textCapacityOf(node))` — the field's own width — and pointedly does *not*
mention `--text-size`, because raising it would not help
`[t: tests/optimizing/analyses/aot-legality.test.ts > "says nothing about --text-size for a store the field bounds"]`.

The same distinction is compiled into the binary as its one string-related run-time check.
`tera_str_copy` stops at the capacity it was handed and, if characters remain, calls
`tera_text_overflow`, which prints `TERA_TEXT_OVERFLOW`
(`src/optimizing/target/faults.ts:7-9`) and exits 1:

```
a string outgrew the space reserved for it: a string a function builds grows with --text-size, while a string kept in a field is bounded by that field
```

The compiler proves *where*; the runtime checks *how much*.
`[t: tests/optimizing/analyses/aot-legality.test.ts > "rejects a string constant longer than the storage a compiled string has"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "accepts a string constant that fills the storage exactly"]`
`[t: tests/optimizing/target/text-literal.test.ts > "fits one fewer character than the code units the bytes hold"]`
`[t: tests/optimizing/target/text-literal.test.ts > "holds nothing at all when the bytes cannot carry a terminator"]`

## The scalar that is not a value

`SCALAR_TEXT` breaks the pattern [Ch 56](56-legality-and-the-art-of-refusing-well.md)
established, and the break is deliberate. It is a member of the `AotScalar` union. It has a
width — 1024 — and an alignment, given by the single special case in the file:

```ts
export function scalarAlignment(scalar: AotScalar): number {
  return scalar === SCALAR_TEXT ? scalarWidth(SCALAR_POINTER) : scalarWidth(scalar);
}
```
— `src/optimizing/types/scalar.ts:107-109`

A kilobyte of characters is aligned to eight, not to a kilobyte, because it is a *region*
and not a scalar quantity
`[t: tests/optimizing/metadata/class-table.test.ts > "aligns text storage on the pointer width instead of its full size"]`.

And it has no C type and no register location. `C_BY_SCALAR`
(`src/optimizing/target/c-types.ts:45-52`) lists six scalars and omits this one, so
`cTypeOf(SCALAR_TEXT)` throws `no C type for scalar text` at `:61`. `LOCATIONS`
(`src/optimizing/backends/x64/target.ts:29-35`) lists five and omits it, so `locationOf`
throws `no x64 location for text` at `:95`; `src/optimizing/backends/riscv64/target.ts:20-26`
is the identical table with the identical omission.

That is right rather than an oversight, because `SCALAR_TEXT` describes **storage, not a
value**. Nothing is ever *held* in text. A value loaded out of text is `SCALAR_STRING` — an
address into that storage — and the C emitter says so as directly as it can:
`emitLoadElement` (`src/optimizing/backends/c/emit.ts:2341-2348`) sees `SCALAR_TEXT` and
emits `elementTextAddress`, an address computation, where every other scalar gets a load.
`emitStoreElement` (`:2350-2364`) is its mirror: a `tera_str_set` copy into the address, not
an assignment.

`[t: tests/optimizing/metadata/class-table.test.ts > "gives a declared string field storage of its own rather than a pointer"]`
`[t: tests/optimizing/target/c-types.test.ts > "names the character type after the unit the target stores text in"]`

> **Unenforced.** The invariant is "`SCALAR_TEXT` is a storage scalar and is never a value's
> scalar", and it is the only thing keeping `cTypeOf(SCALAR_TEXT)`
> (`src/optimizing/target/c-types.ts:61`) and `locationOf(SCALAR_TEXT)`
> (`src/optimizing/backends/x64/target.ts:95`) from ever being reached. Nothing checks it.
> `isStorableScalar` (`src/optimizing/types/scalar.ts:79-81`) filters only `SCALAR_VOID`;
> `AotScalar` is one flat seven-member union; the whole guarantee is that `aotScalarOf`
> never returns `SCALAR_TEXT` while `fieldScalarOf` and `defineArray` rewrite into it.
> Breaking it produces a thrown `no C type for scalar text` reaching the user as a crash,
> not a type error and not a refusal. Cost to enforce: split `AotScalar` into value scalars
> and storage scalars — the same fix [Ch 56 § honesty-items] proposes for `SCALAR_VOID`, and
> the two should be done together.

## Who owns and who borrows

The proof is written in a small vocabulary, and the vocabulary is one class:
`StringBufferRules` (`src/optimizing/analyses/aot-legality.ts:529-630`). Four of its
predicates carry the argument.

```ts
  fillsString(node: CFGInstruction): boolean {
    return callsBuiltin(node, INPUT_BUILTIN);
  }

  ownsBuffer(node: CFGInstruction): boolean {
    return this.buildsString(node) || this.fillsString(node);
  }

  borrowsBuffer(node: CFGInstruction): boolean {
    if (node.type === IR_LOAD_TEXT) return true;
    if (takesPendingThrow(node)) return this.model?.throwsBuffer === true;
    if (node.type !== IR_CALL_KNOWN_FUNCTION || !this.isStringValue(node)) return false;
    const summary = this.summaryOf(node);
    return summary === null || summary.returnsBuffer;
  }
```
— `src/optimizing/analyses/aot-legality.ts:546-560`

**`ownsBuffer`** is a producer: a `+` whose result and both inputs are strings, or a call to
one of `AOT_STRING_BUILTINS` (`buildsString`, `:539-544`), or a line of `input()`
(`fillsString`). **`borrowsBuffer`** hands back an address into somebody else's storage: a
`LoadText`, a caught value, or a call whose summary says `returnsBuffer`. Note the last
clause — a call with *no* summary borrows, which is the conservative direction.
**`readsString`** (`:562-565`) consumes a string without keeping it. **`looksUpWithString`**
(`:567-573`) is a narrow exception for a record key, which is only ever `strcmp`'d and never
retained ([Ch 57 § a-record-is-a-lookup-table](57-objects-without-a-runtime-type.md)).

The ownership rule is that **a buffer belongs to the producer, and a producer is an IR node,
not a function.** `Series.label()` contains two string `+` nodes, so it declares two
buffers:

```c
const tera_char * Series_label(unsigned char *p0) {
  static tera_char sb0[8192];
  static tera_char sb1[8192];
  static const tera_char v0[] = {0x20, 0x6d, 0x65, 0x61, 0x6e, 0x3d, 0x0};
  const int32_t v1 = 2;
  const size_t roots = tera_context.root_count;
  if (roots + 2 > 16384) exit(70);
  tera_context.root_count = roots + 2;
  for (size_t at = roots; at < tera_context.root_count; at++) tera_context.roots_base[at] = 0;
  tera_context.roots_base[roots + 0] = (unsigned char *)p0;
  const tera_char *v2 = (tera_char *)(p0 + 8);
  const tera_char *v3 = tera_str_append(tera_str_set(sb0, 8192, v2), 8192, v0);
  unsigned char *v4 = tera_alloc(1032, 6);
  tera_context.roots_base[roots + 1] = (unsigned char *)v4;
  tera_str_set((tera_char *)(v4 + 8), 512, v3);
  const tera_char *v6 = (tera_char *)(v4 + 8);
  const double v7 = Series_mean(p0);
  const tera_char *v8 = _fixed_text(v7, v1);
  const tera_char *v9 = tera_str_append(tera_str_set(sb1, 8192, v6), 8192, v8);
```
— the C emitted for `docs/example/stats.tera`, `stats.c:1350-1368`

Read the storage classes off it. `v0` is rodata: `" mean="` as six code units and a
terminator. `v2` is object text — `(tera_char *)(p0 + 8)` is the address of the `name`
field's characters, eight bytes past the object header, borrowed and not copied. `sb0` and
`sb1` are the two producer buffers, one per `+`. The names come from
`C_STRING_BUFFER_PREFIX = "sb"` and a counter in `declareStringBuffers`
(`src/optimizing/backends/c/emit.ts:1995-2004`), and the declared length is
`codeUnitCapacity(buffer.capacity)` = 8192.

The four remaining lines — `tera_alloc(1032, 6)`, the `tera_str_set` into it, and the read
back out at `v6` — are string boxing, and they are what the last third of this half of the
chapter is about.

One refinement before that. `mergedProducers` (`:473-506`) does not always give one buffer
per producer. Producers whose values reach more than one phi are union-found into a single
group and share one buffer, because a phi of two strings is one address at run time and one
address must name one storage. Producers that reach at most one phi keep a buffer each.

## The proof

`checkStringLifetimes` is fourteen lines and it is the whole soundness argument.

```ts
  private checkStringLifetimes(): void {
    if (this.borrowedFrom.size === 0 && this.bufferByValue.size === 0) return;
    const liveness = computeValueLiveness(this.graph);
    for (const block of this.graph.blocks) {
      const live = new Set(liveness.liveOut(block));
      for (let at = block.nodes.length - 1; at >= 0; at--) {
        const node = block.nodes[at]!;
        this.checkInvalidation(node, live);
        if (this.failure !== null) return;
        live.delete(node);
        if (node.type === IR_PHI) continue;
        for (const input of node.inputs) live.add(input);
      }
    }
  }
```
— `src/optimizing/analyses/aot-legality.ts:1081-1095`

> **New idea. Backwards liveness.** A value is *live* at a program point if some later
> instruction still reads it. You cannot compute that by walking forwards, because the
> reader has not happened yet. So you walk each block from its last instruction to its
> first, starting from the set of values live on the way *out* of the block. At each node
> you first record the current set — that is exactly what is live *after* this node — then
> delete the node itself, because before its definition it did not exist, and add its
> inputs, because they must have been live to reach it. Phis are skipped when adding inputs:
> a phi's inputs are live at the ends of the *predecessor* blocks, not here.

Walking `Series_label` backwards from `v9` gives the set the proof is actually asking about:

```
 node                                    live after it
 --------------------------------------  ------------------------
 v9 = append(set(sb1, v6), v8)           { }
 v8 = _fixed_text(v7, v1)                { v6 }
 v7 = Series_mean(p0)                    { v6, v1 }
 v6 = load text from v4                  { v1, p0 }
 store text v3 into v4                   { v4, v1, p0 }
 v4 = alloc(1032, 6)                     { v3, v1, p0 }
 v3 = append(set(sb0, v2), v0)           { v1, p0 }
```

At each node two questions are asked, in `checkInvalidation` (`:1125-1154`).

The first is `overwritesSameBuffer` (`:1112-1123`): is this node a producer for a buffer
that some *other* value in the live-after set also names? That is two live strings in one
buffer, both still wanted, and it fails immediately:

> `<fn> builds two strings into the same storage while both are still in use; a string lives
> only until the storage behind it is written again, so use each where it is built, copy it
> into an object field, or keep this part interpreted`

The second is `invalidates` (`:1219-1247`), asked for every live value whose origin is not
this node. It has four ways to answer yes. (a) The origin *owns* its buffer and this node is
a call that can re-enter the current function — a re-entrant callee may rebuild the very
buffer we are holding, so the answer is `a call to <callee>`. (b) The origin borrows from a
re-entrant callee and this node builds a string here — `more string building in <fn>`. (c)
This node is a `StoreText` and `writesElsewhere` (`:289-309`) cannot prove it targets a
different field or a different object — `a write to <field>`. (d) This node is a call whose
summary says it writes text through a parameter that may alias the storage we borrowed, or
writes reachable text at all — `a call to <callee>`.

The failure sentence assembles from `borrowedName` (`:1268-1277`) and the answer:

```
$ node dist/cli.js compile fieldstring.tera -o fs.exe
tera compile: warning: skipped 'f' (x64-windows backend cannot emit: f keeps the string it read from n across a write to n, which can overwrite it; a string lives only until the storage behind it is written again, so use it before that point, copy it into an object field, or keep this part interpreted)
tera compile: warning: skipped 'tera_program' (x64-windows backend cannot emit: tera_program keeps the string it read from n across a write to n, which can overwrite it; a string lives only until the storage behind it is written again, so use it before that point, copy it into an object field, or keep this part interpreted)
tera compile: x64-windows backend cannot emit: entry function tera_program could not be lowered to native code: x64-windows backend cannot emit: tera_program keeps the string it read from n across a write to n, which can overwrite it; a string lives only until the storage behind it is written again, so use it before that point, copy it into an object field, or keep this part interpreted
exit=1
```

The program is `s = p.n`, then `p.n = "two"`, then `print(s)` — case (c). Three lines print,
not one: `f` is refused, `f` is also inlined into `tera_program` so the entry function is
refused for the same reason, and because the *entry* cannot be lowered the whole compile
ends in an error rather than a partial binary
([Ch 56 § the-cascade](56-legality-and-the-art-of-refusing-well.md)). This is the shape
[Ch 56 § the-shape-of-a-refusal](56-legality-and-the-art-of-refusing-well.md) catalogued:
what the program did, why it cannot be compiled, and three ways out, the last of which is
always "keep this part interpreted".

`[t: tests/e2e/optimizing/string-ceiling.test.ts > "declines keeping a string read from a field across a write to that field"]`
`[t: tests/e2e/optimizing/string-ceiling.test.ts > "declines keeping a string read from a field across a call that writes one"]`
`[t: tests/e2e/optimizing/string-ceiling.test.ts > "declines a string it built that is held across a call that can re-enter"]`
`[t: tests/e2e/optimizing/string-ceiling.test.ts > "keeps a string buffer live across a call the callee cannot re-enter"]`
`[t: tests/e2e/optimizing/string-ceiling.test.ts > "admits a returned string used before the call that rebuilds it"]`

## Escape summaries are a fixpoint

Every one of those four cases asked a question about a *callee* — does it retain what I gave
it, does it rewrite the field I read from, can it re-enter me — and none of those is a fact a
single function's graph contains. They are whole-program facts, and
`summarizeStringEscapes` (`:752-826`) computes them.

The unit of the answer is `StringEscapeSummary`:

```ts
export interface StringEscapeSummary {
  readonly retains: ReadonlySet<number>;
  readonly returnsBuffer: boolean;
  readonly writesTextThrough: ReadonlySet<number>;
  readonly writesReachableText: boolean;
}
```
— `src/optimizing/analyses/aot-legality.ts:456-461`

`retains` names the parameter indices whose string the callee keeps somewhere the caller
cannot see; `returnsBuffer` says the returned address points into storage the callee owns;
`writesTextThrough` names parameters whose text the callee rewrites; `writesReachableText`
is the give-up flag for a write the analysis could not attribute to a parameter.

> **New idea. A fixpoint over a call graph.** A summary of a function depends on the
> summaries of everything it calls, and in a program with recursion that dependency is
> circular. The standard answer is to start every function at the most optimistic summary —
> here `NO_ESCAPES` (`:637-642`), retaining nothing and writing nothing — then recompute one
> function at a time. Whenever a function's summary changes, every one of its *callers* is
> pushed back onto the worklist, because their answers were computed against the old one.
> Because summaries only ever grow (a set gains indices, a flag goes false to true) and the
> sets are finite, the loop must stop, and where it stops is the *least fixed point*: the
> smallest set of answers consistent with itself. The loop is `:811-824`; the caller index it
> walks backwards over is built at `:762-768`.

That is how retention propagates through a caller that only forwards its argument
`[t: tests/optimizing/analyses/aot-legality.test.ts > "carries retention back through a caller that only forwards the string"]`.

Three relations in `StringEscapeModel` (`:463-471`) are not summaries but reachability
queries, computed from the call graph rather than iterated: `reenters(callee, owner)` is
"can `callee` reach `owner`", `refills(callee, owner)` is "do their reachable sets overlap",
and `storesText` / `producesText` ask whether any text writer or string producer is
reachable from a callee. `reenters` is what makes recursion decidable at all: a function that
can re-enter *itself* may rebuild its own buffer, so a string it built cannot survive such a
call — which is why the refusal for that case names the callee rather than the field.

The whole model is stamped onto every graph in the module by the AOT driver's module stage
(`src/optimizing/drivers/aot.ts:843-864`), which assigns `graph.stringEscapes` and
`graph.wideText` and then invalidates the legality analysis so the per-function proof reruns
against them. That is why this chapter can read both as though they were given.

`[t: tests/optimizing/analyses/aot-legality.test.ts > "does not retain a string parameter the callee copies into its own storage"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "retains a string parameter the callee stores as a pointer"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "reports a function that returns a string it built as returning a buffer"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "does not report a function that returns a string constant as returning a buffer"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "names the parameter whose text a callee rewrites"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "names the field a module rewrites the text of"]`

## Storage an object owns privately

There is exactly one exemption from all of the above, and it is small, sharp, and the reason
the next section works.

```ts
function privateStorage(origin: CFGInstruction): boolean {
  return origin.type === IR_LOAD_TEXT && holdsOwnText(origin.inputs[0]);
}
```
— `src/optimizing/analyses/aot-legality.ts:278-280`

`holdsOwnText` (`:265-276`) answers yes for an object that is `allocated` in this function
and `filledOnce` — every use of it touches text, through it as the receiver, and exactly one
of those uses is a `StoreText`. It walks through phis, so a merge of two such objects still
counts. `invalidates` consults it at `:1226` and returns `null` unconditionally: a string
borrowed from storage like that can never be invalidated, because the compiler has seen
every write and there is only one.

That is the property that makes a *box* work. Fill an object's text field once at
construction and the address of that text is good for the object's whole lifetime, exempt
from every rule in § the-proof.

`[t: tests/optimizing/analyses/aot-legality.test.ts > "owns the text of a box exactly one store fills"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "does not own the text of a box a second store refills"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "does not own the text of a box nothing fills"]`
`[t: tests/optimizing/analyses/aot-legality.test.ts > "admits a built string copied into storage the object owns"]`

## The pass that takes its own advice

Every refusal sentence in § the-proof offers three remedies, and the middle one is always
"copy it into an object field". `boxEscapingStrings`
(`src/optimizing/passes/string-boxing.ts:247-276`) performs that copy automatically, and the
message was written before the pass existed.

The decision is five lines, read in the order it asks:

```ts
function boxable(
  value: CFGInstruction,
  rules: StringBufferRules,
  types: TypeInference,
  positions: Positions,
  reenters: ReenteringCall,
): boolean {
  if (acceptsNull(types.typeOf(value))) return false;
  if (value.uses.length === 0) return false;
  if (borrowsElementText(value)) return livesAcross(value, positions, OVERWRITES);
  if (!answersString(value, rules)) return false;
  if (aliasesOwnBuffer(value, rules, reenters)) return true;
  if (value.uses.every((use) => use.type === IR_RETURN || use.type === IR_PHI)) return false;
  return rules.walk(value).phis === 0 && livesAcross(value, positions, CALLS);
}
```
— `src/optimizing/passes/string-boxing.ts:138-152`

Nullable first: an absence has no text to copy. Then unused values, which need no storage at
all. Then the array case: a text element read that lives across a store into the array is
boxed, with `OVERWRITES` as the hazard set (`IR_STORE_ELEMENT`, `IR_GENERIC_SET_INDEX`). Then
values that are neither producers nor borrowers drop out. Then the re-entrancy case
`aliasesOwnBuffer`, which boxes a string returned by a callee that can re-enter us and then
feeds a builder here. Then the deliberate omission: a value used **only** by `return` or by a
phi is left alone — returning is the caller's proof to make, and a phi is the next section's
job. Everything else asks `livesAcross(value, positions, CALLS)`: does a call sit between
this value's definition and its last use in the block, or does any use leave the block at
all (`:91-108`).

`v3` in `Series_label` answers yes on the last clause. It is a `+`, so it owns `sb0`; its
last use is the `tera_str_set` feeding `sb1`; and `Series_mean` and `_fixed_text` both sit in
between, either of which may build a string. `boxAt` (`:42-61`) then emits three
instructions through the same `Emitter` the coroutine passes use — allocate the shape, store
the value into its `text` field, load it back — and calls `editor.replaceAllUses(value, held)`
so every consumer reads the *load*, not the original. The shape is minted through
[Ch 57 § minting-into-the-same-table](57-objects-without-a-runtime-type.md)'s
`defineSynthetic` as `tera_text` with one `string` field, which the class table lays out as
8 bytes of header plus `TEXT_STORAGE_BYTES`:

```c
  unsigned char *v4 = tera_alloc(1032, 6);
  tera_str_set((tera_char *)(v4 + 8), 512, v3);
  const tera_char *v6 = (tera_char *)(v4 + 8);
```
— `stats.c:1362-1365`

1032 bytes; 512 is `codeUnitCapacity(1024)`, so 511 characters fit. Class id 6's row in
`tera_classes` is `{ 0, 0, 0 }` — no reference fields, because inline text is not a pointer
and the collector has nothing to trace inside a box. And because that object is filled
exactly once, § storage-an-object-owns-privately exempts `v6` from every invalidation rule,
which is precisely why the pass is sound.

The general rule, and it is the best instance of it in this book: **a diagnostic that names a
specific remedy is a specification for a pass.** Someone wrote "copy it into an object field"
as advice to a user; later, someone implemented the advice.

`[t: tests/optimizing/passes/string-boxing.test.ts > "copies the string it read before the slot it came from is written"]`
`[t: tests/optimizing/passes/string-boxing.test.ts > "leaves the read alone when nothing writes the array in between"]`
`[t: tests/optimizing/passes/string-boxing.test.ts > "reports the read it rewrote"]`

The pass runs twice, and the difference matters. As a per-function legalization pass named
`string-boxing` (`src/optimizing/target/legalization.ts:401-408`) it runs with the default
`NEVER_REENTERS`, so the `aliasesOwnBuffer` clause is dead there. The module stage in the AOT
driver (`src/optimizing/drivers/aot.ts:836-841`) runs it again with a real `reentering`
predicate built from `callReachability`, which is the only place that clause can fire.

## Boxing a whole phi web

The harder half of the pass changes the *shape* of the graph rather than one value, and it
exists because a phi of two strings forces two producers into one buffer — the exact
condition `overwritesSameBuffer` refuses.

`carriedWebs` (`:174-195`) union-finds every string-valued phi that feeds another
string-valued phi into a **web**. `mergesStorage` (`:197-200`) keeps only the webs worth
touching: those whose inputs from outside the web are more than one, and all strings.
`boxWeb` (`:202-245`) then rewrites the web so that **the phi carries a box, not a string.**
Each incoming non-web input is boxed at the end of its own predecessor block, memoised per
`(block, input)` so a value arriving twice is allocated once; each phi's uses are replaced by
a load of the box's field; and the intra-web edges are re-pointed last.

The ordering is the invariant. `boxWeb` must not read a phi input it has already rewritten,
so edges that cross from one web member to another are collected into `crossing` during the
first loop and applied only after both loops finish (`:243`). Get that wrong and a phi input
becomes a box in the middle of the walk, `inside.has(input)` stops answering the question it
was asked, and the web is half-rewritten.

`[t: tests/optimizing/passes/string-boxing.test.ts > "gives each incoming string its own allocation"]`
`[t: tests/optimizing/passes/string-boxing.test.ts > "reads the carried string back out of what the phi holds"]`
`[t: tests/optimizing/passes/string-boxing.test.ts > "leaves a phi fed by one producer and a constant alone"]`
`[t: tests/optimizing/passes/string-boxing.test.ts > "leaves a phi alone when one arm carries no string at all"]`
`[t: tests/e2e/optimizing/aot/string-building.test.ts > "keeps two strings built in different branches apart"]`
`[t: tests/e2e/optimizing/aot/string-building.test.ts > "wraps words into lines, taking the line from a word or from a join"]`

> **Unfinished.** `boxable` returns false for a value whose uses are all `IR_RETURN` or
> `IR_PHI` (`src/optimizing/passes/string-boxing.ts:150`), leaving returned strings to the
> caller's proof and phis to `boxWeb`. But `boxWeb` only fires on a web that `mergesStorage`
> — strictly more than one string input from outside. A single-producer string phi carried
> around a loop and then returned is therefore neither boxed nor merged, and is refused later
> if anything in the loop can rebuild the buffer. This is reachable in ordinary code;
> `[t: tests/e2e/optimizing/aot/string-building.test.ts > "keeps the carried string readable across enough rounds to collect"]`
> pins the shape that *does* work. Cost to finish: a real decision about who owns a returned
> string, not a patch.

> **Unfinished.** A producer buffer is `DEFAULT_TEXT_BUFFER_BYTES` — 16 KB — **per
> producer**, emitted as a function-`static` array whether or not the function ever runs.
> `Series_label` alone carries 32 KB of BSS for two `+` operations; a program with forty
> producers carries 640 KB. Nothing sizes a buffer to what its producer can actually build,
> even where every input is a constant of known length. Cost to finish: a length analysis
> over `buildsString` inputs. The pieces exist — `characterCapacity`, constant folding, the
> per-buffer `capacity` field on `AotStringBuffer` that is already threaded everywhere — the
> pass does not.

> **Unenforced.** `bufferOf` (`src/optimizing/backends/c/emit.ts:2006-2015`) throws a bare
> `Error` — "the string vN produces has no buffer to live in, because the compiler could not
> see where it is built; keep this part interpreted" — rather than a `BackendLoweringError`.
> A bare throw is a crash; only a `BackendLoweringError` is caught by the driver and turned
> into a refusal. The machine backends do it properly: `requireStringBuffer` raises a
> `BackendLoweringError` naming the operation, and that path *is* tested
> `[t: tests/optimizing/machine/string-buffer-refusal.test.ts > "x64 names the concatenation it cannot place"]`.
> Cost to fix: one throw site.

## What a character is

The second half of the chapter is about the other word.

> **New idea. Code unit, code point, character.** A *code point* is a number Unicode assigns
> to a character — `à` is U+00E0. A *code unit* is the fixed-size integer an encoding
> actually stores: UTF-8 uses 8-bit units and spends one to four of them per code point,
> UTF-16 uses 16-bit units and spends one or two. The three counts differ. `"Xin chào"` is
> **8 code points, 9 UTF-8 bytes, and 8 UTF-16 code units**, because `à` costs two bytes in
> UTF-8 and one unit in UTF-16. A compiler must pick one, and every length, index and slice
> in the language then answers in whatever it picked.

tera picks UTF-16, and it did not have a choice.
[Part IX § which-of-the-four-machines-this-part-constrains](_part.md) states the rule this
road runs under: the interpreter is the oracle, and a compiled program is correct exactly
when it agrees with it. The interpreter is a JavaScript engine, so `.length` and
`.char_code_at` answer in UTF-16 code units. Therefore the compiled program stores UTF-16
code units. `TEXT_UNIT_SHIFT = 1`, `TEXT_UNIT_BYTES = 2`
(`src/optimizing/types/scalar.ts:27-29`), and `tera_char` is `typedef`'d from
`C_WIDE_TEXT_UNIT = "uint16_t"` (`src/optimizing/target/c-types.ts:21-32`). Every literal in
the emitted C is a code-unit array — `{0x20, 0x6d, 0x65, 0x61, 0x6e, 0x3d, 0x0}` above — and
in the emitted assembly it is a `.short` directive
(`src/optimizing/machine/data.ts:87-89`), not `.ascii`. UTF-8 appears only at the I/O
boundary, and `byteEscapedLiteral` survives only for the runtime's own byte-string messages
like `"Uncaught "`.

That decision is a **capability**, not a fact about the language: `"utf16-text"`, declared by
`cTarget` (`src/optimizing/backends/c/target.ts:6-15`) and by the x64 targets
(`src/optimizing/backends/x64/target.ts:75-84`), and **not** by riscv64
(`src/optimizing/backends/riscv64/target.ts:42`), which is still on bytes. The same program
compiles on one target and is refused on the other; § two-refusals-not-one shows both.

`[t: tests/optimizing/target/unicode.test.ts > "splits a supplementary code point the way the runtime stores it"]`
`[t: tests/optimizing/target/unicode.test.ts > "joins a pair back into the code point the string spells"]`
`[t: tests/optimizing/target/unicode.test.ts > "tells a lead unit from a trail unit by the mask alone"]`
`[t: tests/optimizing/target/unicode.test.ts > "covers exactly the code points a pair can reach"]`

> **New idea. Surrogate pair.** UTF-16's 16-bit unit cannot hold a code point above 0xFFFF,
> so the range 0xD800–0xDFFF is reserved and never assigned to a character: a code point
> above the basic plane is stored as a *lead* unit from 0xD800 and a *trail* unit from
> 0xDC00, each carrying ten bits of the offset from 0x10000. `src/optimizing/target/unicode.ts`
> derives all of that from `SURROGATE_BITS = 10`: `TRAIL_SURROGATE` is `LEAD_SURROGATE + 2**10`,
> `SURROGATE_LIMIT` is `TRAIL_SURROGATE + 2**10`, and `SURROGATE_PAYLOAD_MASK` is `2**10 - 1`
> (`:11-19`). The consequence for a programmer is the one worth remembering: `.length` counts
> units, so a string of one emoji has a length of 2.

## A table nobody wrote down

`src/optimizing/target/unicode.ts` is 68 lines and contains **no UTF-8 table**. It contains
the two facts a table would have been derived from.

```ts
function utf8Sequence(bytes: number): Utf8Sequence {
  const leadBits = bytes === 1 ? UTF8_LEAD_BITS : UTF8_LEAD_BITS - bytes;
  const leadShift = UTF8_TAIL_BITS * (bytes - 1);
  return {
    bytes,
    limit: 2 ** (leadBits + leadShift),
    mark: bytes === 1 ? 0 : (2 ** bytes - 1) * 2 ** (BYTE_BITS - bytes),
    leadMask: 2 ** leadBits - 1,
    leadShift,
    tailShifts: Array.from(
      { length: bytes - 1 },
      (_unused, index) => leadShift - UTF8_TAIL_BITS * (index + 1),
    ),
  };
}
```
— `src/optimizing/target/unicode.ts:38-52`

The two facts: an `n`-byte lead byte has `8 - n` free bits (or 7 when `n` is 1, since a
one-byte sequence has no mark), and each continuation byte carries 6. Everything else —
the mark, the mask, the shifts, the code-point limit — falls out arithmetically.
`utf8Sequences()` (`:54-60`) then grows the list with a `do…while` until the last entry's
`limit` covers `UNICODE_LIMIT`, which is itself derived from the surrogate constants at
`:21`. `UTF8_MOST_BYTES` is the list's length rather than the literal 4, and `ASCII_LIMIT` is
*defined* as `UTF8_SEQUENCES[0].limit` (`:66`) rather than written as 128.

This is the clearest place in the tree where the repository's no-hardcoding rule pays for
itself, and the reason is what the tests do with it. A hand-written table would be checked
against a second copy of the same table, which proves only that someone typed it twice. These
tests check the derived table against **the platform's own encoder**
`[t: tests/optimizing/target/unicode.test.ts > "spells every sample the way the platform encoder does"]`
and against the platform's own answer for where one-byte sequences stop
`[t: tests/optimizing/target/unicode.test.ts > "marks ASCII off at the byte the platform stops spelling as one byte"]`.

`[t: tests/optimizing/target/unicode.test.ts > "picks the narrowest sequence that holds the code point"]`
`[t: tests/optimizing/target/unicode.test.ts > "tells lead bytes apart by their marks alone"]`
`[t: tests/optimizing/target/unicode.test.ts > "keeps continuation bytes out of the lead byte range"]`
`[t: tests/optimizing/target/unicode.test.ts > "reaches every code point Unicode allows and no wider"]`
`[t: tests/optimizing/target/text-literal.test.ts > "writes text outside ASCII as the UTF-8 bytes it takes"]`
`[t: tests/optimizing/target/text-literal.test.ts > "never reaches for a hex escape, which an assembler reads as variable length"]`

## Where wide text can reach

`src/optimizing/analyses/wide-text.ts` is a whole-program taint analysis, and it is the third
such shape in this part after escape summaries and points-to. Its question: which values in
this module might hold a character outside ASCII?

The seeds are two, and they are three lines:

```ts
function wideConstant(node: CFGInstruction): boolean {
  if (node.type !== IR_CONSTANT) return false;
  const value = node.props.value;
  return typeof value === "string" && !isAsciiRepresentable(value);
}

function readsUnknownText(node: CFGInstruction): boolean {
  return callsBuiltin(node, INPUT_BUILTIN);
}

function seedsWideText(node: CFGInstruction): boolean {
  return wideConstant(node) || readsUnknownText(node);
}
```
— `src/optimizing/analyses/wide-text.ts:42-54`

`isAsciiRepresentable` (`:38-40`) is a nice piece of economy: a string is ASCII exactly when
its UTF-8 byte length equals its code-unit length, so the platform encoder decides and no
range test is written. `input()` is a seed because a line typed at a terminal can contain
anything.

`wideValuesIn` (`:91-116`) marks the seeds and floods forward through `uses` until nothing
changes. Then `letsTextEscape` (`:124-136`) asks the escape question: does any wide value
reach a node in `LEAVES_FOR_THE_HEAP` — a return, a field store, an element store, a global
store, or a call?

> **New idea. Escape, and why one witness widens everything.** A value *escapes* when it
> reaches somewhere the analysis can no longer follow it: into a field, into a global, into a
> callee, out through a return. Once a wide string escapes, the analysis has lost track of
> it, and any later *load* — a parameter, a field read, an element read, a global read,
> `ENTERS_FROM_THE_HEAP` at `:56-62` — might be that same string coming back. So a single
> witness anywhere in the module flips one module-wide flag, and on the next pass every load
> in every function is re-seeded as possibly wide (`wideValuesIn(graph, model.escapes, …)`
> at `aot-legality.ts:1023-1029`). This is the conservative direction and it is deliberately
> coarse: being wrong the other way would compile a program that answers a wrong length.

`summarizeWideText` (`:143-158`) opens with the exit that makes all of this free for the
overwhelming majority of programs: if no unit in the module `spellsWideText` at all, answer
`NARROW_TEXT` immediately and never build a set. `stats.tera` takes that exit.

`[t: tests/optimizing/analyses/wide-text.test.ts > "counts Vietnamese text as not representable"]`
`[t: tests/optimizing/analyses/wide-text.test.ts > "measures text by the bytes UTF-8 takes rather than the code units"]`
`[t: tests/optimizing/analyses/wide-text.test.ts > "carries it through the text a program builds from it"]`
`[t: tests/optimizing/analyses/wide-text.test.ts > "treats what arrives from the heap as wide once the module let some escape"]`
`[t: tests/optimizing/analyses/wide-text.test.ts > "holds no value wide when nothing in the module spells wide text"]`
`[t: tests/optimizing/analyses/wide-text.test.ts > "treats the text a program reads from outside itself as wide"]`
`[t: tests/optimizing/analyses/wide-text.test.ts > "reports no escape for wide text the program only prints"]`

## Two refusals, not one

What the analysis is *for* is refusing the smallest possible set of operations. Two named
sets do the refusing. `INDEXES_CHARACTERS` (`:160-168`) is `length`, `char_at`,
`char_code_at`, `slice`, `index_of`, `pad_start`, `pad_end` — everything whose answer depends
on how many units a character costs. `MAPS_UNICODE` (`:170-176`) is `to_upper_case`,
`to_lower_case`, `trim`, `trim_start`, `trim_end` — everything that needs a Unicode property
table. Printing, joining, comparing, `includes`: all of those give the same answer whichever
way the bytes are counted, and none of them is ever refused.

Which set applies is decided by one line:

```ts
    const counts = exact ? mapsUnicode(node) : countsCharacters(node);
```
— `src/optimizing/analyses/aot-legality.ts:1778`

with `exact` coming from `graph.wideText.exact`, which the driver set from
`backend.target.capabilities.has("utf16-text")` (`src/optimizing/drivers/aot.ts:858`). On a
target that stores code units, only `MAPS_UNICODE` is refused. On one that does not, the
larger `COUNTS_CHARACTERS` is.

Both messages, run:

```
$ node dist/cli.js compile wide2.tera -o wide2.exe
tera compile: warning: skipped 'tera_program' (x64-windows backend cannot emit: string.to_upper_case maps characters the way Unicode says, and this text holds some outside ASCII; the compiled runtime carries no case or whitespace tables, so keep this part interpreted)

$ node dist/cli.js compile wide.tera --emit source --target riscv64 -o wide-rv
tera compile: note: 'tera_program' is not in the binary, and nothing the program runs calls it (riscv64 backend cannot emit: string.length counts characters, and this text holds some outside ASCII, which a compiled string stores as several bytes each; print it, join it, compare it or search it for a substring, or keep this part interpreted)
```

The two have different futures, and the difference is worth being precise about. The second
is a **target** limitation. On x64 and C, `storesCodeUnits` (`:204-206`) is true, and the
same program compiles and runs:

```
$ node dist/cli.js compile wide.tera -o wide.exe
$ ./wide.exe
Xin chào
8
```

Eight — the interpreter's answer for `"Xin chào".length`, code units, character for
character. The first refusal is a **runtime** limitation and applies everywhere including
x64: Unicode case mapping needs tables the binary does not carry, and no encoding choice
fixes that. Note also the difference in severity in the two runs above. The `to_upper_case`
refusal takes down the entry function and the compile exits 1; the riscv64 one is a *note*,
because `--emit source` on a target that cannot link still writes the assembly it could
produce, and exits 0.

One escape hatch: `BYTEWISE_PROP` (`:30`). A pass that has deliberately chosen to read text
in bytes — the number readers of
[Ch 60 § prelude-two-parse-number](60-a-runtime-written-in-its-own-language.md), stamped by
`markNumberTextBytewise` — sets that prop, and `stringMemberOf` (`:183-188`) and
`readsTextBytewise` (`:118-122`) both step aside for it entirely
`[t: tests/optimizing/analyses/wide-text.test.ts > "stands aside for a read a pass took on purpose in bytes"]`.

`[t: tests/optimizing/analyses/wide-text.test.ts > "names the ones that count characters"]`
`[t: tests/optimizing/analyses/wide-text.test.ts > "leaves the ones whose answer is the same bytes either way"]`
`[t: tests/optimizing/analyses/wide-text.test.ts > "leaves a member of another owner alone"]`

> **Unfinished.** riscv64 does not declare `"utf16-text"`
> (`src/optimizing/backends/riscv64/target.ts:42`), so on that target every member in
> `INDEXES_CHARACTERS` is refused for any program containing a single non-ASCII character —
> including `print("Xin chào".length)`, which x64 and C compile and answer correctly, as the
> run above shows. The refusal is honest and its wording is good; the gap is real. Cost to
> finish: the same code-unit work already done for x64 in `src/optimizing/backends/x64/`,
> carried into riscv64's own lowering and data emission.

> **Unfinished.** `WideTextModel.exact` (`src/optimizing/analyses/wide-text.ts:74-78`) is a
> capability answer wearing the name of a precision claim. It is a parameter of
> `summarizeWideText` defaulting to `false`, set from
> `capabilities.has("utf16-text")` at `src/optimizing/drivers/aot.ts:858`, and read in
> exactly one place, `aot-legality.ts:1019`, to choose between the two refusal sets. No test
> in the tree names the field; `tests/optimizing/analyses/wide-text.test.ts` never mentions
> it, and `tests/optimizing/analyses/aot-legality.test.ts:1044` constructs a `wideText` model
> without it. Cost to fix: rename it to what it means — `storesCodeUnits`, say — or give it
> the meaning its name implies.

> `[unpinned]` — the `Series_label` boxing this chapter reads is exercised only through
> `tests/e2e/docs/book-examples.test.ts` running `stats.tera` in the interpreter. No test
> names the box in that function, and no test compiles `stats.tera` to a binary and compares
> its output with the interpreter's.

## What leaves

Every string address in the binary now points into storage some pass can name: a `static
const` array in read-only data, a function-`static` producer buffer `sb<n>`, or text laid out
inside a heap object. Where the compiler could not name one, it refused the function and said
in a sentence what the program did, why, and three ways to change it. `graph.wideText`
carries the module-wide UTF-8/UTF-16 answer, and `graph.stringEscapes` carries the
whole-program summary the proof was argued against.

Chapter 60 takes the same module and notices something the C listing above has been showing
all along. `_fixed_text` is called on line 1367. `_FixedText` is defined two lines below the
end of `Series_label`, and `_FixedDigits_format` is in the same file. None of them is in the
user's program.
None of them is written in C either, and none of them is a compiler builtin: they arrived as
**tera source**, appended to the entry module, parsed and typechecked with the user's own
declarations and compiled by the passes this chapter has been describing. That is
[Ch 60 § what-a-runtime-usually-is](60-a-runtime-written-in-its-own-language.md), and the
`_FixedText` class exists for a reason this chapter has already given: it holds
`this.text = this.text + piece` in an *object field*, which is exactly what the refusal
message tells a user to do.

## Verify it yourself

```bash
# the three storage classes and the box, in one function
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
sed -n '1350,1371p' /tmp/stats-c/stats.c

# a lifetime the compiler cannot prove, refused verbatim
printf 'class P:\n  public constructor(n: string):\n    this.n = n\n\nfn f(p: P) -> int:\n  s = p.n\n  p.n = "two"\n  print(s)\n  return 0\n\nprint(f(P("one")))\n' > /tmp/fieldstring.tera
node dist/cli.js compile /tmp/fieldstring.tera -o /tmp/fs.exe; echo "exit=$?"

# non-ASCII text: compiled on x64, refused on riscv64, refused everywhere for case mapping
printf 's = "Xin ch\303\240o"\nprint(s)\nprint(s.length)\n' > /tmp/wide.tera
printf 's = "Xin ch\303\240o"\nprint(s.to_upper_case())\n' > /tmp/wide2.tera
node dist/cli.js /tmp/wide.tera
node dist/cli.js compile /tmp/wide.tera -o /tmp/wide.exe && /tmp/wide.exe
node dist/cli.js compile /tmp/wide.tera --emit source --target riscv64 -o /tmp/wide-rv
node dist/cli.js compile /tmp/wide2.tera -o /tmp/wide2.exe; echo "exit=$?"

# the constant that does not fit, and the knob the message names
node dist/cli.js help compile | grep text-size

npx vitest run --project unit tests/optimizing/passes/string-boxing.test.ts tests/optimizing/analyses/wide-text.test.ts tests/optimizing/target/unicode.test.ts tests/optimizing/target/text-literal.test.ts tests/optimizing/machine/string-buffer-refusal.test.ts
```

`\303\240` is the UTF-8 for `à`, written as octal escapes so the line survives a shell that
would otherwise mangle it. Neither scratch program belongs in `docs/example/` — neither is a
variation of the running example — and `fieldstring.tera` is copied character for character
from `tests/e2e/optimizing/string-ceiling.test.ts:246-260`. The riscv64 command exits 0 and
prints a *note*, not an error: `--emit source` on a target that cannot link still writes the
assembly it can produce.

## Tests that pin this

- `tests/optimizing/analyses/aot-legality.test.ts` > `"rejects a string constant longer than the storage a compiled string has"` — the `--text-size` ceiling on a producer buffer.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"accepts a string constant that fills the storage exactly"` — the off-by-one at the terminator.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"accepts a string constant outside ASCII"` and `"gives a string constant outside ASCII the same room as an ASCII one"` — capacity is measured in code units, not bytes.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"admits a constant that fits the storage the field holds"`, `"rejects a constant one character past what the field holds"`, `"names the field a too-long constant would not fit"`, `"says nothing about --text-size for a store the field bounds"` — the field ceiling is a different ceiling with a different message.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"rejects storing text into an array of numbers"` — `SCALAR_TEXT` storage is declared, not inferred at the store.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"admits a built string copied into storage the object owns"`, `"rejects a built string stored as a pointer and names what to do instead"`, `"says a built string is held without naming the operation that held it"`, `"names the callee a built string is handed to"` — the four refusal wordings.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"does not retain a string parameter the callee copies into its own storage"`, `"retains a string parameter the callee stores as a pointer"`, `"carries retention back through a caller that only forwards the string"` — `retains`, and the fixpoint that propagates it.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"reports a function that returns a string it built as returning a buffer"`, `"does not report a function that returns a string constant as returning a buffer"` — `returnsBuffer`.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the parameter whose text a callee rewrites"`, `"names no parameter for a callee that only writes text it allocated itself"`, `"names the field a module rewrites the text of"` — `writesTextThrough` and `rewritesField`.
- `tests/optimizing/analyses/aot-legality.test.ts` > `"owns the text of a box exactly one store fills"`, `"does not own the text of a box a second store refills"`, `"does not own the text of a box nothing fills"` — `holdsOwnText`, the exemption boxing depends on.
- `tests/optimizing/passes/string-boxing.test.ts` > `"copies the string it read before the slot it came from is written"`, `"leaves the read alone when nothing writes the array in between"`, `"reports the read it rewrote"` — the element-text half of `boxable`.
- `tests/optimizing/passes/string-boxing.test.ts` > `"gives each incoming string its own allocation"`, `"reads the carried string back out of what the phi holds"`, `"reports the web it rewrote"`, `"leaves a phi fed by one producer and a constant alone"`, `"leaves a phi alone when one arm carries no string at all"` — `carriedWebs`, `mergesStorage`, `boxWeb`.
- `tests/optimizing/metadata/class-table.test.ts` > `"gives a declared string field storage of its own rather than a pointer"`, `"aligns text storage on the pointer width instead of its full size"` — `fieldScalarOf` and the one special case in `scalarAlignment`.
- `tests/optimizing/target/c-types.test.ts` > `"names the character type after the unit the target stores text in"`, `"leaves the spelling of a string parameter the same whichever unit is chosen"`, `"guards both typedefs so a header included twice declares them once"` — `tera_char` and `cTypedefs`.
- `tests/optimizing/target/text-literal.test.ts` > `"fits one fewer character than the code units the bytes hold"`, `"answers exactly the text that spells back into those bytes"`, `"holds nothing at all when the bytes cannot carry a terminator"` — `characterCapacity`.
- `tests/optimizing/target/text-literal.test.ts` > `"writes text outside ASCII as the UTF-8 bytes it takes"`, `"writes a character above the basic plane as all four of its bytes"`, `"pads every escape to three digits so a following digit is not absorbed"`, `"never reaches for a hex escape, which an assembler reads as variable length"` — `byteEscapedLiteral`, the byte-string path.
- `tests/optimizing/target/unicode.test.ts` > `"spells every sample the way the platform encoder does"`, `"reads back the code point it spelled"`, `"picks the narrowest sequence that holds the code point"`, `"tells lead bytes apart by their marks alone"`, `"keeps continuation bytes out of the lead byte range"`, `"reaches every code point Unicode allows and no wider"`, `"marks ASCII off at the byte the platform stops spelling as one byte"` — the derived UTF-8 table, checked against the platform.
- `tests/optimizing/target/unicode.test.ts` > `"splits a supplementary code point the way the runtime stores it"`, `"joins a pair back into the code point the string spells"`, `"tells a lead unit from a trail unit by the mask alone"`, `"leaves every character that needs no pair outside the surrogate range"`, `"covers exactly the code points a pair can reach"` — surrogate pairs.
- `tests/optimizing/analyses/wide-text.test.ts` > `"counts plain ASCII as representable"`, `"counts Vietnamese text as not representable"`, `"counts an emoji as not representable"`, `"measures text by the bytes UTF-8 takes rather than the code units"` — `isAsciiRepresentable`.
- `tests/optimizing/analyses/wide-text.test.ts` > `"finds the constant that spells it"`, `"leaves a constant that stays inside ASCII narrow"`, `"carries it through the text a program builds from it"`, `"leaves what a program builds from ASCII alone narrow"` — seeding and the forward flood.
- `tests/optimizing/analyses/wide-text.test.ts` > `"treats what arrives from the heap as wide once the module let some escape"`, `"treats a text parameter as wide once the module let some escape"`, `"reports an escape once wide text is stored where the analysis cannot follow"`, `"leaves a module that only prints what it read narrow on the heap"`, `"reports no escape for wide text the program only prints"`, `"holds no value wide when nothing in the module spells wide text"`, `"treats the text a program reads from outside itself as wide"` — the escape rule and the cheap exit.
- `tests/optimizing/analyses/wide-text.test.ts` > `"names the ones that count characters"`, `"leaves the ones whose answer is the same bytes either way"`, `"leaves a member of another owner alone"`, `"stands aside for a read a pass took on purpose in bytes"` — `COUNTS_CHARACTERS` and `BYTEWISE_PROP`.
- `tests/optimizing/machine/string-buffer-refusal.test.ts` > `"x64 names the concatenation it cannot place"`, `"riscv64 names the concatenation it cannot place"`, `"x64 names the builtin it cannot place"` — three template-generated titles; the machine backends raise a `BackendLoweringError` where the C backend throws a bare `Error`.
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits concatenation, rendering and indexing of strings"`, `"admits an array of spelled-out strings because they live in read-only data"`, `"admits an array of strings the program builds, because elements hold text"` — the three storage classes, end to end.
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"declines prepending an accumulator to itself"`, `"declines a string it built that is held across a call that can re-enter"`, `"declines keeping a string read from a field across a write to that field"`, `"declines keeping a string read from a field across a call that writes one"` — the four ways `invalidates` answers yes.
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits building a string after a call has already returned"`, `"keeps a string buffer live across a call the callee cannot re-enter"`, `"admits string building in a function that can re-enter itself"`, `"admits a returned string used before the call that rebuilds it"`, `"keeps a string a wrapper returned across a call that rebuilds the buffer behind it"`, `"admits a returned string kept across a call that cannot rebuild it"` — the cases `reenters` and `refills` let through.
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits a line of input copied into a field the object owns"`, `"admits a built string copied into a field the object owns"`, `"admits copying one field of owned text into another"`, `"keeps two returned strings alive at once by copying each into storage of its own"` — the remedy the refusal recommends, taken by hand.
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"appends a different piece per branch inside a loop"`, `"builds an inner string per row and joins the rows"`, `"keeps two strings built in different branches apart"`, `"keeps a string a later pass of the same loop would overwrite"`, `"wraps words into lines, taking the line from a word or from a join"`, `"keeps the carried string readable across enough rounds to collect"` — boxing and phi webs against a real binary's stdout.
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"formats a number in the same statement that reads a field"`, `"reads one field while another field of the same object is written"`, `"keeps a field string in an array when nothing ever rewrites that field"`, `"carries an awaited string into a second await"` — `writesElsewhere` and `settledText`, the two places the proof is allowed to be precise rather than conservative.
