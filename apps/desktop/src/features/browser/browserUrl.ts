// Implements the right-sidebar embedded browser feature.
// Normalizes user-entered locations before passing them to the native Webview.

export function normalizeBrowserUrl(input: string) {
  const trimmedInput = input.trim();
  if (!trimmedInput) return null;

  if (/^https?:\/\//i.test(trimmedInput)) {
    return trimmedInput;
  }

  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(trimmedInput)) {
    return `http://${trimmedInput}`;
  }

  return `https://${trimmedInput}`;
}
