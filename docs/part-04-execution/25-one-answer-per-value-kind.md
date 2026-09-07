# 25. One Answer Per Value Kind   ⟨I · B · J · ~~N~~⟩ (N mirrors the names only)

> **Status:** outline

**Thesis.** Three tiers each resolving `x.length` their own way will eventually disagree;
one dense tag-code table makes disagreement impossible — and the answer type has three
cases, not two.

**What arrived.** From [Ch 24 § property-access]: a resolved property value for a
*`JSObject`* receiver, produced by the accessor / exotic-hook / visibility / inline-cache
sequence, plus a filled `FeedbackSlot` carrying `(mapId, version, offset, protoDepth)`.
Chapter 24 answered `this.values` — an object with a hidden class. It did not answer
`values.length`, because an array is not a `JSObject` and has no hidden class to cache
against. Every receiver that is *not* an object arrives here unresolved.

**What leaves.** A single resolution function, `memberLookupValue(receiver, propName,
interpreter)`, with a three-valued contract — `null`, a `TaggedValue`, or `mkUndefined()`
— that all of tier 0, tier 1 and (via `getRuntimeProperty`) tier 2 route through. Chapter
26 receives it and asks the next question: what happens when the member name is not a
name at all but a *subscript* — `a[i]`, `a[-1]`, `a[1:3]` — and what the receivers are
that opt out of this table entirely.

**New ideas.** *Jump table / dispatch table* (an array indexed by a small integer instead
of a chain of `if`s, and why density matters). *Three-valued return* — the difference
between "absent" and "not mine to answer", and why a language with `undefined` cannot
encode both in one sentinel. *Single source of truth* as a correctness technique rather
than a tidiness one.

**Length.** 10 pages

## Anchors

- `src/runtime/member-lookup.ts` — the whole chapter in 159 lines. `MemberLookup` (the
  function type, `:52-56`), the eight lookup closures `arrayMember` `:75-86`,
  `stringMember` `:88-97`, `regexMember` `:99-103`, `generatorMember` `:105-110`,
  `promiseMember` `:112-117`, `functionMember` `:119-122`, `numberMember` `:124-125`,
  `booleanMember` `:127-128`; `lookupTable()` `:130-137` building the dense array;
  `MEMBER_LOOKUPS` `:139-150` with its ten entries; `memberLookupValue` `:152-159`.
  Also `builtinPrototypeMember` `:58-68` (the decline-when-no-interpreter path) and
  `elementIndex` `:70-73`.
- `src/runtime/member-lookup.ts:38-50` — `BuiltinPrototypeSet`, the five-name union
  `BuiltinPrototypeName`, and `MemberLookupInterpreter`: the *entire* interface the table
  demands of its caller is `builtinPrototypes` plus `_lookupBuiltinPrototype`.
- `src/bytecode/register/interpreter/handlers.ts:286` — call site one, inside
  `handleLdaProp`, reached only after the `isObject` branch has returned. `:426` is the
  same call for a computed string key on a string receiver. `:95` re-declares
  `_lookupBuiltinPrototype` on `InterpreterLike`.
- `src/optimizing/baseline/runtime.ts:338` — call site two, in the baseline runtime's
  `gp`; `:84` declares the same interpreter obligation. `:470` shows the one place the
  baseline still *bypasses* the table and calls `_lookupBuiltinPrototype` directly
  (keyed string access), duplicating `stringMember`'s length/index arithmetic.
- `src/runtime/value-semantics.ts:41-50` — `getRuntimeProperty`: call site three, the
  generic one. Table first, `proxyRuntimeGetProperty` second. This is the function the
  JIT reaches (`src/optimizing/backends/wasm/runtime-support.ts:444, 469, 518, 754,
  1158`) and the one deoptimization uses while rebuilding a frame
  (`src/deopt/frame-materializer.ts:153`).
- `src/bytecode/register/interpreter/index.ts:738-747` — `_lookupBuiltinPrototype`, the
  one implementation of "walk a builtin prototype and its chain", which every table entry
  borrows rather than reimplements.
- `src/objects/exotic/function-members.ts:112-138` — `functionMemberValue`, which returns
  `null` for "no such member"; `functionMember` in the table converts that to
  `mkUndefined()`. The conversion is the contract being enforced at the boundary.
- `src/bytecode/register/interpreter/generator-members.ts:22-31` —
  `asGeneratorMemberInterpreter`: a structural probe (`runFrame` is a function,
  `suspendedFrames` is a `Map`) rather than a type test. Same shape in
  `promise-members.ts`.
- `src/optimizing/metadata/builtin-methods.ts:33+` — `BUILTIN_METHOD_DECLARATIONS`, the
  AOT side. Twenty entries, owners `string` (18), `int` (1), `float` (1) — names only, no
  implementation shared with the table above. `builtinOwnerMember`
  (`src/optimizing/types/declared.ts:165-182`) is how the compiler reads it.
