/**
 * Share link ↔ ticket serialization.
 *
 * The ticket lives only in the URL fragment (#…): it is never sent to a
 * server (no logs, no analytics). Two fragment forms are recognized:
 * - `#t=<base64url>[&n=<name>]` — compact payload (version, node id, hash,
 *   format), resolved through the N0 DNS discovery; built by `encodeLink`.
 *   `n` carries the original file name out-of-band (optional, best effort).
 * - `#ticket=blob…` — full iroh-blobs ticket (fallback, carries the
 *   explicit addresses).
 */

/** Longest file name carried in a share link (UTF-16 code units). */
const MAX_NAME_LEN = 120;

/** Strips anything unsafe for a download name; null when nothing is left. */
export function sanitizeFilename(name: string): string | null {
  const clean = name
    .replace(/[\u0000-\u001f\u007f/\\:]/g, "")
    .trim()
    .slice(0, MAX_NAME_LEN)
    .trim();
  return clean || null;
}

export interface ShareLink {
  ticket: string;
  /** Original file name (sanitized), or null when absent. */
  name: string | null;
}

/** Percent-decodes a fragment value, falling back to the raw string. */
function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Builds the share link for a compact ticket payload. */
export function encodeLink(shortTicket: string, name?: string | null): string {
  const url = new URL(location.href);
  const clean = sanitizeFilename(name ?? "");
  url.hash = clean ? `t=${shortTicket}&n=${encodeURIComponent(clean)}` : `t=${shortTicket}`;
  return url.toString();
}

/** Extracts a ticket (and optional file name) from a URL fragment, or null. */
export function parseTicketFromUrl(url: URL): ShareLink | null {
  const hash = url.hash;
  if (hash.length <= 1) return null;
  const params = new Map<string, string>();
  for (const pair of hash.slice(1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    if (!params.has(key)) params.set(key, decodeValue(pair.slice(eq + 1)));
  }
  const ticket = params.get("t") ?? params.get("ticket");
  if (!ticket) return null;
  const rawName = params.get("n");
  return { ticket, name: rawName ? sanitizeFilename(rawName) : null };
}

/** Removes the ticket fragment from the address bar. */
export function clearTicketFromUrl(): void {
  history.replaceState(null, "", location.pathname + location.search);
}
