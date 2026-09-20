export function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-zinc-950 text-zinc-100">
      <h1 className="text-2xl font-semibold">Locum</h1>
      <p className="text-sm text-zinc-400">
        A janela subiu. As telas entram nas proximas stories.
      </p>
      {/*
        Marcador do smoke. Ele confere que este elemento esta com display none,
        o que so acontece se a folha construida pelo Tailwind chegou na pagina:
        raiz montada prova o React, nao prova o CSS.
      */}
      <span data-locum-probe="tailwind" className="hidden">
        folha de estilo carregada
      </span>
    </main>
  );
}
