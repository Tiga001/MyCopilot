import { useFrontendConfig } from "../../../config/FrontendConfigProvider";
import type { AppLanguage } from "../../../config/frontendTranslations";

export function GeneralSettingsPage() {
  const { language, languageOptions, setLanguage, t } = useFrontendConfig();

  return (
    <article className="settings-list-page general-settings-page">
      <h1>{t("settings.page.general")}</h1>

      <section className="settings-list-section" aria-labelledby="language-setting-heading">
        <div className="settings-list">
          <label className="settings-list-row general-settings-select">
            <span className="settings-list-row__text">
              <span className="settings-list-row__title" id="language-setting-heading">
                {t("general.language")}
              </span>
            </span>

            <span className="settings-list-row__control">
              <span className="sr-only">{t("general.languageAria")}</span>
              <select
                className="settings-list-control settings-list-select"
                value={language}
                onChange={(event) => setLanguage(event.target.value as AppLanguage)}
                aria-label={t("general.languageAria")}
              >
                {languageOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>
      </section>
    </article>
  );
}
