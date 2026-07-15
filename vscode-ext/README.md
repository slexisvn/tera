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

## License

[MIT](LICENSE)
