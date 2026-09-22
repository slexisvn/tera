export const project = {
  name: "tera",
  repository: "https://github.com/slexisvn/tera",
  install: "npm install -g @slexisvn/tera",
  mark: `${import.meta.env.BASE_URL}tera-mark.svg`,
};

const source = (path: string) => `${project.repository}/tree/main/${path}`;
const sourceFile = (path: string) => `${project.repository}/blob/main/${path}`;
const app = (path: string) =>
  `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
const marketplace = (id: string) =>
  `https://marketplace.visualstudio.com/items?itemName=${id}`;

export const links = {
  docs: source("docs"),
  notebook: app("notebook/"),
  extension: marketplace("slexisvn.tera-language"),
  cli: source("src/cli"),
  visualizer: app("visualizer/"),
  examples: source("examples"),
};

export const navigation = [
  { label: "Get started", href: "#quickstart" },
  { label: "Language", href: "#language" },
  { label: "Tooling", href: "#tooling" },
  { label: "Under the hood", href: "#engine" },
];

export const ui = {
  skip: "Skip to content",
  menu: "Toggle navigation",
  github: "GitHub",
  docs: "Documentation",
  copy: "Copy code",
  copied: "Copied",
  copyFailed: "Could not copy. Select and copy the text.",
  install: "Copy install command",
  output: "Illustrative output",
  examples: "Language examples",
  source: "Related example",
};

export const hero = {
  badge: "The Tera programming language",
  title: "Tera",
  subtitle: "Ideas into programs.",
  description:
    "A readable language for everyday code, data, and models. From your first notebook cell to a native executable.",
  primary: "Get started",
  secondary: "Read the docs",
  footnote: "DataFrames. Tensors. Models. Built in.",
};

export const quickstart = {
  eyebrow: "00 / GET STARTED",
  title: "Your first Tera program.",
  description: "Install the CLI, save one line, and run it from your terminal.",
  steps: [
    {
      number: "01",
      title: "Install the CLI",
      detail: "Add the tera command to your terminal.",
      filename: "terminal",
      code: project.install,
      copyLabel: "Copy install command",
    },
    {
      number: "02",
      title: "Create hello.tera",
      detail: "Save this line in a file named hello.tera.",
      filename: "hello.tera",
      code: 'print("Hello, Tera.")',
      copyLabel: "Copy example code",
    },
    {
      number: "03",
      title: "Run the file",
      detail: "Run it in the same folder as hello.tera.",
      filename: "terminal",
      code: "tera hello.tera",
      copyLabel: "Copy run command",
      output: "Hello, Tera.",
    },
  ],
  next: "Explore language examples",
  docs: "Read the full docs",
};

export type Example = {
  id: string;
  label: string;
  filename: string;
  code: string;
  output: string;
  outputLabel?: string;
  source: string;
  title: string;
  description: string;
};

export const examples: Example[] = [
  {
    id: "dataframes",
    label: "DataFrames",
    filename: "sales.tera",
    title: "A little code. A clearer picture.",
    description:
      "Group, aggregate, and explore. Your data is already part of the language.",
    code: `sales = DataFrame(
  region=["North", "South", "North", "West"],
  revenue=[1200, 840, 960, 650]
)

summary = sales.group_by("region").agg(
  sum("revenue").alias("total")
)

summary.order_by("region").show()`,
    output:
      "region | total\n-------+------\nNorth  | 2160\nSouth  | 840\nWest   | 650",
    source: sourceFile("examples/dataframe.tera"),
  },
  {
    id: "tensors",
    label: "Tensors",
    filename: "algebra.tera",
    title: "Math that reads like math.",
    description:
      "Native operators, multidimensional slices, and automatic differentiation.",
    code: `a = tensor([[1.0, 2.0], [3.0, 4.0]])
b = tensor([[2.0, 0.0], [0.0, 2.0]])

product = a @ b
column = product[:, 0]

print(product.to_array())
print(column.to_array())
print(product.sum().item())`,
    output: "[[2, 4], [6, 8]]\n[2, 6]\n20",
    source: sourceFile("examples/tensors.tera"),
  },
  {
    id: "models",
    label: "Models",
    filename: "network.tera",
    title: "Give your model a shape.",
    description:
      "Declare layers and forward passes together. Add training hooks when you need them.",
    code: `model IrisNet(num_classes: int):
  net = Sequential(
    Linear(4, 32),
    ReLU(),
    Linear(32, num_classes)
  )

  forward (x: Tensor) -> Tensor:
    return net(x)

net = IrisNet(3)`,
    output: "IrisNet\n  Linear     4 → 32\n  ReLU\n  Linear    32 → 3",
    outputLabel: "Architecture preview",
    source: sourceFile("examples/regression.tera"),
  },
  {
    id: "language",
    label: "Everyday code",
    filename: "hello.tera",
    title: "Familiar ideas. Room to build.",
    description:
      "Functions, types, classes, modules, and async. A language beyond the notebook.",
    code: `fn total(values: int[]) -> int:
  result = 0
  for value of values:
    result += value
  return result

orders = [12, 8, 15]
print(total(orders))
print("Hello, Tera.")`,
    output: "35\nHello, Tera.",
    source: sourceFile("examples/control_flow.tera"),
  },
];

