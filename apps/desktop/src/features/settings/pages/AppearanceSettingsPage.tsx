import { useFrontendConfig } from "../../../config/FrontendConfigProvider";

export function AppearanceSettingsPage() {
  const { t } = useFrontendConfig();

  return (
    <article className="settings-detail">
      <h1>{t("settings.page.appearance")}</h1>
      <p>{t("appearance.description")}</p>
    </article>
  );
}
