# 2. What tera looks like   ⟨I · B · J · N⟩

You cannot follow a program through a compiler you cannot read. The next eighty-one
chapters take twenty-four lines of tera apart into tokens, trees, bytecode, feedback
vectors, SSA graphs, WebAssembly and x64 assembly, and every one of those chapters assumes
you can look at the original line and know what it was asking for. So this chapter is the
one place in the book that teaches the surface.

It teaches only as much of it as `docs/example/stats.tera` and its seven variations need.
That is a deliberate limit. The surface tera declares is much wider than any of the four
tiers implements — `data/tera-language-spec.ts` is 8,251 lines and names thirty-six
primitive types, five of which belong to compilers that live in other repositories — and a
tour of all of it would teach a language this book never compiles. What follows is the
subset that appears in the example set, plus every place where that subset *looks* like
JavaScript and is not.

There are four such places, and each one costs a later chapter real work. tera has no
binding keyword: `let`, `const` and `var` exist only to be rejected. Blocks are made of
indentation, which means the lexer manufactures structure tokens that no character in the
file produced. Builtin methods are `snake_case` — `.to_fixed(2)`, not `.toFixed(2)` — and
nothing in the checker will tell you when you get that wrong. And a class is a *shape*, not
a name, so two unrelated classes with the same members are interchangeable everywhere,
including at a call site the optimizer is trying to specialize.

**What arrived.** From `[Ch 1 § what-leaves]`: `docs/example/queue.tera` and the two
answers it produces — `10` from the interpreter, a refusal from the native compiler; a map
of the four tiers naming what they share (one bytecode, one object model, one set of type
facts) and what they must agree on (the answer); and the instruments this book measures
with — `differential()`, the tier badges, the five honesty markers, and "Verify it
yourself". The reader knows the book's stakes and nothing at all about the language.

## Blocks are indentation

A colon opens a block. Indentation keeps it open. A line at a shallower column closes it.
There are no braces, no semicolons, and no `end`.

> **New idea.** *The offside rule.* In a brace language the block structure is written down
> — `{` and `}` are characters in the file, and the lexer hands them to the parser like any
> other punctuation. In an offside language the block structure is implied by column
> positions, so somebody has to turn columns into structure before the parser sees
> anything. In tera that somebody is the lexer. It maintains a stack of open indentation
> levels and *manufactures* three token kinds that correspond to no characters at all:
> `Indent` when a line is further right than the level on top of the stack, `Dedent` for
> each level it pops when a line moves left, and `Newline` at the end of a logical line.
> The parser then reads a perfectly ordinary token stream in which blocks are delimited.

Those three kinds sit in the token enumeration next to the ones that do come from
characters:

```ts
export const TokenType = {
  Number: "Number",
  String: "String",
  Identifier: "Identifier",
  Keyword: "Keyword",
  Punctuator: "Punctuator",
  Newline: "Newline",
  Indent: "Indent",
  Dedent: "Dedent",
  RegExp: "RegExp",
  TemplateLiteral: "TemplateLiteral",
  EOF: "EOF",
} as const;
```
— `src/frontend/lexer/index.ts:7-19`

The manufacturing itself is twenty lines, and it is worth reading once because every
indentation error you will ever see in tera comes out of it:

```ts
    if (delimiterDepth === 0) {
      if (pendingBlock) {
        if (indent > indents[indents.length - 1]) {
          indents.push(indent);
          out.push(layout(TokenType.Indent, lineNo, indent + 1));
        }
        pendingBlock = null;
      } else {
        let dedented = false;
        while (indents.length > 1 && indent < indents[indents.length - 1]) {
          indents.pop();
          out.push(layout(TokenType.Dedent, lineNo, indent + 1));
          dedented = true;
        }
        if (dedented && indent !== indents[indents.length - 1]) {
          throw new SyntaxError(
            `[Lexer] unindent does not match any outer indentation level at ${lineNo}:${indent + 1}`,
          );
        }
      }
```
— `src/frontend/lexer/offside.ts:70-89`

Three things in that fragment matter later. `delimiterDepth === 0` is the guard that lets
an expression span lines inside brackets without the layout rule firing — which is why the
array literal on line 20 of `stats.tera` could be broken across lines and still parse.
`pendingBlock` is set by the previous line ending in `:`, so an `Indent` is only ever
emitted where a block was actually opened. And the `throw` is the one place a *lexer*, not
a parser, rejects a program for structural reasons:

```
$ node dist/cli.js -e 'if true:
  print(1)
 print(2)'
[Lexer] unindent does not match any outer indentation level at 3:2
```

[t: `tests/frontend/lexer.test.ts` > `"rejects a dedent that matches no enclosing block"`]

Because blocks are offside-only, the JavaScript spellings that use braces for a block are
refused rather than reinterpreted. An arrow function takes an expression body and nothing
else; object method shorthand and object getters and setters with brace bodies are all
parse errors
[t: `tests/frontend/parser/language.test.ts` > `"rejects a brace block body (arrows take an expression body)"`,
> `"rejects method shorthand with a brace body (blocks are offside-only)"`,
> `"rejects object getter/setter with a brace body"`].
Braces still mean object literal, and brackets still mean array literal and subscript;
they are simply never a block.

Comments are `#` to end of line, and `//` and `/* … */` as in C. All three are skipped in
the lexer before layout runs, so a comment can never change a block's shape.

What the offside rule costs is not obvious from any of this, and `[Ch 5 §
the-program-that-indents-but-does-not-nest]` is the chapter that pays for it: a token
stream that *looks* correctly nested can come from a file whose indentation does not nest
at all.

## Declaring a name

There are exactly two ways to introduce a name, and neither has a keyword in front of it:

