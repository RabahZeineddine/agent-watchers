import { fileURLToPath } from "node:url";
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
  resolve: {
    // O mesmo apelido que o tsconfig do renderer declara. Os componentes
    // vendorizados do shadcn chegam do registry importando por `@/`, e
    // reescrever import em arquivo de terceiro so criaria conflito na
    // proxima atualizacao.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  base: "./",
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
});
