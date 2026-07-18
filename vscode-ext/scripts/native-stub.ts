const message = "mlfw: native GPU backend (CUDA/WebGPU) is disabled in the VSCode notebook kernel; it runs CPU/WASM only";

function fail(): never {
  throw new Error(message);
}

export const create = fail;
export const load = fail;
export const globals = undefined;
export default new Proxy({}, { get: fail, apply: fail });
