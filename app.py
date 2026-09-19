import os
import sys
import yaml
import asyncio
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from core.state_store import StateStore
from core.sessions_reader import OpenCodeSessionReader
from core.llm import LLMClient
from core.prompt_optimizer import PromptOptimizer
from core.slack_mcp import SlackMCPBridge
from core.github_mcp import GitHubMCPBridge
from core.task_sync import TaskSyncEngine
from core.llm_gateway import MultiProviderLLMGateway
from core.config_loader import load_yaml_with_env
from watchers.pr_reviewer.watcher import PRReviewerWatcher

app = FastAPI(title="Personal AI Assistant & Watcher Hub", version="2.1.0")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.yaml")

def get_config() -> dict:
    if os.path.exists(CONFIG_PATH):
        return load_yaml_with_env(CONFIG_PATH)
    return {}

config = get_config()
state_store = StateStore(os.path.join(BASE_DIR, config.get("storage", {}).get("db_path", "data/watchers.db")))
prompt_optimizer = PromptOptimizer(state_store, config)
slack_bridge = SlackMCPBridge()
github_bridge = GitHubMCPBridge()
task_sync_engine = TaskSyncEngine(config=config)
llm_gateway = MultiProviderLLMGateway(config=config)

pr_reviewer = PRReviewerWatcher(config, state_store)
watcher_status = {
    "pr_reviewer": {
        "name": "Pull Request Reviewer (Multi-Agent)",
        "description": "Triagem rápida com GLM 5.3 Flash + Auditoria Crítica com Gemini 3.8 Flash. Integrado ao Slack e GitHub.",
        "status": "IDLE",
        "last_run": None,
        "interval_minutes": config.get("watchers", {}).get("pr_reviewer", {}).get("interval_minutes", 30),
        "channels": config.get("watchers", {}).get("pr_reviewer", {}).get("slack_channels", []),
        "models": {
            "triage": config.get("models", {}).get("fast_model", "gateway/glm-5.3-flash"),
            "review": config.get("models", {}).get("reasoning_model", "gateway/gemini-3.8-flash")
        }
    }
}

# --- Pydantic Models ---
class InitiativeCreate(BaseModel):
    title: str
    category: str
    priority: str
    description: str

class InitiativeUpdate(BaseModel):
    status: str

class ChatMessage(BaseModel):
    message: str
    model: Optional[str] = None

class PromptVersionCreate(BaseModel):
    agent_key: str
    name: str
    system_prompt: str
    change_reason: str
    set_active: bool = True

class PromptActivate(BaseModel):
    version: int

class OptimizePromptRequest(BaseModel):
    agent_key: str
    user_style_instructions: str
    include_recent_reviews: bool = True

class StyleSampleCreate(BaseModel):
    sample_type: str
    content: str

class PublishGitHubRequest(BaseModel):
    repo: str
    pr_number: int
    content: str
    action: str = "COMMENT" # COMMENT, APPROVE, REQUEST_CHANGES

class PublishSlackRequest(BaseModel):
    channel_id: str
    message_ts: str
    text: str
    reaction: Optional[str] = None
    create_draft_only: bool = False

# --- Static Files / Frontend ---
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

