import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { EscolhaDoModelo } from "../assistente-modelo";
import { useIdioma } from "../idioma";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language } from "../../../src/services/i18n-service.js";

type Provedor = ReadResult<"providers.list">[number];
type Fallback = ReadResult<"providers.fallbacks">[number];
type Servidor = ReadResult<"mcp.list">[number];
type Orcamento = ReadResult<"agents.budgets">[number];
type Credencial = ReadResult<"credentials.overview">["refs"][number];
type Ferramenta = ReadResult<"mcp.tools">[number];
type Teste = ReadResult<"mcp.test">;

/**
 * A tela de configuracao: o que esta maquina tem, para onde ela troca, o que
 * ela sabe conectar, e quanto ela pode gastar.
 *
 * Segredo nenhum passa por aqui. O que as secoes de provedor e de servidor
 * mostram e o endereco da credencial e se existe valor guardado nele, que e
 * tudo que `credentials.overview` devolve: o cofre so se abre no caminho de
 * quem vai conectar, e a janela nao e esse caminho.
 *
 * Testar conexao e listar ferramentas ficam atras de botao, e nao na leitura
 * que dispara ao montar. As duas sobem o servidor que vao examinar, e abrir a
 * tela subiria todo cadastro de uma vez, o que num app que fica na bandeja o
 * dia todo e barulho caro.
 */
export function Configuracao() {
  const { t } = useTranslation();
  const maquina = useRead("machine.profile");
  const machineId = maquina.data?.machineId ?? null;

  const provedores = useRead("providers.list");
  // A tabela de substituicao e por maquina, e o identificador chega por outra
  // leitura. Com ele ainda nulo o canal responde lista vazia sem tocar no
  // banco, e a tela repinta quando ele chegar.
  const fallbacks = useRead("providers.fallbacks", machineId ?? "");
  const servidores = useRead("mcp.list");
  const orcamentos = useRead("agents.budgets");
  const credenciais = useRead("credentials.overview");

  const leituras = [provedores, fallbacks, servidores, orcamentos, credenciais];
  const erro = leituras.find((l) => l.status === "error")?.error;
  const pronto =
    machineId !== null && leituras.every((l) => l.status === "ready");
  const estado = erro !== undefined ? "erro" : pronto ? "pronto" : "carregando";

  // Por quem aponta, e nao por convencao de nome: a referencia de um cadastro
  // e escolhida por quem liga os dois, entao adivinha-la a partir do nome do
  // provider acertaria hoje e erraria no dia em que alguem apontasse dois
  // cadastros para a mesma credencial.
  const porCadastro = new Map<string, Credencial>();
  for (const credencial of credenciais.data?.refs ?? []) {
    for (const uso of credencial.users) porCadastro.set(`${uso.kind}:${uso.name}`, credencial);
  }

  return (
    <div
      className="flex flex-col gap-8"
      data-estado={estado}
      data-locum-cofre={credenciais.data?.available === true ? "legivel" : "fechado"}
      data-locum-fallbacks={fallbacks.data?.length ?? -1}
      data-locum-maquina={machineId ?? ""}
      data-locum-orcamentos={(orcamentos.data ?? []).map((o) => o.agentId).join(",")}
      data-locum-probe="configuracao"
      data-locum-provedores={(provedores.data ?? []).map((p) => p.name).join(",")}
      data-locum-servidores={(servidores.data ?? []).map((s) => s.config.name).join(",")}
    >
      {erro === undefined ? null : (
        <p className="text-destructive text-sm">
          {t("settings.refused", { channel: erro.channel, message: erro.message })}
        </p>
      )}

      <Secao
        descricao={t("settings.language.description")}
        titulo={t("settings.language.title")}
      >
        <EscolhaDoIdioma />
      </Secao>

      <Secao
        descricao={t("settings.assistantModel.description")}
        titulo={t("settings.assistantModel.title")}
      >
        <EscolhaDoModelo />
      </Secao>

      <Secao
        descricao={t("settings.providers.description")}
        titulo={t("settings.providers.title")}
      >
        {(provedores.data ?? []).map((provedor) => (
          <LinhaDoProvedor
            credencial={porCadastro.get(`provider:${provedor.name}`)}
            key={provedor.name}
            provedor={provedor}
          />
        ))}
      </Secao>

      <Secao
        descricao={t("settings.fallbacks.description", { machine: machineId ?? "..." })}
        titulo={t("settings.fallbacks.title")}
      >
        {(fallbacks.data ?? []).length === 0 ? (
          <Vazio>{t("settings.fallbacks.empty")}</Vazio>
        ) : (
          (fallbacks.data ?? []).map((fallback) => (
            <LinhaDoFallback fallback={fallback} key={`${fallback.fromModel}>${fallback.toModel}`} />
          ))
        )}
      </Secao>

      <Secao
        descricao={t("settings.servers.description")}
        titulo={t("settings.servers.title")}
      >
        {(servidores.data ?? []).length === 0 ? (
          <Vazio>{t("settings.servers.empty")}</Vazio>
        ) : (
          (servidores.data ?? []).map((servidor) => (
            <LinhaDoServidor
              credencial={porCadastro.get(`mcp:${servidor.config.name}`)}
              key={servidor.config.name}
              servidor={servidor}
            />
          ))
        )}
      </Secao>

      <Secao
        descricao={t("settings.budgets.description")}
        titulo={t("settings.budgets.title")}
      >
        {(orcamentos.data ?? []).map((orcamento) => (
          <LinhaDoOrcamento key={orcamento.agentId} orcamento={orcamento} />
        ))}
      </Secao>
    </div>
  );
}

