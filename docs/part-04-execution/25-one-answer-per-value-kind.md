# 25. One Answer Per Value Kind   ⟨I · B · J · ~~N~~⟩ (N mirrors the names only)

Three machines run inside this process. The interpreter reads bytecode. The baseline
compiler emits JavaScript and calls back into a runtime object. The optimizing JIT emits
WebAssembly and calls back into a different runtime object. All three of them, several
times per loop iteration, have to answer the question *what is `values.length`* — and
`values` is an array, which is not a `JSObject`, has no hidden class, and therefore cannot
be answered by anything Chapter 24 built.

The obvious way to close that gap is for each tier to answer it where the gap appears.
That is three implementations of the same arithmetic, and three implementations of the same
arithmetic is a slow-motion bug: not a crash, but a divergence, discovered months later by
a differential test that happened to put the right value in the right loop. tera instead
puts the whole of it in one 159-line file with one exported function. `MEMBER_LOOKUPS` in
`src/runtime/member-lookup.ts` is a dense array indexed by a value's four-bit tag code, and
`memberLookupValue(receiver, propName, interpreter)` is one array index followed by one
call. Every non-object receiver in every in-process tier goes through it.

The interesting part is not the table. It is the table's return type, which has **three**
cases where a reader expects two. A lookup can say "here it is", it can say "that member is
genuinely absent", and it can say "not my kind — you resolve it". Collapsing those three
onto two is wrong in both directions, and the chapter spends its middle on why.

**What arrived.** From [Ch 24 § property-access-what-one-access-leaves-behind]: a resolved property value for a
`JSObject` receiver, produced by the fixed nullish → accessor → exotic-hook → visibility →
inline-cache → prototype-walk sequence, together with a filled `FeedbackSlot` carrying
`(mapId, version, offset, protoDepth)` and a warm `InlineCache` entry under the site key
`funcName#fnId:slot`. Chapter 24 answered `this.values` — an object with a hidden class.
It did not answer `values.length`, because a `JSArray` is not a `JSObject` and has no
hidden class to cache against. What also arrived was the second half of Chapter 24's
handover: for every receiver that is *not* a `JSObject` — an array, a string, a number, a
function, a promise, a generator, a regex — a single unresolved call sitting at the bottom
of `handleLdaProp` with nothing behind it. This chapter is what is behind it.

## The bug this table does not have

Take the bug seriously before taking the fix seriously. Suppose each tier answered
`x.length` where it noticed the receiver was not an object. The interpreter would grow a
branch in `handleLdaProp`; the baseline runtime would grow one in its `gp` method; the
wasm runtime-support layer would grow a third. Each would be five lines, each obviously
correct, each written on a different day.

Now suppose someone fixes one of them — say, an array's *own* named properties should win
over the array prototype's, so `a.map = 1; a.map` answers `1` and not the builtin. The fix
lands in the interpreter's branch, because that is the branch the failing test exercised.
The baseline and the JIT keep the old behaviour.

Nothing crashes. There is no exception, no assertion, no refusal. A program that ran cold
prints one thing and the same program run four hundred times prints another, and it prints
the *second* thing only after the tiering policy decides the function is hot — which
depends on `DEFAULT_TIERING_POLICY`'s thresholds, which depend on how many times the
enclosing loop ran, which depends on the input. The failure mode is silent divergence with
an input-dependent trigger.

The book's instrument for catching exactly this is `differential()` in
`tests/helpers/tiers.ts`: run a program under the oracle configuration (thresholds set to
`1e12`, so nothing ever compiles), then under `baseline`, `jit`, `osr` and `production`,
and assert all five answers are equal. Part IV's opener promises that instrument as the
first of the three artifacts this stage produces. It works, and
`tests/e2e/optimizing/member-lookup-tiers.test.ts` uses it sixteen times. But it only
catches a divergence that someone thought to write a program for. A shared table catches
the divergence by making it unrepresentable — there is nowhere for the second
implementation to live.

That is the claim to hold on to: this is a *correctness* technique wearing the clothes of a
tidiness technique. A single source of truth is not primarily about having less code.

## Why the obvious design fails

The obvious shared implementation is one function with a `switch` on the runtime type,
exported from a common module and called from all three tiers. It fails immediately, and
the reason is worth stating precisely, because the fix is the whole shape of this file.

Resolving `"slice"` on a string does not stop at the string. The string's own members are
`length` and its integer-indexed characters; everything else — `slice`, `to_upper_case`,
`trim` — lives on `stringPrototype`, a `JSObject` built at engine startup by
`createBuiltinPrototypes()`. Walking that object and its prototype chain is the
interpreter's `_lookupBuiltinPrototype` (`src/bytecode/register/interpreter/index.ts:738-747`).
So the shared `switch` needs an interpreter.

