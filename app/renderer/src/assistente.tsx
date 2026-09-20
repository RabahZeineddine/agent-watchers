import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { call, useRead } from "@/lib/bridge";
import { assinarEventosDoChat, type ChatEvent } from "@/lib/chat";
import { cn } from "@/lib/utils";
import { CornerDownLeft, MessageSquare, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Fala {
  de: "user" | "assistant";
  texto: string;
  ferramentas: string[];
}

/**
 * Console em linguagem natural, por cima da tela em que voce esta.
 *
 * Painel e nao quinta aba de proposito: a pergunta que ele recebe quase sempre
 * e sobre o que esta na tela, e mandar a pessoa sair da tela para perguntar
 * sobre ela e perder o assunto no caminho.
 *
 * Aprovar nao esta aqui e nao vai estar. O assistente le diff, achado e log,
 * que sao conteudo de terceiro; o catalogo dele vive em `electron/chat-tools.ts`
 * e e escrito a mao pelo motivo da emenda 5 do ADR 0003.
 */
export function Assistente() {
  const [aberto, setAberto] = useState(false);
  const [falas, setFalas] = useState<Fala[]>([]);
  const [rascunho, setRascunho] = useState("");
  const [respondendo, setRespondendo] = useState(false);
  const status = useRead("chat.status");
  const campo = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    function ouvir(evento: KeyboardEvent) {
      if (evento.key.toLowerCase() === "j" && (evento.metaKey || evento.ctrlKey)) {
        evento.preventDefault();
        setAberto((v) => !v);
      }
      if (evento.key === "Escape") setAberto(false);
    }
    globalThis.addEventListener("keydown", ouvir);
    return () => globalThis.removeEventListener("keydown", ouvir);
  }, []);

  useEffect(() => {
    if (aberto) campo.current?.focus();
  }, [aberto]);

  // O fluxo chega pedaco a pedaco e cai sempre na ultima fala do assistente.
  useEffect(() => {
    return assinarEventosDoChat((evento: ChatEvent) => {
      setFalas((atual) => {
        const copia = [...atual];
        const ultima = copia.at(-1);
        if (!ultima || ultima.de !== "assistant") return copia;

        if (evento.tipo === "texto") ultima.texto += evento.delta;
        else if (evento.tipo === "ferramenta") ultima.ferramentas = [...ultima.ferramentas, evento.nome];
        else if (evento.tipo === "erro") ultima.texto += `\n\n[${evento.mensagem}]`;
        return copia;
      });

      if (evento.tipo === "fim" || evento.tipo === "erro") setRespondendo(false);
    });
  }, []);

  async function enviar() {
    const texto = rascunho.trim();
    if (!texto || respondendo) return;
    setRascunho("");
    setRespondendo(true);
    setFalas((a) => [
      ...a,
      { de: "user", texto, ferramentas: [] },
      { de: "assistant", texto: "", ferramentas: [] },
    ]);
    await call("chat.send", texto);
  }

  if (!aberto) return <BotaoFlutuante aoAbrir={() => setAberto(true)} />;

  const indisponivel = status.status === "ready" && !status.data.disponivel;

  return (
    <aside className="border-border bg-popover/95 animate-in slide-in-from-right-4 fixed top-0 right-0 bottom-0 z-40 flex w-[420px] flex-col border-l shadow-2xl backdrop-blur-xl duration-200">
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <MessageSquare className="text-muted-foreground size-4" aria-hidden />
        <span className="flex-1 text-sm font-medium">Assistente</span>
        {status.status === "ready" && status.data.modelo && (
          <span className="text-muted-foreground font-mono text-[11px]">{status.data.modelo}</span>
        )}
        <Button
          className="size-7 cursor-pointer"
          onClick={() => setAberto(false)}
          size="icon"
          variant="ghost"
        >
          <X className="size-4" aria-hidden />
          <span className="sr-only">Fechar</span>
        </Button>
      </header>

      <Conversation className="flex-1">
        <ConversationContent className="gap-3 p-4">
          {falas.length === 0 && (
            <ConversationEmptyState
              description={
                indisponivel
                  ? (status.data.motivo ?? "assistente indisponível")
                  : "Pergunte sobre execuções, achados, custo ou configuração. Ele olha o estado real antes de responder."
              }
              icon={<MessageSquare className="size-5" />}
              title={indisponivel ? "Sem modelo escolhido" : "Console do Locum"}
            />
          )}

          {falas.map((fala, i) => (
            <Message from={fala.de} key={i}>
              <MessageContent>
                {fala.ferramentas.length > 0 && (
                  <p className="text-muted-foreground mb-1.5 flex flex-wrap items-center gap-1 text-xs">
                    <Wrench className="size-3" aria-hidden />
                    {fala.ferramentas.join(", ")}
                  </p>
                )}
                <p className="whitespace-pre-wrap text-sm">
                  {fala.texto}
                  {respondendo && i === falas.length - 1 && (
                    <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />
                  )}
                </p>
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
      </Conversation>

      <div className="border-border border-t p-3">
        <div
          className={cn(
            "border-border focus-within:border-ring bg-card flex items-end gap-2 rounded-lg border px-3 py-2 transition-colors duration-200",
            indisponivel && "opacity-60",
          )}
        >
          <textarea
            className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-sm outline-none"
            disabled={indisponivel}
            onChange={(e) => setRascunho(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void enviar();
              }
            }}
            placeholder={indisponivel ? "escolha o modelo em Configuração" : "Pergunte alguma coisa"}
            ref={campo}
            rows={1}
            value={rascunho}
          />
          {respondendo ? (
            <Button
              className="size-7 cursor-pointer"
              onClick={() => void call("chat.cancel")}
              size="icon"
              variant="ghost"
            >
              <Square className="size-3.5" aria-hidden />
              <span className="sr-only">Interromper</span>
            </Button>
          ) : (
            <Button
              className="size-7 cursor-pointer"
              disabled={indisponivel || rascunho.trim().length === 0}
              onClick={() => void enviar()}
              size="icon"
              variant="ghost"
            >
              <CornerDownLeft className="size-3.5" aria-hidden />
              <span className="sr-only">Enviar</span>
            </Button>
          )}
        </div>
        <p className="text-muted-foreground/70 mt-1.5 text-xs">
          Ele não aprova nem publica. A decisão continua sendo o seu clique na inbox.
        </p>
      </div>
    </aside>
  );
}

function BotaoFlutuante({ aoAbrir }: { aoAbrir: () => void }) {
  return (
    <button
      className="border-border bg-card/90 hover:bg-accent focus-visible:ring-ring fixed right-5 bottom-5 z-40 flex h-10 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm shadow-lg backdrop-blur transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
      onClick={aoAbrir}
      type="button"
    >
      <MessageSquare className="size-4" aria-hidden />
      Assistente
      <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">⌘J</kbd>
    </button>
  );
}
