import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
  },
  worker: { format: "es" },
});
