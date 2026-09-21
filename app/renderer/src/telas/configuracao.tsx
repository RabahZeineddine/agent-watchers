import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
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
type ChaveDeProvedor = ReadResult<"providers.credentials">[number];
type ConferenciaDeProvedor = ReadResult<"providers.checkSecret">;
type EstadoDoGithub = ReadResult<"github.status">;
type ConferenciaDoGithub = ReadResult<"github.check">;
type Gatilho = ReadResult<"triggers.schedule">[number];
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
  const chaves = useRead("providers.credentials");
  /*
   * Guardar chave muda duas leituras ao mesmo tempo: a chave em si e a
   * disponibilidade do provedor. Elas voltam juntas para que a linha nunca
   * apareça com chave guardada e provedor ainda apagado, que é o meio segundo
   * em que alguém acharia que não funcionou.
   */
  const [provedoresRecarregados, setProvedoresRecarregados] = useState<{
    lista: Provedor[];
    chaves: ChaveDeProvedor[];
  } | null>(null);

  const recarregarProvedores = (): Promise<void> =>
    Promise.all([read("providers.list"), read("providers.credentials")]).then(
      ([lista, novasChaves]) => setProvedoresRecarregados({ lista, chaves: novasChaves }),
      () => undefined,
    );

  const listaDeProvedores = provedoresRecarregados?.lista ?? provedores.data ?? [];
  const chavesPorProvedor = new Map(
    (provedoresRecarregados?.chaves ?? chaves.data ?? []).map((c) => [c.provider, c]),
  );
  // A tabela de substituicao e por maquina, e o identificador chega por outra
  // leitura. Com ele ainda nulo o canal responde lista vazia sem tocar no
  // banco, e a tela repinta quando ele chegar.
  const fallbacks = useRead("providers.fallbacks", machineId ?? "");
  const servidores = useRead("mcp.list");
  const orcamentos = useRead("agents.budgets");
  const credenciais = useRead("credentials.overview");

  const leituras = [provedores, chaves, fallbacks, servidores, orcamentos, credenciais];
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
      data-locum-provedores={listaDeProvedores.map((p) => p.name).join(",")}
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
        {listaDeProvedores.map((provedor) => (
          <LinhaDoProvedor
            chave={chavesPorProvedor.get(provedor.name)}
            key={provedor.name}
            provedor={provedor}
            recarregar={recarregarProvedores}
          />
        ))}
      </Secao>

      <Secao
        descricao={t("settings.registered.description")}
        titulo={t("settings.registered.title")}
      >
        <ProvedoresCadastrados recarregar={recarregarProvedores} />
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
        descricao={t("settings.github.description")}
        titulo={t("settings.github.title")}
      >
        <Github />
      </Secao>

      <Secao
        descricao={t("settings.watched.description")}
        titulo={t("settings.watched.title")}
      >
        <Observados />
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
  chave,
  provedor,
  recarregar,
}: {
  chave: ChaveDeProvedor | undefined;
  provedor: Provedor;
  recarregar: () => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-col gap-2 px-3 py-2 text-sm"
      data-locum-chave-ambiente={chave?.env === true ? "sim" : "nao"}
      data-locum-chave-conferida={chave?.checkedAt ?? ""}
      data-locum-chave-guardada={chave === undefined ? "" : chave.stored ? "sim" : "nao"}
      data-locum-chave-modelos={chave?.modelCount ?? ""}
      data-locum-chave-ref={chave?.ref ?? ""}
      data-locum-disponivel={provedor.available ? "sim" : "nao"}
      data-locum-provider={provedor.name}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
          {t(
            provedor.available ? "settings.providers.available" : "settings.providers.unavailable",
          )}
        </span>
        {provedor.subscription ? (
          <span className="text-muted-foreground border-border shrink-0 rounded border px-1.5 text-[11px]">
            {t("settings.providers.subscription")}
          </span>
        ) : null}
        {chave === undefined || chave.ref === null ? null : (
          <Badge
            data-locum-credencial={chave.ref}
            data-locum-guardado={chave.stored ? "sim" : "nao"}
            variant={chave.stored ? "secondary" : "outline"}
          >
            {t(chave.stored ? "settings.credential.stored" : "settings.credential.missing", {
              ref: chave.ref,
            })}
          </Badge>
        )}
        {provedor.requires.length > 0 ? (
          <span className="text-muted-foreground text-xs">
            {t(provedor.available ? "settings.providers.uses" : "settings.providers.missing", {
              requirements: provedor.requires.join(", "),
            })}
          </span>
        ) : null}
      </div>

      {chave === undefined || chave.variable === null ? null : (
        <ChaveDoProvedor chave={chave} provedor={provedor} recarregar={recarregar} />
      )}
    </div>
  );
}