```
total: float = 0.0     # annotated
total = 0.0            # inferred from the initializer
```

`stats.tera` uses the second form everywhere. The first form appears where a reader —
or the ahead-of-time compiler — needs the type spelled out.

Every JavaScript programmer's first tera program fails, and it fails usefully:

```
$ node dist/cli.js -e 'let x = 1'
[Parser] 'let' is not a tera keyword; declare a variable as 'name: type = value' or 'name = value' at 1:1
```

That sentence is not an accident of parsing. `let`, `const` and `var` are deliberately
*in* the keyword set — `RESERVED_KEYWORDS` at `src/frontend/lexer/index.ts:35` is spread
into `KEYWORDS` at line 38 — precisely so the parser can recognise them and give advice
instead of a shrug. The advice is one function:

```ts
  rejectReservedKeyword(tok: ParserToken): never {
    this.error(
      `'${String(tok.value)}' is not a tera keyword; declare a variable as ` +
        `'name: type = value' or 'name = value'`,
      tok,
    );
  }
```
— `src/frontend/parser/index.ts:340-346`

It is called from two places, `src/frontend/parser/index.ts:506` and `:1682`, which between
them cover statement position, function bodies, `for` initializers and expression position.
Fifteen tests pin the five positions across the three words
[t: `tests/frontend/parser/language.test.ts` > `"rejects 'let' at statement position"`,
> `"rejects 'let' inside a function body"`, > `"rejects 'let' in a for initializer"`,
> `"rejects 'let' in expression position"`, > `"reports where 'let' appears"` — and the
same five titles for `const` and `var`, generated by a loop over the three words]. The
rejection is on the whole token, not a prefix, so `lets: int = 4` is an ordinary
declaration
[t: `tests/frontend/parser/language.test.ts` > `"leaves an identifier that merely starts with a reserved word alone"`].

The two spellings are not the same node, which is the first place this book must obey
convention 4 — the code's names win, even when they mislead. The annotated form produces a
node the tree calls `LetDeclaration`, after a keyword the language does not have. The bare
form produces no declaration node at all; it is an assignment expression:

```
$ node dist/cli.js --print-ast -e 'x: int = 4
y = 5'
Program
  body: [2]
    LetDeclaration  name="x" declaredType="int"
      init: Literal  value=4 kind="number"
    ExpressionStatement
      expression: AssignmentExpression
        target: Identifier  name="y"
        value: Literal  value=5 kind="number"
```

`LetDeclaration` is the name in `src/frontend/ast/index.ts:8`, in the bytecode compiler's
dispatch at `src/bytecode/register/compiler/statements.ts:226`, and in every scope
computation in between. The book keeps calling it that. The asymmetry is not cosmetic: a
bare `name = value` looks identical whether the name is new or being reassigned, and
deciding which it is falls to a scope analysis rather than to the parser. `[Ch 20 §
scopes-closures-and-classes-in-bytecode]` is where that decision is made and where it once
went wrong.

Reassignment and compound assignment work as expected — `acc *= i` and `i += 1` in
`examples/control_flow.tera:8` and `:25`, `total += this.values[i]` in `stats.tera:10`. A
compound assignment is its own node kind, `CompoundAssignmentExpression`, not sugar the
parser expands; `[Ch 18 § update-and-compound-assignment]` shows why keeping it whole matters to the
bytecode.

## Functions

A function declaration is `fn`, a parameter list, an arrow, a return type, and a colon:

```
fn square(n: int) -> int:
  return n * n
```
— `examples/control_flow.tera:2-3`

The arrow is part of the *declaration* syntax, not a type expression that happens to appear
there. That distinction matters as soon as a function type is used as a parameter or return
annotation, where the arrow appears again in a different role:

```
fn adder(base: int) -> fn(int) -> int:
  fn add(x: int) -> int:
    return base + x
  return add
```
— `examples/control_flow.tera:11-14`

Three things are visible there. Function declarations nest, and the inner one closes over
`base`. `fn(int) -> int` is a type, written with the same arrow. And a function is a value:
`return add` hands back the inner function, and `add10 = adder(10)` on line 16 binds it.

Parameters and return types are optional. `fn report(s) -> string:` — the entry point of
`docs/example/stats-poly.tera:24` — is a perfectly legal function with an undeclared
parameter, and the interpreter runs it without complaint. It is also the single most common
reason a program that runs will not compile ahead of time. The native compiler reads
parameter types off the declaration first and off the call sites second, and where it can
find neither it declines the function rather than guessing. `[Ch 56 §
legality-and-the-art-of-refusing-well]` is that analysis; the point here is only that a
missing annotation is a run-time non-event and an ahead-of-time blocker, and that
`stats.tera` annotates everything for exactly that reason.

Arrow functions exist and take an expression body only: `() => this` at
`examples/design-pattern/16_iterator.tera:10`, `(a, b) => a + b`, `(a, b = 1) => a + b`
with a default. There is no block-bodied arrow, because there is no brace block.

## Classes

A class opens with `class`, a name, optional `extends` and `implements`, and a colon.
Members carry a visibility keyword and optional modifiers. The three visibilities and the
three modifiers are declared in one twenty-four-line file, which is the only place in the
tree that names them:

```ts
export const CLASS_VISIBILITIES = ["public", "private", "protected"] as const;

export type ClassVisibility = (typeof CLASS_VISIBILITIES)[number];

export const DEFAULT_CLASS_VISIBILITY: ClassVisibility = "public";
export const CLASS_STATIC_MODIFIER = "static";
export const CLASS_ABSTRACT_MODIFIER = "abstract";
export const CLASS_ASYNC_MODIFIER = "async";
export const CLASS_MEMBER_MODIFIERS = [
  CLASS_STATIC_MODIFIER,
  CLASS_ABSTRACT_MODIFIER,
  CLASS_ASYNC_MODIFIER,
] as const;
```
— `src/core/class-visibility.ts:1-13`

