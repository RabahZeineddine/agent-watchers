from typing import Dict, Any, List, Optional
import os
from core.state_store import StateStore
from core.llm import LLMClient

class PromptOptimizer:
    """Utiliza os modelos para refinar e personalizar prompts dos agentes com base no histórico de reviews e no estilo do usuário."""

    def __init__(self, state_store: StateStore, config: Dict[str, Any]):
        self.state_store = state_store
        self.config = config
        
        llm_cfg = config.get("llm", {})
        api_base = os.environ.get("LLM_API_BASE") or llm_cfg.get("api_base") or config.get("api_base")
        reasoning_model = os.environ.get("REASONING_MODEL") or llm_cfg.get("models", {}).get("reasoning") or config.get("models", {}).get("reasoning_model")
        api_key = os.environ.get("LLM_API_KEY") or llm_cfg.get("api_key")

        self.llm = LLMClient(model=reasoning_model, api_base=api_base, api_key=api_key, temperature=0.2)

    def optimize_with_style_and_history(
        self,
        agent_key: str,
        user_style_instructions: str,
        include_recent_reviews: bool = True
    ) -> Dict[str, Any]:
        """Gera uma nova versão otimizada do prompt e grava no banco como nova versão."""
        current_active = self.state_store.get_active_prompt(agent_key)
        if not current_active:
            raise ValueError(f"Agente {agent_key} não encontrado no banco.")

        # Buscar histórico de reviews recentes para aprendizado
        reviews_context = ""
        if include_recent_reviews:
            recent_reviews = self.state_store.list_pr_reviews(limit=6)
            if recent_reviews:
                reviews_context = "\n\nExemplos de reviews reais gerados recentemente pela pipeline:\n"
                for r in recent_reviews:
                    reviews_context += f"--- PR: {r['repo']}#{r['pr_number']} | Veredito: {r['status']} ---\n"
                    reviews_context += f"{r['review_summary'][:600]}\n\n"

        # Buscar amostras de estilo salvas
        samples = self.state_store.list_style_samples()
        samples_context = ""
        if samples:
            samples_context = "\n\nAmostras de mensagens e estilo do usuário no Slack/GitHub:\n"
            for s in samples[:5]:
                samples_context += f"[{s['sample_type']}] {s['content']}\n"

        user_name = self.config.get("user", {}).get("name", "Tech Lead")

        meta_prompt = f"""Você é um Meta-Prompt Engineer e Especialista em Alinhamento de Agentes de IA.
Sua tarefa é REESCREVER e APRIMORAR o System Prompt do agente '{agent_key}'.

PROMPT ATUAL (Versão {current_active['version']}):
\"\"\"
{current_active['system_prompt']}
\"\"\"

INSTRUÇÕES DE ESTILO / PERSONALIZAÇÃO DO USUÁRIO ({user_name}):
\"\"\"
{user_style_instructions}
\"\"\"
{samples_context}
{reviews_context}

OBJETIVOS DA NOVA VERSÃO:
1. Incorporar com precisão o tom de voz e estilo exigido pelo usuário (ex: direto, sem rodeios, termos técnicos específicos da time, formato preferido de comunicação).
2. Manter e reforçar as regras críticas de engenharia (zero falso positivo, evidência real arquivo:linha, foco em quebra/segurança/concorrência).
3. Produzir um System Prompt pronto para produção.

RETORNE EXATAMENTE NO SEGUINTE FORMATO JSON (SEM BACKTICKS DE CÓDIGO FORA DO JSON):
{{
  "name": "{current_active['name']}",
  "system_prompt": "conteúdo completo do novo system prompt aqui...",
  "change_reason": "breve explicação das melhorias e estilo adicionado..."
}}
"""

        raw_response = self.llm.complete(
            messages=[{"role": "user", "content": meta_prompt}],
            system_prompt="Você é um assistente JSON estrito. Responda apenas com o JSON válido solicitado."
        )

        import json
        import re

        # Extrair JSON caso venha dentro de bloco ```json ... ```
        json_match = re.search(r"\{[\s\S]*\}", raw_response)
        if not json_match:
            raise RuntimeError(f"Modelo não retornou JSON válido: {raw_response[:300]}")

        parsed = json.loads(json_match.group(0))

        # Gravar nova versão no banco
        new_version = self.state_store.create_prompt_version(
            agent_key=agent_key,
            name=parsed.get("name", current_active["name"]),
            system_prompt=parsed["system_prompt"],
            change_reason=parsed.get("change_reason", user_style_instructions),
            set_active=True
        )

        return {
            "agent_key": agent_key,
            "new_version": new_version,
            "name": parsed.get("name"),
            "change_reason": parsed.get("change_reason"),
            "system_prompt": parsed["system_prompt"]
        }
