import sqlite3
import os
import json
from typing import Optional, Dict, Any, List
from datetime import datetime

class StateStore:
    def __init__(self, db_path: str = "data/watchers.db"):
        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            # PR Reviews
            conn.execute("""
                CREATE TABLE IF NOT EXISTS pr_reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    channel_id TEXT NOT NULL,
                    message_ts TEXT NOT NULL,
                    repo TEXT NOT NULL,
                    pr_number INTEGER NOT NULL,
                    head_sha TEXT NOT NULL,
                    status TEXT NOT NULL, -- 'APPROVE', 'COMMENT', 'REQUEST_CHANGES', 'FAILED'
                    review_summary TEXT,
                    author TEXT,
                    ci_status TEXT,
                    deploy_status TEXT,
                    preview_url TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(repo, pr_number, head_sha)
                )
            """)
            # Watcher execution history
            conn.execute("""
                CREATE TABLE IF NOT EXISTS watcher_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    watcher_name TEXT NOT NULL,
                    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    status TEXT NOT NULL,
                    details TEXT
                )
            """)
            # Minhas Iniciativas & Projetos
            conn.execute("""
                CREATE TABLE IF NOT EXISTS initiatives (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    category TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    description TEXT,
                    slack_threads TEXT,
                    pr_links TEXT,
                    notes TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Chat do Personal Assistant
            conn.execute("""
                CREATE TABLE IF NOT EXISTS assistant_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Versionamento de Prompts dos Agentes
            conn.execute("""
                CREATE TABLE IF NOT EXISTS agent_prompts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_key TEXT NOT NULL, -- 'pr_triage', 'pr_review', 'personal_assistant', 'slack_style'
                    version INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    system_prompt TEXT NOT NULL,
                    change_reason TEXT,     -- Ex: 'Ajuste inicial', 'Auto-otimizado com histórico de PRs', 'Estilo personalizado'
                    is_active BOOLEAN DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(agent_key, version)
                )
            """)
            # Amostras do estilo do usuário (exemplos de mensagens suas no Slack, comentários de review, etc)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS style_samples (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sample_type TEXT NOT NULL, -- 'slack_message', 'pr_comment', 'guideline'
                    content TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

        # Seed inicial dos prompts se tabela estiver vazia
        self._seed_default_prompts()

    def _seed_default_prompts(self):
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM agent_prompts")
            count = cursor.fetchone()[0]
            if count == 0:
                # PR Triage (GLM 5.3 Flash)
                conn.execute("""
                    INSERT INTO agent_prompts (agent_key, version, name, system_prompt, change_reason, is_active)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    "pr_triage",
                    1,
                    "Agente de Triagem Rápida (GLM 5.3 Flash)",
                    """Você é o Agente de Triagem de Pull Requests.
Sua função é realizar um parsing rápido, categorizar a mudança e produzir um sumário executivo conciso para alimentar o Agente de Auditoria Crítica.

Retorne:
1. Categoria da mudança (Fix / Feature / Refactor / Config / Dependency).
2. Arquivos de maior sensibilidade (banco de dados, concorrência, auth, pagamentos, rotas públicas).
3. Resumo executivo em 2 parágrafos do que está sendo alterado.""",
                    "Versão inicial padrão",
                    1
                ))

                # PR Review Crítico (Gemini 3.8 Flash)
                conn.execute("""
                    INSERT INTO agent_prompts (agent_key, version, name, system_prompt, change_reason, is_active)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    "pr_review",
                    1,
                    "Auditor Crítico de Código (Gemini 3.8 Flash)",
                    """Você é um Senior Principal Engineer e Especialista em Code Review rigoroso.
Sua missão é realizar uma revisão crítica, estritamente orientada a evidências e defeitos reais introduzidos pelo Pull Request.
Você recebe a triagem prévia feita pelo Agente de Triagem e o diff completo.

Diretrizes Obrigatórias:
1. SEM NITPICKS COSMÉTICOS: Não reclame de estilo, identação, espaçamento ou preferências subjetivas caso não violem convenções fundamentais do projeto.
2. FOCO EM CRITICIDADE:
   - Regressões funcionais e comportamento incorreto para entradas válidas ou bordas óbvias.
   - Idempotência, atomicidade e concorrência (ex: processamento duplicado de eventos, race conditions).
   - Vazamento de dados, falhas de segurança, autenticação e autorização fraca.
   - Tratamento de erros silenciosos (catch engolindo erro sem log/rethrow).
   - Quebra de contrato de API pública ou schema de banco/eventos.
   - Gaps de testes em caminhos críticos novos ou alterados.
3. PADRÃO DE EVIDÊNCIA:
   - Cite com exatidão o arquivo e as linhas responsáveis (`caminho/arquivo:linha`).
   - Forneça um cenário claro de como e quando a falha vai ocorrer.
   - Sugira a correção técnica objetiva e pontual.
4. VEREDITO FINAL:
   - Ao final, forneça obrigatoriamente a tag `VEREDICT: [APPROVE | COMMENT | REQUEST_CHANGES]`
   - `APPROVE`: Se o PR estiver sólido, seguro e sem defeitos graves.
   - `COMMENT`: Se houver pequenos avisos/pontos de atenção que não impedem merge imediato.
   - `REQUEST_CHANGES`: Se houver bug comprovado, risco de segurança, idempotência falha ou quebra crítica.

Formato da Resposta:
# Resumo da Revisão
[2-3 frases avaliando o objetivo e impacto do PR]

## Achados Críticos (se houver)
- **[Severidade: ALTA/MÉDIA]** `arquivo:linha`
  - **Problema**: [descrição objetiva com evidência]
  - **Cenário de Falha**: [como quebra na prática]
  - **Recomendação**: [como corrigir com snippet se cabível]

## Pontos Positivos
- [1 a 2 pontos fortes da implementação]

## Veredito
VEREDICT: [APPROVE | COMMENT | REQUEST_CHANGES]""",
                    "Versão inicial padrão baseada no /pr-review",
                    1
                ))

                # Personal Assistant
                conn.execute("""
                    INSERT INTO agent_prompts (agent_key, version, name, system_prompt, change_reason, is_active)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    "personal_assistant",
                    1,
                    "Personal Tech Assistant",
                    """Você é o Personal AI Assistant do Engenheiro/Tech Lead.
Você o ajuda a gerenciar iniciativas técnicas, acompanhar revisões de PRs do time e manter a produtividade alta.
Utilize respostas diretas, técnicas e práticas.

Ao responder, utilize o contexto das iniciativas cadastradas, das últimas revisões de PRs e do histórico recente de decisões técnicas.""",
                    "Versão inicial padrão",
                    1
                ))
                conn.commit()

    # Gerenciamento de Prompts Versionados
    def get_active_prompt(self, agent_key: str) -> Optional[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM agent_prompts WHERE agent_key = ? AND is_active = 1 ORDER BY version DESC LIMIT 1",
                (agent_key,)
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def list_prompts(self, agent_key: Optional[str] = None) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            if agent_key:
                cursor.execute("SELECT * FROM agent_prompts WHERE agent_key = ? ORDER BY version DESC", (agent_key,))
            else:
                cursor.execute("SELECT * FROM agent_prompts ORDER BY agent_key ASC, version DESC")
            return [dict(r) for r in cursor.fetchall()]

    def create_prompt_version(self, agent_key: str, name: str, system_prompt: str, change_reason: str, set_active: bool = True) -> int:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COALESCE(MAX(version), 0) FROM agent_prompts WHERE agent_key = ?", (agent_key,))
            next_version = cursor.fetchone()[0] + 1

            if set_active:
                conn.execute("UPDATE agent_prompts SET is_active = 0 WHERE agent_key = ?", (agent_key,))

            cursor.execute("""
                INSERT INTO agent_prompts (agent_key, version, name, system_prompt, change_reason, is_active)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (agent_key, next_version, name, system_prompt, change_reason, 1 if set_active else 0))
            conn.commit()
            return next_version

    def activate_prompt_version(self, agent_key: str, version: int):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE agent_prompts SET is_active = 0 WHERE agent_key = ?", (agent_key,))
            conn.execute("UPDATE agent_prompts SET is_active = 1 WHERE agent_key = ? AND version = ?", (agent_key, version))
            conn.commit()

    # Estilo do Usuário / Exemplos
    def list_style_samples(self) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM style_samples ORDER BY id DESC")
            return [dict(r) for r in cursor.fetchall()]

    def add_style_sample(self, sample_type: str, content: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("INSERT INTO style_samples (sample_type, content) VALUES (?, ?)", (sample_type, content))
            conn.commit()

    # Métodos já existentes
    def is_pr_processed(self, repo: str, pr_number: int, head_sha: str) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id FROM pr_reviews WHERE repo = ? AND pr_number = ? AND head_sha = ?",
                (repo, pr_number, head_sha)
            )
            return cursor.fetchone() is not None

    def record_pr_review(
        self,
        channel_id: str,
        message_ts: str,
        repo: str,
        pr_number: int,
        head_sha: str,
        status: str,
        summary: str,
        author: str = "",
        ci_status: str = "",
        deploy_status: str = "",
        preview_url: str = ""
    ):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO pr_reviews (
                    channel_id, message_ts, repo, pr_number, head_sha, status, review_summary, author, ci_status, deploy_status, preview_url
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (channel_id, message_ts, repo, pr_number, head_sha, status, summary, author, ci_status, deploy_status, preview_url))
            conn.commit()

    def list_pr_reviews(self, limit: int = 50) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM pr_reviews ORDER BY id DESC LIMIT ?", (limit,))
            return [dict(r) for r in cursor.fetchall()]

    def record_run(self, watcher_name: str, status: str, details: str = ""):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO watcher_runs (watcher_name, status, details) VALUES (?, ?, ?)",
                (watcher_name, status, details)
            )
            conn.commit()

    def list_runs(self, limit: int = 20) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM watcher_runs ORDER BY id DESC LIMIT ?", (limit,))
            return [dict(r) for r in cursor.fetchall()]

    def list_initiatives(self) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM initiatives ORDER BY updated_at DESC")
            return [dict(r) for r in cursor.fetchall()]

    def add_initiative(self, title: str, category: str, priority: str, description: str, status: str = "IN_PROGRESS"):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO initiatives (title, category, priority, description, status)
                VALUES (?, ?, ?, ?, ?)
            """, (title, category, priority, description, status))
            conn.commit()

    def update_initiative_status(self, init_id: int, status: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE initiatives SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (status, init_id))
            conn.commit()

    def get_chat_history(self, limit: int = 30) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT role, content, created_at FROM assistant_messages ORDER BY id ASC LIMIT ?", (limit,))
            return [dict(r) for r in cursor.fetchall()]

    def add_chat_message(self, role: str, content: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("INSERT INTO assistant_messages (role, content) VALUES (?, ?)", (role, content))
            conn.commit()