The lexer imports `CLASS_VISIBILITIES` and `CLASS_ABSTRACT_MODIFIER` into `KEYWORDS`
(`src/frontend/lexer/index.ts:72-73`) and leaves `CLASS_STATIC_MODIFIER` out. That single
omission has a visible consequence:

```
$ node dist/cli.js -e 'static = 9
print(static)'
9

$ node dist/cli.js -e 'public = 9
print(public)'
[Parser] Unexpected token 'public' (Keyword) at 1:1
```

`static` is an ordinary identifier that the class parser recognises positionally; `public`
is a keyword everywhere. `DEFAULT_CLASS_VISIBILITY` being `"public"` means an unmarked
member is public, and the parser records `explicitVisibility` separately so a later pass
can tell "public because it says so" from "public because nothing said otherwise"
[t: `tests/frontend/parser/language.test.ts` > `"marks fields declared without a visibility keyword as not explicit"`,
> `"parses visibility modifiers and class fields"`,
> `"rejects duplicate and conflicting class member modifiers"`,
> `"parses abstract classes and abstract member signatures"`].

Fields are not declared. They are created by assigning to `this` in the constructor —
`this.name = name` and `this.values = values` at `stats.tera:3-4` are what make `Series`
have two fields, and their types come from the constructor's parameter annotations.
Accessors are members with `get` or `set` in front of the name, and the setter may take a
typed parameter:

```
  public get fahrenheit():
    return this.c * 9.0 / 5.0 + 32.0
  public set fahrenheit(f: float):
    this.c = (f - 32.0) * 5.0 / 9.0
```
— `examples/classes.tera:65-68`

Read as `t.fahrenheit`, written as `t.fahrenheit = 212.0`
[t: `tests/frontend/parser/language.test.ts` > `"getter and setter"`,
> `"accepts a return type annotation on a class getter"`,
> `"accepts a typed parameter on a class setter"`].

Visibility is checked, not decorative, and it is checked on the ordinary run path — not
only in strict mode:

```
$ node dist/cli.js -e 'class Box:
  public constructor(v: int):
    this.v = v
  private secret() -> int:
    return this.v

b = Box(3)
print(b.secret())'
Cannot access private member 'secret' of 'Box'
```

Exit status 1, and nothing printed. The example set has no private member — every member of
`Series` is public — so this is one of the few places the chapter reaches for an inline
program rather than a file, per convention 2. Under `--typecheck strict` the same source
gives `8:7 Cannot access private member 'secret' of 'Box'`, and under `tera check` the same
sentence again with a `<path>:8:7: error:` prefix: one sentence, three prefixes
[t: `tests/frontend/checker/symbols.test.ts` > `"hides a private member from outside the class"`,
> `"offers a private member inside its own class"`].

Inheritance is `extends`, and a subclass constructor calls `super(...)` — in
`examples/classes.tera:12` with a *named* argument, `super(name="circle")`. Methods that
`return this` chain, which `acc.deposit(100.0).withdraw(30.0).deposit(5.5)` on line 45
relies on. `throw` takes any value, including a bare string: `throw "insufficient funds"`
at line 38.

> **New idea.** *Structural typing.* In most class-based languages a class is a *name*: a
> value is a `Series` because it was constructed by `Series`, and a function that wants a
> `Series` will not take anything else. In tera a class is a *shape*. A value satisfies
> `Series` when it has the members `Series` declares, whoever built it. `implements` checks
> members rather than recording a relationship, and it can be omitted entirely — an
> interface-typed parameter accepts any class with matching members, with no `implements`
> anywhere:
>
> ```
> $ node dist/cli.js --typecheck strict -e 'interface Named:
>   name() -> string
>
> class A:
>   public name() -> string:
>     return "a"
>
> fn call(n: Named) -> string:
>   return n.name()
>
> print(call(A()))'
> a
> ```
>
> That is why `docs/example/stats-poly.tera` can define `Series` and `Constant` with no
> relationship between them and pass both to the same `report`. It is convenient here and
> expensive later: `[Ch 12 § new-idea-a-shape]` shows what the checker must do
> instead of comparing names, and `[Ch 57 § objects-without-a-runtime-type]` shows what the
> native compiler must do when there is no runtime type tag to ask.

## Contextual keywords

> **New idea.** *A contextual keyword* is a word that is reserved in one syntactic position
> and an ordinary identifier in every other. `static` is one: it introduces a class member
> modifier immediately after a visibility keyword, and it is a variable name anywhere else.
> The lexer does not know about positions — it only classifies words — so a contextual
> keyword is a word the lexer deliberately does *not* tokenize as a keyword, leaving the
> parser to recognise it from where it appears.

tera has two lists of keywords and they do not agree. `KEYWORDS` in
`src/frontend/lexer/index.ts:37-81` holds 47 words: the three reserved rejects, plus 44
more including `fn`, `model`, `and`, `or`, `not`, the three visibilities and `abstract`.
`TERA_KEYWORD_GROUPS` in `data/tera-language-spec.ts:280-343` holds 54 words across five
groups — declaration, control, operator, constant, variable — under a
`satisfies Record<TeraKeywordGroup, string[]>` constraint that checks the group *names* and
nothing about the words. The two lists share 43 words. Eleven words appear in the spec and
are not tokenized as keywords: `interface`, `type`, `signal`, `computed`, `resource`,
`implements`, `static`, `get`, `set`, `as` and `effect`. Four words are keywords to the
lexer and absent from the spec: `let`, `const`, `var` and `function`.

