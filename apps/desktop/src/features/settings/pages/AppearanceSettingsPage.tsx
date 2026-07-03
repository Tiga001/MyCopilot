import { useFrontendConfig } from "../../../config/FrontendConfigProvider";
import type { ThemePreference } from "../../../config/frontendTheme";
import type { TranslationKey } from "../../../config/frontendTranslations";
import "./AppearanceSettingsPage.css";

const THEME_OPTIONS: Array<{
  id: ThemePreference;
  labelKey: TranslationKey;
  preview: "system" | "light" | "dark";
}> = [
  { id: "system", labelKey: "appearance.theme.system", preview: "system" },
  { id: "light", labelKey: "appearance.theme.light", preview: "light" },
  { id: "dark", labelKey: "appearance.theme.dark", preview: "dark" },
];

export function AppearanceSettingsPage() {
  const { setThemePreference, t, themePreference } = useFrontendConfig();

  return (
    <article className="settings-detail appearance-settings-page">
      <h1>{t("settings.page.appearance")}</h1>

      <div className="appearance-theme-grid" role="group" aria-label={t("appearance.theme")}>
        {THEME_OPTIONS.map((option) => (
          <button
            className="appearance-theme-option"
            type="button"
            data-active={themePreference === option.id || undefined}
            data-theme-option={option.preview}
            aria-pressed={themePreference === option.id}
            key={option.id}
            onClick={() => setThemePreference(option.id)}
          >
            <span className="appearance-theme-preview" data-preview={option.preview} aria-hidden="true">
              <span className="appearance-theme-preview__window" />
              <span className="appearance-theme-preview__header">
                <span />
                <span />
              </span>
              <span className="appearance-theme-preview__panel">
                <span />
                <span />
                <span />
              </span>
            </span>
            <span className="appearance-theme-option__label">{t(option.labelKey)}</span>
          </button>
        ))}
      </div>
    </article>
  );
}