/* ------------------------------------------------------------------ secoes */

function Secao({
  children,
  descricao,
  titulo,
}: {
  children: React.ReactNode;
  descricao: string;
  titulo: string;
}) {
  /*
   * Uma moldura só por seção.
   *
   * Antes a seção tinha borda e cada linha dentro dela também, então duas
   * molduras disputavam a mesma fronteira e o olho perdia onde um grupo
   * termina. Agora o fio separa linha de linha, e o grupo é delimitado pelo
   * espaço acima dele e pelo título.
   */
  return (
    <section className="flex flex-col gap-1">
      <h2 className="font-medium text-[15px] tracking-tight">{titulo}</h2>
      <p className="text-muted-foreground max-w-[68ch] text-xs">{descricao}</p>
      <div className="divide-border border-border bg-card mt-2 divide-y overflow-hidden rounded-lg border">
        {children}
      </div>
    </section>
  );
}

function Vazio({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-muted-foreground text-sm">{children}</p>;
}

/* ------------------------------------------------------------------- idioma */

/**
 * O nome de um idioma escrito nele mesmo.
 *
 * Não sai do dicionário de propósito: quem abre esta seção é justamente quem
 * está com a janela num idioma que não lê, e "Portuguese" traduzido para o
 * idioma corrente não ajuda nessa hora. O nome no próprio idioma é o que a
 * pessoa reconhece na lista.
 */
function autonimo(codigo: string): string {
  return new Intl.DisplayNames([codigo], { type: "language" }).of(codigo) ?? codigo;
}

/**
 * Em que idioma o Locum fala, escolhido aqui.
 *
 * Seguir o sistema não é o mesmo que escolher o idioma que o sistema está
 * falando agora: quem segue o sistema vira de idioma junto com a máquina, e
 * por isso a opção é botão à parte e não fica marcada quando alguém escolhe
 * `en` numa máquina em inglês.
 *
 * A troca não recarrega a janela nem remonta a árvore: o provedor de idioma
 * muda a instância do i18next que já está no ar, e o mesmo canal avisa o
 * processo principal, que reescreve bandeja e notificação na mesma batida.
 */
function EscolhaDoIdioma() {
  const { t } = useTranslation();
  const { available, language, preference, system, trocar } = useIdioma();
  const [erro, setErro] = useState<string | null>(null);

  const escolher = (escolha: Language | null): void => {
    trocar(escolha).then(
      () => setErro(null),
      (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
    );
  };

  return (
    <div
      className="flex flex-col gap-2 px-4 py-3"
      data-locum-idioma-ativo={language}
      data-locum-idioma-preferencia={preference ?? ""}
      data-locum-idioma-sistema={system}
      data-locum-probe="idioma-escolha"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          data-locum-escolhido={preference === null ? "sim" : "nao"}
          data-locum-idioma="sistema"
          onClick={() => escolher(null)}
          size="sm"
          variant={preference === null ? "secondary" : "ghost"}
        >
          {t("settings.language.system")}
        </Button>
        {available.map((codigo) => (
          <Button
            data-locum-escolhido={preference === codigo ? "sim" : "nao"}
            data-locum-idioma={codigo}
            key={codigo}
            onClick={() => escolher(codigo)}
            size="sm"
            variant={preference === codigo ? "secondary" : "ghost"}
          >
            {autonimo(codigo)}
          </Button>
        ))}
      </div>

      <p className="text-muted-foreground text-xs">
        {t("settings.language.active", { language: autonimo(language), tag: language })}
      </p>

      {erro === null ? null : (
        <p className="text-destructive text-xs">
          {t("settings.language.refused", { message: erro })}
        </p>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- provedores */

function LinhaDoProvedor({
  credencial,
  provedor,
}: {
  credencial: Credencial | undefined;
  provedor: Provedor;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
      data-locum-disponivel={provedor.available ? "sim" : "nao"}
      data-locum-provider={provedor.name}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          provedor.available ? "bg-chart-2" : "bg-muted-foreground/40",
        )}
      />
      <span className="w-36 shrink-0 truncate font-mono text-[13px]">{provedor.name}</span>
      <span
        className={cn(
          "shrink-0 text-xs",
          provedor.available ? "text-chart-2" : "text-muted-foreground",
        )}
      >
        {t(provedor.available ? "settings.providers.available" : "settings.providers.unavailable")}
      </span>
      {provedor.subscription ? (
        <span className="text-muted-foreground border-border shrink-0 rounded border px-1.5 text-[11px]">
          {t("settings.providers.subscription")}
        </span>
      ) : null}
      <Credenciais credencial={credencial} />
      {provedor.requires.length > 0 ? (
        <span className="text-muted-foreground text-xs">
          {t(provedor.available ? "settings.providers.uses" : "settings.providers.missing", {
            requirements: provedor.requires.join(", "),
          })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A credencial de um cadastro: onde ela mora, e se existe valor la.
 *
 * O valor nao chega ate aqui nem por acidente. `credentials.overview` devolve
 * endereco e um booleano, e e isso que a tela tem para mostrar.
 */
function Credenciais({ credencial }: { credencial: Credencial | undefined }) {
  const { t } = useTranslation();

  if (credencial === undefined) return null;
  return (
    <Badge
      data-locum-credencial={credencial.ref}
      data-locum-guardado={credencial.stored ? "sim" : "nao"}
      variant={credencial.stored ? "secondary" : "destructive"}
    >
      {t(credencial.stored ? "settings.credential.stored" : "settings.credential.missing", {
        ref: credencial.ref,
      })}
    </Badge>
  );
}

/* ---------------------------------------------------------------- fallbacks */

function LinhaDoFallback({ fallback }: { fallback: Fallback }) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-border border-b px-4 py-2 text-sm last:border-b-0"
      data-locum-fallback={`${fallback.fromModel}>${fallback.toModel}`}
      data-locum-ordem={fallback.order}
    >
      <code className="text-xs">{fallback.fromModel}</code>
      <span className="text-muted-foreground text-xs">{t("settings.fallbacks.becomes")}</span>
      <code className="text-xs">{fallback.toModel}</code>
      <span className="ml-auto text-muted-foreground text-xs tabular-nums">
        {t("settings.fallbacks.order", { order: fallback.order })}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- servidores */

type EstadoDoTeste =
  | { fase: "parado" }
  | { fase: "testando" }
  | { fase: "respondeu"; teste: Teste }
  | { fase: "recusado"; erro: string };

/**
 * Um servidor MCP cadastrado, com os dois exames que ele aceita.
 *
 * Testar conexao e listar ferramentas sobem o mesmo processo, mas respondem
 * perguntas diferentes: a primeira diz se o cadastro esta certo, a segunda diz
 * o que cada ferramenta pesa antes de alguem marca-la num passo. Por isso sao
 * dois botoes, e nao um exame que sempre faz as duas coisas.
 */
function LinhaDoServidor({
  credencial,
  servidor,
}: {
  credencial: Credencial | undefined;
  servidor: Servidor;
}) {
  const { t } = useTranslation();
  const nome = servidor.config.name;
  const [teste, setTeste] = useState<EstadoDoTeste>({ fase: "parado" });
  const [ferramentas, setFerramentas] = useState<Ferramenta[] | null>(null);
  const [listando, setListando] = useState(false);

  const testar = (): void => {
    setTeste({ fase: "testando" });
    call("mcp.test", nome).then(
      (resultado) => setTeste({ fase: "respondeu", teste: resultado }),
      // `testConnection` devolve a falha como dado, entao chegar aqui quer
      // dizer que a ponte recusou, e nao que o servidor esta fora do ar.
      (erro: unknown) =>
        setTeste({ fase: "recusado", erro: erro instanceof Error ? erro.message : String(erro) }),
    );
  };

  const listar = (): void => {
    setListando(true);
    call("mcp.tools", nome).then(
      (lista) => {
        setFerramentas(lista);
        setListando(false);
      },
      () => {
        setFerramentas([]);
        setListando(false);
      },
    );
  };

  return (
    <div
      className="flex flex-col gap-2 border-border border-b px-4 py-3 last:border-b-0"
      data-locum-escopo={servidor.config.scope}
      data-locum-habilitado={servidor.enabled ? "sim" : "nao"}
      data-locum-servidor={nome}
      data-locum-transporte={servidor.config.transport}
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="w-40 shrink-0 truncate font-medium">{nome}</span>
        <Badge variant="outline">{servidor.config.transport}</Badge>
        <Badge variant={servidor.config.scope === "write" ? "destructive" : "outline"}>
          {servidor.config.scope}
        </Badge>
        <Badge variant={servidor.enabled ? "secondary" : "outline"}>
          {t(servidor.enabled ? "settings.servers.enabled" : "settings.servers.disabled")}
        </Badge>
        <Credenciais credencial={credencial} />
        <div className="ml-auto flex items-center gap-1">
          <Button
            data-locum-testar={nome}
            disabled={teste.fase === "testando"}
            onClick={testar}
            size="sm"
            variant="ghost"
          >
            {t(teste.fase === "testando" ? "settings.servers.testing" : "settings.servers.test")}
          </Button>
          <Button
            data-locum-listar={nome}
            disabled={listando}
            onClick={listar}
            size="sm"
            variant="ghost"
          >
            {t(listando ? "settings.servers.listing" : "settings.servers.list")}
          </Button>
        </div>
      </div>

      <ResultadoDoTeste estado={teste} nome={nome} />

      {ferramentas === null ? null : (
        <div className="flex flex-wrap gap-1" data-locum-ferramentas-de={nome}>
          {ferramentas.length === 0 ? (
            <span className="text-muted-foreground text-xs">{t("settings.servers.noTools")}</span>
          ) : (
            ferramentas.map((ferramenta) => (
              <Badge
                data-locum-ferramenta={`${nome}/${ferramenta.name}`}
                data-locum-tokens={ferramenta.estimatedTokens}
                key={ferramenta.name}
                variant="outline"
              >
                {t("settings.servers.tool", {
                  name: ferramenta.name,
                  tokens: ferramenta.estimatedTokens,
                })}
              </Badge>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ResultadoDoTeste({ estado, nome }: { estado: EstadoDoTeste; nome: string }) {
  const { t } = useTranslation();

  if (estado.fase === "parado" || estado.fase === "testando") return null;

  if (estado.fase === "recusado") {
    return (
      <p className="text-destructive text-xs" data-locum-ok="nao" data-locum-teste={nome}>
        {t("settings.servers.refused", { message: estado.erro })}
      </p>
    );
  }

  const { teste } = estado;
  return (
    <p
      className={teste.ok ? "text-muted-foreground text-xs" : "text-destructive text-xs"}
      data-locum-ferramentas={teste.toolCount}
      data-locum-ok={teste.ok ? "sim" : "nao"}
      data-locum-teste={nome}
    >
      {teste.ok
        ? t("settings.servers.ok", { count: teste.toolCount, elapsed: teste.elapsedMs })
        : t("settings.servers.failed", {
            elapsed: teste.elapsedMs,
            error: teste.error ?? t("settings.servers.noReason"),
          })}
    </p>
  );
}

/* ---------------------------------------------------------------- orcamentos */

function LinhaDoOrcamento({ orcamento }: { orcamento: Orcamento }) {
  const { t } = useTranslation();
  // Teto ausente e teto ausente, e escrever zero ali mentiria sobre o limite.
  const moeda = (valor: number | null): string =>
    valor === null
      ? t("settings.budgets.noCap")
      : t("settings.budgets.amount", { amount: valor.toFixed(2) });

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-border border-b px-4 py-3 text-sm last:border-b-0"
      data-locum-gasto-hoje={orcamento.spentTodayUsd}
      data-locum-orcamento={orcamento.agentId}
      data-locum-por-dia={orcamento.perDayUsd ?? ""}
      data-locum-por-run={orcamento.perRunUsd ?? ""}
    >
      <span className="w-40 shrink-0 truncate font-medium">{orcamento.agentId}</span>
      <span className="text-muted-foreground text-xs">
        {orcamento.version === null
          ? t("settings.budgets.unknownVersion")
          : t("settings.budgets.version", { version: orcamento.version })}
      </span>
      <span className="text-xs tabular-nums">
        {t("settings.budgets.perRun", { amount: moeda(orcamento.perRunUsd) })}
      </span>
      <span className="text-xs tabular-nums">
        {t("settings.budgets.perDay", { amount: moeda(orcamento.perDayUsd) })}
      </span>
      <span
        className="ml-auto text-muted-foreground text-xs tabular-nums"
        data-locum-hoje={orcamento.runsToday}
      >
        {t("settings.budgets.today", {
          count: orcamento.runsToday,
          spent: orcamento.spentTodayUsd.toFixed(3),
        })}
      </span>
    </div>
  );
}
