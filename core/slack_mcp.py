import sys
import os
from typing import List, Dict, Any, Optional

# Slack MCP Server path (configurable via environment variable)
SLACK_MCP_PATH = os.environ.get(
    "SLACK_MCP_PATH",
    os.path.expanduser("~/.config/opencode/mcp/slack-user")
)
if os.path.exists(SLACK_MCP_PATH) and SLACK_MCP_PATH not in sys.path:
    sys.path.append(SLACK_MCP_PATH)

try:
    import server as slack_server  # type: ignore
except ImportError:
    slack_server = None  # type: ignore

class SlackMCPBridge:
    def __init__(self):
        if not slack_server:
            raise RuntimeError("Não foi possível carregar o MCP do Slack em " + SLACK_MCP_PATH)

    def read_channel(self, channel_id: str, limit: int = 30) -> List[Dict[str, Any]]:
        """Lê mensagens recentes de um canal usando o MCP nativo."""
        assert slack_server is not None
        res = slack_server.slack_read_channel(channel_id=channel_id, limit=limit)
        if isinstance(res, str):
            import json
            res = json.loads(res)
        return res.get("messages", [])

    def add_reaction(self, channel_id: str, timestamp: str, name: str) -> bool:
        """Adiciona reação de emoji na mensagem."""
        assert slack_server is not None
        try:
            slack_server.slack_add_reaction(channel_id=channel_id, timestamp=timestamp, name=name)
            return True
        except Exception as e:
            # Se já tiver a reação, o Slack retorna 'already_reacted'
            if "already_reacted" in str(e):
                return True
            print(f"Aviso ao adicionar reação :{name}: {e}")
            return False

    def remove_reaction(self, channel_id: str, timestamp: str, name: str) -> bool:
        assert slack_server is not None
        try:
            slack_server.slack_remove_reaction(channel_id=channel_id, timestamp=timestamp, name=name)
            return True
        except Exception:
            return False

    def send_thread_reply(self, channel_id: str, thread_ts: str, text: str) -> Dict[str, Any]:
        """Responde diretamente na thread do PR."""
        assert slack_server is not None
        return slack_server.slack_send_message(channel_id=channel_id, text=text, thread_ts=thread_ts)

    def create_draft(self, channel_id: str, thread_ts: str, text: str) -> Dict[str, Any]:
        """Cria um draft para aprovação manual."""
        assert slack_server is not None
        return slack_server.slack_create_draft(channel_id=channel_id, thread_ts=thread_ts, text=text)
