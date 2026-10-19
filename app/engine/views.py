"""計算結果を画面向けの形（JSON）に整える

・試合の現在の状況（スコアボード・走者・打者・投手）
・個人成績（打撃・投手・守備）とスコア表
・複数試合の通算成績
"""
from __future__ import annotations

from collections import Counter
from typing import Any

from . import notation as nt
from .core import Game, RESULT_META

BAT_KEYS = ["PA", "AB", "R", "H", "2B", "3B", "HR", "TB", "RBI", "BB", "IBB", "HBP", "SO",
            "SH", "SF", "SB", "CS", "GIDP", "ROE"]
PIT_KEYS = ["OUTS", "BF", "pitches", "H", "HR", "BB", "IBB", "HBP", "SO", "WP", "BK", "R", "ER"]
FLD_KEYS = ["PO", "A", "E", "PB"]


def _rate(n: float, d: float, digits: int = 3) -> str | None:
    if not d:
        return None
    v = n / d
    s = f"{v:.{digits}f}"
    return s[1:] if s.startswith("0.") and digits == 3 else s


def batting_rates(c: Counter) -> dict:
    ab, h = c["AB"], c["H"]
    obp_d = c["AB"] + c["BB"] + c["HBP"] + c["SF"]
    return {
        "AVG": _rate(h, ab),
        "OBP": _rate(h + c["BB"] + c["HBP"], obp_d),
        "SLG": _rate(c["TB"], ab),
    }


def ip_text(outs: int) -> str:
    """投球回の表記（アウト数 → 5回1/3 なら "5.1"）"""
    return f"{outs // 3}.{outs % 3}" if outs % 3 else f"{outs // 3}"


def pitching_rates(c: Counter, innings_per_game: int = 9) -> dict:
    outs = c["OUTS"]
    return {
        "IP": ip_text(outs),
        "ERA": f"{c['ER'] * innings_per_game * 3 / outs:.2f}" if outs else None,
        "WHIP": f"{(c['BB'] + c['H']) * 3 / outs:.2f}" if outs else None,
    }


def _player(g: Game, pid: str | None) -> dict | None:
    if not pid:
        return None
    p = g.roster.get(pid, {})
    return {"id": pid, "name": p.get("name", pid), "number": p.get("number")}


def _fielder_name(g: Game, key: str) -> str:
    if ":pos" in key:
        side, pos = key.split(":pos")
        team = "先攻" if side == "away" else "後攻"
        return f"{nt.POS_NAME.get(int(pos), '野手')}（{team}・選手未登録）"
    return g.name(key)


def game_view(g: Game, halted: dict | None, team_names: dict | None = None) -> dict:
    """1試合の状況と成績をまとめる"""
    team_names = team_names or {"away": "先攻", "home": "後攻"}
    batter_id, order = g.current_batter() if g.status != "final" else (None, None)
    bteam = g.teams[g.bat_side]
    dteam = g.teams[g.def_side]
    ondeck = None
    if bteam.slots and g.status != "final":
        ondeck = bteam.slots[(bteam.batter_idx + 1) % len(bteam.slots)]

    bases = {}
    for b, r in g.bases.items():
        if r is None:
            bases[str(b)] = None
            continue
        bases[str(b)] = {
            **(_player(g, r.player_id) or {}),
            "order": g.order_of(g.bat_side, r.player_id),
            "temp": _player(g, r.temp_id),
            "pitcher": r.pitcher_id,
        }

    rhe = {}
    for side in ("away", "home"):
        rhe[side] = {"R": g.score(side), "H": g.team_stats[side]["H"],
                     "E": g.team_stats[side]["E"], "LOB": g.team_stats[side]["LOB"]}

    cur_pitcher = dteam.pitcher
    pitch_count = g.pit[cur_pitcher]["pitches"] if cur_pitcher else 0

    view: dict[str, Any] = {
        "status": g.status,
        "final_reason": g.final_reason,
        "rules": g.rules,
        "inning": g.inning,
        "half": g.half,
        "outs": g.outs,
        "balls": g.balls,
        "strikes": g.strikes,
        "bases": bases,
        "batting_side": g.bat_side,
        "batter": {**(_player(g, batter_id) or {}), "order": order} if batter_id else None,
        "ondeck": _player(g, ondeck),
        "pitcher": {**(_player(g, cur_pitcher) or {}), "pitches": pitch_count} if cur_pitcher else None,
        "pa_pitches": list(g.pa["pitches"]) if g.pa else [],
        "linescore": g.linescore,
        "rhe": rhe,
        "team_names": team_names,
        "lineups": {s: _lineup_view(g, s) for s in ("away", "home")},
        "halted": halted,
        "events": g.event_log,
        "pa_log": [_pa_view(g, pa) for pa in g.pa_log],
        "box": box_score(g),
        "scorebook": scorebook(g),
        "decisions": {k: (_player(g, v) if k in ("win", "loss", "save") else v)
                      for k, v in (g.decisions or {}).items()},
        "forced": sorted(g.forced_bases()),
    }
    return view


def other_side(side: str) -> str:
    return "home" if side == "away" else "away"


