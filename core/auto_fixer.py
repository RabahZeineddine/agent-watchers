import os
import subprocess
import json
from typing import Dict, Any, Optional, List
from core.llm import LLMClient
from core.state_store import StateStore

AUTO_FIXER_SYSTEM_PROMPT = """Você é um Engenheiro Especialista em Correção e Refatoração de Código.
Sua missão é resolver os apontamentos críticos levantados na auditoria técnica de um Pull Request.

Diretrizes Obrigatórias:
1. FOCO CIRÚRGICO: Altere apenas o estritamente necessário para corrigir os bugs e apontamentos apontados. Não faça refatorações amplas desnecessárias.
2. RESPEITE O ESTILO: Mantenha o padrão de tipagem, formatação e bibliotecas já adotados no repositório.
3. RETORNO ESTRUTURADO: Retorne a lista de modificações de arquivo em formato JSON válido:
{
  "summary": "Resumo das alterações realizadas",
  "files": [
    {
      "path": "caminho/relativo/do/arquivo",
      "action": "modify", -- "modify" ou "create"
      "content": "conteúdo completo atualizado do arquivo"
    }
  ]
}
"""

class AutoFixerEngine:
    """Executa o ciclo iterativo local: Review -> Local Checkout -> Patch -> Tests/Lint -> Signed Commit -> Push."""

    def __init__(self, config: Dict[str, Any], state_store: StateStore):
        self.config = config
        self.state_store = state_store
        self.workspace_base = os.path.expanduser(config.get("workspace_base", "~/Development/github"))
        
        llm_cfg = config.get("llm", {})
        models_cfg = llm_cfg.get("models") or config.get("models", {})
        fixer_model = os.environ.get("REASONING_MODEL") or models_cfg.get("reasoning", "gpt-4o")
        api_base = os.environ.get("LLM_API_BASE") or llm_cfg.get("api_base") or config.get("api_base")
        api_key = os.environ.get("LLM_API_KEY") or llm_cfg.get("api_key")
        self.llm = LLMClient(model=fixer_model, api_base=api_base, api_key=api_key, temperature=0.1)

    def resolve_local_repo_path(self, repo: str) -> Optional[str]:
        """Localiza o diretório local do repositório."""
        repo_name = repo.split("/")[-1]
        candidate = os.path.join(self.workspace_base, repo_name)
        if os.path.exists(candidate) and os.path.isdir(candidate):
            return candidate
        return None

    def run_tests_and_lints(self, repo_path: str) -> Dict[str, Any]:
        """Detecta o ecossistema (Go / Node) e roda validação local."""
        # Go project
        if os.path.exists(os.path.join(repo_path, "go.mod")):
            cmd = "go test ./... -v"
            res = subprocess.run(cmd, shell=True, cwd=repo_path, capture_output=True, text=True)
            return {
                "ecosystem": "go",
                "command": cmd,
                "success": res.returncode == 0,
                "output": res.stdout[-2000:] if res.returncode == 0 else (res.stderr + res.stdout)[-3000:]
            }

        # Node / Yarn / Bun project
        if os.path.exists(os.path.join(repo_path, "package.json")):
            cmd = "yarn typecheck && yarn test" if os.path.exists(os.path.join(repo_path, "yarn.lock")) else "npm test"
            res = subprocess.run(cmd, shell=True, cwd=repo_path, capture_output=True, text=True)
            return {
                "ecosystem": "node",
                "command": cmd,
                "success": res.returncode == 0,
                "output": res.stdout[-2000:] if res.returncode == 0 else (res.stderr + res.stdout)[-3000:]
            }

        return {"ecosystem": "unknown", "success": True, "output": "Nenhum runner de teste detectado automaticamente."}

    def verify_git_signing_config(self, repo_path: str) -> bool:
        """Garante que a assinatura criptográfica obrigatória GPG está ativa."""
        res_sign = subprocess.run(["git", "config", "--get", "commit.gpgsign"], cwd=repo_path, capture_output=True, text=True)
        is_signed = (res_sign.stdout.strip() == "true")
        res_key = subprocess.run(["git", "config", "--get", "user.signingkey"], cwd=repo_path, capture_output=True, text=True)
        has_key = bool(res_key.stdout.strip())
        return is_signed and has_key

    def create_signed_commit_and_push(self, repo_path: str, branch_name: str, message: str) -> Dict[str, Any]:
        """Cria commit assinado com GPG e sobe a branch."""
        if not self.verify_git_signing_config(repo_path):
            raise RuntimeError("Assinatura Git não configurada ou sem chave GPG no repositório local!")

        # Stage
        subprocess.run(["git", "add", "-A"], cwd=repo_path, check=True)
        
        # Commit assinado (-S)
        commit_cmd = ["git", "commit", "-S", "-m", f"fix: {message} [auto-fixer]"]
        commit_res = subprocess.run(commit_cmd, cwd=repo_path, capture_output=True, text=True)
        if commit_res.returncode != 0:
            return {"success": False, "error": commit_res.stderr}

        # Push
        push_cmd = ["git", "push", "origin", branch_name]
        push_res = subprocess.run(push_cmd, cwd=repo_path, capture_output=True, text=True)
        if push_res.returncode != 0:
            return {"success": False, "error": push_res.stderr}

        return {"success": True, "message": "Commit assinado criado e enviado com sucesso!"}