export const language = {
  eyebrow: "01 / THE LANGUAGE",
  title: "Small syntax.\nA lot of possibility.",
  description:
    "Everything you expect from a programming language, with the tools for data work already at hand.",
  core: {
    title: "Less ceremony. More clarity.",
    description:
      "Readable indentation, inferred types, and explicit annotations where they matter.",
    code: `fn greet(name: string) -> string:
  return "Hello, " + name

message = greet("world")
print(message)`,
    features: [
      "Functions & closures",
      "Classes & interfaces",
      "Modules & imports",
      "Async / await",
      "Error handling",
      "Type inference",
    ],
  },
  dataframe: {
    title: "Meet your data.",
    description:
      "Load, filter, join, and aggregate. Turn your next question into a DataFrame.",
    label: "DataFrame",
    columns: ["region", "orders", "revenue"],
    rows: [
      ["North", "24", "2,160"],
      ["South", "18", "840"],
      ["West", "12", "650"],
    ],
    caption: "3 rows × 3 columns",
  },
  tensor: {
    title: "Think in dimensions.",
    description:
      "Tensor algebra, slicing, broadcasting, and autograd. Written the way you think.",
    label: "Tensor",
    matrix: [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ],
    operation: "a @ b",
    caption: "shape [3, 3]",
  },
  model: {
    title: "From layers to learning.",
    description:
      "Model blocks bring layers, training hooks, optimizers, and checkpoints together.",
    label: "Model",
    layers: [
      { name: "Input", size: "4" },
      { name: "Linear + ReLU", size: "32" },
      { name: "Output", size: "3" },
    ],
  },
  chart: {
    title: "See what the numbers say.",
    description:
      "Lines, scatter plots, histograms, and heatmaps. Visual output belongs in the workflow.",
    label: "Charts",
    caption: "Revenue by region",
    values: [
      { label: "North", value: 2160 },
      { label: "South", value: 840 },
      { label: "West", value: 650 },
    ],
  },
};

export const tooling = {
  eyebrow: "02 / YOUR WORKSPACE",
  title: "One language.\nWherever you work.",
  description:
    "Explore in a notebook, stay in your editor, or go straight to the terminal.",
  notebook: {
    title: "Tera Notebook",
    description:
      "A place to think out loud. Run cells, inspect DataFrames, and keep code and charts in the same conversation.",
    action: "Explore the notebook",
    filename: "exploration.tenb",
    cell: 'summary.order_by("region").show()',
    label: "Notebook preview",
  },
  extension: {
    title: "At home in VS Code.",
    label: "VS CODE EXTENSION",
    description:
      "Completions, diagnostics, go-to-definition, and debugging. All in your existing workspace.",
    action: "Explore the extension",
    filename: "main.tera",
    code: `fn greet(name: string) -> string:
  return "Hello, " + name`,
    annotations: { greet: "fn greet(name: string) -> string" },
  },
  cli: {
    title: "The terminal is yours.",
    label: "TERA CLI",
    description:
      "Run scripts, open a REPL, type-check, debug, and compile. One command away.",
    action: "Explore the CLI",
    commands: [
      "tera hello.tera",
      "tera check hello.tera",
      "tera compile hello.tera -o hello",
    ],
  },
};

