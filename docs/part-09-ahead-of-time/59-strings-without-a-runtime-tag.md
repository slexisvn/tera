# 59. Strings without a runtime tag   ⟨ N ⟩

> **Status:** outline

**Thesis.** A string a function builds lives in a static buffer named after its producer,
which is only sound if the compiler can prove no two live values ever share one — and when
it cannot, a later pass performs exactly the fix the error message suggests.

**What arrived.** From chapter 58: a module of ordinary functions and ordinary structs. No
closures, no context slots, no `Await`, no `Yield`, no callable parameters, and exactly one
indirect call. Every value in it has an `AotScalar` from chapter 56 — and for the ones whose
scalar is `SCALAR_STRING`, nobody has yet said **where the characters are**.

**What leaves.** A module in which every string value is an address into storage the
compiler has proved: a `static const` array in read-only data, a function-`static` buffer
`sb<n>`, or a text field inside a heap object. `graph.wideText` carries the whole-program
UTF-8/UTF-16 answer. Chapter 60 takes that module and notices that most of the runtime it
still calls — `to_fixed`, `parse_float`, `Math.exp`, `Map` — is not written in C or
TypeScript at all.

**New ideas.** *A value's lifetime, and a dangling pointer*; *storage class (rodata /
static / heap)*; *backwards liveness*; *escape*; *a fixpoint over a call graph*; *code unit
vs code point vs character*; *UTF-8 and UTF-16, and why a compiler must pick one*;
*surrogate pair*.

**Length.** 14 pages

## Anchors

- `src/optimizing/types/scalar.ts:27-37, 56-63, 107-109` — `SCALAR_TEXT`,
  `TEXT_UNIT_SHIFT = 1`, `TEXT_UNIT_BYTES = 2`, `TEXT_STORAGE_BYTES = 1024`,
  `DEFAULT_TEXT_BUFFER_BYTES = 1 << 14`, `TEXT_BUFFER_MINIMUM_BYTES`; `SCALAR_WIDTHS`
  giving `SCALAR_TEXT` a width of 1024 and `SCALAR_STRING` a width of 8;
  `scalarAlignment`, the one function that special-cases `SCALAR_TEXT` (aligned to 8, not
  1024).
- `src/optimizing/target/text-literal.ts` — `codeUnitCapacity(bytes) = bytes / 2`,
  `characterCapacity(bytes) = codeUnitCapacity(bytes) - 1` (the terminator),
  `byteEscapedLiteral`, `codeUnitList`.
- `src/optimizing/target/c-types.ts` — `C_BY_SCALAR` (45-52) with **no entry for
  `SCALAR_TEXT`**, so `cTypeOf(SCALAR_TEXT)` throws `no C type for scalar text` (59-63);
  `C_CHAR = "tera_char"`, `C_STRING = "const tera_char *"`,
  `C_WIDE_TEXT_UNIT = "uint16_t"`, `C_NARROW_TEXT_UNIT = "unsigned char"`,
  `cTypedefs(textUnit)`.
- `src/optimizing/backends/x64/target.ts:29-35` — `LOCATIONS`, also with **no entry for
  `SCALAR_TEXT`**; `locationOf` throws `no x64 location for text`.
  `src/optimizing/backends/riscv64/target.ts:25` is the same table.
- `src/optimizing/analyses/aot-legality.ts` — the lifetime proof.
  `AotStringBuffer { producer, producers, capacity }` (450-454),
  `StringEscapeSummary` (456-461), `StringEscapeModel` (463-471),
  `mergedProducers` (473-506), `mergedTextInputs` (508-520),
  `StringBufferWalk` (522-527), class `StringBufferRules` (529-…) with
  `isStringValue`, `buildsString`, `fillsString`, `ownsBuffer`, `borrowsBuffer`,
  `readsString`, `looksUpWithString`; `summarizeStringEscapes` (752),
  `holdsOwnText` (265-276), `privateStorage` (278-280),
  `checkStringLifetimes` (1081-1095), `buildsHere` (1097), `exposedAt` (1101),
  `stringOriginOf` (1108), `overwritesSameBuffer` (1112-1123),
  `checkInvalidation` (1125-1154), `borrowsPrivateStorage` (1204-1211),
  `reentersFrom` (1213-1217), `invalidates` (1219-1250),
  `checkConstant`'s length refusal (1515-1527).
- `src/optimizing/passes/string-boxing.ts` — 276 lines. `boxEscapingStrings` (247-276),
  `boxable` (138-152) — the five-line decision, `livesAcross` (91-108),
  `boxAt` (42-61), `answersString` (63-66), `borrowsElementText` (110-112),
  `aliasesOwnBuffer` (125-136), `feedsBuilder` (118-123), `carriedWebs` (174-195) using
  `UnionFind`, `mergesStorage` (197-200), `boxWeb` (202-245),
  `TEXT_BOX_SHAPE = "tera_text"`, `TEXT_BOX_FIELD = "text"`, `textBoxShape` (31-35)
  minting through chapter 57's `defineSynthetic`, `CALLS` and `OVERWRITES` (68-89).
