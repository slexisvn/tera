import { CLASS_ABSTRACT_MODIFIER, CLASS_VISIBILITIES } from "../src/core/class-visibility.ts";

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
  typeParams?: string[];
  returns?: string | null;
  effect?: "sync" | "async" | "io";
  isGetter?: boolean;
  description?: string | null;
};

export type TeraBuiltinSpec = {
  description?: string | null;
  kind?: string | null;
  typeParams?: string[];
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
  typeParams?: string[];
  methods: TeraMethodSpec[];
};

export type TeraTypeAliasSpec = {
  typeParams?: string[];
  type: string;
};

export type TeraInterfaceFieldSpec = {
  type: string;
  optional?: boolean;
};

export type TeraInterfaceSpec = {
  typeParams?: string[];
  fields: Record<string, TeraInterfaceFieldSpec>;
  indexers?: TeraInterfaceIndexSpec[];
};

export type TeraInterfaceIndexSpec = {
  keyType: string;
  valueType: string;
};

export type TeraChartMethodSpec = {
  display: string;
  description: string;
  kind: string;
  returns?: string | null;
  effect?: "sync" | "async" | "io";
  params?: TeraParam[];
};

function param(name: string, type: string, extra: Omit<TeraParam, "name" | "type"> = {}): TeraParam {
  return { name, type, ...extra };
}

function optionalParam(name: string, type: string, defaultValue?: unknown): TeraParam {
  return defaultValue === undefined ? param(name, type, { optional: true }) : param(name, type, { optional: true, defaultValue });
}

function namedOptionalParam(name: string, type: string, defaultValue?: unknown): TeraParam {
  return defaultValue === undefined
    ? param(name, type, { optional: true, named: true })
    : param(name, type, { optional: true, named: true, defaultValue });
}

function namedOptionalAliases(name: string, type: string, aliases: string[] = [], defaultValue?: unknown): TeraParam[] {
  return [name, ...aliases].map((alias) => namedOptionalParam(alias, type, defaultValue));
}

function namedRestParam(name: string, type: string): TeraParam {
  return param(name, type, { optional: true, rest: true, named: true });
}

function namedParam(name: string, type: string): TeraParam {
  return param(name, type, { named: true });
}

function tensorOptions(): TeraParam[] {
  return [
    namedOptionalParam("dtype", "DType"),
    namedOptionalParam("device", "DeviceLike"),
    namedOptionalParam("offset", "int"),
    namedOptionalParam("grad", "bool"),
    namedOptionalParam("requires_grad", "bool"),
  ];
}

function tensorDataOptions(): TeraParam[] {
  return [
    namedOptionalParam("dtype", "DType"),
    namedOptionalParam("device", "DeviceLike")
  ];
}

function tensorShapeParam(name = "shape"): TeraParam {
  return param(name, "NumericShape");
}

function tensorScalarParam(name: string): TeraParam {
  return param(name, "NumericScalar");
}

function numericElementParam(name: string): TeraParam {
  return param(name, "NumericElementInput");
}

function numericVectorParam(name: string): TeraParam {
  return param(name, "NumericVectorInput");
}

function numericMatrixParam(name: string): TeraParam {
  return param(name, "NumericMatrixInput");
}

function mlTensorParam(name: string): TeraParam {
  return param(name, "MLTensor");
}

function boolOption(name: string, aliases: string[] = [], defaultValue?: boolean): TeraParam[] {
  return namedOptionalAliases(name, "bool", aliases, defaultValue);
}

function floatOption(name: string, aliases: string[] = [], defaultValue?: number): TeraParam[] {
  return namedOptionalAliases(name, "float", aliases, defaultValue);
}

function intOption(name: string, aliases: string[] = [], defaultValue?: number): TeraParam[] {
  return namedOptionalAliases(name, "int", aliases, defaultValue);
}

function fitInterceptOptions(): TeraParam[] {
  return boolOption("fit_intercept", [], true);
}

function treeOptions(): TeraParam[] {
  return [
    ...intOption("max_depth", []),
    ...intOption("min_samples_split", []),
    ...intOption("min_samples_leaf", []),
    ...intOption("max_features", []),
    ...intOption("random_state", [])
  ];
}

function forestOptions(): TeraParam[] {
  return [
    ...intOption("n_estimators", []),
    ...treeOptions()
  ];
}

function boostingOptions(): TeraParam[] {
  return [
    ...intOption("n_estimators", []),
    ...floatOption("learning_rate", []),
    ...treeOptions()
  ];
}

function distOptions(): TeraParam[] {
  return [
    ...floatOption("loc"),
    ...floatOption("scale"),
    ...intOption("refine_steps", []),
    ...floatOption("tol"),
    ...floatOption("lower_limit", [])
  ];
}

function randomOptions(extra: TeraParam[] = []): TeraParam[] {
  return [
    ...tensorDataOptions(),
    ...intOption("seed"),
    ...floatOption("low"),
    ...floatOption("high"),
    ...floatOption("loc"),
    ...floatOption("scale"),
    ...extra
  ];
}

function moduleForwardMethod(params: TeraParam[], returns = "Tensor"): TeraMethodSpec {
  return {
    name: "forward",
    params,
    returns,
  };
}

function lossForwardMethod(owner: string): TeraMethodSpec {
  return {
    name: "forward",
    params: [param("input", "Tensor"), param("target", "Tensor")],
    returns: "Tensor",
    description: `${owner} forward pass.`,
  };
}

function tensorMaterializeMethod(name: string): TeraMethodSpec {
  return {
    name,
    params: [],
    typeParams: ["T"],
    returns: "T",
    isGetter: false,
    description: "Materialize the tensor as a scalar or nested numeric array.",
  };
}

function field(type: string, optional = false): TeraInterfaceFieldSpec {
  return optional ? { type, optional } : { type };
}

function fnType(params: string[], returns: string): string {
  return `(${params.join(", ")}) -> ${returns}`;
}

const reactiveCleanupType = fnType([], "void");

const reactiveSignalMethods: TeraMethodSpec[] = [
  { name: "value", params: [], returns: "T", isGetter: true, description: "Low-level current value getter kept for host interop and compatibility; reactive syntax reads the binding directly." },
  { name: "peek", params: [], returns: "T", description: "Read the current value without subscribing the active reactive observer; the optimizer treats this as a readonly reactive-value read." },
  { name: "set", params: [param("value", "T")], returns: "ReactiveSignal<T>", description: "Set the signal value and notify dependent observers when it changes; the optimizer treats this as a reactive-value write." },
  { name: "update", params: [param("update", "(T) -> T")], returns: "ReactiveSignal<T>", description: "Replace the signal value with the result of an updater function. Simple single-use updater expressions can be lowered to peek plus write in optimized code." },
  { name: "subscribe", params: [param("listener", "(T) -> void")], returns: reactiveCleanupType, description: "Subscribe a listener and return a cleanup function." },
  { name: "dispose", params: [], returns: "void", description: "Dispose the signal and detach all listeners." }
];

const reactiveComputedMethods: TeraMethodSpec[] = [
  { name: "value", params: [], returns: "T", isGetter: true, description: "Low-level memoized value getter kept for host interop and compatibility; reactive syntax reads the binding directly." },
  { name: "peek", params: [], returns: "T", description: "Read the memoized value without subscribing the active reactive observer; the optimizer treats this as a readonly reactive-value read." },
  { name: "subscribe", params: [param("listener", "(T) -> void")], returns: reactiveCleanupType, description: "Subscribe a listener and return a cleanup function." },
  { name: "dispose", params: [], returns: "void", description: "Dispose the computation and detach its dependencies." }
];

const reactiveResourceMethods: TeraMethodSpec[] = [
  { name: "value", params: [], returns: "T | undefined", isGetter: true, description: "Low-level resource value getter kept for host interop and compatibility; reactive syntax reads the binding directly." },
  { name: "latest", params: [], returns: "T | undefined", isGetter: true, description: "Read the latest resolved value while the resource is pending or refreshing." },
  { name: "state", params: [], returns: "string", isGetter: true, description: "Current resource state: unresolved, pending, ready, refreshing, or errored." },
  { name: "loading", params: [], returns: "bool", isGetter: true, description: "True while the resource request is pending or refreshing." },
  { name: "error", params: [], returns: "any", isGetter: true, description: "The last resource error, if the current request failed." },
  { name: "peek", params: [], returns: "T | undefined", description: "Read the latest resource value without subscribing the active reactive observer; the optimizer treats this as a readonly reactive-value read." },
  { name: "refetch", params: [], returns: "Promise<T | undefined>", description: "Run the resource fetcher again and ignore any stale pending result; this reads and writes the resource value domain." },
  { name: "mutate", params: [param("value", "T")], returns: "ReactiveResource<T>", description: "Optimistically replace the resource value and mark it ready; the optimizer treats this as a reactive-value write." },
  { name: "subscribe", params: [param("listener", "(T | undefined) -> void")], returns: reactiveCleanupType, description: "Subscribe a listener and return a cleanup function." },
  { name: "dispose", params: [], returns: "void", description: "Dispose the resource and abort its current request." }
];

function interfaceFields(methods: TeraMethodSpec[]): Record<string, TeraInterfaceFieldSpec> {
  return Object.fromEntries(methods.map((method) => [
    method.name,
    field(method.isGetter ? method.returns ?? "any" : fnType(method.params.map((param) => `${param.name}: ${param.type ?? "any"}`), method.returns ?? "void")),
  ]));
}

