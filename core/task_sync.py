import os
import json
import re
from typing import Dict, Any, List, Optional
from core.llm_gateway import MultiProviderLLMGateway
from core.task_trackers import MultiTrackerRouter, TaskTrackerProvider

TASK_GENERATOR_SYSTEM_PROMPT = """Você é um Technical Product Manager e Tech Lead experiente.
Sua missão é gerar uma Task/Story profissional, limpa e técnica a partir do contexto de um Pull Request e de sua revisão de código.

Diretrizes:
1. TÍTULO: Conciso, no padrão da equipe (ex: "[Módulo] Descrição clara da entrega/fix", sem jargões genéricos).
2. DESCRIÇÃO: Estruture em Markdown profissional:
   - ## 🎯 Objetivo
   - ## 🛠️ O que foi feito (bullet points claros)
   - ## 🧪 Validação & Testes
   - ## 🔗 Links (PR e referências)
3. Retorne EXCLUSIVAMENTE um objeto JSON válido (sem backticks markdown fora do JSON):
{
  "title": "[Módulo] Título da Task",
  "description": "descrição completa em markdown...",
  "story_type": "feature"
}
"""

class TaskSyncEngine:
    """Motor de reconciliação com suporte nativo a Multi-Trackers simultâneos."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.router = MultiTrackerRouter(self.config)
        self.llm_gateway = MultiProviderLLMGateway(self.config)

    def extract_task_ids_for_repo(self, text: str, repo: str) -> List[str]:
        tracker = self.router.get_tracker_for_repo(repo)
        return tracker.extract_task_ids(text)

    def get_metadata(self, repo: Optional[str] = None) -> Dict[str, Any]:
        tracker = self.router.get_tracker_for_repo(repo or "")
        return tracker.get_metadata()

    async def generate_task_content_with_ai(self, repo: str, pr_num: int, title: str, summary: str, url: str) -> Dict[str, Any]:
        """Usa o gateway de LLM para gerar título e descrição."""
        prompt = f"""Gere uma Task técnica para o seguinte Pull Request:
Repositório: {repo}
PR #{pr_num}: {title}
Link: {url}

Resumo Técnico / Análise de Código:
\"\"\"
{summary[:2500]}
\"\"\""""

        try:
            res = await self.llm_gateway.complete(
                messages=[{"role": "user", "content": prompt}],
                system_prompt=TASK_GENERATOR_SYSTEM_PROMPT,
                model_tier="fast"
            )
            json_match = re.search(r"\{[\s\S]*\}", res.content)
            if json_match:
                return json.loads(json_match.group(0))
        except Exception as e:
            print(f"[TaskSyncEngine] Erro gerando task com IA: {e}")

        return {
            "title": f"[{repo.split('/')[-1]}] {title}",
            "description": f"## 🎯 Objetivo\n{title}\n\n## 🔗 PR\n[{repo}#{pr_num}]({url})\n\n{summary[:500]}",
            "story_type": "feature"
        }

    def reconcile_prs(self, pr_list: List[Dict[str, Any]], current_user: str = "") -> List[Dict[str, Any]]:
        proposals = []

        for pr in pr_list:
            repo = pr.get("repo", "")
            pr_num = pr.get("pr_number") or pr.get("number")
            title = pr.get("title", "")
            body = pr.get("body", "")
            author = pr.get("author", "")
            url = pr.get("url") or f"https://github.com/{repo}/pull/{pr_num}"

            is_mine = bool(current_user and author and (author.lower() == current_user.lower()))
            tracker = self.router.get_tracker_for_repo(repo)

            full_text = f"{title} {body} {url}"
            task_ids = tracker.extract_task_ids(full_text)

            if not task_ids:
                if is_mine:
                    proposals.append({
                        "type": "MISSING_TASK",
                        "owner_type": "MINE",
                        "author": author,
                        "badge": "Meu PR Sem Task",
                        "badge_color": "amber",
                        "pr_url": url,
                        "repo": repo,
                        "pr_number": pr_num,
                        "title": title,
                        "suggested_action": "Criar Task no Tracker para documentar meu trabalho",
                        "summary": body,
                        "task_id": None
                    })
                else:
                    proposals.append({
                        "type": "TEAM_PR_NO_TASK",
                        "owner_type": "TEAM",
                        "author": author,
                        "badge": "Time (Sem Task)",
                        "badge_color": "slate",
                        "pr_url": url,
                        "repo": repo,
                        "pr_number": pr_num,
                        "title": title,
                        "suggested_action": f"PR de {author} sem Task vinculada.",
                        "task_id": None
                    })
            else:
                for tid in task_ids:
                    task = tracker.get_task(tid)
                    if not task or "error" in task:
                        continue

                    task_title = task.get("title", "")
                    task_url = task.get("url", "")

                    proposals.append({
                        "type": "SYNC_EXISTING_TASK",
                        "owner_type": "MINE" if is_mine else "TEAM",
                        "author": author,
                        "badge": f"Task #{tid} Vinculada",
                        "badge_color": "emerald",
                        "task_id": tid,
                        "task_title": task_title,
                        "task_url": task_url,
                        "pr_url": url,
                        "repo": repo,
                        "pr_number": pr_num,
                        "title": title,
                        "suggested_action": "Adicionar nota de atualização na Task com link do PR",
                        "suggested_comment": f"PR pronto para revisão / em andamento: [{repo}#{pr_num}]({url})\n\n**Resumo**: {title}"
                    })

        return proposals

    def create_task_from_pr(
        self,
        repo: str,
        title: str,
        description: str,
        task_type: str = "feature",
        workflow_state_id: Optional[int] = None,
        project_id: Optional[int] = None,
        iteration_id: Optional[int] = None
    ) -> Dict[str, Any]:
        tracker = self.router.get_tracker_for_repo(repo)
        return tracker.create_task(
            title=title,
            description=description,
            task_type=task_type,
            workflow_state_id=workflow_state_id,
            project_id=project_id,
            iteration_id=iteration_id
        )

    def add_comment_to_task(self, repo: str, task_id: str, comment: str) -> Dict[str, Any]:
        tracker = self.router.get_tracker_for_repo(repo)
        return tracker.add_comment(task_id=task_id, comment=comment)
