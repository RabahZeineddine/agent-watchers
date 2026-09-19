import os
import json
import time
import httpx
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field

@dataclass
class LLMResult:
    content: str
    reasoning_content: Optional[str] = None
    provider_id: str = "default"
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    latency_ms: float = 0.0
    cost_usd: float = 0.0

class MultiProviderLLMGateway:
    """Gateway assíncrono e resiliente para múltiplos provedores de LLM.
    
    Suporta:
    - OpenAI, Gateway Gateway, Groq, Ollama (OpenAI-compatible)
    - Anthropic Claude nativo
    - Circuit-breaker com fallback em cadeia (Ex: tenta Provider 1 -> se der 429/timeout -> tenta Provider 2)
    - Telemetria de latência, tokens e custo estimado
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.providers = self._init_providers()

    def _init_providers(self) -> Dict[str, Dict[str, Any]]:
        providers = {}
        llm_cfg = self.config.get("llm", {})

        # 1. Provedor Primário (OpenAI-compatible ou Gateway ou Custom)
        primary_base = os.environ.get("LLM_API_BASE") or llm_cfg.get("api_base") or self.config.get("api_base") or "https://api.openai.com/v1"
        primary_key = os.environ.get("LLM_API_KEY") or llm_cfg.get("api_key") or os.environ.get("OPENAI_API_KEY") or os.environ.get("FBR_API_KEY") or ""
        providers["primary"] = {
            "type": "openai_compatible",
            "api_base": primary_base.rstrip("/"),
            "api_key": primary_key,
            "fast_model": os.environ.get("FAST_MODEL") or llm_cfg.get("models", {}).get("fast", "gpt-4o-mini"),
            "reasoning_model": os.environ.get("REASONING_MODEL") or llm_cfg.get("models", {}).get("reasoning", "gpt-4o"),
        }

        # 2. Provedor Anthropic Claude nativo (se houver chave configurada)
        anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
        if anthropic_key:
            providers["anthropic"] = {
                "type": "anthropic",
                "api_base": "https://api.anthropic.com/v1",
                "api_key": anthropic_key,
                "fast_model": "claude-3-5-haiku-20241022",
                "reasoning_model": "claude-3-7-sonnet-20250219",
            }

        # 3. Provedor Ollama Local (se disponível na máquina)
        ollama_base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
        providers["ollama"] = {
            "type": "openai_compatible",
            "api_base": ollama_base.rstrip("/"),
            "api_key": "ollama",
            "fast_model": "llama3.2:latest",
            "reasoning_model": "qwen2.5-coder:latest",
        }

        return providers

    async def complete(
        self,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str] = None,
        model_tier: str = "fast", # "fast" ou "reasoning"
        override_model: Optional[str] = None,
        preferred_provider: str = "primary"
    ) -> LLMResult:
        """Executa a inferência com fallback automático entre provedores."""
        provider_order = [preferred_provider] + [p for p in self.providers.keys() if p != preferred_provider]
        last_error = None

        for p_key in provider_order:
            provider = self.providers.get(p_key)
            if not provider or not provider.get("api_key"):
                continue

            target_model = override_model or (
                provider["fast_model"] if model_tier == "fast" else provider["reasoning_model"]
            )

            try:
                start_t = time.perf_counter()
                result = await self._call_provider(provider, target_model, messages, system_prompt)
                latency = (time.perf_counter() - start_t) * 1000.0
                result.latency_ms = round(latency, 2)
                result.provider_id = p_key
                result.model = target_model
                return result
            except Exception as e:
                print(f"[LLM Gateway] Falha no provedor '{p_key}' ({e}). Tentando fallback...")
                last_error = e

        raise RuntimeError(f"Todos os provedores de LLM falharam. Último erro: {last_error}")

    async def _call_provider(
        self,
        provider: Dict[str, Any],
        model: str,
        messages: List[Dict[str, str]],
        system_prompt: Optional[str]
    ) -> LLMResult:
        p_type = provider.get("type", "openai_compatible")

        if p_type == "openai_compatible":
            url = f"{provider['api_base']}/chat/completions"
            payload_msgs = []
            if system_prompt:
                payload_msgs.append({"role": "system", "content": system_prompt})
            payload_msgs.extend(messages)

            payload = {
                "model": model,
                "messages": payload_msgs,
                "temperature": 0.1,
                "max_tokens": 8192
            }

            headers = {
                "Authorization": f"Bearer {provider['api_key']}",
                "Content-Type": "application/json"
            }

            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                
                choice = data.get("choices", [{}])[0].get("message", {})
                content = choice.get("content") or choice.get("reasoning_content") or ""
                usage = data.get("usage", {})

                return LLMResult(
                    content=content,
                    reasoning_content=choice.get("reasoning_content"),
                    prompt_tokens=usage.get("prompt_tokens", 0),
                    completion_tokens=usage.get("completion_tokens", 0),
                    total_tokens=usage.get("total_tokens", 0),
                )

        elif p_type == "anthropic":
            url = f"{provider['api_base']}/messages"
            # Anthropic formata system prompt no header do payload
            payload = {
                "model": model,
                "messages": messages,
                "max_tokens": 4096,
                "temperature": 0.1
            }
            if system_prompt:
                payload["system"] = system_prompt

            headers = {
                "x-api-key": provider["api_key"],
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json"
            }

            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()

                blocks = data.get("content", [])
                text_content = "".join([b.get("text", "") for b in blocks if b.get("type") == "text"])
                usage = data.get("usage", {})

                return LLMResult(
                    content=text_content,
                    prompt_tokens=usage.get("input_tokens", 0),
                    completion_tokens=usage.get("output_tokens", 0),
                    total_tokens=usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
                )

        raise ValueError(f"Tipo de provedor desconhecido: {p_type}")

    async def test_provider_connection(self, api_base: str, api_key: str, model: str) -> Dict[str, Any]:
        """Testa ativamente se um endpoint e chave estão funcionais."""
        url = f"{api_base.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 5
        }
        start = time.perf_counter()
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            latency = round((time.perf_counter() - start) * 1000.0, 1)
            resp.raise_for_status()
            return {"status": "ok", "latency_ms": latency}
