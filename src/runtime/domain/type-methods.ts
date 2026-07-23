export type TypeMethod = {
  returns: string;
  getter?: boolean;
};

export type TypeMethodTable = Record<string, Record<string, TypeMethod>>;

function returning(returns: string, names: readonly string[]): Record<string, TypeMethod> {
  return Object.fromEntries(names.map((name) => [name, { returns }]));
}

const TENSOR_ELEMENTWISE = [
  "neg", "exp", "log", "sqrt", "rsqrt", "abs", "sin", "cos", "tanh", "sigmoid",
  "relu", "gelu", "silu", "sign", "floor", "ceil", "clone",
] as const;

const TENSOR_BINARY = [
  "add", "sub", "mul", "div", "pow", "remainder", "maximum", "minimum",
  "eq", "ne", "lt", "le", "gt", "ge", "matmul", "dot",
] as const;

const TENSOR_SHAPE = [
  "reshape", "transpose", "permute", "expand", "slice", "unsqueeze", "squeeze",
  "narrow", "select", "contiguous",
] as const;

const TENSOR_REDUCTION = ["sum", "mean", "max", "min", "argmax", "argmin", "prod", "softmax", "log_softmax"] as const;

const TENSOR_AUTOGRAD = ["detach", "backward", "requires_grad"] as const;

const DATAFRAME_TRANSFORMS = [
  "select", "filter", "where", "with_column", "drop", "order_by", "sort", "limit",
  "head", "distinct", "union", "union_all", "join", "encode",
] as const;

const COLUMN_OPS = [
  "alias", "as", "add", "sub", "mul", "div", "eq", "ne", "lt", "le", "gt", "ge",
  "and", "or", "not", "is_null", "is_not_null", "like", "between", "isin", "cast",
] as const;

export const TYPE_METHODS: TypeMethodTable = {
  Tensor: {
    ...returning("Tensor", [...TENSOR_ELEMENTWISE, ...TENSOR_BINARY, ...TENSOR_SHAPE, ...TENSOR_REDUCTION, ...TENSOR_AUTOGRAD]),
    shape: { returns: "int[]", getter: true },
    dtype: { returns: "string", getter: true },
    grad: { returns: "Tensor", getter: true },
    length: { returns: "int", getter: true },
  },
  Model: {
    parameters: { returns: "Tensor[]" },
    forward: { returns: "Tensor" },
    validate: { returns: "Tensor" },
    optimizer: { returns: "Object" },
    ...returning("Model", ["train", "eval", "to", "load_state_dict"]),
    state_dict: { returns: "Object" },
    save: { returns: "undefined" },
    is_training: { returns: "bool", getter: true },
  },
  DataFrame: {
    ...returning("DataFrame", DATAFRAME_TRANSFORMS),
    group_by: { returns: "GroupedData" },
    collect: { returns: "Array" },
    to_array: { returns: "Array" },
    chunks: { returns: "Array" },
    to_tensor: { returns: "Tensor" },
    count: { returns: "int" },
    explain: { returns: "string" },
    show: { returns: "undefined" },
    columns: { returns: "string[]", getter: true },
    schema: { returns: "Object", getter: true },
  },
  GroupedData: {
    agg: { returns: "DataFrame" },
  },
  Column: returning("Column", COLUMN_OPS),
  List: {
    ...returning("List", ["splice", "slice", "concat", "reverse", "sort", "map", "filter", "flat_map"]),
    push: { returns: "int" },
    unshift: { returns: "int" },
    index_of: { returns: "int" },
    last_index_of: { returns: "int" },
    find_index: { returns: "int" },
    includes: { returns: "bool" },
    join: { returns: "string" },
    for_each: { returns: "undefined" },
    pop: { returns: "any" },
    shift: { returns: "any" },
    reduce: { returns: "any" },
    find: { returns: "any" },
    length: { returns: "int", getter: true },
  },
  String: {
    ...returning("string", ["to_upper_case", "to_lower_case", "trim", "trim_start", "trim_end", "replace", "replace_all", "slice", "repeat", "pad_start", "pad_end"]),
    split: { returns: "string[]" },
    starts_with: { returns: "bool" },
    ends_with: { returns: "bool" },
    includes: { returns: "bool" },
    index_of: { returns: "int" },
    length: { returns: "int", getter: true },
  },
  Map: {
    set: { returns: "Map" },
    get: { returns: "any" },
    has: { returns: "bool" },
    delete: { returns: "bool" },
    ...returning("Array", ["keys", "values", "entries"]),
    clear: { returns: "undefined" },
    size: { returns: "int", getter: true },
  },
};