type Exame =
  | { fase: "parado" }
  | { fase: "conferindo" }
  | { fase: "respondeu"; resultado: ConferenciaDeProvedor }
  | { fase: "recusado"; erro: string };

/**
 * A chave de um provedor: guardar, esquecer e perguntar o catálogo.
 *
 * Mesma viagem de mão única da credencial do GitHub. O valor digitado sai
 * daqui para o keychain e nunca volta, porque não existe canal que devolva
 * segredo: o que fica visível é se há algo guardado, quando foi a última
 * conferência e quantos modelos ela contou.
 *
 * Guardar deixa o provedor disponível na hora, sem reabrir a janela. Quem faz
 * isso é o serviço, que remonta o registro com a chave nova antes de
 * responder; aqui só se relê o que mudou.
 *
 * Conferir fica atrás de um clique pela mesma razão do teste de servidor MCP:
 * ele sai para a rede, e abrir a tela de configuração não é pedir exame.
 */
function ChaveDoProvedor({
  chave,
  provedor,
  recarregar,
}: {
  chave: ChaveDeProvedor;
  provedor: Provedor;
  recarregar: () => Promise<void>;
}) {
  const { i18n, t } = useTranslation();
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [exame, setExame] = useState<Exame>({ fase: "parado" });

  const guardar = (): void => {
    setSalvando(true);
    // O campo é limpo antes mesmo da resposta, como no token do GitHub: o que
    // foi digitado já está a caminho do cofre, e deixá-lo na tela só aumenta a
    // chance de ele aparecer numa captura ou num ombro alheio.
    const digitado = valor;
    setValor("");
    call("providers.saveSecret", provedor.name, digitado)
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        // A conferência anterior era da chave antiga, e o serviço já a apagou.
        setExame({ fase: "parado" });
      });
  };

  const esquecer = (): void => {
    call("providers.forgetSecret", provedor.name)
      .then(recarregar, () => undefined)
      .finally(() => setExame({ fase: "parado" }));
  };

  const conferir = (): void => {
    setExame({ fase: "conferindo" });
    call("providers.checkSecret", provedor.name).then(
      (resultado) => {
        setExame({ fase: "respondeu", resultado });
        void recarregar();
      },
      // `checkSecret` devolve a recusa do provedor como dado, então chegar
      // aqui quer dizer que a ponte recusou, e não que a chave está errada.
      (erro: unknown) =>
        setExame({
          fase: "recusado",
          erro: erro instanceof Error ? erro.message : String(erro),
        }),
    );
  };

  const conferidaEm =
    chave.checkedAt === null ? null : new Date(chave.checkedAt * 1000).toLocaleString(i18n.language);

  return (
    <div className="flex flex-col gap-1.5 pl-5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.providerKey.field", { provider: provedor.name })}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring min-w-56 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-chave-campo={provedor.name}
          disabled={!chave.vault}
          onChange={(evento) => setValor(evento.target.value)}
          placeholder={t(
            chave.vault ? "settings.providerKey.placeholder" : "settings.providerKey.noVault",
            { variable: chave.variable },
          )}
          spellCheck={false}
          type="password"
          value={valor}
        />
        <Button
          data-locum-chave-salvar={provedor.name}
          disabled={salvando || !chave.vault || valor.trim().length === 0}
          onClick={guardar}
          size="sm"
          variant="secondary"
        >
          {t(salvando ? "settings.providerKey.saving" : "settings.providerKey.save")}
        </Button>
        <Button
          data-locum-chave-conferir={provedor.name}
          disabled={exame.fase === "conferindo"}
          onClick={conferir}
          size="sm"
          variant="ghost"
        >
          {t(
            exame.fase === "conferindo"
              ? "settings.providerKey.checking"
              : "settings.providerKey.check",
          )}
        </Button>
        {chave.stored ? (
          <Button
            data-locum-chave-esquecer={provedor.name}
            onClick={esquecer}
            size="sm"
            variant="ghost"
          >
            {t("settings.providerKey.forget")}
          </Button>
        ) : null}
      </div>

      {chave.env && !chave.stored ? (
        <p className="text-muted-foreground text-xs">
          {t("settings.providerKey.fromEnv", { variable: chave.variable })}
        </p>
      ) : null}

      {conferidaEm === null ? null : (
        <p className="text-muted-foreground text-xs" data-locum-chave-historico={provedor.name}>
          {t("settings.providerKey.lastCheck", {
            count: chave.modelCount ?? 0,
            when: conferidaEm,
          })}
        </p>
      )}

      <ResultadoDaChave exame={exame} provedor={provedor.name} />
    </div>
  );
}

