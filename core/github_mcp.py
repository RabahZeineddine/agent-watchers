import subprocess
import json
from typing import Dict, Any, Optional

class GitHubMCPBridge:
    """Wrapper em torno da CLI 'gh' e GitHub API que respeita a autenticação e permissões da empresa."""

    @staticmethod
    def get_pr_details(repo: str, pr_number: int) -> Dict[str, Any]:
        cmd = [
            "gh", "pr", "view",
            str(pr_number),
            "--repo", repo,
            "--json", "number,title,body,author,state,url,headRefOid,headRefName,baseRefName,additions,deletions,isDraft"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(res.stdout)

    @staticmethod
    def get_pr_diff(repo: str, pr_number: int) -> str:
        cmd = ["gh", "pr", "diff", str(pr_number), "--repo", repo]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return res.stdout

    @staticmethod
    def post_pr_review_comment(repo: str, pr_number: int, body: str, action: str = "COMMENT") -> bool:
        """
        Publica o review no GitHub.
        action: 'COMMENT', 'APPROVE', 'REQUEST_CHANGES'
        """
        flag = "--comment"
        if action == "APPROVE":
            flag = "--approve"
        elif action == "REQUEST_CHANGES":
            flag = "--request-changes"

        cmd = [
            "gh", "pr", "review",
            str(pr_number),
            "--repo", repo,
            flag,
            "--body", body
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            print(f"Erro ao postar review no GitHub: {res.stderr}")
            return False
        return True
