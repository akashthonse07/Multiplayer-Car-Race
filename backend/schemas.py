from pydantic import BaseModel
from typing import Optional, List


class RegisterIn(BaseModel):
    username: str
    password: str


class LoginIn(BaseModel):
    username: str
    password: str


class TokenOut(BaseModel):
    token: str
    user_id: str
    username: str


class UserOut(BaseModel):
    user_id: str
    username: str
    online: bool = False


class FriendRequestIn(BaseModel):
    user_id: str


class FriendOut(BaseModel):
    user_id: str
    username: str
    online: bool = False
    status: str


class RoomCreateIn(BaseModel):
    track: Optional[str] = "neon_circuit"


class RoomOut(BaseModel):
    code: str
    host_user_id: str
    status: str
    track: str
    members: List[dict]
