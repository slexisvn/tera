import type { OptLevelId } from "../types/stage";

const OPT_LEVELS: readonly OptLevelId[] = ["none", "baseline", "speed", "max"];

export type ShareOutcome = {
  readonly link: string;
  readonly copied: boolean;
};

export type Shared = {
  readonly source: string;
  readonly target: string | null;
  readonly optLevel: OptLevelId | null;
};

export function encodeSource(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeSource(text: string): string | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function readShare(hash: string): Shared | null {
  const query = hash.startsWith("#") ? hash.slice(1) : hash;
  if (query === "") return null;
  const fields = new URLSearchParams(query);
  const encoded = fields.get("src");
  if (encoded === null) return null;
  const source = decodeSource(encoded);
  if (source === null) return null;
  const level = fields.get("opt");
  return {
    source,
    target: fields.get("target"),
    optLevel: OPT_LEVELS.find((entry) => entry === level) ?? null,
  };
}

export function shareHash(shared: Shared): string {
  const fields = new URLSearchParams();
  fields.set("src", encodeSource(shared.source));
  if (shared.target !== null) fields.set("target", shared.target);
  if (shared.optLevel !== null) fields.set("opt", shared.optLevel);
  return `#${fields.toString()}`;
}
