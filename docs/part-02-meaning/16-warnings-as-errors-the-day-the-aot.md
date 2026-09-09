# 16. Warnings as Errors: The Day the AOT Gate Flipped   ⟨— · — · — · N⟩

Strict mode adds no checks. That is the smallest true statement about the mechanism this
chapter is named for, and everything else follows from it. `TypeChecker.strict` is a
boolean read at exactly one place in a 1,546-line file, and its only effect is to pick the
word `"error"` instead of the word `"warning"` in one field of one record. There is no
second analysis, no extra pass, no stricter assignability rule. Every diagnostic a `tera
compile` reports was already being computed, silently, on every `tera run`.

So the entire ahead-of-time contract — the thing that makes `queue.tera` print `10` from the
interpreter and produce no binary at all from the native compiler — is one caller deciding
that a non-empty array means refuse. Two lines in `src/api/engine.ts` force the checker into
strict mode whenever the `aot` flag is set, and two more throw if anything came back. That
is the whole gate. It is smaller than the sentence it prints.

The interesting part is what happened when someone finally set it. The checker had been
running in `warn` mode since it was written, which meant nobody had to read its output, which
meant nobody did. Turning the gate on ran the checker in anger against a test suite that
already existed and already passed, and 72 end-to-end tests failed at once. Roughly half were
real type errors in terse test sources that should never have compiled. The other half were
checker bugs on programs that ran correctly. The gate did not find those bugs. The gate made
someone read them — and that is the second thesis of this chapter, and the more portable one:
**a warning-only checker accumulates bugs silently, because nothing forces anyone to look.**

**What arrived.** From [Ch 15 § what-leaves]: a `ModuleGraph` and, from `checkModuleGraph`, a
`ModuleCheckResult` carrying one `ModuleInterface` per module, the merged `TypeEnv`, the
`ClassSurface[]` flattened across every module in the program, and a `diagnostics` array that
spans every module with each entry tagged by its `module` and `path`. Plus the four things
the earlier chapters of this part deposited on the way through: `_paramInfo` and `_returnType`
written back onto the AST ([Ch 11 § the-write-back]), `ClassSurface[]` ([Ch 12]), and
canonical type text produced by `cleanType` ([Ch 9]). This chapter takes the `diagnostics`
field and decides what it means.

## One field, one word

The severity model is one file, 27 lines. Here is the type half:

```ts
export type TypecheckMode = "off" | "warn" | "strict";

export type Diagnostic = {
  line: number;
  column: number;
  message: string;
  severity: "warning" | "error";
};
```
— `src/frontend/checker/diagnostics.ts:1-8`

and here is the constructor half, which is where `strict` is spent:

```ts
export function diagnostic(
  line: number,
  column: number,
  message: string,
  strict: boolean,
): Diagnostic {
  return { line, column, message, severity: strict ? "error" : "warning" };
}
```
— `src/frontend/checker/diagnostics.ts:20-27`

Between them sits `TypecheckError`, whose constructor joins its diagnostics into the `Error`
message with `${d.line}:${d.column} ${d.message}` and a newline separator
(`diagnostics.ts:13-17`). That join is why the refusal you saw in [Ch 1 § the-cold-open]
carries a `6:18` prefix: the position is not formatted by the CLI, it is baked into the
exception's message before anything catches it.

`TypeChecker` reads `strict` once. The field is declared at `type-checker.ts:46`, assigned in
the constructor at `:53`, and consulted at `:1253`, inside a three-line method:

```ts
  add(line: number, column: number, message: string): void {
    this.diagnostics.push(diagnostic(line, column, message, this.strict));
  }
```
— `src/frontend/checker/type-checker.ts:1252-1254`

`grep -n "strict" src/frontend/checker/type-checker.ts` returns four lines: the declaration,
the constructor parameter, the assignment, and that push. Nothing else in the file branches on
it. There is no `if (this.strict)` anywhere, no check that only runs in strict mode, no rule
that tightens.

The three modes then collapse to two booleans one level up:

```ts
export function checkProgram(
  program: SemanticProgram,
  options: BindOptions & { mode?: TypecheckMode } = {},
): CheckProgramResult {
  const bound = bindProgram(program, options);
  const mode = options.mode ?? "warn";
  const diagnostics = mode === "off" ? [] : new TypeChecker(bound, mode === "strict").check();
  return { diagnostics, bound };
}
```
— `src/frontend/checker/index.ts:68-76`

Run the checker or do not; label the results `error` or `warning`. `warn` and `strict` do the
identical work and differ in one string. The default, when nobody says otherwise, is `warn`.

## Severity is policy

> **New idea. A checker produces facts; something else decides whether a fact stops the
> build.** It is tempting to read "type error" as a property of the program — the program is
> wrong, therefore the compiler stops. It is not. The analysis produces a list of places
> where it could not establish what it needed; whether that list is fatal is a *policy*
> decision made by whoever asked for the analysis. The same list can be advice on a program
> you are editing, a lint warning in CI, and a hard refusal in a release build, without a
> single line of the analysis changing. Separating the two is what lets a checker be
> incomplete and still useful: you can afford false alarms in an advisory tool that you
> cannot afford in a gate.

In this engine "elsewhere" is `src/api/engine.ts`, and it is two lines repeated twice. The
first is the override:

```ts
    const mode = aot ? STRICT_TYPECHECK : this.typecheckMode;
```
— `src/api/engine.ts:1187`

Whatever the caller configured, an ahead-of-time compile runs the checker in strict mode. The
second is the gate itself, fourteen lines later, with a third line in front of it that
completes the contract:

