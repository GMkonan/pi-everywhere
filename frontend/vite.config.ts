import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  plugins: [svelte()],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