The baseline runtime has one — it holds `this.interp`. The deoptimizer, rebuilding an
interpreter frame from a frame state, is *in the middle of constructing* the thing it would
have to pass. And a unit test that wants to check `mkArray([...]).length` has no engine at
all. A shared helper that demands an interpreter is not shared; it is the interpreter's
helper that two other places happen to be able to call.

tera's answer is to make the interpreter an *optional parameter that is structurally
probed*, not a dependency. The whole of what the table demands of its caller is two members:

```typescript
export type MemberLookupInterpreter = ProxyInterpreterLike & {
  builtinPrototypes?: BuiltinPrototypeSet;
  _lookupBuiltinPrototype(proto: JSObject, propName: string): TaggedValue;
};

type MemberLookup = (
  receiver: TaggedValue,
  propName: string,
  interpreter: MemberLookupInterpreter | null,
) => TaggedValue | null;
```
— `src/runtime/member-lookup.ts:47-56`

Note the `?` on `builtinPrototypes` and the `| null` on the parameter. Both are load
bearing. A caller with no interpreter passes `null`, still gets every own member answered,
and gets an honest decline for anything that would have needed a prototype. That is what
makes the table callable from the baseline, from a materializing deoptimizer, and from a
test file that constructs a fake interpreter out of an object literal.

> **New idea.** *Structural probe.* A type test asks "is this an instance of class C". A
> structural probe asks "does this object have the members I am about to use". TypeScript's
> types are erased at run time, so a structural probe is the only kind available inside a
> function that was handed an `unknown`. It is weaker — anything with the right members
> passes — and this chapter's last honesty item is about exactly that weakness.

## MEMBER_LOOKUPS: a jump table

[Ch 22 § tagged-values] established that every runtime value in this process is a
JavaScript number carrying a four-bit type code in its low nibble, and that the codes are
small consecutive integers: `CODE_SMI = 0`, `CODE_FALSE = 1`, `CODE_TRUE = 2`,
`CODE_UNDEFINED = 3`, `CODE_NULL = 4`, `CODE_DOUBLE = 5`, `CODE_STRING = 6`,
`CODE_OBJECT = 7`, `CODE_FUNCTION = 8`, `CODE_ARRAY = 9`, `CODE_PROMISE = 10`,
`CODE_ITERATOR = 11`, `CODE_GENERATOR = 12`, `CODE_REGEX = 13`, `CODE_SYMBOL = 14`
(`src/core/value/index.ts:48-63`). This chapter is one of the reasons they are dense.

> **New idea.** *Jump table.* A chain of `if (isArray(x)) … else if (isString(x)) …` costs
> one comparison per kind you skip, and — more importantly for a book about keeping four
> machines in agreement — the *order* of the chain is a fact a reader has to hold in their
> head. A jump table replaces the chain with an array whose index is the thing you were
> testing. Density matters: if the codes were `0x1000`, `0x2000`, `0x4000` you would need a
> hash map or a sparse switch, and the "one index" property would be gone.

The table is built by a five-line helper:

```typescript
function lookupTable(
  entries: ReadonlyArray<readonly [number, MemberLookup]>,
): ReadonlyArray<MemberLookup | undefined> {
  const widest = entries.reduce((code, entry) => Math.max(code, entry[0]), 0);
  const table = new Array<MemberLookup | undefined>(widest + 1).fill(undefined);
  for (const [code, lookup] of entries) table[code] = lookup;
  return table;
}
```
— `src/runtime/member-lookup.ts:130-137`

and filled from ten `[code, closure]` pairs:

```typescript
const MEMBER_LOOKUPS = lookupTable([
  [CODE_ARRAY, arrayMember],
  [CODE_STRING, stringMember],
  [CODE_REGEX, regexMember],
  [CODE_GENERATOR, generatorMember],
  [CODE_PROMISE, promiseMember],
  [CODE_FUNCTION, functionMember],
  [CODE_SMI, numberMember],
  [CODE_DOUBLE, numberMember],
  [CODE_TRUE, booleanMember],
  [CODE_FALSE, booleanMember],
]);
```
— `src/runtime/member-lookup.ts:139-150`

Ten entries; eight distinct closures, because `CODE_SMI` and `CODE_DOUBLE` share
`numberMember` and `CODE_TRUE` and `CODE_FALSE` share `booleanMember`. The widest code
present is `CODE_REGEX = 13`, so the array has fourteen slots and four of them are holes:
`CODE_UNDEFINED`, `CODE_NULL`, `CODE_OBJECT` and `CODE_ITERATOR`. `CODE_SYMBOL = 14` is not
a hole — it is past the end of the array entirely, and reading index 14 of a fourteen-slot
array yields `undefined` for the same reason a hole does.