```ts
    if (aot || mode !== "off") {
      const checked = checkProgram(astToSemanticProgram(parsedSource), {
        mode,
        builtins: checker.builtins,
        aliases: checker.aliases,
        interfaces: checker.interfaces,
      });
      this.diagnostics = checked.diagnostics;
      if (aot) this.aotClasses = buildClassTable(classSurfacesOf(checked.bound), checked.bound.env);
    } else {
      this.diagnostics = [];
    }
    if (mode === STRICT_TYPECHECK && this.diagnostics.length > 0) {
      throw new TypecheckError(this.diagnostics);
    }
```
— `src/api/engine.ts:1193-1207`

Read `if (aot || mode !== "off")` carefully. An AOT compile checks *even when the caller
explicitly turned checking off*. That is not theoretical: `tests/helpers/aot-agreement.ts:6`
declares `const UNCHECKED = { typecheck: "off" } as const`, constructs every engine with it,
and then calls `compileAot` — and gets strict checking anyway, because `aot` is `true`. There
is no way to ask for a native binary and skip the checker.

The same pair appears a second time, identically, at `src/api/engine.ts:1388` and
`:1426-1427`, inside `loadModuleGraph`. Those two occurrences are not redundant: they are the
two doors. `compileAot` (`:944`) is the single-source door and reaches the gate at `:1205`;
`compileAotModule` (`:1001`) calls `loadModuleGraph(entryPath, options, true)` on its first
line and reaches the gate at `:1426`. **`tera compile` always takes the second door.**
`src/cli/compile.ts:335` calls `engine.compileAotModule(resolved, …)` unconditionally, even
for a single file with no imports, so the refusal a user meets on the command line is thrown
from `loadModuleGraph`, never from `compileInRuntime`. The first door is reached only through
the `Engine` API, which is how the test helpers use it.

Now notice what the gate does *not* read. It tests `mode === STRICT_TYPECHECK` and
`this.diagnostics.length > 0`. It never looks at `severity`. The word that `TypeChecker.strict`
exists to choose is not consulted by either throw. Across all of `src/`, `Diagnostic.severity`
is read in exactly two places, and both of them are in the CLI:

```ts
function reportDiagnostic(location: string, diagnostic: Diagnostic): boolean {
  console.error(`${location}: ${diagnostic.severity}: ${diagnostic.message}`);
  return diagnostic.severity === "error";
}
```
— `src/cli/main.ts:118-121`

That function belongs to `tera check`, which is a third route entirely. `runCheck`
(`src/cli/main.ts:141-155`) never constructs an `Engine` — the only two `new Engine` calls in
that file are at `:187` for `run` and `:224` for the REPL. It builds the module graph itself,
calls `checkModuleGraph(graph, { ...options, mode: "strict" })` directly at `:134`, prints
each diagnostic through `reportDiagnostic`, and returns a failure exit code if any came back
with severity `"error"`.

So the correct picture is: **two doors reach the Engine's gate, and a third route reaches the
same checker in the same mode by a separate path.** All three print the same sentence and exit
1, but the prefixes differ, because each door formats it:

```
$ node dist/cli.js --typecheck strict docs/example/queue.tera
6:18 Operator '+' cannot be applied to 'int' and 'int | undefined' (the value may be absent: guard it before use, or spell a fallback with ??)

$ node dist/cli.js compile docs/example/queue.tera -o /tmp/queue.exe
tera compile: 6:18 Operator '+' cannot be applied to 'int' and 'int | undefined' (the value may be absent: guard it before use, or spell a fallback with ??)

$ node dist/cli.js check docs/example/queue.tera
C:\Users\slexi\Documents\tera\docs\example\queue.tera:6:18: error: Operator '+' cannot be applied to 'int' and 'int | undefined' (the value may be absent: guard it before use, or spell a fallback with ??)
```

The first two get their `6:18` from `TypecheckError`'s join; the third gets its
`path:line:column: error:` from `reportDiagnostic`, and is the only one of the three in which
the word `error` — the one thing strict mode actually decides — appears on screen.

> **Unenforced.** The invariant "the AOT road always runs strict" is enforced only by the two
> identical lines at `src/api/engine.ts:1187` and `:1388`, and the refusal is enforced by
> array length rather than by severity. `TypeChecker.strict` is a `public` field and settable.
> Nothing checks that a new AOT entry point repeats the pair — and one already exists that
> does not. `Engine.compileAotFunctions` (`:948`) takes already-compiled
> `RegisterCompiledFunction`s and never runs the checker at all; three tests use it
> (`tests/e2e/optimizing/aot/aot.test.ts:231` and `:252`,
> `tests/e2e/optimizing/aot/static-types.test.ts:265`). It is not reachable from the CLI, so
> no user can compile past the gate through it, but the invariant is a convention among three
> call sites, not a property anything verifies. Cost of enforcing it: one private helper that
> owns `mode` selection and the throw, called by all three entry points.

> **Unenforced.** `engine.ts:1205-1207` and `:1426-1428` are the same three lines written
> twice, and the code around them is not the same. The module-graph door does
> `refuseRepeatedClassNames(graph)` (`:1424`) and `buildClassTable(checked.classes,
> checked.types)` (`:1425`) *before* the throw; the single-source door does its own
> `buildClassTable` at `:1201`, also before. A divergence in that ordering — building a class
> table from a program the gate is about to reject — is not pinned by any test.

## Why the native tier and not the others

