export const CLIENT_ID_PATTERN = /^[a-zA-Z0-9-]{16,64}$/u;
export const COMMAND_ID_PATTERN = /^[0-9]{1,12}$/u;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_PENDING_COMMANDS = 64;
export const MAX_POLL_WAITERS = 16;

/** Validate protocol payloads before Host state changes or command settlement. */
export function validResult(body) {
  return Boolean(body && typeof body === "object" && !Array.isArray(body)
    && typeof body.id === "string" && COMMAND_ID_PATTERN.test(body.id)
    && typeof body.ok === "boolean"
    && (body.ok
      ? body.value === undefined || body.value === null || typeof body.value === "object"
      : body.error === undefined || body.error === null || typeof body.error === "object"));
}

/** Validate Client-originated state and tab events. */
export function validEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (event.kind === "new") return true;
  // Address-bar "open in a new tab" request from the panel UI.
  if (event.kind === "open") {
    return typeof event.url === "string" && event.url.length > 0 && event.url.length <= 8192;
  }
  if (!["switch", "close", "tab-update"].includes(event.kind)
    || typeof event.tabId !== "string" || event.tabId.length > 64) return false;
  if (event.kind !== "tab-update") return true;
  return (event.url === undefined || typeof event.url === "string" && event.url.length <= 8192)
    && (event.title === undefined || typeof event.title === "string" && event.title.length <= 512)
    && (event.loading === undefined || typeof event.loading === "boolean")
    && (event.canGoBack === undefined || typeof event.canGoBack === "boolean")
    && (event.canGoForward === undefined || typeof event.canGoForward === "boolean")
    && (event.crashed === undefined || typeof event.crashed === "boolean")
    && (event.navigated === undefined || typeof event.navigated === "boolean")
    && (event.reloaded === undefined || typeof event.reloaded === "boolean")
    && (event.snapshot === undefined || (event.snapshot !== null && typeof event.snapshot === "object"));
}
