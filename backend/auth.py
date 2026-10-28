import hashlib
import secrets
from datetime import datetime, timedelta
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

SECRET_KEY = "change-me-in-production-please-very-secret"
serializer = URLSafeTimedSerializer(SECRET_KEY)

TOKEN_MAX_AGE = 60 * 60 * 24 * 7  # 7 days


def hash_password(password: str, salt: str = None):
    if salt is None:
        salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return h.hex(), salt


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    h, _ = hash_password(password, salt)
    return secrets.compare_digest(h, password_hash)


def create_token(user_id: str) -> str:
    return serializer.dumps({"uid": user_id})


def verify_token(token: str):
    try:
        data = serializer.loads(token, max_age=TOKEN_MAX_AGE)
        return data.get("uid")
    except (BadSignature, SignatureExpired):
        return None
