// 마크다운 렌더 — unified 파이프라인을 직접 구성한다.
//
//   remark-parse   : markdown(텍스트) → mdast
//   remark-gfm     : GFM 확장 (표/체크박스/취소선/자동링크)
//   remark-rehype  : mdast → hast (HTML AST)
//   rehype-sanitize: AI 출력이므로 위험 노드/속성 제거 (XSS 방어)
//   rehype-react   : hast → React 엘리먼트
//
// AI 응답은 신뢰 불가 입력이라 sanitize 단계가 필수다.

import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useMemo } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeReact from "rehype-react";

// 링크는 새 탭 + 안전 rel 로 열고, 긴 URL 은 레이아웃을 깨지 않게 break.
function MdLink({ href, children, ...rest }: React.ComponentProps<"a">) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all" {...rest}>
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
      // 파싱 실패 시 평문 폴백
      return text;
    }
  }, [text]);

  return <div className="piweb-md">{content}</div>;
}
