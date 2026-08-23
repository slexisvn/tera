import { ByteBuffer } from "./buffer.js";
import { paddingFor, type McFragment } from "./fragment.js";

export type SectionKind = "text" | "rodata" | "data" | "bss" | "debug";

export interface SectionPermissions {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
}

const PERMISSIONS: Record<SectionKind, SectionPermissions> = {
  text: { read: true, write: false, execute: true },
  rodata: { read: true, write: false, execute: false },
  data: { read: true, write: true, execute: false },
  bss: { read: true, write: true, execute: false },
  debug: { read: true, write: false, execute: false },
};

export function isLoadable(section: McSection): boolean {
  return section.kind !== "debug";
}

export type PaddingProvider = (byteCount: number) => readonly number[];

export const zeroPadding: PaddingProvider = (byteCount) =>
  new Array<number>(byteCount).fill(0);

export class McSection {
  readonly fragments: McFragment[] = [];
  address = 0;
  padding: PaddingProvider = zeroPadding;

  constructor(
    readonly name: string,
    readonly kind: SectionKind,
    public alignment: number,
  ) {}

  get permissions(): SectionPermissions {
    return PERMISSIONS[this.kind];
  }

  get size(): number {
    const last = this.fragments[this.fragments.length - 1];
    if (last === undefined) return 0;
    return last.address + last.size - this.address;
  }

  add<T extends McFragment>(fragment: T): T {
    this.fragments.push(fragment);
    return fragment;
  }

  require(alignment: number): void {
    if (alignment > this.alignment) this.alignment = alignment;
  }

  contents(): Uint8Array {
    const buffer = new ByteBuffer(Math.max(this.size, 1));
    for (const fragment of this.fragments) {
      if (fragment.kind === "align") {
        buffer.bytes(this.padding(fragment.size));
        continue;
      }
      buffer.bytes(fragment.bytes);
    }
    return buffer.toBytes();
  }
}

export function fragmentOwners(
  sections: readonly McSection[],
): ReadonlyMap<McFragment, McSection> {
  const owners = new Map<McFragment, McSection>();
  for (const section of sections) {
    for (const fragment of section.fragments) owners.set(fragment, section);
  }
  return owners;
}

export function assignFragmentAddresses(section: McSection, base: number): number {
  let cursor = base + paddingFor(base, section.alignment);
  section.address = cursor;
  for (const fragment of section.fragments) {
    if (fragment.kind === "align") {
      fragment.size = paddingFor(cursor, fragment.alignment);
    }
    fragment.address = cursor;
    cursor += fragment.size;
  }
  return cursor;
}
