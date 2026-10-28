import os
import uuid
import json
import asyncio
from datetime import datetime

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from database import SessionLocal, init_db, User, Friendship, GameRoom, RoomMember, new_user_id
from auth import hash_password, verify_password, create_token, verify_token
from schemas import (RegisterIn, LoginIn, TokenOut, UserOut, FriendRequestIn, FriendOut,
                    RoomCreateIn, RoomOut)
from ws_manager import ConnectionManager

app = FastAPI(title="Cinematic Racer")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

manager = ConnectionManager()

rooms: dict = {}
user_room: dict = {}


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(token: str, db: Session) -> User:
    uid = verify_token(token)
    if not uid:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.user_id == uid).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def user_to_dict(u: User):
    return {"user_id": u.user_id, "username": u.username}


@app.on_event("startup")
def startup():
    init_db()


# ---------- Auth ----------
@app.post("/api/register", response_model=TokenOut)
def register(data: RegisterIn, db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == data.username).first():
        raise HTTPException(400, "Username already taken")
    if len(data.password) < 4:
        raise HTTPException(400, "Password too short")
    h, salt = hash_password(data.password)
    uid = new_user_id()
    user = User(user_id=uid, username=data.username, password_hash=h, salt=salt)
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenOut(token=create_token(uid), user_id=uid, username=user.username)


@app.post("/api/login", response_model=TokenOut)
def login(data: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == data.username).first()
    if not user or not verify_password(data.password, user.password_hash, user.salt):
        raise HTTPException(401, "Invalid credentials")
    return TokenOut(token=create_token(user.user_id), user_id=user.user_id, username=user.username)