- `src/runtime/intrinsics/prototypes.ts:25` — `camelToSnake` at prototype-population
  time: the reason `stringPrototype` holds `to_upper_case` and the table's callers never
  see a camelCase name.

## Worked example

`docs/example/stats.tera`, method `mean`. Its bytecode contains two adjacent property
loads that leave the engine by two different doors:

```
     8  LdaNamedProperty r4 [1] (values) r0     <- Ch 24: JSObject, hidden class, IC
    10  LdaNamedProperty r3 [2] (length) r1     <- Ch 25: CODE_ARRAY, arrayMember
```

Then the four-tier agreement test, which is the chapter's real proof: every value kind in
the table read from inside a loop hot enough to reach baseline, JIT, OSR and production,
each compared against the interpreter's answer.

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
npx vitest run --project e2e tests/e2e/optimizing/member-lookup-tiers.test.ts
```

## Outline

- [ ] **The bug this table does not have.** Open on the shape of the alternative: three
  tiers, three `if (isArray(x) && name === "length")` chains, and a fix landing in one of
  them. Establish that the failure mode is *silent divergence*, not a crash, and that the
  book's oracle ([Part IV opener], `differential`) is what would eventually catch it —
  eventually.
- [ ] **Why the obvious design fails.** Stage the obvious design — a `switch` on the
  runtime type, written once per tier because each tier has its own calling shape — and
  show what breaks it: the baseline and the JIT do not have an interpreter frame to hand,
  so a shared `switch` that assumes one cannot be shared. Establish the actual solution:
  make the interpreter an *optional, structurally-probed* parameter
  (`MemberLookupInterpreter | null`) instead of a dependency.
- [ ] **> New idea: a jump table.** Establish `lookupTable()`
  (`member-lookup.ts:130-137`): entries are `[tagCode, fn]` pairs, the array is sized to
  the widest code and filled with `undefined`, and lookup is one index. Tie it back to
  the four-bit type codes from [Ch 22 § tagged-values] — the codes are dense and small
  *because* tables like this one index by them. Note the ten entries and the six holes.
- [ ] **The three-answer contract.** The core section. Establish each case with the code
  that produces it and the test that pins it:
  - `null` = "not my kind — you resolve it". Produced by the `lookup === undefined`
    branch, i.e. plain objects, `null`, `undefined`, and any code not in the table.
  - a `TaggedValue` = "here it is".
  - `mkUndefined()` = "mine, and genuinely absent" — `arrayMember`'s out-of-range index,
    `stringMember`'s out-of-range character, `functionMember`'s not-a-member.
  Establish that collapsing three onto two is wrong in *both* directions: fold `null` into
  `mkUndefined()` and a plain object's real property becomes `undefined`; fold
  `mkUndefined()` into `null` and `a[99]` falls through to the proxy/object path that
  cannot answer for an array.
- [ ] **Own members are answered without an interpreter.** Establish the split inside each
  entry: `length`, an integer index, a regex `source` — all answered from the payload
  alone; only a *prototype* member needs `builtinPrototypes`. This is what makes the table
  callable from the baseline and from a materializing deoptimizer, neither of which is an
  interpreter. Pin with the two `null`-interpreter tests.
- [ ] **Declining when no prototype is available.** `builtinPrototypeMember` returns
  `null` — not `undefined` — when the interpreter is absent or carries no
  `builtinPrototypes`. Establish why this is the *third* answer being used honestly:
  "I cannot reach the prototype" is not "the member is absent".
- [ ] **The coroutine exception.** `generatorMember` and `promiseMember` answer
  `mkUndefined()` — not `null` — when their structural probe fails. Establish why they
  differ from the prototype-backed kinds: there is no prototype object to fall back to, so
  declining would push the receiver onto a path that cannot handle it either. This is the
  one asymmetry in the table and it has its own test.
- [ ] **Three call sites, and a fourth that came for free.** Walk the interpreter handler
  (after `isObject`, so an object never reaches the table), the baseline runtime's `gp`,
  and `getRuntimeProperty`. Establish that the JIT never calls the table directly — it
  calls `getRuntimeProperty` from `runtime-support.ts` — and that
  `deopt/frame-materializer.ts:153` inherits correct member semantics without knowing the
  table exists.
- [ ] **Where the table is still bypassed.** `baseline/runtime.ts:455-472`: computed
  string-key access re-derives `length`, the integer-index character, and the prototype
  call by hand instead of calling `stringMember`. Establish this as a live duplication —
  it currently agrees, and nothing enforces that it keeps agreeing.
- [ ] **The fourth tier mirrors names, not code.** Establish the asymmetry the part opener
  promised: AOT has no `TaggedValue` and no tag codes, so it cannot index this table. It
  carries `BUILTIN_METHOD_DECLARATIONS` — the same *spellings*, with types and a purity
  flag, and a completely separate implementation per backend. Name the consequence for
  [Ch 28 § builtins] and for the refusals in Part IX: the table guarantees the three
  in-process tiers agree; nothing structural guarantees the fourth does, only tests.
- [ ] **Snake case is upstream.** One paragraph: `camelToSnake` runs when prototypes are
  *populated*, so by the time this table asks for `propName` the name is already
  `to_upper_case`. The table has no naming policy of its own.
- [ ] **What leaves.** State the contract as it will be used for the rest of the book, and
  hand chapter 26 the receivers this table refuses: the objects with subscripts, the
  classes, and the exotics.

## Honesty items

- [ ] > **Unenforced.** Nothing checks that the six unassigned slots in `MEMBER_LOOKUPS`
  are exactly the kinds whose callers resolve them (`CODE_OBJECT`, `CODE_NULL`,
  `CODE_UNDEFINED`, …). `lookupTable` fills holes with `undefined` and
  `memberLookupValue` reads that as "decline"; adding a new tag code silently gets the
  decline path. Enforcing it would cost a `satisfies`-style exhaustiveness constraint over
  the code space in `src/runtime/member-lookup.ts:139-150`.
- [ ] > **Unenforced.** The three-answer contract is a convention, not a type: the return
  type is `TaggedValue | null` and `mkUndefined()` is an ordinary `TaggedValue`. A new
  entry that returns `mkUndefined()` where it should return `null` type-checks. Only
  `tests/runtime/member-lookup.test.ts` distinguishes the cases.
- [ ] > **Unfinished.** `src/optimizing/baseline/runtime.ts:455-472` duplicates
  `stringMember`'s own-member arithmetic instead of calling `memberLookupValue`. Finishing
  it means routing the keyed-string path through the table, which needs `elementIndex`'s
  `Number(propName)` semantics to match the baseline's `isSmi(index)` fast path first.
- [ ] > **Unenforced.** `asGeneratorMemberInterpreter` /
  `asPromiseMemberInterpreter` decide "is this an interpreter" by probing for `runFrame`
  and a `suspendedFrames` `Map`. Any object with those two members passes; the test file
  itself relies on that (`tests/runtime/member-lookup.test.ts:72-75`).
- [ ] Not an honesty marker, a naming note per [Conventions § 4]: `_lookupBuiltinPrototype`
  carries a leading underscore and is nonetheless part of the *public* contract between
  the table and all three of its callers — it appears in three separate interface
  declarations (`handlers.ts:95`, `baseline/runtime.ts:84`,
  `wasm/runtime-support.ts:143`).

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera | grep -n LdaNamedProperty
npx vitest run --project unit tests/runtime/member-lookup.test.ts
npx vitest run --project e2e tests/e2e/optimizing/member-lookup-tiers.test.ts
grep -rn "memberLookupValue" src/ --include=*.ts
grep -c 'owner:' src/optimizing/metadata/builtin-methods.ts
```

