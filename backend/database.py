import os
import uuid
from sqlalchemy import create_engine, Column, Integer, String, DateTime, ForeignKey, Enum as SAEnum, Boolean, Float
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "game.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String(32), unique=True, index=True, nullable=False)
    username = Column(String(64), unique=True, index=True, nullable=False)
    password_hash = Column(String(256), nullable=False)
    salt = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    sent_requests = relationship("Friendship", foreign_keys="Friendship.requester_id", back_populates="requester")
    recv_requests = relationship("Friendship", foreign_keys="Friendship.addressee_id", back_populates="addressee")


class Friendship(Base):
    __tablename__ = "friendships"
    id = Column(Integer, primary_key=True, index=True)
    requester_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    addressee_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String(16), default="pending")  # pending/accepted/rejected
    created_at = Column(DateTime, default=datetime.utcnow)

    requester = relationship("User", foreign_keys=[requester_id], back_populates="sent_requests")
    addressee = relationship("User", foreign_keys=[addressee_id], back_populates="recv_requests")


class GameRoom(Base):
    __tablename__ = "game_rooms"
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(16), unique=True, index=True, nullable=False)
    host_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String(16), default="waiting")  # waiting/running/finished
    track = Column(String(32), default="neon_circuit")
    created_at = Column(DateTime, default=datetime.utcnow)


class RoomMember(Base):
    __tablename__ = "room_members"
    id = Column(Integer, primary_key=True, index=True)
    room_id = Column(Integer, ForeignKey("game_rooms.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    ready = Column(Boolean, default=False)
    joined_at = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)


def new_user_id():
    return "USR-" + uuid.uuid4().hex[:8].upper()