- `src/optimizing/analyses/wide-text.ts` — 221 lines. `utf8ByteLength`,
  `isAsciiRepresentable` (38-40), `wideConstant`, `readsUnknownText`, `seedsWideText`,
  `ENTERS_FROM_THE_HEAP` (56-62), `LEAVES_FOR_THE_HEAP` (64-72),
  `WideTextModel { escapes, reason, exact }`, `NARROW_TEXT`, `wideValuesIn` (91-116),
  `letsTextEscape` (124-136), `summarizeWideText` (143-158),
  `INDEXES_CHARACTERS` / `MAPS_UNICODE` / `COUNTS_CHARACTERS` (160-181),
  `countsCharacters`, `mapsUnicode`, `storesCodeUnits` (204-206),
  `unicodeTableReason` (208-213), `wideTextReason` (215-221), `BYTEWISE_PROP`.
- `src/optimizing/target/unicode.ts` — 68 lines, and **no table is written down**.
  `utf8Sequence(bytes)` (38-52) derives lead mask, mark, limit and tail shifts
  arithmetically; `utf8Sequences()` (54-60) grows the list with a `do…while` until it
  covers `UNICODE_LIMIT`; `ASCII_LIMIT` is *defined as* `UTF8_SEQUENCES[0].limit`.
  Also the UTF-16 constants: `LEAD_SURROGATE`, `TRAIL_SURROGATE`, `SURROGATE_LIMIT`,
  `SURROGATE_MASK`, `SURROGATE_PAYLOAD_MASK`, `SUPPLEMENTARY_BASE`, `TEXT_UNIT_BITS`,
  `TEXT_TERMINATOR_UNITS`, `TEXT_STREAM_BYTES`.
- `src/optimizing/backends/c/emit.ts` — `C_STRING_BUFFER_PREFIX = "sb"` (260),
  `declareStringBuffers` (1995-2004), `bufferOf` (2006-2015) with its
  "has no buffer to live in" throw, `bufferNameOf`, `bufferCapacityOf`,
  `emitStringConcat` (2027), `elementTextAddress` (2334-2339),
  `emitLoadElement` / `emitStoreElement` (2341-2364) — the two places `SCALAR_TEXT` is
  handled by address rather than by value.
- `src/cli/spec.ts:396-405` — `--text-size <bytes>`, defaulting to
  `DEFAULT_TEXT_BUFFER_BYTES` and reported in the help as a character count.
- `src/optimizing/target/capabilities.ts:10` and `src/optimizing/backends/*/target.ts` —
  the `"utf16-text"` capability, declared by `cTarget` and the x64 targets and **not** by
  riscv64.

## Worked example

`docs/example/stats.tera`. One twenty-line function in its C output shows all four storage
classes at once — and one of the four is a pass undoing a refusal:

```
$ node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
$ sed -n '1349,1370p' /tmp/stats-c/stats.c
const tera_char * Series_label(unsigned char *p0) {
  static tera_char sb0[8192];
  static tera_char sb1[8192];
  static const tera_char v0[] = {0x20, 0x6d, 0x65, 0x61, 0x6e, 0x3d, 0x0};
  ...
  const tera_char *v2 = (tera_char *)(p0 + 8);
  const tera_char *v3 = tera_str_append(tera_str_set(sb0, 8192, v2), 8192, v0);
  unsigned char *v4 = tera_alloc(1032, 6);
  tera_str_set((tera_char *)(v4 + 8), 512, v3);
  const tera_char *v6 = (tera_char *)(v4 + 8);
  ...
  const tera_char *v9 = tera_str_append(tera_str_set(sb1, 8192, v6), 8192, v8);
```

- `v0` — a rodata constant, `" mean="` as code units with its terminator.
- `sb0`, `sb1` — two function-`static` buffers, one per producer, 8192 code units each.
- `(tera_char *)(p0 + 8)` — the `name` field's **inline** text, owned by the `Series`
  object.
- `tera_alloc(1032, 6)` then `tera_str_set(v4 + 8, 512, v3)` — **string boxing**: the
  string built in `sb0` must survive until `sb1` is built at the end, so it is copied into
  a 1032-byte `tera_text` object (8 header + 1024 text = 511 characters) and read back from
  there.

Then the case the compiler cannot prove, which still refuses, reproduced verbatim:

```
$ node dist/cli.js compile /tmp/fieldstring.tera -o /tmp/fs.exe
tera compile: warning: skipped 'f' (x64-windows backend cannot emit: f keeps the string it
  read from n across a write to n, which can overwrite it; a string lives only until the
  storage behind it is written again, so use it before that point, copy it into an object
  field, or keep this part interpreted)
```

`/tmp/fieldstring.tera` is the source from
`tests/e2e/optimizing/string-ceiling.test.ts` > `"declines keeping a string read from a
field across a write to that field"`: `s = p.n`, then `p.n = "two"`, then `print(s)`.
**The refusal's advice — "copy it into an object field" — is exactly what boxing did to
`v3` above, automatically.**

## Outline

