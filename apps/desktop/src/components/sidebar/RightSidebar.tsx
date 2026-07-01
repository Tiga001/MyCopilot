import { Maximize, Plus } from "lucide-react";
import { useFrontendConfig } from "../../config/FrontendConfigProvider";
import "./RightSidebar.css";

const RIGHT_PANEL_ACTIONS = [
  {
    titleKey: "rightSidebar.review",
    descriptionKey: "rightSidebar.reviewDescription",
  },
  {
    titleKey: "rightSidebar.terminal",
    descriptionKey: "rightSidebar.terminalDescription",
  },
] as const;

export function RightSidebar() {
  const { t } = useFrontendConfig();

  return (
    <aside className="right-sidebar" aria-label={t("app.rightSidebar")}>
      <header className="right-sidebar__toolbar" data-tauri-drag-region>
        <div className="right-sidebar__toolbar-actions">
          <button className="right-sidebar__icon-button" type="button" aria-label={t("rightSidebar.newPanel")}>
            <Plus aria-hidden="true" />
          </button>
          <button className="right-sidebar__icon-button" type="button" aria-label={t("rightSidebar.maximize")}>
            <Maximize aria-hidden="true" />
          </button>
        </div>
      </header>

      <nav className="right-sidebar__home" aria-label={t("rightSidebar.tools")}>
        {RIGHT_PANEL_ACTIONS.map((action) => (
          <button className="right-sidebar__tool-card" type="button" key={action.titleKey}>
            <span className="right-sidebar__tool-title">{t(action.titleKey)}</span>
            <span className="right-sidebar__tool-description">{t(action.descriptionKey)}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
