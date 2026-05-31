// 세션 푸터 — TUI 의 ui-cosmetics footer 를 미러링한다.
//
// 한 줄: pwd (branch) • name   ···   ↑in ↓out Rcache Wcache $cost  ctx  ·  model • thinking
// 데이터는 /api/session/footer (런타임 없어도 파일에서 토큰/비용 집계).
// refreshKey 가 바뀌면(턴 종료 등) 다시 불러온다.

import { useEffect, useState } from "react";
import { api, type FooterData } from "./api";

function fmtTokens(n: number): string {
  // ui-cosmetics formatTokens 와 정확히 동일
  if (n < 1000) return `${n}`;
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function homeShort(p: string): string {
  // 브라우저라 HOME 을 모른다 — /Users/<x> 또는 /home/<x> 를 ~ 로.
  return p.replace(/^\/(Users|home)\/[^/]+/, "~");
}

export function Footer({ path, cwd, refreshKey }: { path: string; cwd?: string; refreshKey?: number }) {
  const [data, setData] = useState<FooterData | null>(null);

  useEffect(() => {
    let closed = false;
    api
      .footer(path, cwd)
      .then((d) => !closed && setData(d))
      .catch(() => undefined);
    return () => {
      closed = true;
    };
  }, [path, cwd, refreshKey]);

  if (!data) return null;

  // 좌측: pwd (branch) • name  (TUI 1번 줄)
  let pwd = "";
  if (data.cwd) {
    pwd = homeShort(data.cwd);
    if (data.branch) pwd += ` (${data.branch})`;
    if (data.name) pwd += ` • ${data.name}`;
  } else if (data.name) {
    pwd = data.name;
  }

  // stats (TUI 2번 줄 좌측): ↑in ↓out Rcache Wcache $cost  ctx/window
  const stats: string[] = [];
  const tk = data.tokens;
  if (tk.input) stats.push(`↑${fmtTokens(tk.input)}`);
  if (tk.output) stats.push(`↓${fmtTokens(tk.output)}`);
  if (tk.cacheRead) stats.push(`R${fmtTokens(tk.cacheRead)}`);
  if (tk.cacheWrite) stats.push(`W${fmtTokens(tk.cacheWrite)}`);
  if (data.cost) stats.push(`$${data.cost.toFixed(3)}`);
  if (data.contextUsage) {
    const u = data.contextUsage;
    stats.push(u.tokens === null ? `?/${fmtTokens(u.contextWindow)}` : `${fmtTokens(u.tokens)}/${fmtTokens(u.contextWindow)}`);
  }
  const statsLine = stats.join(" ");

  // 모델 • thinking (TUI 2번 줄 우측)
  let model = data.model?.id || "";
  if (model && data.supportsThinking) {
    model += data.thinkingLevel && data.thinkingLevel !== "off" ? ` • ${data.thinkingLevel}` : " • thinking off";
  }

  if (!pwd && !statsLine && !model) return null;

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t bg-background px-6 py-1.5 font-mono text-[11px] text-muted-foreground/70">
      {/* 1번 줄: pwd (branch) • name */}
      {pwd ? <div className="truncate">{pwd}</div> : null}
      {/* 2번 줄: stats ··· model • thinking (좌우 양끝 정렬, 좀으면 wrap) */}
      {statsLine || model ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
          <span className="break-all">{statsLine}</span>
          {model ? <span className="text-muted-foreground">{model}</span> : null}
        </div>
      ) : null}
      {/* 3번 줄: 런타임 소유 여부 */}
      <div>{data.live ? "owned" : "not-owned"}</div>
    </div>
  );
}