Measured on this tree, nine of those eleven are ordinary identifiers in every position —
including statement position, as parameter names, and as object keys. `type` and
`interface` are ordinary identifiers as parameter names and object keys, and start a
declaration at statement position:

```
$ node dist/cli.js -e 'static = 1
get = 2
set = 3
implements = 4
signal = 5
effect = 6
as = 7
computed = 8
resource = 9
print(static, get, set, implements, signal, effect, as, computed, resource)

fn f(type: int, interface: int) -> int:
  return type + interface

print(f(10, 20))
o = { type: 2, interface: 3, get: 4, set: 5, as: 6 }
print(o.type, o.interface, o.get, o.set, o.as)'
1 2 3 4 5 6 7 8 9
30
2 3 4 5 6

$ node dist/cli.js -e 'type = 1
print(type)'
[Parser] Expected Identifier, got '=' (Punctuator) at 1:6
```

Nine spec keywords used as module-level variables; the two that cannot be — `type` and
`interface` — used as parameter names; five used as object keys
[t: `tests/frontend/parser/language.test.ts` > `"reads every keyword a program might want as a field name"`,
> `"keeps a keyword key apart from the statement it spells"`].

Following convention 4, this book calls all of these keywords, and says where each one
binds.

> **Unenforced.** Nothing in the tree checks that `TERA_KEYWORD_GROUPS`
> (`data/tera-language-spec.ts:280-343`) and `KEYWORDS`
> (`src/frontend/lexer/index.ts:37-81`) describe the same language. The `satisfies`
> constraint on the spec table constrains only the five group names. Two consumers read the
> spec list and neither reads the lexer's: `src/cli/repl/language.ts:52` feeds it to tab
> completion, and `tools/editor/src/language-data.ts:14` feeds it to the editor's syntax
> grammar. So the disagreement is visible to users in both directions — the editor
> highlights `static`, `type` and `as` as keywords in a file where they are variables, and
> does not highlight `function`, which really is one. Closing it costs one derived table
> and one decision: which list is the authority. Nothing else in the tree would have to
> change.

## Interface and type

An `interface` declares member signatures with no bodies, indented under a colon. A `type`
alias names a structure. The densest sample of both in the tree is
`examples/design-pattern/16_iterator.tera`, whose first sixteen lines are all declaration:

```
type IteratorStep = { done: bool, value: int | null }

interface IntIterator:
  next() -> IteratorStep

class RangeIterator implements IntIterator:
  public constructor(start: int, stop: int):
    this.current = start
    this.stop = stop
    this["@@iterator"] = () => this
  public next() -> IteratorStep:
    if this.current >= this.stop:
      return { done: true, value: null }
    value = this.current
    this.current += 1
    return { done: false, value: value }
```
— `examples/design-pattern/16_iterator.tera:1-16`

`next() -> IteratorStep` inside the interface is a bare signature: a name, a parameter
list, an arrow and a return type, with no `fn` and no body. `int | null` is a union type
written with `|`. `float[]` is an array type. `null` and `undefined` are two distinct type
names, not synonyms — a distinction the interpreter can afford to blur and the native
compiler cannot, which `[Ch 22 § two-absence-values]` and the AOT chapters on
two absence values both return to.

> **New idea.** *An annotation is text.* `float[]`, `int | null` and `IteratorStep` look
> like type expressions, and in most compilers they would be parsed into structured type
> terms. In tera they are carried as normalized **strings**, and type equality is string
> equality. `_paramInfo` in an AST dump shows it directly: the constructor's parameters
> print as `string` and `float[]`, the strings themselves. That decision shapes the whole
> checker — there are no type variables and no unification — and `[Ch 9 § the-one-line-decision]`
> defends it.

> **Unfinished.** The declared surface is far wider than any tier supports.
> `TERA_PRIMITIVE_TYPES` (`data/tera-language-spec.ts:345-381`) names 36 types. Four of
> them — `int`, `float`, `string`, `bool` — are what the example set uses, and `stats.tera`
> itself annotates only two of those, `string` and `float`. Five others,
> `Tensor`, `DataFrame`, `Trainer`, `Dataset` and `MLModel`, are not implemented in this
> repository at all: they are the interfaces of the sibling compilers `mlfw` and
> `query_engine`, and per convention 19 this book meets them only where a value crosses the
> boundary (`[Ch 28 § four-other-compilers-described-only-by-interface]`). A program can annotate a parameter
> `Tensor` today, and the checker will accept the annotation, and no tier in this tree will
> ever produce one. Finishing it is not a documentation task — it is the sibling
> repositories.

## Calls and named arguments

Calls are positional by default. Parameters may carry defaults
(`balance: float = 0.0`, `examples/classes.tera:30`), a rest parameter collects the
remainder, and `...` spreads an array into positional arguments. Arguments may also be
passed by name:

```
$ node dist/cli.js -e 'fn box(w: float = 1.0, h: float = 1.0) -> float:
  return w * h
print(box(h=2.0, w=3.0))'
6
```

`super(name="circle")` at `examples/classes.tera:12` is the same mechanism in a super call.
The binding rules are Python's — positional first, then named, no parameter bound twice
[t: `tests/e2e/language/functions.test.ts` > `"binds named arguments with Python-style rules"`,
> `"mixes spread positional arguments with named arguments"`].

Named arguments are not sugar the parser erases into a reordered positional call. They
survive into the bytecode as their own calling convention: `ROP_CALL_NAMED = 0x8b` and
`ROP_CALL_METHOD_NAMED = 0x8c` at `src/bytecode/register/ops/bytecode.ts:113-114`, with
`"CallNamed"` and `"CallMethodNamed"` in the opcode name table. The reason is that the
callee's parameter list is not always known when the call is compiled, so the binding has
to happen where the callee is. `[Ch 18 § the-six-call-forms]` is where that decision is
made and paid for.

