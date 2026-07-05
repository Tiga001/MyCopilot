import { useState } from "react";
import type { FocusEvent } from "react";
import type {
  AgentCommandPermission,
  AgentPatchPermission,
  AgentReadPermission,
  AgentWritePermission,
} from "@agent";
import { Check, ChevronDown } from "lucide-react";
import { useFrontendConfig } from "../../../config/FrontendConfigProvider";
import type { AppLanguage } from "../../../config/frontendTranslations";
import type { UiPreferencesSnapshot } from "../../storage/storageClient";
import "./GeneralSettingsPage.css";

const LANGUAGE_DISPLAY_OPTIONS: Array<{ value: AppLanguage; label: string }> = [
  { value: "zh-CN", label: "中文（中国）" },
  { value: "en-US", label: "English (United States)" },
];

interface GeneralSettingsPageProps {
  onUiPreferencesChange: (patch: Partial<UiPreferencesSnapshot>) => void;
  uiPreferences: UiPreferencesSnapshot;
}

interface PermissionSegmentProps {
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
}

function PermissionSegment({ ariaLabel, disabled = false, onChange, options, value }: PermissionSegmentProps) {
  return (
    <span className="general-permission-segment" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={option.value === value}
          data-selected={option.value === value || undefined}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

export function GeneralSettingsPage({ onUiPreferencesChange, uiPreferences }: GeneralSettingsPageProps) {
  const { language, setLanguage, t } = useFrontendConfig();
  const [isLanguageMenuOpen, setLanguageMenuOpen] = useState(false);
  const selectedLanguage =
    LANGUAGE_DISPLAY_OPTIONS.find((option) => option.value === language) ?? LANGUAGE_DISPLAY_OPTIONS[0];

  const closeLanguageMenuOnBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setLanguageMenuOpen(false);
    }
  };
  const updateCustomPermissions = (patch: Partial<UiPreferencesSnapshot["customPermissions"]>) => {
    onUiPreferencesChange({
      customPermissions: {
        ...uiPreferences.customPermissions,
        ...patch,
      },
    });
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

      <section className="settings-list-section" aria-labelledby="custom-permissions-heading">
        <h2 id="custom-permissions-heading">{t("general.customPermissions")}</h2>

        <div className="settings-list general-permissions-list">
          <div className="settings-list-row">
            <span className="settings-list-row__text">
              <span className="settings-list-row__title">{t("general.readPermission")}</span>
            </span>
            <span className="settings-list-row__control">
              <PermissionSegment
                ariaLabel={t("general.readPermission")}
                value={uiPreferences.customPermissions.read}
                options={[
                  { value: "workspace_only", label: t("general.workspaceOnly") },
                  { value: "all", label: t("general.allLocations") },
                ]}
                onChange={(value) => updateCustomPermissions({ read: value as AgentReadPermission })}
              />
            </span>
          </div>

          <div className="settings-list-row">
            <span className="settings-list-row__text">
              <span className="settings-list-row__title">{t("general.writePermission")}</span>
            </span>
            <span className="settings-list-row__control">
              <PermissionSegment
                ariaLabel={t("general.writePermission")}
                value={uiPreferences.customPermissions.write}
                options={[
                  { value: "denied", label: t("general.writeDenied") },
                  { value: "workspace_only", label: t("general.workspaceOnly") },
                  { value: "all", label: t("general.allLocations") },
                ]}
                onChange={(value) => updateCustomPermissions({ write: value as AgentWritePermission })}
              />
            </span>
          </div>

          <div className="settings-list-row">
            <span className="settings-list-row__text">
              <span className="settings-list-row__title">{t("general.patchApproval")}</span>
            </span>
            <span className="settings-list-row__control">
              <PermissionSegment
                ariaLabel={t("general.patchApproval")}
                disabled={uiPreferences.customPermissions.write === "denied"}
                value={uiPreferences.customPermissions.patch}
                options={[
                  { value: "require_approval", label: t("general.yes") },
                  { value: "auto_approve", label: t("general.no") },
                ]}
                onChange={(value) => updateCustomPermissions({ patch: value as AgentPatchPermission })}
              />
            </span>
          </div>

          <div className="settings-list-row">
            <span className="settings-list-row__text">
              <span className="settings-list-row__title">{t("general.commandPermission")}</span>
            </span>
            <span className="settings-list-row__control">
              <PermissionSegment
                ariaLabel={t("general.commandPermission")}
                value={uiPreferences.customPermissions.command}
                options={[
                  { value: "require_approval", label: t("general.requireApproval") },
                  { value: "auto_approve", label: t("general.autoApprove") },
                ]}
                onChange={(value) => updateCustomPermissions({ command: value as AgentCommandPermission })}
              />
            </span>
          </div>
        </div>
      </section>
    </article>
  );
}
