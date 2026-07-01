import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft, Gauge, Monitor, Search, Settings, Shield, Sun } from "lucide-react";
import { useFrontendConfig } from "../../config/FrontendConfigProvider";
import type { TranslationKey } from "../../config/frontendConfig";
import { AppearanceSettingsPage } from "./pages/AppearanceSettingsPage";
import { ConfigurationSettingsPage } from "./pages/ConfigurationSettingsPage";
import { EnvironmentSettingsPage } from "./pages/EnvironmentSettingsPage";
import { GeneralSettingsPage } from "./pages/GeneralSettingsPage";
import { UsageBillingSettingsPage } from "./pages/UsageBillingSettingsPage";
import "./SettingsPage.css";

interface SettingsPageProps {
  onBack: () => void;
}

type SettingsPageId = "general" | "appearance" | "configuration" | "usageBilling" | "environment";

interface SettingsNavItem {
  id: SettingsPageId;
  labelKey: TranslationKey;
  icon: LucideIcon;
}

const SETTINGS_GROUPS: Array<{ titleKey: TranslationKey; items: SettingsNavItem[] }> = [
  {
    titleKey: "settings.group.personal",
    items: [
      { id: "general", labelKey: "settings.page.general", icon: Settings },
      { id: "appearance", labelKey: "settings.page.appearance", icon: Sun },
      { id: "configuration", labelKey: "settings.page.configuration", icon: Shield },
      { id: "usageBilling", labelKey: "settings.page.usageBilling", icon: Gauge },
    ],
  },
  {
    titleKey: "settings.group.coding",
    items: [{ id: "environment", labelKey: "settings.page.environment", icon: Monitor }],
  },
];

function SettingsContent({ activePage }: { activePage: SettingsPageId }) {
  if (activePage === "appearance") {
    return <AppearanceSettingsPage />;
  }

  if (activePage === "configuration") {
    return <ConfigurationSettingsPage />;
  }

  if (activePage === "usageBilling") {
    return <UsageBillingSettingsPage />;
  }

  if (activePage === "environment") {
    return <EnvironmentSettingsPage />;
  }

  return <GeneralSettingsPage />;
}

interface SettingsNavigationProps {
  activePage: SettingsPageId;
  onBack: () => void;
  onSelectPage: (page: SettingsPageId) => void;
}

function SettingsNavigation({ activePage, onBack, onSelectPage }: SettingsNavigationProps) {
  const { t } = useFrontendConfig();

  return (
    <aside className="settings-nav" aria-label={t("settings.navigation")}>
      <button className="settings-nav__back" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        <span>{t("settings.backToApp")}</span>
      </button>

      <label className="settings-nav__search">
        <Search aria-hidden="true" />
        <input type="search" placeholder={t("settings.searchPlaceholder")} aria-label={t("settings.search")} />
      </label>

      <nav className="settings-nav__groups">
        {SETTINGS_GROUPS.map((group) => (
          <section className="settings-nav__group" key={group.titleKey} aria-labelledby={`settings-${group.titleKey}`}>
            <h2 id={`settings-${group.titleKey}`}>{t(group.titleKey)}</h2>
            <div className="settings-nav__items">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className="settings-nav__item"
                    data-active={activePage === item.id || undefined}
                    type="button"
                    key={item.id}
                    onClick={() => onSelectPage(item.id)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{t(item.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </aside>
  );
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  const { t } = useFrontendConfig();
  const [activePage, setActivePage] = useState<SettingsPageId>("general");

  return (
    <div className="settings-page">
      <div className="settings-page__drag-region" data-tauri-drag-region />
      <SettingsNavigation activePage={activePage} onBack={onBack} onSelectPage={setActivePage} />

      <main className="settings-content" aria-label={t("settings.content")}>
        <div className="settings-content__inner">
          <SettingsContent activePage={activePage} />
        </div>
      </main>
    </div>
  );
}
