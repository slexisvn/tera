# 15. Modules: two graphs, not one   ⟨I · B · J · N⟩

A package has to *run* before the submodules inside it, and it has to be *checked* after
them. Those two sentences are both true and they are not compatible with each other, because
one is a claim about initialization order and the other is a claim about dependency order, and
for a package and its own submodules those orders point in opposite directions. `pkg` cannot
exist as a namespace until `pkg/__init__.tera` has run, so `pkg` runs first. But
`pkg/__init__.tera` is the file that imports names *out of* `pkg/inner.tera`, so it is
`pkg.inner`'s types that `pkg` depends on, and `pkg.inner` must be checked first.

This engine does not compromise between them. It builds two edge maps over the same set of
modules, runs Tarjan's algorithm over each, and produces two orderings on the same
`ModuleGraph` record — `initOrder` and `checkOrder`. They differ by exactly one thing: the
init graph has an edge from every module to its parent package, and the check graph does not.
Two tests in the tree assert both orderings on identical input, and they come out reversed.

The instrument for the whole chapter is one flag. `--print-module-graph` prints every record
with its kind and its import targets, then the init order, then one line per cycle, and
nothing else. Everything below can be checked with it.

**What arrived.** From [Ch 14 § what-leaves]: the same AST the parser produced, mutated in
place by `analyzeEffects` — `node.async = true` on every function unit the effect fixpoint
decided must suspend, and `call.implicitAwait = true` on every call site that must await.
Both are per *file*. Nothing so far in this book has asked which files a program consists of.
From [Ch 8]: a `SemanticProgram` whose `Import` nodes carry `level` (how many leading dots),
`path` (the dotted segments), `alias` and `bindings` — four fields, and the only input this
chapter's resolver has.

## New idea: a module

> **New idea. A module, and a compilation unit.** A **module** is a file with three
> properties: a *name* other files can refer to it by, a *top level* that runs once, and a
> *published surface* — the subset of its names that other modules may use. It is not the same
> thing as a **compilation unit**, which is whatever a compiler processes in one go; in this
> engine a module is a compilation unit for the checker and *not* one for the native backend,
> which flattens every module in the program into one object file. The distinction is why
> [§ the-bug-an-imported-top-level-that-never-ran] below is a bug at all.

The chapter answers two questions and keeps them strictly apart.

*Where does this name's code live?* That is **resolution**: turning `shapes.area` or `..mathx`
into a canonical file path and a dotted spec. It is `src/frontend/modules/resolver.ts`, 217
lines, and it never reads a file's contents.

*When does its top level run?* That is **ordering**: `initOrder` and `checkOrder` in
`src/frontend/modules/graph.ts`, 446 lines, which is also where the files actually get parsed.

A third question sits quietly underneath both, and it is the one the checker cares about:
*what does the importing module know about it?* That is the **interface** —
`src/frontend/modules/interface.ts`, 274 lines — and it is a different answer from "everything
in the file", because a name beginning with an underscore is not published.

The running example for all of it is `examples/geometry/`, five files, the only program in the
tree that exercises every resolution rule at once:

```
main.tera             import shapes
                      from mathx import abs_int, max_int
                      from shapes.area import border_area as border
mathx.tera
shapes/__init__.tera  from .area import square_area, rect_area, border_area
                      from .volume import cube_volume, box_volume, prism_volume
shapes/area.tera      from ..mathx import square
shapes/volume.tera    from ..mathx import cube
                      from .area import rect_area
```

An absolute import, a from-import of two names, a from-import through a dotted path with an
alias, two relative imports at level 1, and two at level 2 that climb out of the package. It
runs:

```
$ node dist/cli.js examples/geometry/main.tera
floor area: 51
tank volume: 51
headroom: 5
report: 56
```

## Finding the root

Every resolution is relative to a project root, and the root is found by looking for a marker
file rather than by being told:

```ts
export function projectRootFor(fileSystem: ModuleFileSystem, entryPath: string): string {
  let directory = fileSystem.dirname(fileSystem.resolve(entryPath));
  for (;;) {
    if (fileSystem.isFile(fileSystem.join(directory, PROJECT_MANIFEST))) return directory;
    const parent = fileSystem.dirname(directory);
    if (parent === directory) return fileSystem.dirname(fileSystem.resolve(entryPath));
    directory = parent;
  }
}
```
— `src/frontend/modules/resolver.ts:36-44`

Walk up from the entry file's directory looking for `tera.json`. Reach the filesystem root
without finding one — `parent === directory` is the only termination condition that is not a
hit — and fall back to the entry's own directory.

A marker file and not a flag, because the same entry file must resolve the same way from any
working directory. `node dist/cli.js examples/geometry/main.tera` and
`node ../../dist/cli.js main.tera` run from inside `examples/geometry/` have to agree about
what `shapes` means, and a root derived from `process.cwd()` would not.
`[t: tests/frontend/modules/resolver.test.ts > "walks up to the directory holding tera.json"]`
and
`[t: tests/frontend/modules/resolver.test.ts > "falls back to the entry directory when no manifest exists"]`
pin the two arms.

## Three candidates, in order

The entire precedence rule for what a name may denote is three `if`s:

```ts
function moduleAt(
  fileSystem: ModuleFileSystem,
  target: string,
): { path: string; kind: ModuleKind } | null {
  const file = `${target}${MODULE_EXTENSION}`;
  if (fileSystem.isFile(file)) return { path: fileSystem.canonical(file), kind: "file" };
  const index = fileSystem.join(target, PACKAGE_INDEX);
  if (fileSystem.isFile(index)) return { path: fileSystem.canonical(index), kind: "package" };
  if (fileSystem.isDirectory(target)) {
    return { path: fileSystem.canonical(target), kind: "namespace" };
  }
  return null;
}
```
— `src/frontend/modules/resolver.ts:54-66`

`shapes.tera` would be a `"file"`. `shapes/__init__.tera` makes `shapes` a `"package"`. A bare
directory with no `__init__.tera` is a `"namespace"` — reachable *through*, but with no top
level of its own. In `examples/geometry/`, `shapes` is a package and `mathx` is a file, which
is exactly what `--print-module-graph` reports in the square brackets.

The consequence of the ordering is that a file and a directory of the same name are not an
ambiguity — the file wins, silently, every time
`[t: tests/frontend/modules/resolver.test.ts > "prefers a module file over a package directory of the same name"]`.