- [ ] **§ a-string-is-an-address-and-nothing-else** — Establish what has been removed.
      Parts IV and V had a string *object*: a header, a length, a hash, a
      representation tag, and a garbage collector that owned it. None of it survives. In a
      compiled tera program a `SCALAR_STRING` value is 8 bytes holding an address, the text
      is NUL-terminated code units, and the length is `strlen`. There is no tag, so
      **nothing at run time can ask a string where it lives** — which makes storage a
      compile-time question with no fallback answer.
      **`> **New idea.** Lifetime, and a dangling pointer.**
      State the consequence up front so the rest of the chapter reads as one argument:
      because the address carries no ownership, *the compiler alone* is responsible for the
      claim that the bytes are still there when they are read.
- [ ] **§ three-storage-classes** — The taxonomy, with a fixed-width ASCII table of the
      three: rodata (`static const tera_char v0[]`, immutable, program lifetime, one per
      distinct literal), a **per-producer static buffer** (`static tera_char sb<n>[]`,
      function-`static`, `DEFAULT_TEXT_BUFFER_BYTES` = 16 KB = 8192 code units by default,
      overwritten every time its producer runs), and **object-owned inline text**
      (`SCALAR_TEXT`, 1024 bytes = 511 characters, stored *inside* the object rather than
      pointed at, so it lives exactly as long as the object).
      Establish the design claim: **the storage class is chosen by the compiler and named
      in the diagnostic, never chosen by the programmer** — but it is tunable, and
      `--text-size <bytes>` (`src/cli/spec.ts`:396-405) is the one knob, reported in the
      help as a character count because that is the unit a programmer thinks in.
      Then the constant-length refusal that falls straight out:
      `string constant is longer than the <n> characters a compiled string holds; raise it
      with --text-size, or keep this part interpreted`.
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "rejects a string constant longer than the storage a compiled string has"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "accepts a string constant that fills the storage exactly"]`
      `[t: tests/optimizing/target/text-literal.test.ts > "fits one fewer character than the code units the bytes hold"]`
      `[t: tests/optimizing/target/text-literal.test.ts > "holds nothing at all when the bytes cannot carry a terminator"]`
- [ ] **§ the-scalar-that-is-not-a-value** — `SCALAR_TEXT` deserves its own section because
      it breaks the pattern chapter 56 established. It is in the `AotScalar` union, it has a
      width (1024) and an alignment (8, by the one special case in `scalarAlignment`), and
      **it has no C type and no register location**: `C_BY_SCALAR` has no entry, so
      `cTypeOf(SCALAR_TEXT)` throws `no C type for scalar text`; `LOCATIONS` has no entry,
      so `locationOf` throws `no x64 location for text`.
      Establish why that is right rather than an oversight: `SCALAR_TEXT` describes
      **storage**, not a value. `fieldScalarOf` (`class-table.ts`:484) rewrites a `string`
      field to `SCALAR_TEXT`; `defineArray` (line 600) does the same for an element. A value
      loaded out of one is `SCALAR_STRING` — an address into that storage. The C emitter
      says so directly: `emitLoadElement` for `SCALAR_TEXT` produces an *address*
      (`elementTextAddress`), not a load. See § honesty-items for what nothing checks.
      `[t: tests/optimizing/metadata/class-table.test.ts > "gives a declared string field storage of its own rather than a pointer"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "aligns text storage on the pointer width instead of its full size"]`
      `[t: tests/optimizing/target/c-types.test.ts > "names the character type after the unit the target stores text in"]`
      `[t: tests/optimizing/target/c-types.test.ts > "leaves the spelling of a string parameter the same whichever unit is chosen"]`
- [ ] **§ who-owns-and-who-borrows** — The vocabulary the proof is written in,
      `StringBufferRules` (529-…), four predicates and no more:
      **`ownsBuffer`** (`buildsString` — a string `+` or an AOT string builtin — or
      `fillsString`, a line of input) produces into a buffer;
      **`borrowsBuffer`** (`LoadText`, or a call whose summary says `returnsBuffer`) hands
      back an address into somebody else's;
      **`readsString`** consumes one without keeping it;
      **`looksUpWithString`** is the narrow exception for a record key, which is only ever
      `strcmp`'d ([Ch 57 § a-record-is-a-lookup-table]).
      Establish the ownership rule: **a buffer belongs to the producer**, and a producer is
      an IR node, not a function — which is why `sb0` and `sb1` are two buffers in one
      function.
      Then `mergedProducers` (473-506): producers whose values meet at more than one phi are
      union-found into **one** buffer, because a phi of two strings is one address and it
      must be one storage.
