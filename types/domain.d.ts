type RuntimePrimitive = string | number | boolean | symbol | null | undefined;

type RuntimeValue =
  | RuntimePrimitive
  | RuntimeRecord
  | RuntimeCallable
  | RuntimeValue[];

interface RuntimeRecord {
  [key: string]: RuntimeValue;
  [key: number]: RuntimeValue;
}

interface RuntimeCallable extends RuntimeRecord {
  (...args: RuntimeValue[]): RuntimeValue;
  new (...args: RuntimeValue[]): RuntimeValue;
}
