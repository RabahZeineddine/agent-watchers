import re
import os
from typing import List, Dict, Any, Optional
from core.state_store import StateStore
from core.slack_mcp import SlackMCPBridge
from core.github_mcp import GitHubMCPBridge
from core.deploy_inspector import DeployInspector
from core.llm import LLMClient
from watchers.pr_reviewer.prompts import PR_TRIAGE_SYSTEM_PROMPT, PR_CRITICAL_REVIEW_SYSTEM_PROMPT

class PRReviewerWatcher:
    def __init__(self, config: Dict[str, Any], state_store: StateStore):
        self.config = config
        self.state_store = state_store
        self.slack = SlackMCPBridge()
        self.github = GitHubMCPBridge()
        self.deploy_inspector = DeployInspector()
        
        llm_cfg = config.get("llm", {})
        models_cfg = llm_cfg.get("models") or config.get("models", {})
        multi_cfg = config.get("watchers", {}).get("pr_reviewer", {}).get("multi_agent", {})
        
        self.triage_model = multi_cfg.get("triage_model") or os.environ.get("FAST_MODEL") or models_cfg.get("fast", "gpt-4o-mini")
        self.review_model = multi_cfg.get("deep_review_model") or os.environ.get("REASONING_MODEL") or models_cfg.get("reasoning", "gpt-4o")

        api_base = os.environ.get("LLM_API_BASE") or llm_cfg.get("api_base") or config.get("api_base")
        api_key = os.environ.get("LLM_API_KEY") or llm_cfg.get("api_key")
        self.llm = LLMClient(model=self.triage_model, api_base=api_base, api_key=api_key, temperature=0.1)

        self.pr_regex = re.compile(r"https://github\.com/([^/]+/[^/]+)/pull/(\d+)")

    def _get_active_prompt_or_fallback(self, agent_key: str, fallback: str) -> str:
        prompt_record = self.state_store.get_active_prompt(agent_key)
        if prompt_record and prompt_record.get("system_prompt"):
            return prompt_record["system_prompt"]
        return fallback

    def extract_prs_from_text(self, text: str) -> List[Dict[str, Any]]:
        matches = self.pr_regex.findall(text)
        prs = []
        for repo, pr_num in matches:
            prs.append({"repo": repo, "pr_number": int(pr_num)})
        return prs

    def run(self, dry_run: bool = False, max_messages: int = 20) -> List[Dict[str, Any]]:
        channels = [c for c in self.config.get("watchers", {}).get("pr_reviewer", {}).get("slack_channels", []) if c]
        actions_cfg = self.config.get("watchers", {}).get("pr_reviewer", {}).get("actions", {})
        processed_results = []

        triage_system_prompt = self._get_active_prompt_or_fallback("pr_triage", PR_TRIAGE_SYSTEM_PROMPT)
        review_system_prompt = self._get_active_prompt_or_fallback("pr_review", PR_CRITICAL_REVIEW_SYSTEM_PROMPT)

        print(f"Iniciando PRReviewerWatcher Multi-Agent (Triagem: {self.triage_model} | Review: {self.review_model})")

        for channel_id in channels:
            try:
                messages = self.slack.read_channel(channel_id=channel_id, limit=max_messages)
            except Exception as e:
                print(f"Erro ao ler canal {channel_id}: {e}")
                continue

            for msg in messages:
                text = msg.get("text", "")
                ts = msg.get("ts")
                if not ts or not isinstance(ts, str):
                    continue
                prs = self.extract_prs_from_text(text)

                for pr_info in prs:
                    repo = pr_info["repo"]
                    pr_num = pr_info["pr_number"]

                    try:
                        pr_details = self.github.get_pr_details(repo, pr_num)
                        head_sha = pr_details.get("headRefOid", "")
                        state = pr_details.get("state", "OPEN")
                        is_draft = pr_details.get("isDraft", False)
                        author_login = pr_details.get("author", {}).get("login", "")

                        if state != "OPEN":
                            continue

                        current_user = self.config.get("user", {}).get("github_username") or self.config.get("github_user", "")

                        if self.state_store.is_pr_processed(repo, pr_num, head_sha):
                            continue

                        print(f"-> Novo PR detectado: {repo}#{pr_num} (commit: {head_sha[:7]})")

                        if not dry_run and actions_cfg.get("slack_reaction_on_start"):
                            self.slack.add_reaction(channel_id, ts, actions_cfg["slack_reaction_on_start"])

                        diff = self.github.get_pr_diff(repo, pr_num)
                        if len(diff) > 200000:
                            diff = diff[:200000] + "\n\n... [DIFF TRUNCADO POR TAMANHO]"

                        # Inspeção de CI / CD / Deploy / Preview
                        comments = pr_details.get("comments", [])
                        deploy_info = self.deploy_inspector.inspect_pr(repo, pr_num, comments)
                        ci_status = deploy_info.get("ci", {}).get("overall", "UNKNOWN")
                        
                        deploy_summary_text = ""
                        deploy_status_badge = "N/A"
                        preview_url = ""

                        if deploy_info.get("is_frontend"):
                            front_info = deploy_info.get("frontend", {})
                            preview_url = front_info.get("preview_url") or ""
                            vrt_url = front_info.get("vrt_url") or ""
                            deploy_status_badge = "PREVIEW_READY" if preview_url else "NO_PREVIEW"
                            deploy_summary_text = f"""
Status do Frontend:
- Preview Deploy: {preview_url or 'Não detectado'}
- Visual Regression (VRT): {vrt_url or 'N/A'}
- Bundle Size Impact: {front_info.get('bundle_change') or 'Sem alteração crítica'}
"""
                        else:
                            back_info = deploy_info.get("backend", {})
                            if back_info.get("available") and back_info.get("app_name"):
                                health = back_info.get("health", "Unknown")
                                sync = back_info.get("sync", "Unknown")
                                deploy_status_badge = f"{sync}/{health}".upper()
                                deploy_summary_text = f"""
Status do Backend no ArgoCD:
- App: {back_info.get('app_name')}
- Health: {health}
- Sync: {sync}
"""
                            else:
                                deploy_status_badge = "CI_ONLY"

                        ci_summary_text = f"""
Status dos Checks de CI (GitHub Actions):
- Status Geral: {ci_status} ({deploy_info.get('ci', {}).get('passed', 0)} passou, {deploy_info.get('ci', {}).get('failed', 0)} falhou, {deploy_info.get('ci', {}).get('pending', 0)} pendente)
"""

                        # ETAPA 1: Triagem com prompt versionado
                        print(f"  [Multi-Agent 1/2] Executando triagem com {self.triage_model}...")
                        triage_prompt = f"""Pull Request: {repo}#{pr_num} - {pr_details.get('title')}
Autor: {pr_details.get('author', {}).get('login')}
Descrição: {pr_details.get('body', '')}
{ci_summary_text}
{deploy_summary_text}
Diff:
```diff
{diff[:50000]}
```"""
                        triage_summary = self.llm.complete(
                            messages=[{"role": "user", "content": triage_prompt}],
                            system_prompt=triage_system_prompt,
                            override_model=self.triage_model
                        )

                        # ETAPA 2: Auditoria crítica com prompt versionado
                        print(f"  [Multi-Agent 2/2] Executando auditoria crítica com {self.review_model}...")
                        critical_prompt = f"""Revise o seguinte Pull Request:
Repositório: {repo}
PR #{pr_num}: {pr_details.get('title')}
Autor: {pr_details.get('author', {}).get('login')}
Base: {pr_details.get('baseRefName')} <- Head: {pr_details.get('headRefName')}

Pipeline & Deploy Status:
{ci_summary_text}
{deploy_summary_text}

Triagem Preliminar realizada pelo Agente 1:
{triage_summary}

Descrição do Autor:
{pr_details.get('body', 'Sem descrição.')}

Diff Completo das alterações:
```diff
{diff}
```"""
                        review_result = self.llm.complete(
                            messages=[{"role": "user", "content": critical_prompt}],
                            system_prompt=review_system_prompt,
                            override_model=self.review_model
                        )

                        action = "COMMENT"
                        if "VEREDICT: APPROVE" in review_result:
                            action = "APPROVE"
                        elif "VEREDICT: REQUEST_CHANGES" in review_result:
                            action = "REQUEST_CHANGES"

                        print(f"-> Veredito obtido para {repo}#{pr_num}: {action}")

                        if not dry_run and actions_cfg.get("post_to_github"):
                            github_comment = f"🤖 **AI Code Review (Multi-Agent Engine)**\n\n{review_result}"
                            self.github.post_pr_review_comment(repo, pr_num, github_comment, action=action)

                        if not dry_run:
                            if actions_cfg.get("slack_reaction_on_start"):
                                self.slack.remove_reaction(channel_id, ts, actions_cfg["slack_reaction_on_start"])

                            status_emoji = actions_cfg.get("slack_reaction_on_success", "white_check_mark")
                            if action == "REQUEST_CHANGES":
                                status_emoji = actions_cfg.get("slack_reaction_on_issues", "warning")
                            elif action == "COMMENT":
                                status_emoji = "speech_balloon"

                            self.slack.add_reaction(channel_id, ts, status_emoji)

                            if actions_cfg.get("slack_reply_thread"):
                                thread_msg = f"Revisão técnica concluída no PR com veredito `{action}`. Detalhes: {pr_details.get('url')}"
                                self.slack.send_thread_reply(channel_id, ts, thread_msg)

                        self.state_store.record_pr_review(
                            channel_id=channel_id,
                            message_ts=ts,
                            repo=repo,
                            pr_number=pr_num,
                            head_sha=head_sha,
                            status=action,
                            summary=review_result,
                            author=author_login,
                            ci_status=ci_status,
                            deploy_status=deploy_status_badge,
                            preview_url=preview_url
                        )

                        processed_results.append({
                            "repo": repo,
                            "pr_number": pr_num,
                            "action": action,
                            "summary": review_result
                        })

                    except Exception as e:
                        print(f"Erro processando PR {repo}#{pr_num}: {e}")

        return processed_results