The badge on this chapter is `⟨— · — · — · N⟩`, and the reason is the hinge from
[Ch 1 § the-hinge]. The JIT may guess, because a wrong guess deoptimizes back into the
interpreter and the program continues with the right answer. The native compiler may not,
because the binary contains no interpreter, no bytecode and no frame to rebuild. Where the JIT
inserts a guard, the native compiler must prove the fact or refuse.

A type the checker cannot pin down is exactly a fact that cannot be proved. `int | undefined`
has a perfectly good representation in the interpreter's tagged value ([Ch 22]) — a tag bit
says which it is, and the `+` operator dispatches on the tag at run time. It has no
representation in a machine register ([Ch 55]), because there is nowhere to put the tag and
nothing to dispatch on. So the checker's output is *optional advice* for three tiers and a
*precondition* for the fourth, and the flip described in this chapter is the moment that
asymmetry was written down as a policy instead of left as an intention.

The two grains of refusal are worth keeping apart. The gate refuses a program *whole*: nothing
is emitted, and the reason is a type. The backend declines a function *individually*: it names
what it cannot lower and still ships a binary if the entry point did not need it
([Ch 81 § refusal-as-a-first-class-answer]). `docs/example/queue.tera` meets the first;
`docs/example/stats-refused.tera` meets the second. `docs/example/stats.tera` meets neither —
`node dist/cli.js check docs/example/stats.tera` is silent and exits 0, and `tera compile`
writes the executable.

## Deleting the flag

`tera compile` used to accept `--typecheck`. It does not now, and the reason is worth one
paragraph because it is a small, clean instance of a general rule about flags.

The flag itself is seven lines:

```ts
const TYPECHECK_FLAG: FlagSpec<{ typecheck: TypecheckMode | null }> = {
  name: "typecheck",
  value: "off|warn|strict",
  group: "Types",
  summary: "set the type checker mode",
  apply: (config, value) => (config.typecheck = parseTypecheck(value)),
};
```
— `src/cli/spec.ts:123-129`

It is registered exactly once, as the last entry of `ENGINE_FLAGS` (`spec.ts:248`), and
`ENGINE_FLAGS` is the flag set of `run`, `repl` and `debug`. `COMPILE_COMMAND` and
`CHECK_COMMAND` build their own lists and do not include it. The observable consequence:

```
$ node dist/cli.js compile docs/example/queue.tera --typecheck warn -o /tmp/queue.exe
tera: unknown option '--typecheck' for 'compile' (see 'tera help compile')
$ echo $?
2
```

and `node dist/cli.js help compile` prints Input, Output and Optimization groups and no Types
group at all. (`tera check` answers the same way, for the same reason.)

*(What was tried and rejected.)* The flag was on `COMPILE_COMMAND` for one revision, and the
commit that flipped the gate removed it — the diff deletes `TYPECHECK_FLAG` from the compile
command's flag list and `typecheck: null` from its defaults. What was being tried was a way to
build a binary from a program that only produced warnings: keep the checker advisory, let the
backend do its best, ship something. It was rejected because there is no such binary. A
warning here is not a style complaint; it is the checker saying it could not establish a fact,
and the fact it could not establish is the one the register allocator needs in order to pick a
machine representation. Accepting the flag would have meant accepting a value of it that
cannot be honoured. **A flag that can only be set to the one value that already holds is not a
flag**, and a flag whose other values quietly produce a different meaning of "compiled" is
worse than not having one.

## 72 tests, half of them real

Told as engineering.

*Symptom.* Turning the gate on made 72 end-to-end tests fail at once. They had all been
passing. None of the programs they ran had changed.

*Triage.* Roughly half were genuine type errors — terse test sources written to exercise a
backend, with a parameter left unannotated or a return type that did not match, which the
checker had been complaining about into a void for as long as they had existed. Those were
fixed by fixing the sources. The other half were **checker bugs on programs that ran
correctly**: the program was fine, the interpreter agreed it was fine, and the checker was
wrong. Those were fixed by fixing the checker, and they are the subject of the next section.

*Fix.* One commit, `da1f059` (2026-08-22): 64 files, 757 insertions, 268 deletions. It sets
`STRICT_TYPECHECK`, renames `compileInRuntime`'s third parameter from `retainClassShapes` to
`aot`, deletes `TYPECHECK_FLAG` from the compile command, and touches nine checker and
specification files. Thirty-three test files change with it, twenty of them under
`tests/e2e/`.

*Regression test.* There is no single test that pins "the gate is on", and there could not be
one — the gate is the absence of an escape hatch. What pins it in practice is the entire AOT
suite, which now runs through a checker it cannot switch off: every test under
`tests/e2e/optimizing/aot/` goes through `aot-agreement.ts`'s `{ typecheck: "off" }` engines
and is strict-checked anyway. The narrowest pin on the user-visible behaviour is
`[t: tests/e2e/docs/book-examples.test.ts > "queue.tera runs in the interpreter but is refused ahead of time"]`,
which asserts both halves of the same sentence: the interpreter's `10`, and the compile's
refusal.

*The general rule.* **A warning-only checker accumulates bugs silently, because nothing forces
anyone to read the output.** Nine real defects had been sitting in a checker that ran on every
single execution of every single program, printing nothing anybody had to act on. The cost of
finding them was not analysis; it was one boolean, plus the willingness to spend a day on the
72 failures it produced. If a diagnostic channel has no consumer who is obliged to care, it is
not a diagnostic channel — it is a log.

The count 72 is `[unpinned]`. It is a historical figure from the change record for `da1f059`;
the tree cannot be asked to reproduce it, because the programs it refers to were fixed in the
same commit. What the tree *can* be asked for is the commit, and the commit's shape
corroborates it: `git show --stat da1f059` lists the 33 test files.

