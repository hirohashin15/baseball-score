"""Webアプリ本体（FastAPI）

URLの種類
  /            トップ（試合一覧）
  /teams       チーム・選手の管理
  /new         試合の作成
  /e/<編集鍵>  入力画面（この試合の入力者だけに共有）
  /g/<閲覧鍵>  閲覧画面（誰に共有してもよい 書き込みはできない）
  /p/<選手ID>  選手の通算成績
  /api/...     画面が使うデータの出入り口
"""
from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from collections import Counter
from datetime import timedelta
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import db
from .engine.core import RESULT_META, Game as EngineGame, RuleError, effective_events, replay
from .engine.views import career, game_view, player_game_stats

STATIC = Path(__file__).parent / "static"
LOCK_SECONDS = 120  # 入力中の端末が操作しなくなってから、他の端末が書けるようになるまでの秒数
ADMIN_PASSCODE = os.environ.get("ADMIN_PASSCODE", "")
ENABLE_FIXTURE = os.environ.get("ENABLE_FIXTURE", "") == "1"  # 検証試合の読み込み（本番では無効）
NORMAL_TYPES = {"lineup", "pitch", "pa_result", "runner", "sub", "end", "decision"}
FIX_TYPES = {"void", "correct", "insert"}

@asynccontextmanager
async def _lifespan(_app):
    db.init_db()  # 起動時に表が無ければ作る
    yield


