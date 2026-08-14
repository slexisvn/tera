import type { TaggedValue } from "../core/value/index.js";

type ExternalRootProvider = (visit: (value: TaggedValue) => void) => void;

const providers = new Set<ExternalRootProvider>();

export function registerExternalRootProvider(
  provider: ExternalRootProvider,
): void {
  providers.add(provider);
}

export function visitExternalRoots(visit: (value: TaggedValue) => void): void {
  for (const provider of providers) provider(visit);
}