## The nine

Each of these is a checker bug on a program that ran correctly. Each is told in full in the
chapter that owns the mechanism; this is the index, and every entry names the file that
changed and can be found in the tree today.

1. **`Error` was not in the specification table.** Using it reported `undefined name 'Error'`.
   Fixed by adding it to `data/tera-language-spec.ts` — it is at `:360` in
   `TERA_PRIMITIVE_TYPES` and at `:1291` as a builtin. ([Ch 28])
2. **A class with no constructor did not inherit its parent's signature**, so `Leaf(1)` on a
   subclass that declared no constructor reported `Too many positional arguments for Leaf()`.
   `binder.ts:222-225` now looks the parent's signature up and adopts it when the subclass has
   none. ([Ch 12])
3. **Assignment to a field was checked against the *narrowed* type.** This chapter's worked
   example, below. Fixed by `declaredMemberType`. ([Ch 13])
4. **`x == null` was rejected once narrowing had made the type non-nullable** — the checker
   had proved `x` was not null and then complained that comparing it to null was meaningless.
   One line: `if (isNullish(left) || isNullish(right)) return true;` at
   `src/frontend/checker/operator-types.ts:68`, at the head of `acceptsEquality`. ([Ch 10])
5. **Array-method callbacks were missing their index parameter**, and `sort`'s comparator was
   typed `-> int`. `arrayMethodSignature` (`infer.ts:664-690`) now builds every callback from
   `const visitor = ${element}, int` and types the comparator `-> float`. ([Ch 11])
6. **Method type strings dropped parameter names and optionality**, so named arguments and
   defaults failed on methods but worked on functions. `classMethodType`
   (`type-checker.ts:1414`) now emits `by?: int` and the parser side reads it. ([Ch 12])
7. **`splitTopLevel` did not track `<>`**, so `Promise<int | int>` split into garbage at the
   `|` and `await` stopped unwrapping. `src/core/type-text.ts:14-16` now counts `<` as an
   opener and `>` as a closer, exempting `->`. ([Ch 9])
8. **`Math.floor` and friends returned `float`** in a language with no float-to-int cast, so a
   rounded value could not be stored in an `int` and there was no spelling that would work.
   `floor`, `ceil`, `round`, `trunc` and `sign` return `int` now
   (`data/tera-language-spec.ts:4793-4797`). ([Ch 28])
9. **The scoping one, which was the largest.** A bare assignment inside a function is a
   function *local* at run time, and the checker was binding it in the block scope and looking
   names up past the function boundary. `Scope.boundary` (`binder.ts:25`, set by `createScope`
   at `:297-298`) now marks function, method and model-section scopes; `functionScope`
   (`type-checker.ts:1460-1464`) hoists new bindings to it and `lookupWithinBoundary`
   (`binder.ts:341-350`) stops assignment lookups there. ([Ch 8 § three-lines-that-decide-what-a-bare-x-means])

### The worked example: a field you cannot clear

Number 3 is worth walking, because it is the direct consequence of [Ch 13]'s narrowing and it
shows what "a checker bug the gate exposed" actually looks like from the outside.

A linked node whose `next` field is assigned and later cleared:

```
class Node:
  public constructor(v: int):
    this.v = v
    this.next = null
a = Node(1)
a.next = Node(2)
a.next = null
```

*Before.* The write on the last line was checked against the type `a.next` had been *narrowed*
to by the write on the line above — `Node` — so assigning `null` was reported as a type error.
Under `warn` that was one line of advice on a program that ran perfectly. Under the gate it
was a refusal to compile.

*Mechanism.* Narrowing and assignment-checking were reading the same map. [Ch 13] establishes
that a store to a field narrows the checker's belief about that field, which is correct for
*reads* — after `a.next = Node(2)`, reading `a.next` really does give a `Node`. It is wrong
for *writes*, because what a write must satisfy is the field's declared type, not whatever the
previous write happened to leave behind.

*Fix.* Split the two questions. `declaredTargetType` asks a different function for the type an
assignment target must accept:

```ts
function declaredTargetType(target: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const member =
    target.type === NodeType.MemberExpression || target.type === NodeType.OptionalMemberExpression;
  if (writesUnknownKey(target, bound, scope)) return "any";
  if (member) return declaredMemberType(target, bound, scope);
  const widest = target.type === NodeType.Identifier ? lookup(scope, String(target.name))?.widens : undefined;
  return widest ?? inferExpression(target, bound, scope);
}
```
— `src/frontend/checker/type-checker.ts:1466-1473`

The two branches are the same idea twice. For a member target, `declaredMemberType`
(`infer.ts:234`) goes to the class surface for the declared type instead of to the narrowed
binding. For an identifier target, `widens` does the same job for locals
([Ch 13 § the-widens-field]). Today the program is silent:

```
$ node dist/cli.js check -e 'class Node:
  public constructor(v: int):
    this.v = v
    this.next = null
a = Node(1)
a.next = Node(2)
a.next = null
print(a.v)'
$ echo $?
0
```

*Regression test.*
`[t: tests/frontend/checker/type-checker.test.ts > "keeps a declared nullable field as declared"]`
pins the field half — a `slot: int | null` still rejects a `string` after being narrowed to
`null` — and
`[t: tests/frontend/checker/type-checker.test.ts > "lets an assignment widen a narrowed binding back to its declared type"]`
pins the local half.

