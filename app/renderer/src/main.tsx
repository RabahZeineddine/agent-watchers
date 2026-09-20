import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ProvedorDeIdioma } from "./idioma";
import "./index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("a pagina subiu sem a raiz #root");

createRoot(root).render(
  <StrictMode>
    <ProvedorDeIdioma>
      <App />
    </ProvedorDeIdioma>
  </StrictMode>,
);