## Tests that pin this

- `tests/runtime/member-lookup.test.ts` > "the member lookup registry" — nine tests, one
  per clause of the contract:
  - "routes each prototype-backed value kind to its own prototype" (the table *is* the
    routing: array→array, string→string, regex→regex, smi *and* double→number,
    bool→boolean)
  - "answers a value kind's own members without consulting a prototype" (asserts
    `consulted` is empty — the interpreter is never touched)
  - "resolves a promise member through the registry"
  - "resolves a generator member through the registry"
  - "resolves a function member through the registry"
  - "declines the kinds its callers resolve themselves" (the `null` answer: object, null,
    undefined)
  - "declines a prototype member when no interpreter can supply prototypes"
  - "still answers own members when no interpreter is available"
  - "answers undefined rather than declining when a coroutine member cannot settle" (the
    one documented asymmetry)
- `tests/e2e/optimizing/member-lookup-tiers.test.ts` > "reading a member of every value
  kind once the reader leaves the interpreter" — sixteen tests, each run through
  `differential(..., { tiers: ["baseline", "jit", "osr", "production"] })` against the
  interpreter oracle. Notably "reads an array's own length", "reads a string method off
  the string prototype", "reads a number method off the number prototype", "reads a
  function's own arity", "reads then off a promise", "reads next off a generator", "reads
  a member of an object literal" (the `null`-decline path), and "answers undefined for a
  member no value kind provides".
- `tests/e2e/optimizing/member-access.test.ts` > "computed string-key access matches dot
  access on a string" > "reads length, a character, and a method via a computed key" and
  "resolves computed string keys on a hot (compiled) call" — these pin the bypassed
  baseline path at `runtime.ts:455-472`.
- `tests/e2e/optimizing/member-access.test.ts` > "function member access agrees across
  every tier when hot" > "reads .length (arity) and .name, including on a returned
  closure" and "keeps a user-set own property winning over a builtin member".
- `tests/e2e/optimizing/generator-members-tiers.test.ts` > "members of a receiver the
  compiled lookup has to branch for" > "advances an iterator made inside the hot
  function", "reads a regex member from compiled code".
