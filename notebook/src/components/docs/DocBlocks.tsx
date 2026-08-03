import type { Block } from "../../docs/guide-content";
import { CodeBlock } from "./CodeBlock";
import { renderInline } from "./inline";

function ApiSignature({ signature }: { signature: string }) {
  const match = signature.match(/^[^\s(]+/);
  const name = match ? match[0] : signature;
  const rest = signature.slice(name.length);
  return (
    <div className="doc-api-sig">
      <span className="doc-api-name">{name}</span>
      {rest}
    </div>
  );
}

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
    case "api":
      return (
        <div className="doc-api">
          <ApiSignature signature={block.signature} />
          <p className="doc-api-desc">{renderInline(block.text)}</p>
          {block.code ? <CodeBlock code={block.code} /> : null}
        </div>
      );
  }
}

export function DocBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index) => <DocBlock key={index} block={block} />)}
    </>
  );
}
