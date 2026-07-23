export type TeraKeywordGroup = "declaration" | "control" | "operator" | "constant" | "variable";

export type TeraParam = {
  name: string;
  type?: string | null;
  defaultValue?: unknown;
  optional?: boolean;
  rest?: boolean;
  named?: boolean;
};

export type TeraMethodSpec = {
  name: string;
  params: TeraParam[];
  returns?: string | null;
  effect?: "sync" | "async" | "io";
  isGetter?: boolean;
  description?: string | null;
};

export type TeraBuiltinSpec = {
  description?: string | null;
  kind?: string | null;
  returns?: string | null;
  effect?: "sync" | "async" | "io";
  callConvention?: "positional" | "named" | "positional_named" | "namespace";
  params?: TeraParam[] | null;
  methods?: TeraMethodSpec[];
};

export type TeraOperators = {
  threeChar: string[];
  twoChar: string[];
  oneChar: string[];
};

export type TeraPseudoTypeSpec = {
  methods: TeraMethodSpec[];
};

export type TeraChartMethodSpec = {
  display: string;
  description: string;
  kind: string;
  returns?: string | null;
  effect?: "sync" | "async" | "io";
  params?: TeraParam[];
};

export const TERA_KEYWORD_GROUPS = {
  "declaration": [
    "fn",
    "model",
    "class",
    "let",
    "const",
    "var",
    "extends"
  ],
  "control": [
    "if",
    "else",
    "of",
    "for",
    "while",
    "do",
    "return",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "try",
    "catch",
    "finally",
    "throw",
    "async",
    "await",
    "yield"
  ],
  "operator": [
    "and",
    "or",
    "not",
    "in",
    "instanceof",
    "typeof",
    "delete",
    "void",
    "new"
  ],
  "constant": [
    "true",
    "false",
    "null",
    "undefined"
  ],
  "variable": [
    "this",
    "super"
  ]
} satisfies Record<TeraKeywordGroup, string[]>;

export const TERA_PRIMITIVE_TYPES = [
  "any",
  "unknown",
  "int",
  "float",
  "string",
  "bool",
  "boolean",
  "Map",
  "Set",
  "Array",
  "Object"
];

export const TERA_ASYNC_DOMAIN_TYPES = [
  "DataFrame",
  "Trainer"
];

export const TERA_RESULT_FIELD_TYPES = {
  "backtest": {
    "equity": "DataFrame",
    "port_returns": "DataFrame"
  },
  "walk_forward": {
    "equity": "DataFrame",
    "port_returns": "DataFrame"
  }
};

export const TERA_OPERATORS = {
  "threeChar": [
    ">>>=",
    "===",
    "!==",
    ">>>",
    "**=",
    "<<=",
    ">>=",
    "..."
  ],
  "twoChar": [
    "=>",
    "->",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "??",
    "?.",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "**",
    "<<",
    ">>"
  ],
  "oneChar": [
    "+",
    "-",
    "*",
    "/",
    "%",
    "@",
    "<",
    ">",
    "=",
    "!",
    "&",
    "|",
    "^",
    "~",
    "?",
    ":",
    ".",
    ",",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    ";"
  ]
} satisfies TeraOperators;

