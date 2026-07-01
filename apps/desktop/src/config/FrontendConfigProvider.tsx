import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  FRONTEND_CONFIG_STORAGE_KEY,
  frontendConfig,
  getFrontendCssVariables,
  languageOptions,
  translations,
} from "./frontendConfig";
import type { AppLanguage, FrontendConfig, TranslationKey } from "./frontendConfig";

interface StoredFrontendConfig {
  language?: AppLanguage;
}

interface FrontendConfigContextValue {
  config: FrontendConfig;
  language: AppLanguage;
  languageOptions: typeof languageOptions;
  setLanguage: (language: AppLanguage) => void;
  t: (key: TranslationKey) => string;
}

const FrontendConfigContext = createContext<FrontendConfigContextValue | null>(null);

function isAppLanguage(value: string | null | undefined): value is AppLanguage {
  return value === "zh-CN" || value === "en-US";
}

function readStoredLanguage(): AppLanguage {
  try {
    const rawValue = window.localStorage.getItem(FRONTEND_CONFIG_STORAGE_KEY);
    if (!rawValue) return frontendConfig.language;
    const parsed = JSON.parse(rawValue) as StoredFrontendConfig;
    return isAppLanguage(parsed.language) ? parsed.language : frontendConfig.language;
  } catch {
    return frontendConfig.language;
  }
}

export function FrontendConfigProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(() => readStoredLanguage());

  useLayoutEffect(() => {
    const variables = getFrontendCssVariables(frontendConfig);
    Object.entries(variables).forEach(([name, value]) => {
      document.documentElement.style.setProperty(name, value);
    });
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    window.localStorage.setItem(FRONTEND_CONFIG_STORAGE_KEY, JSON.stringify({ language }));
  }, [language]);

  const value = useMemo<FrontendConfigContextValue>(
    () => ({
      config: frontendConfig,
      language,
      languageOptions,
      setLanguage,
      t: (key) => translations[language][key] ?? translations[frontendConfig.language][key],
    }),
    [language],
  );

  return <FrontendConfigContext.Provider value={value}>{children}</FrontendConfigContext.Provider>;
}

export function useFrontendConfig() {
  const context = useContext(FrontendConfigContext);

  if (!context) {
    throw new Error("useFrontendConfig must be used within FrontendConfigProvider");
  }

  return context;
}
