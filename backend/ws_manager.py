import json
from typing import Dict, Set
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # user_id -> set of websockets
        self.active: Dict[str, Set[WebSocket]] = {}
        # ws -> user_id
        self.ws_user: Dict[WebSocket, str] = {}

    async def connect(self, ws: WebSocket, user_id: str):
        await ws.accept()
        self.active.setdefault(user_id, set()).add(ws)
        self.ws_user[ws] = user_id

    def disconnect(self, ws: WebSocket):
        uid = self.ws_user.pop(ws, None)
        if uid and uid in self.active:
            self.active[uid].discard(ws)
            if not self.active[uid]:
                del self.active[uid]
        return uid

    def is_online(self, user_id: str) -> bool:
        return user_id in self.active and len(self.active[user_id]) > 0

    async def send_to_user(self, user_id: str, data: dict):
        for ws in list(self.active.get(user_id, [])):
            try:
                await ws.send_text(json.dumps(data))
            except Exception:
                pass

    async def broadcast(self, data: dict, exclude: str = None):
        for uid, conns in list(self.active.items()):
            if uid == exclude:
                continue
            for ws in list(conns):
                try:
                    await ws.send_text(json.dumps(data))
                except Exception:
                    pass

    async def broadcast_all(self, data: dict):
        for uid, conns in list(self.active.items()):
            for ws in list(conns):
                try:
                    await ws.send_text(json.dumps(data))
                except Exception:
                    pass

    def online_user_ids(self) -> list:
        return list(self.active.keys())
