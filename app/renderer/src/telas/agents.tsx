import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { comContexto, diffJson, type LinhaDoDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";

type Versao = ReadResult<"agents.versions">[number];
type Spec = Versao["spec"];
type Passo = Spec["steps"][number];
type Previa = ReadResult<"providers.preview">[number];
type Ferramenta = ReadResult<"mcp.tools">[number];

/**
 * A tela de agents, somente leitura.
 *
 * Ela responde tres perguntas: quais agents existem, como cada um mudou ao
 * longo do tempo, e o que cada passo vira nesta maquina. Editar spec nao entra
 * aqui: o editor e outra story, e a gravacao tem regra propria no
 * `AgentService`, que rebaixa passo de acao conforme quem escreve.
 */
export function Agents({ detalhe, navegar }: TelaProps) {
  return detalhe === null ? (
    <Lista navegar={navegar} />
  ) : (
    <Agent agentId={detalhe} navegar={navegar} />
  );
}

/* ------------------------------------------------------------------ lista */

function Lista({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const agents = useRead("agents.list");
  const linhas = agents.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div
        className="text-muted-foreground text-xs"
        data-agents={linhas.map((a) => a.id).join(",")}
        data-estado={agents.status}
        data-locum-probe="agents"
        data-total={linhas.length}
      >
        {agents.status === "error"
          ? t("agents.refused", { message: agents.error.message })
          : agents.status === "loading"
            ? t("agents.loading")
            : t("agents.count", { count: linhas.length })}
      </div>

      {agents.status === "ready" && linhas.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans components={{ code: <code /> }} i18nKey="agents.empty" />
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {linhas.map((agent) => (
            <button
              className="flex w-full items-center gap-3 border-border border-b px-4 py-3 text-left text-sm last:border-b-0 hover:bg-accent/50"
              data-locum-agent={agent.id}
              key={agent.id}
              onClick={() => navegar("agents", agent.id)}
              type="button"
            >
              <span className="w-48 shrink-0 truncate font-medium">{agent.id}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                {agent.name}
              </span>
              <Badge variant={agent.enabled ? "secondary" : "outline"}>
                {t(agent.enabled ? "agents.enabled" : "agents.disabled")}
              </Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- detalhe */

/**
 * Um agent: o historico de versoes, o spec da versao escolhida e a comparacao
 * com outra.
 *
 * As versoes chegam da mais nova para a mais velha, que e a ordem do servico, e
 * e a ordem em que se procura: o que mudou por ultimo e o que se quer ver
 * primeiro.
 */
function Agent({ agentId, navegar }: { agentId: string; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const versoes = useRead("agents.versions", agentId);
  const maquina = useRead("machine.profile");
  const [escolhida, setEscolhida] = useState<number | null>(null);
  const [contra, setContra] = useState<number | null>(null);

  if (versoes.status === "error") {
    return <Aviso probe="agent">{t("agents.refused", { message: versoes.error.message })}</Aviso>;
  }
  if (versoes.status === "loading") {
    return <Aviso probe="agent">{t("agents.detail.loading")}</Aviso>;
  }
  if (versoes.data.length === 0) {
    return <Aviso probe="agent">{t("agents.detail.missing", { agentId })}</Aviso>;
  }

  const lista = versoes.data;
  // Sem escolha, a versao do topo e a que vale, e a comparacao e contra a
  // anterior: e o par que responde "o que mudou da ultima vez".
  const atual = lista.find((v) => v.version === escolhida) ?? lista[0]!;
  const anterior = lista.find((v) => v.version === contra) ?? lista[1];

  return (
    <div
      className="flex flex-col gap-4"
      data-agent={agentId}
      data-comparando={anterior === undefined ? "" : `${anterior.version}:${atual.version}`}
      data-locum-probe="agent"
      data-versao={atual.version}
      data-versoes={lista.map((v) => v.version).join(",")}
    >
      <div className="flex items-center gap-3">
        <Button onClick={() => navegar("agents")} size="sm" variant="ghost">
          <ArrowLeft className="size-4" />
          {t("agents.detail.back")}
        </Button>
        <span className="font-medium text-sm">{atual.spec.name}</span>
        <span className="text-muted-foreground text-xs">{agentId}</span>
        <span className="ml-auto text-muted-foreground text-xs">
          {t("agents.detail.versions", { count: lista.length })}
        </span>
      </div>

      <Historico
        atual={atual.version}
        contra={anterior?.version ?? null}
        escolher={setEscolhida}
        lista={lista}
        marcar={setContra}
      />

      <Passos
        maquina={maquina.data?.machineId ?? null}
        spec={atual.spec}
        versao={atual.version}
      />

      <Comparacao anterior={anterior} atual={atual} />
    </div>
  );
}

/**
 * O historico, uma linha por versao.
 *
 * Cada linha tem dois alvos de clique: o corpo escolhe a versao que a tela
 * mostra, e o botao da direita escolhe contra quem comparar. Sao duas escolhas
 * diferentes sobre a mesma lista, e junta-las num clique so faria a comparacao
 * mudar de par toda vez que alguem quisesse so olhar um spec.
 */
function Historico({
  atual,
  contra,
  escolher,
  lista,
  marcar,
}: {
  atual: number;
  contra: number | null;
  escolher: (v: number) => void;
  lista: Versao[];
  marcar: (v: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {lista.map((versao) => {
        const acao = versao.spec.steps.find((p) => p.type === "action");
        return (
          <div
            className={cn(
              "flex items-center gap-3 border-border border-b px-4 py-2 text-sm last:border-b-0",
              versao.version === atual && "bg-accent/40",
            )}
            data-locum-versao={versao.version}
            key={versao.id}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => escolher(versao.version)}
              type="button"
            >
              <span className="w-12 shrink-0 tabular-nums">
                {t("common.version", { version: versao.version })}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {quando(versao.createdAt)}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                {versao.note ?? t("agents.history.noNote")}
              </span>
              {acao === undefined ? null : (
                <Badge
                  data-locum-modo={versao.version}
                  variant={acao.mode === "approve" ? "secondary" : "destructive"}
                >
                  {acao.mode}
                </Badge>
              )}
            </button>
            <Button
              data-locum-comparar={versao.version}
              disabled={versao.version === atual}
              onClick={() => marcar(versao.version)}
              size="sm"
              variant={versao.version === contra ? "secondary" : "ghost"}
            >
              {t("agents.history.compare")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ passos */

/**
 * Os passos do spec: o que a definicao pede e o que esta maquina faz com isso.
 *
 * O modelo pedido e do spec e nunca muda; o resolvido sai da tabela de
 * substituicao desta maquina. Mostrar os dois lado a lado e o ponto da tela:
 * um spec que diz `claude-opus-5` e uma maquina sem assinatura rodam coisas
 * diferentes, e so aqui da para ver isso sem disparar um run.
 */
function Passos({
  maquina,
  spec,
  versao,
}: {
  maquina: string | null;
  spec: Spec;
  versao: number;
}) {
  // Os modelos entram deduplicados: spec com dois passos no mesmo modelo faria
  // a mesma pergunta duas vezes e o resultado seria o mesmo.
  const modelos = useMemo(
    () => [...new Set(spec.steps.filter((p) => p.type === "model").map((p) => p.model))],
    [spec],
  );

  // A leitura so faz sentido com a maquina conhecida, e ela chega por outra
  // leitura. Lista vazia enquanto isso: o canal responde `[]` sem tocar no
  // banco, e a tela repinta quando o identificador chegar.
  const previas = useRead("providers.preview", maquina === null ? [] : modelos, maquina ?? "");
  const porModelo = new Map<string, Previa>();
  for (const previa of previas.data ?? []) {
    porModelo.set(previa.ok ? previa.resolution.requested : previa.requested, previa);
  }

  return (
    <ol
      className="flex flex-col gap-3"
      data-locum-maquina={maquina ?? ""}
      data-locum-passos={spec.steps.length}
      data-locum-previas={previas.status}
      data-versao={versao}
    >
      {spec.steps.map((passo, i) => (
        <li key={passo.key}>
          <PassoDoSpec
            indice={i}
            passo={passo}
            previa={passo.type === "model" ? porModelo.get(passo.model) : undefined}
            spec={spec}
          />
        </li>
      ))}
    </ol>
  );
}

function PassoDoSpec({
  indice,
  passo,
  previa,
  spec,
}: {
  indice: number;
  passo: Passo;
  previa: Previa | undefined;
  spec: Spec;
}) {
  const { t } = useTranslation();
  const ferramentas = passo.type === "model" ? (passo.tools ?? spec.defaultTools) : [];

  return (
    <div className="rounded-lg border border-border px-4 py-3" data-locum-passo={passo.key}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground tabular-nums">{indice + 1}</span>
        <span className="font-medium">{passo.name}</span>
        <Badge variant="outline">{passo.type}</Badge>
        {passo.optional ? <Badge variant="outline">{t("agents.step.optional")}</Badge> : null}
        {passo.type === "action" ? (
          <Badge variant={passo.mode === "approve" ? "secondary" : "destructive"}>
            {passo.mode}
          </Badge>
        ) : null}
        <span className="ml-auto text-muted-foreground text-xs">
          {passo.needs.length === 0
            ? t("agents.step.noDependency")
            : t("agents.step.dependsOn", { steps: passo.needs.join(", ") })}
        </span>
      </div>

      {passo.type === "model" ? (
        <Resolucao pedido={passo.model} previa={previa} />
      ) : (
        <p className="mt-2 text-muted-foreground text-xs">
          <Trans
            components={{ code: <code /> }}
            i18nKey="agents.step.action"
            values={{ action: passo.action, input: passo.input ?? t("agents.step.noInput") }}
          />
        </p>
      )}

      {passo.type === "model" && passo.requiresServers.length > 0 ? (
        <p className="mt-1 text-muted-foreground text-xs">
          {t("agents.step.requires", { servers: passo.requiresServers.join(", ") })}
        </p>
      ) : null}

      {ferramentas.length > 0 ? <Ferramentas refs={ferramentas} /> : null}
    </div>
  );
}

/** Pedido contra resolvido, com o motivo da troca quando houver. */
function Resolucao({ pedido, previa }: { pedido: string; previa: Previa | undefined }) {
  const { t } = useTranslation();

  if (previa === undefined) {
    return (
      <p className="mt-2 text-muted-foreground text-xs" data-locum-modelo={pedido}>
        <Trans
          components={{ code: <code /> }}
          i18nKey="agents.step.resolving"
          values={{ model: pedido }}
        />
      </p>
    );
  }

  if (!previa.ok) {
    return (
      <p className="mt-2 text-destructive text-xs" data-locum-modelo={pedido}>
        <Trans
          components={{ code: <code /> }}
          i18nKey="agents.step.unresolved"
          values={{ error: previa.error, model: pedido }}
        />
      </p>
    );
  }

  const { used, substitutionReason } = previa.resolution;
  return (
    <p
      className="mt-2 text-muted-foreground text-xs"
      data-locum-modelo={pedido}
      data-locum-resolvido={used}
    >
      <Trans
        components={{ code: <code /> }}
        i18nKey="agents.step.resolved"
        values={{ model: pedido, used }}
      />
      {substitutionReason === undefined
        ? ""
        : t("agents.step.substitution", { reason: substitutionReason })}
    </p>
  );
}

/**
 * As ferramentas do passo, com o peso de cada uma no contexto.
 *
 * A contagem nao vem junto: ela exige falar com o servidor que expoe a
 * ferramenta, e subir todo servidor citado por um spec so porque alguem abriu
 * a tela seria caro e barulhento. Por isso o botao: sobe o que foi pedido, e
 * so quando foi pedido.
 */
function Ferramentas({ refs }: { refs: { server: string; tool: string; class: string }[] }) {
  const { t } = useTranslation();
  const [pesos, setPesos] = useState<Map<string, number>>(new Map());
  const [estado, setEstado] = useState<"parado" | "contando" | "erro">("parado");
  const servidores = [...new Set(refs.map((r) => r.server))];

  const contar = () => {
    setEstado("contando");
    Promise.all(
      servidores.map((nome) =>
        call("mcp.tools", nome).then((tools: Ferramenta[]) =>
          tools.map((t) => [`${nome}/${t.name}`, t.estimatedTokens] as const),
        ),
      ),
    ).then(
      (listas) => {
        setPesos(new Map(listas.flat()));
        setEstado("parado");
      },
      () => setEstado("erro"),
    );
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" data-locum-ferramentas={refs.length}>
      {refs.map((ref) => {
        const peso = pesos.get(`${ref.server}/${ref.tool}`);
        return (
          <Badge
            key={`${ref.server}/${ref.tool}`}
            variant={ref.class === "external_write" ? "destructive" : "outline"}
          >
            {ref.server}/{ref.tool}
            {peso === undefined ? "" : ` · ${t("agents.tools.tokens", { tokens: peso })}`}
          </Badge>
        );
      })}
      <Button
        data-locum-contar={servidores.join(",")}
        disabled={estado === "contando"}
        onClick={contar}
        size="sm"
        variant="ghost"
      >
        {estado === "erro"
          ? t("agents.tools.failed")
          : estado === "contando"
            ? t("agents.tools.counting")
            : t("agents.tools.count")}
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------- comparacao */

/**
 * O que mudou entre duas versoes do spec.
 *
 * Linha igual entra so como contexto em volta do que mudou: spec tem centenas
 * de linhas e quase todas sobrevivem de uma versao para a outra, entao mostrar
 * tudo esconderia a diferenca no meio do resto.
 */
function Comparacao({ anterior, atual }: { anterior: Versao | undefined; atual: Versao }) {
  const { t } = useTranslation();
  const linhas = useMemo(
    () => (anterior === undefined ? [] : comContexto(diffJson(anterior.spec, atual.spec))),
    [anterior, atual],
  );

  if (anterior === undefined) {
    return (
      <div data-locum-diff="0" data-locum-probe="diff">
        <p className="text-muted-foreground text-sm">
          {t("agents.diff.alone", { version: atual.version })}
        </p>
        <div className="mt-2">
          <CodeBlock code={JSON.stringify(atual.spec, null, 2)} language="json">
            <CodeBlockCopyButton />
          </CodeBlock>
        </div>
      </div>
    );
  }

  const mudadas = linhas.filter((l) => l.tipo !== "igual");

  return (
    <div
      data-locum-diff={mudadas.length}
      data-locum-probe="diff"
      data-locum-saiu={mudadas.filter((l) => l.tipo === "saiu").map((l) => l.texto.trim()).join("|")}
      data-locum-entrou={mudadas.filter((l) => l.tipo === "entrou").map((l) => l.texto.trim()).join("|")}
    >
      <p className="mb-2 text-muted-foreground text-xs">
        {t("agents.diff.summary", {
          count: mudadas.length,
          from: anterior.version,
          to: atual.version,
        })}
      </p>

      {mudadas.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("agents.diff.identical")}</p>
      ) : (
        <div className="overflow-auto rounded-lg border border-border font-mono text-xs">
          {linhas.map((linha, i) => (
            <LinhaDaComparacao key={`${linha.antes ?? "-"}:${linha.depois ?? "-"}:${i}`} linha={linha} />
          ))}
        </div>
      )}
    </div>
  );
}

const SINAL: Record<LinhaDoDiff["tipo"], string> = { igual: " ", saiu: "-", entrou: "+" };

function LinhaDaComparacao({ linha }: { linha: LinhaDoDiff }) {
  return (
    <div
      className={cn(
        "flex gap-3 whitespace-pre px-3 py-0.5",
        linha.tipo === "saiu" && "bg-destructive/15 text-destructive-foreground",
        linha.tipo === "entrou" && "bg-primary/15",
        linha.tipo === "igual" && "text-muted-foreground",
      )}
      data-locum-linha={linha.tipo}
    >
      <span className="w-10 shrink-0 text-right tabular-nums opacity-60">{linha.antes ?? ""}</span>
      <span className="w-10 shrink-0 text-right tabular-nums opacity-60">{linha.depois ?? ""}</span>
      <span className="w-3 shrink-0">{SINAL[linha.tipo]}</span>
      <span className="min-w-0">{linha.texto}</span>
    </div>
  );
}

/* ----------------------------------------------------------------- pedacos */

function Aviso({ children, probe }: { children: React.ReactNode; probe: string }) {
  return (
    <p className="text-muted-foreground text-sm" data-locum-probe={probe} data-versoes="">
      {children}
    </p>
  );
}

function quando(segundos: number): string {
  return new Date(segundos * 1000).toISOString().slice(0, 16).replace("T", " ");
}
