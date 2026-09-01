/**
 * Local QR code generation (`qrcode` lib, zero external services).
 * The module matrix is drawn by hand on a canvas so the squares stay
 * hard-edged (pixel look), at the natural module size.
 */

import QRCode from "qrcode";

export interface QrStyle {
  cell?: number;
  quiet?: number;
  dark?: string;
  light?: string;
}

/** Draws `text` as a QR code on `canvas` (crisp squares, no smoothing). */
export function drawQr(
  canvas: HTMLCanvasElement,
  text: string,
  style: QrStyle = {},
): void {
  const cell = style.cell ?? 6;
  const quiet = style.quiet ?? 2;
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const data = qr.modules.data;
  const side = (count + quiet * 2) * cell;
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = style.light ?? "#faf3e3";
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = style.dark ?? "#2b2118";
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (data[y * count + x]) {
        ctx.fillRect((x + quiet) * cell, (y + quiet) * cell, cell, cell);
      }
    }
  }
}