And the whole dispatch:

```typescript
export function memberLookupValue(
  receiver: TaggedValue,
  propName: string,
  interpreter: MemberLookupInterpreter | null = null,
): TaggedValue | null {
  const lookup = MEMBER_LOOKUPS[codeOf(receiver)];
  return lookup === undefined ? null : lookup(receiver, propName, interpreter);
}
```
— `src/runtime/member-lookup.ts:152-159`

One index, one `undefined` test, one call.

> **Unenforced.** Nothing checks that the four holes plus `CODE_SYMBOL` are exactly the
> kinds whose callers resolve them. `lookupTable` fills the gaps with `undefined` and
> `memberLookupValue` reads `undefined` as "decline", so a new tag code added to
> `src/core/value/index.ts` silently inherits the decline path — which is the *safe*
> default only as long as every caller has a fallback that can handle the new kind.
> Enforcing it would cost an exhaustiveness constraint over the code space at
> `src/runtime/member-lookup.ts:139-150` — a `satisfies`-style assertion that the union of
> filled codes and a hand-written `RESOLVED_BY_CALLER` set covers `0..CODE_MAX`.

## The three-answer contract

`memberLookupValue` returns `TaggedValue | null`. Read as a two-valued type — "a value, or
nothing" — it is wrong. Read correctly, it has three cases, and the third is a
`TaggedValue` that happens to be `mkUndefined()`.

| answer | means | produced by |
| --- | --- | --- |
| `null` | *not my kind — you resolve it* | the `lookup === undefined` branch: object, `null`, `undefined`, iterator, symbol — and `builtinPrototypeMember` when it has no interpreter |
| a `TaggedValue` | *here it is* | every entry's success path |
| `mkUndefined()` | *mine, and genuinely absent* | `arrayMember`'s out-of-range index, `stringMember`'s out-of-range character, `functionMember`'s not-a-member, and the two coroutine entries' failed probe |

> **New idea.** *Three-valued return.* A language with `undefined` in it cannot use
> `undefined` to mean both "the member is absent" and "I am not the one who answers". They
> are different claims with different consequences, and any encoding that flattens them
> loses a decision the caller needs to make. tera spends the `null` value on the second
> claim and keeps `undefined` — an ordinary tagged value in this engine, `mkUndefined()` —
> for the first.

Collapsing the three onto two is wrong in *both* directions, and it is worth walking each.

**Fold `null` into `mkUndefined()`** — that is, make the table answer `undefined` for a
plain object instead of declining — and a `JSObject`'s real properties disappear. The
interpreter's `handleLdaProp` returns `member !== null ? member : mkUndefined()`, so a
decline and an absent member are indistinguishable *at that call site*; but
`getRuntimeProperty` (`src/runtime/value-semantics.ts:41-50`) does something different with
them, and it is the generic entry point the JIT uses. A decline there falls through to
`proxyRuntimeGetProperty`, which is what actually reads an object's slots and runs a proxy
trap. Turn the decline into `undefined` and every property read on every object through
that door answers `undefined`.

**Fold `mkUndefined()` into `null`** — make an out-of-range array index decline instead of
answering absent — and `a[99]` on a hundred-element-short array falls through to
`proxyRuntimeGetProperty` with an *array* receiver. That path exists to read object slots
and dispatch proxy traps. It has no idea what an array's element storage is. The answer
would be wrong, or an exception, depending on what the fallback happens to do with a
receiver it was never designed for.

So the third case is not decoration. Both directions of collapse produce a wrong answer for
an ordinary program.

> **Unenforced.** The three-answer contract is a convention, not a type. The declared
> return type is `TaggedValue | null`, and `mkUndefined()` is an ordinary `TaggedValue`, so
> a new table entry that returns `mkUndefined()` where it should return `null` type-checks
> and compiles. The only thing in the tree that distinguishes the cases is
> `tests/runtime/member-lookup.test.ts`. Making it a type would cost a branded return —
> `{ kind: "declined" } | { kind: "value"; value: TaggedValue }` — and an unwrap at all
> three call sites, in exchange for the compiler catching a class of bug that currently
> only a test can catch.

## Own members are answered without an interpreter

Every entry in the table is split the same way: answer from the receiver's payload if you
can, and only reach for a prototype if you cannot. `arrayMember` is the clearest case.

```typescript
const arrayMember: MemberLookup = (receiver, propName, interpreter) => {
  const array = getPayload(receiver as ArrayValue);
  if (propName === "length") return mkSmi(array.getLength());
  const index = elementIndex(propName);
  if (index !== null) {
    const element = array.getIndex(index);
    return element !== undefined ? element : mkUndefined();
  }
  const own = array.getProperty(propName);
  if (own !== undefined) return own;
  return builtinPrototypeMember(interpreter, "arrayPrototype", propName);
};
```
— `src/runtime/member-lookup.ts:75-86`