def _lineup_view(g: Game, side: str) -> dict:
    t = g.teams[side]
    pos_of = {pid: n for n, pid in t.positions.items()}
    return {
        "set": t.lineup_set,
        "slots": [
            {"order": i + 1, **(_player(g, pid) or {}),
             "position": next((k for k, v in nt.POS_CODE.items() if v == pos_of.get(pid)), None)}
            for i, pid in enumerate(t.slots)
        ],
        "pitcher": _player(g, t.pitcher),
        "starting": _starting(g, t),
        "batter_idx": t.batter_idx,
        "used": sorted(t.used),
        "removed": sorted(t.removed),
    }


def _starting(g: Game, t) -> list[dict]:
    """先発メンバー（訂正画面でスタメンを入れ直すときの初期値）"""
    first: dict[int, str] = {}
    for order, pid in t.slot_history:
        first.setdefault(order, pid)
    return [{"order": o, **(_player(g, pid) or {})} for o, pid in sorted(first.items())]


def _pa_view(g: Game, pa: dict) -> dict:
    return {
        "no": pa["no"], "side": pa["side"], "inning": pa["inning"], "half": pa["half"],
        "order": pa.get("order"), "batter": _player(g, pa.get("batter")),
        "pitcher": _player(g, pa.get("pitcher")), "result": pa.get("result"),
        "label": pa.get("label"), "code": pa.get("code"), "rbi": pa.get("rbi", 0),
        "runs": pa.get("runs", 0), "outs_after": pa.get("outs_after"),
        "pitches": pa.get("pitches", []), "unrecorded": pa.get("unrecorded"),
        "unconfirmed": pa.get("unconfirmed"), "event_ids": pa.get("event_ids", []),
    }


def box_score(g: Game) -> dict:
    """打撃・投手・守備の個人成績表"""
    out: dict[str, Any] = {}
    for side in ("away", "home"):
        t = g.teams[side]
        rows = []
        seen = set()
        for order, pid in sorted(t.slot_history, key=lambda x: x[0]):
            if pid in seen:
                continue
            seen.add(pid)
            c = g.bat.get(pid, Counter())
            rows.append({"order": order, **(_player(g, pid) or {}),
                         **{k: c[k] for k in BAT_KEYS}, **batting_rates(c)})
        # 打順外で打撃記録がある選手（念のため）
        for pid, c in g.bat.items():
            if pid not in seen and g.roster.get(pid, {}).get("team") == side and c["PA"]:
                rows.append({"order": None, **(_player(g, pid) or {}), **{k: c[k] for k in BAT_KEYS},
                             **batting_rates(c)})
        tot = Counter()
        for r in rows:
            for k in BAT_KEYS:
                tot[k] += r[k]
        pitchers = []
        for pid in t.pitchers_used:
            c = g.pit.get(pid, Counter())
            dec = None
            if g.decisions.get("win") == pid:
                dec = "勝"
            elif g.decisions.get("loss") == pid:
                dec = "敗"
            elif g.decisions.get("save") == pid:
                dec = "S"
            incomplete = any(pa.get("unrecorded") and pa.get("pitcher") == pid for pa in g.pa_log)
            pitchers.append({**(_player(g, pid) or {}), **{k: c[k] for k in PIT_KEYS},
                             **pitching_rates(c, int(g.rules.get("innings") or 9)),
                             "decision": dec, "pitches_incomplete": incomplete})
        fielders = []
        for key, c in g.fld.items():
            owner = key.split(":pos")[0] if ":pos" in key else g.roster.get(key, {}).get("team")
            if owner != side:
                continue
            fielders.append({"id": key, "name": _fielder_name(g, key), **{k: c[k] for k in FLD_KEYS}})
        out[side] = {
            "batting": rows,
            "batting_total": {**{k: tot[k] for k in BAT_KEYS}, **batting_rates(tot)},
            "pitching": pitchers,
            "fielding": fielders,
            "po_unknown": g.team_stats[side]["PO_UNKNOWN"],
        }
    return out


def scorebook(g: Game) -> dict:
    """スコア表（打順 × 回 のマスに記号を入れる）"""
    book: dict[str, Any] = {}
    for side in ("away", "home"):
        cells: dict[int, dict[int, list[str]]] = {}
        for pa in g.pa_log:
            if pa["side"] != side:
                continue
            order = pa.get("order") or 0
            mark = pa.get("code") or "?"
            cells.setdefault(order, {}).setdefault(pa["inning"], []).append(mark)
        innings = max(len(g.linescore["away"]), len(g.linescore["home"]), 1)
        book[side] = {
            "innings": innings,
            "rows": [
                {"order": o, "cells": {str(i): cells.get(o, {}).get(i, []) for i in range(1, innings + 1)}}
                for o in range(1, max(len(g.teams[side].slots), 9) + 1)
            ],
        }
    return book


def career(rows: list[dict]) -> dict:
    """複数試合の通算成績 rows = [{"bat": Counter, "pit": Counter, "fld": Counter, "innings": int}]"""
    bat, pit, fld = Counter(), Counter(), Counter()
    games = 0
    w = l = 0
    for r in rows:
        games += 1
        bat.update(r.get("bat") or {})
        pit.update(r.get("pit") or {})
        fld.update(r.get("fld") or {})
        w += 1 if r.get("decision") == "勝" else 0
        l += 1 if r.get("decision") == "敗" else 0
    return {
        "games": games,
        "batting": {**{k: bat[k] for k in BAT_KEYS}, **batting_rates(bat)},
        "pitching": {**{k: pit[k] for k in PIT_KEYS}, **pitching_rates(pit), "W": w, "L": l},
        "fielding": {k: fld[k] for k in FLD_KEYS},
    }
