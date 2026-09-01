import { createEffect, on } from "solid-js";
import { drawQr } from "./qr";

/** Canvas QR code, drawn at natural module size (crisp pixel look). */
export function Qr(props: { text: string }) {
  let canvas!: HTMLCanvasElement;
  createEffect(
    on(
      () => props.text,
      (text) => {
        if (text) drawQr(canvas, text);
      },
    ),
  );
  return <canvas ref={canvas} id="qr-canvas" class="qr-pixel" />;
}