There is a fourth `ModuleKind`, `"native"`, and it does not go through `moduleAt` at all.
`resolveAbsolute` (`resolver.ts:158-176`) checks `this.natives` *first*, before any base, and
returns a record whose `path` is `null`. Crucially it does not let a real file shadow one: if
the name is registered as native *and* a file exists for it under any base, the resolver
raises `Cannot shadow native module 'name'`
`[t: tests/frontend/modules/resolver.test.ts > "refuses a file that shadows a native module"]`.
Native modules are also the only kind from which a relative import is meaningless, and
`resolveRelative` says so:
`Cannot use a relative import from native module '<spec>'`
`[t: tests/frontend/modules/resolver.test.ts > "rejects a relative import from a native module"]`.

## Bases, and where peta comes in

`ModuleResolver.bases` (`resolver.ts:102`, built in the constructor at `:106-113`) is the
project root first, then any `searchPaths`, resolved to absolute and deduplicated through a
`Set`. `resolveAbsolute` tries each in order and returns the first hit, so **the root always
wins** over anything installed
`[t: tests/frontend/modules/resolver.test.ts > "prefers the project root over a search path"]`,
and falls through when it has nothing
`[t: tests/frontend/modules/resolver.test.ts > "falls through to a search path when the root has no match"]`.

The search paths are where the `peta` package manager enters, and the seam is small enough to
state completely. `searchPathsForEntry` (`src/frontend/packages.ts:80-86`) finds the project
root for the entry and appends one directory — `tera_packages` — if it exists
`[t: tests/frontend/packages.test.ts > "appends the packages directory of the project holding the entry"]`,
and appends it *after* any explicit `--module-path`, so an explicitly named path also outranks
it
`[t: tests/frontend/packages.test.ts > "keeps every module path ahead of the packages directory"]`.
`installedPackagesIn` (`:88-98`) reads `tera_packages/.peta/state.json`, and `parseState`
(`:42-52`) refuses on the very first line to interpret a file whose `stateVersion` is anything
other than `2` — it returns an empty list rather than a partial one
`[t: tests/frontend/packages.test.ts > "ignores a state file written by a different state version"]`.

That is the whole of it: four constants, one directory name, one JSON file, one version
number. Per [Conventions § 19] the package manager is a boundary, not a chapter — what crosses
it is a list of installed package names and a directory to add to `bases`, and this book
describes it by that interface and stops.
`[t: tests/frontend/packages.test.ts > "resolves a project module ahead of an installed package of the same name"]`
is the rule that matters to a reader: your own file always beats an installed one.

## Relative imports, and the name a module ends up with

`resolveRelative` (`resolver.ts:185-208`) starts from the importer's directory — *except* when
the importer is a namespace, where it starts from the directory itself, because a namespace's
"path" already is a directory — and then applies one `dirname` per dot beyond the first. So
`from .area import …` inside `shapes/__init__.tera` looks in `shapes/`, and
`from ..mathx import square` inside `shapes/area.tera` climbs to the project root
`[t: tests/frontend/modules/graph.test.ts > "resolves relative imports from inside a package"]`,
`[t: tests/frontend/modules/graph.test.ts > "resolves a parent-relative import"]`.

Two things then happen to the answer, and both are about *naming* rather than finding.

First, the path is checked against the bases. `specOf` returns `null` for a path that lies
outside every base, and `resolveRelative` turns that into
`Relative import '..x' escapes the project root`
`[t: tests/frontend/modules/graph.test.ts > "reports a relative import that escapes the project root"]`.
`specOf` is also where the *longest* base wins when several contain the target — it keeps the
best spec seen so far and only replaces it from a strictly longer base
(`resolver.ts:119-135`), which is what
`[t: tests/frontend/modules/resolver.test.ts > "names a file by the innermost base that holds it"]`
asserts.

Second, and less obvious, `owningPackage` (`resolver.ts:210-216`) renames the target after the
package the *importer* was reached as:

```ts
  private owningPackage(from: ResolvedModule, level: number): string | null {
    if (from.spec === ENTRY_SPEC || from.spec.length === 0) return null;
    const segments = from.spec.split(".");
    const owner = from.kind === "file" ? segments.slice(0, -1) : segments;
    const kept = owner.slice(0, owner.length - (level - 1));
    return kept.length === 0 ? null : kept.join(".");
  }
```
— `src/frontend/modules/resolver.ts:210-216`

The point of it is that one file must have one spec no matter how it was reached. If
`shapes/__init__.tera` reaches `area.tera` as `.area`, the result is named `shapes.area` —
not `area` — because the importer's own spec was `shapes`. `level - 1` is subtracted so a
parent-relative import climbs the spec by exactly as many segments as it climbed the
directory tree
`[t: tests/frontend/modules/resolver.test.ts > "follows the package the importer was reached as"]`,
`[t: tests/frontend/modules/resolver.test.ts > "climbs out of the package for a parent import"]`,
`[t: tests/frontend/modules/resolver.test.ts > "keeps the outer name when the importer was reached through the outer base"]`.

## One file, one record

Naming is only half of identity. The other half is `intern`:

```ts
  private intern(resolved: ResolvedModule, chain: readonly string[]): MutableRecord {
    const existing = resolved.path === null
      ? this.bySpec.get(resolved.spec)
      : this.byPath.get(resolved.path);
    if (existing !== undefined) return existing;

    const record: MutableRecord = {
      spec: resolved.spec,
      path: resolved.path,
      kind: resolved.kind,
      source: "",
      ast: EMPTY_AST,
      program: { body: [] },
      bindings: new Map(),
      imports: [],
      chain: [...chain, resolved.spec],
      parsed: resolved.kind === "native" || resolved.kind === "namespace",
    };
```
— `src/frontend/modules/graph.ts:256-273`

**The identity is the canonical path, not the spec** — except when there is no path, which is
native modules only, since a namespace does have a real directory. That single choice is what
makes two of the tested behaviours fall out: a file imported by two different modules is
loaded once
`[t: tests/frontend/modules/graph.test.ts > "loads a file only once when two modules import it"]`,
and a path spelled with mixed separators is still one record
`[t: tests/frontend/modules/resolver.test.ts > "resolves a path with mixed separators to one record"]`,
because `fileSystem.canonical` has already normalized it. So has the entry file, which is why
importing the entry by name does not load it twice
`[t: tests/frontend/modules/resolver.test.ts > "loads the entry file once even when another module imports it by name"]`.