## Loops and iteration

Four loop forms. `while cond:` is the one `stats.tera` uses. C-style
`for (i = 0; i < 2; i += 1):` exists. `for x of xs:` walks values, and `for k in obj:`
walks keys — two different node kinds, not one node with a flag
[t: `tests/frontend/parser/language.test.ts` > `"for of"`, > `"for in"`].

`for … of` also works over a user class, through a subscript with a literal string name:

```
$ node dist/cli.js examples/design-pattern/16_iterator.tera
iterator: 1,2,3
```

`RangeIterator` answers `next()` returning `{ done, value }`, and its constructor installs
`this["@@iterator"] = () => this`. That is the whole protocol: a property whose name is not
a legal identifier, reached by literal-string subscript, holding a function that returns the
iterator. `[Ch 27 § the-iterator-protocol]` shows the opcodes it
lowers to.

Loops can be labelled, and both `break outer` and `continue outer` work today.
`docs/example/labeled.tera` is seven lines and exercises the second:

```
rows = [[1, 2, 0], [3, 0, 4], [5, 6, 7]]

outer: for r of rows:
  for v of r:
    if v == 0:
      continue outer
    print(v)
```
— `docs/example/labeled.tera:1-7`

It prints `1`, `2`, `3`, `5`, `6`, `7` on six lines and exits 0. It did not always. The
observable symptom was that the program printed `1 2 1 2 …` forever. The mechanism: a
labelled statement created a list for labelled `continue` jumps, `continue outer` filled it
with placeholder jumps whose target was `0`, and the labelled statement then discarded the
list without patching anything — so the jump went to instruction 0, the first instruction
of the script, which rebuilt `rows` and started over. `break outer` was correct throughout,
because a `break` target is a position the labelled statement *does* own.

The fix was to stop the label patching a jump it cannot know the target of. A labelled
`continue` must land on the labelled loop's continue point, which is a different instruction
in a `while`, a C-style `for`, a `do`-`while` and a `for`-`of`, and the label sees none of
them. So the label now registers itself in `_pendingLoopLabels`
(`src/bytecode/register/compiler/helpers.ts:128`) and the next `enterLoop` (`:131-145`)
claims it into the loop context it is building, so the loop that owns the latch does the
patching. A label naming no loop is rejected outright
[t: `tests/e2e/docs/book-examples.test.ts` > `"labeled.tera resumes the outer loop instead of restarting the program"`].
The general rule it produced — **a jump can only be patched by the construct that owns its
target** — is the spine of `[Ch 19 § the-fix]`, and it is why the file is
safe to run unbounded. Older notes that say otherwise predate the fix.

## Indexing, slices and matmul

`xs[i]` is a computed member access, and parses to the same node kind as `xs.i`:

```
$ node dist/cli.js --print-ast -e 'y = xs[i]' 2>/dev/null | tail -n +4
      expression: AssignmentExpression
        target: Identifier  name="y"
        value: MemberExpression  computed=true
          object: Identifier  name="xs"
          property: Identifier  name="i"
```

(The dump is printed before anything runs, so the program then fails with `xs is not
defined`; that goes to standard error, which `2>/dev/null` drops so the pasted block is the
dump alone. `tail -n +4` drops the `Program` / `body` / `ExpressionStatement` header the two
forms share.)

A slice or a multi-dimensional subscript is a different node entirely — an
`IndexExpression` carrying one `IndexElement` per subscript:

```
$ node dist/cli.js --print-ast -e 'y = xs[1:4]' 2>/dev/null | tail -n +6
        value: IndexExpression
          object: Identifier  name="xs"
          dims: [1]
            IndexElement  kind="slice" step=null
              start: Literal  value=1 kind="number"
              stop: Literal  value=4 kind="number"

$ node dist/cli.js --print-ast -e 'y = a[i, j]' 2>/dev/null | tail -n +6
        value: IndexExpression
          object: Identifier  name="a"
          dims: [2]
            IndexElement  kind="index"
              value: Identifier  name="i"
            IndexElement  kind="index"
              value: Identifier  name="j"
```

That structural split is deliberate and the reader will meet it again in the bytecode: one
subscript is a property read, two or a slice is an indexing operation with its own opcode
family. Absent bounds are recorded as `null` rather than filled in, so `xs[2:]` and
`xs[::2]` keep their shape, and a slice is not an assignable target
[t: `tests/frontend/parser/language.test.ts` > `"lowers a slice to an index expression with one slice dimension"`,
> `"records absent slice bounds as null"`,
> `"lowers a multi-dimensional index to one dimension per subscript"`,
> `"mixes index and slice dimensions in order"`, > `"rejects assignment to a slice"`].
Negative indices count from the end: `xs[-1]` on a six-element array answers `6`.

`@` is matrix multiplication. It is one character, it lives in `TERA_OPERATORS.oneChar`
(`data/tera-language-spec.ts:890`), and it is the only operator in that table JavaScript
has no spelling for. Its binding power is `"@": 10` in the parser's precedence table
(`src/frontend/parser/index.ts:185`) — the same as `*`, `/` and `%`, below `**` at 11. It
parses everywhere, and answers nowhere in this repository:

```
$ node dist/cli.js -e 'a = [1,2]
b = [3,4]
print(a @ b)'
operator '@' requires a left operand with matmul()
```

The operand that answers `matmul()` is a `Tensor`, and `Tensor` comes from `mlfw`. Per
convention 19 that is a boundary, not a chapter
[t: `tests/frontend/lexer.test.ts` > `"tokenizes tensor matmul"`].

