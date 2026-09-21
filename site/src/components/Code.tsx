import Prism from 'prismjs';
import { CodeTooltip } from './CodeTooltip';
import { stagger } from '../motion';

const grammar: Prism.Grammar = {
  string: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/,
  keyword: /\b(?:fn|model|return|for|in|of|if|else|class|interface|async|await|import|from|throw|try|catch|forward|train|optimizer)\b/,
  boolean: /\b(?:true|false|null)\b/,
  'class-name': /\b(?:int|float|string|bool|Tensor|DataFrame|Sequential|Linear|ReLU|IrisNet)\b/,
  function: /\b[a-zA-Z_]\w*(?=\()/,
  number: /\b\d+(?:\.\d+)?\b/,
  operator: /[-+*/=@<>]+/,
  punctuation: /[()[\]{},.:]/,
};

type CodeProps = { value: string; numbered?: boolean; annotations?: Record<string, string>; animated?: boolean };

function Tokens({ tokens, annotations }: { tokens: Prism.TokenStream; annotations?: CodeProps['annotations'] }) {
  if (typeof tokens === 'string') return tokens;
  if (Array.isArray(tokens)) return tokens.map((token, index) => <Tokens key={index} tokens={token} annotations={annotations} />);
  const annotation = tokens.type === 'function' && typeof tokens.content === 'string' ? annotations?.[tokens.content] : undefined;
  return <span className={`token ${tokens.type}`}>
    {annotation ? <CodeTooltip content={annotation}>{tokens.content as string}</CodeTooltip> : <Tokens tokens={tokens.content} annotations={annotations} />}
  </span>;
}

export function Code({ value, numbered = false, annotations, animated = false }: CodeProps) {
  return <pre className={`code${numbered ? ' code-numbered' : ''}${animated ? ' code-animated' : ''}`}><code>
    {value.split('\n').map((line, index) => <span className="code-line" key={index} style={animated ? stagger(index) : undefined}>
      {numbered && <span className="line-number" aria-hidden="true">{index + 1}</span>}
      <span><Tokens tokens={Prism.tokenize(line || ' ', grammar)} annotations={annotations} /></span>
    </span>)}
  </code></pre>;
}