- [ ] **§ the-proof** — `checkStringLifetimes` (1081-1095) read line by line, because it is
      fourteen lines and it is the whole soundness argument.
      **`> **New idea.** Backwards liveness** — walk each block from its last node to its
      first, starting from `liveOut`, deleting each node as you reach its definition and
      adding its inputs. At every node you therefore hold exactly the set of values still
      live *after* it. Diagram this as a small worked trace over `Series_label`.
      Two questions are asked at each step:
      (a) `overwritesSameBuffer` (1112-1123) — is this node a producer for a buffer that
      some **other** live value also names? That is two strings in one buffer, both wanted.
      (b) `checkInvalidation` → `invalidates` (1219-1250) — does this node do something that
      could rewrite the storage a live string borrows? Four cases: a re-entrant call while a
      built string is live; more string building while a borrowed string from a re-entrant
      callee is live; a `StoreText` to the same field (`writesElsewhere` decides whether it
      really is the same one); a call whose summary says it writes text through that
      parameter or rewrites that field.
      Quote both refusal sentences verbatim, and note the shape chapter 56 catalogued:
      what the program did, why it cannot be compiled, and **three** ways out, one of which
      is always "keep this part interpreted".
      `[t: tests/e2e/optimizing/string-ceiling.test.ts > "declines keeping a string read from a field across a write to that field"]`
      `[t: tests/e2e/optimizing/string-ceiling.test.ts > "declines keeping a string read from a field across a call that writes one"]`
      `[t: tests/e2e/optimizing/string-ceiling.test.ts > "declines a string it built that is held across a call that can re-enter"]`
      `[t: tests/e2e/optimizing/string-ceiling.test.ts > "keeps a string buffer live across a call the callee cannot re-enter"]`
      `[t: tests/e2e/optimizing/string-ceiling.test.ts > "admits a returned string used before the call that rebuilds it"]`
- [ ] **§ escape-summaries-are-a-fixpoint** — The proof above asks questions about *callees*
      — does `shout` retain its argument, does `rename` rewrite `n`, can `tag` re-enter me?
      — and those are whole-program facts. `summarizeStringEscapes` (752) computes one
      `StringEscapeSummary` per function: which parameter indices are `retains`, whether it
      `returnsBuffer`, which parameters it `writesTextThrough`, whether it
      `writesReachableText`. **`> **New idea.** A fixpoint over a call graph** — retention
      propagates backwards through a forwarding caller until nothing changes.
      Establish where this is stamped: `graph.stringEscapes` is set by chapter 55's module
      pass, which is why chapter 55 named it in its handover and this chapter can just read
      it. Note the `reenters(callee, owner)` relation, which is what makes
      recursion — the hardest case — decidable at all: a function that can re-enter *itself*
      may rebuild its own buffer, so a built string cannot survive such a call.
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "does not retain a string parameter the callee copies into its own storage"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "retains a string parameter the callee stores as a pointer"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "carries retention back through a caller that only forwards the string"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "reports a function that returns a string it built as returning a buffer"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "does not report a function that returns a string constant as returning a buffer"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "names the parameter whose text a callee rewrites"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "names the field a module rewrites the text of"]`
- [ ] **§ storage-an-object-owns-privately** — The one exemption, and it is small and sharp.
      `privateStorage(origin)` (278-280) is `origin.type === IR_LOAD_TEXT &&
      holdsOwnText(origin.inputs[0])`, and `holdsOwnText` (265-276) answers yes for an
      object that is stored into **exactly once** through a text field — walking phis so a
      merge of two such objects still counts. A string borrowed from storage like that can
      never be invalidated, because nothing will ever write it again.
      Establish why this matters: it is what makes a *box* work. A `tera_text` object is
      filled once at construction, so a load out of it is exempt from every invalidation
      rule — which is the property the next section exploits.
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "owns the text of a box exactly one store fills"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "does not own the text of a box a second store refills"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "does not own the text of a box nothing fills"]`
      `[t: tests/optimizing/analyses/aot-legality.test.ts > "admits a built string copied into storage the object owns"]`
- [ ] **§ the-pass-that-takes-its-own-advice** — The chapter's thesis, landed. Every refusal
      in § the-proof ends with "copy it into an object field". `boxEscapingStrings`
      (`passes/string-boxing.ts`:247, legalization pass 402) does that copy automatically.
      Read `boxable` (138-152) as the decision, in the order it asks:
      nullable → no (an absence has no text to copy); no uses → no;
      a text element read that lives across a write to the array → yes; not a string
      producer or borrower → no; aliases its own buffer through a re-entrant callee → yes;
      **used only by `return` or `phi` → no** (returning is somebody else's problem, and a
      phi is handled by `boxWeb`); otherwise **`livesAcross(value, positions, CALLS)`** —
      does a call sit between this value's definition and its last use in the block, or does
      a use leave the block at all.
      Then `boxAt` (42-61): allocate `tera_text`, store, load, and replace every use with
      the *load*. Three instructions, and the value is now backed by heap storage nothing
      will rewrite — which § storage-an-object-owns-privately just proved is exempt.
      Establish the general rule this is the best example of in the whole book: **a
      diagnostic that names a specific remedy is a specification for a pass.** The message
      was written first; the pass came later and does what it says.
      `[t: tests/optimizing/passes/string-boxing.test.ts > "copies the string it read before the slot it came from is written"]`
      `[t: tests/optimizing/passes/string-boxing.test.ts > "leaves the read alone when nothing writes the array in between"]`
      `[t: tests/optimizing/passes/string-boxing.test.ts > "reports the read it rewrote"]`
- [ ] **§ boxing-a-whole-phi-web** — The harder half of the same pass, and worth its own
      section because it changes the *shape* of the graph rather than one value.
      `carriedWebs` (174-195) union-finds every string-valued phi that feeds another string
      phi into a **web**; `mergesStorage` (197-200) keeps only webs whose inputs from
      outside are more than one string — i.e. a merge that would force two producers into
      one buffer. `boxWeb` (202-245) then rewrites the web so the **phi carries a box, not a
      string**: each incoming non-web input is boxed at the end of its own predecessor block,
      each phi's uses are replaced by a load, and the intra-web edges are re-pointed last.
      Establish the invariant that makes the ordering matter: `boxWeb` must not read a phi
      input it has already rewritten, which is why `crossing` is collected and applied after
      the loop.
      `[t: tests/optimizing/passes/string-boxing.test.ts > "gives each incoming string its own allocation"]`
      `[t: tests/optimizing/passes/string-boxing.test.ts > "reads the carried string back out of what the phi holds"]`
      `[t: tests/optimizing/passes/string-boxing.test.ts > "leaves a phi fed by one producer and a constant alone"]`
      `[t: tests/optimizing/passes/string-boxing.test.ts > "leaves a phi alone when one arm carries no string at all"]`
      `[t: tests/e2e/optimizing/aot/string-building.test.ts > "keeps two strings built in different branches apart"]`
      `[t: tests/e2e/optimizing/aot/string-building.test.ts > "wraps words into lines, taking the line from a word or from a join"]`