app = FastAPI(title="野球スコア β", docs_url=None, redoc_url=None, lifespan=_lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def get_session():
    s = db.SessionLocal()
    try:
        yield s
    finally:
        s.close()


def err(status: int, message: str, **extra: Any) -> HTTPException:
    """画面にそのまま出せる日本語のエラー"""
    return HTTPException(status_code=status, detail={"message": message, **extra})


def require_passcode(x_passcode: str | None = Header(default=None)) -> None:
    if ADMIN_PASSCODE and x_passcode != ADMIN_PASSCODE:
        raise err(401, "管理用パスコードが違います（チーム登録・試合作成に必要です）")


@app.exception_handler(HTTPException)
async def _http_error(request: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content=detail)


@app.middleware("http")
async def _no_cache_api(request: Request, call_next):
    resp: Response = await call_next(request)
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ============================================================ 共通処理
def _event_dict(e: db.GameEvent) -> dict:
    return {"id": e.id, "seq": e.seq, "type": e.type, "payload": e.payload or {}, "meta": e.meta or {},
            "author": e.author, "created_at": e.created_at.isoformat() if e.created_at else None}


def _events(s: Session, game: db.Game) -> list[dict]:
    rows = s.scalars(select(db.GameEvent).where(db.GameEvent.game_id == game.id)
                     .order_by(db.GameEvent.seq)).all()
    return [_event_dict(e) for e in rows]


def _roster(game: db.Game) -> dict:
    r = {}
    for side, team in (("away", game.away_team), ("home", game.home_team)):
        for p in team.players:
            r[p.id] = {"name": p.name, "number": p.number, "team": side, "throws": p.throws, "bats": p.bats}
    return r


def _team_names(game: db.Game) -> dict:
    return {"away": game.away_team.name, "home": game.home_team.name}


def _team_short(t: db.Team) -> str:
    return t.short_name or t.name[:4]


def _compute(game: db.Game, events: list[dict], stop_before: str | None = None):
    return replay(events, game.rules or {}, _roster(game), stop_before=stop_before)


def _game_info(game: db.Game) -> dict:
    return {
        "id": game.id, "date": game.date, "venue": game.venue, "version": game.version,
        "away_team": {"id": game.away_team.id, "name": game.away_team.name, "short": _team_short(game.away_team)},
        "home_team": {"id": game.home_team.id, "name": game.home_team.name, "short": _team_short(game.home_team)},
        "view_token": game.view_token, "rules": game.rules,
    }


def _pdict(p: db.Player) -> dict:
    return {"id": p.id, "name": p.name, "number": p.number, "throws": p.throws, "bats": p.bats, "active": p.active}


def _roster_lists(game: db.Game) -> dict:
    return {side: [_pdict(p) for p in team.players if p.active]
            for side, team in (("away", game.away_team), ("home", game.home_team))}


def _named_after(g: EngineGame, after: dict | None) -> dict | None:
    """プレー直後の状況に選手名を付ける（1球ごとの詳細表示用）"""
    if not after:
        return after
    out = dict(after)
    out["bases"] = {str(b): (g.name(pid) if pid else None) for b, pid in (after.get("bases") or {}).items()}
    out["batter_name"] = g.name(after["batter"]) if after.get("batter") else None
    out["pitcher_name"] = g.name(after["pitcher"]) if after.get("pitcher") else None
    return out


def _event_history(events: list[dict], g: EngineGame) -> list[dict]:
    """経過画面用：有効なイベントに説明文を付け、取消・訂正の履歴も添える"""
    desc = {e["id"]: e for e in g.event_log}
    eff = effective_events(events)
    corrections = [e for e in events if e["type"] in FIX_TYPES]
    out = []
    for e in eff:
        d = desc.get(e["id"], {})
        out.append({"id": e["id"], "seq": e["seq"], "type": e["type"], "desc": d.get("desc"),
                    "inning": d.get("inning"), "half": d.get("half"), "after": _named_after(g, d.get("after")),
                    "pa_no": d.get("pa_no"), "pitch_no": d.get("pitch_no"), "payload": e.get("payload"),
                    "unconfirmed": d.get("unconfirmed") or (e.get("meta") or {}).get("unconfirmed"),
                    "note": (e.get("meta") or {}).get("note"), "corrected": bool(e.get("corrected_by")),
                    "computed": e["id"] in desc, "author": e.get("author"),
                    "summary": None if e["id"] in desc else _raw_summary(e)})
    return out, len(corrections)


def _raw_summary(e: dict) -> str:
    """計算できなかった記録の簡単な説明（矛盾で止まった後の記録用）"""
    from .engine import notation as nt
    p = e.get("payload") or {}
    t = e["type"]
    if t == "pitch":
        s = nt.PITCH_LABEL.get(p.get("result"), "投球")
        play = p.get("play") or {}
        if play.get("result"):
            s += " → " + nt.pa_label(play["result"], play.get("pos"))
        if p.get("runners"):
            s += "（走者の動きあり）"
        return s
    if t == "pa_result":
        return "結果のみ：" + nt.pa_label(p.get("result", ""), p.get("pos"))
    if t == "runner":
        return "走塁：" + "、".join(f"{nt.BASE_JA.get(m.get('from'), '')}走者 {nt.HOW_LABEL.get(m.get('how'), '')}"
                                  for m in p.get("moves") or [])
    if t == "sub":
        return "選手交代"
    if t == "end":
        return "試合終了"
    return t


def _lock_info(game: db.Game) -> dict:
    active = bool(game.lock_client and game.lock_at and
                  db.now() - _aware(game.lock_at) < timedelta(seconds=LOCK_SECONDS))
    return {"client": game.lock_client if active else None, "name": game.lock_name if active else None}


def _aware(dt):
    from datetime import timezone
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _full_view(game: db.Game, events: list[dict], g: EngineGame, halted: dict | None) -> dict:
    v = game_view(g, halted, _team_names(game))
    v["team_short"] = {"away": _team_short(game.away_team), "home": _team_short(game.home_team)}
    v["events"], v["fix_count"] = _event_history(events, g)
    v["game"] = _game_info(game)
    return v


def _save_projections(s: Session, game: db.Game, g: EngineGame) -> None:
    """計算結果の表（打席一覧・選手別成績・一覧用サマリー）を作り直す"""
    s.execute(delete(db.PlateAppearance).where(db.PlateAppearance.game_id == game.id))
    s.execute(delete(db.PlayerGameStat).where(db.PlayerGameStat.game_id == game.id))
    for pa in g.pa_log:
        s.add(db.PlateAppearance(
            game_id=game.id, no=pa["no"], inning=pa["inning"], half=pa["half"], side=pa["side"],
            batting_order=pa.get("order"), batter_id=pa.get("batter"), pitcher_id=pa.get("pitcher"),
            result=pa.get("result", ""), label=pa.get("label", "")[:60], code=pa.get("code", "")[:20],
            rbi=pa.get("rbi", 0), pitches=pa.get("pitches", []), unrecorded=bool(pa.get("unrecorded")),
            unconfirmed=bool(pa.get("unconfirmed"))))
    roster = _roster(game)
    for pid, st in player_game_stats(g).items():
        if pid not in roster:
            continue
        s.add(db.PlayerGameStat(game_id=game.id, player_id=pid, bat=dict(st["bat"]), pit=dict(st["pit"]),
                                fld=dict(st["fld"]), decision=st["decision"]))
    game.summary = {
        "away": g.score("away"), "home": g.score("home"), "status": g.status,
        "inning": g.inning, "half": g.half, "outs": g.outs,
        "linescore": g.linescore,
    }
    game.updated_at = db.now()


def _game_by(s: Session, *, edit: str | None = None, view: str | None = None, lock: bool = False) -> db.Game:
    q = select(db.Game)
    q = q.where(db.Game.edit_token == edit) if edit else q.where(db.Game.view_token == view)
    if lock and not db.DB_URL.startswith("sqlite"):
        q = q.with_for_update()
    game = s.scalars(q).first()
    if game is None:
        raise err(404, "試合が見つかりません（URLが間違っているか、削除された可能性があります）")
    return game


# ============================================================ チーム・選手
class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    short_name: str = Field(min_length=1, max_length=8)  # 略称（スコアボード用・必須）


class PlayerIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    number: str | None = None
    throws: str | None = Field(default=None, pattern="^[RL]$")   # 投：R=右 L=左（空欄＝未登録）
    bats: str | None = Field(default=None, pattern="^[RLS]$")    # 打：R=右 L=左 S=両
    active: bool = True


@app.get("/api/health")
def health(s: Session = Depends(get_session)):
    s.execute(select(1))
    return {"ok": True, "passcode_required": bool(ADMIN_PASSCODE), "fixture": ENABLE_FIXTURE}


@app.get("/api/teams")
def list_teams(s: Session = Depends(get_session)):
    teams = s.scalars(select(db.Team).where(db.Team.is_guest.is_(False)).order_by(db.Team.name)).all()
    return [{"id": t.id, "name": t.name, "short_name": t.short_name,
             "players": len([p for p in t.players if p.active])} for t in teams]


@app.post("/api/teams", dependencies=[Depends(require_passcode)])
def create_team(body: TeamIn, s: Session = Depends(get_session)):
    t = db.Team(name=body.name.strip(), short_name=body.short_name.strip())
    s.add(t)
    s.commit()
    return {"id": t.id, "name": t.name, "short_name": t.short_name}


@app.get("/api/teams/{team_id}")
def get_team(team_id: str, s: Session = Depends(get_session)):
    t = s.get(db.Team, team_id)
    if not t:
        raise err(404, "チームが見つかりません")
    games = s.scalars(select(db.Game.id).where((db.Game.away_team_id == t.id) | (db.Game.home_team_id == t.id))).all()
    return {"id": t.id, "name": t.name, "short_name": t.short_name, "games": len(games),
            "players": [_pdict(p) for p in t.players]}


@app.patch("/api/teams/{team_id}", dependencies=[Depends(require_passcode)])
def rename_team(team_id: str, body: TeamIn, s: Session = Depends(get_session)):
    t = s.get(db.Team, team_id)
    if not t:
        raise err(404, "チームが見つかりません")
    t.name = body.name.strip()
    t.short_name = body.short_name.strip()
    s.commit()
    return {"id": t.id, "name": t.name, "short_name": t.short_name}


@app.delete("/api/teams/{team_id}", dependencies=[Depends(require_passcode)])
def delete_team(team_id: str, s: Session = Depends(get_session)):
    """チームの削除（そのチームの試合が残っている場合は削除できない）"""
    t = s.get(db.Team, team_id)
    if not t:
        raise err(404, "チームが見つかりません")
    used = s.scalars(select(db.Game.id).where((db.Game.away_team_id == t.id) | (db.Game.home_team_id == t.id))).first()
    if used:
        raise err(409, "このチームの試合が残っているため削除できません 先に試合を削除してください")
    for p in list(t.players):
        s.delete(p)
    s.delete(t)
    s.commit()
    return {"ok": True}


@app.post("/api/teams/{team_id}/players")
def add_player(team_id: str, body: PlayerIn, s: Session = Depends(get_session),
               x_passcode: str | None = Header(default=None), x_edit_token: str | None = Header(default=None)):
    """選手登録 管理用パスコード、またはその チームの試合の編集鍵があれば追加できる（試合中の飛び入り対応）"""
    t = s.get(db.Team, team_id)
    if not t:
        raise err(404, "チームが見つかりません")
    allowed = not ADMIN_PASSCODE or x_passcode == ADMIN_PASSCODE
    if not allowed and x_edit_token:
        g = s.scalars(select(db.Game).where(db.Game.edit_token == x_edit_token)).first()
        allowed = bool(g and team_id in (g.away_team_id, g.home_team_id))
    if not allowed:
        raise err(401, "選手を追加する権限がありません")
    p = db.Player(team_id=team_id, name=body.name.strip(), number=(body.number or "").strip() or None,
                  throws=body.throws or None, bats=body.bats or None)
    s.add(p)
    s.commit()
    return _pdict(p)


@app.patch("/api/players/{player_id}")
def edit_player(player_id: str, body: PlayerIn, s: Session = Depends(get_session),
                x_passcode: str | None = Header(default=None), x_edit_token: str | None = Header(default=None)):
    """選手の編集 管理用パスコード、またはその選手のチームの試合の編集鍵があれば編集できる（試合入力中の修正用）"""
    p = s.get(db.Player, player_id)
    if not p:
        raise err(404, "選手が見つかりません")
    allowed = not ADMIN_PASSCODE or x_passcode == ADMIN_PASSCODE
    if not allowed and x_edit_token:
        g = s.scalars(select(db.Game).where(db.Game.edit_token == x_edit_token)).first()
        allowed = bool(g and p.team_id in (g.away_team_id, g.home_team_id))
    if not allowed:
        raise err(401, "選手を編集する権限がありません")
    p.name, p.number, p.active = body.name.strip(), (body.number or "").strip() or None, body.active
    hand_changed = (p.throws, p.bats) != (body.throws or None, body.bats or None)
    p.throws, p.bats = body.throws or None, body.bats or None
    s.flush()
    if hand_changed:
        # 投打を後から登録・変更したら、その選手のチームの試合の成績（左右別）を作り直す
        games = s.scalars(select(db.Game).where((db.Game.away_team_id == p.team_id) | (db.Game.home_team_id == p.team_id))).all()
        for game in games:
            g, _ = _compute(game, _events(s, game))
            _save_projections(s, game, g)
    s.commit()
    return _pdict(p)


@app.get("/api/players/{player_id}/stats")
def player_stats(player_id: str, s: Session = Depends(get_session)):
    p = s.get(db.Player, player_id)
    if not p:
        raise err(404, "選手が見つかりません")
    rows = s.execute(select(db.PlayerGameStat, db.Game).join(db.Game, db.Game.id == db.PlayerGameStat.game_id)
                     .where(db.PlayerGameStat.player_id == player_id).order_by(db.Game.date.desc())).all()
    games = []
    agg_rows = []
    for st, g in rows:
        agg_rows.append({"bat": Counter(st.bat), "pit": Counter(st.pit), "fld": Counter(st.fld),
                         "decision": st.decision})
        games.append({"date": g.date, "view_token": g.view_token, "away": g.away_team.name,
                      "home": g.home_team.name, "summary": g.summary, "bat": st.bat, "pit": st.pit,
                      "decision": st.decision})
    return {"player": {"id": p.id, "name": p.name, "number": p.number, "team": p.team.name},
            "career": career(agg_rows), "games": games}


# ============================================================ 試合
class GameIn(BaseModel):
    date: str
    away_team_id: str
    home_team_id: str
    venue: str | None = None
    innings: int = Field(default=9, ge=1, le=20)
    extra_hitters: bool = False
    reentry: bool = True
    dh: bool = True
    temp_runner: bool = True


@app.post("/api/games", dependencies=[Depends(require_passcode)])
def create_game(body: GameIn, s: Session = Depends(get_session)):
    if body.away_team_id == body.home_team_id:
        raise err(422, "先攻と後攻に同じチームは選べません")
    for tid in (body.away_team_id, body.home_team_id):
        if not s.get(db.Team, tid):
            raise err(404, "チームが見つかりません")
    rules = {"innings": body.innings, "extra_hitters": body.extra_hitters, "reentry": body.reentry,
             "dh": body.dh, "temp_runner": body.temp_runner}
    g = db.Game(date=body.date, venue=body.venue, away_team_id=body.away_team_id,
                home_team_id=body.home_team_id, rules=rules, summary={"status": "pregame", "away": 0, "home": 0})
    s.add(g)
    s.commit()
    return {"edit_token": g.edit_token, "view_token": g.view_token}


@app.get("/api/games")
def list_games(s: Session = Depends(get_session)):
    games = s.scalars(select(db.Game).order_by(db.Game.date.desc(), db.Game.created_at.desc()).limit(50)).all()
    return [{"date": g.date, "away": g.away_team.name, "home": g.home_team.name, "summary": g.summary,
             "view_token": g.view_token, "venue": g.venue} for g in games]


@app.get("/api/view/{token}")
def view_game(token: str, since: int | None = None, s: Session = Depends(get_session)):
    game = _game_by(s, view=token)
    if since is not None and since == game.version:
        return {"unchanged": True, "version": game.version}
    events = _events(s, game)
    g, halted = _compute(game, events)
    v = _full_view(game, events, g, halted)
    v["mode"] = "view"
    return v


@app.get("/api/edit/{token}")
def edit_game(token: str, s: Session = Depends(get_session)):
    game = _game_by(s, edit=token)
    events = _events(s, game)
    g, halted = _compute(game, events)
    v = _full_view(game, events, g, halted)
    v.update({"mode": "edit", "edit_token": token, "roster": _roster_lists(game), "lock": _lock_info(game)})
    return v


@app.delete("/api/edit/{token}", dependencies=[Depends(require_passcode)])
def delete_game(token: str, s: Session = Depends(get_session)):
    """試合の削除（記録もすべて消える 元に戻せない） 検証用の仮チームも一緒に消す"""
    game = _game_by(s, edit=token)
    teams = [game.away_team, game.home_team]
    for model in (db.GameEvent, db.PlateAppearance, db.PlayerGameStat):
        s.execute(delete(model).where(model.game_id == game.id))
    s.delete(game)
    s.flush()
    for t in teams:
        if t.is_guest:
            left = s.scalars(select(db.Game.id).where((db.Game.away_team_id == t.id) | (db.Game.home_team_id == t.id))).first()
            if not left:
                for p in list(t.players):
                    s.delete(p)
                s.delete(t)
    s.commit()
    return {"ok": True}


class SwapIn(BaseModel):
    client_id: str
    author: str | None = None


@app.post("/api/edit/{token}/swap")
def swap_sides(token: str, body: SwapIn, s: Session = Depends(get_session)):
    """先攻・後攻の入れ替え（試合開始前だけ） 登録済みのスタメンも一緒に入れ替える"""
    game = _game_by(s, edit=token, lock=True)
    _check_lock(game, body.client_id)
    events = _events(s, game)
    eff = effective_events(events)
    if any(e["type"] != "lineup" for e in eff):
        raise err(409, "試合が始まった後は先攻・後攻を入れ替えられません（記録を取り消してから行ってください）")
    game.away_team_id, game.home_team_id = game.home_team_id, game.away_team_id
    seq = game.version
    for e in eff:
        seq += 1
        payload = dict(e["payload"])
        payload["side"] = "home" if payload.get("side") == "away" else "away"
        s.add(db.GameEvent(id=db.new_id(), game_id=game.id, seq=seq, type="correct",
                           payload={"target": e["id"], "event": {"type": "lineup", "payload": payload}},
                           meta={"note": "先攻・後攻の入れ替え"}, author=(body.author or "")[:50] or None,
                           client_id=body.client_id))
    game.version = seq
    s.flush()
    s.refresh(game)
    events = _events(s, game)
    g, halted = _compute(game, events)
    _save_projections(s, game, g)
    s.commit()
    s.refresh(game)
    v = _full_view(game, events, g, halted)
    v.update({"mode": "edit", "edit_token": token, "roster": _roster_lists(game), "lock": _lock_info(game)})
    return v


@app.get("/api/edit/{token}/before/{event_id}")
def state_before(token: str, event_id: str, s: Session = Depends(get_session)):
    """訂正・追加の画面用：指定したプレーの直前の状態"""
    game = _game_by(s, edit=token)
    events = _events(s, game)
    g, halted = _compute(game, events, stop_before=event_id)
    v = game_view(g, None, _team_names(game))
    v.update({"mode": "edit", "roster": _roster_lists(game), "game": _game_info(game)})
    return v


class SuggestIn(BaseModel):
    result: str
    pos: int | None = None
    before: str | None = None


@app.post("/api/edit/{token}/suggest")
def suggest(token: str, body: SuggestIn, s: Session = Depends(get_session)):
    """打席結果を選んだときの、走者の既定の動き"""
    game = _game_by(s, edit=token)
    g, _ = _compute(game, _events(s, game), stop_before=body.before)
    if body.result not in RESULT_META:
        raise err(422, "打席結果が読み取れません")
    try:
        moves = g.suggest_moves(body.result, body.pos)
    except RuleError as e:
        raise err(422, str(e))
    return {"moves": moves, "outs": g.outs, "forced": sorted(g.forced_bases())}


class EventIn(BaseModel):
    type: str
    payload: dict = Field(default_factory=dict)
    meta: dict = Field(default_factory=dict)
    expected_version: int | None = None
    client_id: str = Field(min_length=4, max_length=64)
    author: str | None = None


def _check_lock(game: db.Game, client_id: str) -> None:
    info = _lock_info(game)
    if info["client"] and info["client"] != client_id:
        raise err(423, f"{info['name'] or '別の端末'}が入力中です 引き継ぐ場合は「入力を引き継ぐ」を押してください",
                  lock=info)


def _append(s: Session, game: db.Game, body: EventIn) -> dict:
    """イベント1件を検証して積む（ルール上ありえない入力は保存しない）"""
    if body.type not in NORMAL_TYPES | FIX_TYPES:
        raise err(422, f"未対応の記録の種類です：{body.type}")
    _check_lock(game, body.client_id)
    if body.expected_version is not None and body.expected_version != game.version:
        raise err(409, "他の端末で記録が更新されています 画面を最新にしてから入力し直してください",
                  version=game.version)
    events = _events(s, game)
    ids = {e["id"] for e in events}
    if body.type in FIX_TYPES:
        key = "before" if body.type == "insert" else "target"
        if body.payload.get(key) not in ids:
            raise err(422, "訂正する記録が見つかりません")
        if body.type in ("correct", "insert"):
            inner = (body.payload.get("event") or {}).get("type")
            if inner not in NORMAL_TYPES:
                raise err(422, "訂正後の記録の種類が読み取れません")
    else:
        _, halted_before = _compute(game, events)
        if halted_before:
            raise err(409, "矛盾している記録があります 経過画面で「要確認」のプレーを先に直してください",
                      halted=halted_before)
    cand = {"id": db.new_id(), "seq": game.version + 1, "type": body.type, "payload": body.payload,
            "meta": body.meta, "author": body.author}
    g, halted = _compute(game, events + [cand])
    if halted:
        bad = halted["event_id"]
        own = bad == cand["id"] or (body.type == "correct" and bad == body.payload.get("target"))
        if own:
            raise err(422, halted["message"])
    s.add(db.GameEvent(id=cand["id"], game_id=game.id, seq=cand["seq"], type=body.type,
                       payload=body.payload, meta=body.meta, author=(body.author or "")[:50] or None,
                       client_id=body.client_id))
    game.version = cand["seq"]
    game.lock_client, game.lock_name, game.lock_at = body.client_id, (body.author or "")[:50] or None, db.now()
    _save_projections(s, game, g)
    s.commit()
    v = _full_view(game, events + [cand], g, halted)
    v.update({"mode": "edit", "roster": _roster_lists(game), "lock": _lock_info(game)})
    return v


@app.post("/api/edit/{token}/events")
def post_event(token: str, body: EventIn, s: Session = Depends(get_session)):
    game = _game_by(s, edit=token, lock=True)
    return _append(s, game, body)


class UndoIn(BaseModel):
    client_id: str
    author: str | None = None
    expected_version: int | None = None


@app.post("/api/edit/{token}/undo")
def undo(token: str, body: UndoIn, s: Session = Depends(get_session)):
    """直前の1プレーを取り消す（記録は消さず「取消」を積む）"""
    game = _game_by(s, edit=token, lock=True)
    eff = effective_events(_events(s, game))
    if not eff:
        raise err(422, "取り消せる記録がありません")
    last = eff[-1]
    return _append(s, game, EventIn(type="void", payload={"target": last["id"]}, client_id=body.client_id,
                                    author=body.author, expected_version=body.expected_version))


class LockIn(BaseModel):
    client_id: str
    name: str | None = None
    takeover: bool = False


@app.post("/api/edit/{token}/lock")
def take_lock(token: str, body: LockIn, s: Session = Depends(get_session)):
    """入力権の確認・延長・引き継ぎ"""
    game = _game_by(s, edit=token, lock=True)
    info = _lock_info(game)
    if info["client"] and info["client"] != body.client_id and not body.takeover:
        return {"ok": False, "lock": info}
    game.lock_client, game.lock_name, game.lock_at = body.client_id, (body.name or "")[:50] or None, db.now()
    s.commit()
    return {"ok": True, "lock": _lock_info(game), "version": game.version}


@app.get("/api/edit/{token}/export")
def export_game(token: str, s: Session = Depends(get_session)):
    """バックアップ用：全記録と計算結果をJSONで書き出す（iCloud Driveなどに保存できる）"""
    game = _game_by(s, edit=token)
    events = _events(s, game)
    g, halted = _compute(game, events)
    data = {"format": "baseball-score-backup/1", "game": _game_info(game), "roster": _roster(game),
            "events": events, "result": game_view(g, halted, _team_names(game))}
    fname = f"score_{game.date}_{game.away_team.name}_vs_{game.home_team.name}.json"
    return Response(content=json.dumps(data, ensure_ascii=False, indent=1, default=str),
                    media_type="application/json",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(fname)}"})


def _quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s)


