#!/bin/bash
# Ralph do Locum. Adaptado do ralph.sh original.
#
# Diferenças que importam:
#   - worktree próprio, para não disputar índice com a sessão interativa que
#     está aberta na árvore principal;
#   - banco em pasta de rascunho dentro do worktree, para o loop não sujar o
#     banco real em ~/Library/Application Support/locum;
#   - guardas trocadas para o que existe neste projeto: tsc limpo, árvore limpa,
#     branch diferente de main, branch ausente do remoto;
#   - conclusão é ESTADO, lido do prd.json, não texto que o agente promete.
#
# Uso:
#   ./ralph.sh M1 12        um marco
#   ./ralph.sh all 30       M1, depois M2, depois N, no mesmo worktree
#   ./ralph.sh status       só imprime o estado do backlog

set -e

ALVO="${1:-}"
MAX_ITERATIONS="${2:-12}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIGEM="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKTREE="$(dirname "$ORIGEM")/locum-loop"
TRONCO="main"

# O agente edita a copia que esta no worktree, porque e de la que ele roda. Ler
# a copia da arvore principal faz a contagem de pendentes nunca baixar, e o
# marco so termina por esgotar o teto.
#
# A escolha fica depois da criacao do worktree, e nao aqui: na primeira rodada
# depois de um merge o worktree ainda nao existe quando o script comeca, e
# decidir agora congelaria o caminho errado pela rodada inteira.
PRD_FILE=""
PROGRESS_FILE=""

command -v jq >/dev/null || { echo "ABORTADO: jq nao instalado."; exit 64; }

# Worktree de rodada anterior que ficou para trás faz o estado ser lido de um
# ponto velho, e o loop reimplementa o que já foi mesclado. Se ele existe mas a
# branch dele já não está no repositório, ele é lixo e sai.
if [ -d "$WORKTREE" ] && ! git -C "$ORIGEM" worktree list --porcelain | grep -q "^worktree $WORKTREE$"; then
  echo "Removendo worktree órfão em $WORKTREE"
  rm -rf "$WORKTREE"
  git -C "$ORIGEM" worktree prune
fi

pendentes() {
  jq --arg m "$1" \
    '[.userStories[] | select(.milestone == $m and .passes != true and .blocked != true)] | length' \
    "$PRD_FILE" 2>/dev/null || echo "-1"
}
bloqueadas() {
  jq --arg m "$1" \
    '[.userStories[] | select(.milestone == $m and .blocked == true)] | length' \
    "$PRD_FILE" 2>/dev/null || echo "0"
}

estado() {
  echo ""
  jq -r '.userStories[]
    | "\(if .passes then "[x]" elif .blocked then "[!]" else "[ ]" end)  \(.milestone)  \(.id)  \(.title)\(if .blocked then "  <- " + (.blocked_reason // "bloqueada") else "" end)"' \
    "$PRD_FILE"
  echo ""
  for m in M1 M2 N M3 M4a M4c M5 M6 M7; do
    echo "  $m: $(pendentes "$m") pendente(s), $(bloqueadas "$m") bloqueada(s)"
  done
  echo ""
}

# Depois do merge, a copia do worktree some junto com ele, e o status volta a
# ler a arvore principal.
escolhe_estado() {
  if [ -f "$WORKTREE/scripts/ralph/prd.json" ]; then
    PRD_FILE="$WORKTREE/scripts/ralph/prd.json"
    PROGRESS_FILE="$WORKTREE/scripts/ralph/progress.txt"
  else
    PRD_FILE="$SCRIPT_DIR/prd.json"
    PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
  fi
}
escolhe_estado

if [ "$ALVO" = "status" ]; then
  estado
  exit 0
fi

if [ -z "$ALVO" ]; then
  echo "uso: ./ralph.sh <marco|all|status> [max_iteracoes]"
  echo "     ./ralph.sh M1 12"
  echo "     ./ralph.sh all 30"
  exit 64
fi

# ── Worktree próprio, obrigatório ────────────────────────────────────────────
#
# A árvore principal costuma ter uma sessão interativa aberta. Duas instâncias
# disputando índice já fizeram commit parar em branch alheia, e é estrago que
# só aparece depois.
if [ ! -d "$WORKTREE" ]; then
  echo "Criando worktree em $WORKTREE (a partir de $TRONCO)"
  git -C "$ORIGEM" worktree add "$WORKTREE" -b "loop/backlog" "$TRONCO"

  echo "Instalando dependencias"
  (cd "$WORKTREE/app" && npm install --silent)
  # Módulo nativo e esbuild precisam de script de build, bloqueado por padrão
  # no npm 11.
  (cd "$WORKTREE/app" && npm approve-scripts better-sqlite3 esbuild >/dev/null 2>&1 || true)
  (cd "$WORKTREE/app" && npm rebuild better-sqlite3 esbuild >/dev/null 2>&1 || true)
