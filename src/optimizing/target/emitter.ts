import type { EmittedFunction } from "./artifact.js";

export interface Emitter {
  emit(): EmittedFunction;
}
