// Implements the right-sidebar embedded browser feature.
// Owns the native Tauri Webview lifecycle and keeps it aligned with the React host rectangle.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { navigateBrowserWebview } from "./browserClient";

interface UseBrowserWebviewOptions {
  hostRef: RefObject<HTMLDivElement>;
  isActive: boolean;
  webviewLabel: string;
}

interface UseBrowserWebviewResult {
  clearBrowsingData: () => Promise<void>;
  currentUrl: string | null;
  errorMessage: string | null;
  isLoaded: boolean;
  loadUrl: (url: string) => Promise<void>;
  setZoom: (scaleFactor: number) => Promise<void>;
}

const MIN_BROWSER_WEBVIEW_HEIGHT = 80;
const MIN_BROWSER_WEBVIEW_WIDTH = 120;

function getHostRect(host: HTMLElement) {
  const rect = host.getBoundingClientRect();

  return {
    height: Math.max(0, Math.round(rect.height)),
    width: Math.max(0, Math.round(rect.width)),
    x: Math.round(rect.left),
    y: Math.round(rect.top),
  };
}

function canShowWebview(host: HTMLElement, isActive: boolean, hasUrl: boolean) {
  if (!isActive || !hasUrl) return false;

  const rect = host.getBoundingClientRect();
  const style = getComputedStyle(host);
  return (
    rect.width >= MIN_BROWSER_WEBVIEW_WIDTH &&
    rect.height >= MIN_BROWSER_WEBVIEW_HEIGHT &&
    style.display !== "none" &&
    style.visibility !== "hidden"
  );
}

export function useBrowserWebview({
  hostRef,
  isActive,
  webviewLabel,
}: UseBrowserWebviewOptions): UseBrowserWebviewResult {
  const webviewRef = useRef<Webview | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  const isActiveRef = useRef(isActive);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const updateWebviewBounds = useCallback(async () => {
    const host = hostRef.current;
    const webview = webviewRef.current;
    if (!host || !webview) return;

    const shouldShow = canShowWebview(host, isActiveRef.current, Boolean(currentUrlRef.current));
    if (!shouldShow) {
      await webview.hide();
      return;
    }

    const rect = getHostRect(host);
    await webview.setPosition(new LogicalPosition(rect.x, rect.y));
    await webview.setSize(new LogicalSize(rect.width, rect.height));
    await webview.show();
  }, [hostRef]);

  const createWebview = useCallback(
    async (url: string) => {
      const host = hostRef.current;
      if (!host) throw new Error("Browser host is not mounted");

      const rect = getHostRect(host);
      const webview = new Webview(getCurrentWindow(), webviewLabel, {
        url,
        x: rect.x,
        y: rect.y,
        width: Math.max(MIN_BROWSER_WEBVIEW_WIDTH, rect.width),
        height: Math.max(MIN_BROWSER_WEBVIEW_HEIGHT, rect.height),
        focus: true,
        zoomHotkeysEnabled: true,
      });

      webviewRef.current = webview;
      webview.once("tauri://error", (event) => {
        const message = typeof event.payload === "string" ? event.payload : "Failed to create browser webview";
        setErrorMessage(message);
      });
      webview.once("tauri://created", () => {
        setErrorMessage(null);
        void updateWebviewBounds().catch((error) => {
          console.error("Failed to position browser webview", error);
        });
      });

      return webview;
    },
    [hostRef, updateWebviewBounds, webviewLabel],
  );

  const loadUrl = useCallback(
    async (url: string) => {
      currentUrlRef.current = url;
      setCurrentUrl(url);
      setIsLoaded(true);
      setErrorMessage(null);

      try {
        const webview = webviewRef.current;
        if (!webview) {
          await createWebview(url);
          return;
        }

        await navigateBrowserWebview(webviewLabel, url);
        await updateWebviewBounds();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
      }
    },
    [createWebview, updateWebviewBounds, webviewLabel],
  );

  const setZoom = useCallback(async (scaleFactor: number) => {
    const webview = webviewRef.current;
    if (!webview) return;

    await webview.setZoom(scaleFactor);
  }, []);

  const clearBrowsingData = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;

    await webview.clearAllBrowsingData();
  }, []);

  useEffect(() => {
    void updateWebviewBounds().catch((error) => {
      console.error("Failed to update browser webview visibility", error);
    });
  }, [isActive, updateWebviewBounds]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        void updateWebviewBounds().catch((error) => {
          console.error("Failed to resize browser webview", error);
        });
      });
    });

    resizeObserver.observe(host);
    window.addEventListener("resize", updateWebviewBounds);

    return () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateWebviewBounds);
    };
  }, [hostRef, updateWebviewBounds]);

  useEffect(() => {
    return () => {
      const webview = webviewRef.current;
      webviewRef.current = null;
      if (webview) {
        void webview.close().catch((error) => {
          console.error("Failed to close browser webview", error);
        });
      }
    };
  }, []);

  return {
    clearBrowsingData,
    currentUrl,
    errorMessage,
    isLoaded,
    loadUrl,
    setZoom,
  };
}