*The general rule.* **A narrowing is a fact about reads. It is not a fact about writes.** The
class of program this had been mistyping is every mutable optional field there is: a linked
list, a cache slot, a parent pointer, a `next` in any structure that is built and then torn
down. None of them could be compiled ahead of time, and nobody knew, because in `warn` mode a
warning on a working program is easy to ignore.

## What the checker actually hands downstream

After this chapter the checker is done, so it matters precisely what survived. Four artifacts
leave, and each has exactly one reader.

**`_paramInfo` and `_returnType`, written back onto the AST.** Two fields on function nodes,
holding type text. The parser writes them from annotations (five sites in
`src/frontend/parser/index.ts`); the checker *adds* to them, for arrows and function
expressions that had a contextual type and no annotation of their own, through
`adoptContextualSignature`:

```ts
  if (changed && adopted.length === (declared ?? adopted).length) node._paramInfo = adopted;
  if (!isUntypedName(returns) && typeof node._returnType !== "string") node._returnType = returns!;
```
— `src/frontend/ast/index.ts:322-323`

That function is called from three places, all in `type-checker.ts` (`:364`, `:847`, `:860`),
and all of them are arrow bodies. It is the only place in the checker that mutates the tree
the bytecode compiler will walk. The reader is one function:

```ts
  const info = fn._paramInfo;
  const returns = fn._returnType;
```
— `src/bytecode/register/compiler/functions.ts:170-171`

`declaredSignatureOf` (`functions.ts:165`) turns them into a `bytecode.DeclaredSignature` and
`functions.ts:715` hangs it on `innerFunc.declaredSignature`. That field is then read in
`src/optimizing/analyses/aot-legality.ts` (nine sites),
`src/optimizing/analyses/type-inference.ts`, the x64 and riscv64 lowerings, and the AOT driver
— and nowhere else. The interpreter does not read it. The baseline compiler does not read it.

**`ClassSurface[]`**, produced by `classSurfacesOf`, read by `buildClassTable` — and only when
`aot` is true, at `engine.ts:1201` and `:1425`, both guarded by a bare `if (aot)`. ([Ch 57])

**Canonical type text** from `cleanType`, read by `latticeFromDeclaredType` ([Ch 48]) and by
the symbol table ([Ch 74]).

**The `Diagnostic[]`**, read by `engine.ts` and by `src/cli/main.ts`, and by nothing else.

The consequence is worth stating plainly, because it is easy to assume otherwise: **the
interpreter and the baseline compiler read none of it.** The bytecode compiler walks the raw
AST, not the `SemanticProgram` the checker built; the checker's tree is a parallel structure
that dies with the check. Set `--typecheck off` and the interpreter produces exactly the same
answer, because nothing on its road ever consulted a type.

One asymmetry inside that: the module checker's own diagnostics do not respect the mode.

```ts
  private report(record: ModuleRecord, diagnostic: Diagnostic): void {
    this.diagnostics.push({ ...diagnostic, module: record.spec, path: record.path });
  }

  private error(record: ModuleRecord, line: number, column: number, message: string): void {
    this.report(record, { line, column, message, severity: "error" });
  }
```
— `src/frontend/modules/check.ts:157-163`

`ModuleChecker.error` hardcodes `"error"`, and `run()` gates only the *per-module type
checker* on `silent` (`check.ts:116-131`) — `checkImports` and `checkImportAssignments` run
regardless. So a bad import is reported as an error even under `--typecheck off`, and then, on
the run path, stored and never read:

```
$ node dist/cli.js --typecheck off main.tera        # 'from lib import nope'
2
$ node dist/cli.js compile main.tera -o main.exe
tera compile: 1:17 Module 'lib' has no export 'nope'
```

Same program, same mode, two answers — which is the whole chapter in one command pair.

## Soundness and completeness

> **New idea. Sound and complete.** A checker is **sound** if everything it accepts is safe:
> no program it passes goes wrong in the way the checker was supposed to prevent. It is
> **complete** if everything safe is accepted: no correct program is rejected. You get to pick
> one, in general, for any analysis over a language that can compute. A sound-and-incomplete
> checker has false alarms — it refuses programs that would have worked. A
> complete-and-unsound one has false silences — it passes programs that will not.

This checker chose neither cleanly, which is the honest answer and the one worth knowing. It
is deliberately incomplete: `q.shift()` after a guard that proved only one element is a real
program that runs correctly and is refused, and that refusal is the book's cold open. It is
also, in the places catalogued below, unsound: a single `any` inside a type disables checking
for every expression that type reaches, and a call to a function declared later in the file is
not checked at all.

The choice is invisible until the gate flips. Incompleteness under `warn` is a false alarm you
ignore. Incompleteness under the gate is a program you cannot build. That is precisely why 72
tests failed on the day it was set, and why the honest inventory that follows matters more
than it would in a language whose checker was advisory forever.

## The honest inventory: `any` is a hole with 32 doors

> **Unfinished.** `isUnknownish` (`src/frontend/checker/type-checker.ts:1058-1070`) suppresses
> 32 distinct checks. A single `any` in a union, an array element, or a tuple slot disables
> checking for every expression that type reaches. Cost of narrowing it: distinguishing "the
> user wrote `any`" from "the checker could not work it out", which needs a second sentinel
> threaded through `TypeName` — and `TypeName` is a string ([Ch 9]).

The predicate is thirteen lines and it recurses:

```ts
  isUnknownish(type: string, seen = new Set<string>()): boolean {
    const key = cleanType(type);
    if (seen.has(key)) return false;
    seen.add(key);
    const resolved = resolveType(key, this.bound.env);
    if (resolved === "any" || resolved === "unknown") return true;
    const parts = unionParts(resolved, this.bound.env);
    if (parts.length > 1) return parts.some((part) => this.isUnknownish(part, seen));
    const element = arrayElementType(resolved);
    if (element) return this.isUnknownish(element, seen);
    if (isTupleType(resolved)) return tupleTypes(resolved).some((item) => this.isUnknownish(item, seen));
    return false;
  }
```
— `src/frontend/checker/type-checker.ts:1058-1070`

It resolves aliases, answers true for `any` and `unknown`, and then recurses through union
parts, through array elements, and through tuple slots. So `int | any` is unknownish, and
`any[][]` is unknownish, and so is `(int | any)[]`.

`grep -c isUnknownish src/frontend/checker/type-checker.ts` answers 33: the definition, three
recursive calls inside it, and 29 lines of call sites carrying 32 calls. The symbol appears in
no other file. Every one of those 32 is an early `return` that abandons a whole check —
`checkBinary` at `:911`, the assignment check at `:1025`, the iteration check at `:504`, the
call-argument check at `:809`, and so on down the file.

The effect is easy to see:

```
$ node dist/cli.js check -e 'a: int = 1
b: bool = true
print(a - b)'
[eval]:3:11: error: Operator '-' cannot be applied to 'int' and 'bool'

$ node dist/cli.js check -e 'a: int | any = 1
b: bool = true
print(a - b)'
$ echo $?
0
```

One `any` in a union that also contains `int` and the operator check does not run. The same
holds through an array element: `xs: any[]` minus a `bool` is silent.

This is deliberate. Without it the gate would refuse most programs that call an untyped
builtin, since the specification table types a great many returns `"any"` — including
`shift`'s, which is why [Ch 1 § what-shift-answers] had to manufacture `int | undefined` in
`infer.ts` rather than read it from the spec. Making the gate usable meant making the checker
give up wherever it did not know, and `isUnknownish` is where it gives up. It is the largest
single gap in the contract, and it is the price of the contract existing at all.

The direct counterweight is one fuzz test:
`[t: tests/e2e/frontend/checker-spec-fuzz.test.ts > "fuzzes the typed expression surface that must not collapse to any"]`,
which asserts that a fully annotated expression surface keeps concrete types rather than
degrading into the hole.

## Single-pass, and why source order is semantics

> **Unfinished.** The checker walks `program.body` once, in source order (`check()` at
> `type-checker.ts:57-61`, then `checkStatements`). A call to a function declared *later*
> whose return type is *inferred* sees nothing and answers `any`. The identical program with
> the two declarations swapped reports the error. Cost of fixing: a declaration pre-pass that
> seeds every top-level signature before checking any body — which then needs a story for
> mutually inferred returns, i.e. a fixpoint ([Ch 14] already runs one, over
> a different question).

The demonstration is the same program twice.

```
$ node dist/cli.js check -e 'fn use() -> int:
  return later()
fn later():
  return "text"
print(use())'
$ echo $?
0

$ node dist/cli.js check -e 'fn later():
  return "text"
fn use() -> int:
  return later()
print(use())'
[eval]:4:10: error: Type 'string' is not assignable to return type 'int'
$ echo $?
1
```

`later()` returns a string. `use()` declares it returns `int`. In the first spelling the
checker reaches `use`'s body before it has bound `later`'s inferred return, so the call
answers `any`, `isUnknownish` fires, and the return check is skipped. In the second, `later`
has been seen, its return is known to be `string`, and the mismatch is reported at the exact
position of the call.

Under `warn` this is a curiosity. Under the gate it means **the order you write your functions
in changes whether your program compiles**, which is the kind of property a language usually
promises not to have. The reason it has not been fixed is structural rather than lazy: the
checker has no dependency order for value declarations. It has one for modules —
[Ch 15 § two-edge-sets] builds `initOrder` and `checkOrder` by running Tarjan over the import
graph — but nothing does the equivalent for the functions inside a module.

## The honest inventory: two more

> **Unenforced.** Excess properties in an object literal are never reported.
> `node dist/cli.js check -e 'interface P:` / `  x: int` / `p: P = { x: 1, y: 2 }` /
> `print(p.x)'` is silent and exits 0. Nothing in `objectAssignable` or
> `checkObjectExpression` compares the literal's field set against the target's — the
> structural rule checks that the *required* fields are present, not that no others are, which
> is the correct rule for a language whose classes are shapes ([Ch 12]) and the wrong one for
> catching a typo'd field name.

> **Unfinished.** A `FunctionExpression` with no expected type infers as the bare string
> `"Function"`:
>
> ```ts
>     case NodeType.FunctionExpression:
>       return expected ? signatureType(expected) : "Function";
> ```
> — `src/frontend/checker/infer.ts:101-102`
>
> `"Function"` resolves to nothing structural, so neither its parameters nor its return value
> is checked anywhere, and calls through it answer `unknown`. Arrow functions have a
> contextual path (`inferArrow`, `infer.ts:99-100`) and are checked; `function` expressions do
> not. A three-line file whose function expression returns a `string` from a body that is then
> added to `1` passes `tera check` in silence and prints `text1`. Cost: an inference path for
> `FunctionExpression` mirroring `inferArrow`, plus a decision about what an unannotated
> parameter means there.

## The cheapest exhaustive test

A gate this load-bearing needs an instrument that keeps it honest, and the answer is
`tests/e2e/frontend/checker-spec-fuzz.test.ts` — 1,467 lines, 23 tests, about 22 seconds.