- [ ] **§ what-a-character-is** — Turn to the second half of the chapter with the primer the
      rest depends on. **`> **New idea.** Code unit, code point, character** — and the
      concrete fact that makes them differ here: `"Xin chào"` is 8 code points, 9 UTF-8
      bytes, and 8 UTF-16 code units.
      Establish the decision and why it was forced: the interpreter is a JavaScript engine,
      so `.length` and `.char_code_at` answer in **UTF-16 code units**, and the AOT binary
      has to agree byte-for-byte with it — the interpreter is this road's oracle throughout,
      as the part opener states. So memory is UTF-16:
      `TEXT_UNIT_SHIFT = 1`, `TEXT_UNIT_BYTES = 2`, `tera_char` is `uint16_t`
      (`C_WIDE_TEXT_UNIT`). UTF-8 appears only at the I/O boundary, and a literal is emitted
      as code units, not bytes.
      Then the honest split: this is a **capability**, `"utf16-text"`, declared by `cTarget`
      and the x64 targets and **not by riscv64**, which is still on bytes. The same program
      compiles on one and is refused on the other — shown in § two-refusals-not-one.
      `[t: tests/optimizing/target/unicode.test.ts > "splits a supplementary code point the way the runtime stores it"]`
      `[t: tests/optimizing/target/unicode.test.ts > "joins a pair back into the code point the string spells"]`
      `[t: tests/optimizing/target/unicode.test.ts > "tells a lead unit from a trail unit by the mask alone"]`
      `[t: tests/optimizing/target/unicode.test.ts > "leaves every character that needs no pair outside the surrogate range"]`
      `[t: tests/optimizing/target/unicode.test.ts > "covers exactly the code points a pair can reach"]`
- [ ] **§ a-table-nobody-wrote-down** — `src/optimizing/target/unicode.ts` is 68 lines and
      contains **no literal UTF-8 table**. `utf8Sequence(bytes)` derives everything from two
      facts — a lead byte has `8 - bytes` free bits (or 7 for a one-byte sequence) and each
      continuation byte carries 6 — and `utf8Sequences()` grows the list with a `do…while`
      until the last entry's `limit` covers `UNICODE_LIMIT`. `ASCII_LIMIT` is then *defined*
      as `UTF8_SEQUENCES[0].limit`, not written as `128`.

      ```ts
      function utf8Sequence(bytes: number): Utf8Sequence {
        const leadBits = bytes === 1 ? UTF8_LEAD_BITS : UTF8_LEAD_BITS - bytes;
        const leadShift = UTF8_TAIL_BITS * (bytes - 1);
        return { bytes, limit: 2 ** (leadBits + leadShift), ... };
      }
      ```

      — src/optimizing/target/unicode.ts:38-52

      Establish this as the tree's clearest instance of a house rule
      (`MEMORY: no hardcoding`) paying for itself: the test does not check the table against
      a second copy of the table, it checks it against **the platform's own encoder**.
      `[t: tests/optimizing/target/unicode.test.ts > "spells every sample the way the platform encoder does"]`
      `[t: tests/optimizing/target/unicode.test.ts > "reads back the code point it spelled"]`
      `[t: tests/optimizing/target/unicode.test.ts > "picks the narrowest sequence that holds the code point"]`
      `[t: tests/optimizing/target/unicode.test.ts > "tells lead bytes apart by their marks alone"]`
      `[t: tests/optimizing/target/unicode.test.ts > "keeps continuation bytes out of the lead byte range"]`
      `[t: tests/optimizing/target/unicode.test.ts > "reaches every code point Unicode allows and no wider"]`
      `[t: tests/optimizing/target/unicode.test.ts > "marks ASCII off at the byte the platform stops spelling as one byte"]`
      `[t: tests/optimizing/target/text-literal.test.ts > "writes text outside ASCII as the UTF-8 bytes it takes"]`
      `[t: tests/optimizing/target/text-literal.test.ts > "never reaches for a hex escape, which an assembler reads as variable length"]`
- [ ] **§ where-wide-text-can-reach** — `analyses/wide-text.ts` as a whole-program taint
      analysis, and the shape is worth naming because it is the third one in this part
      (after escapes and points-to). Seeds: a constant that is not ASCII-representable, and
      `input()`, which can return anything. `wideValuesIn` (91-116) marks seeds and floods
      forward through uses. `letsTextEscape` (124-136) asks whether any wide value reaches
      `LEAVES_FOR_THE_HEAP` — a return, a field/element/global store, a call — and if so the
      **whole module's heap** is treated as possibly wide, which re-seeds
      `ENTERS_FROM_THE_HEAP` on the next round.
      **`> **New idea.** Escape, and why a conservative analysis widens on one witness.**
      `summarizeWideText` (143-158) has the cheap early exit that makes this free for most
      programs: if no unit `spellsWideText` at all, answer `NARROW_TEXT` immediately.
      `[t: tests/optimizing/analyses/wide-text.test.ts > "counts Vietnamese text as not representable"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "measures text by the bytes UTF-8 takes rather than the code units"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "carries it through the text a program builds from it"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "treats what arrives from the heap as wide once the module let some escape"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "holds no value wide when nothing in the module spells wide text"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "treats the text a program reads from outside itself as wide"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "reports no escape for wide text the program only prints"]`