The punctuator tables are split three ways — `threeChar`, `twoChar`, `oneChar` — so that
maximal munch is a table ordering rather than a rule anyone has to remember: the lexer tries
the longest list first, and the tables are checked to be ordered longest-first with no
punctuator listed after one it is a prefix of
[t: `tests/frontend/operators.test.ts` > `"orders multi-character punctuators longest first so maximal munch holds"`,
> `"never lists a punctuator after one it is a prefix of"`,
> `"keeps word-shaped binary operators out of the punctuator table"`].

## Async

`async fn` declares an asynchronous function and `await` suspends on one.
`docs/example/stats-async.tera` is `stats.tera` rewritten in that style: `load` returns an
array, `mean_of` awaits it, `main` awaits both and prints, and the last line calls `main()`.
It prints the same two lines as the spine.

Then the deviation. For two *domain* types, an effect analysis marks a caller async and
inserts the `await` for you, transitively through parameters and mutual recursion. The seed
set is exactly two names:

```ts
export const TERA_ASYNC_DOMAIN_TYPES = [
  "DataFrame",
  "Trainer"
];
```
— `data/tera-language-spec.ts:395-398`

`src/frontend/effects/index.ts:7` turns that into the set the analysis starts from. A
function that awaits a method on one of those types becomes async; its direct callers become
async and their calls to it become awaits; a function that touches neither is left alone
[t: `tests/frontend/effects.test.ts` > `"marks a function that awaits a domain method as async"`,
> `"propagates async to a direct caller and awaits the call"`,
> `"leaves a purely synchronous function alone"`].

The boundary is worth stating precisely, because "tera has implicit await" would be false. A
user-declared `async fn` called without `await` yields the promise, exactly as JavaScript
would:

```
$ node dist/cli.js -e 'async fn answer() -> int:
  return 42
print(answer())'
[Promise fulfilled]
```

Implicit await is seeded by two names and propagated from there; it is not a general rule of
the language. `[Ch 14 § where-async-comes-from-at-all]` is the analysis in full,
including the 0-CFA callee resolution that lets it follow a function through a parameter.

## Strings and templates

Three quote forms: double, single, and backtick. Backticks interpolate with `${…}`, and the
expression inside may be arbitrary:

```
  public describe() -> string:
    return `${this.name} with area ${this.area()}`
```
— `examples/classes.tera:7-8`

[t: `tests/frontend/lexer.test.ts` > `"simple template"`, > `"template with multiple expressions"`,
> `"template with nested braces"`, > `"unterminated template throws"`]

`+` concatenates, coercing a number on either side, which is what `stats.tera:15` relies on:
`this.name + " mean=" + this.mean().to_fixed(2)`.

`.to_fixed(2)` is a method on a `float`, and the name is the second deviation this chapter
promised. **Builtin methods are `snake_case`.** `to_fixed`, `to_string`, `to_upper_case`,
`index_of`. The camelCase spelling is not an alias; it is nothing:

```
$ node dist/cli.js -e 'x = 15.7
print(x.to_fixed(2))'
15.70

$ node dist/cli.js -e 'x = 15.7
print(x.toFixed(2))'
undefined is not a function
```

A `float` has methods at all because `TERA_PRIMITIVE_PSEUDO_TYPES` maps the primitive names
onto owner objects:

```ts
export const TERA_PRIMITIVE_PSEUDO_TYPES = {
  "string": "String",
  "int": "Number",
  "float": "Number",
  "bool": "Boolean",
  "boolean": "Boolean"
} satisfies Record<string, string>;
```
— `data/tera-language-spec.ts:384-390`

`src/frontend/checker/type-system.ts:104` builds the method-owner map from that table and
`src/frontend/checker/symbols.ts:95` builds the completion list from it, which is how the
checker knows that `15.7.to_fixed(2)` resolves against `Number`.

> **Unenforced.** The checker does not verify that a method name exists on the pseudo-type
> it resolves against. `node dist/cli.js check` accepts `s.toUpperCase()` where `s: string`
> and exits 0; `--typecheck strict` accepts it too and the program then fails at run time
> with `undefined is not a function`, a message naming a downstream symptom rather than the
> misspelled method. The one door that catches it is the native compiler, which cannot
> guess. Given a scratch file `camel.tera` holding
> `fn shout(s: string) -> string:` / `  return s.toUpperCase()` / `print(shout("hi"))` —
> not part of the example set, because the example set contains no misspelling:
>
> ```
> $ node dist/cli.js compile camel.tera -o camel.exe
> tera compile: warning: skipped 'shout' (x64-windows backend cannot emit: unsupported property toUpperCase)
> tera compile: warning: skipped 'tera_program' (calls unavailable function shout)
> tera compile: x64-windows backend cannot emit: entry function tera_program could not be lowered to native code: it calls shout, skipped because x64-windows backend cannot emit: unsupported property toUpperCase
> ```
>
> The tables to check against already exist — `TERA_PRIMITIVE_PSEUDO_TYPES` and the method
> lists in `data/tera-language-spec.ts` — so closing it is a lookup in the checker's member
> resolution plus a diagnostic, not new data. `[unpinned]` — no test in the tree asserts
> that a misspelled builtin method is diagnosed before it runs.

None of the string surface is free once there is no VM underneath: a produced string has to
live somewhere, and `[Ch 59 § strings-without-a-runtime-tag]` is where the native compiler
pays for every line in this section.

## stats.tera line by line

The spine, read once from the top. The class first:

```
class Series:
  public constructor(name: string, values: float[]):
    this.name = name
    this.values = values

  public mean() -> float:
    total = 0.0
    i = 0
    while i < this.values.length:
      total += this.values[i]
      i += 1
    return total / this.values.length

  public label() -> string:
    return this.name + " mean=" + this.mean().to_fixed(2)
```
— `docs/example/stats.tera:1-15`

