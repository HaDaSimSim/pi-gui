// UI 설정 스토어 — localStorage 에 저장하고 document 에 반영한다.
//
// 브라우저에서 끝나는 설정들: 언어(en/ko), 테마(light/dark/true-dark),
// 밀도(comfortable/compact), 모션, 폰트(sans/mono). 어디서든 useUiSettings()
// 로 읽고 바꾼다.
//
// 테마는 Tailwind 의 .dark 클래스 기반 (true-dark 는 .dark.true-dark).
// 밀도는 data-density 속성으로 두고 CSS 가 간격을 조절할 여지를 남긴다.

import { useCallback, useEffect, useState } from "react";
import type { Lang } from "./i18n";

export type ThemeMode = "light" | "dark" | "true-dark";
export type Density = "comfortable" | "compact";

export interface UiSettings {
  lang: Lang; // "en" | "ko"
  theme: ThemeMode; // light | dark | true-dark
  density: Density;
  motionDisabled: boolean;
  fontSans: string; // 본문 폰트 (CSS font-family 값)
  fontMono: string; // 모노스페이스 폰트
}

const STORAGE_KEY = "pi-web.ui-settings";

// 기본 폰트 체인 (globals.css 의 변수 기본값과 일치).
const DEFAULT_FONT_SANS =
  '"Pretendard GOV", "Pretendard", system-ui, -apple-system, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
const DEFAULT_FONT_MONO =
  '"BlexMono Nerd Font", "IBM Plex Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// 브라우저 언어가 한국어면 기본을 ko 로.
function detectLang(): Lang {
  try {
    return navigator.language?.toLowerCase().startsWith("ko") ? "ko" : "en";
  } catch {
    return "en";
  }
}

const VALID_THEMES: ThemeMode[] = ["light", "dark", "true-dark"];

const DEFAULTS: UiSettings = {
  lang: detectLang(),
  theme: "light",
  density: "comfortable",
  motionDisabled: false,
  fontSans: DEFAULT_FONT_SANS,
  fontMono: DEFAULT_FONT_MONO,
};

function load(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<UiSettings> & { mode?: unknown; trueDark?: unknown };
    // 구 포맷(mode + trueDark) → 신 포맷(theme) 마이그레이션.
    let theme: ThemeMode;
    if (typeof parsed.theme === "string" && VALID_THEMES.includes(parsed.theme as ThemeMode)) {
      theme = parsed.theme as ThemeMode;
    } else if (parsed.mode === "dark") {
      theme = parsed.trueDark === false ? "dark" : "true-dark";
    } else {
      theme = "light";
    }
    return {
      lang: parsed.lang === "ko" ? "ko" : parsed.lang === "en" ? "en" : DEFAULTS.lang,
      theme,
      density: parsed.density === "compact" ? "compact" : "comfortable",
      motionDisabled: !!parsed.motionDisabled,
      fontSans: typeof parsed.fontSans === "string" && parsed.fontSans.trim() ? parsed.fontSans : DEFAULT_FONT_SANS,
      fontMono: typeof parsed.fontMono === "string" && parsed.fontMono.trim() ? parsed.fontMono : DEFAULT_FONT_MONO,
    };
  } catch {
    return DEFAULTS;
  }
}

// 설정을 document 에 적용한다 (클래스 + CSS 변수).
function applyAll(s: UiSettings) {
  try {
    const root = document.documentElement;
    // 테마: light → 클래스 없음, dark/true-dark → .dark (+ .true-dark)
    root.classList.toggle("dark", s.theme !== "light");
    root.classList.toggle("true-dark", s.theme === "true-dark");
    root.dataset.density = s.density;
    root.dataset.motion = s.motionDisabled ? "reduced" : "full";
    root.lang = s.lang;
    root.style.setProperty("--piweb-font-sans", s.fontSans);
    root.style.setProperty("--piweb-font-mono", s.fontMono);
  } catch {
    /* SSR/비브라우저 환경 방어 */
  }
}

/** 폰트 기본값(설정 UI 의 "기본으로" 버튼용). */
export const FONT_DEFAULTS = { sans: DEFAULT_FONT_SANS, mono: DEFAULT_FONT_MONO };

// 모듈 로드 시점에 한 번 적용 — 첫 페인트 전에 테마가 붙도록.
let current = load();
applyAll(current);

// 여러 컴포넌트가 같은 상태를 보도록 간단한 구독 모델.
const listeners = new Set<(s: UiSettings) => void>();
function setGlobal(next: UiSettings) {
  current = next;
  applyAll(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 저장 실패는 무시 (시크릿 모드 등) */
  }
  for (const fn of listeners) fn(next);
}

export function useUiSettings() {
  const [settings, setSettings] = useState<UiSettings>(current);

  useEffect(() => {
    const fn = (s: UiSettings) => setSettings(s);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const update = useCallback((patch: Partial<UiSettings>) => {
    setGlobal({ ...current, ...patch });
  }, []);

  return { settings, update };
}