> **New idea. Property-based testing.** An ordinary test states one input and one expected
> output. A property-based test states a rule that must hold for *every* input in some family,
> then generates members of that family and checks the rule. You stop writing cases and start
> writing invariants, which is the only way to cover a space too large to enumerate by hand —
> and, when the generator is seeded from a fixed constant, a failure is still exactly
> reproducible, which is what separates this from throwing random data at a program.

The generator is a linear congruential one, seeded from a constant:

```ts
let seed = 0xdecafbad;
```
— `tests/e2e/frontend/checker-spec-fuzz.test.ts:22`

with `seed = (seed * 1664525 + 1013904223) >>> 0` as the step (`:25`). Every case goes through
`checkSource(source, "strict")` — the two helpers `expectNoDiagnostics` (`:276`) and
`expectDiagnostic` (`:282`) both do, and so does every inline call. The suite therefore tests
the checker in exactly the mode the gate runs it in.

The invariant that applies to *every* diagnostic, regardless of what the case was testing, is
sixteen lines:

```ts
function expectDiagnosticsInSource(failures: Failure[], label: string, source: string, diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (!Number.isInteger(diagnostic.line) || !Number.isInteger(diagnostic.column)) {
      pushFailure(failures, label, source, `non-integer position ${JSON.stringify(diagnostic)}`);
    }
    if (diagnostic.line < 1 || diagnostic.line > source.split("\n").length) {
      pushFailure(failures, label, source, `line out of range ${JSON.stringify(diagnostic)}`);
    }
    if (diagnostic.column < 1 || diagnostic.column > lineText(source, diagnostic.line).length + 1) {
      pushFailure(failures, label, source, `column out of range ${JSON.stringify(diagnostic)}`);
    }
    if (diagnostic.severity !== "error") {
      pushFailure(failures, label, source, `expected strict error ${JSON.stringify(diagnostic)}`);
    }
  }
}
```
— `tests/e2e/frontend/checker-spec-fuzz.test.ts:45-60`

Integer line and column; line inside the source; column inside that line's length plus one;
severity exactly `"error"`. A checker that reports the right thing at the wrong place fails
here, and so does one that forgets to honour strict mode. All 23 tests route their diagnostics
through it, so every one of them pins the position and severity invariant in addition to
whatever it was written for. That last clause is the reason this file is the cheapest test in
the tree: the invariant costs nothing per case, and it is checked on every diagnostic 23 tests
can produce.

## The corpus is the spec

Four of the 23 do not sample. They enumerate `data/tera-language-spec.ts` itself:

- *"covers every builtin and chart signature from the language spec"* — iterates
  `Object.entries(TERA_BUILTINS)` and `Object.entries(TERA_CHART_METHODS)` (`:1091`, `:1117`)
  and then asserts coverage: `if (covered.builtins !== Object.keys(TERA_BUILTINS).length)` is a
  failure, and the same for charts (`:1143-1144`).
- *"covers every pseudo type method and every kind method from the language spec"* — the same
  shape over `TERA_PSEUDO_TYPES` and `TERA_KIND_METHODS`, with the coverage counters compared
  against the flattened method counts at `:1219-1222`.
- *"covers arity and named-argument contracts from the whole language spec"* — walks all four
  tables again for the call-shape rules.
- *"resolves every declared field of record-returning builtins (nested + array element)"* —
  walks the record returns and resolves each declared field.

The invariant that makes this work is [Ch 28]'s: the specification table is one source of
truth for the builtin surface. Add a builtin and the coverage counter no longer matches
`Object.keys(TERA_BUILTINS).length`, so the test fails until the new entry is checked. **A new
builtin is checked the day it is added, with no test to write** — which is the only reason a
23-test file can stand behind a gate that refuses binaries.

## What leaves

An **AST, unchanged in shape by the checker**. For three tiers the checker's diagnostics go
into `Engine.diagnostics` and, on the default `warn` path, are never printed by anything —
only `tera check` reports them, and it does so through a separate route that never constructs
an `Engine` ([Ch 1 § the-gate] carries that as a `> **Never runs.**`). For the fourth tier the
same tree either passes through or is replaced by a `TypecheckError` and no binary at all.
Either way [Ch 17 § what-a-bytecode-is-and-why-one-exists-here] receives a plain tree and cannot tell which mode
produced it: **the checker is not in the bytecode compiler's input path.**

What survives of Part II is deliberately small, and it survives as **text**. `_paramInfo` and
`_returnType` — mostly the parser's annotations, plus the contextual types
`adoptContextualSignature` adopted onto arrows — carried on the AST nodes themselves, to be
read once by `declaredSignatureOf` and turned into a `DeclaredSignature` that only the
optimizing tiers consult. `ClassSurface[]`, already converted into a class table and held on
the `Engine`, and only when `aot`. Canonical type text, waiting for the lattice in [Ch 48] and
the symbol table in [Ch 74]. And one boolean that [Ch 14 § one-flag-one-byte] earned,
`node.implicitAwait`, which Part III spends.

That closes Part II, and the hinge from its opener is the closing sentence too. Five artifacts
leave the checker; four of them are consumed by the optimizing road and none of them by the
interpreter. The fifth is a list of diagnostics whose emptiness one caller — `Engine`, on the
`aot` flag, in two places — treats as a licence to emit a native binary. That is the whole
ahead-of-time contract, and it is one field, one word, and two lines written twice.

## Verify it yourself