Then the free function and the module body:

```
fn report(s: Series) -> string:
  return s.label()

latency = Series("latency", [12.5, 9.0, 31.25, 7.75, 18.0])
throughput = Series("throughput", [880.0, 913.5, 902.25, 897.0])

print(report(latency))
print(report(throughput))
```
— `docs/example/stats.tera:17-24`

```
$ node dist/cli.js docs/example/stats.tera
latency mean=15.70
throughput mean=898.19
```

| Lines | Construct | Where it is compiled |
| --- | --- | --- |
| 1 | `class C:` — a shape, not a name | `[Ch 12 § new-idea-a-shape]`, `[Ch 20 § a-class-is-a-desugaring]` |
| 2 | constructor with declared `string` and `float[]` parameters | `[Ch 9 § the-one-line-decision]` |
| 3–4 | `this.x = x` — the assignment that declares a field | `[Ch 23 § hidden-classes-what-an-object-is]` |
| 6, 14 | `public m() -> T:` — visibility and a return annotation | `[Ch 12 § visibility-is-required-not-defaulted]` |
| 7–8 | bare `name = value`, type from the initializer | `[Ch 11 § two-directions]` |
| 9 | `while` with a `.length` read in the test | `[Ch 21 § jumps-and-the-back-edge]`, `[Ch 13 § the-boolean-the-guard-threw-away]` |
| 10 | computed index read plus compound assignment | `[Ch 18 § member-and-index-access]`, `[Ch 24 § lda-prop-the-sequence-in-order]` |
| 11 | `i += 1` — the loop's induction variable | `[Ch 48 § loop-invariant-code-motion]` |
| 12 | division producing a `float` | `[Ch 22 § canonical-numbers]` |
| 15 | `+` concatenation, a method on a method's result, `.to_fixed(2)` | `[Ch 59 § strings-without-a-runtime-tag]` |
| 17–18 | free `fn` with a class-typed parameter, monomorphic method call | `[Ch 34 § the-five-caches-behind-one-site]` |
| 20–21 | module-level bindings, constructor calls, array literals | `[Ch 15 § one-file-one-record]` |
| 23–24 | `print` of a call's result | `[Ch 28 § what-the-program-calls-one-shape-for-everything-callable]` |

Twenty-four lines, thirteen constructs, and not one of them is unusual. That is the point:
the engine behind them is 120,822 lines, and the distance between those two numbers is the
book.

## The eight files

`docs/example/` holds exactly eight `.tera` files. Each variation is a small edit to the
spine that makes one stage behave differently.

| File | Lines | The edit | Chapters |
| --- | --- | --- | --- |
| `stats.tera` | 24 | — the spine | everywhere |
| `stats-poly.tera` | 29 | a second class with the same members, and `fn report(s)` untyped | 12, 34, 57 |
| `stats-async.tera` | 21 | `async fn load()` and an `await` | 14, 30, 58, 63 |
| `stats-closure.tera` | 16 | a returned inner function, `values.map(double)` | 20, 50, 58 |
| `stats-deopt.tera` | 18 | a string inside a numeric array | 33, 34, 54 |
| `stats-refused.tera` | 20 | one function returns `string` or `float` | 56, 81 |
| `queue.tera` | 9 | `while q.length > 0` with two `shift()` calls | 1, 13 |
| `labeled.tera` | 7 | `continue outer` | 19, 82 |

What keeps that set honest is a test that enumerates the directory rather than listing the
files it knows about:

```ts
describe("the book's running example", () => {
  it("covers every example file, so a new one cannot be added untested", () => {
    const present = readdirSync(EXAMPLES).filter((name) => name.endsWith(".tera"));
    expect(present.sort()).toEqual(Object.keys(EXPECTED).sort());
  });
```
— `tests/e2e/docs/book-examples.test.ts:46-50`

A ninth file cannot be added without an expected output, and an existing file cannot be
deleted without the suite noticing. Every file also has its own expectation
[t: `tests/e2e/docs/book-examples.test.ts` > `"stats.tera prints what the book says it prints"`,
and one such title per file, generated from the `EXPECTED` table], and `stats.tera`'s length
is pinned too
[t: `tests/e2e/docs/book-examples.test.ts` > `"stats.tera is the twenty-four lines the book claims"`],
because convention 1 makes it the source of every listing in the remaining eighty-one
chapters.

## What leaves

Enough tera to read every listing in the rest of the book, without any chapter pausing to
explain the source. Concretely: colon-and-indent blocks and the three layout tokens behind
them; `name: type = value` and bare `name = value` with no binding keyword, and the
`LetDeclaration` node the annotated form still produces; `fn` with an arrow return type and
what an unannotated parameter costs ahead of time; `class` with visibility, accessors,
`extends`, `implements`, and the fact that a class is a shape; `interface` and `type` with
annotations carried as text; positional, default, rest, spread and named arguments, the last
of these surviving into the bytecode as its own opcode; four loop forms, the
`this["@@iterator"]` protocol and labelled `break`/`continue`; one-subscript member access
versus the `IndexExpression` a slice or a multi-dimensional index produces; `async fn` and
the two-name seed set that makes some awaits implicit; and the string surface, including the
`snake_case` builtin method names.

And the example set: eight files, each named with the chapters it serves, pinned by a test
that enumerates the directory.

`[Ch 3 § why-more-than-one-form]` takes one line of that program — `total += this.values[i]`,
`stats.tera:10` — and shows it as source, tokens, AST, semantic AST, checked AST, bytecode,
feedback, baseline JavaScript, SSA, optimized SSA, WebAssembly, MachineIR, assembly and
ELF, captioning each form with the chapter that explains it. It can do that without stopping
to say what `+=`, `this`, or a subscript mean, because this chapter said.

