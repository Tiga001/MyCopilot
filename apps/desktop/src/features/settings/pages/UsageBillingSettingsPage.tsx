import { useFrontendConfig } from "../../../config/FrontendConfigProvider";

export function UsageBillingSettingsPage() {
  const { t } = useFrontendConfig();

  return (
    <article className="settings-detail">
      <h1>{t("settings.page.usageBilling")}</h1>
      <p>{t("usageBilling.description")}</p>
    </article>
  );
}
