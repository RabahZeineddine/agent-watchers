import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { useJanela } from "@/lib/janela";
import { cn } from "@/lib/utils";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { useState } from "react";
import { GrafoDaExecucao } from "../grafo";
import type { TelaProps } from "../rotas";

type Execucao = ReadResult<"runs.list">[number];
type Detalhe = NonNullable<ReadResult<"runs.get">>;
type Passo = Detalhe["steps"][number];

/** Altura de cada linha da lista. Fixa, porque a janela virtual conta com isso. */
const ALTURA_DA_LINHA = 56;

/**
 * A tela de execucoes: a lista, e o detalhe de uma delas.
 *
 * Qual das duas aparece sai do hash, e nao de estado local, porque recarregar
 * a janela no detalhe de um run precisa voltar para o mesmo run. O roteador
 * entrega o identificador em `detalhe`.
 */
export function Execucoes({ detalhe, navegar }: TelaProps) {
  return detalhe === null ? (
    <Lista navegar={navegar} />
  ) : (
    <Execucao navegar={navegar} runId={detalhe} />
  );
}

/* ------------------------------------------------------------------ lista */

function Lista({ navegar }: { navegar: TelaProps["navegar"] }) {
  // O limite e alto de proposito: a janela virtual abaixo e quem sustenta a
  // lista longa, e pedir de vinte em vinte traria paginacao para uma tela que
  // ninguem pagina, ela rola.
  const runs = useRead("runs.list", { limit: 500 });
  const linhas = runs.data ?? [];
  const janela = useJanela(linhas.length, ALTURA_DA_LINHA);

  return (
    <div className="flex h-full flex-col">
      <div
        className="mb-3 text-muted-foreground text-xs"
        data-estado={runs.status}
        data-locum-probe="execucoes"
        data-runs={linhas.map((r) => r.id).join(",")}
        data-total={linhas.length}
      >
        {runs.status === "error"
          ? `a ponte recusou: ${runs.error.message}`
          : runs.status === "loading"
            ? "lendo execucoes..."
            : `${linhas.length} execucao(oes)`}
      </div>

      {runs.status === "ready" && linhas.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nenhuma execucao ainda. O comando <code>npm run dev demo</code> cria uma
          a partir do evento sintetico.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border" ref={janela.ref}>
          {/*
            Os espacadores sustentam a barra de rolagem no tamanho da lista
            inteira enquanto so as linhas visiveis existem no DOM.
          */}
          <div style={{ height: janela.antes }} />
          {linhas.slice(janela.inicio, janela.fim).map((run) => (
            <LinhaDeExecucao key={run.id} navegar={navegar} run={run} />
          ))}
          <div style={{ height: janela.depois }} />
        </div>
      )}
    </div>
  );
}

function LinhaDeExecucao({
  navegar,
  run,
}: {
  navegar: TelaProps["navegar"];
  run: Execucao;
}) {
  return (
    <button
      className="flex w-full items-center gap-3 border-border border-b px-4 text-left text-sm last:border-b-0 hover:bg-accent/50"
      data-locum-run={run.id}
      onClick={() => navegar("execucoes", run.id)}
      style={{ height: ALTURA_DA_LINHA }}
      type="button"
    >
      <Estado status={run.status} />
      <span className="w-48 shrink-0 truncate font-medium">
        {run.agentId} <span className="text-muted-foreground">v{run.agentVersion}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
        {run.agentName}
      </span>
      <span className="shrink-0 text-muted-foreground text-xs">{quando(run.createdAt)}</span>
      <span className="w-28 shrink-0 text-right tabular-nums">{dinheiro(run)}</span>
    </button>
  );
}

/* ----------------------------------------------------------------- detalhe */