# ---------- Users ----------
@app.get("/api/me")
def me(token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    return user_to_dict(u)


@app.get("/api/users/search")
def search_users(q: str = Query(...), token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    q = q.strip()
    results = []
    if q:
        users = db.query(User).filter(
            (User.user_id.ilike(f"%{q}%")) | (User.username.ilike(f"%{q}%"))
        ).limit(20).all()
        for x in users:
            if x.id == u.id:
                continue
            results.append({"user_id": x.user_id, "username": x.username,
                           "online": manager.is_online(x.user_id)})
    return results


@app.get("/api/users/online")
def online_users(token: str = Query(...), db: Session = Depends(get_db)):
    get_current_user(token, db)
    return manager.online_user_ids()


# ---------- Friends ----------
@app.post("/api/friends/request")
async def send_friend_request(data: FriendRequestIn, token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    target = db.query(User).filter(User.user_id == data.user_id).first()
    if not target:
        raise HTTPException(404, "User not found")
    if target.id == u.id:
        raise HTTPException(400, "Cannot add yourself")
    existing = db.query(Friendship).filter(
        ((Friendship.requester_id == u.id) & (Friendship.addressee_id == target.id)) |
        ((Friendship.requester_id == target.id) & (Friendship.addressee_id == u.id))
    ).first()
    if existing:
        if existing.status == "accepted":
            raise HTTPException(400, "Already friends")
        if existing.status == "pending":
            raise HTTPException(400, "Request already pending")
        existing.requester_id = u.id
        existing.addressee_id = target.id
        existing.status = "pending"
        db.commit()
    else:
        fr = Friendship(requester_id=u.id, addressee_id=target.id, status="pending")
        db.add(fr)
        db.commit()
    await manager.send_to_user(target.user_id, {
        "type": "friend_request",
        "from": {"user_id": u.user_id, "username": u.username}
    })
    return {"ok": True}


@app.post("/api/friends/accept")
async def accept_friend(data: FriendRequestIn, token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    requester = db.query(User).filter(User.user_id == data.user_id).first()
    if not requester:
        raise HTTPException(404, "User not found")
    fr = db.query(Friendship).filter(
        Friendship.requester_id == requester.id,
        Friendship.addressee_id == u.id,
        Friendship.status == "pending"
    ).first()
    if not fr:
        raise HTTPException(404, "No pending request")
    fr.status = "accepted"
    db.commit()
    await manager.send_to_user(requester.user_id, {
        "type": "friend_accepted",
        "user": {"user_id": u.user_id, "username": u.username}
    })
    return {"ok": True}


@app.post("/api/friends/reject")
def reject_friend(data: FriendRequestIn, token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    requester = db.query(User).filter(User.user_id == data.user_id).first()
    if not requester:
        raise HTTPException(404, "User not found")
    fr = db.query(Friendship).filter(
        Friendship.requester_id == requester.id,
        Friendship.addressee_id == u.id,
        Friendship.status == "pending"
    ).first()
    if fr:
        fr.status = "rejected"
        db.commit()
    return {"ok": True}


@app.get("/api/friends")
def list_friends(token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    friendships = db.query(Friendship).filter(
        ((Friendship.requester_id == u.id) | (Friendship.addressee_id == u.id)),
        Friendship.status == "accepted"
    ).all()
    out = []
    for f in friendships:
        other = f.addressee if f.requester_id == u.id else f.requester
        out.append({
            "user_id": other.user_id,
            "username": other.username,
            "online": manager.is_online(other.user_id),
            "status": "accepted"
        })
    return out


@app.get("/api/friends/requests")
def list_requests(token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    pending = db.query(Friendship).filter(
        Friendship.addressee_id == u.id,
        Friendship.status == "pending"
    ).all()
    out = []
    for f in pending:
        out.append({"user_id": f.requester.user_id, "username": f.requester.username})
    return out

# ---------- Rooms ----------
def room_dict(code):
    r = rooms[code]
    members = []
    for uid in r["members"]:
        members.append({"user_id": uid, "ready": r["ready"].get(uid, False),
                        "online": manager.is_online(uid)})
    return {
        "code": code,
        "host_user_id": r["host"],
        "status": r["status"],
        "track": r["track"],
        "members": members
    }


@app.post("/api/rooms")
def create_room(data: RoomCreateIn, token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    if u.user_id in user_room:
        old = user_room.pop(u.user_id)
        if old in rooms and u.user_id in rooms[old]["members"]:
            rooms[old]["members"].discard(u.user_id)
            rooms[old]["ready"].pop(u.user_id, None)
    code = uuid.uuid4().hex[:6].upper()
    rooms[code] = {"code": code, "host": u.user_id, "track": data.track or "neon_circuit",
                   "status": "waiting", "members": {u.user_id}, "ready": {u.user_id: False}}
    user_room[u.user_id] = code
    gr = GameRoom(code=code, host_id=u.id, track=rooms[code]["track"])
    db.add(gr)
    db.commit()
    db.refresh(gr)
    rm = RoomMember(room_id=gr.id, user_id=u.id, ready=False)
    db.add(rm)
    db.commit()
    return room_dict(code)


@app.post("/api/rooms/{code}/join")
async def join_room(code: str, token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    code = code.upper()
    if code not in rooms:
        raise HTTPException(404, "Room not found")
    r = rooms[code]
    if r["status"] != "waiting":
        raise HTTPException(400, "Race already started")
    if len(r["members"]) >= 8:
        raise HTTPException(400, "Room full")
    if u.user_id in user_room and user_room[u.user_id] != code:
        old = user_room.pop(u.user_id)
        if old in rooms and u.user_id in rooms[old]["members"]:
            rooms[old]["members"].discard(u.user_id)
            rooms[old]["ready"].pop(u.user_id, None)
    r["members"].add(u.user_id)
    r["ready"].setdefault(u.user_id, False)
    user_room[u.user_id] = code
    gr = db.query(GameRoom).filter(GameRoom.code == code).first()
    if gr:
        if not db.query(RoomMember).filter(RoomMember.room_id == gr.id, RoomMember.user_id == u.id).first():
            db.add(RoomMember(room_id=gr.id, user_id=u.id, ready=False))
            db.commit()
    await manager.broadcast_all({"type": "room_update", "room": room_dict(code)})
    return room_dict(code)


@app.post("/api/rooms/{code}/leave")
async def leave_room(code: str, token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    code = code.upper()
    if code in rooms and u.user_id in rooms[code]["members"]:
        rooms[code]["members"].discard(u.user_id)
        rooms[code]["ready"].pop(u.user_id, None)
        user_room.pop(u.user_id, None)
        if rooms[code]["host"] == u.user_id:
            if rooms[code]["members"]:
                rooms[code]["host"] = sorted(rooms[code]["members"])[0]
            else:
                del rooms[code]
                return {"ok": True}
        await manager.broadcast_all({"type": "room_update", "room": room_dict(code)})
    return {"ok": True}


@app.post("/api/rooms/{code}/ready")
async def set_ready(code: str, ready: bool = Query(...), token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    code = code.upper()
    if code not in rooms or u.user_id not in rooms[code]["members"]:
        raise HTTPException(404, "Room not found")
    rooms[code]["ready"][u.user_id] = ready
    gr = db.query(GameRoom).filter(GameRoom.code == code).first()
    if gr:
        rm = db.query(RoomMember).filter(RoomMember.room_id == gr.id, RoomMember.user_id == u.id).first()
        if rm:
            rm.ready = ready
            db.commit()
    await manager.broadcast_all({"type": "room_update", "room": room_dict(code)})
    return room_dict(code)


@app.post("/api/rooms/{code}/start")
async def start_race(code: str, token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    code = code.upper()
    if code not in rooms:
        raise HTTPException(404, "Room not found")
    r = rooms[code]
    if r["host"] != u.user_id:
        raise HTTPException(403, "Only host can start")
    r["status"] = "running"
    gr = db.query(GameRoom).filter(GameRoom.code == code).first()
    if gr:
        gr.status = "running"
        db.commit()
    await manager.broadcast_all({"type": "race_start", "room": room_dict(code), "countdown": 3})
    return {"ok": True}


@app.get("/api/rooms/{code}")
def get_room(code: str, token: str = Query(...), db: Session = Depends(get_db)):
    get_current_user(token, db)
    code = code.upper()
    if code not in rooms:
        raise HTTPException(404, "Room not found")
    return room_dict(code)


@app.post("/api/rooms/{code}/finish")
async def finish_race(code: str, time: float = Query(...), token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    code = code.upper()
    if code not in rooms:
        raise HTTPException(404, "Room not found")
    await manager.broadcast_all({"type": "race_finish", "user_id": u.user_id, "username": u.username, "time": time})
    return {"ok": True}


@app.post("/api/invite")
async def invite_friend(room_code: str = Query(...), friend_user_id: str = Query(...),
                      token: str = Query(...), db: Session = Depends(get_db)):
    u = get_current_user(token, db)
    code = room_code.upper()
    if code not in rooms or u.user_id not in rooms[code]["members"]:
        raise HTTPException(400, "Not in room")
    await manager.send_to_user(friend_user_id, {
        "type": "invite",
        "from": {"user_id": u.user_id, "username": u.username},
        "room_code": code
    })
    return {"ok": True}

# ---------- WebSocket ----------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(...)):
    uid = verify_token(token)
    if not uid:
        await ws.close(code=4001)
        return
    db = SessionLocal()
    user = db.query(User).filter(User.user_id == uid).first()
    db.close()
    if not user:
        await ws.close(code=4001)
        return

    await manager.connect(ws, uid)
    await manager.broadcast_all({"type": "presence", "online": manager.online_user_ids()})
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
            elif mtype == "pos":
                code = user_room.get(uid)
                if code and code in rooms:
                    r = rooms[code]
                    if r["status"] == "running":
                        out = {"type": "pos", "user_id": uid, "username": user.username,
                               "x": msg.get("x"), "y": msg.get("y"), "z": msg.get("z"),
                               "rx": msg.get("rx"), "ry": msg.get("ry"), "rz": msg.get("rz"),
                               "speed": msg.get("speed"), "lap": msg.get("lap")}
                        for other in r["members"]:
                            if other != uid:
                                await manager.send_to_user(other, out)
            elif mtype == "chat":
                code = user_room.get(uid)
                text = str(msg.get("text", ""))[:200]
                if code and code in rooms:
                    for other in rooms[code]["members"]:
                        await manager.send_to_user(other, {"type": "chat", "user_id": uid,
                                                          "username": user.username, "text": text})
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(ws)
        await manager.broadcast_all({"type": "presence", "online": manager.online_user_ids()})


# ---------- Static frontend ----------
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"msg": "frontend not found"}