export const TERA_BUILTINS = {
  "tensor": {
    "description": "Construct a tensor from a literal value, array, or nested array. Accepts `dtype`, `device`, `grad` options.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "zeros": {
    "description": "Create a tensor of the given shape filled with `0`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "shape",
        "type": "Array"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "ones": {
    "description": "Create a tensor of the given shape filled with `1`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "shape",
        "type": "Array"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "empty": {
    "description": "Allocate a tensor of the given shape without initializing its contents.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "shape",
        "type": "Array"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "full": {
    "description": "Create a tensor of the given shape filled with the provided scalar `value`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "shape",
        "type": "Array"
      },
      {
        "name": "value",
        "type": "float"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "randn": {
    "description": "Sample a tensor of the given shape from the standard normal distribution.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "shape",
        "type": "Array"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "arange": {
    "description": "Half-open integer range tensor `[start, end)` with optional `step`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "start",
        "type": "int"
      },
      {
        "name": "end",
        "type": "int",
        "optional": true
      },
      {
        "name": "step",
        "type": "int",
        "optional": true
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "eye": {
    "description": "Identity matrix of size `n × m` (or `n × n` if `m` omitted).",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "n",
        "type": "int"
      },
      {
        "name": "m",
        "type": "int",
        "optional": true
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "linspace": {
    "description": "Evenly spaced values between `start` and `end`, inclusive, with `steps` points.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "start",
        "type": "float"
      },
      {
        "name": "end",
        "type": "float"
      },
      {
        "name": "steps",
        "type": "int"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "randperm": {
    "description": "Random permutation of integers `0..n-1`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "n",
        "type": "int"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "zeros_like": {
    "description": "Zero tensor with the same shape, dtype, and device as the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "tensor",
        "type": "Tensor"
      }
    ]
  },
  "ones_like": {
    "description": "Tensor of ones with the same shape, dtype, and device as the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "tensor",
        "type": "Tensor"
      }
    ]
  },
  "empty_like": {
    "description": "Uninitialized tensor with the same shape, dtype, and device as the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "tensor",
        "type": "Tensor"
      }
    ]
  },
  "full_like": {
    "description": "Constant-filled tensor matching the shape, dtype, and device of the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "tensor",
        "type": "Tensor"
      },
      {
        "name": "value",
        "type": "float"
      }
    ]
  },
  "randn_like": {
    "description": "Standard-normal sample with the same shape, dtype, and device as the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      {
        "name": "tensor",
        "type": "Tensor"
      }
    ]
  },
  "where": {
    "description": "Element-wise conditional selection: pick from `a` where `condition` is true, else from `b`.",
    "kind": "function",
    "returns": "Tensor",
    "params": [
      {
        "name": "condition",
        "type": "Tensor"
      },
      {
        "name": "a",
        "type": "Tensor"
      },
      {
        "name": "b",
        "type": "Tensor"
      }
    ]
  },
  "cat": {
    "description": "Concatenate tensors along an existing dimension.",
    "kind": "function",
    "returns": "Tensor",
    "params": [
      {
        "name": "tensors",
        "type": "Array"
      },
      {
        "name": "axis",
        "type": "int",
        "optional": true,
        "defaultValue": 0
      }
    ]
  },
  "stack": {
    "description": "Stack tensors along a new dimension.",
    "kind": "function",
    "returns": "Tensor",
    "params": [
      {
        "name": "tensors",
        "type": "Array"
      },
      {
        "name": "axis",
        "type": "int",
        "optional": true,
        "defaultValue": 0
      }
    ]
  },
  "sum": {
    "description": "Aggregate `Column` computing the sum of a column within a `group_by(...).agg(...)`.",
    "kind": "function",
    "returns": "Column",
    "params": [
      {
        "name": "column",
        "type": "any"
      }
    ]
  },
  "max": {
    "description": "Aggregate `Column` computing the maximum of a column within a `group_by(...).agg(...)`.",
    "kind": "function",
    "returns": "Column",
    "params": [
      {
        "name": "column",
        "type": "any"
      }
    ]
  },
  "min": {
    "description": "Aggregate `Column` computing the minimum of a column within a `group_by(...).agg(...)`.",
    "kind": "function",
    "returns": "Column",
    "params": [
      {
        "name": "column",
        "type": "any"
      }
    ]
  },
  "range": {
    "description": "Integer range: returns an array `[start..stop)` with optional `step`.",
    "kind": "function",
    "returns": "int[]",
    "params": [
      {
        "name": "start",
        "type": "int",
        "optional": true
      },
      {
        "name": "stop",
        "type": "int",
        "optional": true
      },
      {
        "name": "step",
        "type": "int",
        "optional": true,
        "defaultValue": 1
      }
    ]
  },
  "print": {
    "description": "Print one or more values to the runtime output, separated by a space.",
    "kind": "global",
    "params": [
      {
        "name": "values",
        "optional": true,
        "rest": true
      }
    ]
  },
  "compile": {
    "description": "Compile a model or function to a backend (`cpu`/`gpu`/`wasm`/`webgpu`). `input` provides an example for shape inference and tuning.",
    "kind": "function",
    "returns": "Object",
    "params": [
      {
        "name": "model",
        "type": "any"
      },
      {
        "name": "input",
        "type": "any",
        "optional": true,
        "named": true
      }
    ]
  },
  "Sequential": {
    "description": "Compose modules into a feed-forward pipeline. The output of each module is fed to the next.",
    "kind": "sequential",
    "returns": "Object",
    "params": [
      {
        "name": "modules",
        "type": "any",
        "optional": true,
        "rest": true
      }
    ]
  },
  "Linear": {
    "description": "Fully-connected layer `y = x @ Wᵀ + b`. Set `bias=false` to disable the bias term.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "in",
        "type": "int"
      },
      {
        "name": "out",
        "type": "int"
      },
      {
        "name": "bias",
        "type": "bool",
        "optional": true,
        "defaultValue": true
      }
    ]
  },
  "ReLU": {
    "description": "Rectified Linear Unit activation module: `max(0, x)`.",
    "kind": "module",
    "returns": "Object",
    "params": []
  },
  "GELU": {
    "description": "Gaussian Error Linear Unit activation module — commonly used in Transformers.",
    "kind": "module",
    "returns": "Object",
    "params": []
  },
  "SiLU": {
    "description": "SiLU/Swish activation module: `x * sigmoid(x)`.",
    "kind": "module",
    "returns": "Object",
    "params": []
  },
  "Sigmoid": {
    "description": "Logistic sigmoid activation module.",
    "kind": "module",
    "returns": "Object",
    "params": []
  },
  "Tanh": {
    "description": "Hyperbolic tangent activation module.",
    "kind": "module",
    "returns": "Object",
    "params": []
  },
  "LeakyReLU": {
    "description": "Leaky ReLU activation; negative inputs are scaled by `negative_slope` instead of zeroed.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "negative_slope",
        "type": "float",
        "optional": true,
        "defaultValue": 0.01
      }
    ]
  },
  "ELU": {
    "description": "Exponential Linear Unit activation. Smooth alternative to ReLU for negative values.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "alpha",
        "type": "float",
        "optional": true,
        "defaultValue": 1
      }
    ]
  },
  "Softmax": {
    "description": "Softmax module over the specified dimension.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "dim",
        "type": "int",
        "optional": true,
        "defaultValue": -1
      }
    ]
  },
  "LogSoftmax": {
    "description": "LogSoftmax module — numerically stable log of softmax.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "dim",
        "type": "int",
        "optional": true,
        "defaultValue": -1
      }
    ]
  },
  "Flatten": {
    "description": "Flatten a contiguous range of dimensions into one. Typical use: between conv blocks and a Linear head.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "start_dim",
        "type": "int",
        "optional": true,
        "defaultValue": 1
      },
      {
        "name": "end_dim",
        "type": "int",
        "optional": true,
        "defaultValue": -1
      }
    ]
  },
  "Dropout": {
    "description": "Randomly zero elements with probability `p` during training. Inactive at eval time.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "p",
        "type": "float",
        "optional": true,
        "defaultValue": 0.5
      }
    ]
  },
  "LayerNorm": {
    "description": "Layer normalization over the given trailing shape. Stabilizes activations independent of batch.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "shape",
        "type": "Array"
      },
      {
        "name": "eps",
        "type": "float",
        "optional": true,
        "defaultValue": 0.00001
      }
    ]
  },
  "BatchNorm1d": {
    "description": "Batch normalization for 2-D `(N, C)` or 3-D `(N, C, L)` inputs.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "features",
        "type": "int"
      },
      {
        "name": "eps",
        "type": "float",
        "optional": true,
        "defaultValue": 0.00001
      },
      {
        "name": "momentum",
        "type": "float",
        "optional": true,
        "defaultValue": 0.1
      }
    ]
  },
  "BatchNorm2d": {
    "description": "Batch normalization for 4-D `(N, C, H, W)` image-like inputs.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "features",
        "type": "int"
      },
      {
        "name": "eps",
        "type": "float",
        "optional": true,
        "defaultValue": 0.00001
      },
      {
        "name": "momentum",
        "type": "float",
        "optional": true,
        "defaultValue": 0.1
      }
    ]
  },
  "Conv1d": {
    "description": "1-D convolution over an input with `in` channels, producing `out` channels.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "in",
        "type": "int"
      },
      {
        "name": "out",
        "type": "int"
      },
      {
        "name": "kernel",
        "type": "int"
      },
      {
        "name": "stride",
        "type": "int",
        "optional": true,
        "defaultValue": 1
      },
      {
        "name": "padding",
        "type": "int",
        "optional": true,
        "defaultValue": 0
      }
    ]
  },
  "Conv2d": {
    "description": "2-D convolution. Use `padding` to preserve spatial dimensions.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "in",
        "type": "int"
      },
      {
        "name": "out",
        "type": "int"
      },
      {
        "name": "kernel",
        "type": "int"
      },
      {
        "name": "stride",
        "type": "int",
        "optional": true,
        "defaultValue": 1
      },
      {
        "name": "padding",
        "type": "int",
        "optional": true,
        "defaultValue": 0
      }
    ]
  },
  "MaxPool2d": {
    "description": "2-D max pooling. Downsamples spatial dimensions taking the per-window max.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "kernel",
        "type": "int"
      },
      {
        "name": "stride",
        "type": "int",
        "optional": true
      },
      {
        "name": "padding",
        "type": "int",
        "optional": true,
        "defaultValue": 0
      }
    ]
  },
  "AvgPool2d": {
    "description": "2-D average pooling. Downsamples spatial dimensions averaging per window.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "kernel",
        "type": "int"
      },
      {
        "name": "stride",
        "type": "int",
        "optional": true
      },
      {
        "name": "padding",
        "type": "int",
        "optional": true,
        "defaultValue": 0
      }
    ]
  },
  "AdaptiveAvgPool2d": {
    "description": "2-D adaptive average pooling to a target output spatial shape, independent of input size.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "output_size",
        "type": "Array"
      }
    ]
  },
  "Embedding": {
    "description": "Lookup table mapping integer ids to dense vectors of size `dim`.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "num",
        "type": "int"
      },
      {
        "name": "dim",
        "type": "int"
      },
      {
        "name": "padding_idx",
        "type": "int",
        "optional": true
      }
    ]
  },
  "GRU": {
    "description": "Multi-layer Gated Recurrent Unit. Call `out, h_n = gru(x, h0?)` — returns the output sequence and the final hidden state. Set `batch_first=true` for `(N, T, input)` inputs.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "input",
        "type": "int"
      },
      {
        "name": "hidden",
        "type": "int"
      },
      {
        "name": "num_layers",
        "type": "int",
        "optional": true,
        "defaultValue": 1
      },
      {
        "name": "batch_first",
        "type": "bool",
        "optional": true,
        "defaultValue": false
      },
      {
        "name": "bias",
        "type": "bool",
        "optional": true,
        "defaultValue": true
      }
    ]
  },
  "GRUCell": {
    "description": "Single GRU time-step. `h_next = cell(x, h)` — apply manually to step a sequence one element at a time.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "input",
        "type": "int"
      },
      {
        "name": "hidden",
        "type": "int"
      },
      {
        "name": "bias",
        "type": "bool",
        "optional": true,
        "defaultValue": true
      }
    ]
  },
  "LSTM": {
    "description": "Multi-layer Long Short-Term Memory. Call `out, state = lstm(x, [h0, c0]?)` — returns the output sequence and `state = [h_n, c_n]` (final hidden and cell states). Set `batch_first=true` for `(N, T, input)` inputs.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "input",
        "type": "int"
      },
      {
        "name": "hidden",
        "type": "int"
      },
      {
        "name": "num_layers",
        "type": "int",
        "optional": true,
        "defaultValue": 1
      },
      {
        "name": "batch_first",
        "type": "bool",
        "optional": true,
        "defaultValue": false
      },
      {
        "name": "bias",
        "type": "bool",
        "optional": true,
        "defaultValue": true
      }
    ]
  },
  "LSTMCell": {
    "description": "Single LSTM time-step. `h_next, c_next = cell(x, [h, c])` — carries both hidden and cell state for O(T) autoregressive stepping.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "input",
        "type": "int"
      },
      {
        "name": "hidden",
        "type": "int"
      },
      {
        "name": "bias",
        "type": "bool",
        "optional": true,
        "defaultValue": true
      }
    ]
  },
  "CrossEntropyLoss": {
    "description": "Combined LogSoftmax + NLL loss — standard for multiclass classification. Pass `ignore_index` (e.g. a padding id) to exclude those target positions from the loss — useful for seq2seq with padded sequences.",
    "kind": "module",
    "returns": "Object",
    "params": [
      {
        "name": "reduction",
        "type": "string",
        "optional": true,
        "defaultValue": "mean"
      },
      {
        "name": "ignore_index",
        "type": "int",
        "optional": true
      }
    ]
  },
  "MSELoss": {
    "description": "Mean squared error loss — standard for regression.",
    "kind": "module",
    "returns": "Object",
    "params": []
  },
  "NLLLoss": {
    "description": "Negative log-likelihood loss. Pair with LogSoftmax outputs.",
    "kind": "module",
    "returns": "Object",
    "params": []
  },
  "BCELoss": {
    "description": "Binary cross-entropy loss for sigmoid-activated outputs.",
    "kind": "module",
    "returns": "Object",
    "params": []
  },
  "SGD": {
    "description": "Stochastic gradient descent with optional `momentum` and `weight_decay`.",
    "kind": "optimizer",
    "returns": "Object",
    "params": [
      {
        "name": "params",
        "type": "any"
      },
      {
        "name": "lr",
        "type": "float",
        "optional": true,
        "named": true,
        "defaultValue": 0.01
      },
      {
        "name": "momentum",
        "type": "float",
        "optional": true,
        "named": true,
        "defaultValue": 0
      },
      {
        "name": "weight_decay",
        "type": "float",
        "optional": true,
        "named": true,
        "defaultValue": 0
      }
    ]
  },
  "Adam": {
    "description": "Adaptive moment estimation optimizer. Standard default for deep learning.",
    "kind": "optimizer",
    "returns": "Object",
    "params": [
      {
        "name": "params",
        "type": "any"
      },
      {
        "name": "lr",
        "type": "float",
        "optional": true,
        "named": true,
        "defaultValue": 0.001
      },
      {
        "name": "betas",
        "type": "Array",
        "optional": true,
        "named": true
      },
      {
        "name": "weight_decay",
        "type": "float",
        "optional": true,
        "named": true,
        "defaultValue": 0
      }
    ]
  },
  "AdamW": {
    "description": "Adam variant with decoupled weight decay — preferred for transformer-style models.",
    "kind": "optimizer",
    "returns": "Object",
    "params": [
      {
        "name": "params",
        "type": "any"
      },
      {
        "name": "lr",
        "type": "float",
        "optional": true,
        "named": true,
        "defaultValue": 0.001
      },
      {
        "name": "betas",
        "type": "Array",
        "optional": true,
        "named": true
      },
      {
        "name": "weight_decay",
        "type": "float",
        "optional": true,
        "named": true,
        "defaultValue": 0.01
      }
    ]
  },
  "StepLR": {
    "description": "Decay the learning rate by `gamma` every `step_size` epochs.",
    "kind": "scheduler",
    "returns": "Object",
    "params": [
      {
        "name": "optimizer",
        "type": "any"
      },
      {
        "name": "step_size",
        "type": "int"
      },
      {
        "name": "gamma",
        "type": "float",
        "optional": true,
        "defaultValue": 0.1
      }
    ]
  },
  "CosineAnnealingLR": {
    "description": "Cosine schedule decaying the learning rate to `eta_min` over `t_max` epochs.",
    "kind": "scheduler",
    "returns": "Object",
    "params": [
      {
        "name": "optimizer",
        "type": "any"
      },
      {
        "name": "t_max",
        "type": "int"
      },
      {
        "name": "eta_min",
        "type": "float",
        "optional": true,
        "defaultValue": 0
      }
    ]
  },
  "ReduceLROnPlateau": {
    "description": "Reduce learning rate when a monitored metric stops improving.",
    "kind": "scheduler",
    "returns": "Object",
    "params": [
      {
        "name": "optimizer",
        "type": "any"
      },
      {
        "name": "mode",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "min"
      },
      {
        "name": "patience",
        "type": "int",
        "optional": true,
        "named": true,
        "defaultValue": 10
      },
      {
        "name": "factor",
        "type": "float",
        "optional": true,
        "named": true,
        "defaultValue": 0.1
      }
    ]
  },
  "Trainer": {
    "description": "Drives the training loop: epochs, validation, callbacks, logging, checkpointing.",
    "kind": "trainer",
    "returns": "Trainer",
    "params": [
      {
        "name": "max_epochs",
        "type": "int",
        "optional": true,
        "named": true,
        "defaultValue": 20
      },
      {
        "name": "accelerator",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "cpu"
      },
      {
        "name": "logger",
        "type": "any",
        "optional": true,
        "named": true,
        "defaultValue": true
      },
      {
        "name": "enable_checkpointing",
        "type": "bool",
        "optional": true,
        "named": true,
        "defaultValue": false
      },
      {
        "name": "enable_progress",
        "type": "bool",
        "optional": true,
        "named": true,
        "defaultValue": true
      },
      {
        "name": "callbacks",
        "type": "any",
        "optional": true,
        "named": true
      },
      {
        "name": "fast_dev_run",
        "type": "bool",
        "optional": true,
        "named": true,
        "defaultValue": false
      },
      {
        "name": "gradient_clip_val",
        "type": "float",
        "optional": true,
        "named": true
      },
      {
        "name": "log_every_n_steps",
        "type": "int",
        "optional": true,
        "named": true,
        "defaultValue": 50
      }
    ],
    "methods": [
      {
        "name": "fit",
        "params": [
          {
            "name": "model",
            "type": "Module",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "train_loader",
            "type": "DataLoader",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "val_loader",
            "type": "DataLoader",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Run the training loop. Iterates `max_epochs` over `train_loader`, optionally validating on `val_loader` each epoch."
      },
      {
        "name": "validate",
        "params": [
          {
            "name": "model",
            "type": "Module",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "loader",
            "type": "DataLoader",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Run validation only (no gradient updates). Returns logged metrics."
      },
      {
        "name": "test",
        "params": [
          {
            "name": "model",
            "type": "Module",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "loader",
            "type": "DataLoader",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Run the model in eval mode over `loader`. Returns logged metrics."
      },
      {
        "name": "predict",
        "params": [
          {
            "name": "model",
            "type": "Module",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "loader",
            "type": "DataLoader",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Run the model in eval mode and collect outputs into an array."
      }
    ]
  },
  "log": {
    "description": "Log a metric value. Only callable inside a `train`/`validate` block — calling it elsewhere is an error. Calls `.compute()` automatically on Metric instances.",
    "kind": "step",
    "params": [
      {
        "name": "name",
        "type": "string"
      },
      {
        "name": "value",
        "type": "Tensor"
      },
      {
        "name": "on_step",
        "type": "bool",
        "optional": true
      },
      {
        "name": "on_epoch",
        "type": "bool",
        "optional": true
      },
      {
        "name": "prog_bar",
        "type": "bool",
        "optional": true,
        "defaultValue": "false"
      },
      {
        "name": "reduce_fx",
        "type": "string",
        "optional": true,
        "defaultValue": "\"mean\""
      }
    ]
  },
  "optim_config": {
    "description": "Wrap an optimizer (and optionally an LR scheduler) for return from an `optimizer:` block.",
    "kind": "function",
    "returns": "Object",
    "params": [
      {
        "name": "optimizer",
        "type": "any"
      },
      {
        "name": "lr_scheduler",
        "type": "Object",
        "optional": true,
        "named": true
      }
    ]
  },
  "TensorDataset": {
    "description": "In-memory dataset zipping one or more tensors along their first dimension.",
    "kind": "data",
    "returns": "Object",
    "params": [
      {
        "name": "tensors",
        "type": "any",
        "optional": true,
        "rest": true
      }
    ]
  },
  "DataLoader": {
    "description": "Iterate over a dataset in mini-batches with optional shuffling and `drop_last`.",
    "kind": "data",
    "returns": "DataLoader",
    "params": [
      {
        "name": "dataset",
        "type": "any"
      },
      {
        "name": "batch_size",
        "type": "int",
        "optional": true,
        "named": true,
        "defaultValue": 32
      },
      {
        "name": "shuffle",
        "type": "bool",
        "optional": true,
        "named": true,
        "defaultValue": true
      },
      {
        "name": "drop_last",
        "type": "bool",
        "optional": true,
        "named": true,
        "defaultValue": false
      }
    ],
    "methods": [
      {
        "name": "length",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Number of batches per epoch."
      }
    ]
  },
  "load_csv": {
    "description": "Load a CSV file into a `DataFrame`. Numeric fields are parsed as numeric values; use\nthe `DataFrame` API (`select`, `filter`, `group_by`, `to_tensor`, `encode`, …)\nto analyse it.",
    "kind": "data",
    "returns": "DataFrame",
    "effect": "io",
    "params": [
      {
        "name": "path",
        "type": "string"
      },
      {
        "name": "separator",
        "type": "string",
        "optional": true,
        "named": true
      }
    ]
  },
  "read_text": {
    "description": "Read a text file and return its contents as a string.",
    "kind": "data",
    "returns": "string",
    "effect": "io",
    "params": [
      {
        "name": "path",
        "type": "string"
      }
    ]
  },
  "load_json": {
    "description": "Read a JSON file and return it as nested dicts/arrays.",
    "kind": "data",
    "returns": "any",
    "effect": "io",
    "params": [
      {
        "name": "path",
        "type": "string"
      }
    ]
  },
  "load_model": {
    "description": "Load weights from a checkpoint `path` into an existing `model` (in place) and return it. Save the model first with `model.save(path)`, rebuild it with the same architecture, then `load_model(model, path)`.",
    "kind": "data",
    "returns": "Object",
    "effect": "io",
    "params": [
      {
        "name": "model",
        "type": "any"
      },
      {
        "name": "path",
        "type": "string"
      }
    ]
  },
  "load_tokenizer": {
    "description": "Load a tokenizer artifact saved with `tok.save(path)`. Returns a `Tokenizer`.",
    "kind": "data",
    "returns": "Tokenizer",
    "effect": "io",
    "params": [
      {
        "name": "path",
        "type": "string"
      }
    ]
  },
  "Tokenizer": {
    "description": "Build a text tokenizer. `mode` is `\"word\"`, `\"char\"`, or `\"bpe\"` (trainable subword). `fit(texts)` on a corpus first, then `encode`/`decode`/`encode_batch`. Reserves special tokens (`<pad> <unk> <bos> <eos>`) at low ids exposed as `pad_id`/`unk_id`/`bos_id`/`eos_id`.",
    "kind": "data",
    "returns": "Tokenizer",
    "params": [
      {
        "name": "mode",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "word"
      },
      {
        "name": "vocab_size",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "lowercase",
        "type": "bool",
        "optional": true,
        "named": true,
        "defaultValue": false
      },
      {
        "name": "num_merges",
        "type": "int",
        "optional": true,
        "named": true,
        "defaultValue": 1000
      },
      {
        "name": "special_tokens",
        "type": "Array",
        "optional": true,
        "named": true
      }
    ],
    "methods": [
      {
        "name": "fit",
        "params": [
          {
            "name": "texts",
            "type": "string[]",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tokenizer",
        "isGetter": false,
        "description": "Learn the vocabulary (and BPE merges) from a array of strings. Returns the tokenizer."
      },
      {
        "name": "save",
        "params": [
          {
            "name": "path",
            "type": "string",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "none",
        "isGetter": false,
        "description": "Save the fitted tokenizer as a compact artifact. Reload it with the global `load_tokenizer(path)`."
      },
      {
        "name": "encode",
        "params": [
          {
            "name": "text",
            "type": "string",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "add_bos",
            "type": "boolean",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "add_eos",
            "type": "boolean",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "int[]",
        "isGetter": false,
        "description": "Tokenize `text` to a array of integer ids. Optionally wrap with begin/end-of-sequence tokens."
      },
      {
        "name": "decode",
        "params": [
          {
            "name": "ids",
            "type": "int[]",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "skip_special",
            "type": "boolean",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Turn a array of ids back into a string (special tokens skipped by default)."
      },
      {
        "name": "encode_batch",
        "params": [
          {
            "name": "texts",
            "type": "string[]",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "max_len",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "pad_id",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "add_bos",
            "type": "boolean",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "add_eos",
            "type": "boolean",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Encode a array of strings into a padded `[N, max_len]` i32 tensor, ready for a model."
      },
      {
        "name": "vocab_size",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Number of tokens in the learned vocabulary (property)."
      },
      {
        "name": "pad_id",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Reserved id of the `<pad>` token."
      },
      {
        "name": "unk_id",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Reserved id of the `<unk>` (unknown) token."
      },
      {
        "name": "bos_id",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Reserved id of the `<bos>` (begin-of-sequence) token."
      },
      {
        "name": "eos_id",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Reserved id of the `<eos>` (end-of-sequence) token."
      }
    ]
  },
  "DataFrame": {
    "description": "Build a lazy `DataFrame` from named column arrays, one named argument per\ncolumn: `DataFrame(name=[\"a\", \"b\"], age=[30, 40])`. Column types are inferred\nfrom the values. The frame records a query plan and is only executed when\nmaterialized with `collect`, `to_array`, `count`, `show`, or `chunks`.",
    "kind": "data",
    "returns": "DataFrame",
    "callConvention": "named",
    "params": [
      {
        "name": "columns",
        "type": "any",
        "rest": true,
        "named": true
      }
    ]
  },
  "col": {
    "description": "Reference a column by name in a `DataFrame` expression, returning a `Column`\nthat can be transformed and compared. Use a dotted name (`\"t.id\"`) to qualify a\ntable alias.",
    "kind": "function",
    "returns": "Column",
    "params": [
      {
        "name": "name",
        "type": "string"
      }
    ]
  },
  "lit": {
    "description": "Wrap a constant value as a `Column` literal so it can be combined with other\ncolumns in expressions.",
    "kind": "function",
    "returns": "Column",
    "params": [
      {
        "name": "value",
        "type": "any"
      }
    ]
  },
  "expr": {
    "description": "Parse a scalar SQL string into a `Column`, e.g. `expr(\"price * 1.1\")`. Bound\nagainst the frame's schema at build time.",
    "kind": "function",
    "returns": "Column",
    "params": [
      {
        "name": "sql",
        "type": "string"
      }
    ]
  },
  "avg": {
    "description": "Aggregate `Column` computing the mean of a column within a `group_by(...).agg(...)`.",
    "kind": "function",
    "returns": "Column",
    "params": [
      {
        "name": "column",
        "type": "any"
      }
    ]
  },
  "count": {
    "description": "Aggregate `Column` counting non-null values of a column within `agg(...)`.",
    "kind": "function",
    "returns": "Column",
    "params": [
      {
        "name": "column",
        "type": "any",
        "optional": true
      }
    ]
  },
  "count_star": {
    "description": "Aggregate `Column` counting all rows (`COUNT(*)`) within `agg(...)`.",
    "kind": "function",
    "returns": "Column",
    "params": []
  },
  "register_columns_table": {
    "description": "Register named column arrays as a SQL-addressable table and return its generated\ntable name, one named argument per column: `register_columns_table(name=[\"a\"], age=[30])`.\nUse the returned name inside `expr(\"... FROM <name>\")`.",
    "kind": "data",
    "returns": "string",
    "callConvention": "named",
    "params": [
      {
        "name": "columns",
        "type": "any",
        "rest": true,
        "named": true
      }
    ]
  },
  "backtest": {
    "description": "Run a vectorized cross-sectional backtest over a price `DataFrame` shaped time × asset (numeric columns are the assets; a date/index column is dropped automatically). `signal` selects a trading signal (`\"momentum\"`, `\"mean_reversion\"`, `\"zscore\"`) and `portfolio` a position rule (`\"equal_weight\"`, `\"cross_sectional\"`, `\"long_short\"`); either may instead be a handle from `momentum(...)`, `long_short(...)`, etc. Returns a record with `.metrics` (a map of `sharpe`, `sortino`, `maxDrawdown`, `calmar`, `hitRate`, `turnover`), `.equity` and `.port_returns` (DataFrames), and `.weights`.",
    "kind": "quant",
    "returns": "Object",
    "effect": "async",
    "params": [
      {
        "name": "prices",
        "type": "any"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "walk_forward": {
    "description": "Walk-forward (out-of-sample) backtest: split the series into `folds` segments after an initial `min_train_fraction` training window and stitch the per-fold out-of-sample returns. Same arguments and result shape as `backtest`.",
    "kind": "quant",
    "returns": "Object",
    "effect": "async",
    "params": [
      {
        "name": "prices",
        "type": "any"
      },
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "momentum": {
    "description": "Build a momentum signal handle (trailing return over `lookback` periods) to pass to `backtest`/`walk_forward` as `signal=`.",
    "kind": "quant",
    "returns": "Function",
    "params": [
      {
        "name": "lookback",
        "type": "int",
        "optional": true,
        "defaultValue": 20
      }
    ]
  },
  "mean_reversion": {
    "description": "Build a mean-reversion signal handle (the negated `lookback` momentum) for use as `signal=`.",
    "kind": "quant",
    "returns": "Function",
    "params": [
      {
        "name": "lookback",
        "type": "int",
        "optional": true,
        "defaultValue": 20
      }
    ]
  },
  "zscore": {
    "description": "Build a z-score signal handle (rolling standardized price over `window`) for use as `signal=`.",
    "kind": "quant",
    "returns": "Function",
    "params": [
      {
        "name": "window",
        "type": "int",
        "optional": true,
        "defaultValue": 20
      }
    ]
  },
  "equal_weight": {
    "description": "Portfolio handle weighting every active asset equally by sign, for use as `portfolio=`.",
    "kind": "quant",
    "returns": "Function",
    "params": []
  },
  "cross_sectional": {
    "description": "Portfolio handle that demeans the signal across assets and scales to unit gross exposure, for use as `portfolio=`.",
    "kind": "quant",
    "returns": "Function",
    "params": []
  },
  "long_short": {
    "description": "Portfolio handle going long the top `fraction` and short the bottom `fraction` of ranked assets, for use as `portfolio=`.",
    "kind": "quant",
    "returns": "Function",
    "params": [
      {
        "name": "fraction",
        "type": "float",
        "optional": true,
        "defaultValue": 0.5
      }
    ]
  },
  "sharpe": {
    "description": "Annualized Sharpe ratio of a returns array or a single-column returns `DataFrame`.",
    "kind": "quant",
    "returns": "float",
    "params": [
      {
        "name": "returns",
        "type": "any"
      },
      {
        "name": "periods_per_year",
        "type": "int",
        "optional": true
      }
    ]
  },
  "deflated_sharpe": {
    "description": "Deflated Sharpe ratio — the probability the strategy's Sharpe is real after accounting for the count and dispersion of `trial_sharpes` searched over (guards against selection bias).",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "pbo": {
    "description": "Probability of Backtest Overfitting via combinatorially symmetric cross-validation over a time × trial matrix (rows of returns, one column per candidate strategy). Accepts a matrix or a `DataFrame`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "min_track_record_length": {
    "description": "Minimum count of observations needed before the observed Sharpe exceeds `target_sharpe` at the given `confidence`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "risk_parity": {
    "description": "Equal-risk-contribution portfolio weights for a covariance matrix. Passing a returns `DataFrame` estimates the sample covariance first. Returns a weight array.",
    "kind": "quant",
    "returns": "Array",
    "effect": "async",
    "params": [
      {
        "name": "cov",
        "type": "any"
      }
    ]
  },
  "hrp": {
    "description": "Hierarchical Risk Parity weights — cluster assets by correlation and allocate by recursive bisection. Accepts a covariance matrix or a returns `DataFrame`.",
    "kind": "quant",
    "returns": "Array",
    "effect": "async",
    "params": [
      {
        "name": "cov",
        "type": "any"
      }
    ]
  },
  "mean_variance": {
    "description": "Mean-variance optimal weights for expected returns `mu` and covariance `cov` (a matrix or a returns `DataFrame`), normalized to unit gross exposure.",
    "kind": "quant",
    "returns": "Array",
    "effect": "async",
    "params": [
      {
        "name": "mu",
        "type": "any"
      },
      {
        "name": "cov",
        "type": "any"
      }
    ]
  },
  "quill": {
    "description": "Parse and type-check a Quill product definition from a source string and return a product handle. Call `.price(rate=..., spot=..., vol=..., paths?=..., seed?=..., greeks?=...)` on it to run the Monte-Carlo pricer; the result has `.price`, `.standard_error`, and a `.greeks` map (`delta`, `vega`, `rho`, …). `greeks` is `\"price-only\"`, `\"first-order\"`, or `\"full\"`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "load_quill": {
    "description": "Like `quill`, but read the Quill product definition from a file `path`. Returns the same product handle with a `.price(...)` method and a `.name` field.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "adf_test": {
    "description": "Augmented Dickey-Fuller unit-root test. Returns a record with `statistic`, `criticalValues`, and `stationary` (true when the statistic is below the critical value).",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "kpss_test": {
    "description": "KPSS stationarity test (null hypothesis: the series is stationary). Returns `statistic`, `criticalValues`, `stationary`. Complements `adf_test`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "hurst_exponent": {
    "description": "Hurst exponent from rescaled-range analysis. `< 0.5` mean-reverting, `~0.5` random walk, `> 0.5` trending.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "half_life": {
    "description": "Ornstein-Uhlenbeck mean-reversion half-life (in periods) estimated by regressing the change on the lagged level.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "engle_granger": {
    "description": "Engle-Granger two-step cointegration test: regress `dependent` on `regressors`, then ADF-test the residual. Returns `statistic`, `criticalValues`, `cointegrated`, `hedgeRatio`, and `spread`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "johansen": {
    "description": "Johansen cointegration test on a matrix of price levels. Returns `eigenvalues`, `traceStatistics`, `maxEigenStatistics`, and the estimated cointegration `rank`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "cusum_events": {
    "description": "Symmetric CUSUM filter — returns the indices where the cumulative deviation exceeds `threshold`, used to sample structural-shift events.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "sadf": {
    "description": "Supremum ADF statistic — the max ADF over expanding windows, a test for explosive (bubble) behavior.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "bsadf": {
    "description": "Backward-SADF series — the running SADF at each point, for dating the start/end of explosive regimes.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "kalman_filter": {
    "description": "Linear Kalman filter over a state-space `spec` (transition, observation, process/measurement noise). Returns filtered `states`, `covariances`, and one-step innovations.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "kalman_smoother": {
    "description": "Rauch-Tung-Striebel smoother — the full-sample smoothed state matrix for the same state-space `spec` as `kalman_filter`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "dynamic_beta": {
    "description": "Time-varying hedge ratio / beta via a Kalman filter (random-walk coefficients). Returns the per-period `states` (betas) — the workhorse for dynamic pairs trading.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "fit_garch": {
    "description": "Fit a GARCH(1,1) volatility model by maximum likelihood. Returns a record with `params` (`omega`, `alpha`, `beta`), `log_likelihood`, and fitted `variances`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "garch_forecast": {
    "description": "Forecast conditional variance `horizon` steps ahead from GARCH `params` (as returned by `fit_garch`).",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "garch_volatility": {
    "description": "In-sample conditional volatility path (standard deviation per period) for the given GARCH `params`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "tick_bars": {
    "description": "Aggregate a `ticks` DataFrame (`price`, `volume`) into OHLC bars of fixed tick count. Returns a bar `DataFrame`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "volume_bars": {
    "description": "Information-driven bars sampled every fixed traded `volume_per_bar`. Returns a bar `DataFrame`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "dollar_bars": {
    "description": "Bars sampled every fixed traded dollar value — the most sample-stationary bar type. Returns a bar `DataFrame`.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "tick_rule": {
    "description": "Lee-Ready tick rule — signs each trade `+1`/`-1` by price change to infer aggressor side.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "roll_spread": {
    "description": "Roll's implied effective bid-ask spread from the serial covariance of price changes.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "amihud": {
    "description": "Amihud illiquidity — average of `|return| / dollar_volume`, a price-impact-per-dollar measure.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "kyle_lambda": {
    "description": "Kyle's lambda — price impact per signed volume, estimated by regressing price changes on signed order flow.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "vpin": {
    "description": "Volume-synchronized Probability of Informed Trading — order-flow-toxicity series over volume buckets.",
    "kind": "quant",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "EarlyStopping": {
    "description": "Stop training when a monitored metric stops improving for `patience` evaluations.",
    "kind": "callback",
    "returns": "Object",
    "params": [
      {
        "name": "monitor",
        "type": "string",
        "named": true
      },
      {
        "name": "patience",
        "type": "int",
        "optional": true,
        "named": true,
        "defaultValue": 3
      },
      {
        "name": "mode",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "min"
      }
    ]
  },
  "ModelCheckpoint": {
    "description": "Save the best model(s) according to a monitored metric.",
    "kind": "callback",
    "returns": "Object",
    "params": [
      {
        "name": "monitor",
        "type": "string",
        "named": true
      },
      {
        "name": "save_top_k",
        "type": "int",
        "optional": true,
        "named": true,
        "defaultValue": 1
      },
      {
        "name": "mode",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "min"
      }
    ]
  },
  "ProgressCallback": {
    "description": "Lightweight progress bar callback for the Trainer.",
    "kind": "callback",
    "returns": "Object",
    "params": []
  },
  "LearningRateMonitor": {
    "description": "Log the current learning rate at each step.",
    "kind": "callback",
    "returns": "Object",
    "params": []
  },
  "Timer": {
    "description": "Measure and log wall-clock time per epoch and total.",
    "kind": "callback",
    "returns": "Object",
    "params": []
  },
  "GradientAccumulationScheduler": {
    "description": "Accumulate gradients across multiple steps before updating, on a per-epoch schedule.",
    "kind": "callback",
    "returns": "Object",
    "params": [
      {
        "name": "scheduling",
        "type": "Object",
        "named": true
      }
    ]
  },
  "ConsoleLogger": {
    "description": "Send log records to stdout.",
    "kind": "logger",
    "returns": "Object",
    "params": []
  },
  "CSVLogger": {
    "description": "Append log records to a CSV file under `save_dir/name`.",
    "kind": "logger",
    "returns": "Object",
    "params": [
      {
        "name": "save_dir",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "logs"
      },
      {
        "name": "name",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "experiment"
      }
    ]
  },
  "Accuracy": {
    "description": "Classification accuracy metric. Configure with `task` (`binary`/`multiclass`/`multilabel`).",
    "kind": "metric",
    "returns": "Object",
    "params": [
      {
        "name": "task",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "binary"
      },
      {
        "name": "num_classes",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "top_k",
        "type": "int",
        "optional": true,
        "named": true,
        "defaultValue": 1
      }
    ]
  },
  "Precision": {
    "description": "Precision metric — fraction of positive predictions that are correct.",
    "kind": "metric",
    "returns": "Object",
    "params": [
      {
        "name": "task",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "binary"
      },
      {
        "name": "num_classes",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "average",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "macro"
      }
    ]
  },
  "Recall": {
    "description": "Recall metric — fraction of actual positives that are predicted positive.",
    "kind": "metric",
    "returns": "Object",
    "params": [
      {
        "name": "task",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "binary"
      },
      {
        "name": "num_classes",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "average",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "macro"
      }
    ]
  },
  "F1Score": {
    "description": "Harmonic mean of precision and recall.",
    "kind": "metric",
    "returns": "Object",
    "params": [
      {
        "name": "task",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "binary"
      },
      {
        "name": "num_classes",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "average",
        "type": "string",
        "optional": true,
        "named": true,
        "defaultValue": "macro"
      }
    ]
  },
  "ConfusionMatrix": {
    "description": "Cumulative confusion matrix over `num_classes`.",
    "kind": "metric",
    "returns": "Object",
    "params": [
      {
        "name": "num_classes",
        "type": "int",
        "named": true
      }
    ]
  },
  "MetricCollection": {
    "description": "Group multiple metrics into one callable for convenience.",
    "kind": "metric",
    "returns": "Object",
    "params": [
      {
        "name": "metrics",
        "type": "any",
        "optional": true,
        "rest": true
      }
    ]
  },
  "LinearRegression": {
    "description": "Ordinary least-squares linear regression (solved via `lstsq`).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "Ridge": {
    "description": "L2-regularized linear regression, closed-form via `solve`.",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "Lasso": {
    "description": "L1-regularized linear regression via coordinate descent (sparse coefficients).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "ElasticNet": {
    "description": "Combined L1/L2 linear regression via coordinate descent.",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "LogisticRegression": {
    "description": "Multinomial logistic regression (softmax) trained by gradient descent. Also exposes `predict_proba(X) -> Tensor`.",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "KNeighborsClassifier": {
    "description": "k-nearest-neighbors classifier (majority vote over Euclidean neighbors).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "KNeighborsRegressor": {
    "description": "k-nearest-neighbors regressor (mean of neighbor targets).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "GaussianNB": {
    "description": "Gaussian Naive Bayes classifier.",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "DecisionTreeClassifier": {
    "description": "CART decision-tree classifier (Gini impurity).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "DecisionTreeRegressor": {
    "description": "CART decision-tree regressor (variance reduction).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "RandomForestClassifier": {
    "description": "Bagged ensemble of decision trees (majority vote).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "RandomForestRegressor": {
    "description": "Bagged ensemble of decision trees (mean prediction).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "GradientBoostingClassifier": {
    "description": "Stage-wise gradient boosting for classification (multinomial deviance).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "GradientBoostingRegressor": {
    "description": "Stage-wise gradient boosting for regression (squared-error residuals).",
    "kind": "ml_model",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "StandardScaler": {
    "description": "Standardize features to zero mean and unit variance per column.",
    "kind": "ml_transform",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "MinMaxScaler": {
    "description": "Scale features to a given range per column.",
    "kind": "ml_transform",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "LabelEncoder": {
    "description": "Encode categorical labels to integer ids. `inverse_transform` returns the original labels.",
    "kind": "ml_transform",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "OneHotEncoder": {
    "description": "Encode categorical labels to one-hot rows.",
    "kind": "ml_transform",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "PCA": {
    "description": "Principal component analysis (via `svd`). Exposes `components_`, `explainedVariance_`, `explainedVarianceRatio_`.",
    "kind": "ml_transform",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "KMeans": {
    "description": "k-means clustering (k-means++ init). Exposes `clusterCenters_`, `labels_`, `inertia_`.",
    "kind": "ml_cluster",
    "returns": "KMeans",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ],
    "methods": [
      {
        "name": "fit",
        "params": [
          {
            "name": "X",
            "type": "Tensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "KMeans",
        "isGetter": false,
        "description": "Compute cluster centers from `X`."
      },
      {
        "name": "predict",
        "params": [
          {
            "name": "X",
            "type": "Tensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Assign each row of `X` to its nearest cluster."
      },
      {
        "name": "fit_predict",
        "params": [
          {
            "name": "X",
            "type": "Tensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Fit then return the training labels."
      }
    ]
  },
  "KFold": {
    "description": "K-fold cross-validation splitter.",
    "kind": "ml_split",
    "returns": "KFold",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ],
    "methods": [
      {
        "name": "split",
        "params": [
          {
            "name": "n",
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Record[]",
        "isGetter": false,
        "description": "Return `n_splits` `{train, test}` index partitions for `n` samples."
      }
    ]
  },
  "TimeSeriesSplit": {
    "description": "Expanding-window splitter for time-ordered data.",
    "kind": "ml_split",
    "returns": "TimeSeriesSplit",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ],
    "methods": [
      {
        "name": "split",
        "params": [
          {
            "name": "n",
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Record[]",
        "isGetter": false,
        "description": "Return forward-chaining `{train, test}` index partitions."
      }
    ]
  },
  "GridSearchCV": {
    "description": "Exhaustive hyperparameter search with cross-validation. Pass an estimator constructor and a grid of parameter arrays.",
    "kind": "grid_search",
    "returns": "GridSearchCV",
    "params": [
      {
        "name": "estimator",
        "type": "any"
      },
      {
        "name": "param_grid",
        "type": "any"
      },
      {
        "name": "cv",
        "type": "int",
        "optional": true,
        "named": true
      }
    ],
    "methods": [
      {
        "name": "fit",
        "params": [
          {
            "name": "X",
            "type": "Tensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "y",
            "type": "Tensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "GridSearchCV",
        "isGetter": false,
        "description": "Search all parameter combinations and refit the best on the full data. Sets `bestParams_`, `bestScore_`, `bestEstimator_`."
      },
      {
        "name": "predict",
        "params": [
          {
            "name": "X",
            "type": "Tensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Predict using the best found estimator."
      }
    ]
  },
  "train_test_split": {
    "description": "Split data into train/test partitions. With `y`, returns `[X_train, X_test, y_train, y_test]`; with only `X`, returns `[X_train, X_test]`.",
    "kind": "ml_function",
    "returns": "Array",
    "params": [
      {
        "name": "X",
        "type": "any"
      },
      {
        "name": "y",
        "type": "any",
        "optional": true
      },
      {
        "name": "test_size",
        "type": "float",
        "optional": true,
        "named": true
      },
      {
        "name": "shuffle",
        "type": "bool",
        "optional": true,
        "named": true
      },
      {
        "name": "random_state",
        "type": "int",
        "optional": true,
        "named": true
      }
    ]
  },
  "cross_val_score": {
    "description": "Cross-validated scores for an estimator constructor over `cv` folds.",
    "kind": "ml_function",
    "returns": "Array",
    "params": [
      {
        "name": "estimator",
        "type": "any"
      },
      {
        "name": "X",
        "type": "any"
      },
      {
        "name": "y",
        "type": "any"
      },
      {
        "name": "cv",
        "type": "int",
        "optional": true,
        "named": true
      }
    ]
  },
  "r2_score": {
    "description": "Coefficient of determination (R²).",
    "kind": "ml_metric",
    "returns": "any",
    "params": [
      {
        "name": "y_true",
        "type": "any"
      },
      {
        "name": "y_pred",
        "type": "any"
      }
    ]
  },
  "mean_squared_error": {
    "description": "Mean squared error.",
    "kind": "ml_metric",
    "returns": "any",
    "params": [
      {
        "name": "y_true",
        "type": "any"
      },
      {
        "name": "y_pred",
        "type": "any"
      }
    ]
  },
  "mean_absolute_error": {
    "description": "Mean absolute error.",
    "kind": "ml_metric",
    "returns": "any",
    "params": [
      {
        "name": "y_true",
        "type": "any"
      },
      {
        "name": "y_pred",
        "type": "any"
      }
    ]
  },
  "accuracy_score": {
    "description": "Classification accuracy.",
    "kind": "ml_metric",
    "returns": "any",
    "params": [
      {
        "name": "y_true",
        "type": "any"
      },
      {
        "name": "y_pred",
        "type": "any"
      }
    ]
  },
  "confusion_matrix": {
    "description": "Confusion matrix as a nested array.",
    "kind": "ml_metric",
    "returns": "any",
    "params": [
      {
        "name": "y_true",
        "type": "any"
      },
      {
        "name": "y_pred",
        "type": "any"
      }
    ]
  },
  "svd": {
    "description": "Reduced singular value decomposition. Returns `{U, S, V}` with `input ≈ U diag(S) Vᵀ`.",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "eigh": {
    "description": "Symmetric eigendecomposition. Returns `{values, vectors}` (ascending eigenvalues).",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "cholesky": {
    "description": "Cholesky factor `L` (lower-triangular) of a symmetric positive-definite matrix.",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "solve": {
    "description": "Solve the linear system `a @ x = b` for `x`.",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "lstsq": {
    "description": "Least-squares solution to `a @ x ≈ b` (via pseudo-inverse).",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "inv": {
    "description": "Matrix inverse.",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "pinv": {
    "description": "Moore-Penrose pseudo-inverse.",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "det": {
    "description": "Determinant (scalar).",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "cov": {
    "description": "Covariance matrix of the columns of `input`.",
    "kind": "linalg",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "normal_cdf": {
    "description": "Normal distribution cumulative distribution function, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "normal_ppf": {
    "description": "Normal distribution quantile function (inverse CDF), applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "normal_pdf": {
    "description": "Normal distribution probability density function, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "t_cdf": {
    "description": "Student's t cumulative distribution function with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "t_ppf": {
    "description": "Student's t quantile function (inverse CDF) with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "t_pdf": {
    "description": "Student's t probability density function with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "chi2_cdf": {
    "description": "Chi-squared cumulative distribution function with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "chi2_ppf": {
    "description": "Chi-squared quantile function (inverse CDF) with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "chi2_pdf": {
    "description": "Chi-squared probability density function with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "f_cdf": {
    "description": "F distribution cumulative distribution function with `d1` and `d2` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "f_ppf": {
    "description": "F distribution quantile function (inverse CDF) with `d1` and `d2` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "f_pdf": {
    "description": "F distribution probability density function with `d1` and `d2` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "float",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "erf": {
    "description": "Error function, applied elementwise.",
    "kind": "numeric_func",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "erfc": {
    "description": "Complementary error function, applied elementwise.",
    "kind": "numeric_func",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "lgamma": {
    "description": "Natural logarithm of the absolute value of the gamma function, applied elementwise.",
    "kind": "numeric_func",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "gamma": {
    "description": "Gamma function, applied elementwise.",
    "kind": "numeric_func",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "fft": {
    "description": "Discrete Fourier transform of a 1-D real or `[n, 2]` complex signal. Returns an `[n, 2]` Tensor of real/imaginary pairs.",
    "kind": "numeric_transform",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "ifft": {
    "description": "Inverse discrete Fourier transform of a 1-D real or `[n, 2]` complex signal. Returns an `[n, 2]` Tensor of real/imaginary pairs.",
    "kind": "numeric_transform",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "qr": {
    "description": "QR decomposition. Returns `{Q, R}` with `input = Q @ R`.",
    "kind": "numeric_transform",
    "returns": "any",
    "params": [
      {
        "name": "input",
        "type": "any"
      }
    ]
  },
  "linear_interp": {
    "description": "Piecewise-linear interpolation of the points `(xs, ys)` evaluated at `xq` (an int, float, or array of numeric values).",
    "kind": "numeric_func",
    "returns": "any",
    "params": []
  },
  "cubic_spline": {
    "description": "Natural cubic spline interpolant through the points `(xs, ys)`.",
    "kind": "numeric_func",
    "returns": "CubicSpline",
    "params": [],
    "methods": [
      {
        "name": "evaluate",
        "params": [
          {
            "name": "xq",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "float",
        "isGetter": false,
        "description": "Evaluate the spline at a query point or a array of query points."
      }
    ]
  },
  "t_test_1samp": {
    "description": "One-sample t-test of the mean of `x` against `popmean`. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "t_test_ind": {
    "description": "Two-sample independent t-test. `equal_var=true` pools variances; `equal_var=false` uses the Welch unequal-variance form. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "t_test_paired": {
    "description": "Paired t-test on matched samples `x` and `y`. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "chi2_gof": {
    "description": "Chi-square goodness-of-fit test of `observed` counts against `expected` counts (uniform when omitted). Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "chi2_independence": {
    "description": "Chi-square test of independence on a 2-D contingency `table`. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "ks_test_1samp": {
    "description": "One-sample Kolmogorov-Smirnov test of `x` against a reference CDF (normal with `loc`/`scale` by default). Returns a record with `statistic`, `pvalue`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "ks_test_2samp": {
    "description": "Two-sample Kolmogorov-Smirnov test comparing the empirical distributions of `x` and `y`. Returns a record with `statistic`, `pvalue`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "jarque_bera": {
    "description": "Jarque-Bera normality test built from sample skewness and kurtosis. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "dagostino_k2": {
    "description": "D'Agostino K-squared normality test combining skewness and kurtosis z-scores. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "anderson_darling": {
    "description": "Anderson-Darling normality test with the small-sample corrected p-value. Returns a record with `statistic`, `pvalue`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "mann_whitney_u": {
    "description": "Mann-Whitney U rank-sum test with normal approximation, tie correction, and continuity correction. Returns a record with `statistic`, `pvalue`.",
    "kind": "numeric_stats_test",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "acf": {
    "description": "Sample autocorrelation function of `x` up to `nlags` (FFT-based). Returns a Tensor of length `nlags + 1` with lag 0 equal to 1.",
    "kind": "numeric_timeseries",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "pacf": {
    "description": "Partial autocorrelation function of `x` via Levinson-Durbin recursion. Returns a Tensor of length `nlags + 1` with lag 0 equal to 1.",
    "kind": "numeric_timeseries",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "ljung_box": {
    "description": "Ljung-Box test for autocorrelation up to `lags`. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_timeseries",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "durbin_watson": {
    "description": "Durbin-Watson statistic of a residual series; values near 2 indicate no first-order autocorrelation.",
    "kind": "numeric_timeseries",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "periodogram": {
    "description": "Power spectrum of `x` at frequencies `k / n` for `k = 0..n/2`. Returns a Tensor of length `n/2 + 1`.",
    "kind": "numeric_timeseries",
    "returns": "Object",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "convolve": {
    "description": "FFT-based linear convolution of two 1-D signals. `mode` is `\"full\"`, `\"same\"`, or `\"valid\"`.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "correlate": {
    "description": "FFT-based cross-correlation of two 1-D signals. `mode` is `\"full\"`, `\"same\"`, or `\"valid\"`.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "rolling_mean": {
    "description": "Rolling mean over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "rolling_std": {
    "description": "Rolling standard deviation over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "rolling_sum": {
    "description": "Rolling sum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "rolling_min": {
    "description": "Rolling minimum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "rolling_max": {
    "description": "Rolling maximum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "polyfit": {
    "description": "Least-squares polynomial fit of degree `deg` to the points `(x, y)`. Returns coefficients ordered from the highest degree down.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "polyval": {
    "description": "Evaluate a polynomial with coefficients ordered from the highest degree down at `x` (an int, float, array, or Tensor).",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "polyroots": {
    "description": "All complex roots of a polynomial via Durand-Kerner iteration. Returns a `[deg, 2]` Tensor of real/imaginary pairs.",
    "kind": "numeric_array_op",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "random_uniform": {
    "description": "Seeded uniform samples on `[low, high)` with the given shape.",
    "kind": "numeric_random",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "random_normal": {
    "description": "Seeded normal samples with mean `loc` and standard deviation `scale`.",
    "kind": "numeric_random",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "random_t": {
    "description": "Seeded Student t samples with `df` degrees of freedom.",
    "kind": "numeric_random",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "random_chi2": {
    "description": "Seeded chi-square samples with `df` degrees of freedom.",
    "kind": "numeric_random",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "random_exponential": {
    "description": "Seeded exponential samples with the given `scale` (mean).",
    "kind": "numeric_random",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "multivariate_normal": {
    "description": "Seeded multivariate normal samples via the Cholesky factor of `cov`. Returns an `[n, d]` Tensor.",
    "kind": "numeric_random",
    "returns": "any",
    "params": [
      {
        "name": "options",
        "type": "Object",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  }
} satisfies Record<string, TeraBuiltinSpec>;

export const TERA_KIND_METHODS = {
  "module": [
    {
      "name": "forward",
      "params": [
        {
          "name": "x",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Run the module's forward pass. Calling the module directly (`module(x)`) is equivalent to `module.forward(x)`."
    },
    {
      "name": "parameters",
      "params": [],
      "returns": "Tensor[]",
      "isGetter": false,
      "description": "Return an array of the module's learnable parameter tensors."
    },
    {
      "name": "train",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Set the module to training mode (enables Dropout, updates BatchNorm running stats)."
    },
    {
      "name": "eval",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Set the module to evaluation mode (disables Dropout, freezes BatchNorm stats)."
    },
    {
      "name": "to",
      "params": [
        {
          "name": "device",
          "type": "string",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "Module",
      "isGetter": false,
      "description": "Move the module's parameters to a device (`\"cpu\"`, `\"gpu\"`, `\"webgpu\"`) and return it."
    }
  ],
  "sequential": [
    {
      "name": "forward",
      "params": [
        {
          "name": "x",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Run inputs sequentially through each contained module."
    },
    {
      "name": "parameters",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Return parameters of all contained modules concatenated."
    },
    {
      "name": "train",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Switch all submodules to training mode."
    },
    {
      "name": "eval",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Switch all submodules to evaluation mode."
    }
  ],
  "optimizer": [
    {
      "name": "step",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Apply one optimizer update step using the current gradients."
    },
    {
      "name": "zero_grad",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Zero out gradients of all tracked parameters before the next backward pass."
    },
    {
      "name": "param_groups",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Return the array of parameter groups (each with its own learning rate, weight decay, etc.)."
    }
  ],
  "scheduler": [
    {
      "name": "step",
      "params": [
        {
          "name": "metric",
          "type": null,
          "optional": true,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Advance the scheduler by one step. Some schedulers (`ReduceLROnPlateau`) require a monitored metric."
    },
    {
      "name": "get_last_lr",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Return the most recently computed learning rate(s)."
    }
  ],
  "metric": [
    {
      "name": "update",
      "params": [
        {
          "name": "preds",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "target",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Update internal state with a new batch of predictions and ground-truth labels."
    },
    {
      "name": "compute",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Compute the current metric value across all accumulated updates."
    },
    {
      "name": "reset",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Clear accumulated state so the next epoch starts fresh."
    }
  ],
  "callback": [
    {
      "name": "on_train_start",
      "params": [
        {
          "name": "trainer",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "model",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Hook fired at the start of training."
    },
    {
      "name": "on_train_end",
      "params": [
        {
          "name": "trainer",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "model",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Hook fired at the end of training."
    },
    {
      "name": "on_epoch_start",
      "params": [
        {
          "name": "trainer",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "model",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Hook fired at the start of each epoch."
    },
    {
      "name": "on_epoch_end",
      "params": [
        {
          "name": "trainer",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "model",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Hook fired at the end of each epoch."
    }
  ],
  "logger": [
    {
      "name": "log",
      "params": [
        {
          "name": "name",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "value",
          "type": null,
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "step",
          "type": null,
          "optional": true,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Record a scalar metric value."
    },
    {
      "name": "flush",
      "params": [],
      "returns": null,
      "isGetter": false,
      "description": "Flush buffered records to the underlying sink."
    }
  ],
  "trainer": [
    {
      "name": "fit",
      "params": [
        {
          "name": "model",
          "type": "Module",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "train_loader",
          "type": "DataLoader",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "val_loader",
          "type": "DataLoader",
          "optional": true,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Run the full training loop."
    },
    {
      "name": "validate",
      "params": [
        {
          "name": "model",
          "type": "Module",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "loader",
          "type": "DataLoader",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Run validation only."
    },
    {
      "name": "test",
      "params": [
        {
          "name": "model",
          "type": "Module",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "loader",
          "type": "DataLoader",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Run the model in eval mode and report logged metrics."
    },
    {
      "name": "predict",
      "params": [
        {
          "name": "model",
          "type": "Module",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "loader",
          "type": "DataLoader",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": null,
      "isGetter": false,
      "description": "Run the model in eval mode and return collected outputs.\n\n# Pseudo-types\n\nThese don't correspond to a builtin call but capture the type of common results."
    }
  ],
  "ml_model": [
    {
      "name": "fit",
      "params": [
        {
          "name": "X",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "y",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "Model",
      "isGetter": false,
      "description": "Fit the estimator to training features `X` and targets `y`. Returns the fitted model."
    },
    {
      "name": "predict",
      "params": [
        {
          "name": "X",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "Tensor",
      "isGetter": false,
      "description": "Predict targets/labels for the rows of `X`."
    },
    {
      "name": "score",
      "params": [
        {
          "name": "X",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "y",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "float",
      "isGetter": false,
      "description": "Return the model's default score (R² for regressors, accuracy for classifiers)."
    }
  ],
  "ml_transform": [
    {
      "name": "fit",
      "params": [
        {
          "name": "X",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "Transformer",
      "isGetter": false,
      "description": "Learn the transform parameters from `X`."
    },
    {
      "name": "transform",
      "params": [
        {
          "name": "X",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "Tensor",
      "isGetter": false,
      "description": "Apply the learned transform to `X`."
    },
    {
      "name": "fit_transform",
      "params": [
        {
          "name": "X",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "Tensor",
      "isGetter": false,
      "description": "Fit then transform `X` in one call."
    },
    {
      "name": "inverse_transform",
      "params": [
        {
          "name": "X",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "Tensor",
      "isGetter": false,
      "description": "Map transformed data back to the original space (where supported)."
    }
  ]
} satisfies Record<string, TeraMethodSpec[]>;

export const TERA_PSEUDO_TYPES = {
  "Tensor": {
    "methods": [
      {
        "name": "shape",
        "params": [],
        "returns": "int[]",
        "isGetter": true,
        "description": "Return the shape (size-per-dimension array) of the tensor."
      },
      {
        "name": "dtype",
        "params": [],
        "returns": "string",
        "isGetter": true,
        "description": "Return the dtype string of the tensor."
      },
      {
        "name": "reshape",
        "params": [
          {
            "name": "shape",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Return a view with the given shape; total element count must match."
      },
      {
        "name": "transpose",
        "params": [
          {
            "name": "dim0",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "dim1",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Swap two dimensions."
      },
      {
        "name": "permute",
        "params": [
          {
            "name": "dims",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Reorder all dimensions per the permutation array."
      },
      {
        "name": "expand",
        "params": [
          {
            "name": "shape",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Broadcast to a larger shape without copying memory."
      },
      {
        "name": "slice",
        "params": [
          {
            "name": "dim",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "start",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "end",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "step",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": "1"
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "View a contiguous slice along the given dimension."
      },
      {
        "name": "unsqueeze",
        "params": [
          {
            "name": "dim",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Insert a size-1 dimension at the given position."
      },
      {
        "name": "squeeze",
        "params": [
          {
            "name": "dim",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Remove a size-1 dimension at the given position."
      },
      {
        "name": "narrow",
        "params": [
          {
            "name": "dim",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "start",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "length",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Take `length` elements starting at `start` along `dim`."
      },
      {
        "name": "select",
        "params": [
          {
            "name": "dim",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "index",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Select a single index along `dim`, removing that dimension."
      },
      {
        "name": "contiguous",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Return a row-major contiguous copy of the tensor."
      },
      {
        "name": "detach",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Return a copy detached from the autograd graph."
      },
      {
        "name": "backward",
        "params": [
          {
            "name": "gradient",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Propagate gradients backward from this tensor."
      },
      {
        "name": "requires_grad",
        "params": [
          {
            "name": "flag",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": "true"
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Enable or disable gradient tracking on this tensor."
      },
      {
        "name": "grad",
        "params": [],
        "returns": "Tensor | null",
        "isGetter": true,
        "description": "Read the accumulated gradient of this leaf tensor."
      },
      {
        "name": "length",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Total count of elements (numel)."
      },
      {
        "name": "neg",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise unary negation."
      },
      {
        "name": "exp",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise natural exponential `e^x`."
      },
      {
        "name": "log",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise natural logarithm."
      },
      {
        "name": "sqrt",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise square root."
      },
      {
        "name": "rsqrt",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise reciprocal square root `1/√x`."
      },
      {
        "name": "abs",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise absolute value."
      },
      {
        "name": "sin",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise sine."
      },
      {
        "name": "cos",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise cosine."
      },
      {
        "name": "tanh",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise hyperbolic tangent."
      },
      {
        "name": "sigmoid",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise logistic sigmoid `1/(1+e^-x)`."
      },
      {
        "name": "relu",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise ReLU activation."
      },
      {
        "name": "gelu",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Gaussian Error Linear Unit activation."
      },
      {
        "name": "silu",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "SiLU/Swish activation: `x * sigmoid(x)`."
      },
      {
        "name": "sign",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise sign: `-1`, `0`, or `+1`."
      },
      {
        "name": "floor",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise floor (round toward `-∞`)."
      },
      {
        "name": "ceil",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise ceiling (round toward `+∞`)."
      },
      {
        "name": "clone",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Return a deep copy of the tensor (separate storage)."
      },
      {
        "name": "add",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise addition; scalars are auto-promoted."
      },
      {
        "name": "sub",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise subtraction; scalars are auto-promoted."
      },
      {
        "name": "mul",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise multiplication; scalars are auto-promoted."
      },
      {
        "name": "div",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise division; scalars are auto-promoted."
      },
      {
        "name": "pow",
        "params": [
          {
            "name": "exponent",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise power `x ** exponent`."
      },
      {
        "name": "remainder",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise floored remainder (sign follows divisor)."
      },
      {
        "name": "maximum",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise maximum of two tensors."
      },
      {
        "name": "minimum",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise minimum of two tensors."
      },
      {
        "name": "eq",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise equality comparison. Returns a boolean tensor."
      },
      {
        "name": "ne",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise inequality comparison."
      },
      {
        "name": "lt",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise less-than comparison."
      },
      {
        "name": "le",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise less-than-or-equal comparison."
      },
      {
        "name": "gt",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise greater-than comparison."
      },
      {
        "name": "ge",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Element-wise greater-than-or-equal comparison."
      },
      {
        "name": "matmul",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Matrix multiplication; broadcasts on leading batch dimensions."
      },
      {
        "name": "dot",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Inner (dot) product of two 1-D tensors."
      },
      {
        "name": "sum",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Sum over `axis` (or the whole tensor); `keep` retains reduced dims."
      },
      {
        "name": "mean",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Arithmetic mean over `axis` (or the whole tensor); `keep` retains reduced dims."
      },
      {
        "name": "max",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Maximum over `axis` (or the whole tensor); `keep` retains reduced dims."
      },
      {
        "name": "min",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Minimum over `axis` (or the whole tensor); `keep` retains reduced dims."
      },
      {
        "name": "argmax",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Index of the maximum along `axis`; `keep` retains reduced dims."
      },
      {
        "name": "argmin",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Index of the minimum along `axis`; `keep` retains reduced dims."
      },
      {
        "name": "prod",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Product of elements over `axis` (or the whole tensor); `keep` retains reduced dims."
      },
      {
        "name": "softmax",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": "-1"
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Softmax along `axis`, normalizing to a probability distribution."
      },
      {
        "name": "log_softmax",
        "params": [
          {
            "name": "axis",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": "-1"
          }
        ],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Logarithm of softmax along `axis`, numerically stable."
      }
    ]
  },
  "Model": {
    "methods": [
      {
        "name": "parameters",
        "params": [],
        "returns": "Tensor[]",
        "isGetter": false,
        "description": "Return the model's learnable parameter tensors."
      },
      {
        "name": "forward",
        "params": [
          {
            "name": "*args",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Run the model's forward block. Calling the model directly is equivalent."
      },
      {
        "name": "train",
        "params": [],
        "returns": "Model",
        "isGetter": false,
        "description": "Set training mode."
      },
      {
        "name": "eval",
        "params": [],
        "returns": "Model",
        "isGetter": false,
        "description": "Set evaluation mode."
      },
      {
        "name": "to",
        "params": [
          {
            "name": "device",
            "type": "string",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Model",
        "isGetter": false,
        "description": "Move the model's parameters to a device (`\"cpu\"`, `\"gpu\"`, `\"webgpu\"`) and return it."
      },
      {
        "name": "state_dict",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Return a serializable object of parameter tensors."
      },
      {
        "name": "load_state_dict",
        "params": [
          {
            "name": "state",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Load parameter tensors from a previously saved object."
      },
      {
        "name": "save",
        "params": [
          {
            "name": "path",
            "type": "string",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "none",
        "isGetter": false,
        "description": "Save the model's weights to `path` (compact binary checkpoint). Reload into a same-architecture model with `load_model(model, path)`."
      }
    ]
  },
  "DataFrame": {
    "methods": [
      {
        "name": "columns",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Return the column names as an array of strings."
      },
      {
        "name": "schema",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Return the frame's schema (fields with names and data types)."
      },
      {
        "name": "explain",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Return the logical query plan as a human-readable string."
      },
      {
        "name": "select",
        "params": [
          {
            "name": "columns",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Project a new frame from the given columns or `Column` expressions."
      },
      {
        "name": "filter",
        "params": [
          {
            "name": "condition",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Keep only rows matching a boolean `Column` (or SQL string) condition."
      },
      {
        "name": "where",
        "params": [
          {
            "name": "condition",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Alias for `filter`."
      },
      {
        "name": "with_column",
        "params": [
          {
            "name": "name",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "column",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Return a new frame with an added or replaced column computed from `column`."
      },
      {
        "name": "drop",
        "params": [
          {
            "name": "columns",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Return a new frame without the named columns."
      },
      {
        "name": "group_by",
        "params": [
          {
            "name": "columns",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "GroupedData",
        "isGetter": false,
        "description": "Group rows by the given columns, returning a `GroupedData` for aggregation."
      },
      {
        "name": "order_by",
        "params": [
          {
            "name": "specs",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Sort rows. Each spec is a column name/`Column`, or `{ col, desc }` for ordering."
      },
      {
        "name": "sort",
        "params": [
          {
            "name": "specs",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Alias for `order_by`."
      },
      {
        "name": "limit",
        "params": [
          {
            "name": "count",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "offset",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": "0"
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Return at most `count` rows, skipping the first `offset` rows."
      },
      {
        "name": "head",
        "params": [
          {
            "name": "n",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": "5"
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Return the first `n` rows as a new frame (pandas-style preview)."
      },
      {
        "name": "distinct",
        "params": [],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Return a frame with duplicate rows removed."
      },
      {
        "name": "union",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Concatenate the rows of another frame with matching column types."
      },
      {
        "name": "union_all",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Concatenate rows of another frame, keeping duplicates."
      },
      {
        "name": "join",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "on",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "how",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": "\"INNER\""
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Join with another frame on one or more key columns. `how` is one of\n`INNER`, `LEFT`, `RIGHT`, or `FULL`."
      },
      {
        "name": "collect",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Execute the plan and return all rows as an array of objects."
      },
      {
        "name": "to_array",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Alias for `collect`."
      },
      {
        "name": "count",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Execute the plan and return the row count."
      },
      {
        "name": "show",
        "params": [
          {
            "name": "n",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": "20"
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Execute and print the first `n` rows as a formatted table; returns the text."
      },
      {
        "name": "chunks",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Execute and stream results as an async iterator of data chunks."
      },
      {
        "name": "to_tensor",
        "params": [
          {
            "name": "columns",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Materialize the (optionally selected) numeric columns into a 2-D tensor of\nshape `[rows, columns]`. Non-numeric columns raise — encode them first."
      },
      {
        "name": "to_array",
        "params": [],
        "returns": null,
        "isGetter": false,
        "description": "Alias for `collect` — execute and return rows as an array of objects."
      },
      {
        "name": "encode",
        "params": [
          {
            "name": "column",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "classes",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": null,
        "isGetter": false,
        "description": "Encode a categorical column to integer ids, returning `[encoded_tensor,\nclasses_array]`. Pass `classes=` to reuse ids fitted on another frame."
      }
    ]
  },
  "GroupedData": {
    "methods": [
      {
        "name": "agg",
        "params": [
          {
            "name": "columns",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "DataFrame",
        "isGetter": false,
        "description": "Apply aggregate `Column` expressions (e.g. `sum`, `avg`, `count`) over each\ngroup, returning a `DataFrame` of group keys and aggregates."
      }
    ]
  },
  "Column": {
    "methods": [
      {
        "name": "alias",
        "params": [
          {
            "name": "name",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Rename the column's output to `name`."
      },
      {
        "name": "as",
        "params": [
          {
            "name": "name",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Alias for `alias`."
      },
      {
        "name": "add",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Arithmetic addition with another column or value."
      },
      {
        "name": "sub",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Arithmetic subtraction with another column or value."
      },
      {
        "name": "mul",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Arithmetic multiplication with another column or value."
      },
      {
        "name": "div",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Arithmetic division with another column or value."
      },
      {
        "name": "eq",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Equality comparison, producing a boolean column."
      },
      {
        "name": "ne",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Inequality comparison, producing a boolean column."
      },
      {
        "name": "lt",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Less-than comparison, producing a boolean column."
      },
      {
        "name": "le",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Less-than-or-equal comparison, producing a boolean column."
      },
      {
        "name": "gt",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Greater-than comparison, producing a boolean column."
      },
      {
        "name": "ge",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Greater-than-or-equal comparison, producing a boolean column."
      },
      {
        "name": "and",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Logical AND of two boolean columns."
      },
      {
        "name": "or",
        "params": [
          {
            "name": "other",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Logical OR of two boolean columns."
      },
      {
        "name": "not",
        "params": [],
        "returns": "Column",
        "isGetter": false,
        "description": "Logical negation of a boolean column."
      },
      {
        "name": "is_null",
        "params": [],
        "returns": "Column",
        "isGetter": false,
        "description": "True where the column value is null."
      },
      {
        "name": "is_not_null",
        "params": [],
        "returns": "Column",
        "isGetter": false,
        "description": "True where the column value is not null."
      },
      {
        "name": "like",
        "params": [
          {
            "name": "pattern",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "SQL `LIKE` match against a string pattern."
      },
      {
        "name": "between",
        "params": [
          {
            "name": "low",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "high",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "True where the value lies in the inclusive range `[low, high]`."
      },
      {
        "name": "isin",
        "params": [
          {
            "name": "values",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "True where the value is one of the given values."
      },
      {
        "name": "cast",
        "params": [
          {
            "name": "targetType",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Column",
        "isGetter": false,
        "description": "Cast the column to another data type."
      }
    ]
  },
  "Array": {
    "methods": [
      {
        "name": "push",
        "params": [
          {
            "name": "x",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "int",
        "isGetter": false,
        "description": "Add `x` to the end of the array and return the new length."
      },
      {
        "name": "pop",
        "params": [],
        "returns": "any",
        "isGetter": false,
        "description": "Remove and return the last element."
      },
      {
        "name": "shift",
        "params": [],
        "returns": "any",
        "isGetter": false,
        "description": "Remove and return the first element."
      },
      {
        "name": "unshift",
        "params": [
          {
            "name": "x",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "int",
        "isGetter": false,
        "description": "Insert `x` at the front and return the new length."
      },
      {
        "name": "splice",
        "params": [
          {
            "name": "start",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "count",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "items",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "Array",
        "isGetter": false,
        "description": "Remove `count` elements starting at `start`, inserting `items` in their place, and\nreturn the removed elements."
      },
      {
        "name": "slice",
        "params": [
          {
            "name": "start",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "end",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Array",
        "isGetter": false,
        "description": "Return a shallow copy of the range `[start, end)`. Negative indices count from the end."
      },
      {
        "name": "concat",
        "params": [
          {
            "name": "arrays",
            "type": null,
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "Array",
        "isGetter": false,
        "description": "Return a new array with `arrays` appended to this one."
      },
      {
        "name": "index_of",
        "params": [
          {
            "name": "x",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "int",
        "isGetter": false,
        "description": "Return the index of the first occurrence of `x`, or `-1` if absent."
      },
      {
        "name": "last_index_of",
        "params": [
          {
            "name": "x",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "int",
        "isGetter": false,
        "description": "Return the index of the last occurrence of `x`, or `-1` if absent."
      },
      {
        "name": "includes",
        "params": [
          {
            "name": "x",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "boolean",
        "isGetter": false,
        "description": "True when `x` is present."
      },
      {
        "name": "reverse",
        "params": [],
        "returns": "Array",
        "isGetter": false,
        "description": "Reverse the array in place and return it."
      },
      {
        "name": "sort",
        "params": [
          {
            "name": "compare",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Array",
        "isGetter": false,
        "description": "Sort the array in place and return it."
      },
      {
        "name": "join",
        "params": [
          {
            "name": "sep",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Join the elements into a string separated by `sep` (default `\",\"`)."
      },
      {
        "name": "map",
        "params": [
          {
            "name": "fn",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Array",
        "isGetter": false,
        "description": "Return a new array with `fn` applied to every element."
      },
      {
        "name": "filter",
        "params": [
          {
            "name": "fn",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Array",
        "isGetter": false,
        "description": "Return a new array of the elements for which `fn` returns true."
      },
      {
        "name": "reduce",
        "params": [
          {
            "name": "fn",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "initial",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "any",
        "isGetter": false,
        "description": "Fold the array left-to-right with `fn`."
      },
      {
        "name": "for_each",
        "params": [
          {
            "name": "fn",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "none",
        "isGetter": false,
        "description": "Call `fn` for every element."
      },
      {
        "name": "find",
        "params": [
          {
            "name": "fn",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "any",
        "isGetter": false,
        "description": "Return the first element for which `fn` returns true, or `null`."
      },
      {
        "name": "find_index",
        "params": [
          {
            "name": "fn",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "int",
        "isGetter": false,
        "description": "Return the index of the first element for which `fn` returns true, or `-1`."
      },
      {
        "name": "flat_map",
        "params": [
          {
            "name": "fn",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Array",
        "isGetter": false,
        "description": "Map every element with `fn` and flatten the result one level."
      },
      {
        "name": "length",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Number of elements."
      }
    ]
  },
  "String": {
    "methods": [
      {
        "name": "to_upper_case",
        "params": [],
        "returns": "string",
        "isGetter": false,
        "description": "Return the string with every character upper-cased."
      },
      {
        "name": "to_lower_case",
        "params": [],
        "returns": "string",
        "isGetter": false,
        "description": "Return the string with every character lower-cased."
      },
      {
        "name": "trim",
        "params": [],
        "returns": "string",
        "isGetter": false,
        "description": "Return the string with leading and trailing whitespace removed."
      },
      {
        "name": "trim_start",
        "params": [],
        "returns": "string",
        "isGetter": false,
        "description": "Return the string with leading whitespace removed."
      },
      {
        "name": "trim_end",
        "params": [],
        "returns": "string",
        "isGetter": false,
        "description": "Return the string with trailing whitespace removed."
      },
      {
        "name": "split",
        "params": [
          {
            "name": "sep",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string[]",
        "isGetter": false,
        "description": "Split the string on `sep`."
      },
      {
        "name": "replace",
        "params": [
          {
            "name": "old",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "new",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return a copy with the first occurrence of `old` replaced by `new`."
      },
      {
        "name": "replace_all",
        "params": [
          {
            "name": "old",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "new",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return a copy with every occurrence of `old` replaced by `new`."
      },
      {
        "name": "starts_with",
        "params": [
          {
            "name": "prefix",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "boolean",
        "isGetter": false,
        "description": "True when the string begins with `prefix`."
      },
      {
        "name": "ends_with",
        "params": [
          {
            "name": "suffix",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "boolean",
        "isGetter": false,
        "description": "True when the string ends with `suffix`."
      },
      {
        "name": "index_of",
        "params": [
          {
            "name": "sub",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "int",
        "isGetter": false,
        "description": "Return the index of the first occurrence of `sub`, or `-1` if absent."
      },
      {
        "name": "includes",
        "params": [
          {
            "name": "sub",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "boolean",
        "isGetter": false,
        "description": "True when `sub` occurs anywhere in the string."
      },
      {
        "name": "slice",
        "params": [
          {
            "name": "start",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "end",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return the substring `[start, end)`. Negative indices count from the end."
      },
      {
        "name": "repeat",
        "params": [
          {
            "name": "n",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return the string repeated `n` times."
      },
      {
        "name": "pad_start",
        "params": [
          {
            "name": "len",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "fill",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Pad the front with `fill` until the string reaches `len`."
      },
      {
        "name": "pad_end",
        "params": [
          {
            "name": "len",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "fill",
            "type": null,
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Pad the end with `fill` until the string reaches `len`."
      },
      {
        "name": "length",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Number of characters."
      }
    ]
  },
  "Map": {
    "methods": [
      {
        "name": "get",
        "params": [
          {
            "name": "key",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "any",
        "isGetter": false,
        "description": "Return the value stored under `key`, or `undefined`."
      },
      {
        "name": "set",
        "params": [
          {
            "name": "key",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "value",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "Map",
        "isGetter": false,
        "description": "Store `value` under `key` and return the map."
      },
      {
        "name": "has",
        "params": [
          {
            "name": "key",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "boolean",
        "isGetter": false,
        "description": "True when `key` is present."
      },
      {
        "name": "delete",
        "params": [
          {
            "name": "key",
            "type": null,
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "boolean",
        "isGetter": false,
        "description": "Remove `key`, returning whether it was present."
      },
      {
        "name": "keys",
        "params": [],
        "returns": "iterator",
        "isGetter": false,
        "description": "Iterate the keys."
      },
      {
        "name": "values",
        "params": [],
        "returns": "iterator",
        "isGetter": false,
        "description": "Iterate the values."
      },
      {
        "name": "entries",
        "params": [],
        "returns": "iterator",
        "isGetter": false,
        "description": "Iterate `[key, value]` pairs."
      },
      {
        "name": "clear",
        "params": [],
        "returns": "none",
        "isGetter": false,
        "description": "Remove every entry."
      },
      {
        "name": "size",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Number of entries."
      }
    ]
  }
} satisfies Record<string, TeraPseudoTypeSpec>;

export const TERA_CHART_METHODS = {
  "line": {
    "display": "chart.line(data, x?, y?, color?, title?, x_label?, y_label?, hline?, vline?, dash?, animate=false, frame?, key?, easing=\"cubic\", loop=false, speed=1, autoplay=false, zoom=true)",
    "description": "Draw a line chart for ordered values or trends. Use y=[...] for multiple series and color= to group DataFrame rows. Add a dashed reference line with hline=3.5 (horizontal) or vline=100 (vertical) — pass an int, float, or array, and label/color them with hline_label=\"μ = 3.5\", hline_color=\"#e06c75\". Use dash=true to dash every series. Pass animate=true to reveal the line left→right with Play/Pause, a scrubber, loop, and speed controls (honours reduced-motion). Pass frame=\"step\" to morph the curve between keyframes (one per distinct frame value), tweening vertices over time with a frame scrubber. Pace the motion with easing=\"linear\"|\"ease\"|\"ease-in-out\"|\"cubic\", repeat with loop=true, run faster/slower with speed=0.5|1|2|4, and auto-start with autoplay=true (otherwise the chart rests on its final frame as a static poster until you press Play, so exports and screenshots stay complete).",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "bar": {
    "display": "chart.bar(data, x?, y?, color?, mode=\"grouped\", title?)",
    "description": "Compare values across categories. Use mode=\"stacked\" to stack multiple series; aggregate DataFrame rows before charting.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "scatter": {
    "display": "chart.scatter(data, x?, y?, size?, color?, title?, animate=false, frame?, key?, duration?, easing=\"cubic\", loop=true, speed=1, autoplay=false, zoom=true)",
    "description": "Plot numeric X/Y observations to inspect relationships, clusters, and outliers. Use color= to split DataFrame groups. Pass animate=true to reveal points left→right with transport controls. Pass frame=\"year\" with key=\"country\" to morph the marks between keyframes (Gapminder-style): each distinct frame value becomes a keyframe, marks matched by key smoothly interpolate their x/y (and size/color), and marks that enter or leave fade in/out. The transport label shows the current frame value and the scrubber seeks by frame; reduced-motion snaps between frames without tweening. Tune the motion with easing=\"linear\"|\"ease\"|\"ease-in-out\"|\"cubic\", loop=true/false, and speed=0.5|1|2|4; until you press Play (or set autoplay=true) the chart holds its last frame as a static poster so exports stay complete.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "histogram": {
    "display": "chart.histogram(data, x?, color?, bins=20, title?, zoom=true)",
    "description": "Show the frequency distribution of numeric values. Bins are computed automatically and can be grouped with color=.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "area": {
    "display": "chart.area(data, x?, y?, color?, mode=\"overlay\", title?, animate=false, easing=\"cubic\", loop=false, speed=1, autoplay=false, zoom=true)",
    "description": "Show trends with the area below each series filled. Use mode=\"stacked\" when aligned series should accumulate. Pass animate=true to reveal the area left→right with transport controls; pace it with easing=\"linear\"|\"ease\"|\"ease-in-out\"|\"cubic\", loop=true, and speed=0.5|1|2|4. The chart rests on its filled final frame until you press Play (or set autoplay=true).",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "box": {
    "display": "chart.box(data, x?, color?, whisker=1.5, title?)",
    "description": "Summarize a numeric distribution with Tukey quartiles, median, whiskers, and outliers. Use color= for grouped boxes.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "violin": {
    "display": "chart.violin(data, x?, color?, bandwidth?, whisker=1.5, title?)",
    "description": "Show a mirrored kernel-density distribution together with median and quartile markers. Use color= to compare groups.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "density": {
    "display": "chart.density(data, x?, color?, bandwidth?, title?, zoom=true)",
    "description": "Estimate and draw a smooth numeric probability density using a Gaussian kernel. Bandwidth defaults to Silverman.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "correlation": {
    "display": "chart.correlation(data, columns?, method=\"pearson\", title?)",
    "description": "Draw a correlation matrix for numeric DataFrame columns. Supports method=\"pearson\" and method=\"spearman\".",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "hexbin": {
    "display": "chart.hexbin(data, x?, y?, bins=30, title?, zoom=true)",
    "description": "Aggregate dense numeric X/Y observations into hexagonal bins whose intensity represents the point count.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "heatmap": {
    "display": "chart.heatmap(data, x?, y?, value?, title?)",
    "description": "Draw a numeric matrix heatmap. For DataFrame input, provide x, y, and value columns; 2D arrays are supported directly.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "regression": {
    "display": "chart.regression(data, x?, y?, title?, zoom=true)",
    "description": "Plot numeric X/Y observations with a least-squares linear fit and R² tooltip.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "ecdf": {
    "display": "chart.ecdf(data, x?, color?, title?, zoom=true)",
    "description": "Draw an empirical cumulative distribution function for comparing numeric distributions without binning.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "bubble": {
    "display": "chart.bubble(data, x?, y?, size?, color?, title?, frame?, key?, duration?, easing=\"cubic\", loop=true, speed=1, autoplay=false, zoom=true)",
    "description": "Plot X/Y observations with marker area scaled by a third numeric variable. Useful for spend, revenue, or segment size. Pass frame=\"year\" with key=\"country\" to morph the bubbles between keyframes: marks matched by key interpolate their x/y/size/color over time, entering/leaving marks fade, and the transport scrubber seeks by frame value (reduced-motion snaps without tweening). Pace it with easing=\"linear\"|\"ease\"|\"ease-in-out\"|\"cubic\", loop=true/false, and speed=0.5|1|2|4; the chart holds its last frame as a static poster until you press Play (or set autoplay=true).",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "funnel": {
    "display": "chart.funnel(data, step?, value?, title?)",
    "description": "Show a conversion funnel across ordered stages, including overall and step-to-step retention.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "waterfall": {
    "display": "chart.waterfall(data, step?, value?, title?)",
    "description": "Show how positive and negative contributions accumulate from a starting point to a final total.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": [
      {
        "name": "data",
        "type": "any"
      },
      {
        "name": "x",
        "type": "string | int | float",
        "optional": true,
        "named": true
      },
      {
        "name": "y",
        "type": "string | int | float | string[] | int[] | float[]",
        "optional": true,
        "named": true
      },
      {
        "name": "bins",
        "type": "int",
        "optional": true,
        "named": true
      },
      {
        "name": "title",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "x_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "y_label",
        "type": "string",
        "optional": true,
        "named": true
      },
      {
        "name": "options",
        "type": "any",
        "optional": true,
        "rest": true,
        "named": true
      }
    ]
  },
  "figure": {
    "display": "chart.figure(data, title?).encode(x?, color?).bar(y?).line(y?, axis?).facet(col?)",
    "description": "Compose multiple marks on one coordinate system. Chain .line/.bar/.scatter/.point/.area/.histogram/.regression/.bubble; pass axis=\"right\" for a secondary y-axis, or .facet(\"column\") to split into small-multiple panels.",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "sync",
    "params": []
  }
} satisfies Record<string, TeraChartMethodSpec>;
