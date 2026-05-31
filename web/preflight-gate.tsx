// 사전 점검 게이트 — pi/모델/session-lock 이 설치돼 있어야 pi-gui 가 동작한다.
// 시작 시 /api/preflight 를 호출해, 빠진 게 있으면 무엇을 설치해야 하는지 안내한다.
// 통과하면 children(=실제 앱)을 렌더한다.

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, XCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "./api";
import { useT, type I18nKey } from "./i18n";
import { waitForBackendPort } from "./config";

interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

// 체크별 안내 문구 키.
const CHECK_LABEL: Record<string, string> = {
  pi: "preflight.checkPi",
  models: "preflight.checkModels",
  "session-lock": "preflight.checkLock",
};

export function PreflightGate({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const [state, setState] = useState<"loading" | "ok" | "fail" | "error">("loading");
  const [checks, setChecks] = useState<Check[]>([]);

  const run = () => {
    setState("loading");
    // Tauri prod: 동적 포트가 주입될 때까지 기다렸다가 호출.
    waitForBackendPort().then(() =>
      api
        .preflight()
        .then((r) => {
          setChecks(r.checks);
          setState(r.ok ? "ok" : "fail");
        })
        .catch(() => setState("error")),
    );
  };

  useEffect(run, []);

  if (state === "ok") return <>{children}</>;

  if (state === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // error = 백엔드 자체에 연결 못 함. fail = 연결됐지만 빠진 게 있음.
  return (
    <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2.5">
          <AlertTriangle className="size-5 text-amber-500" />
          <h1 className="text-lg font-semibold">
            {state === "error" ? t("preflight.backendDown") : t("preflight.setupNeeded")}
          </h1>
        </div>

        {state === "error" ? (
          <p className="mb-4 text-sm text-muted-foreground">{t("preflight.backendDownDesc")}</p>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted-foreground">{t("preflight.setupNeededDesc")}</p>
            <div className="mb-5 flex flex-col gap-2">
              {checks.map((c) => (
                <div key={c.id} className="flex items-start gap-2.5 rounded-md border p-3">
                  {c.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{t((CHECK_LABEL[c.id] ?? "preflight.checkPi") as I18nKey)}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground" title={c.detail}>
                      {c.detail}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mb-4 text-xs text-muted-foreground">{t("preflight.installHint")}</p>
          </>
        )}

        <Button onClick={run} className="gap-1.5">
          <RefreshCw className="size-4" /> {t("preflight.recheck")}
        </Button>
      </div>
    </div>
  );
}
