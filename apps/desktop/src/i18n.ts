import { useSyncExternalStore } from "react";
import { en } from "./locales/en";

export type Locale = "zh-CN" | "en";
export type LanguagePreference = "system" | Locale;

const STORAGE_KEY = "shell-ex-language";
const catalogs: Readonly<Partial<Record<Locale, Readonly<Record<string, string>>>>> = { en };
const listeners = new Set<() => void>();

export function resolveLocale(preference: LanguagePreference, systemLanguage: string): Locale {
  if (preference !== "system") return preference;
  return /^zh(?:[-_]|$)/i.test(systemLanguage) ? "zh-CN" : "en";
}

function readPreference(): LanguagePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "zh-CN" || value === "en" ? value : "system";
  } catch {
    return "system";
  }
}

let preference = readPreference();
let localeOverride: Locale | null = null;
function systemLanguage(): string {
  return typeof navigator !== "undefined" ? navigator.language : "en";
}

export function getLanguagePreference(): LanguagePreference {
  return preference;
}
export function getLocale(): Locale {
  return localeOverride ?? resolveLocale(preference, systemLanguage());
}

export function translate(locale: Locale, key: string, ...args: unknown[]): string {
  const catalog = catalogs[locale];
  const message = catalog && Object.hasOwn(catalog, key) ? catalog[key] : key;
  return message.replace(/\{(\d+)\}/g, (match, index: string) => {
    const position = Number(index);
    return position < args.length ? String(args[position] ?? "") : match;
  });
}

export function tr(key: string, ...args: unknown[]): string {
  return translate(getLocale(), key, ...args);
}

function notifyLanguageChanged() {
  if (typeof document !== "undefined") {
    document.documentElement.lang = getLocale();
    document.title = tr("Shell EX · 服务器工作台");
  }
  listeners.forEach((listener) => listener());
}

/** A secondary window can follow the main window without rewriting its preference. */
export function setLocaleOverride(value: Locale | null) {
  if (localeOverride === value) return;
  localeOverride = value;
  notifyLanguageChanged();
}

export function setLanguagePreference(value: LanguagePreference) {
  if (value !== "system" && value !== "zh-CN" && value !== "en") return;
  preference = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // The current session can still change languages when storage is unavailable.
  }
  notifyLanguageChanged();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The app subscribes once; descendants render with the current locale without remounting. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => {
    if (preference === "system") notifyLanguageChanged();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      preference = readPreference();
      notifyLanguageChanged();
    }
  });
  notifyLanguageChanged();
}
