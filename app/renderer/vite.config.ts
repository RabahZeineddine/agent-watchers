import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * O renderer do Locum. Nao existe servidor por tras dele: a janela carrega o
 * que saiu daqui, do disco, pelo esquema proprio que o processo principal
 * atende. Por isso `base` e relativa, e por isso nada aqui pode depender de
 * rede em tempo de execucao.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
});