- [ ] **§ two-refusals-not-one** — What the analysis is *for*: refusing the smallest possible
      set of operations. Two named sets:
      `INDEXES_CHARACTERS` (`length`, `char_at`, `char_code_at`, `slice`, `index_of`,
      `pad_start`, `pad_end`) and `MAPS_UNICODE` (`to_upper_case`, `to_lower_case`, `trim`,
      `trim_start`, `trim_end`). Everything else — printing, joining, comparing,
      `includes` — is byte-safe either way and is never refused.
      Both messages, reproduced:

      ```
      $ node dist/cli.js compile /tmp/wide2.tera -o /tmp/wide2.exe
      tera compile: ... string.to_upper_case maps characters the way Unicode says, and this
        text holds some outside ASCII; the compiled runtime carries no case or whitespace
        tables, so keep this part interpreted

      $ node dist/cli.js compile /tmp/wide.tera --emit source --target riscv64 -o /tmp/wide-rv
      tera compile: ... string.length counts characters, and this text holds some outside
        ASCII, which a compiled string stores as several bytes each; print it, join it,
        compare it or search it for a substring, or keep this part interpreted
      ```

      Establish the difference precisely, because the two refusals have different futures.
      The **second** is a *target* limitation: on x64 and C, `storesCodeUnits` is true, so
      `print(s.length)` on `"Xin chào"` compiles and answers `8` exactly as the interpreter
      does. It is quoted here from riscv64, which does not declare `"utf16-text"`. The
      **first** is a *runtime* limitation and applies everywhere: Unicode case mapping needs
      tables the binary does not carry, and no encoding choice fixes that.
      Note the `BYTEWISE_PROP` escape hatch (30, 118-122, 184): a pass that has deliberately
      taken a read in bytes — the number readers of chapter 60 — stamps it and steps outside
      this analysis entirely.
      `[t: tests/optimizing/analyses/wide-text.test.ts > "names the ones that count characters"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "leaves the ones whose answer is the same bytes either way"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "leaves a member of another owner alone"]`
      `[t: tests/optimizing/analyses/wide-text.test.ts > "stands aside for a read a pass took on purpose in bytes"]`
- [ ] **§ what-leaves** — Close on the one sentence the chapter earns: **every string
      address in the binary points into storage some pass can name, and the compiler refused
      every program where it could not.** Hand over to chapter 60 with the observation that
      opens it: `_fixed_text`, `_FixedDigits` and `_FixedText` are all over the C listing
      this chapter has been reading, they are not part of the user's program, and they are
      not written in C either.

## Honesty items

- `> **Unenforced.**` — the `SCALAR_TEXT` split. The invariant is "`SCALAR_TEXT` is a
  storage scalar and never a value's scalar", and it is what keeps
  `cTypeOf(SCALAR_TEXT)` (`src/optimizing/target/c-types.ts`:59) and
  `locationOf(SCALAR_TEXT)` (`src/optimizing/backends/x64/target.ts`:93) from ever being
  called. Nothing checks it: `isStorableScalar` filters only `SCALAR_VOID`, `AotScalar` is
  one flat union, and the guarantee is that `aotScalarOf` never returns `SCALAR_TEXT` while
  `fieldScalarOf` and `defineArray` rewrite into it. Breaking it produces a thrown
  `no C type for scalar text` reaching the user, not a type error. Cost: split `AotScalar`
  into value scalars and storage scalars — the same fix § honesty-items of chapter 56
  proposes for `SCALAR_VOID`, and the two should be done together.
- `> **Unfinished.**` — riscv64 does not declare `"utf16-text"`
  (`src/optimizing/backends/riscv64/target.ts`), so on that target every member in
  `INDEXES_CHARACTERS` refuses on any program containing one non-ASCII character, including
  `print("Xin chào".length)`, which x64 and C compile and answer correctly. The refusal is
  honest and the wording is good; the gap is real. Cost: the same code-unit work already
  done for x64 in `src/optimizing/backends/x64/`, plus riscv64's own `McTarget.encode()`,
  which throws — see [Ch 72].
- `> **Unfinished.**` — a string buffer is `DEFAULT_TEXT_BUFFER_BYTES` (16 KB) **per
  producer**, allocated as a function-`static` array whether or not that function ever runs.
  A program with forty producers carries 640 KB of BSS. Nothing sizes a buffer to what its
  producer can actually build, even where the inputs are all constants. Cost: a length
  analysis over `buildsString` inputs — the pieces exist (`characterCapacity`, constant
  folding), the pass does not.
- `> **Unenforced.**` — `bufferOf` (`src/optimizing/backends/c/emit.ts`:2006-2015) throws a
  bare `Error` — "the string vN produces has no buffer to live in" — rather than a
  `BackendLoweringError`, so it is a crash rather than a refusal. The machine backends do it
  properly: `requireStringBuffer` raises a `BackendLoweringError` naming the operation, and
  that path *is* tested. Cost: one throw site.
  `[t: tests/optimizing/machine/string-buffer-refusal.test.ts > "x64 names the concatenation it cannot place"]`
