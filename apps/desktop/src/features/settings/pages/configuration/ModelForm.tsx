import { useMemo, useState } from "react";
import { useFrontendConfig } from "../../../../config/FrontendConfigProvider";
import type { ModelConfig, ModelFormValues } from "./configurationTypes";

interface ModelFormProps {
  model?: ModelConfig;
  onCancel: () => void;
  onSave: (values: ModelFormValues) => void;
}

function toFormValues(model?: ModelConfig): ModelFormValues {
  return {
    id: model?.id ?? "",
    displayName: model?.displayName ?? "",
    inputPrice: model?.inputPrice ?? "0",
    outputPrice: model?.outputPrice ?? "0",
    supportsImage: model?.supportsImage ?? false,
  };
}

export function ModelForm({ model, onCancel, onSave }: ModelFormProps) {
  const { t } = useFrontendConfig();
  const initialValues = useMemo(() => toFormValues(model), [model]);
  const [values, setValues] = useState<ModelFormValues>(initialValues);
  const isEditing = Boolean(model);
  const canSave = values.id.trim().length > 0;

  return (
    <form
      className="model-form-page"
      aria-labelledby="model-form-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({
          ...values,
          id: values.id.trim(),
          displayName: values.displayName.trim(),
          inputPrice: values.inputPrice.trim() || "0",
          outputPrice: values.outputPrice.trim() || "0",
        });
      }}
    >
      <h1 id="model-form-heading">{isEditing ? t("configuration.editModel") : t("configuration.newModel")}</h1>

      <label className="configuration-field">
        <span>{t("configuration.modelId")}</span>
        <input
          value={values.id}
          placeholder={t("configuration.modelIdPlaceholder")}
          onChange={(event) => setValues((current) => ({ ...current, id: event.target.value }))}
        />
      </label>

      <label className="configuration-field">
        <span>{t("configuration.displayName")}</span>
        <input
          value={values.displayName}
          placeholder={t("configuration.displayNamePlaceholder")}
          onChange={(event) => setValues((current) => ({ ...current, displayName: event.target.value }))}
        />
      </label>

      <div className="model-form-page__price-grid">
        <label className="configuration-field">
          <span>{t("configuration.inputPrice")}</span>
          <input
            inputMode="decimal"
            value={values.inputPrice}
            onChange={(event) => setValues((current) => ({ ...current, inputPrice: event.target.value }))}
          />
        </label>

        <label className="configuration-field">
          <span>{t("configuration.outputPrice")}</span>
          <input
            inputMode="decimal"
            value={values.outputPrice}
            onChange={(event) => setValues((current) => ({ ...current, outputPrice: event.target.value }))}
          />
        </label>
      </div>

      <label className="model-form-page__checkbox">
        <input
          type="checkbox"
          checked={values.supportsImage}
          onChange={(event) => setValues((current) => ({ ...current, supportsImage: event.target.checked }))}
        />
        <span>{t("configuration.supportsImageInput")}</span>
      </label>

      <div className="model-form-page__actions">
        <button className="secondary-settings-button" type="button" onClick={onCancel}>
          {t("configuration.cancel")}
        </button>
        <button className="primary-settings-button" type="submit" disabled={!canSave}>
          {t("configuration.save")}
        </button>
      </div>
    </form>
  );
}
