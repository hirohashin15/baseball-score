"""データベースの定義（SQLAlchemy）

正本は game_events（1球・1プレーごとの記録）
plate_appearances / player_game_stats は game_events から自動で作り直す「計算結果の表」
"""
from __future__ import annotations

import os
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint,
                        create_engine, event)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker


def _db_url() -> str:
    url = os.environ.get("DATABASE_URL", "sqlite:///./local.db")
    # Neon / Render が出す postgres:// 形式を、ドライバ指定付きの形式にそろえる
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


DB_URL = _db_url()
_is_sqlite = DB_URL.startswith("sqlite")
engine = create_engine(
    DB_URL,
    pool_pre_ping=True,  # 無料DBは休止から復帰するため、接続前に生存確認する
    connect_args={"check_same_thread": False} if _is_sqlite else {},
)
if _is_sqlite:
    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def now() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


def new_token() -> str:
    """推測されにくいURL用の鍵"""
    return secrets.token_urlsafe(16)


class Base(DeclarativeBase):
    pass


class Team(Base):
    __tablename__ = "teams"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    short_name: Mapped[str | None] = mapped_column(String(20), nullable=True)
    is_guest: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    players: Mapped[list["Player"]] = relationship(back_populates="team", order_by="Player.created_at")


class Player(Base):
    __tablename__ = "players"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    team_id: Mapped[str] = mapped_column(ForeignKey("teams.id"))
    name: Mapped[str] = mapped_column(String(100))
    number: Mapped[str | None] = mapped_column(String(10), nullable=True)
    throws: Mapped[str | None] = mapped_column(String(1), nullable=True)  # 投：R=右 L=左
    bats: Mapped[str | None] = mapped_column(String(1), nullable=True)    # 打：R=右 L=左 S=両
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    team: Mapped[Team] = relationship(back_populates="players")


class Game(Base):
    __tablename__ = "games"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    date: Mapped[str] = mapped_column(String(10))
    venue: Mapped[str | None] = mapped_column(String(100), nullable=True)
    away_team_id: Mapped[str] = mapped_column(ForeignKey("teams.id"))
    home_team_id: Mapped[str] = mapped_column(ForeignKey("teams.id"))
    rules: Mapped[dict] = mapped_column(JSON, default=dict)
    edit_token: Mapped[str] = mapped_column(String(40), unique=True, default=new_token)
    view_token: Mapped[str] = mapped_column(String(40), unique=True, default=new_token)
    version: Mapped[int] = mapped_column(Integer, default=0)  # 最後に積んだイベントの通し番号
    lock_client: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lock_name: Mapped[str | None] = mapped_column(String(50), nullable=True)
    lock_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    summary: Mapped[dict] = mapped_column(JSON, default=dict)  # 一覧表示用（スコア・状況）
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    away_team: Mapped[Team] = relationship(foreign_keys=[away_team_id])
    home_team: Mapped[Team] = relationship(foreign_keys=[home_team_id])


class GameEvent(Base):
    """記録の正本 書き換えず、取消・訂正も新しい行として積む"""
    __tablename__ = "game_events"
    __table_args__ = (UniqueConstraint("game_id", "seq", name="uq_game_seq"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    game_id: Mapped[str] = mapped_column(ForeignKey("games.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(20))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    author: Mapped[str | None] = mapped_column(String(50), nullable=True)
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PlateAppearance(Base):
    """打席の一覧（計算結果 game_events から作り直す）"""
    __tablename__ = "plate_appearances"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    game_id: Mapped[str] = mapped_column(ForeignKey("games.id"), index=True)
    no: Mapped[int] = mapped_column(Integer)
    inning: Mapped[int] = mapped_column(Integer)
    half: Mapped[str] = mapped_column(String(6))
    side: Mapped[str] = mapped_column(String(4))
    batting_order: Mapped[int | None] = mapped_column(Integer, nullable=True)
    batter_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    pitcher_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    result: Mapped[str] = mapped_column(String(30))
    label: Mapped[str] = mapped_column(String(60))
    code: Mapped[str] = mapped_column(String(20))
    rbi: Mapped[int] = mapped_column(Integer, default=0)
    pitches: Mapped[list] = mapped_column(JSON, default=list)
    unrecorded: Mapped[bool] = mapped_column(Boolean, default=False)
    unconfirmed: Mapped[bool] = mapped_column(Boolean, default=False)


class PlayerGameStat(Base):
    """選手ごとの試合成績（計算結果 通算成績の集計に使う）"""
    __tablename__ = "player_game_stats"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    game_id: Mapped[str] = mapped_column(ForeignKey("games.id"), index=True)
    player_id: Mapped[str] = mapped_column(String(32), index=True)
    bat: Mapped[dict] = mapped_column(JSON, default=dict)
    pit: Mapped[dict] = mapped_column(JSON, default=dict)
    fld: Mapped[dict] = mapped_column(JSON, default=dict)
    decision: Mapped[str | None] = mapped_column(String(4), nullable=True)
    text_note: Mapped[str | None] = mapped_column(Text, nullable=True)


# 後から追加した列（すでに表がある本番DBにも足す）
_ADDED_COLUMNS = {"players": {"throws": "VARCHAR(1)", "bats": "VARCHAR(1)"}}


def init_db() -> None:
    Base.metadata.create_all(engine)
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, cols in _ADDED_COLUMNS.items():
            have = {c["name"] for c in insp.get_columns(table)}
            for name, typ in cols.items():
                if name not in have:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {typ}"))
