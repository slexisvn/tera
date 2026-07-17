import { getPayload } from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";

type CollectionReceiver = {
  hiddenClass: { instanceType: string };
} & Record<string, unknown>;

/**
 * Shared receiver-guard for collection prototype methods (Map/Set/WeakMap).
 * Unwraps the payload, verifies it carries the expected internal-data `field`
 * and matching `instanceType`, and returns that internal data. Otherwise throws
 * an incompatible-receiver TypeError labelled with `label`.
 */
export function getCollectionData<T>(
  thisValue: TaggedValue,
  field: string,
  instanceType: string,
  label: string,
): T {
  const obj = getPayload(thisValue);
  const receiver = obj as CollectionReceiver | null | undefined;
  const data = receiver ? receiver[field] : undefined;
  if (!receiver || !data || receiver.hiddenClass.instanceType !== instanceType)
    throw new Error(
      `TypeError: Method ${label}.prototype called on incompatible receiver`,
    );
  return data as T;
}
