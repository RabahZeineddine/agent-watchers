from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
import os
import json
import urllib.request
import urllib.error
import re
import subprocess

class TaskTrackerProvider(ABC):
    """Interface abstrata plugável para qualquer sistema de gerenciamento de tarefas."""

    @abstractmethod
    def get_task(self, task_id: str) -> Dict[str, Any]:
        """Recupera detalhes de uma tarefa pelo identificador."""
        pass

    @abstractmethod
    def create_task(
        self,
        title: str,
        description: str,
        task_type: str = "feature",
        workflow_state_id: Optional[int] = None,
        project_id: Optional[int] = None,
        iteration_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """Cria uma nova tarefa no gerenciador com opções de estado/workflow, projeto e iteração."""
        pass

    @abstractmethod
    def add_comment(self, task_id: str, comment: str) -> Dict[str, Any]:
        """Adiciona um comentário de atualização na tarefa."""
        pass

    @abstractmethod
    def extract_task_ids(self, text: str) -> List[str]:
        """Extrai identificadores de tarefas contidos no texto (ex: sc-1234, PROJ-123, #123)."""
        pass

    @abstractmethod
    def get_metadata(self) -> Dict[str, Any]:
        """Retorna workflows, estados, projetos e iterações disponíveis."""
        pass

class ShortcutTrackerProvider(TaskTrackerProvider):
    """Implementação do Shortcut."""

    def __init__(self, api_token: Optional[str] = None, api_base: str = "https://api.app.shortcut.com/api/v3"):
        self.api_token = api_token or os.environ.get("SHORTCUT_API_TOKEN") or os.environ.get("TASK_TRACKER_TOKEN")
        self.api_base = api_base.rstrip("/")

    def _request(self, endpoint: str, method: str = "GET", data: Optional[Dict[str, Any]] = None) -> Any:
        if not self.api_token:
            return {"error": "Token do Shortcut não configurado."}

        url = f"{self.api_base}/{endpoint.lstrip('/')}"
        headers = {
            "Shortcut-Token": self.api_token,
            "Content-Type": "application/json"
        }
        body = json.dumps(data).encode("utf-8") if data else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return {"error": f"HTTP {e.code}: {e.read().decode('utf-8')}"}
        except Exception as e:
            return {"error": str(e)}

    def get_task(self, task_id: str) -> Dict[str, Any]:
        raw_id = re.sub(r"[^\d]", "", task_id)
        res = self._request(f"stories/{raw_id}")
        if "id" in res:
            return {
                "id": str(res.get("id")),
                "title": res.get("name"),
                "url": res.get("app_url"),
                "status": str(res.get("workflow_state_id"))
            }
        return res

    def get_metadata(self) -> Dict[str, Any]:
        workflows = self._request("workflows")
        projects = self._request("projects")
        iterations = self._request("iterations")

        clean_workflows = []
        clean_projects = []
        clean_iterations = []

        if isinstance(workflows, list):
            for w in workflows:
                clean_workflows.append({
                    "id": w.get("id"),
                    "name": w.get("name"),
                    "states": [
                        {"id": s.get("id"), "name": s.get("name"), "type": s.get("type")}
                        for s in w.get("states", [])
                    ]
                })

        if isinstance(projects, list):
            for p in projects:
                clean_projects.append({
                    "id": p.get("id"),
                    "name": p.get("name")
                })

        if isinstance(iterations, list):
            for it in iterations:
                clean_iterations.append({
                    "id": it.get("id"),
                    "name": it.get("name"),
                    "status": it.get("status")
                })

        return {
            "provider": "shortcut",
            "workflows": clean_workflows,
            "projects": clean_projects,
            "iterations": clean_iterations
        }

    def create_task(
        self,
        title: str,
        description: str,
        task_type: str = "feature",
        workflow_state_id: Optional[int] = None,
        project_id: Optional[int] = None,
        iteration_id: Optional[int] = None
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "name": title,
            "description": description,
            "story_type": "bug" if task_type == "bug" else "feature"
        }

        if workflow_state_id:
            payload["workflow_state_id"] = workflow_state_id
        elif project_id:
            payload["project_id"] = project_id
        else:
            meta = self.get_metadata()
            workflows = meta.get("workflows", [])
            state_found = None
            for w in workflows:
                for s in w.get("states", []):
                    if s.get("type") in ("unstarted", "backlog"):
                        state_found = s.get("id")
                        break
                if state_found:
                    break
            if state_found:
                payload["workflow_state_id"] = state_found
            elif meta.get("projects"):
                payload["project_id"] = meta["projects"][0]["id"]

        if iteration_id:
            payload["iteration_id"] = iteration_id

        res = self._request("stories", method="POST", data=payload)
        if "id" in res:
            return {
                "id": str(res.get("id")),
                "title": res.get("name"),
                "url": res.get("app_url")
            }
        return res

    def add_comment(self, task_id: str, comment: str) -> Dict[str, Any]:
        raw_id = re.sub(r"[^\d]", "", task_id)
        return self._request(f"stories/{raw_id}/comments", method="POST", data={"text": comment})

    def extract_task_ids(self, text: str) -> List[str]:
        matches = re.findall(r"(?:sc-|story/|shortcut\.com/\S+/story/)(\d{3,7})", text, re.IGNORECASE)
        return list(set(matches))

class GitHubIssuesTrackerProvider(TaskTrackerProvider):
    """Implementação nativa usando GitHub Issues."""

    def __init__(self, default_repo: Optional[str] = None):
        self.default_repo = default_repo

    def get_task(self, task_id: str) -> Dict[str, Any]:
        repo = self.default_repo
        num = task_id
        if "#" in task_id:
            repo, num = task_id.split("#", 1)
        if not repo:
            return {"error": "Repositório não especificado para a issue."}

        cmd = ["gh", "issue", "view", num, "--repo", repo, "--json", "number,title,url,state"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            data = json.loads(res.stdout)
            return {
                "id": f"{repo}#{data.get('number')}",
                "title": data.get("title"),
                "url": data.get("url"),
                "status": data.get("state")
            }
        return {"error": res.stderr}

    def get_metadata(self) -> Dict[str, Any]:
        return {
            "provider": "github_issues",
            "workflows": [
                {
                    "id": 1,
                    "name": "GitHub Project Board",
                    "states": [
                        {"id": 1, "name": "Open", "type": "unstarted"},
                        {"id": 2, "name": "Closed", "type": "done"}
                    ]
                }
            ],
            "projects": [{"id": 1, "name": self.default_repo or "Default Repo"}],
            "iterations": []
        }

    def create_task(
        self,
        title: str,
        description: str,
        task_type: str = "feature",
        workflow_state_id: Optional[int] = None,
        project_id: Optional[int] = None,
        iteration_id: Optional[int] = None
    ) -> Dict[str, Any]:
        repo = self.default_repo
        if not repo:
            return {"error": "Repositório padrão não configurado para criar issue."}
        labels = "bug" if task_type == "bug" else "enhancement"
        cmd = ["gh", "issue", "create", "--repo", repo, "--title", title, "--body", description, "--label", labels]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            url = res.stdout.strip()
            num = url.split("/")[-1]
            return {"id": f"{repo}#{num}", "title": title, "url": url}
        return {"error": res.stderr}

    def add_comment(self, task_id: str, comment: str) -> Dict[str, Any]:
        repo = self.default_repo
        num = task_id
        if "#" in task_id:
            repo, num = task_id.split("#", 1)
        cmd = ["gh", "issue", "comment", num, "--repo", repo, "--body", comment]
        res = subprocess.run(cmd, capture_output=True, text=True)
        return {"success": res.returncode == 0}

    def extract_task_ids(self, text: str) -> List[str]:
        matches = re.findall(r"([\w.-]+/[\w.-]+#\d+|\b#\d{2,6}\b)", text)
        return list(set(matches))

class MultiTrackerRouter:
    """Roteador simultâneo de múltiplos Task Trackers.
    
    Permite ter Shortcut, GitHub Issues e Jira ativos em paralelo,
    roteando automaticamente com base no repositório do PR ou no formato do ID da task.
    """

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.trackers: Dict[str, TaskTrackerProvider] = {}
        self.repo_routes: Dict[str, str] = {}
        self._init_trackers()

    def _init_trackers(self):
        tracker_cfg = self.config.get("task_tracker", {})
        
        # 1. Shortcut
        sc_token = os.environ.get("SHORTCUT_API_TOKEN") or tracker_cfg.get("api_token")
        sc_base = os.environ.get("SHORTCUT_API_BASE") or tracker_cfg.get("api_base", "https://api.app.shortcut.com/api/v3")
        if sc_token:
            self.trackers["shortcut"] = ShortcutTrackerProvider(api_token=sc_token, api_base=sc_base)

        # 2. GitHub Issues (sempre ativo usando a autenticação local do gh CLI)
        self.trackers["github_issues"] = GitHubIssuesTrackerProvider(default_repo=None)

    def get_tracker_for_repo(self, repo: str) -> TaskTrackerProvider:
        """Determina o tracker ideal para o repositório."""
        # Se houver rota específica definida no config
        tracker_key = self.repo_routes.get(repo)
        if tracker_key and tracker_key in self.trackers:
            return self.trackers[tracker_key]

        # Prioridade padrão: Shortcut se configurado, senão GitHub Issues
        if "shortcut" in self.trackers:
            return self.trackers["shortcut"]
        return self.trackers.get("github_issues") or ShortcutTrackerProvider()

    def get_all_active_trackers(self) -> Dict[str, TaskTrackerProvider]:
        return self.trackers
