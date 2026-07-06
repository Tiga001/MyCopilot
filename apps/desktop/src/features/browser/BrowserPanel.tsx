// Implements the right-sidebar embedded browser feature.
// Renders browser controls while the native Tauri Webview owns page content.

import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe2, Minus, MoreVertical, Plus, RefreshCw } from "lucide-react";
import { useFrontendConfig } from "../../config/FrontendConfigProvider";
import {
  fetchBrowserPageMetadata,
  goBackBrowserWebview,
  goForwardBrowserWebview,
  reloadBrowserWebview,
} from "./browserClient";
import type { BrowserPageMetadata } from "./browserClient";
import { normalizeBrowserUrl } from "./browserUrl";
import { useBrowserWebview } from "./useBrowserWebview";
import "./BrowserPanel.css";

interface BrowserPanelProps {
  isActive: boolean;
  onPageMetadataChange?: (metadata: BrowserPageMetadata) => void;
  pageId: string;
}

const ZOOM_STEP = 0.1;

function clampZoom(value: number) {
  return Math.min(3, Math.max(0.3, value));
}

function getFallbackPageTitle(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function BrowserPanel({ isActive, onPageMetadataChange, pageId }: BrowserPanelProps) {
  const { t } = useFrontendConfig();
  const hostRef = useRef<HTMLDivElement>(null);
  const metadataRequestIdRef = useRef(0);
  const webviewLabel = useMemo(() => `right-sidebar-browser-${pageId}`, [pageId]);
  const [addressValue, setAddressValue] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const {
    clearBrowsingData,
    currentUrl,
    errorMessage,
    isLoaded,
    loadUrl,
    setZoom,
  } = useBrowserWebview({
    hostRef,
    isActive,
    webviewLabel,
  });

  const submitAddress = useCallback(async () => {
    const url = normalizeBrowserUrl(addressValue);
    if (!url) return;

    setAddressValue(url);
    const metadataRequestId = metadataRequestIdRef.current + 1;
    metadataRequestIdRef.current = metadataRequestId;
    onPageMetadataChange?.({
      iconUrl: null,
      title: getFallbackPageTitle(url),
    });
    await loadUrl(url);

    void fetchBrowserPageMetadata(url)
      .then((metadata) => {
        if (metadataRequestIdRef.current !== metadataRequestId) return;
        onPageMetadataChange?.({
          iconUrl: metadata.iconUrl,
          title: metadata.title?.trim() || getFallbackPageTitle(url),
        });
      })
      .catch((error) => {
        console.warn("Failed to fetch browser page metadata", error);
      });
  }, [addressValue, loadUrl, onPageMetadataChange]);

  const updateZoom = useCallback(
    async (nextZoom: number) => {
      const normalizedZoom = clampZoom(nextZoom);
      setZoomState(normalizedZoom);
      await setZoom(normalizedZoom);
    },
    [setZoom],
  );

  return (
    <section className="browser-panel" aria-label={t("browser.title")}>
      <header className="browser-panel__toolbar">
        <div className="browser-panel__navigation">
          <button
            className="browser-panel__icon-button"
            type="button"
            aria-label={t("browser.back")}
            aria-disabled={!isLoaded}
            title={t("browser.back")}
            onClick={() => {
              if (isLoaded) void goBackBrowserWebview(webviewLabel);
            }}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <button
            className="browser-panel__icon-button"
            type="button"
            aria-label={t("browser.forward")}
            aria-disabled={!isLoaded}
            title={t("browser.forward")}
            onClick={() => {
              if (isLoaded) void goForwardBrowserWebview(webviewLabel);
            }}
          >
            <ArrowRight aria-hidden="true" />
          </button>
          <button
            className="browser-panel__icon-button"
            type="button"
            aria-label={t("browser.reload")}
            aria-disabled={!isLoaded}
            title={t("browser.reload")}
            onClick={() => {
              if (isLoaded) void reloadBrowserWebview(webviewLabel);
            }}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>

        <form
          className="browser-panel__address"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAddress();
          }}
        >
          <input
            value={addressValue}
            type="text"
            spellCheck={false}
            placeholder={t("browser.addressPlaceholder")}
            aria-label={t("browser.addressPlaceholder")}
            onChange={(event) => setAddressValue(event.target.value)}
          />
        </form>

        <div className="browser-panel__menu-anchor">
          <button
            className="browser-panel__icon-button"
            type="button"
            aria-label={t("browser.menu")}
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((current) => !current)}
          >
            <MoreVertical aria-hidden="true" />
          </button>

          {isMenuOpen && (
            <div className="browser-panel__menu">
              <button
                className="browser-panel__menu-item"
                type="button"
                onClick={() => {
                  void clearBrowsingData();
                  setIsMenuOpen(false);
                }}
              >
                <span>{t("browser.clearBrowsingData")}</span>
              </button>

              <div className="browser-panel__zoom-row">
                <span>{t("browser.zoom")}</span>
                <div className="browser-panel__zoom-control">
                  <button type="button" aria-label={t("browser.zoomOut")} onClick={() => void updateZoom(zoom - ZOOM_STEP)}>
                    <Minus aria-hidden="true" />
                  </button>
                  <strong>{Math.round(zoom * 100)}%</strong>
                  <button type="button" aria-label={t("browser.zoomIn")} onClick={() => void updateZoom(zoom + ZOOM_STEP)}>
                    <Plus aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="browser-panel__content" ref={hostRef}>
        {!currentUrl && (
          <div className="browser-panel__empty">
            <Globe2 aria-hidden="true" />
            <h2>{t("browser.emptyTitle")}</h2>
            <p>{t("browser.emptyDescription")}</p>
          </div>
        )}
        {errorMessage && <div className="browser-panel__error">{errorMessage}</div>}
      </div>
    </section>
  );
}
