export const STORAGE_KEY = "tera-notebook-v1";
export const THEME_KEY = "tera-notebook-theme";
export const DF_PAGE_SIZE = 25;
export const CSV_BATCH_ROWS = 16384;

export const KEYWORDS = [
  "model", "forward", "train", "validate", "optimizer", "return", "fn",
  "if", "else", "for", "in", "while", "break", "continue",
  "and", "or", "not", "true", "false", "null",
];

export const SEED_CELLS = [
  `a = tensor([[1, 2], [3, 4]])\nb = tensor([[5, 6], [7, 8]])\na @ b`,
  `x = randn([3, 4])\nprint(x.shape)\nx.relu().mean()`,
  `metrics = DataFrame(epoch=[1, 2, 3, 4], loss=[1.0, 0.72, 0.48, 0.31], val_loss=[1.1, 0.81, 0.6, 0.44])\nchart.line(metrics, x="epoch", y=["loss", "val_loss"], title="Training")`,
  `model MLP(input: int, hidden: int, output: int):\n  fc1 = Linear(input, hidden)\n  fc2 = Linear(hidden, output)\n\n  forward (x: Tensor) -> Tensor:\n    x = fc1(x).relu()\n    return fc2(x)\n\nnet = MLP(2, 4, 1)\nnet(randn([8, 2]))`,
  `fn fib(n: int) -> int:\n  if n < 2:\n    return n\n  return fib(n - 1) + fib(n - 2)\n\nfib(12)`,
  `prices = DataFrame(\n  tech=[100, 102, 101, 105, 108, 107, 110, 113, 111, 115],\n  bank=[50, 49, 51, 50, 48, 49, 47, 48, 46, 45],\n  energy=[30, 31, 33, 32, 34, 36, 35, 37, 39, 38],\n)\nresult = backtest(prices, signal="momentum", portfolio="long_short", lookback=3)\nresult.metrics`,
];

export const BINARY_EXTS = new Set(["ckpt", "safetensors", "bin", "npy", "png", "jpg", "jpeg", "gif", "webp"]);
