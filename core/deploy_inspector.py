import os
import subprocess
import json
import re
from typing import Dict, Any, List, Optional

class DeployInspector:
    """Inspeciona pipelines de CI/CD, deploys e previews de acordo com o tipo de projeto."""

    def __init__(self, argocd_mcp_path: Optional[str] = None):
        self.argocd_mcp_path = argocd_mcp_path or os.environ.get(
            "ARGOCD_MCP_PATH",
            os.path.expanduser("~/.config/opencode/mcp/argocd")
        )
        self.argocd_available = os.path.exists(self.argocd_mcp_path)

    def get_pr_checks(self, repo: str, pr_number: int) -> Dict[str, Any]:
        """Obtém status completo dos checks do GitHub Actions para o PR."""
        cmd = ["gh", "pr", "checks", str(pr_number), "--repo", repo]
        res = subprocess.run(cmd, capture_output=True, text=True)
        
        checks = []
        passed = 0
        failed = 0
        pending = 0

        for line in res.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split("\t") if p.strip()]
            if len(parts) >= 2:
                name = parts[0]
                status = parts[1].lower()
                url = parts[3] if len(parts) > 3 else ""
                
                if "pass" in status:
                    passed += 1
                elif "fail" in status:
                    failed += 1
                else:
                    pending += 1

                checks.append({"name": name, "status": status, "url": url})

        overall = "SUCCESS"
        if failed > 0:
            overall = "FAILED"
        elif pending > 0:
            overall = "PENDING"

        return {
            "overall": overall,
            "total": len(checks),
            "passed": passed,
            "failed": failed,
            "pending": pending,
            "checks": checks[:20] # Top 20 relevantes
        }

    def detect_frontend_preview_or_publish(self, comments: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Para frontend, detecta preview deploy e links de staging/VRT via comentários."""
        preview_url = None
        vrt_url = None
        bundle_change = None

        for c in comments:
            body = c.get("body", "")
            # Preview deploy genérico (ex: *.vercel.app, *.preview.*, *.staging.*, *.dev)
            match_preview = re.search(r"https://[a-zA-Z0-9.-]+\.(?:vercel\.app|netlify\.app|[a-zA-Z0-9-]+\.(?:dev|services|io|com))", body)
            if match_preview and not preview_url:
                preview_url = match_preview.group(0)

            # VRT (Visual Regression Testing genérico)
            match_vrt = re.search(r"https://vrt[a-zA-Z0-9.-]*\.[a-zA-Z0-9.-]+[^\s)]+", body)
            if match_vrt and not vrt_url:
                vrt_url = match_vrt.group(0)

            # Bundle Analysis
            if "Bundle Analysis" in body:
                match_bundle = re.search(r"Global Bundle Size.*?([🟡🔴🟢].*?B)", body)
                if match_bundle:
                    bundle_change = match_bundle.group(1)

        return {
            "has_preview": bool(preview_url),
            "preview_url": preview_url,
            "vrt_url": vrt_url,
            "bundle_change": bundle_change
        }

    def inspect_argocd_service(self, service_name: str, env: str = "staging") -> Dict[str, Any]:
        """Para backends e microserviços, consulta o estado de deploy no ArgoCD via MCP."""
        if not self.argocd_available:
            return {"available": False, "reason": "ArgoCD MCP não disponível"}

        # Executa de forma isolada chamando o server.py do MCP
        py_code = f"""
import sys
sys.path.append("{self.argocd_mcp_path}")
import server
import json

try:
    apps = server.argocd_list_applications(env="{env}", search="{service_name}")
    print(json.dumps(apps))
except Exception as e:
    print(json.dumps({{"error": str(e)}}))
"""
        cmd = ["uv", "run", "--with", "mcp", "--with", "cryptography", "--with", "httpx", "python3", "-c", py_code]
        res = subprocess.run(cmd, capture_output=True, text=True)
        
        try:
            # Pega a última linha válida em JSON
            lines = [l.strip() for l in res.stdout.strip().split("\n") if l.strip().startswith("[") or l.strip().startswith("{")]
            if not lines:
                return {"available": False, "error": res.stderr}
            
            data = json.loads(lines[-1])
            if isinstance(data, list) and data:
                app = data[0]
                return {
                    "available": True,
                    "app_name": app.get("name"),
                    "health": app.get("health"),
                    "sync": app.get("sync"),
                    "revision": app.get("targetRevision")
                }
            return {"available": True, "app_name": None, "status": "App não encontrada no ArgoCD"}
        except Exception as e:
            return {"available": False, "error": str(e)}

    def inspect_pr(self, repo: str, pr_number: int, pr_comments: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Executa a inspeção unificada de CI, Deploy e Previews."""
        repo_name = repo.split("/")[-1].lower()
        ci_status = self.get_pr_checks(repo, pr_number)

        is_frontend = any(k in repo_name for k in ["app", "admin", "front", "client", "ui"])
        
        result: Dict[str, Any] = {
            "repo": repo,
            "pr_number": pr_number,
            "ci": ci_status,
            "is_frontend": is_frontend
        }

        if is_frontend:
            result["frontend"] = self.detect_frontend_preview_or_publish(pr_comments)
        else:
            # Backend: busca no ArgoCD
            svc_name = repo_name.replace("-svc", "").replace("-backend", "")
            result["backend"] = self.inspect_argocd_service(svc_name)

        return result
