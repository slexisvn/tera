# Tera Language

Language support for **Tera** (`.tera`) — a tensor algebra & neural network DSL.

Syntax highlighting, diagnostics, and IntelliSense powered by a built-in language server.

## Features

- **Syntax highlighting** for tensors, models, functions, and control flow
- **Diagnostics** — type errors and undefined names reported as you type
- **IntelliSense** — completions for builtins, tensor methods, and modules
- **Snippets** for common patterns (models, layers, training loops)
- **Bracket matching, auto-indent, and comment toggling**

## Example

```tera
x = tensor([[1, 2], [3, 4]])
w = randn([2, 3])
y = (x @ w).relu()

model MLP(input: int, hidden: int, output: int):
  fc1 = Linear(input, hidden)
  fc2 = Linear(hidden, output)

  forward (x: Tensor) -> Tensor:
    x = fc1(x).relu()
    return fc2(x)

net = MLP(2, 4, 1)
print(net(randn([8, 2])).shape)
```

## Requirements

VS Code `^1.94.0`. The extension activates automatically when you open a `.tera` file.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tera.trace.server` | `off` | Trace LSP communication between VS Code and the Tera language server (`off` / `messages` / `verbose`). |

## Development

```bash
npm --prefix ..  run build   # build the Tera compiler bundles this extension consumes
npm run build                # regenerate language data, then bundle to dist/
npm run typecheck && npm test
```

| Path | Purpose |
|------|---------|
| `src/client/` | Extension host: language client + notebook controller |
| `src/server/` | Language server: `analyzer/` (tokens, symbols, diagnostics) and `providers/` |
| `src/notebook/` | Notebook kernel process and chart renderer |
| `src/shared/` | Types shared between the server, the emitters, and the web notebook |
| `scripts/` | `generate.ts` emits the grammar, snippets and `language-data.json`; `build.ts` bundles |
| `../data/tera-language-spec.ts` | Shared Tera language spec, docs, signatures, methods and operators |

Nothing about the language is hand-listed twice. Keywords, operators, docs, method
signatures, chart docs and pseudo-type method data come from `../data/tera-language-spec.ts`.
Runtime built-ins, their `kind` and their return types still come from `src/runtime/domain`
and are validated against the shared spec during generation.

`npm run generate` fails when these disagree: if the lexer gains or drops a keyword
(`../data/tera-language-spec.ts`), or if a built-in is undocumented, documented but nonexistent,
or annotated with a kind the runtime contradicts. So the grammar and the docs cannot
silently drift from the language.

To add a language feature, drop a provider in `src/server/providers/` and list it in that
folder's `index.ts`.

## License

[MIT](LICENSE)
