import { Plus } from "lucide-react";
import { useState } from "react";
import { useFrontendConfig } from "../../../../config/FrontendConfigProvider";
import type { ModelConfig } from "./configurationTypes";

interface ModelManagerProps {
  models: ModelConfig[];
  onBack: () => void;
  onCreate: () => void;
  onDelete: (modelId: string) => void;
  onEdit: (model: ModelConfig) => void;
}

export function ModelManager({ models, onBack, onCreate, onDelete, onEdit }: ModelManagerProps) {
  const { t } = useFrontendConfig();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  return (
    <section className="model-manager-page" aria-labelledby="model-manager-heading">
      <div className="model-manager-page__header">
        <div>
          <h1 id="model-manager-heading">{t("configuration.modelManager")}</h1>
          <p>{t("configuration.priceNote")}</p>
        </div>

        <button className="secondary-settings-button secondary-settings-button--accent" type="button" onClick={onCreate}>
          <Plus aria-hidden="true" />
          <span>{t("configuration.newModel")}</span>
        </button>
      </div>

      <div className="model-manager-table" role="table" aria-label={t("configuration.modelTable")}>
        <div className="model-manager-table__row model-manager-table__row--head" role="row">
          <span role="columnheader">{t("configuration.tableModel")}</span>
          <span role="columnheader">{t("configuration.tableImage")}</span>
          <span role="columnheader">{t("configuration.tableInput")}</span>
          <span role="columnheader">{t("configuration.tableOutput")}</span>
          <span role="columnheader" aria-label={t("configuration.tableActions")} />
        </div>

        {models.map((model) => {
          const isDeleting = pendingDeleteId === model.id;

          return (
            <div className="model-manager-table__row" role="row" key={model.id}>
              <span className="model-manager-table__model" role="cell">
                <strong>{model.displayName}</strong>
                {model.providerPath && <small>{model.providerPath}</small>}
              </span>
              <span role="cell">
                <span className="image-support-pill" data-supported={model.supportsImage || undefined}>
                  {model.supportsImage ? t("configuration.supported") : t("configuration.unsupported")}
                </span>
              </span>
              <span className="model-manager-table__price" role="cell">
                {model.inputPrice}
              </span>
              <span className="model-manager-table__price" role="cell">
                {model.outputPrice}
              </span>
              <span className="model-manager-table__actions" role="cell">
                {isDeleting ? (
                  <span className="delete-confirmation">
                    <span>{t("configuration.confirmDelete")}</span>
                    <button
                      className="danger-settings-button"
                      type="button"
                      onClick={() => {
                        onDelete(model.id);
                        setPendingDeleteId(null);
                      }}
                    >
                      {t("configuration.delete")}
                    </button>
                    <button className="secondary-settings-button" type="button" onClick={() => setPendingDeleteId(null)}>
                      {t("configuration.cancel")}
                    </button>
                  </span>
                ) : (
                  <>
                    <button className="secondary-settings-button" type="button" onClick={() => onEdit(model)}>
                      {t("configuration.edit")}
                    </button>
                    <button
                      className="secondary-settings-button"
                      type="button"
                      onClick={() => setPendingDeleteId(model.id)}
                    >
                      {t("configuration.delete")}
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="model-manager-page__footer">
        <button className="primary-settings-button" type="button" onClick={onBack}>
          {t("configuration.done")}
        </button>
      </div>
    </section>
  );
}
