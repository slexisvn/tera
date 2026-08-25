import { memo } from "react";
import { highlightIr } from "@tera/editor";

export const IrLine = memo(function IrLine({ text }: { text: string }) {
  return (
    <>
      {highlightIr(text).map((token, at) =>
        token.cls === "" ? token.text : (
          <span className={token.cls} key={at}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
});