Four steps, in order: `length` from the payload; an integer-looking name as an element
index (`elementIndex` is `Number(propName)` filtered through `Number.isInteger`,
`:70-73`); an own named property the user set on the array; and only then the prototype.
The order is the semantics — a user-set `a.map` wins over the builtin `map`, and
`tests/e2e/optimizing/member-access.test.ts` pins the analogous rule for functions with
`"keeps a user-set own property winning over a builtin member"`.

`stringMember` (`:88-97`) has the same shape with three steps instead of four: `length`,
an indexed character via `stringCharAt`, prototype. `regexMember` (`:99-103`) asks
`getRegexProperty` for `source`, `flags` and friends before the prototype.

`numberMember` and `booleanMember` are the degenerate case, and they are two lines each:

```typescript
const numberMember: MemberLookup = (_receiver, propName, interpreter) =>
  builtinPrototypeMember(interpreter, "numberPrototype", propName);
```
— `src/runtime/member-lookup.ts:124-125`

The receiver is named `_receiver` because it is never read. A number has no own members
at all; everything a number can answer lives on `numberPrototype`.

The split is what makes the table callable without an engine. Pass `null` and the first
three steps of `arrayMember` still work:

```
memberLookupValue(mkArray(createJSArray([mkSmi(4)])), "length", null)  ->  mkSmi(1)
memberLookupValue(mkString("hey"), "length", null)                     ->  mkSmi(3)
```

pinned by `tests/runtime/member-lookup.test.ts:144-147`
[t: `tests/runtime/member-lookup.test.ts` > "still answers own members when no interpreter is available"].
And the complementary claim — that answering an own member never *touches* the interpreter
even when one was supplied — is pinned by
[t: `tests/runtime/member-lookup.test.ts` > "answers a value kind's own members without consulting a prototype"],
which builds an interpreter whose `_lookupBuiltinPrototype` appends to a `consulted` array
and then asserts `consulted` is empty after six own-member reads.

## Declining when no prototype is available

The single place the third answer is produced *deliberately rather than incidentally* is
the prototype helper:

```typescript
function builtinPrototypeMember(
  interpreter: MemberLookupInterpreter | null,
  prototype: BuiltinPrototypeName,
  propName: string,
): TaggedValue | null {
  if (!interpreter || !interpreter.builtinPrototypes) return null;
  return interpreter._lookupBuiltinPrototype(
    interpreter.builtinPrototypes[prototype],
    propName,
  );
}
```
— `src/runtime/member-lookup.ts:58-68`

It returns `null`, not `mkUndefined()`. This is the contract being used honestly:
*"I cannot reach the prototype"* is not *"the member is absent"*. The table does not know
whether `stringPrototype` has a `slice`; it knows it cannot look. Answering `undefined`
would be a claim it has no evidence for, and — since `getRuntimeProperty` treats a
`TaggedValue` as final — a claim no downstream caller could override.

`BuiltinPrototypeName` is a closed five-name union (`:40-45`): `arrayPrototype`,
`stringPrototype`, `regexPrototype`, `numberPrototype`, `booleanPrototype`. Those are
exactly the prototype-backed kinds; the other three entries in the table have no prototype
object of their own.

[t: `tests/runtime/member-lookup.test.ts` > "declines a prototype member when no interpreter can supply prototypes"]
asserts `toBeNull()` for `array.map`, `string.slice`, `regex.test`, `number.to_fixed` and
`boolean.to_string`, all with `null` for the interpreter. The complementary decline —
"not my kind" — is
[t: `tests/runtime/member-lookup.test.ts` > "declines the kinds its callers resolve themselves"],
which checks a `JSObject`, `mkNull()` and `mkUndefined()`.

## The coroutine exception

Two entries break the pattern, and they break it in the direction that looks wrong:

```typescript
const generatorMember: MemberLookup = (receiver, propName, interpreter) => {
  const resuming = asGeneratorMemberInterpreter(interpreter);
  return resuming === null
    ? mkUndefined()
    : generatorMemberValue(resuming, receiver as GeneratorValue, propName);
};

const promiseMember: MemberLookup = (receiver, propName, interpreter) => {
  const settling = asPromiseMemberInterpreter(interpreter);
  return settling === null
    ? mkUndefined()
    : promiseMemberValue(settling, receiver as PromiseValue, propName);
};
```
— `src/runtime/member-lookup.ts:105-117`

When the probe fails these answer `mkUndefined()` — *absent* — where every
prototype-backed kind answers `null` — *cannot look*. The asymmetry is real and it is
deliberate.

