export class VMError {
  type: string;
  name: string;
  message: string;
  stack?: string;

  constructor(type: string, message: string) {
    this.type = type;
    this.name = type;
    this.message = message;
    this.stack = new Error().stack;
  }

  toString() {
    return `${this.type}: ${this.message}`;
  }
}

export class VMTypeError extends VMError {
  constructor(message: string) {
    super("TypeError", message);
  }
}

export class VMReferenceError extends VMError {
  constructor(message: string) {
    super("ReferenceError", message);
  }
}

export class VMRangeError extends VMError {
  constructor(message: string) {
    super("RangeError", message);
  }
}

export class VMSyntaxError extends VMError {
  constructor(message: string) {
    super("SyntaxError", message);
  }
}

export function isVMError(err: object | string | number | boolean | symbol | null | undefined): err is VMError {
  return err instanceof VMError;
}

export function vmErrorToTagged(
  err: VMError,
  mkString: (value: string) => TaggedValue,
  mkObject: (value: JSObject) => TaggedValue,
  createJSObject: () => JSObject,
  mkBool?: (value: boolean) => TaggedValue,
  mkFunction?: (value: RuntimeFunctionPayload) => TaggedValue,
) {
  const obj = createJSObject();
  obj.setProperty("name", mkString(err.name));
  obj.setProperty("message", mkString(err.message));
  obj.setProperty("stack", mkString(err.stack || ""));
  if (mkBool) obj.setProperty("__isError__", mkBool(true));
  if (mkFunction)
    obj.setProperty(
      "constructor",
      mkFunction({ name: err.name, properties: {} }),
    );
  return mkObject(obj);
}
import type { RuntimeFunctionPayload, TaggedValue } from "../value/index.js";
import type { JSObject } from "../../objects/heap/js-object.js";
