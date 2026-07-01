import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft, Gauge, Monitor, Search, Settings, Shield, Sun } from "lucide-react";
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
  label: string;
  icon: LucideIcon;
}

const SETTINGS_GROUPS: Array<{ title: string; items: SettingsNavItem[] }> = [
  {
    title: "个人",
    items: [
      { id: "general", label: "常规", icon: Settings },
      { id: "appearance", label: "外观", icon: Sun },
      { id: "configuration", label: "配置", icon: Shield },
      { id: "usageBilling", label: "使用情况和计费", icon: Gauge },
    ],
  },
  {
    title: "编码",
    items: [{ id: "environment", label: "环境", icon: Monitor }],
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
  return (
    <aside className="settings-nav" aria-label="设置导航">
      <button className="settings-nav__back" type="button" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        <span>返回应用</span>
      </button>

      <label className="settings-nav__search">
        <Search aria-hidden="true" />
        <input type="search" placeholder="搜索设置..." aria-label="搜索设置" />
      </label>

      <nav className="settings-nav__groups">
        {SETTINGS_GROUPS.map((group) => (
          <section className="settings-nav__group" key={group.title} aria-labelledby={`settings-${group.title}`}>
            <h2 id={`settings-${group.title}`}>{group.title}</h2>
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
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>

      <span className="settings-nav__update">更新</span>
    </aside>
  );
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  const [activePage, setActivePage] = useState<SettingsPageId>("general");

  return (
    <div className="settings-page">
      <div className="settings-page__drag-region" data-tauri-drag-region />
      <SettingsNavigation activePage={activePage} onBack={onBack} onSelectPage={setActivePage} />

      <main className="settings-content" aria-label="设置内容">
        <div className="settings-content__inner">
          <SettingsContent activePage={activePage} />
        </div>
      </main>
    </div>
  );
}