The difference is what a decline would mean downstream. A declined string falls through to
`proxyRuntimeGetProperty`, which for a non-object receiver has a defined, harmless
behaviour, and in the interpreter's `handleLdaProp` the decline is immediately converted to
`mkUndefined()` anyway. But a generator's `next` is not a property on a prototype object
that some other path might find; it is a closure manufactured on demand by
`generatorMemberValue`, which needs `runFrame` and `suspendedFrames` to build it. There is
no prototype object to fall back to, and no other resolver in the engine can produce a
generator's `next`. Declining would push the receiver onto a path that cannot handle it
either — trading a defensible `undefined` for an undefined-behaviour walk through
object-property code with a generator payload.

The probe itself is structural:

```typescript
export function asGeneratorMemberInterpreter(
  interpreter: unknown,
): GeneratorMemberInterpreter | null {
  const candidate = interpreter as GeneratorMemberInterpreter | null | undefined;
  return candidate &&
    typeof candidate.runFrame === "function" &&
    candidate.suspendedFrames instanceof Map
    ? candidate
    : null;
}
```
— `src/bytecode/register/interpreter/generator-members.ts:22-31`

`src/bytecode/register/interpreter/promise-members.ts` has the same shape for
`asPromiseMemberInterpreter`.

[t: `tests/runtime/member-lookup.test.ts` > "answers undefined rather than declining when a coroutine member cannot settle"]
is the one test in the file that exists solely to pin an asymmetry:
`memberLookupValue(promiseValue(), "then", null)` and
`memberLookupValue(generatorValue(), "next", null)` both `toEqual(mkUndefined())`, where the
five prototype-backed kinds in the test above them all `toBeNull()`.

> **Unenforced.** `asGeneratorMemberInterpreter` and `asPromiseMemberInterpreter` decide
> "is this an interpreter" by probing for a `runFrame` function and a `suspendedFrames`
> `Map`. Any object with those two members passes. The test file relies on that — the
> generator fixture at `tests/runtime/member-lookup.test.ts:72-75` builds a `resuming`
> object out of exactly those two members and nothing else — which means the probe is not
> merely weak in principle, it is *used* weakly in the tree. Tightening it would cost a
> nominal brand on the interpreter and a change to every synthetic interpreter in `tests/`.

## Three call sites, and a fourth that came for free

`grep -rn "memberLookupValue" src/` returns eight lines, three of which are imports and one
of which is the definition. The four remaining are the callers.

**Call site one — the interpreter.** `src/bytecode/register/interpreter/handlers.ts:286`,
the last two lines of `handleLdaProp`:

```typescript
  const member = memberLookupValue(obj, propName, interp);
  return member !== null ? member : mkUndefined();
```
— `src/bytecode/register/interpreter/handlers.ts:286-287`

It is reached only after the `isObject(obj)` branch that opens at `:200` has returned, so
an object never arrives at the table. That is why `CODE_OBJECT` being a hole costs nothing
on this path: the hole is unreachable from here. `:426` is the same call for a computed
string key on a string receiver, inside `handleLdaIndex` (`handlers.ts:376-434`) — the
`isString(obj)` branch, reached when the index is not a number. Both convert a decline to
`mkUndefined()` at the boundary, because the opcode has to produce a value.

**Call site two — the baseline.** `src/optimizing/baseline/runtime.ts:338`, the tail of the
runtime's `gp` (get-property) method, with the same decline-to-`undefined` conversion
against the runtime's cached `this.u`. `runtime.ts:83-84` declares the same two-member
obligation on the interpreter the baseline holds.

**Call site three — the generic door.** `src/runtime/value-semantics.ts:41-50`:

```typescript
export function getRuntimeProperty(
  obj: TaggedValue,
  propName: string,
  interpreter: MemberLookupInterpreter | null = null,
): TaggedValue {
  const member = memberLookupValue(obj, propName, interpreter);
  return member !== null
    ? member
    : proxyRuntimeGetProperty(obj, propName, interpreter);
}
```
— `src/runtime/value-semantics.ts:41-50`

Table first, proxy/object resolution second. This is the only caller that does something
*useful* with a decline rather than flattening it, and it is the reason the three-answer
contract exists at all.

The JIT never calls the table. It calls `getRuntimeProperty`, from five places in
`src/optimizing/backends/wasm/runtime-support.ts` — `:444`, `:469`, `:518`, `:754` and
`:1158` — and `:143` in that file is the third and last declaration of the
`_lookupBuiltinPrototype` obligation. So tier 2's member semantics are tier 0's member
semantics by construction, through one indirection.

