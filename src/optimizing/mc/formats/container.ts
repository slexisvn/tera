import type { McModule } from "../module.js";
import type { McTarget } from "../target.js";

export interface McObjectWriter {
  readonly extension: string;
  readonly carriesDebug: boolean;
  image(module: McModule, target: McTarget): Uint8Array;
}

export interface McExecutableWriter {
  readonly extension: string;
  readonly carriesDebug: boolean;
  image(module: McModule, target: McTarget, entrySymbol: string): Uint8Array;
}
