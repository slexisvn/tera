import { getPayload } from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";

type CollectionReceiver = {
  hiddenClass: { instanceType: string };
} & Record<string, unknown>;

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