fi

# O worktree pode ter acabado de nascer, entao o estado e reescolhido aqui.
escolhe_estado

# Banco de rascunho: o loop roda `demo`, e o banco real tem histórico que vale.
export LOCUM_HOME="$WORKTREE/.locum-loop-data"
mkdir -p "$LOCUM_HOME"
(cd "$WORKTREE/app" && npx drizzle-kit push --force >/dev/null 2>&1 || true)

if [ ! -f "$PROGRESS_FILE" ]; then
  {
    echo "# Locum, progresso do loop"
    echo "Inicio: $(date)"
    echo "---"
  } > "$PROGRESS_FILE"
fi

# ── Uma rodada de marco ──────────────────────────────────────────────────────
# Devolve 0 quando o marco fecha, 1 quando estoura o teto, e aborta o processo
# inteiro nas condições que não devem continuar.
roda_marco() {
  local marco="$1" teto="$2" i

  echo ""
  echo "###############################################################"
  echo "  Marco $marco, ate $teto iteracoes, $(pendentes "$marco") pendente(s)"
  echo "###############################################################"

  if [ "$(pendentes "$marco")" = "0" ]; then
    echo "Marco $marco ja esta fechado."
    return 0
  fi

  for i in $(seq 1 "$teto"); do
    echo ""
    echo "==============================================================="
    echo "  $marco, iteracao $i de $teto   $(date '+%H:%M:%S')"
    echo "==============================================================="

    local saida
    saida=$(cd "$WORKTREE" && claude --dangerously-skip-permissions \
      --add-dir "$SCRIPT_DIR" \
      --print < "$SCRIPT_DIR/AGENT.md" 2>&1 | tee /dev/stderr) || true

    # Hook que bloqueia o prompt faz a iteração não rodar. Seguir em frente aqui
    # queima o teto inteiro sem produzir nada.
    if echo "$saida" | grep -q "operation blocked by hook"; then
      echo ""
      echo "ABORTADO: hook bloqueou o prompt; a iteracao nao rodou."
      exit 2
    fi

    local branch_atual
    branch_atual=$(git -C "$WORKTREE" branch --show-current 2>/dev/null || echo "")
    if [ "$branch_atual" = "$TRONCO" ] || [ -z "$branch_atual" ]; then
      echo ""
      echo "ABORTADO: worktree em '$branch_atual'."
      exit 6
    fi

    # Push é decisão do dono do repositório, nunca do loop.
    if git -C "$WORKTREE" ls-remote --exit-code --heads origin "$branch_atual" >/dev/null 2>&1; then
      echo ""
      echo "ABORTADO: a branch $branch_atual apareceu no remoto. O loop nao empurra."
      exit 8
    fi

    if ! (cd "$WORKTREE/app" && npx tsc --noEmit >/dev/null 2>&1); then
      echo ""
      echo "ABORTADO: tsc com erro no fim da iteracao."
      (cd "$WORKTREE/app" && npx tsc --noEmit) || true
      exit 4
    fi

    # Árvore suja significa trabalho não commitado, e a iteração seguinte é uma
    # instância nova que não sabe o que ficou pela metade.
    if [ -n "$(git -C "$WORKTREE" status --porcelain)" ]; then
      echo ""
      echo "ABORTADO: worktree suja no fim da iteracao:"
      git -C "$WORKTREE" status --short
      exit 7
    fi

    # Conclusão é ESTADO. O prd.json é a fonte da verdade.
    local pend blo
    pend=$(pendentes "$marco")
    blo=$(bloqueadas "$marco")
    if [ "$pend" = "-1" ]; then
      echo ""
      echo "ABORTADO: nao consegui ler o prd.json."
      exit 3
    fi
    if [ "$pend" = "0" ]; then
      echo ""
      echo "Marco $marco fechado na iteracao $i ($blo bloqueada(s))."
      return 0
    fi
    echo "$marco: $pend pendente(s), $blo bloqueada(s)."

    sleep 2
  done

  echo ""
  echo "Teto de $teto iteracoes sem fechar o marco $marco."
  return 1
}

MARCOS="$ALVO"
[ "$ALVO" = "all" ] && MARCOS="M1 M2 N M3"

FALHOU=0
for m in $MARCOS; do
  roda_marco "$m" "$MAX_ITERATIONS" || FALHOU=1
done

echo ""
echo "==============================================================="
echo "  Fim  $(date '+%Y-%m-%d %H:%M:%S')"
echo "==============================================================="
estado
git -C "$WORKTREE" log --oneline "$TRONCO"..HEAD | head -40
echo ""
echo "Para trazer para a main:"
echo "  git -C \"$ORIGEM\" merge --no-ff loop/backlog"

exit "$FALHOU"
