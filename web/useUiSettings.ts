// UI 설정 스토어 — localStorage 에 저장하고 Cloudscape 전역 스타일에 반영한다.
//
// 백엔드/SDK 가 아니라 "브라우저에서 끝나는" 설정들. 언어(en/ko), 테마(라이트/
// 다크), 밀도(comfortable/compact), 모션 비활성화. 페이지 어디서든
// useUiSettings() 로 읽고 바꿀 수 있다.

import { useCallback, useEffect, useState } from "react";
import { Mode, Density, applyMode, applyDensity, disableMotion } from "@cloudscape-design/global-styles";
import { applyTheme, type Theme } from "@cloudscape-design/components/theming";
import type { Lang } from "./i18n";

// 테마 모드 — 단일 선택지. "true-dark" 는 다크 + 순수 검정(OLED).
export type ThemeMode = "light" | "dark" | "true-dark";

export interface UiSettings {
  lang: Lang; // "en" | "ko"
  theme: ThemeMode; // light | dark | true-dark
  density: Density; // Density.Comfortable | Density.Compact
  motionDisabled: boolean;
  fontSans: string; // 본문 폰트 (CSS font-family 값)
  fontMono: string; // 모노스페이스 폰트
}

const STORAGE_KEY = "pi-web.ui-settings";

// 기본 폰트 체인 (theme.css 의 변수 기본값과 일치).
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
  density: Density.Comfortable,
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
    } else if (parsed.mode === Mode.Dark || parsed.mode === "dark") {
      theme = parsed.trueDark === false ? "dark" : "true-dark";
    } else {
      theme = "light";
    }
    return {
      lang: parsed.lang === "ko" ? "ko" : parsed.lang === "en" ? "en" : DEFAULTS.lang,
      theme,
      density: parsed.density === Density.Compact ? Density.Compact : Density.Comfortable,
      motionDisabled: !!parsed.motionDisabled,
      fontSans: typeof parsed.fontSans === "string" && parsed.fontSans.trim() ? parsed.fontSans : DEFAULT_FONT_SANS,
      fontMono: typeof parsed.fontMono === "string" && parsed.fontMono.trim() ? parsed.fontMono : DEFAULT_FONT_MONO,
    };
  } catch {
    return DEFAULTS;
  }
}

// 트루 다크 테마: Cloudscape 공식 applyTheme 로 다크 모드 토큰값만
// 순수 검정 계열로 교체한다. light 값은 그대로 둔다(테마는 한 번만
// 적용하고, 라이트/다크 전환은 applyMode 가 담당). 계층감을 위해
// 바닥은 #000, 떠있는 표면은 근접 검정.
const TRUE_DARK_THEME: Theme = {
  tokens: {
    colorBackgroundLayoutMain: { dark: "#000000" },
    colorBackgroundHomeHeader: { dark: "#000000" },
    colorBackgroundContainerContent: { dark: "#0c0c0c" },
    colorBackgroundContainerHeader: { dark: "#0c0c0c" },
    colorBackgroundDropdownItemDefault: { dark: "#0c0c0c" },
    colorBackgroundInputDefault: { dark: "#121212" },
    colorBackgroundDialog: { dark: "#000000" },
    colorBackgroundPopover: { dark: "#0c0c0c" },
    colorBackgroundCellShaded: { dark: "#141414" },
    colorBackgroundDropdownItemHover: { dark: "#1a1a1a" },
  },
};

// applyTheme 는 reset 함수를 돌려준다. 토글 시 이전 테마를 제거하기 위해 보관.
let resetTrueDark: (() => void) | null = null;

function applyTrueDark(enabled: boolean) {
  // 먼저 이전 테마 제거 (중첩 방지).
  if (resetTrueDark) {
    resetTrueDark();
    resetTrueDark = null;
  }
  if (enabled) {
    try {
      resetTrueDark = applyTheme({ theme: TRUE_DARK_THEME }).reset;
    } catch {
      /* 테마 적용 실패는 무시 (기본 다크로 폴백) */
    }
  }
}

// 설정을 Cloudscape 전역 스타일 + CSS 변수에 적용한다 (document 레벨).
function applyAll(s: UiSettings) {
  // theme 을 Cloudscape Mode 로 매핑: light → Light, 그 외 → Dark.
  applyMode(s.theme === "light" ? Mode.Light : Mode.Dark);
  applyDensity(s.density);
  disableMotion(s.motionDisabled);
  // 트루 다크 테마는 "true-dark" 일 때만 (light 값은 안 건드림).
  applyTrueDark(s.theme === "true-dark");
  try {
    const root = document.documentElement;
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
