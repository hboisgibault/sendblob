/**
 * Sérialisation ticket iroh-blobs ↔ fragment d'URL (#ticket=...).
 *
 * Le ticket vit uniquement dans le fragment : il n'est jamais transmis à un
 * serveur (ni logs, ni analytics). Implémentation réelle en phase 3.
 */

export function encodeTicket(_ticket: Uint8Array): string {
  throw new Error("not implemented (phase 3)");
}

export function parseTicketFromUrl(_url: URL): Uint8Array | null {
  throw new Error("not implemented (phase 3)");
}
