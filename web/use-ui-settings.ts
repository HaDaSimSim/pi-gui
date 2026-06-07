// UI settings store — persists to localStorage and applies to the document.
//
// Settings that live in the browser: language (en/ko), theme (light/dark/true-dark),
// density (comfortable/compact), motion, fonts (sans/mono). Read and change them anywhere
// via useUiSettings().
//
// Theme is based on Tailwind's .dark class (true-dark is .dark.true-dark).
// auto follows the system prefers-color-scheme and updates live when the system setting changes.
// Density is kept as a data-density attribute, leaving room for CSS to adjust spacing.

import { useCallback, useEffect, useState } from 'react';
import type { Lang } from './i18n';

// Theme structure the user picks (designed for extensibility):
//  - mode: what determines light/dark. auto=follows the system.
//  - lightVariant: the concrete theme used on the light side (currently just light).
//  - darkVariant: the concrete theme used on the dark side (dark / true-dark).
// mode=auto uses darkVariant when the system is dark, lightVariant when light.
// mode=light/dark ignores the system and forces that side's variant (odd combos allowed too).
export type ThemeModeTrigger = 'auto' | 'light' | 'dark';
export type LightVariant = 'light';
export type DarkVariant = 'dark' | 'true-dark';
export type Density = 'comfortable' | 'compact';

export interface UiSettings {
  lang: Lang; // "en" | "ko"
  themeMode: ThemeModeTrigger; // auto | light | dark (switch criterion)
  lightVariant: LightVariant; // light-side variant
  darkVariant: DarkVariant; // dark-side variant (dark | true-dark)
  density: Density;
  motionDisabled: boolean;
  fontSans: string; // body font (CSS font-family value)
  fontMono: string; // monospace font
}

const STORAGE_KEY = 'pi-web.ui-settings';

// Default font chain (matches the variable defaults in globals.css).
const DEFAULT_FONT_SANS =
  '"Pretendard GOV", "Pretendard", system-ui, -apple-system, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
const DEFAULT_FONT_MONO =
  '"BlexMono Nerd Font", "IBM Plex Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// If the browser language is Korean, default to ko.
function detectLang(): Lang {
  try {
    return navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  } catch {
    return 'en';
  }
}

const VALID_DARK: DarkVariant[] = ['dark', 'true-dark'];

const DEFAULTS: UiSettings = {
  lang: detectLang(),
  themeMode: 'auto',
  lightVariant: 'light',
  darkVariant: 'true-dark',
  density: 'comfortable',
  motionDisabled: false,
  fontSans: DEFAULT_FONT_SANS,
  fontMono: DEFAULT_FONT_MONO,
};

function load(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Migrate old formats:
    //  - {theme: "auto|light|dark|true-dark"}  (previous format)
    //  - {mode:"dark", trueDark:bool}          (even older)
    // → {themeMode, lightVariant, darkVariant} new format.
    let themeMode: ThemeModeTrigger = DEFAULTS.themeMode;
    let darkVariant: DarkVariant = DEFAULTS.darkVariant;
    if (
      parsed.themeMode === 'auto' ||
      parsed.themeMode === 'light' ||
      parsed.themeMode === 'dark'
    ) {
      themeMode = parsed.themeMode;
      if (VALID_DARK.includes(parsed.darkVariant as DarkVariant))
        darkVariant = parsed.darkVariant as DarkVariant;
    } else if (typeof parsed.theme === 'string') {
      // Infer from a single theme value.
      if (parsed.theme === 'light') themeMode = 'light';
      else if (parsed.theme === 'dark') {
        themeMode = 'dark';
        darkVariant = 'dark';
      } else if (parsed.theme === 'true-dark') {
        themeMode = 'dark';
        darkVariant = 'true-dark';
      } else themeMode = 'auto'; // "auto"
    } else if (parsed.mode === 'dark') {
      themeMode = 'dark';
      darkVariant = parsed.trueDark === false ? 'dark' : 'true-dark';
    }

    return {
      lang: parsed.lang === 'ko' ? 'ko' : parsed.lang === 'en' ? 'en' : DEFAULTS.lang,
      themeMode,
      lightVariant: 'light',
      darkVariant,
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      motionDisabled: !!parsed.motionDisabled,
      fontSans:
        typeof parsed.fontSans === 'string' && parsed.fontSans.trim()
          ? parsed.fontSans
          : DEFAULT_FONT_SANS,
      fontMono:
        typeof parsed.fontMono === 'string' && parsed.fontMono.trim()
          ? parsed.fontMono
          : DEFAULT_FONT_MONO,
    };
  } catch {
    return DEFAULTS;
  }
}

// Whether the system is in dark mode (for auto theme resolution).
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

// theme settings → the (dark, trueDark) to actually apply.
// mode=auto follows the system to pick the light/dark side, then applies that side's variant.
function resolveTheme(s: UiSettings): { dark: boolean; trueDark: boolean } {
  let side: 'light' | 'dark';
  if (s.themeMode === 'light') side = 'light';
  else if (s.themeMode === 'dark') side = 'dark';
  else side = systemPrefersDark() ? 'dark' : 'light'; // auto

  if (side === 'light') return { dark: false, trueDark: false };
  return { dark: true, trueDark: s.darkVariant === 'true-dark' };
}

// Apply settings to the document (classes + CSS variables).
function applyAll(s: UiSettings) {
  try {
    const root = document.documentElement;
    const { dark, trueDark } = resolveTheme(s);
    root.classList.toggle('dark', dark);
    root.classList.toggle('true-dark', trueDark);
    root.dataset.density = s.density;
    root.dataset.motion = s.motionDisabled ? 'reduced' : 'full';
    root.lang = s.lang;
    root.style.setProperty('--piweb-font-sans', s.fontSans);
    root.style.setProperty('--piweb-font-mono', s.fontMono);
  } catch {
    /* guard against SSR/non-browser environments */
  }
}

/** Font defaults (for the "reset to default" button in the settings UI). */
export const FONT_DEFAULTS = { sans: DEFAULT_FONT_SANS, mono: DEFAULT_FONT_MONO };

// Apply once at module load — so the theme is attached before the first paint.
let current = load();
applyAll(current);

// React live to system dark/light switches when in auto mode.
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (current.themeMode === 'auto') applyAll(current);
  });
} catch {
  /* guard against environments without matchMedia */
}

// A simple subscription model so multiple components see the same state.
const listeners = new Set<(s: UiSettings) => void>();
function setGlobal(next: UiSettings) {
  current = next;
  applyAll(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore save failures (incognito mode etc.) */
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