The `parsed` flag is set in the same object literal, and it is a small decision with a visible
consequence. `native` and `namespace` records are born already parsed, so `intern` never
pushes them onto the queue (`:279`) and `load` returns immediately (`:281`). A namespace
directory therefore has a `path` that is stored, printed, used for relative resolution — and
never read.

The `chain` field is the record's provenance: every intern extends the importer's chain by one
spec. When a resolution fails, `ModuleGraphError` turns it into a trail:

```ts
export class ModuleGraphError extends Error {
  constructor(message: string, readonly chain: readonly string[] = []) {
    super(chain.length > 1 ? `${message} (imported by ${chain.join(" -> ")})` : message);
```
— `src/frontend/modules/graph.ts:76-79`

One import deep and you get the bare message; two or more and you get
`(imported by a -> b -> c)`
`[t: tests/frontend/modules/graph.test.ts > "reports an unresolved module with the import chain"]`.

## Two things a from import might name

`from pkg import inner` is ambiguous, and the ambiguity cannot be resolved by looking at the
import statement. `inner` may be an exported *binding* of `pkg` — a function, a value, a class
— or it may be a *submodule* `pkg/inner.tera`. Which one it is depends on what is inside
`pkg/__init__.tera`, and at the moment the import is resolved that file may not have been
parsed yet.

The engine's answer is to defer. `resolveImport` records each binding with `submodule: null`,
and after the queue has drained, `linkSubmoduleBindings` (`graph.ts:341-360`) walks every
recorded import again. For each binding whose owner does *not* export that name, it calls
`resolveOwnedSubmodule` (`:362-365`) — which only tries at all if the owner is a package or a
namespace — and, if that resolves, interns the new module and rewrites the binding with
`submodule: <spec>`.

Interning a new module refills the queue. So the driver is a loop over a loop:

```ts
  build(): ModuleGraph {
    const entry = this.intern(this.resolveEntry(), []);
    if (this.entrySource !== undefined) entry.source = this.entrySource;
    this.drain();
    while (this.linkSubmoduleBindings()) this.drain();
    return this.finish(entry);
  }
```
— `src/frontend/modules/graph.ts:244-250`

`linkSubmoduleBindings` returns `this.queue.length > 0` — "did I discover anything?" — and
`drain` parses whatever it discovered, which may itself name more submodules. The loop
terminates because `intern` is idempotent on a canonical path.

The precedence is the important part and it is exactly one line, `if
(owner.bindings.has(binding.imported)) return binding;`: **an exported name beats a
same-named submodule**
`[t: tests/frontend/modules/graph.test.ts > "prefers an exported name over a same-named submodule"]`.
The submodule route is the fallback
`[t: tests/frontend/modules/graph.test.ts > "binds a submodule named in a from-import"]`, and
the checker knows not to complain about it
`[t: tests/frontend/modules/check.test.ts > "allows a submodule import that is not an exported name"]`.

## New idea: a strongly connected component

> **New idea. A strongly connected component.** In a directed graph, a **strongly connected
> component** is a maximal set of nodes in which every node can reach every other. A node with
> no cycle through it is a component of size one. A cycle is a component of size greater than
> one. **Tarjan's algorithm** finds all of them in a single depth-first pass, and it has a
> property that makes it the right tool here rather than merely a correct one: it emits
> components in **reverse topological order**. A component is only closed when the search has
> finished with everything it can reach, so by construction every component a node depends on
> has already been emitted. Collect the components in the order they come out and you have a
> dependency-respecting order for free, with cycles collapsed into single units instead of
> reported as errors.

`tarjan` (`graph.ts:161-215`) is an explicit-stack implementation. There is no recursion in it
at all — the depth-first search keeps its own `work` array of `{ node, next }` frames — which
matters because a deep chain of imports would otherwise be bounded by the host's JavaScript
stack rather than by memory.

One line in it is doing work a reader will skip past:

```ts
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) break;
      }
      component.sort((left, right) => index.get(left)! - index.get(right)!);
      components.push(component);
```
— `src/frontend/modules/graph.ts:204-212`

Popping the stack gives the component's members in an order that depends on the traversal;
sorting them by *discovery index* makes it deterministic. Two builds of the same program
produce the same `initOrder`
`[t: tests/frontend/modules/graph.test.ts > "produces the same init order across builds"]`.
Keep that sort in mind — [§ what-a-cycle-is-and-is-not] and the honesty item below both turn
on it.

## Two edge sets

Here is the centre of the chapter. `importEdges` (`graph.ts:367-380`) builds the obvious map:
one edge per import target, plus one per resolved submodule binding, filtered to specs that
are actually in the graph. Then `finish` builds a second map from it:

```ts
  private finish(entry: MutableRecord): ModuleGraph {
    const specs = [...this.bySpec.keys()];
    const importEdges = this.importEdges();
    const initEdges = new Map<string, string[]>();
    for (const [spec, targets] of importEdges) {
      const parent = parentSpec(spec);
      initEdges.set(
        spec,
        parent !== null && this.bySpec.has(parent) ? [...targets, parent] : targets,
      );
    }
```
— `src/frontend/modules/graph.ts:382-392`

`initEdges` is `importEdges` **plus an edge from every module to its parent package**.
`parentSpec` (`:102-106`) is the dotted name up to the last dot, and `null` for a native spec
or a top-level name.

Now run the two graphs on the same three files. `pkg/__init__.tera` says
`from .inner import shared`; `pkg/inner.tera` defines `shared`; `main.tera` says
`from pkg import shared`.

In the **check** graph the edges are `__main__ → pkg` and `pkg → pkg.inner`. Three components
of one node each, emitted in reverse topological order:
`[pkg.inner, pkg, __main__]`
`[t: tests/frontend/modules/graph.test.ts > "checks a package after the submodules it imports"]`.
The submodule is checked first, which is right, because `pkg`'s interface is built out of
names it re-exported from `pkg.inner`.

