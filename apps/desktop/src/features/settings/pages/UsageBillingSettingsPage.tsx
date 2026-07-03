import { useFrontendConfig } from "../../../config/FrontendConfigProvider";

export function UsageBillingSettingsPage() {
  const { t } = useFrontendConfig();

  return (
    <article className="settings-list-page">
      <h1>{t("settings.page.usageBilling")}</h1>
    </article>
  );
}