function Execucao({ navegar, runId }: { navegar: TelaProps["navegar"]; runId: string }) {
  const run = useRead("runs.get", runId);
  const achados = useRead("runs.findings", runId);

  if (run.status === "error") {
    return <Aviso probe="execucao">a ponte recusou: {run.error.message}</Aviso>;
  }
  if (run.status === "loading") {
    return <Aviso probe="execucao">lendo a execucao...</Aviso>;
  }
  if (run.data === undefined) {
    return <Aviso probe="execucao">execucao {runId} nao existe mais</Aviso>;
  }

  const detalhe = run.data;
  // O primeiro passo com saida carrega o marcador do bloco de codigo, que e
  // por onde o smoke confere que o destaque do shiki chegou: ele precisa de um
  // alvo estavel, e nao do primeiro `pre` que aparecer na tela.
  const comSaida = detalhe.steps.find((p) => p.output !== null)?.stepKey ?? null;

  return (
    <div
      className="flex flex-col gap-4"
      data-achados={achados.data?.length ?? -1}
      data-chaves={detalhe.steps.map((p) => p.stepKey).join(",")}
      data-locum-probe="execucao"
      data-passos={detalhe.steps.length}
      data-run={detalhe.id}
    >
      <div className="flex items-center gap-3">
        <Button onClick={() => navegar("execucoes")} size="sm" variant="ghost">
          <ArrowLeft className="size-4" />
          Execucoes
        </Button>
        <Estado status={detalhe.status} />
        <span className="font-medium text-sm">
          {detalhe.agentId} <span className="text-muted-foreground">v{detalhe.agentVersion}</span>
        </span>
        <span className="text-muted-foreground text-xs">{quando(detalhe.createdAt)}</span>
        <span className="ml-auto text-sm tabular-nums">{dinheiro(detalhe)}</span>
      </div>

      {detalhe.error !== null ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {detalhe.error}
        </p>
      ) : null}

      {/*
        O grafo antes da linha do tempo de proposito: ele responde "o que esta
        esperando o que", e a lista abaixo responde "o que aconteceu em cada
        um". Quem abre um run parado quer a primeira pergunta.
      */}
      <GrafoDaExecucao detalhe={detalhe} />

      <ol className="flex flex-col gap-3">
        {detalhe.steps.map((passo) => (
          <li key={passo.id}>
            <PassoDaExecucao
              marcado={passo.stepKey === comSaida}
              passo={passo}
              runId={detalhe.id}
            />
          </li>
        ))}
      </ol>

      <Achados achados={achados.data ?? []} />
    </div>
  );
}

/**
 * Um passo na linha do tempo.
 *
 * O `Reasoning` guarda como o passo foi resolvido, que e a parte que some da
 * tela quando tudo da certo e e a primeira que se procura quando nao da: qual
 * modelo foi pedido, qual rodou, por que trocou, e quais skills entraram.
 */
function PassoDaExecucao({
  marcado,
  passo,
  runId,
}: {
  marcado: boolean;
  passo: Passo;
  runId: string;
}) {
  const segundos =
    passo.startedAt !== null && passo.endedAt !== null ? passo.endedAt - passo.startedAt : undefined;
  const ferramentas = lista(passo.toolsUsed);
  const skills = lista(passo.skillsUsed).map((s) =>
    typeof s === "object" && s !== null && "name" in s ? String((s as { name: unknown }).name) : String(s),
  );

  return (
    <div className="rounded-lg border border-border px-4 py-3" data-locum-passo={passo.stepKey}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground tabular-nums">{passo.idx + 1}</span>
        <span className="font-medium">{passo.name}</span>
        <Estado status={passo.status} />
        <span className="text-muted-foreground text-xs">
          {passo.modelUsed ?? "acao"}
          {passo.substitutionReason !== null ? " (substituido)" : ""}
        </span>
        <span className="ml-auto flex items-center gap-3 text-muted-foreground text-xs tabular-nums">
          <span>{segundos === undefined ? "-" : `${segundos}s`}</span>
          <span>
            {passo.promptTokens + passo.completionTokens} tok
          </span>
          <span>{passo.costUsd.toFixed(3)} USD</span>
          <Reexecutar runId={runId} stepKey={passo.stepKey} />
        </span>
      </div>

      {passo.error !== null ? (
        <p className="mt-2 text-destructive text-xs">{passo.error}</p>
      ) : null}

      {ferramentas.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {ferramentas.map((nome) => (
            <Badge key={String(nome)} variant="outline">
              {String(nome)}
            </Badge>
          ))}
        </div>
      ) : null}

      {passo.modelRequested !== null ? (
        <Reasoning defaultOpen={false} duration={segundos}>
          <ReasoningTrigger>Como o passo foi resolvido</ReasoningTrigger>
          <ReasoningContent>
            {[
              `Modelo pedido: \`${passo.modelRequested}\``,
              `Modelo usado: \`${passo.modelUsed ?? "nenhum"}\``,
              passo.substitutionReason !== null
                ? `Motivo da substituicao: ${passo.substitutionReason}`
                : "Sem substituicao nesta maquina.",
              skills.length > 0 ? `Skills: ${skills.join(", ")}` : "Nenhuma skill selecionada.",
              `Tentativa ${passo.attempt}, ${passo.promptTokens} token(s) de entrada e ${passo.completionTokens} de saida.`,
            ].join("\n\n")}
          </ReasoningContent>
        </Reasoning>
      ) : null}

      {passo.input !== null ? <Json rotulo="Entrada" valor={passo.input} /> : null}
      {passo.output !== null ? (
        <Json marcado={marcado} rotulo="Saida" valor={passo.output} />
      ) : null}
    </div>
  );
}

