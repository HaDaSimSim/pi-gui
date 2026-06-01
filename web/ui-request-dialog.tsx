// extension UI 브릿지 다이얼로그 — ctx.ui.confirm/select/input/editor 를
// shadcn 다이얼로그로 렌더하고 결과를 respond() 로 백엔드에 돌려준다.

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "./markdown";
import type { UiRequest } from "./use-session";

export function UiRequestDialog({
  request,
  onRespond,
}: {
  request: UiRequest;
  onRespond: (id: string, value: unknown) => void;
}) {
  const [text, setText] = useState(request.placeholder ?? "");

  // 요청이 바뀌면 입력값 초기화.
  useEffect(() => {
    setText(request.kind === "editor" ? (request.placeholder ?? "") : "");
  }, [request.id, request.kind, request.placeholder]);

  // confirm: false, select/input/editor: undefined 로 취소.
  const cancel = () => onRespond(request.id, request.kind === "confirm" ? false : undefined);

  return (
    <Dialog open onOpenChange={(o) => !o && cancel()}>
      <DialogContent className={request.kind === "btw" ? "sm:max-w-2xl" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {request.kind === "btw" ? <span className="text-accent-foreground">💬 by the way</span> : request.title}
          </DialogTitle>
          {request.kind === "btw" ? (
            <DialogDescription>{request.title}</DialogDescription>
          ) : request.message ? (
            <DialogDescription>{request.message}</DialogDescription>
          ) : null}
        </DialogHeader>

        {request.kind === "btw" ? (
          <div className="max-h-[60vh] overflow-y-auto">
            <Markdown text={request.answer ?? ""} />
            <p className="mt-3 text-xs text-muted-foreground">this is not saved to the conversation</p>
          </div>
        ) : null}

        {request.kind === "select" ? (
          <div className="flex flex-col gap-1.5">
            {(request.options ?? []).map((opt) => (
              <Button
                key={opt}
                variant="outline"
                className="justify-start"
                onClick={() => onRespond(request.id, opt)}
              >
                {opt}
              </Button>
            ))}
          </div>
        ) : null}

        {request.kind === "input" ? (
          <Input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) onRespond(request.id, text);
            }}
          />
        ) : null}

        {request.kind === "editor" ? (
          <Textarea
            autoFocus
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="resize-none font-mono text-sm"
          />
        ) : null}

        <DialogFooter>
          {request.kind === "confirm" ? (
            <>
              <Button variant="outline" onClick={() => onRespond(request.id, false)}>
                No
              </Button>
              <Button onClick={() => onRespond(request.id, true)}>Yes</Button>
            </>
          ) : request.kind === "btw" ? (
            <Button onClick={() => onRespond(request.id, undefined)}>Close</Button>
          ) : request.kind === "input" || request.kind === "editor" ? (
            <>
              <Button variant="outline" onClick={cancel}>
                Cancel
              </Button>
              <Button onClick={() => onRespond(request.id, text)}>OK</Button>
            </>
          ) : (
            <Button variant="outline" onClick={cancel}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
