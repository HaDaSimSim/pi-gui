// UI 설정 스토어 — localStorage 에 저장하고 document 에 반영한다.
//
// 브라우저에서 끝나는 설정들: 언어(en/ko), 테마(light/dark/true-dark),
// 밀도(comfortable/compact), 모션, 폰트(sans/mono). 어디서든 useUiSettings()
// 로 읽고 바꾼다.
//
// 테마는 Tailwind 의 .dark 클래스 기반 (true-dark 는 .dark.true-dark).
// auto 는 시스템 prefers-color-scheme 을 따라가며, 시스템 설정이 바뀌면 라이브 반영.
// 밀도는 data-density 속성으로 두고 CSS 가 간격을 조절할 여지를 남긴다.

import { useCallback, useEffect, useState } from "react";
import type { Lang } from "./i18n";

// 사용자가 고르는 테마 구조 (확장성 고려):
//  - mode: 어떤 기준으로 light/dark 를 정할지. auto=시스템 따라감.
//  - lightVariant: light 측일 때 쓸 구체 테마 (현재 light 하나).
//  - darkVariant: dark 측일 때 쓸 구체 테마 (dark / true-dark).
// mode=auto 면 시스템이 dark 일 때 darkVariant, light 일 때 lightVariant.
// mode=light/dark 면 시스템 무시하고 그 측 변형을 강제 (괴랑한 조합도 허용).
export type ThemeModeTrigger = "auto" | "light" | "dark";
export type LightVariant = "light";
export type DarkVariant = "dark" | "true-dark";
export type Density = "comfortable" | "compact";

export interface UiSettings {
  lang: Lang; // "en" | "ko"
  themeMode: ThemeModeTrigger; // auto | light | dark (전환 기준)
  lightVariant: LightVariant; // light 측 변형
  darkVariant: DarkVariant; // dark 측 변형 (dark | true-dark)
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

const VALID_DARK: DarkVariant[] = ["dark", "true-dark"];

const DEFAULTS: UiSettings = {
  lang: detectLang(),
  themeMode: "auto",
  lightVariant: "light",
  darkVariant: "true-dark",
  density: "comfortable",
  motionDisabled: false,
  fontSans: DEFAULT_FONT_SANS,
  fontMono: DEFAULT_FONT_MONO,
};

function load(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // 구 포맷 마이그레이션:
    //  - {theme: "auto|light|dark|true-dark"}  (직전 포맷)
    //  - {mode:"dark", trueDark:bool}          (더 이전)
    // → {themeMode, lightVariant, darkVariant} 신 포맷.
    let themeMode: ThemeModeTrigger = DEFAULTS.themeMode;
    let darkVariant: DarkVariant = DEFAULTS.darkVariant;
    if (parsed.themeMode === "auto" || parsed.themeMode === "light" || parsed.themeMode === "dark") {
      themeMode = parsed.themeMode;
      if (VALID_DARK.includes(parsed.darkVariant as DarkVariant)) darkVariant = parsed.darkVariant as DarkVariant;
    } else if (typeof parsed.theme === "string") {
      // 단일 theme 값에서 추론.
      if (parsed.theme === "light") themeMode = "light";
      else if (parsed.theme === "dark") { themeMode = "dark"; darkVariant = "dark"; }
      else if (parsed.theme === "true-dark") { themeMode = "dark"; darkVariant = "true-dark"; }
      else themeMode = "auto"; // "auto"
    } else if (parsed.mode === "dark") {
      themeMode = "dark";
      darkVariant = parsed.trueDark === false ? "dark" : "true-dark";
    }

    return {
      lang: parsed.lang === "ko" ? "ko" : parsed.lang === "en" ? "en" : DEFAULTS.lang,
      themeMode,
      lightVariant: "light",
      darkVariant,
      density: parsed.density === "compact" ? "compact" : "comfortable",
      motionDisabled: !!parsed.motionDisabled,
      fontSans: typeof parsed.fontSans === "string" && parsed.fontSans.trim() ? parsed.fontSans : DEFAULT_FONT_SANS,
      fontMono: typeof parsed.fontMono === "string" && parsed.fontMono.trim() ? parsed.fontMono : DEFAULT_FONT_MONO,
    };
  } catch {
    return DEFAULTS;
  }
}

// 시스템이 다크 모드인지 (auto 테마 판정용).
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

// theme 설정 → 실제 적용할 (dark 여부, trueDark 여부).
// mode=auto 면 시스템을 따라 light/dark 측을 정하고, 그 측의 변형을 적용.
function resolveTheme(s: UiSettings): { dark: boolean; trueDark: boolean } {
  let side: "light" | "dark";
  if (s.themeMode === "light") side = "light";
  else if (s.themeMode === "dark") side = "dark";
  else side = systemPrefersDark() ? "dark" : "light"; // auto

  if (side === "light") return { dark: false, trueDark: false };
  return { dark: true, trueDark: s.darkVariant === "true-dark" };
}

// 설정을 document 에 적용한다 (클래스 + CSS 변수).
function applyAll(s: UiSettings) {
  try {
    const root = document.documentElement;
    const { dark, trueDark } = resolveTheme(s);
    root.classList.toggle("dark", dark);
    root.classList.toggle("true-dark", trueDark);
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

// auto 모드일 때 시스템 다크/라이트 전환에 라이브로 반응.
try {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (current.themeMode === "auto") applyAll(current);
  });
} catch {
  /* matchMedia 없는 환경 방어 */
}

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