/**
 * O botao de reexecutar.
 *
 * Ele manda `wait: false` porque o pipeline leva minutos: esperar o desfecho
 * deixaria a promessa do IPC pendurada e a tela travada com um botao que nao
 * volta. O servico zera o passo e os que dependem dele antes de soltar o
 * executor, entao o que a tela le depois ja e o estado novo.
 */
function Reexecutar({ runId, stepKey }: { runId: string; stepKey: string }) {
  const [estado, setEstado] = useState<"parado" | "pedindo" | "erro">("parado");

  return (
    <Button
      data-locum-rerun={stepKey}
      disabled={estado === "pedindo"}
      onClick={() => {
        setEstado("pedindo");
        call("runs.rerunStep", runId, stepKey, { wait: false }).then(
          () => globalThis.location.reload(),
          () => setEstado("erro"),
        );
      }}
      size="sm"
      title={estado === "erro" ? "a reexecucao foi recusada" : `reexecutar ${stepKey}`}
      variant="ghost"
    >
      <RotateCcw className={cn("size-3.5", estado === "erro" && "text-destructive")} />
    </Button>
  );
}

function Achados({ achados }: { achados: ReadResult<"runs.findings"> }) {
  if (achados.length === 0) return null;

  return (
    <Task defaultOpen>
      <TaskTrigger title={`${achados.length} achado(s)`} />
      <TaskContent>
        {achados.map((achado, i) => (
          <TaskItem key={`${achado.file ?? "geral"}-${achado.line ?? i}`}>
            <Badge variant={achado.severity === "critical" ? "destructive" : "secondary"}>
              {achado.severity}
            </Badge>{" "}
            <TaskItemFile>
              {achado.file ?? "geral"}
              {achado.line === undefined ? "" : `:${achado.line}`}
            </TaskItemFile>{" "}
            {achado.problem}
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

/* ----------------------------------------------------------------- pedacos */

function Json({
  marcado = false,
  rotulo,
  valor,
}: {
  marcado?: boolean;
  rotulo: string;
  valor: unknown;
}) {
  return (
    <div className="mt-2" {...(marcado ? { "data-locum-probe": "code-block" } : {})}>
      <p className="mb-1 text-muted-foreground text-xs">{rotulo}</p>
      <CodeBlock code={JSON.stringify(valor, null, 2)} language="json">
        <CodeBlockCopyButton />
      </CodeBlock>
    </div>
  );
}

/** As cores dos estados, num lugar so, porque lista e detalhe mostram os mesmos. */
const CORES: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  done: "secondary",
  running: "default",
  queued: "outline",
  pending: "outline",
  paused: "default",
  awaiting_approval: "default",
  skipped: "outline",
  failed: "destructive",
  cancelled: "outline",
};

function Estado({ status }: { status: string }) {
  return (
    <Badge data-locum-estado={status} variant={CORES[status] ?? "outline"}>
      {status}
    </Badge>
  );
}

function Aviso({ children, probe }: { children: React.ReactNode; probe: string }) {
  return (
    <p className="text-muted-foreground text-sm" data-locum-probe={probe} data-passos={-1}>
      {children}
    </p>
  );
}

/** O que sai de coluna JSON chega como `unknown`: so vira lista se for uma. */
function lista(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : [];
}

function quando(segundos: number): string {
  return new Date(segundos * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * O par cobrado e equivalente, sempre junto.
 *
 * Passo que roda na assinatura nao cobra dinheiro, e mostrar so o cobrado faria
 * toda execucao parecer gratuita.
 */
function dinheiro(run: { costUsd: number; estimateUsd: number }): string {
  return `${run.costUsd.toFixed(3)} / ${run.estimateUsd.toFixed(3)} USD`;
}