**And the fourth site came for free.** `src/deopt/frame-materializer.ts:153` calls
`getRuntimeProperty` while rebuilding an interpreter frame from a frame state, to
re-evaluate an `IR_GENERIC_GET_PROP` node whose result was not materialized. Nobody wrote
member-lookup logic for the deoptimizer. It inherits the whole contract — the three
answers, the own-member/prototype split, the coroutine asymmetry — by calling a function
that already had them. That is the practical payoff of a single source of truth: the fourth
consumer is free, and it is the one nobody would have thought to write a divergence test
for.

> Naming note, per [Conventions § 4]. `_lookupBuiltinPrototype` carries a leading
> underscore, which in most codebases marks a private member. It is not private. It is
> half of the *public* contract between this table and all three of its callers, and it is
> declared in three separate interfaces: `handlers.ts:95`, `baseline/runtime.ts:84`, and
> `wasm/runtime-support.ts:143`. The name misleads; the code's name wins, and the rest of
> this book uses it.

## Where the table is still bypassed

The claim "three tiers, one implementation" is true for named property access. It is not
yet true for *computed* string-key access in the baseline. `gi`, the baseline runtime's
indexed-get, re-derives string member arithmetic by hand:

```typescript
      const key = isString(index) ? getPayload(index) : toDisplayString(index);
      if (key === "length") return mkSmi(text.length);
      const idx = Number(key);
      if (Number.isInteger(idx)) {
        const ch = stringCharAt(text, idx);
        return ch !== undefined ? mkString(ch) : this.u;
      }
      return this.interp._lookupBuiltinPrototype(
        this.interp.builtinPrototypes.stringPrototype,
        key,
      );
```
— `src/optimizing/baseline/runtime.ts:463-473`

Compare that to `stringMember` (`member-lookup.ts:88-97`): `length` from the payload, an
integer-index character, the string prototype. It is the same three steps in the same
order, written twice. The interpreter's equivalent path at `handlers.ts:426` calls
`memberLookupValue`; the baseline's does not.

Today the two agree, and
[t: `tests/e2e/optimizing/member-access.test.ts` > "reads length, a character, and a method via a computed key"]
plus
[t: `tests/e2e/optimizing/member-access.test.ts` > "resolves computed string keys on a hot (compiled) call"]
run the same source through the interpreter oracle and the compiled tiers and demand equal
answers. But those tests pin the *outcome* for the cases they cover; nothing pins the
*implementations* to each other, which is exactly the situation the first section of this
chapter described.

> **Unfinished.** `src/optimizing/baseline/runtime.ts:463-473` duplicates `stringMember`'s
> own-member arithmetic instead of calling `memberLookupValue`. Finishing it means routing
> the keyed-string path through the table, which requires reconciling two index policies
> first: `elementIndex` uses `Number(propName)` filtered by `Number.isInteger`, while the
> baseline's fast path at `:459` short-circuits on `isSmi(index)` before it ever builds a
> string key. The two agree on every integer that fits in a Smi and are untested against
> each other outside it.

There is a second, smaller copy of the same arithmetic, and it is not the baseline's:
`handlers.ts:235-248` answers `length` and an indexed character for a
`INSTANCE_TYPE_STRING_WRAPPER` object — a `JSObject` wrapping a string primitive, which has
`codeOf` `CODE_OBJECT` and therefore cannot reach the table at all.

> **Unenforced.** Three implementations of "a string's own members" now exist —
> `src/runtime/member-lookup.ts:88-97`, `src/optimizing/baseline/runtime.ts:463-473`, and
> `src/bytecode/register/interpreter/handlers.ts:235-248` — and nothing derives any of them
> from the others or asserts they agree. The third is structurally hard to remove: the
> table is indexed by tag code, and a string wrapper's tag code is `CODE_OBJECT`.

## The fourth tier mirrors names, not code

Everything above is scoped to the three tiers that run inside this process. The native
compiler is outside it, and the part opener said why: there is no `TaggedValue` in an AOT
binary, therefore no tag code, therefore no index into this table.

What the native side has instead is a name list. `BUILTIN_METHOD_DECLARATIONS` in
`src/optimizing/metadata/builtin-methods.ts` is twenty records of the form:

```typescript
export const BUILTIN_METHOD_DECLARATIONS: readonly BuiltinMethodDeclaration[] = [
  { owner: "string", name: "char_code_at", pure: true },
  { owner: "string", name: "char_at", pure: true },
  { owner: "string", name: "length", pure: true },
  { owner: "int", name: "to_string", pure: true },
  { owner: "float", name: "to_string", pure: true },
```
— `src/optimizing/metadata/builtin-methods.ts:35-40`

`grep -c 'owner: "' src/optimizing/metadata/builtin-methods.ts` returns `20`: eighteen owned
by `string`, one by `int`, one by `float`. The compiler reads them through
`builtinOwnerMember` (`src/optimizing/types/declared.ts:165-182`), which turns an
`(owner, name)` pair into a lattice type, a getter flag and a signature.