In the **init** graph `pkg.inner` gains an edge back to `pkg`. Now `pkg → pkg.inner → pkg` is a
cycle, so the two are one component, and the order inside the component is by discovery index
— the search reached `pkg` first — so:
`[pkg, pkg.inner, __main__]`
`[t: tests/frontend/modules/graph.test.ts > "still initialises the package before its submodule"]`.

Two tests, identical input, reversed answers. That is the whole design in six lines of test
source.

`examples/geometry/` shows the same thing at scale:

```
$ node dist/cli.js --print-module-graph examples/geometry/main.tera
entry: __main__
  __main__ [file] -> shapes, mathx, shapes.area
  shapes [package] -> shapes.area, shapes.volume
  mathx [file]
  shapes.area [file] -> mathx
  shapes.volume [file] -> mathx, shapes.area
init order: mathx -> shapes -> shapes.area -> shapes.volume -> __main__
```

`shapes` runs before `shapes.area` even though `shapes` is the one that imports from it.
`mathx` runs first because it depends on nothing and both submodules depend on it.

### Why the obvious design fails

*(Why the obvious design fails.)*

The obvious design is one order. Build the import graph, topologically sort it, use the answer
for both purposes; if there is a cycle, report it and stop. Every step of that is defensible
and the result cannot work.

It cannot work because the two orders are answering different questions about the same edge.
When `pkg/__init__.tera` writes `from .inner import shared`, the *type* dependency runs from
`pkg` to `pkg.inner`: to know what `pkg` publishes you must first know what `pkg.inner`
publishes. But the *existence* dependency runs the other way: `pkg.inner` is only reachable as
a name because `pkg` exists as a package, and a program that says `import pkg` and then reads
`pkg.inner.thing` needs `pkg`'s namespace object to have been published before anything can be
hung off it. `publishModuleNamespaces` (`src/api/engine.ts:1289-1302`) is the code that hangs
it, and it runs per record inside the `initOrder` walk.

So one ordering has to invert the other for exactly the parent/child edge and agree everywhere
else. Adding the parent edge to a *copy* of the map and running the same algorithm twice does
precisely that, in nine lines, with no special case anywhere else in the system: the parent
edge makes package and submodule mutually reachable, which collapses them into one component,
which takes the question of ordering *between* them away from topology and hands it to the
component's own tiebreak.

Which is where the design's soft spot is.

> **Broken.** The parent edge guarantees that a package and its submodules land in **one
> component**. It does not guarantee that the package comes **first** inside that component.
> That is decided by `component.sort(by discovery index)` at `graph.ts:211`, and the discovery
> index is assigned by a depth-first search whose starting successors are the *entry file's*
> imports, in source order. Change which module the entry names first and the order inside the
> component flips. Measured on this tree, 2026-09-07, on three files: `pkg/__init__.tera`
> containing `base = 10` and then `from .inner import doubled`, `pkg/inner.tera` containing
> `from pkg import base` and then `doubled = base * 2`. An entry of `import pkg` /
> `print(pkg.doubled)` reports `init order: pkg -> pkg.inner -> __main__` and prints `20`. An
> entry of `from pkg.inner import doubled` / `print(doubled)` reports
> `init order: pkg.inner -> pkg -> __main__` and fails at run time with
> `cannot access 'base' from module 'pkg.inner' before module 'pkg' finished initializing`,
> exit 1. Same three module files, same edges, different entry import — two outcomes.
> `tera check` accepts both and exits 0 in each case. The same flip is visible without any
> failure in `examples/geometry/`: replace `main.tera` with a single
> `from shapes.area import border_area as border` and the init order becomes
> `mathx -> shapes.area -> shapes -> shapes.volume -> __main__`, with the submodule ahead of
> its package. Cost of fixing: sort each component by spec depth before discovery index, so a
> parent always precedes its children within a component — about one line, plus a decision
> about what to do when a component contains two unrelated packages. **[unpinned]** — the two
> tests that pin the orderings both use an entry that names the package first, so neither
> reaches this case.

## What a cycle is and is not

`cycles` is computed from the *check* graph's components, not the init graph's — which is
right, because the init graph deliberately manufactures cycles that are not cycles in the
program:

```ts
    const cycles = importComponents.filter(
      (component) =>
        component.length > 1 || (importEdges.get(component[0]!) ?? []).includes(component[0]!),
    );
```
— `src/frontend/modules/graph.ts:422-425`

A component of more than one module, or a single module that imports itself
`[t: tests/frontend/modules/graph.test.ts > "keeps a two-module cycle in one component"]`,
`[t: tests/frontend/modules/graph.test.ts > "reports a self import as a cycle"]`,
`[t: tests/frontend/modules/graph.test.ts > "has no cycles for an acyclic graph"]`.

And then — nothing. A cycle is *reported*, not refused. `--print-module-graph` prints a
`cycle:` line and the program runs:

```
$ node dist/cli.js --print-module-graph parity.tera
entry: __main__
  __main__ [file] -> even
  even [file] -> odd
  odd [file] -> even
init order: even -> odd -> __main__
cycle: even -> odd
true
```

Two modules whose functions call each other across the import, and it answers. That is the
whole design position:
`[t: tests/e2e/language/modules.test.ts > "supports mutually recursive functions across a cycle"]`
pins it running, and
`[t: tests/frontend/modules/check.test.ts > "checks a cycle without hanging"]` pins the checker
walking it — which the `checkOrder` loop does without special-casing, because Tarjan already
flattened the component into a list.

What replaces the cycle error is a much narrower one, raised at the moment of harm rather than
at the moment of structure: reading a value from a module whose top level has not finished.

```
$ node dist/cli.js main.tera
cannot access 'y' from module 'a' before module 'b' finished initializing
```
`[t: tests/e2e/language/modules.test.ts > "reports a cycle read of a value that is not initialised yet"]`

The cycle is legal; the *premature read* is the error. That is a strictly better rule, because
mutually recursive *functions* across a cycle are common and harmless — the calls happen after
both top levels have run — while a top-level read across one is always wrong regardless of
whether the modules form a cycle in the abstract.

## What a module publishes

`bindingsOf` (`graph.ts:108-116`) walks the top level of the semantic program and
`collectBinding` (`:118-155`) turns eight `SemanticNode` kinds into a `ModuleBinding`:
`Function`, `Class`, `Model`, `Interface`, `TypeAlias`, `Var`, `Destructure` — and `Import`
itself:

```ts
    case "Import":
      if (node.bindings.length === 0) {
        const local = node.alias ?? node.path[0];
        if (local !== undefined) add(local, "module", node.span);
        return;
      }
      for (const binding of node.bindings) add(binding.local, "value", binding.span);
      return;
```
— `src/frontend/modules/graph.ts:143-150`

A name you imported is a name you publish. That is what makes `shapes/__init__.tera` work at
all: it contains nothing but two `from .` imports, and every name it pulls in becomes part of
its own surface
`[t: tests/frontend/modules/graph.test.ts > "re-exports names brought in by an import"]`,
`[t: tests/frontend/modules/graph.test.ts > "records declarations of every top-level kind"]`,
`[t: tests/frontend/modules/graph.test.ts > "records top-level bare assignments as bindings"]`.

The entire privacy model is one line:

```ts
export function isExportable(name: string): boolean {
  return !name.startsWith("_");
}
```
— `src/frontend/modules/graph.ts:98-100`

No keyword, no export list, no visibility modifier. A leading underscore and the name is not
published
`[t: tests/frontend/modules/graph.test.ts > "marks underscore-prefixed names as not exported"]`.
`examples/geometry/mathx.tera` uses it deliberately: `_negate` is a helper `abs_int` calls, and
it is invisible to every importer
`[t: tests/e2e/language/modules.test.ts > "lets a module keep private state that the importer cannot see"]`.

`moduleInterfaceOf` (`interface.ts:158-191`) then sorts each *exported* binding into one of
four lists, checking in this order: a `type` binding whose name is in `env.aliases` becomes an
`alias`; a name in `env.interfaces` becomes an `interface` (and stops there if the binding kind
was `interface`); a name with a signature in `bound.root.signatures` becomes a `builtin`;
anything else becomes a `value` carrying its type text. Those four lists are the module's
published surface, and they are what the next module in `checkOrder` will be handed.

## What the importer sees

`importedSurface` (`interface.ts:241-274`) turns a list of resolved imports into one surface
for the importing module, and it has two shapes.

`from X import a as b` goes through `renameSignature` (`:209-225`), which searches builtins,
aliases and interfaces under the *imported* name and republishes the entry under the *local*
one, falling back to a plain value if nothing matched. So an imported function keeps its full
signature under its new name, and calls through the alias are type-checked
`[t: tests/frontend/modules/check.test.ts > "renames an aliased import in the importing module"]`,
`[t: tests/frontend/modules/check.test.ts > "checks a call against the imported signature"]`.
A private name is simply absent from the owner's surface, so it never arrives
`[t: tests/frontend/modules/check.test.ts > "does not leak a private name into the importing module"]`.

`import X` takes the other branch:

```ts
  for (const entry of imports) {
    if (entry.local !== null) {
      if (!claim(entry.local)) continue;
      surface.values.push({ name: entry.local, type: ANY_TYPE });
      const bound = entry.boundSpec === null ? undefined : interfaces.get(entry.boundSpec);
      if (bound !== undefined) mergeSurface(surface, qualifiedSurface(bound, entry.local));
      continue;
    }
```
— `src/frontend/modules/interface.ts:253-260`

The local name is published as a value typed `any`, and then `qualifiedSurface` (`:227-232`)
re-publishes every builtin and value of the target under the dotted name `X.f`. So
`shapes.square_area(4)` type-checks as a call to a real signature — the checker never resolves
a member on `shapes`, it looks up the flat name `shapes.square_area`
`[t: tests/frontend/modules/check.test.ts > "types a call made through a namespace import"]`.

That trick buys real checking cheaply and it has two visible holes.

> **Unfinished.** The namespace local itself is typed `any`
> (`interface.ts:256`), so member access on it is unconstrained. The *qualified* names are
> typed — `node dist/cli.js check` on a program calling `shapes.square_area("x")` reports
> `Type 'string' is not assignable to parameter 'side: int'` at the argument — but a member
> that does not exist is not an error at all: `shapes.no_such_fn(1)` in the same file produces
> no diagnostic and exits 0. Verified on this tree, 2026-09-07. Cost of fixing: publishing the
> module as an `ObjectShape` in `env.interfaces` instead of a value plus a set of dotted names,
> which changes how dotted-name lookups resolve in `infer.ts` for every import in the tree.

> **Unfinished.** `qualifiedSurface` (`interface.ts:227-232`) re-publishes only `builtins` and
> `values`. An `interface`, a `class` or a type alias reached through a namespace import —
> `shapes.Point` used as a *type* — is not in the importing module's surface at all. Only the
> `from X import Point` spelling carries a shape across.

And one more, which turns out to be worse than the outline for this chapter assumed.

> **Broken.** `importedSurface`'s `claim` closure (`interface.ts:247-251`) is a `Set` of local
> names: the first import to bind a name wins and every later one is dropped, with no
> diagnostic. The runtime has no such rule — the last binding written into the module's cells
> wins. So the two disagree. Measured on this tree, 2026-09-07: `a.tera` defines
> `fn f(n: int) -> int`, `b.tera` defines `fn f(s: string) -> string`, and an entry containing
> `from a import f`, `from b import f`, `print(f("hello"))` **runs and prints `hello!`** — the
> interpreter called `b.f` — while `node dist/cli.js check` on the same file reports
> `Type 'string' is not assignable to parameter 'n: int'`, which is `a.f`'s signature, and
> `tera compile` refuses the program with the identical sentence and writes no binary. A
> correct program is refused, and the refusal describes a function the program does not call.
> `checkImportAssignments` reports a *write* to an imported binding; nothing reports a
> duplicate *import*. Cost of fixing: one diagnostic in `ModuleChecker.checkImports` when two
> imports claim the same local name, plus deciding whether the rule is "first wins" (matching
> the checker) or "last wins" (matching the runtime) — the two halves must be made to agree
> before either can be reported. **[unpinned]** —
> `tests/e2e/language/modules-differential.test.ts > "keeps two modules with the same function name apart"`
> covers the *aliased* spelling (`as ah`, `as bh`), which is exactly the case that avoids the
> collision.

## The checker's own diagnostics

`ModuleChecker.run` (`check.ts:114-141`) is one loop over `checkOrder`. For each record it
runs its own three checks, then calls `checkProgram` with `imports: importedSurface(...)`,
tags every returned diagnostic with the module's spec and path, stores the module's interface
for the modules that come after it, and adopts its type aliases.

