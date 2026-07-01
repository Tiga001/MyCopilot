import { Check } from "lucide-react";
import { useFrontendConfig } from "../../../../config/FrontendConfigProvider";
import type { ModelConfig } from "./configurationTypes";

interface ModelProviderSettingsProps {
  apiUrl: string;
  apiToken: string;
  models: ModelConfig[];
  onApiTokenChange: (value: string) => void;
  onApiUrlChange: (value: string) => void;
  onManageModels: () => void;
  onToggleModel: (modelId: string) => void;
}

export function ModelProviderSettings({
  apiUrl,
  apiToken,
  models,
  onApiTokenChange,
  onApiUrlChange,
  onManageModels,
  onToggleModel,
}: ModelProviderSettingsProps) {
  const { t } = useFrontendConfig();

  return (
    <section className="configuration-section" aria-labelledby="model-settings-heading">
      <h1 id="model-settings-heading">{t("configuration.model")}</h1>

      <div className="configuration-form-block">
        <h2>{t("configuration.modelSettings")}</h2>

        <label className="configuration-field">
          <span>API URL</span>
          <input type="url" value={apiUrl} onChange={(event) => onApiUrlChange(event.target.value)} />
        </label>

        <label className="configuration-field">
          <span>API Token</span>
          <input type="password" value={apiToken} onChange={(event) => onApiTokenChange(event.target.value)} />
        </label>
      </div>

      <div className="available-models-heading">
        <h2>{t("configuration.availableModels")}</h2>
        <button className="secondary-settings-button" type="button" onClick={onManageModels}>
          {t("configuration.manageModels")}
        </button>
      </div>

      <div className="available-model-list" aria-label={t("configuration.availableModelList")}>
        {models.map((model) => (
          <label className="available-model-row" key={model.id}>
            <input
              type="checkbox"
              checked={model.enabled}
              onChange={() => onToggleModel(model.id)}
              aria-label={`${t("configuration.enableModelPrefix")} ${model.displayName}`}
            />
            <span className="available-model-row__check" aria-hidden="true">
              <Check />
            </span>
            <span className="available-model-row__name">{model.displayName}</span>
            <span className="model-capability-pill" data-supported={model.supportsImage || undefined}>
              {model.supportsImage ? t("configuration.image") : t("configuration.text")}
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