- `> **Unfinished.**` — `WideTextModel.exact` is threaded through `summarizeWideText` as a
  parameter with a default of `false` and is set from
  `backend.target.capabilities.has("utf16-text")` at `src/optimizing/drivers/aot.ts`:858.
  It is a capability answer wearing the name of a precision claim, and no test names the
  field. Cost: rename it, or give it the meaning its name implies.
- `> **Unfinished.**` — `boxable` refuses a value whose uses are all `IR_RETURN` or `IR_PHI`
  (`string-boxing.ts`:150), leaving returned strings to the caller's proof and phis to
  `boxWeb`. But `boxWeb` only fires on a web that `mergesStorage` — more than one
  string input from outside. A single-producer phi carried around a loop and returned is
  therefore neither boxed nor merged, and is refused later if anything in the loop can
  rebuild the buffer. Reachable in practice; see
  `[t: tests/e2e/optimizing/aot/string-building.test.ts > "keeps the carried string readable across enough rounds to collect"]`
  for the shape that *does* work. Cost: a real question about who owns a returned string,
  not a patch.
- `[unpinned]` — the `Series_label` boxing shown in § the worked example is exercised only
  through `tests/e2e/docs/book-examples.test.ts` running `stats.tera`; no test names the box
  in that function.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
sed -n '1349,1370p' /tmp/stats-c/stats.c
printf 'class P:\n  public constructor(n: string):\n    this.n = n\n\nfn f(p: P) -> int:\n  s = p.n\n  p.n = "two"\n  print(s)\n  return 0\n\nprint(f(P("one")))\n' > /tmp/fieldstring.tera
printf 's = "Xin ch\\303\\240o"\nprint(s)\nprint(s.length)\n' > /tmp/wide.tera
printf 's = "Xin ch\\303\\240o"\nprint(s.to_upper_case())\n' > /tmp/wide2.tera
node dist/cli.js compile /tmp/fieldstring.tera -o /tmp/fs.exe
node dist/cli.js compile /tmp/wide2.tera -o /tmp/wide2.exe
node dist/cli.js compile /tmp/wide.tera --emit source --target riscv64 -o /tmp/wide-rv
npx vitest run --project unit tests/optimizing/passes/string-boxing.test.ts tests/optimizing/analyses/wide-text.test.ts tests/optimizing/target/unicode.test.ts tests/optimizing/target/text-literal.test.ts tests/optimizing/machine/string-buffer-refusal.test.ts
```

The three `printf`s write the programs quoted in § the-proof and
§ two-refusals-not-one; `\303\240` is the UTF-8 for `à`, written as octal escapes so the
line survives a shell that would otherwise mangle it. None of the three belongs in
`docs/example/` — none is an edit to `stats.tera` — so under `docs/CONVENTIONS.md` rule 2
this chapter states in its opener that the running example cannot reach a *refused* string
lifetime or any non-ASCII text, and uses named scratch programs for those two beats only.
`fieldstring.tera` is the source of
`tests/e2e/optimizing/string-ceiling.test.ts` > `"declines keeping a string read from a
field across a write to that field"`, so it cannot rot silently.

## Tests that pin this

