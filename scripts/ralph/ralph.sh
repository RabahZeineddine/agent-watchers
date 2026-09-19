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
# Uso: ./ralph.sh <marco> [max_iteracoes]
#   ./ralph.sh M1 12

set -e

MARCO="${1:-}"
MAX_ITERATIONS="${2:-12}"

if [ -z "$MARCO" ]; then
  echo "uso: ./ralph.sh <marco> [max_iteracoes]   ex: ./ralph.sh M1 12"
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"

ORIGEM="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKTREE="$(dirname "$ORIGEM")/locum-loop"
TRONCO="main"
BRANCH="loop/$(echo "$MARCO" | tr '[:upper:]' '[:lower:]')"

command -v jq >/dev/null || { echo "ABORTADO: jq nao instalado."; exit 64; }

# ── Worktree próprio, obrigatório ────────────────────────────────────────────
#
# A árvore principal costuma ter uma sessão interativa aberta. Duas instâncias
# disputando índice já fizeram commit parar em branch alheia, e é estrago que
# só aparece depois.
if [ ! -d "$WORKTREE" ]; then
  echo "Criando worktree em $WORKTREE (a partir de $TRONCO)"
  git -C "$ORIGEM" worktree add "$WORKTREE" -b "$BRANCH" "$TRONCO"

  echo "Instalando dependencias"
  (cd "$WORKTREE/app" && npm install --silent)
  # Módulo nativo e esbuild precisam de script de build, bloqueado por padrão
  # no npm 11.
  (cd "$WORKTREE/app" && npm approve-scripts better-sqlite3 esbuild >/dev/null 2>&1 || true)
  (cd "$WORKTREE/app" && npm rebuild better-sqlite3 esbuild >/dev/null 2>&1 || true)
fi

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

pendentes() {
  jq --arg m "$MARCO" \
    '[.userStories[] | select(.milestone == $m and .passes != true and .blocked != true)] | length' \
    "$PRD_FILE" 2>/dev/null || echo "-1"
}
bloqueadas() {
  jq --arg m "$MARCO" \
    '[.userStories[] | select(.milestone == $m and .blocked == true)] | length' \
    "$PRD_FILE" 2>/dev/null || echo "0"
}

echo "Locum, marco $MARCO, worktree $WORKTREE, ate $MAX_ITERATIONS iteracoes"
echo "Pendentes agora: $(pendentes)"

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo ""
  echo "==============================================================="
  echo "  Iteracao $i de $MAX_ITERATIONS   (marco $MARCO)"
  echo "==============================================================="

  OUTPUT=$(cd "$WORKTREE" && claude --dangerously-skip-permissions \
    --add-dir "$SCRIPT_DIR" \
    --print < "$SCRIPT_DIR/AGENT.md" 2>&1 | tee /dev/stderr) || true

  # Hook que bloqueia o prompt faz a iteração não rodar. Seguir em frente aqui
  # queima o teto inteiro sem produzir nada.
  if echo "$OUTPUT" | grep -q "operation blocked by hook"; then
    echo ""
    echo "ABORTADO: hook bloqueou o prompt; a iteracao $i nao rodou."
    exit 2
  fi

  BRANCH_ATUAL=$(git -C "$WORKTREE" branch --show-current 2>/dev/null || echo "")
  if [ "$BRANCH_ATUAL" = "$TRONCO" ] || [ -z "$BRANCH_ATUAL" ]; then
    echo ""
    echo "ABORTADO: worktree em '$BRANCH_ATUAL' na iteracao $i."
    exit 6
  fi

  # Push é decisão do dono do repositório, nunca do loop.
  if git -C "$WORKTREE" ls-remote --exit-code --heads origin "$BRANCH_ATUAL" >/dev/null 2>&1; then
    echo ""
    echo "ABORTADO: a branch $BRANCH_ATUAL apareceu no remoto. O loop nao empurra."
    exit 8
  fi

  if ! (cd "$WORKTREE/app" && npx tsc --noEmit >/dev/null 2>&1); then
    echo ""
    echo "ABORTADO: tsc com erro no fim da iteracao $i."
    (cd "$WORKTREE/app" && npx tsc --noEmit) || true
    exit 4
  fi

  # Árvore suja significa trabalho não commitado, e a iteração seguinte é uma
  # instância nova que não sabe o que ficou pela metade.
  if [ -n "$(git -C "$WORKTREE" status --porcelain)" ]; then
    echo ""
    echo "ABORTADO: worktree suja no fim da iteracao $i:"
    git -C "$WORKTREE" status --short
    exit 7
  fi

  # Conclusão é ESTADO. O prd.json é a fonte da verdade.
  PENDING=$(pendentes)
  BLOCKED=$(bloqueadas)
  if [ "$PENDING" = "-1" ]; then
    echo ""
    echo "ABORTADO: nao consegui ler o prd.json."
    exit 3
  fi
  if [ "$PENDING" = "0" ]; then
    echo ""
    echo "Marco $MARCO fechado: 0 pendente ($BLOCKED bloqueada(s))."
    echo "Concluido na iteracao $i de $MAX_ITERATIONS."
    git -C "$WORKTREE" log --oneline "$TRONCO"..HEAD | head -30
    echo ""
    echo "Para trazer para a main:"
    echo "  git -C \"$ORIGEM\" merge --no-ff $BRANCH_ATUAL"
    exit 0
  fi
  echo "prd.json: $PENDING pendente(s), $BLOCKED bloqueada(s) no marco $MARCO."

  sleep 2
done

echo ""
echo "Teto de iteracoes ($MAX_ITERATIONS) sem fechar o marco $MARCO."
echo "Veja $PROGRESS_FILE."
exit 1