@app.get("/", response_class=HTMLResponse)
def serve_dashboard():
    index_file = os.path.join(BASE_DIR, "static", "index.html")
    if os.path.exists(index_file):
        with open(index_file, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>Index.html não encontrado</h1>"

# --- API Endpoints: Models & Config ---
@app.get("/api/models")
def get_available_models():
    models_cfg = config.get("models", {})
    return {
        "default_fast": models_cfg.get("fast_model", "gateway/glm-5.3-flash"),
        "default_reasoning": models_cfg.get("reasoning_model", "gateway/gemini-3.8-flash"),
        "available": models_cfg.get("available_models", [])
    }

# --- API Endpoints: Publicação Controlada com 1 Clique ---
@app.post("/api/reviews/publish-github")
def publish_to_github(req: PublishGitHubRequest):
    """Permite ao usuário publicar manualmente a análise no GitHub após revisar o texto na UI."""
    try:
        formatted_body = req.content
        if not formatted_body.startswith("🤖"):
            formatted_body = f"🤖 **AI Code Review (Multi-Agent: GLM 5.3 Flash + Gemini 3.8 Flash)**\n\n{formatted_body}"
        
        ok = github_bridge.post_pr_review_comment(
            repo=req.repo,
            pr_number=req.pr_number,
            body=formatted_body,
            action=req.action
        )
        if not ok:
            raise HTTPException(status_code=500, detail="Erro ao postar review no GitHub CLI")
        return {"status": "ok", "message": f"Review publicado no {req.repo}#{req.pr_number} com ação {req.action}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/reviews/publish-slack")
def publish_to_slack(req: PublishSlackRequest):
    """Permite enviar a notificação na thread do Slack ou criar um draft privado."""
    try:
        # Se for draft
        if req.create_draft_only:
            res = slack_bridge.create_draft(channel_id=req.channel_id, thread_ts=req.message_ts, text=req.text)
            return {"status": "ok", "type": "draft", "message": "Draft criado no seu Slack!"}
        
        # Envio direto na thread
        res = slack_bridge.send_thread_reply(channel_id=req.channel_id, thread_ts=req.message_ts, text=req.text)
        
        # Opcionalmente adiciona emoji
        if req.reaction:
            slack_bridge.add_reaction(channel_id=req.channel_id, timestamp=req.message_ts, name=req.reaction)

        return {"status": "ok", "type": "sent", "message": "Mensagem postada na thread do Slack!"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- API Endpoints: Prompt Studio & Versioning ---
@app.get("/api/prompts")
def list_prompts(agent_key: Optional[str] = None):
    return state_store.list_prompts(agent_key=agent_key)

@app.post("/api/prompts")
def create_prompt_version(item: PromptVersionCreate):
    version = state_store.create_prompt_version(
        agent_key=item.agent_key,
        name=item.name,
        system_prompt=item.system_prompt,
        change_reason=item.change_reason,
        set_active=item.set_active
    )
    return {"status": "ok", "version": version}

@app.post("/api/prompts/{agent_key}/activate")
def activate_prompt(agent_key: str, item: PromptActivate):
    state_store.activate_prompt_version(agent_key, item.version)
    return {"status": "ok", "active_version": item.version}

@app.post("/api/prompts/optimize")
def optimize_prompt(req: OptimizePromptRequest):
    try:
        result = prompt_optimizer.optimize_with_style_and_history(
            agent_key=req.agent_key,
            user_style_instructions=req.user_style_instructions,
            include_recent_reviews=req.include_recent_reviews
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- API Endpoints: Style Samples ---
@app.get("/api/style-samples")
def list_style_samples():
    return state_store.list_style_samples()

@app.post("/api/style-samples")
def add_style_sample(sample: StyleSampleCreate):
    state_store.add_style_sample(sample.sample_type, sample.content)
    return {"status": "ok"}

# --- API Endpoints: Watchers & Reviews ---
@app.get("/api/watchers")
def list_watchers():
    return watcher_status

@app.post("/api/watchers/pr_reviewer/run")
async def trigger_pr_reviewer(background_tasks: BackgroundTasks, dry_run: bool = False):
    if watcher_status["pr_reviewer"]["status"] == "RUNNING":
        raise HTTPException(status_code=400, detail="Watcher já está em execução")

    def run_task():
        import time
        watcher_status["pr_reviewer"]["status"] = "RUNNING"
        try:
            results = pr_reviewer.run(dry_run=dry_run)
            watcher_status["pr_reviewer"]["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")
            state_store.record_run("pr_reviewer", "SUCCESS", f"Processou {len(results)} PRs")
        except Exception as e:
            state_store.record_run("pr_reviewer", "ERROR", str(e))
        finally:
            watcher_status["pr_reviewer"]["status"] = "IDLE"

    background_tasks.add_task(run_task)
    return {"message": "PR Reviewer iniciado em segundo plano", "dry_run": dry_run}

@app.get("/api/reviews")
def get_reviews(limit: int = 50):
    return state_store.list_pr_reviews(limit=limit)

@app.get("/api/runs")
def get_runs(limit: int = 20):
    return state_store.list_runs(limit=limit)

# --- API Endpoints: OpenCode Sessions & Contexts ---
@app.get("/api/sessions")
def get_opencode_sessions(limit: int = 30):
    return OpenCodeSessionReader.list_sessions(limit=limit)

# --- API Endpoints: Minhas Iniciativas ---
@app.get("/api/initiatives")
def get_initiatives():
    return state_store.list_initiatives()

@app.post("/api/initiatives")
def create_initiative(item: InitiativeCreate):
    state_store.add_initiative(
        title=item.title,
        category=item.category,
        priority=item.priority,
        description=item.description
    )
    return {"status": "ok"}

@app.patch("/api/initiatives/{init_id}")
def update_initiative(init_id: int, item: InitiativeUpdate):
    state_store.update_initiative_status(init_id, item.status)
    return {"status": "ok"}

# --- API Endpoints: Task Reconciliation (Shortcut / Jira / GitHub Issues) ---
class CreateTaskRequest(BaseModel):
    repo: Optional[str] = ""
    title: str
    description: str
    story_type: str = "feature"
    workflow_state_id: Optional[int] = None
    project_id: Optional[int] = None
    iteration_id: Optional[int] = None

class GenerateTaskDraftRequest(BaseModel):
    repo: str
    pr_number: int
    title: str
    summary: str
    url: str

class AddTaskCommentRequest(BaseModel):
    repo: Optional[str] = ""
    task_id: str
    comment: str

class SettingsUpdateRequest(BaseModel):
    llm_provider: Optional[str] = None
    llm_api_base: Optional[str] = None
    llm_api_key: Optional[str] = None
    fast_model: Optional[str] = None
    reasoning_model: Optional[str] = None
    task_tracker_provider: Optional[str] = None
    task_tracker_token: Optional[str] = None
    task_tracker_base: Optional[str] = None
    github_user: Optional[str] = None

@app.get("/api/tasks/metadata")
def get_task_metadata():
    """Retorna os workflows/boards, projetos e iterações disponíveis no task tracker ativo."""
    return task_sync_engine.get_metadata()

@app.get("/api/settings")
def get_settings():
    llm_cfg = config.get("llm", {})
    tracker_cfg = config.get("task_tracker", {})
    user_cfg = config.get("user", {})
    return {
        "llm_provider": os.environ.get("LLM_PROVIDER") or llm_cfg.get("provider", "openai_compatible"),
        "llm_api_base": os.environ.get("LLM_API_BASE") or llm_cfg.get("api_base", "https://api.openai.com/v1"),
        "has_llm_key": bool(os.environ.get("LLM_API_KEY") or llm_cfg.get("api_key")),
        "fast_model": os.environ.get("FAST_MODEL") or llm_cfg.get("models", {}).get("fast", "gpt-4o-mini"),
        "reasoning_model": os.environ.get("REASONING_MODEL") or llm_cfg.get("models", {}).get("reasoning", "gpt-4o"),
        "task_tracker_provider": os.environ.get("TASK_TRACKER_PROVIDER") or tracker_cfg.get("provider", "shortcut"),
        "task_tracker_base": os.environ.get("TASK_TRACKER_BASE") or tracker_cfg.get("api_base", "https://api.app.shortcut.com/api/v3"),
        "has_tracker_token": bool(os.environ.get("TASK_TRACKER_TOKEN") or tracker_cfg.get("api_token")),
        "github_user": os.environ.get("GITHUB_USER") or user_cfg.get("github_username", "octocat")
    }

class TestConnectionRequest(BaseModel):
    provider: str
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None

@app.post("/api/settings/test-connection")
async def test_connection(req: TestConnectionRequest):
    """Testa ativamente a conexão com o provedor de LLM ou Task Tracker."""
    if req.provider == "llm":
        base = req.api_base or os.environ.get("LLM_API_BASE") or "https://api.openai.com/v1"
        key = req.api_key or os.environ.get("LLM_API_KEY") or os.environ.get("FBR_API_KEY") or ""
        model = req.model or os.environ.get("FAST_MODEL") or "gpt-4o-mini"
        if not key:
            raise HTTPException(status_code=400, detail="Chave de API do LLM não fornecida.")
        try:
            res = await llm_gateway.test_provider_connection(base, key, model)
            return {"status": "ok", "message": f"Conectado com sucesso! Latência: {res['latency_ms']}ms"}
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Falha de conexão com LLM: {str(e)}")

    elif req.provider == "task_tracker":
        tracker_type = os.environ.get("TASK_TRACKER_PROVIDER", "shortcut")
        token = req.api_key or os.environ.get("TASK_TRACKER_TOKEN") or ""
        base = req.api_base or os.environ.get("TASK_TRACKER_BASE") or "https://api.app.shortcut.com/api/v3"
        if tracker_type == "shortcut":
            if not token:
                raise HTTPException(status_code=400, detail="Token do Shortcut não fornecido.")
            import urllib.request
            req_sc = urllib.request.Request(f"{base.rstrip('/')}/member", headers={"Shortcut-Token": token})
            try:
                with urllib.request.urlopen(req_sc, timeout=10) as resp:
                    if resp.status == 200:
                        return {"status": "ok", "message": "Conectado ao Shortcut com sucesso!"}
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Falha de conexão com Shortcut: {str(e)}")
        elif tracker_type == "github_issues":
            import subprocess
            res_gh = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True)
            if res_gh.returncode == 0:
                return {"status": "ok", "message": "GitHub CLI autenticado com sucesso!"}
            raise HTTPException(status_code=400, detail=f"GitHub CLI não autenticado: {res_gh.stderr}")

    return {"status": "ok", "message": "Provedor verificado."}

@app.post("/api/settings")
def update_settings(req: SettingsUpdateRequest):
    if req.llm_provider: os.environ["LLM_PROVIDER"] = req.llm_provider
    if req.llm_api_base: os.environ["LLM_API_BASE"] = req.llm_api_base
    if req.llm_api_key: os.environ["LLM_API_KEY"] = req.llm_api_key
    if req.fast_model: os.environ["FAST_MODEL"] = req.fast_model
    if req.reasoning_model: os.environ["REASONING_MODEL"] = req.reasoning_model
    if req.task_tracker_provider: os.environ["TASK_TRACKER_PROVIDER"] = req.task_tracker_provider
    if req.task_tracker_token: os.environ["TASK_TRACKER_TOKEN"] = req.task_tracker_token
    if req.task_tracker_base: os.environ["TASK_TRACKER_BASE"] = req.task_tracker_base
    if req.github_user: os.environ["GITHUB_USER"] = req.github_user

    # Reinstancia os engines com as novas configurações
    global task_sync_engine, prompt_optimizer
    task_sync_engine = TaskSyncEngine(config=config)
    prompt_optimizer = PromptOptimizer(state_store, config)
    return {"status": "ok", "message": "Configurações atualizadas com sucesso!"}

@app.get("/api/tasks/reconcile")
@app.get("/api/shortcut/reconcile")
def get_task_reconcile():
    """Analisa PRs recentes e histórico para gerar propostas de sincronização com o Task Tracker."""
    reviews = state_store.list_pr_reviews(limit=25)
    prs = []
    for r in reviews:
        prs.append({
            "repo": r["repo"],
            "pr_number": r["pr_number"],
            "title": f"{r['repo']} PR #{r['pr_number']}",
            "body": r["review_summary"],
            "author": r.get("author", ""),
            "url": f"https://github.com/{r['repo']}/pull/{r['pr_number']}"
        })
    current_user = os.environ.get("GITHUB_USER") or config.get("user", {}).get("github_username") or "octocat"
    proposals = task_sync_engine.reconcile_prs(prs, current_user=current_user)
    return proposals

@app.post("/api/tasks/generate-draft")
@app.post("/api/shortcut/generate-draft")
def generate_task_draft(req: GenerateTaskDraftRequest):
    """Utiliza o modelo de IA configurado para gerar o título e a descrição completa em Markdown."""
    draft = task_sync_engine.generate_task_content_with_ai(
        repo=req.repo,
        pr_num=req.pr_number,
        title=req.title,
        summary=req.summary,
        url=req.url
    )
    return draft

@app.post("/api/tasks/create")
@app.post("/api/shortcut/create-story")
def create_task(req: CreateTaskRequest):
    res = task_sync_engine.create_task_from_pr(
        repo=req.repo or "",
        title=req.title,
        description=req.description,
        task_type=req.story_type,
        workflow_state_id=req.workflow_state_id,
        project_id=req.project_id,
        iteration_id=req.iteration_id
    )
    return res

@app.post("/api/tasks/comment")
@app.post("/api/shortcut/comment-story")
def comment_task(req: AddTaskCommentRequest):
    res = task_sync_engine.add_comment_to_task(repo=req.repo or "", task_id=req.task_id, comment=req.comment)
    return res

# --- API Endpoints: Personal Assistant Chat ---
@app.get("/api/assistant/chat")
def get_assistant_chat():
    return state_store.get_chat_history()

@app.post("/api/assistant/chat")
def post_assistant_chat(msg: ChatMessage):
    state_store.add_chat_message("user", msg.message)

    initiatives = state_store.list_initiatives()
    reviews = state_store.list_pr_reviews(limit=5)
    sessions = OpenCodeSessionReader.list_sessions(limit=5)

    assistant_prompt_record = state_store.get_active_prompt("personal_assistant")
    base_instructions = assistant_prompt_record["system_prompt"] if assistant_prompt_record else "Você é o assistente técnico."

    context_summary = f"""{base_instructions}

Contexto do Momento:
- Iniciativas ativas cadastradas: {len(initiatives)}
- Últimos PRs revisados pelo watcher: {[r['repo'] + '#' + str(r['pr_number']) + ' (' + r['status'] + ')' for r in reviews]}
- Sessões recentes de trabalho: {[s['title'] for s in sessions]}
"""
    llm_cfg = config.get("llm", {})
    chosen_model = msg.model or os.environ.get("FAST_MODEL") or llm_cfg.get("models", {}).get("fast", "gpt-4o-mini")
    api_base = os.environ.get("LLM_API_BASE") or llm_cfg.get("api_base") or config.get("api_base")
    api_key = os.environ.get("LLM_API_KEY") or llm_cfg.get("api_key")

    llm = LLMClient(
        model=chosen_model,
        api_base=api_base,
        api_key=api_key
    )

    try:
        reply = llm.complete(
            messages=[{"role": "user", "content": msg.message}],
            system_prompt=context_summary,
            override_model=chosen_model
        )
    except Exception as e:
        reply = f"Erro ao processar com o modelo ({chosen_model}): {e}"

    state_store.add_chat_message("assistant", reply)
    return {"reply": reply, "model_used": chosen_model}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8080, reload=True)