## Verify it yourself

```bash
# the spine, and the two lines every later chapter is chasing
node dist/cli.js docs/example/stats.tera

# there is no binding keyword, and the parser says what to write instead
node dist/cli.js -e 'let x = 1'

# static is an identifier; public is a keyword everywhere
node dist/cli.js -e 'static = 9
print(static)'
node dist/cli.js -e 'public = 9
print(public)'

# classes: inheritance, named super arguments, accessors, template literals
node dist/cli.js examples/classes.tera

# interface, type alias, implements, and for-of over a user iterator
node dist/cli.js examples/design-pattern/16_iterator.tera

# implicit await is seeded by two domain types; a user async fn is not one of them
node dist/cli.js -e 'async fn answer() -> int:
  return 42
print(answer())'

# the shape of what the parser built. Stop at 24 lines: class methods are stored as
# plain records with no node tag, so from line 25 the dump falls back to one JSON blob
# per method rather than a tree.
node dist/cli.js --print-ast docs/example/stats.tera | head -24

# the three rejected words, in every position they can appear
npx vitest run --project unit tests/frontend/parser/language.test.ts -t "reserved"
```

## Tests that pin this

- `tests/frontend/lexer.test.ts` > `"emits layout tokens for indentation blocks"` — the
  offside rule produces `Indent`, `Dedent` and `Newline`, and produces no `{`, `}` or `;`.
- `tests/frontend/lexer.test.ts` > `"rejects a dedent that matches no enclosing block"` and
  > `"reports the line and column of the offending dedent"` — the one structural rejection a
  lexer makes.
- `tests/frontend/lexer.test.ts` > `"keywords"` and
  > `"treats void as a type identifier, not an operator keyword"` — what the word list does
  and does not classify.
- `tests/frontend/lexer.test.ts` > `"tokenizes tensor matmul"` — `a @ b` is three tokens.
- `tests/frontend/lexer.test.ts` > `"simple template"`,
  > `"template with multiple expressions"`, > `"template with nested braces"`,
  > `"unterminated template throws"` — backtick interpolation.
- `tests/frontend/parser/language.test.ts` > `"rejects 'let' at statement position"`,
  > `"rejects 'let' inside a function body"`, > `"rejects 'let' in a for initializer"`,
  > `"rejects 'let' in expression position"`, > `"reports where 'let' appears"` — and the
  same five titles for `const` and `var`, generated by a loop over the three words.
- `tests/frontend/parser/language.test.ts` > `"leaves an identifier that merely starts with a reserved word alone"`
  — `lets: int = 4` is a declaration, not a rejection.
- `tests/frontend/parser/language.test.ts` > `"rejects method shorthand with a brace body (blocks are offside-only)"`,
  > `"rejects object getter/setter with a brace body"`,
  > `"rejects a brace block body (arrows take an expression body)"` — three places the
  offside rule refuses a JavaScript spelling.
- `tests/frontend/parser/language.test.ts` > `"parses visibility modifiers and class fields"`,
  > `"marks fields declared without a visibility keyword as not explicit"`,
  > `"rejects duplicate and conflicting class member modifiers"`,
  > `"parses abstract classes and abstract member signatures"` — the modifier grammar.
- `tests/frontend/parser/language.test.ts` > `"getter and setter"`,
  > `"accepts a return type annotation on a class getter"`,
  > `"accepts a typed parameter on a class setter"` — accessors.
- `tests/frontend/parser/language.test.ts` > `"for in"` and > `"for of"` — keys versus
  values, two node kinds.
- `tests/frontend/parser/language.test.ts` > `"lowers a slice to an index expression with one slice dimension"`,
  > `"records absent slice bounds as null"`,
  > `"lowers a multi-dimensional index to one dimension per subscript"`,
  > `"mixes index and slice dimensions in order"`, > `"rejects assignment to a slice"` — the
  `IndexExpression` split.
- `tests/frontend/parser/language.test.ts` > `"reads every keyword a program might want as a field name"`
  and > `"keeps a keyword key apart from the statement it spells"` — why `{ type: 2 }`
  parses.
- `tests/frontend/operators.test.ts` > `"orders multi-character punctuators longest first so maximal munch holds"`,
  > `"never lists a punctuator after one it is a prefix of"`,
  > `"keeps word-shaped binary operators out of the punctuator table"` — maximal munch as a
  table.
- `tests/frontend/checker/symbols.test.ts` > `"hides a private member from outside the class"`
  and > `"offers a private member inside its own class"` — visibility is checked, not
  decorative.
- `tests/frontend/effects.test.ts` > `"marks a function that awaits a domain method as async"`,
  > `"propagates async to a direct caller and awaits the call"`,
  > `"leaves a purely synchronous function alone"` — the exact boundary of implicit await.
- `tests/e2e/language/functions.test.ts` > `"binds named arguments with Python-style rules"`
  and > `"mixes spread positional arguments with named arguments"`.
- `tests/e2e/docs/book-examples.test.ts` > `"covers every example file, so a new one cannot be added untested"`,
  > `"stats.tera prints what the book says it prints"` (and one such title per example file,
  generated from the `EXPECTED` table), and
  > `"stats.tera is the twenty-four lines the book claims"`.
- `tests/e2e/docs/book-examples.test.ts` > `"labeled.tera resumes the outer loop instead of restarting the program"`
  — the labelled-`continue` regression test.
- `[unpinned]` — nothing checks that `TERA_KEYWORD_GROUPS` and `KEYWORDS` describe the same
  language, and nothing checks that a misspelled builtin method (`toFixed` for `to_fixed`)
  is diagnosed before the program runs.
