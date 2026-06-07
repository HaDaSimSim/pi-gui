// Extension UI bridge — renders ctx.ui.confirm/select/input/editor/btw inline in
// the composer slot (like the TUI, the prompt appears in place of the input),
// not as a modal. Rendering inline means a request on an inactive tab stays
// hidden with its tab (no portal popping over another session) until the user
// switches to it; the result goes back to the backend via onRespond().

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useT } from './i18n';
import { Markdown } from './markdown';
import type { UiRequest } from './use-session';

export function UiRequestDialog({
  request,
  onRespond,
}: {
  request: UiRequest;
  onRespond: (id: string, value: unknown) => void;
}) {
  const { t } = useT();
  const [text, setText] = useState(request.placeholder ?? '');

  // Reset input when the request changes.
  useEffect(() => {
    setText(request.kind === 'editor' ? (request.placeholder ?? '') : '');
  }, [request.kind, request.placeholder]);

  // Cancel with confirm: false, select/input/editor: undefined.
  const cancel = () => onRespond(request.id, request.kind === 'confirm' ? false : undefined);

  return (
    <div className="rounded-md border bg-muted/30 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        {request.kind === 'btw' ? (
          <span className="text-accent-foreground">💬 by the way</span>
        ) : (
          <span>{request.title}</span>
        )}
      </div>
      {request.kind === 'btw' ? (
        <div className="mb-2">
          <div className="mb-1 text-sm text-muted-foreground">{request.title}</div>
          <div className="max-h-[50vh] overflow-y-auto">
            <Markdown text={request.answer ?? ''} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            this is not saved to the conversation
          </p>
        </div>
      ) : request.message ? (
        <div className="mb-2 text-sm text-muted-foreground">{request.message}</div>
      ) : null}

      {request.kind === 'select' ? (
        <div className="flex flex-col gap-1.5">
          {(request.options ?? []).map((opt) => (
            <Button
              type="button"
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

      {request.kind === 'input' ? (
        <Input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) onRespond(request.id, text);
          }}
        />
      ) : null}

      {request.kind === 'editor' ? (
        <Textarea
          autoFocus
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="resize-none font-mono text-sm"
        />
      ) : null}

      <div className="mt-3 flex justify-end gap-2">
        {request.kind === 'confirm' ? (
          <>
            <Button type="button" variant="outline" onClick={() => onRespond(request.id, false)}>
              {t('uireq.no')}
            </Button>
            <Button type="button" onClick={() => onRespond(request.id, true)}>
              {t('uireq.yes')}
            </Button>
          </>
        ) : request.kind === 'btw' ? (
          <Button type="button" onClick={() => onRespond(request.id, undefined)}>
            {t('uireq.close')}
          </Button>
        ) : request.kind === 'input' || request.kind === 'editor' ? (
          <>
            <Button type="button" variant="outline" onClick={cancel}>
              {t('uireq.cancel')}
            </Button>
            <Button type="button" onClick={() => onRespond(request.id, text)}>
              {t('uireq.ok')}
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" onClick={cancel}>
            {t('uireq.cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
