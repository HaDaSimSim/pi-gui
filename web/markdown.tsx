// Markdown render — builds the unified pipeline directly.
//
//   remark-parse   : markdown (text) → mdast
//   remark-gfm     : GFM extensions (tables/checkboxes/strikethrough/autolinks)
//   remark-rehype  : mdast → hast (HTML AST)
//   rehype-sanitize: AI output, so strip dangerous nodes/attributes (XSS defense)
//   rehype-react   : hast → React elements
//
// AI responses are untrusted input, so the sanitize step is mandatory.

import { useMemo } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import rehypeReact from 'rehype-react';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

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

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeReact, { Fragment, jsx, jsxs, components: { a: MdLink } });

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
