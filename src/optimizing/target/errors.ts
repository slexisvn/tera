export class BackendLoweringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendLoweringError";
  }
}

export function isBackendLoweringError(error: unknown): error is BackendLoweringError {
  return error instanceof BackendLoweringError;
}
