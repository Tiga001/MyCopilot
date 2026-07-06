// Implements the right-sidebar embedded browser feature.
// Wraps Rust navigation commands for the native Webview-backed browser panel.

import { invoke } from "@tauri-apps/api/core";

export interface BrowserPageMetadata {
  iconUrl: string | null;
  title: string | null;
}

export function navigateBrowserWebview(webviewLabel: string, url: string): Promise<void> {
  return invoke("browser_navigate_url", { webviewLabel, url });
}

export function fetchBrowserPageMetadata(url: string): Promise<BrowserPageMetadata> {
  return invoke("browser_fetch_page_metadata", { url });
}

export function reloadBrowserWebview(webviewLabel: string): Promise<void> {
  return invoke("browser_reload", { webviewLabel });
}

export function goBackBrowserWebview(webviewLabel: string): Promise<void> {
  return invoke("browser_go_back", { webviewLabel });
}

export function goForwardBrowserWebview(webviewLabel: string): Promise<void> {
  return invoke("browser_go_forward", { webviewLabel });
}