```bash
# the same sentence through all three doors, with three different prefixes
node dist/cli.js --typecheck strict docs/example/queue.tera; echo "exit=$?"
node dist/cli.js compile docs/example/queue.tera -o /tmp/queue.exe; echo "exit=$?"
node dist/cli.js check docs/example/queue.tera; echo "exit=$?"

# and the default mode: same program, same checker, no word about it
node dist/cli.js --typecheck warn docs/example/queue.tera; echo "exit=$?"
node dist/cli.js --typecheck off docs/example/queue.tera; echo "exit=$?"

# the flag is gone from compile and check, and help lists no Types group
node dist/cli.js compile docs/example/queue.tera --typecheck warn -o /tmp/queue.exe
node dist/cli.js help compile

# the worked example: an optional field you can clear again
node dist/cli.js check -e 'class Node:
  public constructor(v: int):
    this.v = v
    this.next = null
a = Node(1)
a.next = Node(2)
a.next = null
print(a.v)'; echo "exit=$?"

# source order is semantics: the same program, declarations swapped
node dist/cli.js check -e 'fn use() -> int:
  return later()
fn later():
  return "text"
print(use())'; echo "exit=$?"
node dist/cli.js check -e 'fn later():
  return "text"
fn use() -> int:
  return later()
print(use())'; echo "exit=$?"

# one any in a union switches the operator check off
node dist/cli.js check -e 'a: int = 1
b: bool = true
print(a - b)'; echo "exit=$?"
node dist/cli.js check -e 'a: int | any = 1
b: bool = true
print(a - b)'; echo "exit=$?"

# excess properties are never reported
node dist/cli.js check -e 'interface P:
  x: int
p: P = { x: 1, y: 2 }
print(p.x)'; echo "exit=$?"

# the gate's instrument: 23 tests, all through checkSource(source, "strict")
npx vitest run --project e2e tests/e2e/frontend/checker-spec-fuzz.test.ts

# the commit that flipped the gate
git show --stat da1f059 | tail -5
```

The first three print the same sentence under `6:18`, `tera compile: 6:18` and
`<absolute path>:6:18: error:` and all exit 1. The next two print `10` and exit 0. The
`--typecheck warn` compile answers `tera: unknown option '--typecheck' for 'compile' (see
'tera help compile')` and exits 2, and `help compile` shows Input, Output and Optimization and
no Types group. The `Node` program is silent. The two source-order programs differ: the first
exits 0, the second reports `Type 'string' is not assignable to return type 'int'` at 4:10.
The `int | bool` subtraction is reported; the `int | any | bool` one is not. The object literal
with the extra field is silent. The fuzz suite is 23 tests in about 22 seconds on one machine,
one run.

Two commands need a file. The `FunctionExpression` gap wants four lines saved outside the
repository — with an editor, not a shell heredoc, which eats backslashes — because a program
whose whole point is to type-check wrongly cannot be added to `docs/example/`
(`docs/CONVENTIONS.md` rule 1):

```
f = function(a):
  return "text"
;
print(f(1) + 1)
```

```bash
node dist/cli.js check fnexpr.tera    # silent, exit 0
node dist/cli.js fnexpr.tera          # text1, exit 0
```

The module-diagnostic asymmetry wants two files in one directory — `lib.tera` containing
`fn hello() -> int:` and `  return 1`, and `main.tera` containing `from lib import nope` and
`print(2)`:

```bash
node dist/cli.js --typecheck off main.tera        # 2, exit 0
node dist/cli.js compile main.tera -o main.exe    # tera compile: 1:17 Module 'lib' has no export 'nope', exit 1
```

## Tests that pin this

`tests/e2e/frontend/checker-spec-fuzz.test.ts` > `describe("checker fuzz invariants")` — all
23 call `checkSource(source, "strict")` and route their diagnostics through
`expectDiagnosticsInSource`, so every one of them also pins the position and severity
invariant:

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

The fourth — *"fuzzes the typed expression surface that must not collapse to any"* — is the
direct counterweight to the `isUnknownish` honesty item.

`tests/e2e/docs/book-examples.test.ts` > `describe("the two answers the book opens on")`:

- > "queue.tera runs in the interpreter but is refused ahead of time"
  — the gate itself: the same diagnostic, advice on one side and a refusal on the other.
- > "stats-refused.tera runs in the interpreter but is declined by the backend"
  — refusal at the other grain, per function rather than per program.

`tests/frontend/checker/type-checker.test.ts` — the two halves of the worked-example fix:

- > "keeps a declared nullable field as declared"
  — a field declared `int | null` still rejects a `string` after a narrowing store.
- > "lets an assignment widen a narrowed binding back to its declared type"
  — the same rule for a local, through `widens`.

`tests/e2e/language/types.test.ts` > `"supports off, warn, and strict modes"` — the only reader
of `Engine.diagnostics` in warn mode anywhere in the tree.

Unpinned claims, listed rather than asserted:

- That `TypeChecker.strict` has exactly one use, and that strict mode therefore adds no
  checks: **[unpinned]**. The claim is a grep, not a test.
- That an AOT compile checks even when `typecheck` is `"off"` (`engine.ts:1193`):
  **[unpinned]** as a direct assertion. It is exercised indirectly by every test that goes
  through `tests/helpers/aot-agreement.ts`, whose engines are all constructed
  `{ typecheck: "off" }`, but no test names the behaviour.
- That `Engine.compileAotFunctions` reaches neither gate: **[unpinned]**.
- The figure of 72 failing e2e tests: **[unpinned]**. It is a historical count from the change
  record for commit `da1f059`, not reproducible from the tree.
