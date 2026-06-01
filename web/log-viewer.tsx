// 백엔드 로그 뷰어 — View 메뉴 또는 디버그 버튼에서 열어 최근 로그를 확인.
// /api/log 에서 최근 500줄을 읽어 모노스페이스로 표시 + 클립보드 복사.

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, RefreshCw } from "lucide-react";
import { apiUrl } from "./config";

export function LogViewer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchLog = useCallback(() => {
    setLoading(true);
    fetch(apiUrl("/api/log"))
      .then((r) => r.json())
      .then((d) => setLines(d.lines ?? []))
      .catch(() => setLines(["(failed to fetch log)"]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open) fetchLog();
  }, [open, fetchLog]);

  const copy = () => {
    navigator.clipboard.writeText(lines.join("\n")).catch(() => undefined);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle>Backend Log</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
            {lines.length ? lines.join("\n") : "(empty)"}
          </pre>
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-2">
          <Button variant="outline" size="sm" onClick={fetchLog} disabled={loading}>
            <RefreshCw className={`mr-1.5 size-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={copy}>
            <Copy className="mr-1.5 size-3.5" /> Copy
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
