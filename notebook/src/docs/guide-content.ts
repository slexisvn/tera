export type Block =
  | { kind: "text"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "code"; code: string }
  | { kind: "note"; text: string }
  | { kind: "list"; items: string[] };

export type Chapter = {
  id: string;
  title: string;
  blocks: Block[];
};

export const GUIDE_CHAPTERS: Chapter[] = [
  {
    id: "introduction",
    title: "Introduction",
    blocks: [
      { kind: "text", text: "Tera is a statically typed, Python-flavored language for numerical and machine-learning work. It reads like Python — indentation-delimited blocks, no semicolons or braces — but every value has a type the checker understands, and tensors, models, DataFrames, and reactive state are part of the language rather than bolted-on libraries." },
      { kind: "text", text: "The same program runs in this notebook and compiles to `cpu`, `wasm`, `webgpu`, or `cuda` backends, so the code you prototype in a cell is the code you ship." },
      { kind: "code", code: "fn greet(name: string) -> string:\n  return \"Hello, \" + name\n\nprint(greet(\"Tera\"))" },
      { kind: "list", items: [
        "**Typed, but inferred** — annotate what matters; the checker fills in the rest.",
        "**Offside syntax** — blocks are introduced by `:` and a deeper indent.",
        "**Batteries included** — `tensor`, `model`, `DataFrame`, `signal`, and `chart` are built in.",
        "**One language, many targets** — the same source compiles to CPU, WASM, WebGPU, or CUDA.",
      ] },
      { kind: "note", text: "Every code block below is real Tera. Copy one into a notebook cell and run it." },
    ],
  },
  {
    id: "getting-started",
    title: "Getting started",
    blocks: [
      { kind: "text", text: "A notebook is a list of cells that share one kernel and run top to bottom. A cell's final expression becomes its result, so you rarely need to `print` just to see a value." },
      { kind: "code", code: "x = 21\nx * 2" },
      { kind: "text", text: "Use `print` to emit intermediate values while a cell computes something else. Arguments are separated by a space." },
      { kind: "code", code: "print(\"warming up\", 1 + 1)\n[1, 2, 3].map(n => n * n)" },
      { kind: "note", text: "Bindings you create in one cell stay available in later cells until you restart the kernel." },
    ],
  },
  {
    id: "values-and-types",
    title: "Values & types",
    blocks: [
      { kind: "text", text: "Tera separates `int` and `float`, and has `string`, `bool`, `null`, and `undefined`. Use `any` to opt out of checking and `unknown` for a value you must narrow before using." },
      { kind: "code", code: "count: int = 3\nratio: float = 0.5\nname: string = \"ada\"\nready: bool = true\nmissing = null" },
      { kind: "heading", text: "Collections" },
      { kind: "text", text: "Arrays are ordered and homogeneous by inference; object literals map string keys to values and back structural interfaces (see Classes & interfaces)." },
      { kind: "code", code: "nums = [1, 2, 3]\nuser = { name: \"Ada\", score: 10 }\nprint(nums[0], user.name)" },
      { kind: "text", text: "Strings support interpolation with backtick templates and `${...}`." },
      { kind: "code", code: "owner = \"Ada\"\nbalance = 120\nprint(`${owner} has ${balance}`)" },
      { kind: "note", text: "`int` and `float` are distinct types: `3` is an `int`, `3.0` is a `float`. Mixing them where a `float` is expected is fine; the reverse is checked." },
    ],
  },
  {
    id: "variables",
    title: "Variables & bindings",
    blocks: [
      { kind: "text", text: "A bare `name = value` introduces a binding. Use `let` for an explicit mutable binding, `const` for one that cannot be reassigned, and `var` for legacy function-scoped code." },
      { kind: "code", code: "let total = 0\nconst PI = 3.14159\ntotal = total + PI" },
      { kind: "text", text: "Destructuring pulls values out of arrays and objects in one step." },
      { kind: "code", code: "[a, b] = [1, 2]\n{ name } = { name: \"Ada\", score: 10 }\nprint(a, b, name)" },
      { kind: "note", text: "Reassigning a `const` binding is a checker error." },
    ],
  },
  {
    id: "operators",
    title: "Operators",
    blocks: [
      { kind: "text", text: "Arithmetic works as expected, with `**` for exponentiation and `%` for remainder." },
      { kind: "code", code: "print(7 / 2, 7 % 2, 2 ** 8)" },
      { kind: "text", text: "Boolean logic uses the readable `and`, `or`, and `not` keywords (the C-style `&&`, `||`, and `!` are also available)." },
      { kind: "code", code: "ready = true\nif ready and not false:\n  print(\"go\")" },
      { kind: "text", text: "Use `??` to supply a fallback for `null`/`undefined`, and `?.` to read through a possibly-missing value without throwing." },
      { kind: "code", code: "config = { retries: null }\nprint(config.retries ?? 3)\nprint(config?.timeout)" },
    ],
  },
  {
    id: "control-flow",
    title: "Control flow",
    blocks: [
      { kind: "text", text: "`if`/`else` branches on a condition. Blocks are introduced with `:` and indentation." },
      { kind: "code", code: "score = 82\nif score >= 90:\n  print(\"A\")\nelse:\n  print(\"needs work\")" },
      { kind: "text", text: "`for … of` iterates over the values of an array, string, or range; `for … in` iterates over keys and indices." },
      { kind: "code", code: "total = 0\nfor n of range(1, 5):\n  total = total + n\nprint(total)" },
      { kind: "code", code: "for key in { a: 1, b: 2 }:\n  print(key)" },
      { kind: "text", text: "`while` and `do` loops repeat while a condition holds; `break` and `continue` control the loop." },
      { kind: "code", code: "i = 0\nwhile i < 3:\n  print(i)\n  i = i + 1" },
      { kind: "text", text: "Errors propagate with `throw` and are handled by `try`/`catch`/`finally`." },
      { kind: "code", code: "try:\n  throw \"boom\"\ncatch e:\n  print(\"caught\", e)\nfinally:\n  print(\"done\")" },
    ],
  },
  {
    id: "functions",
    title: "Functions",
    blocks: [
      { kind: "text", text: "Declare a function with `fn`. Annotate parameters and the return type with `->`; local variables are inferred." },
      { kind: "code", code: "fn area(width: float, height: float) -> float:\n  return width * height\n\nprint(area(3.0, 4.0))" },
      { kind: "text", text: "Parameters can have defaults, and callers may pass them by name in any order." },
      { kind: "code", code: "fn greet(name: string, greeting: string = \"Hello\") -> string:\n  return `${greeting}, ${name}`\n\nprint(greet(\"Ada\"))\nprint(greet(\"Ada\", greeting=\"Hi\"))" },
      { kind: "text", text: "Arrow functions are concise expression-bodied functions — ideal for `map`/`filter` and callbacks. They close over the surrounding scope." },
      { kind: "code", code: "nums = [1, 2, 3, 4]\nnums.filter(n => n % 2 == 0).map(n => n * 10)" },
      { kind: "text", text: "Functions that await asynchronous work are inferred as `async`; use `await` to read their result." },
      { kind: "code", code: "result = await Promise.resolve(10).then(v => v * 2)\nprint(result)" },
    ],
  },
  {
    id: "classes",
    title: "Classes & interfaces",
    blocks: [
      { kind: "text", text: "A `class` groups data and behavior. Fields must declare a visibility — `public`, `private`, or `protected` — and the `constructor` initializes `this`." },
      { kind: "code", code: "class Account:\n  public constructor(owner: string, balance: float = 0.0):\n    this.owner = owner\n    this.balance = balance\n  public deposit(amount: float) -> Account:\n    this.balance += amount\n    return this\n  public get summary() -> string:\n    return `${this.owner}: ${this.balance}`\n\nacc = Account(\"alice\")\nacc.deposit(100.0).summary" },
      { kind: "text", text: "`extends` inherits members; call the parent through `super`. `static` members belong to the class itself." },
      { kind: "code", code: "class Shape:\n  public constructor(name: string):\n    this.name = name\n  public area() -> float:\n    return 0.0\n\nclass Circle extends Shape:\n  public constructor(r: float):\n    super(name=\"circle\")\n    this.r = r\n  public area() -> float:\n    return 3.14159 * this.r * this.r\n\nCircle(2.0).area()" },
      { kind: "heading", text: "Interfaces & type aliases" },
      { kind: "text", text: "An `interface` describes the shape of an object structurally; `type` names a reusable type. Mark optional fields with `?`." },
      { kind: "code", code: "type UserId = int | string\n\ninterface User:\n  id: UserId\n  name: string\n  active?: bool\n\nada: User = { id: 1, name: \"Ada\" }" },
      { kind: "note", text: "Assignability is structural: any object with the required fields satisfies an interface." },
    ],
  },
  {
    id: "tensors",
    title: "Tensors",
    blocks: [
      { kind: "text", text: "Tensors are n-dimensional numeric arrays. Build them from literals or with factory functions like `zeros`, `ones`, `randn`, `arange`, and `eye`." },
      { kind: "code", code: "a = tensor([[1, 2], [3, 4]])\nb = randn([2, 2])\na @ b" },
      { kind: "text", text: "Elementwise math, reductions, and matrix ops (`@`) work directly on tensors; reshaping returns views without copying data." },
      { kind: "code", code: "x = randn([3, 4])\nprint(x.shape)\nx.relu().mean()" },
      { kind: "text", text: "Request gradients with `grad`, run a backward pass, and read `.grad` to get derivatives — this is the basis of training." },
      { kind: "code", code: "x = tensor([1.0, 2.0, 3.0], { grad: true })\ny = (x * x).sum()\ny.backward()\nx.grad" },
    ],
  },
  {
    id: "models",
    title: "Models & neural networks",
    blocks: [
      { kind: "text", text: "A `model` is a class of layers with a `forward` method describing how inputs flow to outputs. Sub-layers created in the body are tracked as parameters automatically." },
      { kind: "code", code: "model MLP(input: int, hidden: int, output: int):\n  fc1 = Linear(input, hidden)\n  fc2 = Linear(hidden, output)\n\n  forward (x: Tensor) -> Tensor:\n    x = fc1(x).relu()\n    return fc2(x)\n\nnet = MLP(2, 4, 1)\nnet(randn([8, 2]))" },
      { kind: "text", text: "`Sequential` composes layers into a pipeline when you don't need custom control flow." },
      { kind: "code", code: "net = Sequential(Linear(2, 8), ReLU(), Linear(8, 1))\nnet(randn([4, 2]))" },
      { kind: "text", text: "A training step pairs a loss with an optimizer: compute the loss, back-propagate, then step the parameters." },
      { kind: "code", code: "net = Sequential(Linear(2, 1))\nopt = Adam(net.parameters(), lr=0.01)\nloss_fn = MSELoss()\n\npred = net(randn([16, 2]))\nloss = loss_fn(pred, zeros([16, 1]))\nloss.backward()\nopt.step()\nloss" },
      { kind: "note", text: "For full training loops with validation and checkpointing, hand a model and data loaders to `Trainer` (see the reference)." },
    ],
  },
  {
    id: "reactivity",
    title: "Reactivity",
    blocks: [
      { kind: "text", text: "Reactive bindings model values that change over time. Declare a `signal` for writable state and a `computed` for a value derived from other reactive reads. Inside reactive code you read a binding by its name." },
      { kind: "code", code: "signal count = 0\ncomputed doubled = count * 2\n\ncount.set(3)\ndoubled" },
      { kind: "text", text: "An `effect:` block re-runs whenever any reactive value it reads changes — use it for side effects like logging or drawing." },
      { kind: "code", code: "signal name = \"Ada\"\n\neffect:\n  print(\"hello\", name)\n\nname.set(\"Grace\")" },
      { kind: "text", text: "A `resource` wraps async data, tracking its loading and error state so views can react to it." },
      { kind: "note", text: "Use `batch` to group several writes into one notification, and `untrack` to read a signal without subscribing to it." },
    ],
  },
  {
    id: "dataframes",
    title: "DataFrames",
    blocks: [
      { kind: "text", text: "A `DataFrame` is a columnar table with a lazy, SQL-like query API. Build one from columns, then chain transformations and finish with `show` or `collect`." },
      { kind: "code", code: "df = DataFrame(name=[\"A\", \"B\", \"C\"], value=[10, 20, 30])\ndf.show()" },
      { kind: "text", text: "Refer to columns with `col`, add computed columns with `with_column`, and filter with column expressions." },
      { kind: "code", code: "df = DataFrame(name=[\"A\", \"B\", \"C\"], value=[10, 20, 30])\ndf.filter(col(\"value\").gt(10)).with_column(\"double\", col(\"value\").mul(2)).show()" },
      { kind: "text", text: "`group_by(...).agg(...)` summarizes groups with aggregates like `sum`, `avg`, `min`, and `max`." },
      { kind: "code", code: "df = DataFrame(group=[\"a\", \"a\", \"b\"], value=[1, 2, 3])\ndf.group_by(\"group\").agg(sum(col(\"value\")).alias(\"total\")).show()" },
    ],
  },
  {
    id: "charts",
    title: "Charts",
    blocks: [
      { kind: "text", text: "The `chart` namespace turns a DataFrame, tensor, or plain arrays into a notebook visualization. Each constructor returns a chart the notebook renders inline." },
      { kind: "code", code: "metrics = DataFrame(epoch=[1, 2, 3, 4], loss=[1.0, 0.72, 0.48, 0.31], val_loss=[1.1, 0.81, 0.6, 0.44])\nchart.line(metrics, x=\"epoch\", y=[\"loss\", \"val_loss\"], title=\"Training\")" },
      { kind: "text", text: "Pass `y=[...]` for multiple series, `color=` to split rows into groups, and `title=`/`x_label=`/`y_label=` for labels. `chart.bar`, `chart.scatter`, `chart.area`, `chart.histogram`, and more follow the same shape." },
      { kind: "code", code: "revenue = DataFrame(region=[\"APAC\", \"EU\", \"US\"], value=[120, 80, 95])\nchart.bar(revenue, x=\"region\", y=\"value\", title=\"Revenue\")" },
    ],
  },
  {
    id: "quant",
    title: "Quant & finance",
    blocks: [
      { kind: "text", text: "Tera ships a quantitative-finance toolkit. `backtest` runs a signal-and-portfolio strategy over a price table and returns performance metrics and equity curves." },
      { kind: "code", code: "prices = DataFrame(tech=[100, 102, 101, 105, 108, 107, 110, 113], bank=[50, 49, 51, 50, 48, 49, 47, 48])\nresult = backtest(prices, signal=\"momentum\", portfolio=\"long_short\", lookback=3)\nresult.metrics" },
      { kind: "text", text: "Signals (`momentum`, `mean_reversion`, `zscore`) and portfolios (`equal_weight`, `cross_sectional`, `long_short`) compose, and `walk_forward` evaluates a strategy across rolling folds." },
      { kind: "text", text: "Risk and performance helpers such as `sharpe`, `risk_parity`, and `mean_variance` work on plain return arrays or covariance matrices; `quill` prices derivative products from a small pricing DSL." },
      { kind: "note", text: "See the Quant & finance section of the reference for every signal, portfolio, and metric." },
    ],
  },
  {
    id: "conventions",
    title: "Code conventions",
    blocks: [
      { kind: "text", text: "Tera has a small, consistent style. Following it keeps notebooks readable and matches the built-in library." },
      { kind: "heading", text: "Layout" },
      { kind: "text", text: "Blocks are defined by indentation under a `:` header — there are no braces. Use two spaces per level, one statement per line." },
      { kind: "code", code: "fn clamp(x: float, low: float, high: float) -> float:\n  if x < low:\n    return low\n  if x > high:\n    return high\n  return x" },
      { kind: "heading", text: "Naming" },
      { kind: "list", items: [
        "`snake_case` for variables, functions, and fields.",
        "`PascalCase` for types, interfaces, classes, models, and constructor-style builtins (`Linear`, `Conv2d`, `Adam`).",
        "Lowercase for tensor factories and free functions (`tensor`, `zeros`, `randn`, `arange`).",
      ] },
      { kind: "heading", text: "Named arguments" },
      { kind: "text", text: "Prefer keyword arguments for options so calls read clearly. Library options accept both `snake_case` and `camelCase` aliases (`weight_decay`/`weightDecay`, `requires_grad`/`requiresGrad`) — pick `snake_case` and stay consistent." },
      { kind: "code", code: "opt = SGD(net.parameters(), lr=0.01, momentum=0.9, weight_decay=0.0001)" },
      { kind: "heading", text: "Types & comments" },
      { kind: "text", text: "Annotate function parameters and return types; let local variables infer. Comments start with `#` or `//` — keep them sparse and about intent, not mechanics." },
      { kind: "code", code: "# scale logits to probabilities\nfn softmax_last(x: Tensor) -> Tensor:\n  return x.softmax(axis=-1)" },
    ],
  },
];
