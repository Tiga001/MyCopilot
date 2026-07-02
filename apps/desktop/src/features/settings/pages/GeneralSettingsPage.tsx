import { useFrontendConfig } from "../../../config/FrontendConfigProvider";
import type { AppLanguage } from "../../../config/frontendTranslations";
import "./GeneralSettingsPage.css";

export function GeneralSettingsPage() {
  const { language, languageOptions, setLanguage, t } = useFrontendConfig();

  return (
    <article className="settings-detail general-settings-page">
      <h1>{t("settings.page.general")}</h1>

      <section className="general-settings-section" aria-labelledby="language-setting-heading">
        <div>
          <h2 id="language-setting-heading">{t("general.language")}</h2>
          <p>{t("general.languageDescription")}</p>
        </div>

        <label className="general-settings-select">
          <span className="sr-only">{t("general.languageAria")}</span>
          <select
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
        </label>
      </section>
    </article>
  );
}
