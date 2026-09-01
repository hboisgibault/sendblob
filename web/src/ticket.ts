/**
 * iroh-blobs ticket ↔ URL fragment (#ticket=...) serialization.
 *
 * The ticket lives only in the fragment: it is never sent to a server
 * (no logs, no analytics). Real implementation in phase 3.
 */

export function encodeTicket(_ticket: Uint8Array): string {
  throw new Error("not implemented (phase 3)");
}

export function parseTicketFromUrl(_url: URL): Uint8Array | null {
  throw new Error("not implemented (phase 3)");
}
