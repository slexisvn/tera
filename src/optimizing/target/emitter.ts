import type { BackendArtifact } from "./artifact.js";

export interface Emitter {
  emit(): BackendArtifact;
}
