/**
 * Espaco reservado da inbox.
 *
 * A hierarquia do que aparece primeiro numa fila de aprovacao e gosto, nao
 * criterio, entao esta tela e desenhada junto com o dono do projeto e nao sai
 * daqui sozinha. O que ja existe por baixo e a fila de verdade: a contagem na
 * barra lateral vem de `approvals.listPending`, pela ponte.
 */
export function Inbox() {
  return (
    <p className="text-muted-foreground text-sm">
      A fila de aprovacao ganha tela junto com o dono do projeto. Ate la, a
      decisao continua saindo pela linha de comando, e a contagem de pendencias
      aparece na bandeja e no rodape da barra lateral.
    </p>
  );
}
