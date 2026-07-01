import { useFrontendConfig } from "../../../../config/FrontendConfigProvider";
import type { SearchMode } from "./configurationTypes";

interface WebSearchSettingsProps {
  searchMode: SearchMode;
  tavilyApiKey: string;
  onSearchModeChange: (value: SearchMode) => void;
  onTavilyApiKeyChange: (value: string) => void;
}

export function WebSearchSettings({
  searchMode,
  tavilyApiKey,
  onSearchModeChange,
  onTavilyApiKeyChange,
}: WebSearchSettingsProps) {
  const { t } = useFrontendConfig();

  return (
    <section className="configuration-section configuration-section--search" aria-labelledby="web-search-heading">
      <h1 id="web-search-heading">{t("configuration.webSearch")}</h1>

      <label className="configuration-field">
        <span>{t("configuration.searchMode")}</span>
        <select
          value={searchMode}
          onChange={(event) => onSearchModeChange(event.target.value as SearchMode)}
          aria-label={t("configuration.searchMode")}
        >
          <option value="auto">auto</option>
          <option value="disabled">disabled</option>
          <option value="tavily">tavily</option>
        </select>
      </label>

      <label className="configuration-field">
        <span>{t("configuration.tavilyApiKey")}</span>
        <input
          type="password"
          value={tavilyApiKey}
          onChange={(event) => onTavilyApiKeyChange(event.target.value)}
        />
      </label>
    </section>
  );
}
