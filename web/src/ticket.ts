/**
 * Share link ↔ ticket serialization.
 *
 * The ticket lives only in the URL fragment (#…): it is never sent to a
 * server (no logs, no analytics). Two fragment forms are recognized:
 * - `#t=<base64url>` — compact payload (version, node id, hash, format),
 *   resolved through the N0 DNS discovery; built by `encodeLink`;
 * - `#ticket=blob…` — full iroh-blobs ticket (fallback, carries the
 *   explicit addresses).
 */

/** Builds the share link for a compact ticket payload. */
export function encodeLink(shortTicket: string): string {
  const url = new URL(location.href);
  url.hash = `t=${shortTicket}`;
  return url.toString();
}

/** Extracts a ticket from a URL fragment, or null. */
export function parseTicketFromUrl(url: URL): string | null {
  const hash = url.hash;
  for (const prefix of ["#t=", "#ticket="]) {
    if (hash.startsWith(prefix) && hash.length > prefix.length) {
      return decodeURIComponent(hash.slice(prefix.length));
    }
  }
  return null;
}

/** Removes the ticket fragment from the address bar. */
export function clearTicketFromUrl(): void {
  history.replaceState(null, "", location.pathname + location.search);
}