export const TERA_KEYWORD_GROUPS = {
  "declaration": [
    "fn",
    "model",
    CLASS_ABSTRACT_MODIFIER,
    "class",
    "interface",
    "type",
    "signal",
    "computed",
    "resource",
    "extends",
    "implements",
    "static",
    ...CLASS_VISIBILITIES,
    "get",
    "set",
    "import",
    "from",
    "as"
  ],
  "control": [
    "if",
    "else",
    "effect",
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
  "undefined",
  "void",
  "int",
  "float",
  "string",
  "bool",
  "boolean",
  "Map",
  "Set",
  "Array",
  "Object",
  "Promise",
  "Error",
  "Tensor",
  "IndexTensor",
  "Module",
  "Optimizer",
  "LRScheduler",
  "Metric",
  "MLModel",
  "MLTransform",
  "MetricCollection",
  "Callback",
  "Logger",
  "Dataset",
  "DataLoader",
  "Tokenizer",
  "DataFrame",
  "Column",
  "GroupedData",
  "Trainer",
  "ReactiveSignal",
  "ReactiveComputed",
  "ReactiveResource"
];

export const TERA_PRIMITIVE_PSEUDO_TYPES = {
  "string": "String",
  "int": "Number",
  "float": "Number",
  "bool": "Boolean",
  "boolean": "Boolean"
} satisfies Record<string, string>;

export const TERA_COMPILE_TARGETS = ["cpu", "webgpu", "cuda", "wasm"] as const;
export type TeraCompileTarget = typeof TERA_COMPILE_TARGETS[number];

export const TERA_ASYNC_DOMAIN_TYPES = [
  "DataFrame",
  "Trainer"
];

export const TERA_BUILTIN_ALIASES = {
  "DType": { "type": "string" },
  "DeviceLike": { "type": "string | Device" },
  "NumericScalar": { "type": "int | float" },
  "NumericShape": { "type": "int | int[]" },
  "Pair2": { "type": "[int, int]" },
  "PairPadding2d": { "type": "[Pair2, Pair2] | Pair2" },
  "ConvSize2d": { "type": "int | Pair2" },
  "ConvPadding2d": { "type": "int | PairPadding2d" },
  "Conv1dSize": { "type": "int | int[]" },
  "Conv1dPadding": { "type": "int | Pair2" },
  "Pool2dSize": { "type": "int | Pair2" },
  "Pool2dPadding": { "type": "int | PairPadding2d" },
  "LossReduction": { "type": "string" },
  "TokenizerSpecialTokens": { "type": "string[] | TokenizerSpecialTokenMap" },
  "LoggerConfig": { "type": "bool | Logger | Logger[] | null" },
  "OptimizerParams": { "type": "Tensor[] | OptimizerParamGroupInput[]" },
  "TensorInput": { "type": "Tensor | NumericScalar" },
  "TensorDataInput": { "type": "NumericScalar | TensorDataInput[]" },
  "TensorData": { "type": "TensorDataInput" },
  "DynamicShapeSpec": { "type": "bool | Set | null | undefined" },
  "DynamicShapes": { "type": "DynamicShapeSpec[] | null" },
  "CompileTarget": { "type": "string" },
  "CompileFusionStrategy": { "type": "string" },
  "CompileMatmulBackend": { "type": "string" },
  "CompileErrorMode": { "type": "string" },
  "CompileVerifyMode": { "type": "bool | string" },
  "NumericElementInput": { "type": "Tensor | NumericScalar" },
  "NumericArrayInput": { "type": "Tensor | NumericScalar[]" },
  "NumericVectorInput": { "type": "Tensor | NumericScalar | NumericScalar[]" },
  "NumericMatrixInput": { "type": "Tensor | NumericScalar[][]" },
  "NumericDistResult": { "type": "float | Tensor" },
  "MLTensor": { "type": "Tensor" },
  "MetricValue": { "type": "NumericScalar | Tensor" },
  "MetricResult": { "type": "float | float[] | float[][]" },
  "EstimatorFactory": { "type": "(ParamGrid | null) -> MLModel" },
  "ScoringFn": { "type": "(MLTensor, MLTensor) -> float" },
  "FoldArray": { "type": "Fold[]" },
  "TrainTestSplitResult": { "type": "[MLTensor, MLTensor] | [MLTensor, MLTensor, MLTensor, MLTensor]" },
  "LinearInterpResult": { "type": "float | float[]" },
  "ScalarFn": { "type": "(float) -> float" },
  "VectorFn": { "type": "(float[]) -> float" },
  "GradientFn": { "type": "(float[]) -> float[]" },
  "ResidualFn": { "type": "(float[]) -> float[]" },
  "JacobianFn": { "type": "(float[], int) -> float[][]" },
  "Bounds": { "type": "[float, float][]" },
  "OptimizerStateValue": { "type": "NumericScalar | bool | string | NumericScalar[] | undefined" },
  "MinimizeResult": { "type": "OptimizationResult" },
  "KsTestResult": { "type": "TestResultNoDf" },
  "Signal": { "type": "(float[][]) -> float[][]" },
  "Portfolio": { "type": "(float[][]) -> float[][]" }
} satisfies Record<string, TeraTypeAliasSpec>;

export const TERA_BUILTIN_INTERFACES = {
  "ReactiveSignal": {
    "typeParams": ["T"],
    "fields": interfaceFields(reactiveSignalMethods)
  },
  "ReactiveComputed": {
    "typeParams": ["T"],
    "fields": interfaceFields(reactiveComputedMethods)
  },
  "ReactiveResource": {
    "typeParams": ["T"],
    "fields": interfaceFields(reactiveResourceMethods)
  },
  "TensorOptions": {
    "fields": {
      "shape": field("int[]", true),
      "dtype": field("DType", true),
      "device": field("DeviceLike", true),
      "requiresGrad": field("bool", true),
      "requires_grad": field("bool", true),
      "grad": field("bool", true),
      "offset": field("int", true)
    }
  },
  "OptimizerConfig": {
    "fields": {
      "optimizer": field("Optimizer"),
      "lrScheduler": field("LRScheduler | ReduceLROnPlateau", true),
      "lr_scheduler": field("LRScheduler | ReduceLROnPlateau", true)
    }
  },
  "OptimizerParamGroupInput": {
    "fields": {
      "params": field("Tensor[]")
    }
  },
  "OptimizerParamState": {
    "fields": {}
  },
  "CompileOptions": {
    "fields": {
      "name": field("string", true),
      "mode": field("string", true),
      "verify": field("CompileVerifyMode", true),
      "error_mode": field("CompileErrorMode", true),
      "fold_weights": field("bool", true),
      "dynamic_shapes": field("DynamicShapes", true),
      "shape_buckets": field("int[][][]", true),
      "backward": field("unknown", true),
      "target": field("CompileTarget", true),
      "source": field("bool", true),
      "fusion": field("CompileFusionOptions", true),
      "scheduling": field("CompileSchedulingOptions", true),
      "matmul_backend": field("CompileMatmulBackend", true),
      "quantization": field("CompileQuantizationOptions", true),
      "optimization": field("CompileOptimizationOptions", true),
      "memory": field("CompileMemoryOptions", true),
      "partition": field("CompilePartitionOptions", true),
      "trace": field("CompileTraceOptions", true),
      "remat_policy": field("unknown", true),
      "remat": field("ParamGrid", true),
      "pass_context": field("unknown", true),
      "lowering_rules": field("unknown", true),
      "codegen_entries": field("unknown", true)
    }
  },
  "CompileFusionOptions": {
    "fields": {
      "enabled": field("bool", true),
      "strategy": field("CompileFusionStrategy", true),
      "launch_overhead_us": field("float", true),
      "max_fusion_size": field("int", true),
      "max_shared_memory": field("int", true),
      "allow_reduction_fusion": field("bool", true),
      "max_reductions": field("int", true),
      "cost": field("ParamGrid", true),
      "benefit_weights": field("ParamGrid", true)
    }
  },
  "CompileSchedulingOptions": {
    "fields": {
      "enabled": field("bool", true),
      "autotune": field("bool", true),
      "gpu_tiling": field("bool", true),
      "primitive_matmul": field("bool", true),
      "strategy": field("string", true),
      "seed": field("int", true),
      "hardware_measure": field("bool", true),
      "population_size": field("int", true),
      "num_generations": field("int", true),
      "top_k_for_benchmark": field("int", true),
      "max_rounds_per_task": field("int", true)
    },
    "indexers": [{ "keyType": "string", "valueType": "unknown" }]
  },
  "CompileQuantizationOptions": {
    "fields": {
      "enabled": field("bool", true),
      "fold_weights": field("bool", true),
      "calibration_data": field("unknown", true),
      "calibration": field("unknown", true),
      "calibration_mode": field("string", true),
      "quantizable_ops": field("string[]", true)
    },
    "indexers": [{ "keyType": "string", "valueType": "unknown" }]
  },
  "CompileOptimizationOptions": {
    "fields": {
      "layout": field("bool", true),
      "rematerialization": field("bool", true),
      "remat_config": field("ParamGrid", true),
      "fast_math": field("bool", true),
      "max_simplify_iterations": field("int", true),
      "loop_partition": field("bool", true),
      "detect_accumulators": field("bool", true),
      "tensorize": field("bool", true)
    }
  },
  "CompileMemoryOptions": {
    "fields": {
      "alignment": field("int", true),
      "inplace_reuse": field("bool", true),
      "alloc_strategy": field("string", true),
      "pool_allocation": field("bool", true)
    }
  },
  "CompilePartitionOptions": {
    "fields": {
      "enabled": field("bool", true),
      "targets": field("unknown[]", true),
      "default_target": field("unknown", true),
      "op_target_overrides": field("unknown", true),
      "memory_limits": field("unknown", true),
      "min_partition_size": field("int", true),
      "cost_weights": field("ParamGrid", true)
    },
    "indexers": [{ "keyType": "string", "valueType": "unknown" }]
  },
  "CompileTraceOptions": {
    "fields": {
      "level": field("int", true),
      "sink": field("unknown", true),
      "ir_snapshot": field("CompileTraceSnapshotOptions", true)
    }
  },
  "CompileTraceSnapshotOptions": {
    "fields": {
      "after_graph_passes": field("bool", true),
      "after_lowering": field("bool", true),
      "after_scheduling": field("bool", true)
    }
  },
  "SVDResult": {
    "fields": {
      "U": field("Tensor"),
      "S": field("Tensor"),
      "V": field("Tensor")
    }
  },
  "EighResult": {
    "fields": {
      "values": field("Tensor"),
      "vectors": field("Tensor")
    }
  },
  "QRResult": {
    "fields": {
      "Q": field("Tensor"),
      "R": field("Tensor")
    }
  },
  "TestResult": {
    "fields": {
      "statistic": field("float"),
      "pvalue": field("float"),
      "df": field("float", true)
    }
  },
  "TestResultNoDf": {
    "fields": {
      "statistic": field("float"),
      "pvalue": field("float")
    }
  },
  "CubicSpline": {
    "fields": {
      "xs": field("float[]"),
      "ys": field("float[]"),
      "coefficients": field("float[]"),
      "evaluate": field("(NumericScalar | NumericScalar[]) -> float | float[]")
    }
  },
  "OptimizationResult": {
    "fields": {
      "point": field("float[]"),
      "value": field("float"),
      "iterations": field("int"),
      "converged": field("bool")
    }
  },
  "RootResult": {
    "fields": {
      "root": field("float"),
      "iterations": field("int"),
      "converged": field("bool")
    }
  },
  "Fold": {
    "fields": {
      "train": field("int[]"),
      "test": field("int[]")
    }
  },
  "TokenizerSpecialTokenMap": {
    "fields": {
      "pad": field("string", true),
      "unk": field("string", true),
      "bos": field("string", true),
      "eos": field("string", true)
    }
  },
  "TokenizerStrategyData": {
    "fields": {
      "lowercase": field("bool", true),
      "numMerges": field("int", true),
      "num_merges": field("int", true),
      "endOfWord": field("string", true),
      "end_of_word": field("string", true),
      "merges": field("[string, string][]", true)
    }
  },
  "TokenizerConfig": {
    "fields": {
      "lowercase": field("bool", true),
      "numMerges": field("int", true),
      "num_merges": field("int", true),
      "endOfWord": field("string", true),
      "end_of_word": field("string", true),
      "merges": field("[string, string][]", true),
      "vocabSize": field("int | null", true),
      "vocab_size": field("int | null", true)
    }
  },
  "TokenizerJSON": {
    "fields": {
      "format": field("string"),
      "version": field("int"),
      "mode": field("string"),
      "config": field("TokenizerConfig"),
      "specialTokens": field("TokenizerSpecialTokenMap"),
      "vocab": field("string[]"),
      "strategy": field("TokenizerStrategyData")
    }
  },
  "MetricRecord": {
    "fields": {}
  },
  "MetricMap": {
    "fields": {}
  },
  "ParamGrid": {
    "fields": {}
  },
  "GradientAccumulationSchedule": {
    "fields": {}
  },
  "NumericMetricRecord": {
    "fields": {}
  },
  "LogOptions": {
    "fields": {
      "onStep": field("bool | null", true),
      "on_step": field("bool | null", true),
      "onEpoch": field("bool | null", true),
      "on_epoch": field("bool | null", true),
      "reduceFx": field("string", true),
      "reduce_fx": field("string", true),
      "progBar": field("bool", true),
      "prog_bar": field("bool", true)
    }
  },
  "SchedulerConfig": {
    "fields": {
      "scheduler": field("LRScheduler | ReduceLROnPlateau"),
      "interval": field("string", true),
      "frequency": field("int", true),
      "monitor": field("string | null", true)
    }
  },
  "OptimizerStateDict": {
    "fields": {
      "state": field("Map"),
      "paramGroups": field("OptimizerParamState[]")
    }
  },
  "CriticalValues": {
    "fields": {
      "one": field("float"),
      "five": field("float"),
      "ten": field("float")
    }
  },
  "UnitRootTest": {
    "fields": {
      "statistic": field("float"),
      "critical_values": field("CriticalValues"),
      "stationary": field("bool")
    }
  },
  "EngleGrangerResult": {
    "fields": {
      "statistic": field("float"),
      "critical_values": field("CriticalValues"),
      "cointegrated": field("bool"),
      "hedge_ratio": field("float[]"),
      "spread": field("float[]")
    }
  },
  "JohansenResult": {
    "fields": {
      "eigenvalues": field("float[]"),
      "vectors": field("float[][]"),
      "trace_statistics": field("float[]"),
      "max_eigen_statistics": field("float[]"),
      "rank": field("int")
    }
  },
  "KalmanResult": {
    "fields": {
      "states": field("float[][]"),
      "covariances": field("float[][][]"),
      "innovations": field("float[]"),
      "innovation_variances": field("float[]")
    }
  },
  "GarchParams": {
    "fields": {
      "omega": field("float"),
      "alpha": field("float"),
      "beta": field("float")
    }
  },
  "GarchFit": {
    "fields": {
      "params": field("GarchParams"),
      "log_likelihood": field("float"),
      "persistence": field("float"),
      "unconditional_variance": field("float"),
      "variances": field("float[]")
    }
  },
  "QuantMetrics": {
    "fields": {
      "sharpe": field("float"),
      "sortino": field("float"),
      "calmar": field("float"),
      "turnover": field("float"),
      "maxDrawdown": field("float"),
      "max_drawdown": field("float"),
      "hitRate": field("float"),
      "hit_rate": field("float")
    },
    "indexers": [{ "keyType": "string", "valueType": "float" }]
  },
  "QuantBacktestResult": {
    "fields": {
      "metrics": field("QuantMetrics"),
      "equity": field("DataFrame"),
      "port_returns": field("DataFrame"),
      "weights": field("float[][]")
    }
  },
  "QuantGreeks": {
    "fields": {},
    "indexers": [{ "keyType": "string", "valueType": "float" }]
  },
  "QuillPriceResult": {
    "fields": {
      "price": field("float"),
      "standard_error": field("float"),
      "greeks": field("QuantGreeks")
    }
  },
  "QuillProduct": {
    "fields": {
      "name": field("string | null")
    }
  }
} satisfies Record<string, TeraInterfaceSpec>;

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
  "Signal": {
    "description": "Create a writable reactive signal from an initial value. In Tera source, prefer `signal name = expr` and read `name` directly; fresh signal allocation is compiler-visible and does not alias existing reactive-value reads.",
    "kind": "reactive",
    "typeParams": ["T"],
    "returns": "ReactiveSignal<T>",
    "params": [
      param("value", "T")
    ]
  },
  "signal": {
    "description": "Create a writable reactive signal from an initial value. In Tera source, prefer `signal name = expr` and read `name` directly; fresh signal allocation is compiler-visible and does not alias existing reactive-value reads.",
    "kind": "reactive",
    "typeParams": ["T"],
    "returns": "ReactiveSignal<T>",
    "params": [
      param("value", "T")
    ]
  },
  "computed": {
    "description": "Create a memoized reactive computation that tracks the signals it reads. In Tera source, prefer `computed name = expr` and read `name` directly.",
    "kind": "reactive",
    "typeParams": ["T"],
    "returns": "ReactiveComputed<T>",
    "params": [
      param("compute", "() -> T")
    ]
  },
  "resource": {
    "description": "Create an async reactive resource. In Tera source, `resource name = expr` tracks reactive reads in `expr`, stores loading/error state, ignores stale results, and reads `name` directly.",
    "kind": "reactive",
    "typeParams": ["T"],
    "returns": "ReactiveResource<T>",
    "params": [
      param("fetch", "() -> T")
    ]
  },
  "effect": {
    "description": "Run a reactive side effect and return a cleanup function. In Tera source, `effect:` creates an effect block and reactive bindings inside are read directly.",
    "kind": "reactive",
    "returns": reactiveCleanupType,
    "params": [
      param("run", "() -> any")
    ]
  },
  "batch": {
    "description": "Batch reactive writes and flush dependent observers once the callback finishes.",
    "kind": "reactive",
    "typeParams": ["T"],
    "returns": "T",
    "params": [
      param("run", "() -> T")
    ]
  },
  "untrack": {
    "description": "Run a callback without collecting reactive dependencies.",
    "kind": "reactive",
    "typeParams": ["T"],
    "returns": "T",
    "params": [
      param("run", "() -> T")
    ]
  },
  "watch": {
    "description": "Watch a signal, computed value, or reader function and return a cleanup function.",
    "kind": "reactive",
    "returns": reactiveCleanupType,
    "params": [
      param("source", "any"),
      param("run", "(any, any) -> any")
    ]
  },
  "root": {
    "description": "Create a reactive owner scope and pass its dispose function to a callback.",
    "kind": "reactive",
    "returns": "any",
    "params": [
      param("run", "Function")
    ]
  },
  "cleanup": {
    "description": "Register a cleanup callback on the current reactive owner.",
    "kind": "reactive",
    "returns": "void",
    "params": [
      param("run", "() -> any")
    ]
  },
  "tensor": {
    "description": "Construct a tensor from a literal value, array, or nested array. Accepts `dtype`, `device`, `grad` options.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      param("data", "TensorDataInput"),
      namedOptionalParam("shape", "int[]"),
      ...tensorOptions()
    ]
  },
  "zeros": {
    "description": "Create a tensor of the given shape filled with `0`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      ...tensorOptions()
    ]
  },
  "ones": {
    "description": "Create a tensor of the given shape filled with `1`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      ...tensorOptions()
    ]
  },
  "empty": {
    "description": "Allocate a tensor of the given shape without initializing its contents.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      ...tensorOptions()
    ]
  },
  "full": {
    "description": "Create a tensor of the given shape filled with the provided scalar `value`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      tensorScalarParam("value"),
      ...tensorOptions()
    ]
  },
  "randn": {
    "description": "Sample a tensor of the given shape from the standard normal distribution.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      ...tensorOptions()
    ]
  },
  "arange": {
    "description": "Half-open integer range tensor `[start, end)` with optional `step`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      tensorScalarParam("start"),
      optionalParam("end", "int | float"),
      optionalParam("step", "int | float"),
      ...tensorOptions()
    ]
  },
  "eye": {
    "description": "Identity matrix of size `n × m` (or `n × n` if `m` omitted).",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      param("n", "int"),
      optionalParam("m", "int"),
      ...tensorOptions()
    ]
  },
  "linspace": {
    "description": "Evenly spaced values between `start` and `end`, inclusive, with `steps` points.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      tensorScalarParam("start"),
      tensorScalarParam("end"),
      param("steps", "int"),
      ...tensorOptions()
    ]
  },
  "randperm": {
    "description": "Random permutation of integers `0..n-1`.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      param("n", "int"),
      ...tensorOptions()
    ]
  },
  "scalar": {
    "description": "Create a scalar tensor from a numeric value.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      tensorScalarParam("value"),
      ...tensorOptions()
    ]
  },
  "zeros_like": {
    "description": "Zero tensor with the same shape, dtype, and device as the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      param("tensor", "Tensor"),
      ...tensorOptions()
    ]
  },
  "ones_like": {
    "description": "Tensor of ones with the same shape, dtype, and device as the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      param("tensor", "Tensor"),
      ...tensorOptions()
    ]
  },
  "empty_like": {
    "description": "Uninitialized tensor with the same shape, dtype, and device as the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      param("tensor", "Tensor"),
      ...tensorOptions()
    ]
  },
  "full_like": {
    "description": "Constant-filled tensor matching the shape, dtype, and device of the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      param("tensor", "Tensor"),
      tensorScalarParam("value"),
      ...tensorOptions()
    ]
  },
  "randn_like": {
    "description": "Standard-normal sample with the same shape, dtype, and device as the input.",
    "kind": "factory",
    "returns": "Tensor",
    "params": [
      param("tensor", "Tensor"),
      ...tensorOptions()
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
      param("tensors", "Tensor[]"),
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
      param("tensors", "Tensor[]"),
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
  "input": {
    "description": "Read one line from the runtime input source, writing the optional prompt first. Returns the line without its terminator, or an empty string once the input is exhausted.",
    "kind": "global",
    "returns": "string",
    "params": [optionalParam("prompt", "string")]
  },
  "queue_microtask": {
    "description": "Schedule a callback to run on the microtask queue after the current synchronous work finishes and before the next task.",
    "kind": "global",
    "returns": "void",
    "params": [param("callback", "() -> any")]
  },
  "Number": {
    "description": "Convert a value to a number.",
    "kind": "function",
    "returns": "float",
    "params": [param("value", "any")]
  },
  "Error": {
    "description": "Create an error value carrying a message.",
    "kind": "function",
    "returns": "Error",
    "params": [optionalParam("message", "string")]
  },
  "String": {
    "description": "Convert a value to its string representation.",
    "kind": "function",
    "returns": "string",
    "params": [param("value", "any")]
  },
  "sleep": {
    "description": "Settle after a number of milliseconds; await it to suspend the caller.",
    "kind": "function",
    "returns": "Promise<void>",
    "params": [param("millis", "float")]
  },
  "parse_int": {
    "description": "Parse an integer from a string with an optional radix.",
    "kind": "function",
    "returns": "int",
    "params": [param("text", "string"), optionalParam("radix", "int")]
  },
  "parse_float": {
    "description": "Parse a floating-point number from a string.",
    "kind": "function",
    "returns": "float",
    "params": [param("text", "string")]
  },
  "is_nan": {
    "description": "True when the value is NaN after numeric conversion.",
    "kind": "function",
    "returns": "bool",
    "params": [param("value", "any")]
  },
  "is_finite": {
    "description": "True when the value is a finite number.",
    "kind": "function",
    "returns": "bool",
    "params": [param("value", "any")]
  },
  "compile": {
    "description": "Compile a model or function to a backend (`cpu`/`gpu`/`wasm`/`webgpu`). `input` provides an example for shape inference and tuning.",
    "kind": "function",
    "returns": "unknown",
    "params": [
      param("model", "Module"),
      namedOptionalParam("input", "Tensor | Tensor[]"),
      namedOptionalParam("example_inputs", "Tensor[]"),
      namedOptionalParam("target", "CompileTarget"),
      namedOptionalParam("source", "bool"),
      namedOptionalParam("name", "string"),
      namedOptionalParam("mode", "string"),
      namedOptionalParam("verify", "CompileVerifyMode"),
      namedOptionalParam("error_mode", "CompileErrorMode"),
      namedOptionalParam("fold_weights", "bool"),
      namedOptionalParam("dynamic_shapes", "DynamicShapes"),
      namedOptionalParam("shape_buckets", "int[][][]"),
      namedOptionalParam("backward", "unknown"),
      namedOptionalParam("fusion", "CompileFusionOptions"),
      namedOptionalParam("scheduling", "CompileSchedulingOptions"),
      namedOptionalParam("matmul_backend", "CompileMatmulBackend"),
      namedOptionalParam("quantization", "CompileQuantizationOptions"),
      namedOptionalParam("optimization", "CompileOptimizationOptions"),
      namedOptionalParam("memory", "CompileMemoryOptions"),
      namedOptionalParam("partition", "CompilePartitionOptions"),
      namedOptionalParam("trace", "CompileTraceOptions"),
      namedOptionalParam("remat_policy", "unknown"),
      namedOptionalParam("remat", "ParamGrid"),
      namedOptionalParam("pass_context", "unknown"),
      namedOptionalParam("lowering_rules", "unknown"),
      namedOptionalParam("codegen_entries", "unknown"),
      namedOptionalParam("options", "CompileOptions")
    ]
  },
  "Sequential": {
    "description": "Compose modules into a feed-forward pipeline. The output of each module is fed to the next.",
    "kind": "sequential",
    "returns": "Sequential",
    "params": [
      param("modules", "Module", { optional: true, rest: true })
    ]
  },
  "Linear": {
    "description": "Fully-connected layer `y = x @ Wᵀ + b`. Set `bias=false` to disable the bias term.",
    "kind": "module",
    "returns": "Linear",
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
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "ReLU": {
    "description": "Rectified Linear Unit activation module: `max(0, x)`.",
    "kind": "module",
    "returns": "ReLU",
    "params": [],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "GELU": {
    "description": "Gaussian Error Linear Unit activation module — commonly used in Transformers.",
    "kind": "module",
    "returns": "GELU",
    "params": [],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "SiLU": {
    "description": "SiLU/Swish activation module: `x * sigmoid(x)`.",
    "kind": "module",
    "returns": "SiLU",
    "params": [],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "Sigmoid": {
    "description": "Logistic sigmoid activation module.",
    "kind": "module",
    "returns": "Sigmoid",
    "params": [],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "Tanh": {
    "description": "Hyperbolic tangent activation module.",
    "kind": "module",
    "returns": "Tanh",
    "params": [],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "LeakyReLU": {
    "description": "Leaky ReLU activation; negative inputs are scaled by `negative_slope` instead of zeroed.",
    "kind": "module",
    "returns": "LeakyReLU",
    "params": [
      {
        "name": "negative_slope",
        "type": "float",
        "optional": true,
        "defaultValue": 0.01
      }
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "ELU": {
    "description": "Exponential Linear Unit activation. Smooth alternative to ReLU for negative values.",
    "kind": "module",
    "returns": "ELU",
    "params": [
      {
        "name": "alpha",
        "type": "float",
        "optional": true,
        "defaultValue": 1
      }
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "Softmax": {
    "description": "Softmax module over the specified dimension.",
    "kind": "module",
    "returns": "Softmax",
    "params": [
      {
        "name": "dim",
        "type": "int",
        "optional": true,
        "defaultValue": -1
      }
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "LogSoftmax": {
    "description": "LogSoftmax module — numerically stable log of softmax.",
    "kind": "module",
    "returns": "LogSoftmax",
    "params": [
      {
        "name": "dim",
        "type": "int",
        "optional": true,
        "defaultValue": -1
      }
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "Flatten": {
    "description": "Flatten a contiguous range of dimensions into one. Typical use: between conv blocks and a Linear head.",
    "kind": "module",
    "returns": "Flatten",
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
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "Dropout": {
    "description": "Randomly zero elements with probability `p` during training. Inactive at eval time.",
    "kind": "module",
    "returns": "Dropout",
    "params": [
      {
        "name": "p",
        "type": "float",
        "optional": true,
        "defaultValue": 0.5
      }
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "LayerNorm": {
    "description": "Layer normalization over the given trailing shape. Stabilizes activations independent of batch.",
    "kind": "module",
    "returns": "LayerNorm",
    "params": [
      param("shape", "NumericShape"),
      optionalParam("eps", "float", 0.00001),
      optionalParam("elementwise_affine", "bool", true)
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "BatchNorm1d": {
    "description": "Batch normalization for 2-D `(N, C)` or 3-D `(N, C, L)` inputs.",
    "kind": "module",
    "returns": "BatchNorm1d",
    "params": [
      param("features", "int"),
      optionalParam("eps", "float", 0.00001),
      optionalParam("affine", "bool", true)
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "BatchNorm2d": {
    "description": "Batch normalization for 4-D `(N, C, H, W)` image-like inputs.",
    "kind": "module",
    "returns": "BatchNorm2d",
    "params": [
      param("features", "int"),
      optionalParam("eps", "float", 0.00001),
      optionalParam("affine", "bool", true)
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "Conv1d": {
    "description": "1-D convolution over an input with `in` channels, producing `out` channels.",
    "kind": "module",
    "returns": "Conv1d",
    "params": [
      param("in", "int"),
      param("out", "int"),
      param("kernel", "Conv1dSize"),
      ...namedOptionalAliases("stride", "Conv1dSize", [], 1),
      ...namedOptionalAliases("padding", "Conv1dPadding", [], 0),
      ...namedOptionalAliases("dilation", "Conv1dSize", [], 1),
      ...intOption("groups", [], 1),
      ...boolOption("bias", [], true)
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "Conv2d": {
    "description": "2-D convolution. Use `padding` to preserve spatial dimensions.",
    "kind": "module",
    "returns": "Conv2d",
    "params": [
      param("in", "int"),
      param("out", "int"),
      param("kernel", "ConvSize2d"),
      ...namedOptionalAliases("stride", "ConvSize2d", [], 1),
      ...namedOptionalAliases("padding", "ConvPadding2d", [], 0),
      ...namedOptionalAliases("dilation", "ConvSize2d", [], 1),
      ...intOption("groups", [], 1),
      ...boolOption("bias", [], true)
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "MaxPool2d": {
    "description": "2-D max pooling. Downsamples spatial dimensions taking the per-window max.",
    "kind": "module",
    "returns": "MaxPool2d",
    "params": [
      param("kernel", "Pool2dSize"),
      optionalParam("stride", "Pool2dSize | null"),
      optionalParam("padding", "Pool2dPadding", 0)
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "AvgPool2d": {
    "description": "2-D average pooling. Downsamples spatial dimensions averaging per window.",
    "kind": "module",
    "returns": "AvgPool2d",
    "params": [
      param("kernel", "Pool2dSize"),
      optionalParam("stride", "Pool2dSize | null"),
      optionalParam("padding", "Pool2dPadding", 0)
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "AdaptiveAvgPool2d": {
    "description": "2-D adaptive average pooling to a target output spatial shape, independent of input size.",
    "kind": "module",
    "returns": "AdaptiveAvgPool2d",
    "params": [
      param("output_size", "Pool2dSize")
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor")])
    ]
  },
  "Embedding": {
    "description": "Lookup table mapping integer ids to dense vectors of size `dim`.",
    "kind": "module",
    "returns": "Embedding",
    "params": [
      {
        "name": "num",
        "type": "int"
      },
      {
        "name": "dim",
        "type": "int"
      }
    ],
    "methods": [
      moduleForwardMethod([param("indices", "Tensor")])
    ]
  },
  "GRU": {
    "description": "Multi-layer Gated Recurrent Unit. Call `out, h_n = gru(x, h0?)` — returns the output sequence and the final hidden state. Set `batch_first=true` for `(N, T, input)` inputs.",
    "kind": "module",
    "returns": "GRU",
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
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor"), optionalParam("h0", "Tensor | null")], "[Tensor, Tensor]")
    ]
  },
  "GRUCell": {
    "description": "Single GRU time-step. `h_next = cell(x, h)` — apply manually to step a sequence one element at a time.",
    "kind": "module",
    "returns": "GRUCell",
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
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor"), optionalParam("hidden", "Tensor | null")])
    ]
  },
  "LSTM": {
    "description": "Multi-layer Long Short-Term Memory. Call `out, state = lstm(x, [h0, c0]?)` — returns the output sequence and `state = [h_n, c_n]` (final hidden and cell states). Set `batch_first=true` for `(N, T, input)` inputs.",
    "kind": "module",
    "returns": "LSTM",
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
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor"), optionalParam("state", "[Tensor, Tensor] | null")], "[Tensor, [Tensor, Tensor]]")
    ]
  },
  "LSTMCell": {
    "description": "Single LSTM time-step. `h_next, c_next = cell(x, [h, c])` — carries both hidden and cell state for O(T) autoregressive stepping.",
    "kind": "module",
    "returns": "LSTMCell",
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
    ],
    "methods": [
      moduleForwardMethod([param("input", "Tensor"), optionalParam("state", "[Tensor, Tensor] | null")], "[Tensor, Tensor]")
    ]
  },
  "CrossEntropyLoss": {
    "description": "Combined LogSoftmax + NLL loss — standard for multiclass classification. Pass `ignore_index` (e.g. a padding id) to exclude those target positions from the loss — useful for seq2seq with padded sequences.",
    "kind": "module",
    "returns": "CrossEntropyLoss",
    "params": [
      {
        "name": "reduction",
        "type": "LossReduction",
        "optional": true,
        "defaultValue": "mean"
      },
      {
        "name": "ignore_index",
        "type": "int",
        "optional": true
      }
    ],
    "methods": [
      lossForwardMethod("CrossEntropyLoss")
    ]
  },
  "MSELoss": {
    "description": "Mean squared error loss — standard for regression.",
    "kind": "module",
    "returns": "MSELoss",
    "params": [
      optionalParam("reduction", "LossReduction", "mean")
    ],
    "methods": [
      lossForwardMethod("MSELoss")
    ]
  },
  "NLLLoss": {
    "description": "Negative log-likelihood loss. Pair with LogSoftmax outputs.",
    "kind": "module",
    "returns": "NLLLoss",
    "params": [
      optionalParam("reduction", "LossReduction", "mean"),
      optionalParam("ignore_index", "int")
    ],
    "methods": [
      lossForwardMethod("NLLLoss")
    ]
  },
  "BCELoss": {
    "description": "Binary cross-entropy loss for sigmoid-activated outputs.",
    "kind": "module",
    "returns": "BCELoss",
    "params": [
      optionalParam("reduction", "LossReduction", "mean")
    ],
    "methods": [
      lossForwardMethod("BCELoss")
    ]
  },
  "SGD": {
    "description": "Stochastic gradient descent with optional `momentum` and `weight_decay`.",
    "kind": "optimizer",
    "returns": "SGD",
    "params": [
      param("params", "OptimizerParams"),
      ...floatOption("lr", [], 0.01),
      ...floatOption("momentum", [], 0),
      ...floatOption("dampening", [], 0),
      ...floatOption("weight_decay", [], 0),
      ...boolOption("nesterov", [], false)
    ]
  },
  "Adam": {
    "description": "Adaptive moment estimation optimizer. Standard default for deep learning.",
    "kind": "optimizer",
    "returns": "Adam",
    "params": [
      param("params", "OptimizerParams"),
      ...floatOption("lr", [], 0.001),
      namedOptionalParam("betas", "float[]"),
      ...floatOption("eps", [], 0.00000001),
      ...floatOption("weight_decay", [], 0),
      ...boolOption("amsgrad", [], false)
    ]
  },
  "AdamW": {
    "description": "Adam variant with decoupled weight decay — preferred for transformer-style models.",
    "kind": "optimizer",
    "returns": "AdamW",
    "params": [
      param("params", "OptimizerParams"),
      ...floatOption("lr", [], 0.001),
      namedOptionalParam("betas", "float[]"),
      ...floatOption("eps", [], 0.00000001),
      ...floatOption("weight_decay", [], 0.01),
      ...boolOption("amsgrad", [], false)
    ]
  },
  "StepLR": {
    "description": "Decay the learning rate by `gamma` every `step_size` epochs.",
    "kind": "scheduler",
    "returns": "StepLR",
    "params": [
      param("optimizer", "Optimizer"),
      param("step_size", "int"),
      optionalParam("gamma", "float", 0.1),
      optionalParam("last_epoch", "int", -1)
    ]
  },
  "CosineAnnealingLR": {
    "description": "Cosine schedule decaying the learning rate to `eta_min` over `t_max` epochs.",
    "kind": "scheduler",
    "returns": "CosineAnnealingLR",
    "params": [
      param("optimizer", "Optimizer"),
      param("t_max", "int"),
      optionalParam("eta_min", "float", 0),
      optionalParam("last_epoch", "int", -1)
    ]
  },
  "ReduceLROnPlateau": {
    "description": "Reduce learning rate when a monitored metric stops improving.",
    "kind": "scheduler",
    "returns": "ReduceLROnPlateau",
    "params": [
      param("optimizer", "Optimizer"),
      namedOptionalParam("mode", "string", "min"),
      namedOptionalParam("factor", "float", 0.1),
      namedOptionalParam("patience", "int", 10),
      namedOptionalParam("threshold", "float", 0.0001),
      namedOptionalParam("threshold_mode", "string", "rel"),
      namedOptionalParam("cooldown", "int", 0),
      namedOptionalParam("min_lr", "float", 0),
      namedOptionalParam("eps", "float", 0.00000001)
    ]
  },
  "Trainer": {
    "description": "Drives the training loop: epochs, validation, callbacks, logging, checkpointing.",
    "kind": "trainer",
    "returns": "Trainer",
    "params": [
      ...intOption("max_epochs", [], 20),
      ...intOption("max_steps", []),
      namedOptionalParam("accelerator", "string", "cpu"),
      namedOptionalParam("precision", "string"),
      namedOptionalParam("callbacks", "Callback[]"),
      namedOptionalParam("logger", "LoggerConfig", true),
      ...boolOption("enable_checkpointing", [], false),
      ...boolOption("enable_progress", [], true),
      ...floatOption("gradient_clip_val", []),
      namedOptionalParam("gradient_clip_algorithm", "string"),
      ...intOption("accumulate_grad_batches", [], 1),
      namedOptionalParam("limit_train_batches", "int | null"),
      namedOptionalParam("limit_val_batches", "int | null"),
      namedOptionalParam("limit_test_batches", "int | null"),
      ...floatOption("val_check_interval", []),
      ...intOption("check_val_every_n_epoch", [], 1),
      ...intOption("log_every_n_steps", [], 50),
      ...boolOption("deterministic"),
      namedOptionalParam("fast_dev_run", "bool | int", false),
      namedOptionalParam("default_root_dir", "string"),
      ...boolOption("compile", [], false),
      namedOptionalParam("compile_mode", "string"),
      ...boolOption("cuda_graph", [], false),
      ...intOption("cuda_graph_warmup_steps", [])
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
        "returns": "undefined",
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
        "returns": "NumericMetricRecord",
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
        "returns": "NumericMetricRecord",
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
        "returns": "unknown[]",
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
        "type": "Tensor | Metric | float | int"
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
    "returns": "OptimizerConfig",
    "params": [
      param("optimizer", "Optimizer"),
      namedOptionalParam("lr_scheduler", "LRScheduler | ReduceLROnPlateau"),
    ]
  },
  "TensorDataset": {
    "description": "In-memory dataset zipping one or more tensors along their first dimension.",
    "kind": "data",
    "returns": "TensorDataset",
    "params": [
      {
        "name": "tensors",
        "type": "Tensor",
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
        "type": "Dataset"
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
    "typeParams": ["T"],
    "returns": "T",
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
    "returns": "Module",
    "effect": "io",
    "params": [
      param("model", "Module"),
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
        "type": "TokenizerSpecialTokens",
        "optional": true,
        "named": true
      },
      {
        "name": "end_of_word",
        "type": "string",
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
            "type": "string | string[]",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "this",
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
        "returns": "undefined",
        "isGetter": false,
        "description": "Save the fitted tokenizer as a compact artifact. Reload it with the global `load_tokenizer(path)`."
      },
      {
        "name": "to_json",
        "params": [],
        "returns": "TokenizerJSON",
        "isGetter": false,
        "description": "Serialize the tokenizer configuration, vocabulary, and learned strategy."
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
            "named": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "add_eos",
            "type": "boolean",
            "optional": true,
            "named": true,
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
            "named": true,
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
            "type": "string | string[]",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "max_len",
            "type": "int",
            "optional": true,
            "named": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "pad_id",
            "type": "int",
            "optional": true,
            "named": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "add_bos",
            "type": "boolean",
            "optional": true,
            "named": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "add_eos",
            "type": "boolean",
            "optional": true,
            "named": true,
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
    "returns": "QuantBacktestResult",
    "effect": "async",
    "params": [
      param("prices", "any"),
      namedOptionalParam("signal", "string | Signal", "momentum"),
      namedOptionalParam("portfolio", "string | Portfolio", "long_short"),
      namedOptionalParam("lookback", "int", 20),
      namedOptionalParam("fraction", "float", 0.5),
      namedOptionalParam("cost", "float", 0),
      namedOptionalParam("max_leverage", "float", "Infinity"),
      namedOptionalParam("start", "int", 0),
      namedOptionalParam("periods_per_year", "int", 252),
      namedOptionalParam("asset_columns", "string[]")
    ]
  },
  "walk_forward": {
    "description": "Walk-forward (out-of-sample) backtest: split the series into `folds` segments after an initial `min_train_fraction` training window and stitch the per-fold out-of-sample returns. Same arguments and result shape as `backtest`.",
    "kind": "quant",
    "returns": "QuantBacktestResult",
    "effect": "async",
    "params": [
      param("prices", "any"),
      namedOptionalParam("signal", "string | Signal", "momentum"),
      namedOptionalParam("portfolio", "string | Portfolio", "long_short"),
      namedOptionalParam("lookback", "int", 20),
      namedOptionalParam("fraction", "float", 0.5),
      namedOptionalParam("cost", "float", 0),
      namedOptionalParam("max_leverage", "float", "Infinity"),
      namedOptionalParam("folds", "int", 4),
      namedOptionalParam("min_train_fraction", "float", 0.5),
      namedOptionalParam("periods_per_year", "int", 252),
      namedOptionalParam("asset_columns", "string[]")
    ]
  },
  "momentum": {
    "description": "Build a momentum signal handle (trailing return over `lookback` periods) to pass to `backtest`/`walk_forward` as `signal=`.",
    "kind": "quant",
    "returns": "Signal",
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
    "returns": "Signal",
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
    "returns": "Signal",
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
    "returns": "Portfolio",
    "params": []
  },
  "cross_sectional": {
    "description": "Portfolio handle that demeans the signal across assets and scales to unit gross exposure, for use as `portfolio=`.",
    "kind": "quant",
    "returns": "Portfolio",
    "params": []
  },
  "long_short": {
    "description": "Portfolio handle going long the top `fraction` and short the bottom `fraction` of ranked assets, for use as `portfolio=`.",
    "kind": "quant",
    "returns": "Portfolio",
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
    "returns": "float",
    "params": [
      param("returns", "any"),
      optionalParam("trial_sharpes", "any")
    ]
  },
  "pbo": {
    "description": "Probability of Backtest Overfitting via combinatorially symmetric cross-validation over a time × trial matrix (rows of returns, one column per candidate strategy). Accepts a matrix or a `DataFrame`.",
    "kind": "quant",
    "returns": "float",
    "params": [
      param("trial_returns", "any"),
      optionalParam("partitions", "int", 10)
    ]
  },
  "min_track_record_length": {
    "description": "Minimum count of observations needed before the observed Sharpe exceeds `target_sharpe` at the given `confidence`.",
    "kind": "quant",
    "returns": "float",
    "params": [
      param("returns", "any"),
      optionalParam("target_sharpe", "float", 0),
      optionalParam("confidence", "float", 0.95)
    ]
  },
  "risk_parity": {
    "description": "Equal-risk-contribution portfolio weights for a covariance matrix. Passing a returns `DataFrame` estimates the sample covariance first. Returns a weight array.",
    "kind": "quant",
    "returns": "float[]",
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
    "returns": "float[]",
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
    "returns": "float[]",
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
    "returns": "QuillProduct",
    "params": [
      param("source", "string")
    ]
  },
  "load_quill": {
    "description": "Like `quill`, but read the Quill product definition from a file `path`. Returns the same product handle with a `.price(...)` method and a `.name` field.",
    "kind": "quant",
    "returns": "QuillProduct",
    "params": [
      param("path", "string")
    ]
  },
  "adf_test": {
    "description": "Augmented Dickey-Fuller unit-root test. Returns a record with `statistic`, `critical_values` (`.one`/`.five`/`.ten`), and `stationary` (true when the statistic is below the critical value).",
    "kind": "quant",
    "returns": "UnitRootTest",
    "params": [
      param("series", "any"),
      optionalParam("lags", "int", 0),
      optionalParam("trend", "string", "constant")
    ]
  },
  "kpss_test": {
    "description": "KPSS stationarity test (null hypothesis: the series is stationary). Returns `statistic`, `critical_values`, `stationary`. Complements `adf_test`.",
    "kind": "quant",
    "returns": "UnitRootTest",
    "params": [
      param("series", "any"),
      optionalParam("trend", "string", "constant"),
      optionalParam("lags", "int")
    ]
  },
  "hurst_exponent": {
    "description": "Hurst exponent from rescaled-range analysis. `< 0.5` mean-reverting, `~0.5` random walk, `> 0.5` trending.",
    "kind": "quant",
    "returns": "float",
    "params": [
      param("series", "any"),
      optionalParam("min_window", "int", 10),
      optionalParam("max_window", "int"),
      optionalParam("growth", "float", 1.5)
    ]
  },
  "half_life": {
    "description": "Ornstein-Uhlenbeck mean-reversion half-life (in periods) estimated by regressing the change on the lagged level.",
    "kind": "quant",
    "returns": "float",
    "params": [
      param("series", "any")
    ]
  },
  "engle_granger": {
    "description": "Engle-Granger two-step cointegration test: regress `dependent` on `regressors`, then ADF-test the residual. Returns `statistic`, `critical_values`, `cointegrated`, `hedge_ratio`, and `spread`.",
    "kind": "quant",
    "returns": "EngleGrangerResult",
    "params": [
      param("dependent", "any"),
      param("regressors", "any"),
      optionalParam("lags", "int", 0)
    ]
  },
  "johansen": {
    "description": "Johansen cointegration test on a matrix of price levels. Returns `eigenvalues`, `vectors`, `trace_statistics`, `max_eigen_statistics`, and the estimated cointegration `rank`.",
    "kind": "quant",
    "returns": "JohansenResult",
    "params": [
      param("levels", "any"),
      optionalParam("lags", "int", 1)
    ]
  },
  "cusum_events": {
    "description": "Symmetric CUSUM filter — returns the indices where the cumulative deviation exceeds `threshold`, used to sample structural-shift events.",
    "kind": "quant",
    "returns": "int[]",
    "params": [
      param("series", "any"),
      param("threshold", "float"),
      optionalParam("drift", "float", 0)
    ]
  },
  "sadf": {
    "description": "Supremum ADF statistic — the max ADF over expanding windows, a test for explosive (bubble) behavior.",
    "kind": "quant",
    "returns": "float",
    "params": [
      param("series", "any"),
      optionalParam("min_window", "int", 20),
      optionalParam("lags", "int", 0),
      optionalParam("trend", "string", "constant")
    ]
  },
  "bsadf": {
    "description": "Backward-SADF series — the running SADF at each point, for dating the start/end of explosive regimes.",
    "kind": "quant",
    "returns": "float[]",
    "params": [
      param("series", "any"),
      optionalParam("min_window", "int", 20),
      optionalParam("lags", "int", 0),
      optionalParam("trend", "string", "constant")
    ]
  },
  "kalman_filter": {
    "description": "Linear Kalman filter over a state-space `spec` (transition, observation, process/measurement noise). Returns filtered `states`, `covariances`, `innovations`, and `innovation_variances`.",
    "kind": "quant",
    "returns": "KalmanResult",
    "params": [
      param("observations", "any"),
      param("observation_vectors", "any"),
      param("spec", "Object")
    ]
  },
  "kalman_smoother": {
    "description": "Rauch-Tung-Striebel smoother — the full-sample smoothed state matrix for the same state-space `spec` as `kalman_filter`.",
    "kind": "quant",
    "returns": "float[][]",
    "params": [
      param("observations", "any"),
      param("observation_vectors", "any"),
      param("spec", "Object")
    ]
  },
  "dynamic_beta": {
    "description": "Time-varying hedge ratio / beta via a Kalman filter (random-walk coefficients). Returns the per-period `states` (betas) — the workhorse for dynamic pairs trading.",
    "kind": "quant",
    "returns": "KalmanResult",
    "params": [
      param("dependent", "any"),
      param("regressors", "any"),
      namedOptionalParam("process_noise", "float", 0.0001),
      namedOptionalParam("observation_noise", "float", 0.01),
      namedOptionalParam("initial_variance", "float", 1)
    ]
  },
  "fit_garch": {
    "description": "Fit a GARCH(1,1) volatility model by maximum likelihood. Returns a record with `params` (`omega`, `alpha`, `beta`), `log_likelihood`, `persistence`, `unconditional_variance`, and fitted `variances`.",
    "kind": "quant",
    "returns": "GarchFit",
    "params": [
      param("returns", "any"),
      namedOptionalParam("variance_targeting", "bool", true),
      namedOptionalParam("seed", "int", 1),
      namedOptionalParam("alpha_range", "[float, float]", [0.0001, 0.4]),
      namedOptionalParam("beta_range", "[float, float]", [0.3, 0.999]),
      namedOptionalParam("omega_scale_range", "[float, float]", [0.001, 2]),
      namedOptionalParam("stationarity_margin", "float", 0.0001)
    ]
  },
  "garch_forecast": {
    "description": "Forecast conditional variance `horizon` steps ahead from GARCH `params` (as returned by `fit_garch`).",
    "kind": "quant",
    "returns": "float[]",
    "params": [
      param("returns", "any"),
      param("params", "GarchParams"),
      param("horizon", "int"),
      optionalParam("initial_variance", "float")
    ]
  },
  "garch_volatility": {
    "description": "In-sample conditional volatility path (standard deviation per period) for the given GARCH `params`.",
    "kind": "quant",
    "returns": "float[]",
    "params": [
      param("returns", "any"),
      param("params", "GarchParams"),
      optionalParam("initial_variance", "float")
    ]
  },
  "tick_bars": {
    "description": "Aggregate a `ticks` DataFrame (`price`, `volume`) into OHLC bars of fixed tick count. Returns a bar `DataFrame`.",
    "kind": "quant",
    "returns": "DataFrame",
    "params": [
      param("ticks", "any"),
      param("ticks_per_bar", "int")
    ]
  },
  "volume_bars": {
    "description": "Information-driven bars sampled every fixed traded `volume_per_bar`. Returns a bar `DataFrame`.",
    "kind": "quant",
    "returns": "DataFrame",
    "params": [
      param("ticks", "any"),
      param("volume_per_bar", "float")
    ]
  },
  "dollar_bars": {
    "description": "Bars sampled every fixed traded dollar value — the most sample-stationary bar type. Returns a bar `DataFrame`.",
    "kind": "quant",
    "returns": "DataFrame",
    "params": [
      param("ticks", "any"),
      param("dollar_per_bar", "float")
    ]
  },
  "tick_rule": {
    "description": "Lee-Ready tick rule — signs each trade `+1`/`-1` by price change to infer aggressor side.",
    "kind": "quant",
    "returns": "int[]",
    "params": [
      param("prices", "any")
    ]
  },
  "roll_spread": {
    "description": "Roll's implied effective bid-ask spread from the serial covariance of price changes.",
    "kind": "quant",
    "returns": "float",
    "params": [
      param("prices", "any")
    ]
  },
  "amihud": {
    "description": "Amihud illiquidity — average of `|return| / dollar_volume`, a price-impact-per-dollar measure.",
    "kind": "quant",
    "returns": "float",
    "params": [
      param("returns", "any"),
      param("dollar_volumes", "any")
    ]
  },
  "kyle_lambda": {
    "description": "Kyle's lambda — price impact per signed volume, estimated by regressing price changes on signed order flow.",
    "kind": "quant",
    "returns": "float",
    "params": [
      param("prices", "any"),
      param("volumes", "any")
    ]
  },
  "vpin": {
    "description": "Volume-synchronized Probability of Informed Trading — order-flow-toxicity series over volume buckets.",
    "kind": "quant",
    "returns": "float[]",
    "params": [
      param("ticks", "any"),
      param("bucket_volume", "float"),
      optionalParam("window", "int", 50)
    ]
  },
  "EarlyStopping": {
    "description": "Stop training when a monitored metric stops improving for `patience` evaluations.",
    "kind": "callback",
    "returns": "EarlyStopping",
    "params": [
      namedOptionalParam("monitor", "string"),
      namedOptionalParam("patience", "int", 3),
      namedOptionalParam("mode", "string", "min"),
      ...floatOption("min_delta", [], 0),
      ...boolOption("check_on_train_epoch_end", [])
    ]
  },
  "ModelCheckpoint": {
    "description": "Save the best model(s) according to a monitored metric.",
    "kind": "callback",
    "returns": "ModelCheckpoint",
    "params": [
      namedOptionalParam("dirpath", "string"),
      namedOptionalParam("filename", "string"),
      namedOptionalParam("monitor", "string | null"),
      namedOptionalParam("mode", "string", "min"),
      ...intOption("save_top_k", [], 1),
      ...boolOption("save_last", []),
      ...intOption("every_n_epochs", [])
    ]
  },
  "ProgressCallback": {
    "description": "Lightweight progress bar callback for the Trainer.",
    "kind": "callback",
    "returns": "ProgressCallback",
    "params": [
      ...intOption("bar_length", [])
    ]
  },
  "LearningRateMonitor": {
    "description": "Log the current learning rate at each step.",
    "kind": "callback",
    "returns": "LearningRateMonitor",
    "params": [
      ...boolOption("log_momentum", [])
    ]
  },
  "Timer": {
    "description": "Measure and log wall-clock time per epoch and total.",
    "kind": "callback",
    "returns": "Timer",
    "params": []
  },
  "GradientAccumulationScheduler": {
    "description": "Accumulate gradients across multiple steps before updating, on a per-epoch schedule.",
    "kind": "callback",
    "returns": "GradientAccumulationScheduler",
    "params": [
      namedParam("scheduling", "GradientAccumulationSchedule")
    ]
  },
  "ConsoleLogger": {
    "description": "Send log records to stdout.",
    "kind": "logger",
    "returns": "ConsoleLogger",
    "params": [
      namedOptionalParam("name", "string"),
      namedOptionalParam("version", "int | null"),
      ...intOption("log_frequency", [])
    ]
  },
  "CSVLogger": {
    "description": "Append log records to a CSV file under `save_dir/name`.",
    "kind": "logger",
    "returns": "CSVLogger",
    "params": [
      namedOptionalParam("save_dir", "string", "logs"),
      namedOptionalParam("name", "string", "experiment"),
      namedOptionalParam("version", "int | null"),
      ...intOption("flush_interval", [])
    ]
  },
  "Accuracy": {
    "description": "Classification accuracy metric. Configure with `task` (`binary`/`multiclass`/`multilabel`).",
    "kind": "metric",
    "returns": "Accuracy",
    "params": [
      namedOptionalParam("task", "string", "binary"),
      namedOptionalParam("num_classes", "int | null"),
      ...intOption("top_k", [], 1),
      ...floatOption("threshold")
    ]
  },
  "Precision": {
    "description": "Precision metric — fraction of positive predictions that are correct.",
    "kind": "metric",
    "returns": "Precision",
    "params": [
      namedOptionalParam("task", "string", "binary"),
      namedOptionalParam("num_classes", "int"),
      namedOptionalParam("average", "string", "macro")
    ]
  },
  "Recall": {
    "description": "Recall metric — fraction of actual positives that are predicted positive.",
    "kind": "metric",
    "returns": "Recall",
    "params": [
      namedOptionalParam("task", "string", "binary"),
      namedOptionalParam("num_classes", "int"),
      namedOptionalParam("average", "string", "macro")
    ]
  },
  "F1Score": {
    "description": "Harmonic mean of precision and recall.",
    "kind": "metric",
    "returns": "F1Score",
    "params": [
      namedOptionalParam("task", "string", "binary"),
      namedOptionalParam("num_classes", "int"),
      namedOptionalParam("average", "string", "macro")
    ]
  },
  "ConfusionMatrix": {
    "description": "Cumulative confusion matrix over `num_classes`.",
    "kind": "metric",
    "returns": "ConfusionMatrix",
    "params": [
      namedParam("num_classes", "int")
    ]
  },
  "MetricCollection": {
    "description": "Group multiple metrics into one callable for convenience.",
    "kind": "metric_collection",
    "returns": "MetricCollection",
    "params": [
      optionalParam("metrics", "MetricMap")
    ],
    "methods": [
      {
        "name": "add",
        "params": [
          param("name", "string"),
          param("metric", "Metric")
        ],
        "returns": "this",
        "isGetter": false,
        "description": "Add a named metric to the collection."
      },
      {
        "name": "update",
        "params": [
          param("preds", "Tensor"),
          param("target", "Tensor")
        ],
        "returns": "undefined",
        "isGetter": false,
        "description": "Update all metrics with one prediction/target batch."
      },
      {
        "name": "compute",
        "params": [],
        "returns": "MetricRecord",
        "isGetter": false,
        "description": "Return a record of metric names to computed results."
      },
      {
        "name": "reset",
        "params": [],
        "returns": "undefined",
        "isGetter": false,
        "description": "Clear every metric in the collection."
      },
      {
        "name": "forward",
        "params": [
          param("preds", "Tensor"),
          param("target", "Tensor")
        ],
        "returns": "MetricRecord",
        "isGetter": false,
        "description": "Update all metrics and return computed results."
      }
    ]
  },
  "LinearRegression": {
    "description": "Ordinary least-squares linear regression (solved via `lstsq`).",
    "kind": "ml_model",
    "returns": "LinearRegression",
    "params": [
      ...fitInterceptOptions()
    ]
  },
  "Ridge": {
    "description": "L2-regularized linear regression, closed-form via `solve`.",
    "kind": "ml_model",
    "returns": "Ridge",
    "params": [
      ...floatOption("alpha", [], 1),
      ...fitInterceptOptions()
    ]
  },
  "Lasso": {
    "description": "L1-regularized linear regression via coordinate descent (sparse coefficients).",
    "kind": "ml_model",
    "returns": "Lasso",
    "params": [
      ...floatOption("alpha", [], 1),
      ...fitInterceptOptions(),
      ...intOption("max_iter", []),
      ...floatOption("tol")
    ]
  },
  "ElasticNet": {
    "description": "Combined L1/L2 linear regression via coordinate descent.",
    "kind": "ml_model",
    "returns": "ElasticNet",
    "params": [
      ...floatOption("alpha", [], 1),
      ...floatOption("l1_ratio", []),
      ...fitInterceptOptions(),
      ...intOption("max_iter", []),
      ...floatOption("tol")
    ]
  },
  "LogisticRegression": {
    "description": "Multinomial logistic regression (softmax) trained by gradient descent. Also exposes `predict_proba(X) -> Tensor`.",
    "kind": "ml_model",
    "returns": "LogisticRegression",
    "params": [
      ...floatOption("C"),
      ...floatOption("lr"),
      ...intOption("max_iter", [])
    ]
  },
  "KNeighborsClassifier": {
    "description": "k-nearest-neighbors classifier (majority vote over Euclidean neighbors).",
    "kind": "ml_model",
    "returns": "KNeighborsClassifier",
    "params": [
      ...intOption("n_neighbors", [])
    ]
  },
  "KNeighborsRegressor": {
    "description": "k-nearest-neighbors regressor (mean of neighbor targets).",
    "kind": "ml_model",
    "returns": "KNeighborsRegressor",
    "params": [
      ...intOption("n_neighbors", [])
    ]
  },
  "GaussianNB": {
    "description": "Gaussian Naive Bayes classifier.",
    "kind": "ml_model",
    "returns": "GaussianNB",
    "params": []
  },
  "DecisionTreeClassifier": {
    "description": "CART decision-tree classifier (Gini impurity).",
    "kind": "ml_model",
    "returns": "DecisionTreeClassifier",
    "params": [
      ...treeOptions()
    ]
  },
  "DecisionTreeRegressor": {
    "description": "CART decision-tree regressor (variance reduction).",
    "kind": "ml_model",
    "returns": "DecisionTreeRegressor",
    "params": [
      ...treeOptions()
    ]
  },
  "RandomForestClassifier": {
    "description": "Bagged ensemble of decision trees (majority vote).",
    "kind": "ml_model",
    "returns": "RandomForestClassifier",
    "params": [
      ...forestOptions()
    ]
  },
  "RandomForestRegressor": {
    "description": "Bagged ensemble of decision trees (mean prediction).",
    "kind": "ml_model",
    "returns": "RandomForestRegressor",
    "params": [
      ...forestOptions()
    ]
  },
  "GradientBoostingClassifier": {
    "description": "Stage-wise gradient boosting for classification (multinomial deviance).",
    "kind": "ml_model",
    "returns": "GradientBoostingClassifier",
    "params": [
      ...boostingOptions()
    ]
  },
  "GradientBoostingRegressor": {
    "description": "Stage-wise gradient boosting for regression (squared-error residuals).",
    "kind": "ml_model",
    "returns": "GradientBoostingRegressor",
    "params": [
      ...boostingOptions()
    ]
  },
  "StandardScaler": {
    "description": "Standardize features to zero mean and unit variance per column.",
    "kind": "ml_transform",
    "returns": "StandardScaler",
    "params": [
      ...boolOption("with_mean", [], true),
      ...boolOption("with_std", [], true)
    ]
  },
  "MinMaxScaler": {
    "description": "Scale features to a given range per column.",
    "kind": "ml_transform",
    "returns": "MinMaxScaler",
    "params": [
      namedOptionalParam("feature_range", "[float, float]"),
    ]
  },
  "LabelEncoder": {
    "description": "Encode categorical labels to integer ids. `inverse_transform` returns the original labels.",
    "kind": "label_encoder",
    "returns": "LabelEncoder",
    "params": [],
    "methods": [
      {
        "name": "fit",
        "params": [
          mlTensorParam("y")
        ],
        "returns": "this",
        "isGetter": false,
        "description": "Learn label classes from `y`."
      },
      {
        "name": "transform",
        "params": [
          mlTensorParam("y")
        ],
        "returns": "MLTensor",
        "isGetter": false,
        "description": "Encode labels to integer ids."
      },
      {
        "name": "fit_transform",
        "params": [
          mlTensorParam("y")
        ],
        "returns": "MLTensor",
        "isGetter": false,
        "description": "Fit then encode labels in one call."
      },
      {
        "name": "inverse_transform",
        "params": [
          mlTensorParam("y")
        ],
        "returns": "float[]",
        "isGetter": false,
        "description": "Decode integer ids to the original numeric labels."
      }
    ]
  },
  "OneHotEncoder": {
    "description": "Encode categorical labels to one-hot rows.",
    "kind": "one_hot_encoder",
    "returns": "OneHotEncoder",
    "params": [],
    "methods": [
      {
        "name": "fit",
        "params": [
          mlTensorParam("y")
        ],
        "returns": "this",
        "isGetter": false,
        "description": "Learn label classes from `y`."
      },
      {
        "name": "transform",
        "params": [
          mlTensorParam("y")
        ],
        "returns": "MLTensor",
        "isGetter": false,
        "description": "Encode labels into one-hot rows."
      },
      {
        "name": "fit_transform",
        "params": [
          mlTensorParam("y")
        ],
        "returns": "MLTensor",
        "isGetter": false,
        "description": "Fit then one-hot encode labels in one call."
      }
    ]
  },
  "PCA": {
    "description": "Principal component analysis (via `svd`). Exposes `components_`, `explainedVariance_`, `explainedVarianceRatio_`.",
    "kind": "ml_transform",
    "returns": "PCA",
    "params": [
      namedOptionalParam("n_components", "int | null"),
    ]
  },
  "KMeans": {
    "description": "k-means clustering (k-means++ init). Exposes `clusterCenters_`, `labels_`, `inertia_`.",
    "kind": "ml_cluster",
    "returns": "KMeans",
    "params": [
      ...intOption("n_clusters", []),
      ...intOption("max_iter", []),
      ...intOption("n_init", []),
      ...intOption("random_state", [])
    ],
    "methods": [
      {
        "name": "fit",
        "params": [
          {
            "name": "X",
            "type": "MLTensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "this",
        "isGetter": false,
        "description": "Compute cluster centers from `X`."
      },
      {
        "name": "predict",
        "params": [
          {
            "name": "X",
            "type": "MLTensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "MLTensor",
        "isGetter": false,
        "description": "Assign each row of `X` to its nearest cluster."
      },
      {
        "name": "fit_predict",
        "params": [
          {
            "name": "X",
            "type": "MLTensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "MLTensor | null",
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
      ...intOption("n_splits", []),
      ...boolOption("shuffle"),
      ...intOption("random_state", [])
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
        "returns": "FoldArray",
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
      ...intOption("n_splits", [])
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
        "returns": "FoldArray",
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
      param("estimator", "EstimatorFactory"),
      param("param_grid", "ParamGrid"),
      namedOptionalParam("cv", "int"),
      namedOptionalParam("scoring", "ScoringFn | null")
    ],
    "methods": [
      {
        "name": "fit",
        "params": [
          {
            "name": "X",
            "type": "MLTensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "y",
            "type": "MLTensor",
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
            "type": "MLTensor",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "MLTensor",
        "isGetter": false,
        "description": "Predict using the best found estimator."
      }
    ]
  },
  "train_test_split": {
    "description": "Split data into train/test partitions. With `y`, returns `[X_train, X_test, y_train, y_test]`; with only `X`, returns `[X_train, X_test]`.",
    "kind": "ml_function",
    "returns": "TrainTestSplitResult",
    "params": [
      mlTensorParam("X"),
      optionalParam("y", "MLTensor"),
      ...floatOption("test_size", []),
      ...boolOption("shuffle"),
      ...intOption("random_state", [])
    ]
  },
  "cross_val_score": {
    "description": "Cross-validated scores for an estimator constructor over `cv` folds.",
    "kind": "ml_function",
    "returns": "float[]",
    "params": [
      param("estimator", "EstimatorFactory"),
      mlTensorParam("X"),
      mlTensorParam("y"),
      namedOptionalParam("cv", "int"),
      namedOptionalParam("scoring", "ScoringFn | null"),
      ...boolOption("shuffle"),
      ...intOption("random_state", [])
    ]
  },
  "r2_score": {
    "description": "Coefficient of determination (R²).",
    "kind": "ml_metric",
    "returns": "float",
    "params": [
      mlTensorParam("y_true"),
      mlTensorParam("y_pred")
    ]
  },
  "mean_squared_error": {
    "description": "Mean squared error.",
    "kind": "ml_metric",
    "returns": "float",
    "params": [
      mlTensorParam("y_true"),
      mlTensorParam("y_pred")
    ]
  },
  "mean_absolute_error": {
    "description": "Mean absolute error.",
    "kind": "ml_metric",
    "returns": "float",
    "params": [
      mlTensorParam("y_true"),
      mlTensorParam("y_pred")
    ]
  },
  "accuracy_score": {
    "description": "Classification accuracy.",
    "kind": "ml_metric",
    "returns": "float",
    "params": [
      mlTensorParam("y_true"),
      mlTensorParam("y_pred")
    ]
  },
  "confusion_matrix": {
    "description": "Confusion matrix as a nested array.",
    "kind": "ml_metric",
    "returns": "float[][]",
    "params": [
      mlTensorParam("y_true"),
      mlTensorParam("y_pred")
    ]
  },
  "svd": {
    "description": "Reduced singular value decomposition. Returns `{U, S, V}` with `input ≈ U diag(S) Vᵀ`.",
    "kind": "linalg",
    "returns": "SVDResult",
    "params": [
      param("input", "Tensor")
    ]
  },
  "eigh": {
    "description": "Symmetric eigendecomposition. Returns `{values, vectors}` (ascending eigenvalues).",
    "kind": "linalg",
    "returns": "EighResult",
    "params": [
      param("input", "Tensor")
    ]
  },
  "cholesky": {
    "description": "Cholesky factor `L` (lower-triangular) of a symmetric positive-definite matrix.",
    "kind": "linalg",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "solve": {
    "description": "Solve the linear system `a @ x = b` for `x`.",
    "kind": "linalg",
    "returns": "Tensor",
    "params": [
      param("a", "Tensor"),
      param("b", "Tensor")
    ]
  },
  "lstsq": {
    "description": "Least-squares solution to `a @ x ≈ b` (via pseudo-inverse).",
    "kind": "linalg",
    "returns": "Tensor",
    "params": [
      param("a", "Tensor"),
      param("b", "Tensor")
    ]
  },
  "inv": {
    "description": "Matrix inverse.",
    "kind": "linalg",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "pinv": {
    "description": "Moore-Penrose pseudo-inverse.",
    "kind": "linalg",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "det": {
    "description": "Determinant (scalar).",
    "kind": "linalg",
    "returns": "NumericScalar",
    "params": [
      param("input", "Tensor")
    ]
  },
  "cov": {
    "description": "Covariance matrix of the columns of `input`.",
    "kind": "linalg",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "normal_cdf": {
    "description": "Normal distribution cumulative distribution function, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("x"),
      ...distOptions()
    ]
  },
  "normal_ppf": {
    "description": "Normal distribution quantile function (inverse CDF), applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("p"),
      ...distOptions()
    ]
  },
  "normal_pdf": {
    "description": "Normal distribution probability density function, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("x"),
      ...distOptions()
    ]
  },
  "t_cdf": {
    "description": "Student's t cumulative distribution function with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("x"),
      optionalParam("df", "float"),
      ...distOptions()
    ]
  },
  "t_ppf": {
    "description": "Student's t quantile function (inverse CDF) with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("p"),
      optionalParam("df", "float"),
      ...distOptions()
    ]
  },
  "t_pdf": {
    "description": "Student's t probability density function with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("x"),
      optionalParam("df", "float"),
      ...distOptions()
    ]
  },
  "chi2_cdf": {
    "description": "Chi-squared cumulative distribution function with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("x"),
      optionalParam("df", "float"),
      ...distOptions()
    ]
  },
  "chi2_ppf": {
    "description": "Chi-squared quantile function (inverse CDF) with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("p"),
      optionalParam("df", "float"),
      ...distOptions()
    ]
  },
  "chi2_pdf": {
    "description": "Chi-squared probability density function with `df` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("x"),
      optionalParam("df", "float"),
      ...distOptions()
    ]
  },
  "f_cdf": {
    "description": "F distribution cumulative distribution function with `d1` and `d2` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("x"),
      optionalParam("d1", "float"),
      optionalParam("d2", "float"),
      ...distOptions()
    ]
  },
  "f_ppf": {
    "description": "F distribution quantile function (inverse CDF) with `d1` and `d2` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("p"),
      optionalParam("d1", "float"),
      optionalParam("d2", "float"),
      ...distOptions()
    ]
  },
  "f_pdf": {
    "description": "F distribution probability density function with `d1` and `d2` degrees of freedom, applied elementwise.",
    "kind": "numeric_dist",
    "returns": "NumericDistResult",
    "params": [
      numericElementParam("x"),
      optionalParam("d1", "float"),
      optionalParam("d2", "float"),
      ...distOptions()
    ]
  },
  "erf": {
    "description": "Error function, applied elementwise.",
    "kind": "numeric_func",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "erfc": {
    "description": "Complementary error function, applied elementwise.",
    "kind": "numeric_func",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "lgamma": {
    "description": "Natural logarithm of the absolute value of the gamma function, applied elementwise.",
    "kind": "numeric_func",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "gamma": {
    "description": "Gamma function, applied elementwise.",
    "kind": "numeric_func",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "fft": {
    "description": "Discrete Fourier transform of a 1-D real or `[n, 2]` complex signal. Returns an `[n, 2]` Tensor of real/imaginary pairs.",
    "kind": "numeric_transform",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "ifft": {
    "description": "Inverse discrete Fourier transform of a 1-D real or `[n, 2]` complex signal. Returns an `[n, 2]` Tensor of real/imaginary pairs.",
    "kind": "numeric_transform",
    "returns": "Tensor",
    "params": [
      param("input", "Tensor")
    ]
  },
  "qr": {
    "description": "QR decomposition. Returns `{Q, R}` with `input = Q @ R`.",
    "kind": "numeric_transform",
    "returns": "QRResult",
    "params": [
      param("input", "Tensor")
    ]
  },
  "linear_interp": {
    "description": "Piecewise-linear interpolation of the points `(xs, ys)` evaluated at `xq` (an int, float, or array of numeric values).",
    "kind": "numeric_func",
    "returns": "LinearInterpResult",
    "params": [
      param("xs", "NumericScalar[]"),
      param("ys", "NumericScalar[]"),
      param("xq", "NumericScalar | NumericScalar[]")
    ]
  },
  "cubic_spline": {
    "description": "Natural cubic spline interpolant through the points `(xs, ys)`.",
    "kind": "numeric_func",
    "returns": "CubicSpline",
    "params": [
      param("xs", "NumericScalar[]"),
      param("ys", "NumericScalar[]")
    ],
    "methods": [
      {
        "name": "evaluate",
        "params": [
          param("xq", "NumericScalar | NumericScalar[]")
        ],
        "returns": "LinearInterpResult",
        "isGetter": false,
        "description": "Evaluate the spline at a query point or a array of query points."
      }
    ]
  },
  "t_test_1samp": {
    "description": "One-sample t-test of the mean of `x` against `popmean`. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "TestResult",
    "params": [
      numericVectorParam("x"),
      namedOptionalParam("popmean", "float")
    ]
  },
  "t_test_ind": {
    "description": "Two-sample independent t-test. `equal_var=true` pools variances; `equal_var=false` uses the Welch unequal-variance form. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "TestResult",
    "params": [
      numericVectorParam("x"),
      numericVectorParam("y"),
      namedOptionalParam("popmean", "float"),
      namedOptionalParam("equal_var", "bool"),
    ]
  },
  "t_test_paired": {
    "description": "Paired t-test on matched samples `x` and `y`. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "TestResult",
    "params": [
      numericVectorParam("x"),
      numericVectorParam("y"),
      namedOptionalParam("popmean", "float")
    ]
  },
  "chi2_gof": {
    "description": "Chi-square goodness-of-fit test of `observed` counts against `expected` counts (uniform when omitted). Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "TestResult",
    "params": [
      numericVectorParam("observed"),
      optionalParam("expected", "NumericVectorInput | null"),
      namedOptionalParam("ddof", "int")
    ]
  },
  "chi2_independence": {
    "description": "Chi-square test of independence on a 2-D contingency `table`. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "TestResult",
    "params": [
      numericMatrixParam("table")
    ]
  },
  "ks_test_1samp": {
    "description": "One-sample Kolmogorov-Smirnov test of `x` against a reference CDF (normal with `loc`/`scale` by default). Returns a record with `statistic`, `pvalue`.",
    "kind": "numeric_stats_test",
    "returns": "TestResultNoDf",
    "params": [
      numericVectorParam("x"),
      optionalParam("cdf", "ScalarFn"),
      namedOptionalParam("loc", "float"),
      namedOptionalParam("scale", "float")
    ]
  },
  "ks_test_2samp": {
    "description": "Two-sample Kolmogorov-Smirnov test comparing the empirical distributions of `x` and `y`. Returns a record with `statistic`, `pvalue`.",
    "kind": "numeric_stats_test",
    "returns": "TestResultNoDf",
    "params": [
      numericVectorParam("x"),
      numericVectorParam("y")
    ]
  },
  "jarque_bera": {
    "description": "Jarque-Bera normality test built from sample skewness and kurtosis. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "TestResult",
    "params": [
      numericVectorParam("x")
    ]
  },
  "dagostino_k2": {
    "description": "D'Agostino K-squared normality test combining skewness and kurtosis z-scores. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_stats_test",
    "returns": "TestResult",
    "params": [
      numericVectorParam("x")
    ]
  },
  "anderson_darling": {
    "description": "Anderson-Darling normality test with the small-sample corrected p-value. Returns a record with `statistic`, `pvalue`.",
    "kind": "numeric_stats_test",
    "returns": "TestResultNoDf",
    "params": [
      numericVectorParam("x")
    ]
  },
  "mann_whitney_u": {
    "description": "Mann-Whitney U rank-sum test with normal approximation, tie correction, and continuity correction. Returns a record with `statistic`, `pvalue`.",
    "kind": "numeric_stats_test",
    "returns": "TestResultNoDf",
    "params": [
      numericVectorParam("x"),
      numericVectorParam("y")
    ]
  },
  "acf": {
    "description": "Sample autocorrelation function of `x` up to `nlags` (FFT-based). Returns a Tensor of length `nlags + 1` with lag 0 equal to 1.",
    "kind": "numeric_timeseries",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      namedOptionalParam("nlags", "int")
    ]
  },
  "pacf": {
    "description": "Partial autocorrelation function of `x` via Levinson-Durbin recursion. Returns a Tensor of length `nlags + 1` with lag 0 equal to 1.",
    "kind": "numeric_timeseries",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      namedOptionalParam("nlags", "int")
    ]
  },
  "ljung_box": {
    "description": "Ljung-Box test for autocorrelation up to `lags`. Returns a record with `statistic`, `pvalue`, `df`.",
    "kind": "numeric_timeseries",
    "returns": "TestResult",
    "params": [
      numericVectorParam("x"),
      namedOptionalParam("lags", "int"),
      namedOptionalParam("model_df", "int"),
    ]
  },
  "durbin_watson": {
    "description": "Durbin-Watson statistic of a residual series; values near 2 indicate no first-order autocorrelation.",
    "kind": "numeric_timeseries",
    "returns": "float",
    "params": [
      numericVectorParam("x")
    ]
  },
  "periodogram": {
    "description": "Power spectrum of `x` at frequencies `k / n` for `k = 0..n/2`. Returns a Tensor of length `n/2 + 1`.",
    "kind": "numeric_timeseries",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      namedOptionalParam("detrend", "bool")
    ]
  },
  "convolve": {
    "description": "FFT-based linear convolution of two 1-D signals. `mode` is `\"full\"`, `\"same\"`, or `\"valid\"`.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("a"),
      numericVectorParam("b"),
      namedOptionalParam("mode", "string")
    ]
  },
  "correlate": {
    "description": "FFT-based cross-correlation of two 1-D signals. `mode` is `\"full\"`, `\"same\"`, or `\"valid\"`.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("a"),
      numericVectorParam("b"),
      namedOptionalParam("mode", "string")
    ]
  },
  "rolling_mean": {
    "description": "Rolling mean over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      param("window", "int")
    ]
  },
  "rolling_std": {
    "description": "Rolling standard deviation over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      param("window", "int"),
      namedOptionalParam("ddof", "int")
    ]
  },
  "rolling_sum": {
    "description": "Rolling sum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      param("window", "int")
    ]
  },
  "rolling_min": {
    "description": "Rolling minimum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      param("window", "int")
    ]
  },
  "rolling_max": {
    "description": "Rolling maximum over each length-`window` slice of `x`. Returns a Tensor of length `n - window + 1`.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      param("window", "int")
    ]
  },
  "polyfit": {
    "description": "Least-squares polynomial fit of degree `deg` to the points `(x, y)`. Returns coefficients ordered from the highest degree down.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("x"),
      numericVectorParam("y"),
      param("deg", "int")
    ]
  },
  "polyval": {
    "description": "Evaluate a polynomial with coefficients ordered from the highest degree down at `x` (an int, float, array, or Tensor).",
    "kind": "numeric_array_op",
    "returns": "NumericDistResult",
    "params": [
      numericVectorParam("coeffs"),
      param("x", "NumericElementInput | NumericArrayInput")
    ]
  },
  "polyroots": {
    "description": "All complex roots of a polynomial via Durand-Kerner iteration. Returns a `[deg, 2]` Tensor of real/imaginary pairs.",
    "kind": "numeric_array_op",
    "returns": "Tensor",
    "params": [
      numericVectorParam("coeffs")
    ]
  },
  "random_uniform": {
    "description": "Seeded uniform samples on `[low, high)` with the given shape.",
    "kind": "numeric_random",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      ...randomOptions()
    ]
  },
  "random_normal": {
    "description": "Seeded normal samples with mean `loc` and standard deviation `scale`.",
    "kind": "numeric_random",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      ...randomOptions()
    ]
  },
  "random_t": {
    "description": "Seeded Student t samples with `df` degrees of freedom.",
    "kind": "numeric_random",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      optionalParam("df", "float"),
      ...randomOptions()
    ]
  },
  "random_chi2": {
    "description": "Seeded chi-square samples with `df` degrees of freedom.",
    "kind": "numeric_random",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      optionalParam("df", "float"),
      ...randomOptions()
    ]
  },
  "random_exponential": {
    "description": "Seeded exponential samples with the given `scale` (mean).",
    "kind": "numeric_random",
    "returns": "Tensor",
    "params": [
      tensorShapeParam(),
      ...randomOptions()
    ]
  },
  "multivariate_normal": {
    "description": "Seeded multivariate normal samples via the Cholesky factor of `cov`. Returns an `[n, d]` Tensor.",
    "kind": "numeric_random",
    "returns": "Tensor",
    "params": [
      numericVectorParam("mean"),
      numericMatrixParam("cov"),
      optionalParam("n", "int"),
      ...tensorDataOptions(),
      ...intOption("seed")
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
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "unknown",
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
      "returns": "this",
      "isGetter": false,
      "description": "Set the module to training mode (enables Dropout, updates BatchNorm running stats)."
    },
    {
      "name": "eval",
      "params": [],
      "returns": "this",
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
      "returns": "this",
      "isGetter": false,
      "description": "Move the module's parameters to a device (`\"cpu\"`, `\"gpu\"`, `\"webgpu\"`) and return it."
    },
    {
      "name": "state_dict",
      "params": [],
      "returns": "Map",
      "isGetter": false,
      "description": "Return a map of parameter and buffer tensors."
    },
    {
      "name": "load_state_dict",
      "params": [
        param("state", "Map")
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Load parameter and buffer tensors from a state dictionary."
    },
    {
      "name": "zero_grad",
      "params": [],
      "returns": "this",
      "isGetter": false,
      "description": "Clear gradients on all parameters and return the module."
    }
  ],
  "sequential": [
    {
      "name": "forward",
      "params": [
        {
          "name": "x",
          "type": "Tensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "Tensor",
      "isGetter": false,
      "description": "Run inputs sequentially through each contained module."
    },
    {
      "name": "parameters",
      "params": [],
      "returns": "Tensor[]",
      "isGetter": false,
      "description": "Return parameters of all contained modules concatenated."
    },
    {
      "name": "train",
      "params": [],
      "returns": "this",
      "isGetter": false,
      "description": "Switch all submodules to training mode."
    },
    {
      "name": "eval",
      "params": [],
      "returns": "this",
      "isGetter": false,
      "description": "Switch all submodules to evaluation mode."
    },
    {
      "name": "state_dict",
      "params": [],
      "returns": "Map",
      "isGetter": false,
      "description": "Return a map of parameter and buffer tensors."
    },
    {
      "name": "load_state_dict",
      "params": [
        param("state", "Map")
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Load parameter and buffer tensors from a state dictionary."
    },
    {
      "name": "zero_grad",
      "params": [],
      "returns": "this",
      "isGetter": false,
      "description": "Clear gradients on all parameters and return the module."
    }
  ],
  "optimizer": [
    {
      "name": "step",
      "params": [],
      "returns": "undefined",
      "isGetter": false,
      "description": "Apply one optimizer update step using the current gradients."
    },
    {
      "name": "zero_grad",
      "params": [
        optionalParam("set_to_none", "bool")
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Zero out gradients of all tracked parameters before the next backward pass."
    },
    {
      "name": "param_groups",
      "params": [],
      "returns": "Object[]",
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
          "type": "float",
          "optional": true,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Advance the scheduler by one step. Some schedulers (`ReduceLROnPlateau`) require a monitored metric."
    },
    {
      "name": "get_last_lr",
      "params": [],
      "returns": "float[] | null",
      "isGetter": false,
      "description": "Return the most recently computed learning rate(s)."
    }
  ],
  "metric": [
    {
      "name": "forward",
      "params": [
        {
          "name": "preds",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "target",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "MetricResult",
      "isGetter": false,
      "description": "Update the metric and return its current value."
    },
    {
      "name": "update",
      "params": [
        {
          "name": "preds",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "target",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Update internal state with a new batch of predictions and ground-truth labels."
    },
    {
      "name": "compute",
      "params": [],
      "returns": "MetricResult",
      "isGetter": false,
      "description": "Compute the current metric value across all accumulated updates."
    },
    {
      "name": "reset",
      "params": [],
      "returns": "undefined",
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
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "model",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Hook fired at the start of training."
    },
    {
      "name": "on_train_end",
      "params": [
        {
          "name": "trainer",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "model",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Hook fired at the end of training."
    },
    {
      "name": "on_epoch_start",
      "params": [
        {
          "name": "trainer",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "model",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Hook fired at the start of each epoch."
    },
    {
      "name": "on_epoch_end",
      "params": [
        {
          "name": "trainer",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "model",
          "type": "unknown",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Hook fired at the end of each epoch."
    }
  ],
  "logger": [
    {
      "name": "log_metrics",
      "params": [
        {
          "name": "metrics",
          "type": "NumericMetricRecord",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "step",
          "type": "int",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Record numeric metric values at a step."
    },
    {
      "name": "log_hyperparams",
      "params": [
        param("params", "Object")
      ],
      "returns": "undefined",
      "isGetter": false,
      "description": "Record hyperparameters."
    },
    {
      "name": "finalize",
      "params": [],
      "returns": "undefined",
      "isGetter": false,
      "description": "Finalize and close logger resources."
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
      "returns": "undefined",
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
      "returns": "NumericMetricRecord",
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
      "returns": "NumericMetricRecord",
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
      "returns": "unknown[]",
      "isGetter": false,
      "description": "Run the model in eval mode and return collected outputs."
    }
  ],
  "ml_model": [
    {
      "name": "fit",
      "params": [
        {
          "name": "X",
          "type": "MLTensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "y",
          "type": "MLTensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "this",
      "isGetter": false,
      "description": "Fit the estimator to training features `X` and targets `y`. Returns the fitted model."
    },
    {
      "name": "predict",
      "params": [
        {
          "name": "X",
          "type": "MLTensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "MLTensor",
      "isGetter": false,
      "description": "Predict targets/labels for the rows of `X`."
    },
    {
      "name": "score",
      "params": [
        {
          "name": "X",
          "type": "MLTensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        },
        {
          "name": "y",
          "type": "MLTensor",
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
          "type": "MLTensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "this",
      "isGetter": false,
      "description": "Learn the transform parameters from `X`."
    },
    {
      "name": "transform",
      "params": [
        {
          "name": "X",
          "type": "MLTensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "MLTensor",
      "isGetter": false,
      "description": "Apply the learned transform to `X`."
    },
    {
      "name": "fit_transform",
      "params": [
        {
          "name": "X",
          "type": "MLTensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "MLTensor",
      "isGetter": false,
      "description": "Fit then transform `X` in one call."
    },
    {
      "name": "inverse_transform",
      "params": [
        {
          "name": "X",
          "type": "MLTensor",
          "optional": false,
          "rest": false,
          "defaultValue": null
        }
      ],
      "returns": "MLTensor",
      "isGetter": false,
      "description": "Map transformed data back to the original space (where supported)."
    }
  ]
} satisfies Record<string, TeraMethodSpec[]>;

export const TERA_PSEUDO_TYPES = {
  "ReactiveSignal": {
    "typeParams": ["T"],
    "methods": reactiveSignalMethods
  },
  "ReactiveComputed": {
    "typeParams": ["T"],
    "methods": reactiveComputedMethods
  },
  "ReactiveResource": {
    "typeParams": ["T"],
    "methods": reactiveResourceMethods
  },
  "Math": {
    "methods": [
      { "name": "abs", "params": [param("x", "float")], "returns": "float" },
      { "name": "floor", "params": [param("x", "float")], "returns": "int" },
      { "name": "ceil", "params": [param("x", "float")], "returns": "int" },
      { "name": "round", "params": [param("x", "float")], "returns": "int" },
      { "name": "trunc", "params": [param("x", "float")], "returns": "int" },
      { "name": "sign", "params": [param("x", "float")], "returns": "int" },
      { "name": "sqrt", "params": [param("x", "float")], "returns": "float" },
      { "name": "log", "params": [param("x", "float")], "returns": "float" },
      { "name": "exp", "params": [param("x", "float")], "returns": "float" },
      { "name": "sin", "params": [param("x", "float")], "returns": "float" },
      { "name": "cos", "params": [param("x", "float")], "returns": "float" },
      { "name": "pow", "params": [param("base", "float"), param("exponent", "float")], "returns": "float" },
      { "name": "min", "params": [param("values", "float", { rest: true })], "returns": "float" },
      { "name": "max", "params": [param("values", "float", { rest: true })], "returns": "float" },
      { "name": "random", "params": [], "returns": "float" },
      { "name": "PI", "params": [], "returns": "float", "isGetter": true },
      { "name": "E", "params": [], "returns": "float", "isGetter": true }
    ]
  },
  "JSON": {
    "methods": [
      { "name": "stringify", "params": [param("value", "any"), optionalParam("replacer", "any"), optionalParam("indent", "int")], "returns": "string" },
      { "name": "parse", "params": [param("text", "string"), optionalParam("reviver", "any")], "returns": "any" }
    ]
  },
  "Number": {
    "methods": [
      {
        "name": "to_string",
        "params": [
          {
            "name": "radix",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return the number rendered as a string with an optional radix."
      },
      {
        "name": "to_fixed",
        "params": [
          {
            "name": "digits",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return fixed-point decimal notation."
      },
      {
        "name": "to_precision",
        "params": [
          {
            "name": "precision",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return a string using the requested significant digits."
      },
      {
        "name": "to_exponential",
        "params": [
          {
            "name": "fraction_digits",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return exponential notation with optional fraction digits."
      },
      {
        "name": "value_of",
        "params": [],
        "returns": "this",
        "isGetter": false,
        "description": "Return the numeric primitive value."
      }
    ]
  },
  "Boolean": {
    "methods": [
      {
        "name": "to_string",
        "params": [],
        "returns": "string",
        "isGetter": false,
        "description": "Return `true` or `false` as text."
      },
      {
        "name": "value_of",
        "params": [],
        "returns": "this",
        "isGetter": false,
        "description": "Return the boolean primitive value."
      }
    ]
  },
  "Error": {
    "methods": [
      { "name": "message", "params": [], "returns": "string", "isGetter": true },
      { "name": "name", "params": [], "returns": "string", "isGetter": true },
      { "name": "to_string", "params": [], "returns": "string" }
    ]
  },
  "Promise": {
    "typeParams": ["T"],
    "methods": [
      { "name": "then", "typeParams": ["U"], "params": [param("on_fulfilled", "(T) -> U"), optionalParam("on_rejected", "(any) -> U")], "returns": "Promise<U>" },
      { "name": "catch", "typeParams": ["U"], "params": [param("on_rejected", "(any) -> U")], "returns": "Promise<T | U>" },
      { "name": "finally", "params": [param("on_finally", "() -> any")], "returns": "Promise<T>" }
    ]
  },
  "PromiseConstructor": {
    "methods": [
      { "name": "resolve", "typeParams": ["T"], "params": [optionalParam("value", "T")], "returns": "Promise<T>" },
      { "name": "reject", "params": [optionalParam("reason", "any")], "returns": "Promise<never>" },
      { "name": "all", "typeParams": ["T"], "params": [param("values", "Promise<T>[]")], "returns": "Promise<T[]>" },
      { "name": "all_settled", "typeParams": ["T"], "params": [param("values", "Promise<T>[]")], "returns": "Promise<T[]>" },
      { "name": "race", "typeParams": ["T"], "params": [param("values", "Promise<T>[]")], "returns": "Promise<T>" },
      { "name": "any", "typeParams": ["T"], "params": [param("values", "Promise<T>[]")], "returns": "Promise<T>" }
    ]
  },
  "ObjectConstructor": {
    "methods": [
      { "name": "keys", "params": [param("target", "Object")], "returns": "string[]" },
      { "name": "values", "params": [param("target", "Object")], "returns": "any[]" },
      { "name": "entries", "params": [param("target", "Object")], "returns": "[string, any][]" },
      { "name": "assign", "params": [param("target", "Object"), param("sources", "Object", { rest: true })], "returns": "Object" },
      { "name": "freeze", "params": [param("target", "Object")], "returns": "Object" },
      { "name": "is_frozen", "params": [param("target", "Object")], "returns": "bool" },
      { "name": "seal", "params": [param("target", "Object")], "returns": "Object" },
      { "name": "is_sealed", "params": [param("target", "Object")], "returns": "bool" }
    ]
  },
  "IndexTensor": {
    "methods": [
      {
        "name": "item",
        "params": [],
        "returns": "int",
        "isGetter": false,
        "description": "Return the scalar index value."
      }
    ]
  },
  "QuillProduct": {
    "methods": [
      {
        "name": "price",
        "description": "Price the checked product under the supplied market data. Returns `.price`, `.standard_error`, and a `.greeks` map.",
        "returns": "QuillPriceResult",
        "params": [
          param("rate", "float", { named: true }),
          namedOptionalParam("spot", "float"),
          namedOptionalParam("vol", "float"),
          namedOptionalParam("spots", "Object"),
          namedOptionalParam("vols", "Object"),
          namedOptionalParam("params", "Object"),
          namedOptionalParam("model_params", "Object"),
          namedOptionalParam("correlation", "float[][]"),
          namedOptionalParam("curve", "Object"),
          namedOptionalParam("paths", "int", 100000),
          namedOptionalParam("seed", "int", 1),
          namedOptionalParam("greeks", "string", "full")
        ]
      }
    ]
  },
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
        "name": "device",
        "params": [],
        "returns": "Device",
        "isGetter": true,
        "description": "Return the tensor's device."
      },
      {
        "name": "strides",
        "params": [],
        "returns": "int[]",
        "isGetter": true,
        "description": "Return the tensor strides."
      },
      {
        "name": "ndim",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Return the tensor rank."
      },
      {
        "name": "rank",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Return the tensor rank."
      },
      {
        "name": "numel",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Return the total number of elements."
      },
      {
        "name": "is_contiguous",
        "params": [],
        "returns": "bool",
        "isGetter": true,
        "description": "True when the tensor is stored contiguously."
      },
      {
        "name": "is_leaf",
        "params": [],
        "returns": "bool",
        "isGetter": true,
        "description": "True when the tensor is an autograd leaf."
      },
      {
        "name": "version",
        "params": [],
        "returns": "int",
        "isGetter": true,
        "description": "Return the tensor mutation version."
      },
      {
        "name": "reshape",
        "params": [
          {
            "name": "shape",
            "type": "int[]",
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
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "dim1",
            "type": "int",
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
            "type": "int[]",
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
            "type": "int[]",
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
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "start",
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "end",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "step",
            "type": "int",
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
            "type": "int",
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
            "type": "int",
            "optional": true,
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
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "start",
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "length",
            "type": "int",
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
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "index",
            "type": "int",
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
        "name": "retain_grad",
        "params": [],
        "returns": "Tensor",
        "isGetter": false,
        "description": "Retain gradients for a non-leaf tensor and return it."
      },
      {
        "name": "item",
        "params": [],
        "returns": "NumericScalar",
        "isGetter": false,
        "description": "Return the tensor scalar value."
      },
      {
        "name": "backward",
        "params": [
          {
            "name": "gradient",
            "type": "MLTensor",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "undefined",
        "isGetter": false,
        "description": "Propagate gradients backward from this tensor."
      },
      {
        "name": "requires_grad",
        "params": [
          {
            "name": "flag",
            "type": "bool",
            "optional": true,
            "rest": false,
            "defaultValue": "true"
          }
        ],
        "returns": "this",
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
      tensorMaterializeMethod("to_array"),
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "Tensor | int | float",
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
            "type": "MLTensor",
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
            "type": "MLTensor",
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
            "type": "int | int[]",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": "bool",
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
            "type": "int | int[]",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": "bool",
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
            "type": "int | int[]",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": "bool",
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
            "type": "int | int[]",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": "bool",
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
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": "bool",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "IndexTensor",
        "isGetter": false,
        "description": "Index of the maximum along `axis`; `keep` retains reduced dims."
      },
      {
        "name": "argmin",
        "params": [
          {
            "name": "axis",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": "bool",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "IndexTensor",
        "isGetter": false,
        "description": "Index of the minimum along `axis`; `keep` retains reduced dims."
      },
      {
        "name": "prod",
        "params": [
          {
            "name": "axis",
            "type": "int | int[]",
            "optional": true,
            "rest": false,
            "defaultValue": null
          },
          {
            "name": "keep",
            "type": "bool",
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
            "type": "int",
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
            "type": "int",
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
          param("args", "unknown", { optional: true, rest: true })
        ],
        "returns": "unknown",
        "isGetter": false,
        "description": "Run the model's forward block. Calling the model directly is equivalent."
      },
      {
        "name": "train",
        "params": [],
        "returns": "this",
        "isGetter": false,
        "description": "Set training mode."
      },
      {
        "name": "eval",
        "params": [],
        "returns": "this",
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
        "returns": "this",
        "isGetter": false,
        "description": "Move the model's parameters to a device (`\"cpu\"`, `\"gpu\"`, `\"webgpu\"`) and return it."
      },
      {
        "name": "state_dict",
        "params": [],
        "returns": "Map",
        "isGetter": false,
        "description": "Return a serializable object of parameter tensors."
      },
      {
        "name": "load_state_dict",
        "params": [
          {
            "name": "state",
            "type": "Map",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "undefined",
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
        "returns": "undefined",
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
        "returns": "string[]",
        "isGetter": false,
        "description": "Return the column names as an array of strings."
      },
      {
        "name": "schema",
        "params": [],
        "returns": "any",
        "isGetter": false,
        "description": "Return the frame's schema (fields with names and data types)."
      },
      {
        "name": "explain",
        "params": [],
        "returns": "string",
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
        "typeParams": ["T"],
        "returns": "T[]",
        "isGetter": false,
        "description": "Execute the plan and return all rows as an array of objects."
      },
      {
        "name": "to_array",
        "params": [],
        "typeParams": ["T"],
        "returns": "T[]",
        "isGetter": false,
        "description": "Alias for `collect`."
      },
      {
        "name": "count",
        "params": [],
        "returns": "int",
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
        "returns": "string",
        "isGetter": false,
        "description": "Execute and print the first `n` rows as a formatted table; returns the text."
      },
      {
        "name": "chunks",
        "params": [],
        "returns": "any",
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
        "returns": "MLTensor",
        "isGetter": false,
        "description": "Materialize the (optionally selected) numeric columns into a 2-D tensor of\nshape `[rows, columns]`. Non-numeric columns raise — encode them first."
      },
      {
        "name": "to_array",
        "params": [],
        "typeParams": ["T"],
        "returns": "T[]",
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
        "returns": "[Tensor, string[]]",
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
            "name": "target_type",
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
        "name": "concat",
        "params": [
          {
            "name": "pieces",
            "type": "string",
            "optional": true,
            "rest": true,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return this string with `pieces` appended to it."
      },
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
          },
          {
            "name": "limit",
            "type": "int",
            "optional": true,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string[]",
        "isGetter": false,
        "description": "Split the string on `sep`, keeping at most `limit` pieces."
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
        "name": "char_at",
        "params": [
          {
            "name": "index",
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "string",
        "isGetter": false,
        "description": "Return the character at `index` as a string, or the empty string when `index` is out of range."
      },
      {
        "name": "char_code_at",
        "params": [
          {
            "name": "index",
            "type": "int",
            "optional": false,
            "rest": false,
            "defaultValue": null
          }
        ],
        "returns": "int",
        "isGetter": false,
        "description": "Return the UTF-16 code unit at `index`."
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
        "name": "last_index_of",
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
        "description": "Return the index of the last occurrence of `sub`, or `-1` if absent."
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

export const TERA_GLOBAL_NAMESPACES = {
  "Math": "Math",
  "JSON": "JSON",
  "Object": "ObjectConstructor",
  "Promise": "PromiseConstructor"
} satisfies Record<string, string>;

export const TERA_CHART_METHODS = {
  "line": {
    "display": "chart.line(data, x?, y?, color?, title?, x_label?, y_label?, hline?, vline?, dash?, animate=false, frame?, key?, easing=\"cubic\", loop=false, speed=1, autoplay=false, zoom=true)",
    "description": "Draw a line chart for ordered values or trends. Use y=[...] for multiple series and color= to group DataFrame rows. Add a dashed reference line with hline=3.5 (horizontal) or vline=100 (vertical) — pass an int, float, or array, and label/color them with hline_label=\"μ = 3.5\", hline_color=\"#e06c75\". Use dash=true to dash every series. Pass animate=true to reveal the line left→right with Play/Pause, a scrubber, loop, and speed controls (honours reduced-motion). Pass frame=\"step\" to morph the curve between keyframes (one per distinct frame value), tweening vertices over time with a frame scrubber. Pace the motion with easing=\"linear\"|\"ease\"|\"ease-in-out\"|\"cubic\", repeat with loop=true, run faster/slower with speed=0.5|1|2|4, and auto-start with autoplay=true (otherwise the chart rests on its final frame as a static poster until you press Play, so exports and screenshots stay complete).",
    "kind": "method of chart",
    "returns": "ChartSpec",
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
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
    "effect": "async",
    "params": []
  }
} satisfies Record<string, TeraChartMethodSpec>;
