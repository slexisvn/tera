export type KeywordGroup =
  | "declaration"
  | "control"
  | "operator"
  | "constant"
  | "variable";

export type Param = {
  name: string;
  type?: string | null;
  defaultValue?: string | null;
  optional?: boolean;
  rest?: boolean;
};

export type Signature = {
  params: Param[];
  display: string;
};

export type Method = {
  name: string;
  description: string | null;
  returns: string | null;
  effect: string;
  isGetter: boolean;
  signature: Signature;
};

export type Builtin = {
  name: string;
  kind: string;
  description: string | null;
  returns: string | null;
  effect: string;
  signature: Signature | null;
  methods: Method[];
};

export type Operators = {
  threeChar: string[];
  twoChar: string[];
  oneChar: string[];
};

export type LanguageData = {
  version: number;
  keywords: string[];
  keywordGroups: Record<KeywordGroup, string[]>;
  types: string[];
  operators: Operators;
  pseudoTypes: Record<string, Method[]>;
  builtins: Builtin[];
};

export type PseudoTypeSource = Record<
  string,
  {
    methods: Array<{
      name: string;
      description?: string;
      returns?: string;
      effect?: string;
      isGetter?: boolean;
      params: Param[];
    }>;
  }
>;
