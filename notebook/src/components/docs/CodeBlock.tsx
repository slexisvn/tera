import { useState } from "react";
import { highlightHtml } from "@/utils/highlight";

type CodeBlockProps = {
  code: string;
};

export function CodeBlock({ code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="doc-code">
      <button className="doc-code-copy" type="button" onClick={copy} title="Copy to clipboard">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="doc-code-pre">
        <code dangerouslySetInnerHTML={{ __html: highlightHtml(code) }} />
      </pre>
    </div>
  );
}