export const engine = {
  eyebrow: "03 / UNDER THE HOOD",
  title: "Simple to write.\nBuilt to go deeper.",
  description:
    "A language compiler at the core. A query optimizer for your data. An ML compiler for your models.",
  systems: [
    {
      id: "language",
      label: "Language",
      subtitle: "Compile the program",
      title: "One language. JIT or AOT.",
      description:
        "Warm up through JIT tiers, or compile supported programs straight to native code. The same language, ready for either path.",
      input: "Your Tera program",
      output: "EXECUTION PATHS",
      steps: [
        { name: "Source", detail: "Parse & analyze" },
        { name: "Bytecode", detail: "Register instructions" },
        { name: "Optimize", detail: "IR & compiler passes" },
      ],
      targets: ["Tiered JIT", "Native AOT"],
      details: [
        {
          title: "JIT · Optimize as you run",
          text: "Start in the bytecode interpreter. Hot code moves through a JavaScript baseline and an optimizing WebAssembly tier.",
        },
        {
          title: "AOT · Compile ahead",
          text: "Compile supported programs to native executables, object files, or C source before execution.",
        },
      ],
      note: "The interpreter is the starting tier of the JIT runtime. Native AOT checks supported patterns at compile time.",
    },
    {
      id: "query",
      label: "DataFrames",
      subtitle: "Find a better plan",
      title: "Same question. A smarter plan.",
      description:
        "DataFrame operations become a query plan. Push filters down, reorder joins, and execute in columnar batches.",
      input: "DataFrame operations",
      output: "EXECUTION",
      steps: [
        { name: "Plan", detail: "Logical operations" },
        { name: "Optimize", detail: "Rewrite & estimate" },
        { name: "Execute", detail: "Physical operators" },
      ],
      targets: ["Lazy plans", "Cost estimates", "Columnar execution"],
      details: [
        {
          title: "Do less work",
          text: "Push filters closer to the data, reconsider join order, and use statistics to estimate execution costs.",
        },
        {
          title: "Work in batches",
          text: "Physical operators process columnar chunks. DataFrames share the same optimizer and executor as SQL.",
        },
      ],
      note: "A chain of DataFrame operations stays a plan until an action requests its results.",
    },
    {
      id: "ml",
      label: "Tensors & models",
      subtitle: "Turn graphs into kernels",
      title: "A model becomes machine work.",
      description:
        "Run tensors eagerly, or compile a model. Its graph lowers into scheduled tensor operations and backend kernels.",
      input: "Compiled model",
      output: "BACKEND TARGETS",
      steps: [
        { name: "Graph IR", detail: "Trace & optimize" },
        { name: "Tensor IR", detail: "Lower & schedule" },
        { name: "Low-level IR", detail: "Generate kernels" },
      ],
      targets: ["CPU", "WebAssembly", "CUDA", "WebGPU"],
      details: [
        {
          title: "See the computation",
          text: "Graph passes transform the model before tensor-level lowering exposes loops and scheduling decisions.",
        },
        {
          title: "Match the backend",
          text: "Code generation and buffer planning prepare execution. Eager operations also reuse cached kernels.",
        },
      ],
      note: "Eager tensor execution and whole-model compilation are distinct paths through the ML stack.",
    },
  ],
  command: "tera compile hello.tera -o hello",
  note: "AOT checks supported patterns strictly and reports what it cannot compile.",
  visualizer: "Follow the compiler",
  visualizerDescription:
    "Explore tokens, bytecode, IR, and optimization passes in the compiler visualizer.",
};

export const closing = {
  eyebrow: "YOUR NEXT IDEA STARTS HERE",
  title: "Make something with Tera.",
  description: "A small script. A new model. Whatever comes next.",
  examples: "Browse examples",
  footer: "A language for ideas in motion.",
  top: "Back to top",
};
