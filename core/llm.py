import os
import json
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional

class LLMClient:
    def __init__(
        self,
        model: Optional[str] = None,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 8192
    ):
        self.api_base = (api_base or os.environ.get("LLM_API_BASE") or os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        self.api_key = api_key or os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("FBR_API_KEY")
        self.model = model or os.environ.get("FAST_MODEL") or "gpt-4o-mini"
        self.temperature = temperature
        self.max_tokens = max_tokens

    def complete(self, messages: List[Dict[str, str]], system_prompt: Optional[str] = None, override_model: Optional[str] = None) -> str:
        if not self.api_key:
            raise ValueError("Chave de API do LLM não configurada! Defina LLM_API_KEY ou configure na aba Configurações.")

        target_model = override_model or self.model
        url = f"{self.api_base}/chat/completions"
        payload_messages = []
        if system_prompt:
            payload_messages.append({"role": "system", "content": system_prompt})
        payload_messages.extend(messages)

        payload = {
            "model": target_model,
            "messages": payload_messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            },
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                choices = data.get("choices", [])
                if not choices:
                    return ""
                msg = choices[0].get("message", {})
                content = msg.get("content")
                if content:
                    return content
                return msg.get("reasoning_content") or ""
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            raise RuntimeError(f"Erro na chamada do LLM ({e.code}): {err_body}")
        except Exception as e:
            raise RuntimeError(f"Falha de conexão com LLM: {e}")