- `tests/optimizing/analyses/aot-legality.test.ts` > `"rejects a string constant longer than the storage a compiled string has"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"accepts a string constant that fills the storage exactly"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"accepts a string constant outside ASCII"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"gives a string constant outside ASCII the same room as an ASCII one"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"rejects storing text into an array of numbers"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"admits a built string copied into storage the object owns"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"rejects a built string stored as a pointer and names what to do instead"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"says a built string is held without naming the operation that held it"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the callee a built string is handed to"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"does not retain a string parameter the callee copies into its own storage"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"retains a string parameter the callee stores as a pointer"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"carries retention back through a caller that only forwards the string"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"reports a function that returns a string it built as returning a buffer"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"does not report a function that returns a string constant as returning a buffer"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the parameter whose text a callee rewrites"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names no parameter for a callee that only writes text it allocated itself"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the field a module rewrites the text of"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"admits a constant that fits the storage the field holds"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"rejects a constant one character past what the field holds"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"names the field a too-long constant would not fit"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"says nothing about --text-size for a store the field bounds"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"owns the text of a box exactly one store fills"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"does not own the text of a box a second store refills"`
- `tests/optimizing/analyses/aot-legality.test.ts` > `"does not own the text of a box nothing fills"`
- `tests/optimizing/passes/string-boxing.test.ts` > `"gives each incoming string its own allocation"`
- `tests/optimizing/passes/string-boxing.test.ts` > `"reads the carried string back out of what the phi holds"`
- `tests/optimizing/passes/string-boxing.test.ts` > `"reports the web it rewrote"`
- `tests/optimizing/passes/string-boxing.test.ts` > `"leaves a phi fed by one producer and a constant alone"`
- `tests/optimizing/passes/string-boxing.test.ts` > `"leaves a phi alone when one arm carries no string at all"`
- `tests/optimizing/passes/string-boxing.test.ts` > `"copies the string it read before the slot it came from is written"`
- `tests/optimizing/passes/string-boxing.test.ts` > `"reports the read it rewrote"`
- `tests/optimizing/passes/string-boxing.test.ts` > `"leaves the read alone when nothing writes the array in between"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"counts plain ASCII as representable"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"counts Vietnamese text as not representable"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"counts an emoji as not representable"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"measures text by the bytes UTF-8 takes rather than the code units"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"finds the constant that spells it"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"leaves a constant that stays inside ASCII narrow"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"carries it through the text a program builds from it"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"leaves what a program builds from ASCII alone narrow"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"treats what arrives from the heap as wide once the module let some escape"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"treats a text parameter as wide once the module let some escape"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"holds no value wide when nothing in the module spells wide text"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"reports an escape once wide text is stored where the analysis cannot follow"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"treats the text a program reads from outside itself as wide"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"leaves a module that only prints what it read narrow on the heap"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"reports no escape for wide text the program only prints"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"names the ones that count characters"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"leaves the ones whose answer is the same bytes either way"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"leaves a member of another owner alone"`
- `tests/optimizing/analyses/wide-text.test.ts` > `"stands aside for a read a pass took on purpose in bytes"`
- `tests/optimizing/target/unicode.test.ts` > `"spells every sample the way the platform encoder does"`
- `tests/optimizing/target/unicode.test.ts` > `"reads back the code point it spelled"`
- `tests/optimizing/target/unicode.test.ts` > `"picks the narrowest sequence that holds the code point"`
- `tests/optimizing/target/unicode.test.ts` > `"tells lead bytes apart by their marks alone"`
- `tests/optimizing/target/unicode.test.ts` > `"keeps continuation bytes out of the lead byte range"`
- `tests/optimizing/target/unicode.test.ts` > `"reaches every code point Unicode allows and no wider"`
- `tests/optimizing/target/unicode.test.ts` > `"marks ASCII off at the byte the platform stops spelling as one byte"`
- `tests/optimizing/target/unicode.test.ts` > `"splits a supplementary code point the way the runtime stores it"`
- `tests/optimizing/target/unicode.test.ts` > `"joins a pair back into the code point the string spells"`
- `tests/optimizing/target/unicode.test.ts` > `"tells a lead unit from a trail unit by the mask alone"`
- `tests/optimizing/target/unicode.test.ts` > `"leaves every character that needs no pair outside the surrogate range"`
- `tests/optimizing/target/unicode.test.ts` > `"covers exactly the code points a pair can reach"`
- `tests/optimizing/target/text-literal.test.ts` > `"writes text outside ASCII as the UTF-8 bytes it takes"`
- `tests/optimizing/target/text-literal.test.ts` > `"writes a character above the basic plane as all four of its bytes"`
- `tests/optimizing/target/text-literal.test.ts` > `"pads every escape to three digits so a following digit is not absorbed"`
- `tests/optimizing/target/text-literal.test.ts` > `"never reaches for a hex escape, which an assembler reads as variable length"`
- `tests/optimizing/target/text-literal.test.ts` > `"fits one fewer character than the code units the bytes hold"`
- `tests/optimizing/target/text-literal.test.ts` > `"answers exactly the text that spells back into those bytes"`
- `tests/optimizing/target/text-literal.test.ts` > `"holds nothing at all when the bytes cannot carry a terminator"`
- `tests/optimizing/target/c-types.test.ts` > `"names the character type after the unit the target stores text in"`
- `tests/optimizing/target/c-types.test.ts` > `"leaves the spelling of a string parameter the same whichever unit is chosen"`
- `tests/optimizing/target/c-types.test.ts` > `"guards both typedefs so a header included twice declares them once"`
- `tests/optimizing/machine/string-buffer-refusal.test.ts` > `"x64 names the concatenation it cannot place"`
- `tests/optimizing/machine/string-buffer-refusal.test.ts` > `"riscv64 names the concatenation it cannot place"`
- `tests/optimizing/machine/string-buffer-refusal.test.ts` > `"x64 names the builtin it cannot place"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits concatenation, rendering and indexing of strings"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits an array of spelled-out strings because they live in read-only data"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits an array of strings the program builds, because elements hold text"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"declines prepending an accumulator to itself"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits building a string after a call has already returned"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"keeps a string buffer live across a call the callee cannot re-enter"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits string building in a function that can re-enter itself"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"declines a string it built that is held across a call that can re-enter"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits a line of input copied into a field the object owns"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits a built string copied into a field the object owns"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"keeps two returned strings alive at once by copying each into storage of its own"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits a returned string used before the call that rebuilds it"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"keeps a string a wrapper returned across a call that rebuilds the buffer behind it"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"declines keeping a string read from a field across a write to that field"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"declines keeping a string read from a field across a call that writes one"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits copying one field of owned text into another"`
- `tests/e2e/optimizing/string-ceiling.test.ts` > `"admits a returned string kept across a call that cannot rebuild it"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"appends a different piece per branch inside a loop"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"builds an inner string per row and joins the rows"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"keeps two strings built in different branches apart"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"keeps a string a later pass of the same loop would overwrite"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"wraps words into lines, taking the line from a word or from a join"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"keeps the carried string readable across enough rounds to collect"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"formats a number in the same statement that reads a field"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"reads one field while another field of the same object is written"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"keeps a field string in an array when nothing ever rewrites that field"`
- `tests/e2e/optimizing/aot/string-building.test.ts` > `"carries an awaited string into a second await"`
