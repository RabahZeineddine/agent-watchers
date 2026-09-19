import sqlite3
import os
from typing import List, Dict, Any
from datetime import datetime

class OpenCodeSessionReader:
    """Lê metadados e histórico de sessões do OpenCode local para visualização na UI."""
    DB_PATH = os.path.expanduser("~/.local/share/opencode/opencode.db")

    @classmethod
    def is_available(cls) -> bool:
        return os.path.exists(cls.DB_PATH)

    @classmethod
    def list_sessions(cls, limit: int = 40) -> List[Dict[str, Any]]:
        if not cls.is_available():
            return []

        try:
            # Conexão em modo leitura (URI com mode=ro para segurança)
            conn = sqlite3.connect(f"file:{cls.DB_PATH}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            query = """
                SELECT 
                    s.id, 
                    s.title, 
                    s.time_created, 
                    s.time_updated,
                    (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as message_count
                FROM session s
                ORDER BY s.time_updated DESC
                LIMIT ?
            """
            cursor.execute(query, (limit,))
            rows = cursor.fetchall()
            
            sessions = []
            for r in rows:
                updated_dt = datetime.fromtimestamp(r["time_updated"] / 1000).strftime("%Y-%m-%d %H:%M:%S")
                created_dt = datetime.fromtimestamp(r["time_created"] / 1000).strftime("%Y-%m-%d %H:%M:%S")
                sessions.append({
                    "id": r["id"],
                    "title": r["title"] or "Sessão sem título",
                    "created_at": created_dt,
                    "updated_at": updated_dt,
                    "message_count": r["message_count"]
                })
            conn.close()
            return sessions
        except Exception as e:
            print(f"Erro ao ler sessões do OpenCode: {e}")
            return []

    @classmethod
    def get_session_summary(cls, session_id: str) -> Dict[str, Any]:
        if not cls.is_available():
            return {"error": "DB not found"}

        try:
            conn = sqlite3.connect(f"file:{cls.DB_PATH}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # Buscar primeiras e últimas mensagens da sessão
            cursor.execute("""
                SELECT m.id, m.time_created
                FROM message m
                WHERE m.session_id = ?
                ORDER BY m.time_created ASC
            """, (session_id,))
            messages = cursor.fetchall()
            conn.close()

            return {
                "session_id": session_id,
                "total_messages": len(messages),
            }
        except Exception as e:
            return {"error": str(e)}