The three checks are the ones the per-module checker structurally cannot make, because they
are about a *relationship* between two files.

`checkImports` (`:165-197`) reports an unknown export, with a suggestion when a near miss
exists, and a private-name access. Both messages are worth quoting because they are the
specification:

```
$ node dist/cli.js check priv.tera
…\priv.tera:1:20: error: '_secret' is private to module 'shapes'
…\priv.tera:1:29: error: Module 'shapes' has no export 'square_are'; did you mean 'square_area'?
```

The suggestion is a Levenshtein edit distance — `editDistance` (`check.ts:34-46`) is an
in-place two-row implementation — gated at `SUGGESTION_DISTANCE = 3` (`:32`), so a wild guess
is not offered. Note the columns: 20 and 29, the positions of the two specifiers inside the
`from` clause, not the start of the line
`[t: tests/frontend/modules/check.test.ts > "points the diagnostic at the specifier"]`,
`[t: tests/frontend/modules/check.test.ts > "reports an unknown export"]`,
`[t: tests/frontend/modules/check.test.ts > "suggests a near miss"]`,
`[t: tests/frontend/modules/check.test.ts > "reports an import of a private name"]`.

`checkNativeImport` (`:199-218`) does the same against a native module, building its exported
set from all four external lists. `checkImportAssignments` (`:220-234`) reports
`Cannot assign to imported binding 'x'`
`[t: tests/frontend/modules/check.test.ts > "reports assignment to an imported binding"]`,
`[t: tests/frontend/modules/check.test.ts > "reports assignment to an aliased module binding"]`.

And then `adoptAliases`, which is the one place in the module system that chooses silence over
an error:

```ts
  private adoptAliases(env: TypeEnv): void {
    for (const [name, alias] of env.aliases) {
      if (this.disputed.has(name)) continue;
      const seen = this.types.aliases.get(name);
      if (seen === undefined) {
        this.types.aliases.set(name, alias);
        continue;
      }
      if (seen.type === alias.type) continue;
      this.disputed.add(name);
      this.types.aliases.delete(name);
    }
  }
```
— `src/frontend/modules/check.ts:143-155`

A type alias defined in any module is adopted into one program-wide `TypeEnv`, which is what
lets `type Id = int` cross an import without being re-declared
`[t: tests/frontend/modules/check.test.ts > "carries an imported type alias into the importing module"]`.

> **Unfinished.** `adoptAliases` makes aliases effectively global and unqualified. Two modules
> that both define `type Id = int` agree by accident. Two that disagree hit the last three
> lines: the name goes into `disputed`, is **deleted for every module**, and is never
> re-adopted — with no diagnostic anywhere. A program that type-checked before a second module
> declared a conflicting alias will silently start resolving that name as unknown. Cost:
> per-module alias environments, which means `resolveType` needs to know which module it is
> resolving for — a parameter threaded through most of the checker.

## The bug: an imported top level that never ran

*Symptom.* A native binary built from a multi-module program produced wrong values. Not a
crash, not a refusal — wrong numbers, because only `__main__`'s top level had executed. Any
module that computed a value at load time, or printed something, contributed nothing.

*Mechanism.* The interpreter walks `initOrder` and calls `interpreter.execute` once per record
(`src/api/engine.ts:1317-1321`), so a module's top level is just another compiled function
that gets run. The ahead-of-time path went through `compileAotModuleInRuntime`
(`engine.ts:1006-1050`), which compiled every record — and then emitted an entry point that
called none of them. The front end's ordering was a correct answer that one back end simply
did not implement.

*Fix.* Two halves. `compileAotModuleInRuntime` renames each non-entry module's top-level code
to `cellKey(record.spec, MODULE_INIT_NAME)` — `<spec>#tera_module_init`, with
`MODULE_INIT_NAME = "tera_module_init"` at `engine.ts:145` — and collects the names into
`moduleInits`, in `initOrder`. Then `startModules` (`src/optimizing/drivers/aot.ts:242-266`,
run as the `module-start` stage at `:694`) unshifts one `irCallKnownFunction` per initializer
into the **front of the entry graph's first block**:

```ts
    calls.push(stamp(irCallKnownFunction({ name } as never, [])));
  }
  for (const call of calls) call.block = block;
  block.nodes.unshift(...calls);
  graph.rebuildUses();
```
— `src/optimizing/drivers/aot.ts:261-265`

*Regression test.*
`[t: tests/e2e/optimizing/aot/modules.test.ts > "runs an imported module's top level before the program"]`
compiles a two-module program to a real PE executable, runs it, and asserts stdout is
`module loaded\n5\n` — the imported module's `print` first, then the entry's. Its helper also
asserts `program.moduleInits` is `[]`, which is how it pins that the IR rewrite is what ran
rather than the fallback. The geometry example agrees end to end, though nothing in `tests/`
compiles it: **[unpinned]**, verified by hand on this tree, 2026-09-07 —
`node dist/cli.js compile examples/geometry/main.tera -o geo.exe && ./geo.exe` prints the same
four lines the interpreter does.

*General rule.* **An ordering computed by the front end is a contract, and every back end has
to implement it — not just the one you were looking at.** The front end had already published
`initOrder` on a public record; the interpreter honoured it; nothing anywhere asserted that a
second consumer existed, so the second consumer quietly did not.

There is a link-time fallback for the same job — `moduleInitTable` emits a null-terminated
array of function pointers into the C header
`[t: tests/optimizing/target/symbols.test.ts > "declares the function pointer type the table holds"]`
— and it is reached by one line:

```ts
  const moduleInits = started ? [] : inits.map((name) => backend.symbolOf(name));
```
— `src/optimizing/drivers/aot.ts:885`

It is the *fallback*, not the primary path. Reading `startModules` back, `started` is false in
exactly three situations: there are no initializers, a module was refused (below), or there is
no `tera_program` unit at all — which is the `--entry`-named build, where the IR rewrite has no
entry graph to unshift into.

## When even that is refused

`startModules` will not perform the rewrite if any initializer can throw while it loads:

```ts
    if (canReject(unit.graph)) {
      return {
        started: false,
        refused:
          `module ${name} can throw while it loads, and the compiler cannot yet carry that ` +
          `throw out of a module; keep this part interpreted`,
      };
    }
```
— `src/optimizing/drivers/aot.ts:253-260`