Three things are shared with the in-process table, and one crucial thing is not. Shared:
the *spellings* (`to_upper_case`, not `toUpperCase`), the notion of an owner, and the fact
that a member of a primitive is resolvable at all. Not shared: any line of implementation.
Each native backend emits its own code for `to_upper_case`, and the declaration carries a
`pure` flag the in-process table has no equivalent of, because purity only matters to an
optimizer that wants to fold or eliminate the call.

The asymmetry has a name in this book's structure. The in-process table makes disagreement
between tiers 0, 1 and 2 *structurally impossible* — there is one function, and it either
answers or declines. Between those three and tier 3 there is no such structure: agreement
is a property of two independently-written implementations that share only a list of
strings, and the only thing that checks it is a test. [Ch 28 § builtins-are-three-kinds-in-one-union] takes that up for
calls, and it is the root of a whole family of refusals in Part IX: where the native
compiler cannot reproduce a member's semantics, its honest move is to decline the function
rather than emit something that answers differently.

## Snake case is upstream

One paragraph, because it is a question this chapter will otherwise leave open: nothing in
`member-lookup.ts` translates names, and yet `label()` in `stats.tera` calls `.to_fixed(2)`
while the intrinsic that implements it is declared as `toFixed`
(`src/runtime/intrinsics/number-methods.ts:33`).

The conversion happens once, at engine startup, when prototypes are *populated*:
`populatePrototype` writes each method under `camelToSnake(name)`
(`src/runtime/intrinsics/prototypes.ts:25`, using the helper in `src/utils/naming.ts`). By
the time `numberMember` asks `_lookupBuiltinPrototype` for `"to_fixed"`, the property on
`numberPrototype` is already spelled `to_fixed`. The table has no naming policy of its own,
and neither does `_lookupBuiltinPrototype`; both do exact string lookups on a name the
front end put in a constant pool and the prototype builder put on an object.

You can see both halves meet in `label`'s bytecode. Constant `[3]` is the string
`"to_fixed"`, put there by the parser; instruction 16 loads it as a named property of
register `r1`, which at that moment holds the `float` that `mean()` returned — tag code
`CODE_DOUBLE`, table entry `numberMember`, prototype `numberPrototype`:

```
    14  CallMethod r2 r0 r0 r3
    15  Star r1
    16  LdaNamedProperty r1 [3] (to_fixed) r4
    17  Star r2
```
— `node dist/cli.js --print-bytecode --filter label docs/example/stats.tera`

## What leaves

One resolution function with a three-valued contract:
`memberLookupValue(receiver, propName, interpreter)` answers `null` for "not my kind",
`mkUndefined()` for "mine and genuinely absent", and a `TaggedValue` for everything else.
Tier 0 calls it twice in `handlers.ts`, tier 1 calls it once in the baseline runtime's `gp`,
and tier 2 reaches it through `getRuntimeProperty`, which is also what the deoptimizer's
frame materializer uses. The three in-process tiers therefore cannot disagree about
`values.length`, `"abc"[1]`, `fn.name`, `p.then`, `g.next` or `/ab/.source` — not because
they are tested to agree, but because there is one place the answer is computed. The fourth
tier agrees only by test, because it shares the twenty spellings in
`BUILTIN_METHOD_DECLARATIONS` and no implementation.

What this chapter does *not* hand on is everything the table declines. `null` from
`memberLookupValue` is a live obligation, and `getRuntimeProperty` discharges it by calling
`proxyRuntimeGetProperty` — the door to plain objects, to proxy traps, and to the exotic
receivers whose member access does not follow the ordinary rules at all.

[Ch 26 § indexing-two-subscripts-one-file] takes those receivers, plus the reads this chapter never saw because
they are not reached by a *name*: a subscript (`a[i]`), a slice (`a[1:3]`), a
multi-dimensional index (`m[i, j]`), a private field reached through a class lineage, a
static member reached through a `staticBase` chain, and the three object kinds — proxies,
collections, primitive wrappers — that each opt out of the hidden-class machinery in a
different way. Two of those subscript syntaxes have opposite out-of-range policies, which
is the next chapter's opening surprise.

## Verify it yourself

```bash
# The two doors, side by side: instruction 8 leaves through Ch 24 (JSObject, hidden
# class, IC); instruction 10 leaves through this chapter (CODE_ARRAY, arrayMember).
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera | grep -n LdaNamedProperty
```

```
17:     8  LdaNamedProperty r4 [1] (values) r0
19:    10  LdaNamedProperty r3 [2] (length) r1
26:    17  LdaNamedProperty r4 [1] (values) r4
45:    36  LdaNamedProperty r4 [1] (values) r8
47:    38  LdaNamedProperty r3 [2] (length) r9
```

