// Markdown render — builds the unified pipeline directly.
//
//   remark-parse    : markdown (text) → mdast
//   remark-gfm      : GFM extensions (tables/checkboxes/strikethrough/autolinks)
//   remark-rehype   : mdast → hast (HTML AST)
//   rehype-sanitize : AI output, so strip dangerous nodes/attributes (XSS defense)
//   rehype-highlight: tokenize fenced code into <span class="hljs-*"> for theming
//   rehype-react    : hast → React elements
//
// AI responses are untrusted input, so the sanitize step is mandatory. Highlight
// runs *after* sanitize so the spans it injects are not stripped; the default
// sanitize schema already permits `language-*` classes on <code>, so the fence
// language survives sanitize and rehype-highlight can pick it up.

import { Check, Copy } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import rehypeHighlight from 'rehype-highlight';
import rehypeReact from 'rehype-react';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { useT } from './i18n';

// Links open in a new tab + safe rel, and long URLs break so they don't break layout.
function MdLink({ href, children, ...rest }: React.ComponentProps<'a'>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="break-all"
      {...rest}
    >
      {children}
    </a>
  );
}

// Fenced code block with a hover copy button. Inline `code` stays a plain <code>
// (remark only emits <pre><code> for fences), so this wraps the <pre> level.
function CodeBlock({ children, ...rest }: React.ComponentProps<'pre'>) {
  const { t } = useT();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = preRef.current?.textContent ?? '';
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div className="piweb-codeblock">
      <button
        type="button"
        className="piweb-codeblock-copy"
        onClick={copy}
        aria-label={copied ? t('code.copied') : t('code.copy')}
        title={copied ? t('code.copied') : t('code.copy')}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
    </div>
  );
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  // detect: highlight fences with no language by auto-detecting; ignoreMissing:
  // don't throw when a declared language isn't registered.
  .use(rehypeHighlight, { detect: true, ignoreMissing: true })
  .use(rehypeReact, { Fragment, jsx, jsxs, components: { a: MdLink, pre: CodeBlock } });

export function Markdown({ text }: { text: string }) {
  const content = useMemo(() => {
    try {
      return processor.processSync(text).result as React.ReactNode;
    } catch {
      // Plain-text fallback on parse failure
      return text;
    }
  }, [text]);

  return <div className="piweb-md">{content}</div>;
}