/* ---------------------------------------------- provedores cadastrados */

type Cadastrado = ReadResult<"providers.registered">[number];
type Remocao = ReadResult<"providers.remove">;

/**
 * Gateway compatível com OpenAI: cadastrar, ver e remover.
 *
 * A lista de provedores acima é fixa no código, e é por isso que esta seção
 * existe: um segundo gateway da empresa, um Ollama em outra máquina ou um
 * OpenRouter não têm onde entrar sem ela. O que se cadastra aqui aparece lá em
 * cima como qualquer outro provedor, com campo de chave próprio, e um passo
 * pode apontar para ele pelo identificador.
 *
 * Remover pede dois cliques quando o provedor está em uso. O primeiro volta
 * com a lista de onde ele aparece, e é o serviço que a monta: a tela mostra o
 * que recebeu e oferece o segundo clique, mas a decisão de não apagar em
 * silêncio é do lado que apaga.
 */
function ProvedoresCadastrados({ recarregar }: { recarregar: () => Promise<void> }) {
  const { t } = useTranslation();
  const inicial = useRead("providers.registered");
  const [relido, setRelido] = useState<Cadastrado[] | null>(null);
  const [id, setId] = useState("");
  const [nome, setNome] = useState("");
  const [url, setUrl] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Por provedor, e não um só para a seção: duas remoções avisadas ao mesmo
  // tempo mostrariam a lista de uso de uma na linha da outra.
  const [avisos, setAvisos] = useState<Record<string, Remocao>>({});

  const lista = relido ?? inicial.data ?? [];
  const recusa = erro ?? inicial.error?.message ?? null;

  const reler = (): Promise<void> =>
    Promise.all([read("providers.registered").then(setRelido), recarregar()]).then(
      () => undefined,
      (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
    );

  const agir = (acao: Promise<unknown>): Promise<unknown> => {
    setOcupado(true);
    return acao
      .then(
        (resultado) => {
          setErro(null);
          return resultado;
        },
        (falha: unknown) => {
          setErro(falha instanceof Error ? falha.message : String(falha));
          return undefined;
        },
      )
      .then(async (resultado) => {
        await reler();
        return resultado;
      })
      .finally(() => setOcupado(false));
  };

  const cadastrar = (): void => {
    void agir(
      call("providers.register", { id: id.trim(), label: nome.trim(), baseUrl: url.trim() }).then(
        () => {
          setId("");
          setNome("");
          setUrl("");
        },
      ),
    );
  };

  const remover = (alvo: string, force: boolean): void => {
    void agir(call("providers.remove", alvo, force)).then((resultado) => {
      const remocao = resultado as Remocao | undefined;
      setAvisos((antes) => {
        const proximos = { ...antes };
        // Removido ou recusado pela ponte, o aviso anterior sai: ele descrevia
        // um provedor que não está mais lá, ou uma tentativa que não chegou.
        if (remocao === undefined || remocao.removed) delete proximos[alvo];
        else proximos[alvo] = remocao;
        return proximos;
      });
    });
  };

  const valido = id.trim() !== "" && nome.trim() !== "" && url.trim() !== "";

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-cadastrados={lista.map((p) => p.id).join(",")}
      data-locum-probe="provedores-cadastrados"
    >
      {lista.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("settings.registered.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {lista.map((cadastrado) => (
            <LinhaDoCadastrado
              aoRemover={(force) => remover(cadastrado.id, force)}
              aviso={avisos[cadastrado.id]}
              cadastrado={cadastrado}
              key={cadastrado.id}
              ocupado={ocupado}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("settings.registered.id")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-40 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-cadastrar-id=""
          onChange={(evento) => setId(evento.target.value)}
          placeholder={t("settings.registered.idHint")}
          spellCheck={false}
          value={id}
        />
        <input
          aria-label={t("settings.registered.label")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-44 rounded-md border px-3 py-1.5 text-xs outline-none focus-visible:ring-1"
          data-locum-cadastrar-nome=""
          onChange={(evento) => setNome(evento.target.value)}
          placeholder={t("settings.registered.labelHint")}
          spellCheck={false}
          value={nome}
        />
        <input
          aria-label={t("settings.registered.baseUrl")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring min-w-56 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-cadastrar-url=""
          onChange={(evento) => setUrl(evento.target.value)}
          placeholder={t("settings.registered.baseUrlHint")}
          spellCheck={false}
          value={url}
        />
        <Button
          data-locum-cadastrar-salvar=""
          disabled={ocupado || !valido}
          onClick={cadastrar}
          size="sm"
          variant="secondary"
        >
          {t("settings.registered.add")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.registered.howTo")}</p>

      {recusa === null ? null : (
        <p className="text-destructive text-xs" data-locum-cadastrados-erro={recusa}>
          {t("settings.registered.refused", { message: recusa })}
        </p>
      )}
    </div>
  );
}

function LinhaDoCadastrado({
  aoRemover,
  aviso,
  cadastrado,
  ocupado,
}: {
  aoRemover: (force: boolean) => void;
  aviso: Remocao | undefined;
  cadastrado: Cadastrado;
  ocupado: boolean;
}) {
  const { t } = useTranslation();
  const usos = aviso === undefined || aviso.removed ? [] : aviso.usedBy;

  return (
    <li
      className="border-border flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
      data-locum-cadastrado={cadastrado.id}
      data-locum-cadastrado-nome={cadastrado.label}
      data-locum-cadastrado-url={cadastrado.baseUrl}
      data-locum-cadastrado-usos={usos.length}
    >
      <span className="font-mono text-[13px]">{cadastrado.id}</span>
      <span className="text-muted-foreground text-xs">{cadastrado.label}</span>
      <span className="text-muted-foreground font-mono text-xs">{cadastrado.baseUrl}</span>

      <div className="ml-auto flex items-center gap-1">
        <Button
          data-locum-cadastrado-remover={cadastrado.id}
          disabled={ocupado}
          onClick={() => aoRemover(false)}
          size="sm"
          variant="ghost"
        >
          {t("settings.registered.remove")}
        </Button>
        {usos.length === 0 ? null : (
          <Button
            data-locum-cadastrado-forcar={cadastrado.id}
            disabled={ocupado}
            onClick={() => aoRemover(true)}
            size="sm"
            variant="ghost"
          >
            {t("settings.registered.removeAnyway")}
          </Button>
        )}
      </div>

      {usos.length === 0 ? null : (
        <p className="text-destructive w-full text-xs">
          {t("settings.registered.inUse", {
            count: usos.length,
            where: usos
              .map((uso) =>
                uso.kind === "step"
                  ? t("settings.registered.useStep", { agent: uso.agentId, step: uso.stepKey })
                  : t("settings.registered.useFallback", { from: uso.from, to: uso.to }),
              )
              .join(", "),
          })}
        </p>
      )}
    </li>
  );
}

function ResultadoDaChave({ exame, provedor }: { exame: Exame; provedor: string }) {
  const { t } = useTranslation();

  if (exame.fase === "parado" || exame.fase === "conferindo") return null;

  if (exame.fase === "recusado") {
    return (
      <p className="text-destructive text-xs" data-locum-chave-resultado="recusado">
        {t("settings.providerKey.bridgeRefused", { message: exame.erro })}
      </p>
    );
  }

  const { resultado } = exame;
  if (resultado.ok) {
    return (
      <p className="text-chart-2 text-xs" data-locum-chave-resultado="ok">
        {t("settings.providerKey.answered", { count: resultado.count, provider: provedor })}
      </p>
    );
  }

  return (
    <p className="text-destructive text-xs" data-locum-chave-resultado={resultado.reason}>
      {resultado.reason === "missing"
        ? t("settings.providerKey.missing", { provider: provedor })
        : t("settings.providerKey.failed", { message: resultado.message })}
    </p>
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


/* ------------------------------------------------------------------- github */

type Conferencia =
  | { fase: "parado" }
  | { fase: "conferindo" }
  | { fase: "respondeu"; resultado: ConferenciaDoGithub }
  | { fase: "recusado"; erro: string };

/**
 * A credencial do GitHub: guardar, esquecer e perguntar de quem ela é.
 *
 * O valor digitado sai daqui numa direção só, para o keychain, e nunca volta:
 * não existe canal que devolva segredo, então nem recarregando a tela o campo
 * reaparece preenchido. O que fica visível é se há algo guardado, de quem é a
 * conta e quando foi a última conferência, que é o suficiente para alguém saber
 * se pode ligar um gatilho.
 *
 * Conferir fica atrás de um clique pela mesma razão do teste de servidor MCP:
 * ele sai para a rede, e abrir a tela de configuração não é pedir exame.
 */
function Github() {
  const { i18n, t } = useTranslation();
  const inicial = useRead("github.status");
  const [recarregado, setRecarregado] = useState<EstadoDoGithub | null>(null);
  const [token, setToken] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [conferencia, setConferencia] = useState<Conferencia>({ fase: "parado" });

  const estado = recarregado ?? inicial.data ?? null;

  const recarregar = (): Promise<void> =>
    read("github.status").then(setRecarregado, () => undefined);

  const guardar = (): void => {
    setSalvando(true);
    // O campo é limpo antes mesmo da resposta: o que foi digitado já está a
    // caminho do cofre, e deixá-lo na tela só aumenta a chance de ele aparecer
    // numa captura ou num ombro alheio.
    const valor = token;
    setToken("");
    call("github.save", valor)
      .then(recarregar, () => undefined)
      .finally(() => {
        setSalvando(false);
        // A conferência anterior era do token antigo, e o serviço já a apagou.
        setConferencia({ fase: "parado" });
      });
  };

  const esquecer = (): void => {
    call("github.forget")
      .then(recarregar, () => undefined)
      .finally(() => setConferencia({ fase: "parado" }));
  };

  const conferir = (): void => {
    setConferencia({ fase: "conferindo" });
    call("github.check").then(
      (resultado) => {
        setConferencia({ fase: "respondeu", resultado });
        void recarregar();
      },
      // `check` devolve a recusa do GitHub como dado, então chegar aqui quer
      // dizer que a ponte recusou, e não que o token está errado.
      (erro: unknown) =>
        setConferencia({
          fase: "recusado",
          erro: erro instanceof Error ? erro.message : String(erro),
        }),
    );
  };

  const conferidoEm =
    estado?.checkedAt == null
      ? null
      : new Date(estado.checkedAt * 1000).toLocaleString(i18n.language);

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-github-ambiente={estado?.env === true ? "sim" : "nao"}
      data-locum-github-cofre={estado?.vault === true ? "aberto" : "fechado"}
      data-locum-github-conferido={estado?.checkedAt ?? ""}
      data-locum-github-guardado={estado === null ? "" : estado.stored ? "sim" : "nao"}
      data-locum-github-login={estado?.identity?.login ?? ""}
      data-locum-probe="github"
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="w-40 shrink-0 truncate font-medium">{estado?.ref ?? ""}</span>
        <Badge variant={estado?.stored === true ? "secondary" : "destructive"}>
          {t(estado?.stored === true ? "settings.github.stored" : "settings.github.absent")}
        </Badge>
        {estado?.env === true ? (
          <Badge variant="outline">{t("settings.github.fromEnv")}</Badge>
        ) : null}
        {estado?.vault === false ? (
          <Badge variant="outline">{t("settings.github.noVault")}</Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            data-locum-github-conferir=""
            disabled={conferencia.fase === "conferindo"}
            onClick={conferir}
            size="sm"
            variant="ghost"
          >
            {t(
              conferencia.fase === "conferindo"
                ? "settings.github.checking"
                : "settings.github.check",
            )}
          </Button>
          {estado?.stored === true ? (
            <Button data-locum-github-esquecer="" onClick={esquecer} size="sm" variant="ghost">
              {t("settings.github.forget")}
            </Button>
          ) : null}
        </div>
      </div>

      {estado?.identity == null ? null : (
        <p className="text-muted-foreground text-xs" data-locum-github-identidade="">
          {t("settings.github.identity", {
            login: estado.identity.login,
            scopes:
              estado.identity.scopes.length === 0
                ? t("settings.github.fineGrained")
                : estado.identity.scopes.join(", "),
          })}
          {conferidoEm === null ? null : ` · ${t("settings.github.when", { when: conferidoEm })}`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/*
         * Campo de senha, e não de texto: o valor colado aqui aparece em
         * gravação de tela e em quem estiver olhando de lado, e o campo fica
         * numa tela que se abre para conferir outras coisas.
         */}
        <input
          aria-label={t("settings.github.field")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring min-w-64 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-github-token=""
          onChange={(evento) => setToken(evento.target.value)}
          placeholder={t("settings.github.placeholder")}
          spellCheck={false}
          type="password"
          value={token}
        />
        <Button
          data-locum-github-salvar=""
          disabled={salvando || token.trim().length === 0}
          onClick={guardar}
          size="sm"
          variant="secondary"
        >
          {t(salvando ? "settings.github.saving" : "settings.github.save")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">
        {t("settings.github.howTo")}
      </p>

      <ResultadoDoGithub conferencia={conferencia} />
    </div>
  );
}

function ResultadoDoGithub({ conferencia }: { conferencia: Conferencia }) {
  const { t } = useTranslation();

  if (conferencia.fase === "parado" || conferencia.fase === "conferindo") return null;

  if (conferencia.fase === "recusado") {
    return (
      <p
        className="text-destructive text-xs"
        data-locum-github-resultado="recusado"
        data-locum-ok="nao"
      >
        {t("settings.github.refused", { message: conferencia.erro })}
      </p>
    );
  }

  const { resultado } = conferencia;
  if (resultado.ok) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-locum-github-resultado="ok"
        data-locum-ok="sim"
      >
        {t("settings.github.answered", {
          login: resultado.login,
          scopes:
            resultado.scopes.length === 0
              ? t("settings.github.fineGrained")
              : resultado.scopes.join(", "),
        })}
      </p>
    );
  }

  return (
    <p
      className="text-destructive text-xs"
      data-locum-github-resultado={resultado.reason}
      data-locum-ok="nao"
    >
      {resultado.reason === "missing"
        ? t("settings.github.missing")
        : t("settings.github.failed", { error: resultado.message })}
    </p>
  );
}

/* --------------------------------------------------------------- observados */

/** Fonte da varredura. Hoje só existe uma, e o cadastro guarda o nome dela. */
const FONTE = "github";

/** Cadência de estreia, em minutos. A mesma que o zod usa quando ninguém diz. */
const CADENCIA_PADRAO = "15";

/**
 * O que esta máquina observa: dono, padrão de repositório e de quanto em
 * quanto tempo o Locum vai olhar.
 *
 * O gatilho nasce parado, e ligar é outro clique. Não é cerimônia: um cadastro
 * que já acordasse sozinho colocaria o executor para rodar em cima de um
 * repositório que alguém ainda está terminando de escolher, gastando modelo
 * antes de a pessoa ter conferido o que digitou.
 *
 * Nada aqui publica. Um gatilho ligado varre, cria execução e o passo de ação
 * para na fila de aprovação, que continua sendo o único lugar onde sai
 * comentário, e só com clique.
 */
function Observados() {
  const { i18n, t } = useTranslation();
  const agents = useRead("agents.list");
  const inicial = useRead("triggers.schedule");
  const [recarregado, setRecarregado] = useState<Gatilho[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [dono, setDono] = useState("");
  const [repo, setRepo] = useState("");
  const [cadencia, setCadencia] = useState(CADENCIA_PADRAO);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const agenda = recarregado ?? inicial.data ?? null;
  const recusa = erro ?? inicial.error?.message ?? null;
  // Só a varredura: gatilho de relógio e de MCP entram por outro caminho e não
  // têm dono nem padrão de repositório para esta seção mostrar.
  const gatilhos = (agenda ?? []).filter((g) => g.kind === "poll");

  const listaDeAgents = agents.data ?? [];
  // O primeiro da lista é o padrão, e não uma opção vazia: quem tem um agent só
  // não deveria precisar escolhê-lo para cadastrar o que observar.
  const escolhido = agentId !== "" ? agentId : (listaDeAgents[0]?.id ?? "");

  // A leitura que falha vira texto na tela e não lista vazia: sem isso, ponte
  // recusada e nenhum repositório observado ficam iguais para quem olha.
  const recarregar = (): Promise<void> =>
    read("triggers.schedule").then(setRecarregado, (falha: unknown) =>
      setErro(falha instanceof Error ? falha.message : String(falha)),
    );

  const agir = (acao: Promise<unknown>): void => {
    setOcupado(true);
    acao
      .then(
        () => setErro(null),
        (falha: unknown) => setErro(falha instanceof Error ? falha.message : String(falha)),
      )
      .then(recarregar)
      .finally(() => setOcupado(false));
  };

  const minutos = Number(cadencia);
  const valido =
    escolhido !== "" &&
    dono.trim() !== "" &&
    repo.trim() !== "" &&
    Number.isInteger(minutos) &&
    minutos >= 1;

  const observar = (): void => {
    agir(
      call("triggers.set", escolhido, {
        kind: "poll",
        source: FONTE,
        owner: dono.trim(),
        repoMatch: repo.trim(),
        everyMinutes: minutos,
      }).then(() => {
        setDono("");
        setRepo("");
      }),
    );
  };

  return (
    <div
      className="flex flex-col gap-3 px-4 py-3"
      data-locum-observados={gatilhos.map((g) => g.triggerId).join(",")}
      data-locum-probe="observados"
    >
      {gatilhos.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("settings.watched.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {gatilhos.map((gatilho) => (
            <LinhaDoObservado
              aoLigar={(ligado) => agir(call("triggers.setEnabled", gatilho.triggerId, ligado))}
              aoRemover={() => agir(call("triggers.remove", gatilho.triggerId))}
              gatilho={gatilho}
              idioma={i18n.language}
              key={gatilho.triggerId}
              ocupado={ocupado}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t("settings.watched.agent")}
          className="border-border bg-background cursor-pointer rounded-md border px-2 py-1.5 text-xs"
          data-locum-observar-agent=""
          onChange={(evento) => setAgentId(evento.target.value)}
          value={escolhido}
        >
          {listaDeAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.id}
            </option>
          ))}
        </select>

        <input
          aria-label={t("settings.watched.owner")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-40 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-observar-dono=""
          onChange={(evento) => setDono(evento.target.value)}
          placeholder={t("settings.watched.ownerHint")}
          spellCheck={false}
          value={dono}
        />

        <input
          aria-label={t("settings.watched.repo")}
          autoComplete="off"
          className="border-border bg-background focus-visible:ring-ring w-44 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-observar-repo=""
          onChange={(evento) => setRepo(evento.target.value)}
          placeholder={t("settings.watched.repoHint")}
          spellCheck={false}
          value={repo}
        />

        <input
          aria-label={t("settings.watched.cadence")}
          className="border-border bg-background focus-visible:ring-ring w-20 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus-visible:ring-1"
          data-locum-observar-cadencia=""
          min={1}
          onChange={(evento) => setCadencia(evento.target.value)}
          step={1}
          type="number"
          value={cadencia}
        />

        <Button
          data-locum-observar-salvar=""
          disabled={ocupado || !valido}
          onClick={observar}
          size="sm"
          variant="secondary"
        >
          {t("settings.watched.add")}
        </Button>
      </div>

      <p className="text-muted-foreground max-w-[68ch] text-xs">{t("settings.watched.howTo")}</p>

      {recusa === null ? null : (
        <p className="text-destructive text-xs" data-locum-observados-erro={recusa}>
          {t("settings.watched.refused", { message: recusa })}
        </p>
      )}
    </div>
  );
}

function LinhaDoObservado({
  aoLigar,
  aoRemover,
  gatilho,
  idioma,
  ocupado,
}: {
  aoLigar: (ligado: boolean) => void;
  aoRemover: () => void;
  gatilho: Gatilho;
  idioma: string;
  ocupado: boolean;
}) {
  const { t } = useTranslation();
  const config = gatilho.config;
  // O `kind` já foi filtrado por quem monta a lista, e este estreitamento é o
  // que dá acesso a dono e padrão sem espalhar a checagem pelo JSX.
  const alvo =
    config.kind === "poll"
      ? t("settings.watched.target", {
          owner: config.owner ?? t("settings.watched.fromEnv"),
          repo: config.repoMatch,
        })
      : "";

  const quando = (ms: number | null): string =>
    ms === null ? t("settings.watched.never") : new Date(ms).toLocaleString(idioma);

  return (
    <li
      className="border-border flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
      data-locum-gatilho={gatilho.triggerId}
      data-locum-gatilho-alvo={config.kind === "poll" ? `${config.owner ?? ""}/${config.repoMatch}` : ""}
      data-locum-gatilho-habilitado={gatilho.enabled ? "sim" : "nao"}
      data-locum-gatilho-proxima={gatilho.nextDueAt ?? ""}
      data-locum-gatilho-ultima={gatilho.lastFireAt ?? ""}
    >
      <span className="font-mono text-xs">{alvo}</span>
      <Badge variant={gatilho.enabled ? "secondary" : "outline"}>
        {t(gatilho.enabled ? "settings.watched.on" : "settings.watched.off")}
      </Badge>
      <span className="text-muted-foreground text-xs">
        {t("settings.watched.every", { count: gatilho.everyMinutes ?? 0 })}
      </span>
      <span className="text-muted-foreground text-xs">{gatilho.agentId}</span>

      <div className="ml-auto flex items-center gap-1">
        <Button
          data-locum-gatilho-ligar={gatilho.triggerId}
          disabled={ocupado}
          onClick={() => aoLigar(!gatilho.enabled)}
          size="sm"
          variant="ghost"
        >
          {t(gatilho.enabled ? "settings.watched.disable" : "settings.watched.enable")}
        </Button>
        <Button
          data-locum-gatilho-remover={gatilho.triggerId}
          disabled={ocupado}
          onClick={aoRemover}
          size="sm"
          variant="ghost"
        >
          {t("settings.watched.remove")}
        </Button>
      </div>

      <p className="text-muted-foreground w-full text-xs">
        {t("settings.watched.beats", {
          last: quando(gatilho.lastFireAt),
          next: gatilho.enabled ? quando(gatilho.nextDueAt) : t("settings.watched.parked"),
        })}
      </p>
    </li>
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
