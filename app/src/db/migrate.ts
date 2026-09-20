import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, rawDb } from "./index.js";

/** Tabela que o migrator do drizzle usa para saber o que já rodou. */
const TABELA_DE_CONTROLE = "__drizzle_migrations";

/** Tabela qualquer do esquema, usada para reconhecer banco que já tem dado. */
const TABELA_TESTEMUNHA = "agents";

type Journal = { entries: { idx: number; when: number; tag: string }[] };

/**
 * Onde estão os arquivos de migração, quando ninguém disser.
 *
 * O migrator do drizzle lê os `.sql` do disco na hora de rodar, então a pasta
 * não pode ser embutida no pacote do esbuild: ela viaja como arquivo mesmo.
 * Quem sobe empacotado sabe onde a pasta foi parar e passa o caminho; aqui
 * sobra o caso de rodar do código, onde a pasta está na raiz de `app/`.
 *
 * A procura é a partir do diretório de trabalho e não do arquivo: este módulo
 * termina dentro do pacote do processo principal, e ali o caminho do próprio
 * arquivo não diz mais onde o repositório está.
 */
export function migrationsFolder(): string {
  const custom = process.env.LOCUM_MIGRATIONS;
  if (custom && custom.length > 0) return custom;

  let dir = process.cwd();
  for (let nivel = 0; nivel < 4; nivel += 1) {
    const candidato = join(dir, "drizzle");
    if (existsSync(join(candidato, "meta", "_journal.json"))) return candidato;
    const acima = dirname(dir);
    if (acima === dir) break;
    dir = acima;
  }
  return join(process.cwd(), "drizzle");
}

function tabelaExiste(nome: string): boolean {
  const linha = rawDb
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(nome);
  return linha !== undefined;
}

/**
 * Adota banco que nasceu de `drizzle-kit push`, sem recriar as tabelas.
 *
 * Até aqui o esquema vinha da ferramenta de desenvolvimento, que cria tabela
 * direto e não deixa registro nenhum. Rodar a primeira migração num banco
 * desses estouraria em `table agents already exists`, e o dono da máquina
 * perderia o histórico por causa de uma troca de mecanismo. Então quando as
 * tabelas já estão lá e o controle não existe, as migrações presentes entram
 * como aplicadas.
 *
 * Marca todas e não só a última de propósito: o migrator decide pelo carimbo
 * mais recente, mas quem for depurar quer ver o que foi adotado.
 */
function adotarEsquemaExistente(journal: Journal, pasta: string): number {
  rawDb.exec(
    `create table if not exists ${TABELA_DE_CONTROLE} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )`,
  );
  const insere = rawDb.prepare(
    `insert into ${TABELA_DE_CONTROLE} ("hash", "created_at") values (?, ?)`,
  );
  let adotadas = 0;
  for (const entrada of journal.entries) {
    const sql = readFileSync(join(pasta, `${entrada.tag}.sql`), "utf8");
    insere.run(createHash("sha256").update(sql).digest("hex"), entrada.when);
    adotadas += 1;
  }
  return adotadas;
}

export type ResultadoDaMigracao = {
  /** Migrações que existem na pasta. */
  disponiveis: number;
  /** Banco que já tinha esquema e passou a ser controlado por migração. */
  adotado: boolean;
  /** Banco que nasceu agora, sem nenhuma tabela antes. */
  criado: boolean;
};

/**
 * Cria ou atualiza o esquema antes de qualquer serviço tocar o banco.
 *
 * `drizzle-kit push` é ferramenta de desenvolvimento e não existe no
 * aplicativo instalado: numa máquina limpa o Locum subiria sem tabela nenhuma.
 * Por isso o esquema passa a vir das migrações geradas, que viajam junto com o
 * pacote e são aplicadas na subida.
 */
export function migrateDb(folder?: string): ResultadoDaMigracao {
  const pasta = folder ?? migrationsFolder();
  const journalPath = join(pasta, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(`migração: não achei ${journalPath}, rode npm run db:generate`);
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;

  const tinhaEsquema = tabelaExiste(TABELA_TESTEMUNHA);
  const tinhaControle = tabelaExiste(TABELA_DE_CONTROLE);
  const adotado = tinhaEsquema && !tinhaControle;
  if (adotado) adotarEsquemaExistente(journal, pasta);

  // A chave estrangeira fica desligada durante a migração: passo que recria
  // tabela move dado entre tabela velha e nova, e a checagem no meio do
  // caminho acusaria referência que volta a existir no fim.
  const chaveEstrangeira = rawDb.pragma("foreign_keys", { simple: true });
  rawDb.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder: pasta });
  } finally {
    rawDb.pragma(`foreign_keys = ${chaveEstrangeira === 1 ? "ON" : "OFF"}`);
  }

  return { disponiveis: journal.entries.length, adotado, criado: !tinhaEsquema };
}
