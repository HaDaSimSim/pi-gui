// Tauri custom titlebar.
//
// Instead of the default macOS titlebar (titleBarStyle: Overlay + hiddenTitle),
// a hand-drawn thin bar centers "π - session name - directory".
// The whole thing is a drag region (data-tauri-drag-region) so the window can be moved.
// The left is left empty for the traffic-light buttons (pl-[78px]).

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
