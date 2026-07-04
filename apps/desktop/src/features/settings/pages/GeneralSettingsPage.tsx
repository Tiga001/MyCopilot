import { useState } from "react";
import type { FocusEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useFrontendConfig } from "../../../config/FrontendConfigProvider";
import type { AppLanguage } from "../../../config/frontendTranslations";
import "./GeneralSettingsPage.css";

const LANGUAGE_DISPLAY_OPTIONS: Array<{ value: AppLanguage; label: string }> = [
  { value: "zh-CN", label: "中文（中国）" },
  { value: "en-US", label: "English (United States)" },
];

export function GeneralSettingsPage() {
  const { language, setLanguage, t } = useFrontendConfig();
  const [isLanguageMenuOpen, setLanguageMenuOpen] = useState(false);
  const selectedLanguage =
    LANGUAGE_DISPLAY_OPTIONS.find((option) => option.value === language) ?? LANGUAGE_DISPLAY_OPTIONS[0];

  const closeLanguageMenuOnBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setLanguageMenuOpen(false);
    }
  };

  return (
    <article className="settings-list-page general-settings-page">
      <h1>{t("settings.page.general")}</h1>

      <section className="settings-list-section" aria-labelledby="language-setting-heading">
        <div className="settings-list general-settings-list">
          <div className="settings-list-row general-settings-language-row">
            <span className="settings-list-row__text">
              <span className="settings-list-row__title" id="language-setting-heading">
                语言 / Language
              </span>
            </span>

            <span className="settings-list-row__control general-language-control" onBlur={closeLanguageMenuOnBlur}>
              <span className="sr-only">{t("general.languageAria")}</span>
              <button
                className="general-language-button"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={isLanguageMenuOpen}
                aria-label={t("general.languageAria")}
                onClick={() => setLanguageMenuOpen((current) => !current)}
              >
                <span>{selectedLanguage.label}</span>
                <ChevronDown aria-hidden="true" />
              </button>

              {isLanguageMenuOpen && (
                <div className="general-language-menu" role="listbox" aria-label={t("general.languageAria")}>
                  {LANGUAGE_DISPLAY_OPTIONS.map((option) => {
                    const isSelected = option.value === language;
                    return (
                      <button
                        className="general-language-option"
                        data-selected={isSelected || undefined}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        key={option.value}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setLanguage(option.value);
                          setLanguageMenuOpen(false);
                        }}
                      >
                        <span>{option.label}</span>
                        {isSelected && <Check aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </span>
          </div>
        </div>
      </section>
    </article>
  );
}