`start.refused` is pushed as a failure against `PROGRAM_ENTRY_NAME` (`:736-737`), so the entry
function is skipped and the program does not build. Verified on this tree, 2026-09-07, with a
two-module program whose imported module opens with a `try` / `throw` / `catch`:

```
$ node dist/cli.js main.tera
x
module loaded
5
$ node dist/cli.js compile main.tera -o main.exe
tera compile: warning: skipped 'tera_program' (module side#tera_module_init can throw while it loads, and the compiler cannot yet carry that throw out of a module; keep this part interpreted)
tera compile: x64-windows backend cannot emit: entry function tera_program could not be lowered to native code: module side#tera_module_init can throw while it loads, and the compiler cannot yet carry that throw out of a module; keep this part interpreted
```

Two messages for one cause, which is the recurring shape [Conventions § 5] asks for: the
warning names the module and the reason, the error names the downstream symptom — the entry
function could not be lowered — and then repeats the cause verbatim.
`[t: tests/e2e/optimizing/aot/modules.test.ts > "declines the program when a module's top level cannot be emitted"]`
pins it, matching on `/cannot emit/`, which is the outer sentence.

> **Unfinished.** `startModules` abandons the entire IR-level initializer rewrite if *any* one
> module can throw while loading. It is all-or-nothing per program, not per module: nine clean
> initializers and one that can reject means none of the ten are wired in, and since the
> refusal is recorded against the entry function the whole compile fails. Cost: emitting the
> call sequence for the modules that can be started and falling back to the link-time table
> only for the rest, which requires the two mechanisms to agree on ordering — currently they
> are alternatives, not a mixture.

## What leaves

A `ModuleGraph` (`src/frontend/modules/graph.ts:59-65`): the `entry` record; `modules`, a map
from spec to `ModuleRecord` interned by canonical path, each carrying its source, AST,
`SemanticProgram`, bindings and resolved imports; the two orderings `initOrder` and
`checkOrder`; and `cycles`. Every tier reads `initOrder` — the interpreter walks it in
`runModuleGraph` (`src/api/engine.ts:1304-1334`), and the native road walks the same order in
`compileAotModuleInRuntime` to build `moduleInits`.

And from `checkModuleGraph` (`src/frontend/modules/check.ts:237-242`), a `ModuleCheckResult`
(`:25-30`) with four fields: `interfaces`, one `ModuleInterface` per module; `types`, the
merged program-wide `TypeEnv` that `adoptAliases` built; `classes`, the `ClassSurface[]` of
[Ch 12] now flattened across every module in the program rather than one file; and
`diagnostics`, a `readonly ModuleDiagnostic[]` — each entry an ordinary `Diagnostic` widened
with the `module` spec and `path` it came from (`:14-17`).

That last field is what [Ch 16 § one-field-one-word] receives, and this chapter deliberately does not
decide what it means. `ModuleChecker.run` computes `mode` from the caller's options and passes
it straight through to `checkProgram`; the array it returns is the same array whether the
program will be interpreted or compiled. Whether a non-empty `diagnostics` is advice printed to
stderr or a refusal with no binary is one caller's decision, made in `engine.ts`, and it is the
whole ahead-of-time contract.

## Verify it yourself

```bash
# the interpreter's four lines
node dist/cli.js examples/geometry/main.tera

# five records, four kinds, and the package before the submodules it imports from
node dist/cli.js --print-module-graph examples/geometry/main.tera

# the same four lines from a native binary, which is what the initializer fix bought
node dist/cli.js compile examples/geometry/main.tera -o geo.exe && ./geo.exe

# resolution, graph, interface and packages (77 tests across four files)
npx vitest run --project unit tests/frontend/modules/ tests/frontend/packages.test.ts

# the same rules, run in the interpreter (30 tests)
npx vitest run --project e2e tests/e2e/language/modules.test.ts
```

The second prints
`init order: mathx -> shapes -> shapes.area -> shapes.volume -> __main__`. The third prints
`floor area: 51`, `tank volume: 51`, `headroom: 5`, `report: 56` — identical to the first.

The three honesty items measured in this chapter each need files that are deliberately not in
`docs/example/`, for the reason [Ch 1 § two-answers-then-and-now] gives: a program written to
disagree cannot be pinned to one expected output. Write them with your editor — not with a
shell heredoc, which eats backslashes — outside the repository.

**The init-order flip.** In a directory `ord/`, put `pkg/__init__.tera` = `base = 10` then a
blank line then `from .inner import doubled`; `pkg/inner.tera` = `from pkg import base` then a
blank line then `doubled = base * 2`. Then two entry files: `good.tera` = `import pkg` /
`print(pkg.doubled)`, and `bad.tera` = `from pkg.inner import doubled` / `print(doubled)`.

```bash
node dist/cli.js --print-module-graph ord/good.tera   # pkg -> pkg.inner -> __main__, prints 20
node dist/cli.js --print-module-graph ord/bad.tera    # pkg.inner -> pkg -> __main__, then the error
node dist/cli.js check ord/bad.tera; echo "exit=$?"   # silent, exit 0
```

**The duplicate import.** `a.tera` = `fn f(n: int) -> int:` / `  return n + 1`; `b.tera` =
`fn f(s: string) -> string:` / `  return s + "!"`; `dup.tera` = `from a import f` /
`from b import f` / blank / `print(f("hello"))`.

```bash
node dist/cli.js dup.tera            # hello!  -- the runtime used b.f
node dist/cli.js check dup.tera      # Type 'string' is not assignable to parameter 'n: int'
node dist/cli.js compile dup.tera -o dup.exe; echo "exit=$?"   # same sentence, exit 1
```

**The untyped namespace member.** With a `shapes/__init__.tera` exporting
`fn square_area(side: int) -> int`, an entry of `import shapes` /
`print(shapes.square_area("x"))` / `print(shapes.no_such_fn(1))` reports one diagnostic, for
the argument type, and says nothing at all about the member that does not exist.

## Tests that pin this

`tests/frontend/modules/resolver.test.ts` — resolution, with no filesystem:

- > `"walks up to the directory holding tera.json"` and > `"falls back to the entry directory when no manifest exists"` — `projectRootFor`'s two arms.
- > `"prefers a module file over a package directory of the same name"` — `moduleAt`'s precedence.
- > `"resolves a registered native module"`, > `"refuses a file that shadows a native module"`, > `"rejects a relative import from a native module"` — the fourth kind.
- > `"prefers the project root over a search path"` and > `"falls through to a search path when the root has no match"` — `bases`, in order.
- > `"rejects an unknown module"` — `Cannot resolve module '<name>'`.
- > `"gives the entry file the __main__ spec"`, > `"loads the entry file once even when another module imports it by name"`, > `"resolves a path with mixed separators to one record"` — identity by canonical path.
- > `"follows the package the importer was reached as"`, > `"keeps the outer name when the importer was reached through the outer base"`, > `"climbs out of the package for a parent import"`, > `"names a file by the innermost base that holds it"`, > `"gives a package and its relative submodule one namespace in the graph"` — `owningPackage` and `specOf`.

`tests/frontend/modules/graph.test.ts` — loading and ordering:

- > `"checks a package after the submodules it imports"` and > `"still initialises the package before its submodule"` — **the chapter's thesis, on identical input.**
- > `"loads a single entry module"`, > `"loads an imported sibling module"`, > `"loads a package through its __init__"`, > `"reaches a submodule through a namespace package"`.
- > `"initialises dependencies before dependents"` and > `"initialises a package before any of its submodules"`.
- > `"binds a submodule named in a from-import"` and > `"prefers an exported name over a same-named submodule"` — `linkSubmoduleBindings`' precedence.
- > `"resolves relative imports from inside a package"`, > `"resolves a parent-relative import"`, > `"reports a relative import that escapes the project root"`.
- > `"loads a file only once when two modules import it"`, > `"reports an unresolved module with the import chain"`.
- > `"resolves dotted namespace imports and binds the root package"`, > `"binds the full module when an alias is given"`.
- > `"keeps a two-module cycle in one component"`, > `"reports a self import as a cycle"`, > `"has no cycles for an acyclic graph"`, > `"produces the same init order across builds"` — Tarjan, and the discovery-index sort.
- > `"marks underscore-prefixed names as not exported"`, > `"records top-level bare assignments as bindings"`, > `"records declarations of every top-level kind"`, > `"re-exports names brought in by an import"` — `isExportable` and `collectBinding`.
- > `"resolves a registered native module without touching the disk"` and > `"refuses to let a file shadow a native module"`.

`tests/frontend/modules/check.test.ts` — the cross-module diagnostics:

- > `"reports an unknown export"`, > `"suggests a near miss"`, > `"reports an import of a private name"`, > `"points the diagnostic at the specifier"`, > `"accepts an import of an exported name"`.
- > `"reports assignment to an imported binding"` and > `"reports assignment to an aliased module binding"`.
- > `"allows a submodule import that is not an exported name"`.
- > `"checks a call against the imported signature"`, > `"accepts a call that matches the imported signature"`, > `"renames an aliased import in the importing module"`, > `"does not leak a private name into the importing module"` — `importedSurface` and `renameSignature`.
- > `"types a call made through a namespace import"`, > `"accepts a well-typed namespace call"`, > `"types a re-exported name reached through a package namespace"` — `qualifiedSurface`.
- > `"carries an imported type alias into the importing module"` — `adoptAliases`, agreeing arm only.
- > `"checks a cycle without hanging"`, > `"still reports an unknown export inside a cycle"`, > `"checks a package after the submodules it re-exports"`.

`tests/frontend/packages.test.ts` — the `peta` seam, six tests:

- > `"appends the packages directory of the project holding the entry"`, > `"keeps every module path ahead of the packages directory"`, > `"resolves a project module ahead of an installed package of the same name"`, > `"resolves an installed package when nothing shadows it"`, > `"reads the installed set peta recorded"`, > `"ignores a state file written by a different state version"`.

`tests/e2e/language/modules.test.ts` — the same rules, run:

- > `"runs each module body exactly once"`, > `"initialises dependencies before dependents"`, > `"runs a package __init__ before its submodule"`, > `"re-exports a name through a package __init__"`, > `"resolves a relative import inside a package"`, > `"names a package's own submodule after the package, not after the outer root"`.
- > `"lets a module keep private state that the importer cannot see"` — `isExportable` at run time.
- > `"supports mutually recursive functions across a cycle"` and > `"reports a cycle read of a value that is not initialised yet"` — the cycle position, both halves.
- > `"shares one class definition across modules"`, > `"does not fold a member access when a local shadows the module name"`.

`tests/e2e/language/modules-differential.test.ts` > `describe("multi-module programs agree across tiers")` — eleven tests, including > `"calls an imported numeric function in a hot loop"`, > `"reads an imported module-level constant in a hot loop"`, > `"runs mutually recursive functions across an import cycle"` and > `"keeps two modules with the same function name apart"`.

`tests/e2e/optimizing/aot/modules.test.ts` — the fourth tier:

- > `"runs an imported module's top level before the program"` — the regression test for the initializer bug, run as a real PE executable.
- > `"declines the program when a module's top level cannot be emitted"` — the `canReject` refusal.
- > `"lists only init functions that actually lowered"`, > `"omits the table when no module init survives"`, > `"never lists the entry module"` — the link-time fallback table.
- > `"gives two modules with the same function name distinct symbols"` and > `"resolves the cross-module call to the qualified symbol"` — one object file, many modules.

Unpinned, in order of how much they would cost to pin:

- **`examples/geometry/` compiled to a native binary agreeing with the interpreter: [unpinned]** — `grep -rn "geometry" tests/` returns nothing. The mechanism is pinned by the AOT modules test above; this specific program is not.
- **The init-order flip inside a package component: [unpinned]** — both ordering tests use an entry that names the package first.
- **The duplicate-import divergence: [unpinned]** — the differential test that comes closest uses distinct local aliases.
- **The relationship between `initOrder` and `checkOrder`: [unpinned].** They are two independent Tarjan runs over two independently built maps, and nothing asserts anything about the pair — not that `checkOrder` is a topological order of `importEdges`, not that every runnable module appears exactly once in each, not that the two contain the same set. The two tests at `tests/frontend/modules/graph.test.ts:330-355` pin one three-module case by example. There is no invariant check.