```bash
# The nine clauses of the contract, one test each. Runs without an engine.
npx vitest run --project unit tests/runtime/member-lookup.test.ts
```

```
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

```bash
# Sixteen value-kind reads, each run through the interpreter oracle and then through
# baseline, jit, osr and production, and required to give the same answer.
npx vitest run --project e2e tests/e2e/optimizing/member-lookup-tiers.test.ts
```

```
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

```bash
# Every caller of the table. Four call sites, three imports, one definition.
grep -rn "memberLookupValue" src/ --include=*.ts
```

```
src/bytecode/register/interpreter/handlers.ts:55:import { memberLookupValue } from "../../../runtime/member-lookup.js";
src/bytecode/register/interpreter/handlers.ts:286:  const member = memberLookupValue(obj, propName, interp);
src/bytecode/register/interpreter/handlers.ts:426:    const member = memberLookupValue(obj, key, interp);
src/optimizing/baseline/runtime.ts:65:import { memberLookupValue, type BuiltinPrototypeSet } from "../../runtime/member-lookup.js";
src/optimizing/baseline/runtime.ts:338:    const member = memberLookupValue(obj, propName, this.interp);
src/runtime/member-lookup.ts:152:export function memberLookupValue(
src/runtime/value-semantics.ts:13:import { memberLookupValue, type MemberLookupInterpreter } from "./member-lookup.js";
src/runtime/value-semantics.ts:46:  const member = memberLookupValue(obj, propName, interpreter);
```

```bash
# The AOT name list. Twenty declarations; the unquoted `grep -c "owner:"` would say 25
# because it also counts two interface fields and three unrelated uses.
grep -c 'owner: "' src/optimizing/metadata/builtin-methods.ts
grep -o 'owner: "[a-z]*"' src/optimizing/metadata/builtin-methods.ts | sort | uniq -c
```

```
20
      1 owner: "float"
      1 owner: "int"
     18 owner: "string"
```

## Tests that pin this

- `tests/runtime/member-lookup.test.ts` > `"the member lookup registry"` — nine tests, one
  per clause of the contract.
  - `"routes each prototype-backed value kind to its own prototype"` — the table *is* the
    routing: array→array, string→string, regex→regex, smi *and* double→number,
    bool→boolean, asserted as an ordered list of six `consulted` records.
  - `"answers a value kind's own members without consulting a prototype"` — asserts
    `consulted` is `[]` after six own-member reads, i.e. the interpreter is never touched.
  - `"resolves a promise member through the registry"` — `then` and `catch` come back as
    functions.
  - `"resolves a generator member through the registry"` — `next` comes back as a function.
  - `"resolves a function member through the registry"` — `fn.name`.
  - `"declines the kinds its callers resolve themselves"` — the `null` answer, for a
    `JSObject`, `mkNull()` and `mkUndefined()`.
  - `"declines a prototype member when no interpreter can supply prototypes"` — the other
    `null` answer, for all five prototype-backed kinds.
  - `"still answers own members when no interpreter is available"` — the own/prototype
    split, with `null` for the interpreter.
  - `"answers undefined rather than declining when a coroutine member cannot settle"` — the
    one documented asymmetry.
- `tests/e2e/optimizing/member-lookup-tiers.test.ts` > `"reading a member of every value
  kind once the reader leaves the interpreter"` — sixteen tests, each run through
  `differential(..., { tiers: ["baseline", "jit", "osr", "production"] })` against the
  interpreter oracle, with the read placed inside a four-hundred-iteration loop so every
  tier is reached. Notably `"reads an array's own length"`, `"reads a string method off the
  string prototype"`, `"reads a number method off the number prototype"`, `"reads a
  function's own arity"`, `"reads then off a promise"`, `"reads next off a generator"`,
  `"reads a member of an object literal"` (the `null`-decline path) and `"answers undefined
  for a member no value kind provides"`.
- `tests/e2e/optimizing/member-access.test.ts` > `"computed string-key access matches dot
  access on a string"` > `"reads length, a character, and a method via a computed key"` and
  `"resolves computed string keys on a hot (compiled) call"` — these pin the *outcome* of
  the bypassed baseline path at `runtime.ts:463-473`, not the duplication itself.
- `tests/e2e/optimizing/member-access.test.ts` > `"function member access agrees across
  every tier when hot"` > `"reads .length (arity) and .name, including on a returned
  closure"` and `"keeps a user-set own property winning over a builtin member"` — the
  own-before-prototype order, under all four tier configurations.
- `tests/e2e/optimizing/generator-members-tiers.test.ts` > `"members of a receiver the
  compiled lookup has to branch for"` > `"advances an iterator made inside the hot
  function"` and `"reads a regex member from compiled code"` — the two table entries whose
  receivers a compiled tier has to branch for rather than inline.
