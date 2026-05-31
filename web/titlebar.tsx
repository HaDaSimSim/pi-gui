// Tauri 커스텀 타이틀바.
//
// macOS 기본 타이틀바(titleBarStyle: Overlay + hiddenTitle) 대신,
// 직접 그린 얇은 바에 "π - 세션이름 - 디렉터리" 를 가운데 띄운다.
// 전체가 드래그 영역(data-tauri-drag-region)이라 창 이동이 된다.
// 왼쪽은 신호등 버튼 자리라 비워둔다(pl-[78px]).

export function Titlebar({ name, dir }: { name: string; dir?: string }) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center border-b border-sidebar-border bg-sidebar pl-[78px] pr-3"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        <span className="font-mono font-semibold text-foreground/80">π</span>
        {name ? (
          <>
            <span className="text-muted-foreground/40">-</span>
            <span className="max-w-[40%] truncate text-foreground/70">{name}</span>
          </>
        ) : null}
        {dir ? (
          <>
            <span className="text-muted-foreground/40">-</span>
            <span className="max-w-[30%] truncate">{dir}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