# ============================================================ 検証試合の読み込み
@app.post("/api/admin/import-fixture", dependencies=[Depends(require_passcode)])
def import_fixture(s: Session = Depends(get_session)):
    """2026-10-18 Nexus Tokyo vs EDOSEN の検証試合を、新しい試合として登録する（ENABLE_FIXTURE=1 のときだけ）"""
    if not ENABLE_FIXTURE:
        raise err(404, "検証試合の読み込みは無効です")
    from fixtures import nexus_edo_20261018 as fx
    away = db.Team(name="Nexus Tokyo（検証）", short_name="Nexus", is_guest=True)
    home = db.Team(name="EDOSEN（検証）", short_name="EDOSEN", is_guest=True)
    s.add_all([away, home])
    s.flush()
    idmap = {}
    for key, info in fx.roster().items():
        team = away if info["team"] == "away" else home
        p = db.Player(team_id=team.id, name=info["name"])
        s.add(p)
        s.flush()
        idmap[key] = p.id
    game = db.Game(date="2026-10-18", away_team_id=away.id, home_team_id=home.id, rules=fx.RULES,
                   venue="検証データ")
    s.add(game)
    s.flush()

    def remap(obj):
        if isinstance(obj, dict):
            return {k: remap(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [remap(v) for v in obj]
        if isinstance(obj, str) and obj in idmap:
            return idmap[obj]
        return obj

    evs, _ = fx.events()
    for e in evs:
        s.add(db.GameEvent(id=db.new_id(), game_id=game.id, seq=e["seq"], type=e["type"],
                           payload=remap(e["payload"]), meta=e.get("meta") or {}, author="検証データ"))
    game.version = len(evs)
    s.flush()
    s.refresh(game)
    g, _ = _compute(game, _events(s, game))
    _save_projections(s, game, g)
    s.commit()
    return {"edit_token": game.edit_token, "view_token": game.view_token}


# ============================================================ 画面（1つのHTMLを全URLで返す）
def _index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/")
def page_home():
    return _index()


@app.get("/{kind}/{rest:path}")
def page_any(kind: str, rest: str):
    if kind in ("e", "g", "p", "s", "teams", "new", "t"):
        return _index()
    raise HTTPException(status_code=404, detail="ページが見つかりません")


@app.get("/teams")
def page_teams():
    return _index()


@app.get("/new")
def page_new():
    return _index()
