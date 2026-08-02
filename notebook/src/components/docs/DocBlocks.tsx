import type { Block } from "../../docs/guide-content";
import { CodeBlock } from "./CodeBlock";
import { renderInline } from "./inline";

function DocBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      return <h3 className="doc-subheading">{block.text}</h3>;
    case "text":
      return <p className="doc-text">{renderInline(block.text)}</p>;
    case "note":
      return <div className="doc-note">{renderInline(block.text)}</div>;
    case "list":
      return (
        <ul className="doc-list">
          {block.items.map((item, index) => <li key={index}>{renderInline(item)}</li>)}
        </ul>
      );
    case "code":
      return <CodeBlock code={block.code} />;
  }
}

export function DocBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index) => <DocBlock key={index} block={block} />)}
    </>
  );
}
