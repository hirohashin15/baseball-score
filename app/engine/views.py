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

# 成績の項目（NPBの個人成績の項目に合わせる）
BAT_KEYS = ["G", "PA", "AB", "R", "H", "2B", "3B", "HR", "TB", "RBI", "SB", "CS", "SH", "SF",
            "BB", "IBB", "HBP", "SO", "GIDP", "ROE"]
PIT_KEYS = ["G", "W", "L", "SV", "HLD", "OUTS", "BF", "pitches", "H", "HR", "BB", "IBB", "HBP", "SO",
            "WP", "BK", "R", "ER"]
FLD_KEYS = ["G", "PO", "A", "E", "DP", "PB", "SB_A", "CS_C", "PO_K"]


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
    """投球回の表記（NPB式：5回1/3 → "5 1/3"）"""
    return f"{outs // 3} {outs % 3}/3" if outs % 3 else f"{outs // 3}"


def fielding_rates(c: Counter) -> dict:
    chances = c["PO"] + c["A"] + c["E"]
    att = c["SB_A"] + c["CS_C"]
    return {"FPCT": _rate(c["PO"] + c["A"], chances), "CS_PCT": _rate(c["CS_C"], att)}


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
        "decisions": {k: (_player(g, v) if k in ("win", "loss", "save")
                          else [_player(g, x) for x in v] if k == "holds" else v)
                      for k, v in (g.decisions or {}).items()},
        "forced": sorted(g.forced_bases()),
        "judge": (g.event_log[-1].get("judge") if g.event_log else []) or [],
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


def player_game_stats(g: Game) -> dict[str, dict]:
    """選手ごとの、この試合の成績（打撃・投手・守備） 試合数（G）も付ける"""
    out: dict[str, dict] = {}
    d = g.decisions or {}
    holds = set(d.get("holds") or [])
    for side in ("away", "home"):
        t = g.teams[side]
        for pid in t.used | set(t.pitchers_used):
            out.setdefault(pid, {"bat": Counter(), "pit": Counter(), "fld": Counter(), "decision": None,
                                 "positions": [], "side": side})
    for pid, c in g.bat.items():
        out.setdefault(pid, {"bat": Counter(), "pit": Counter(), "fld": Counter(), "decision": None,
                             "positions": [], "side": g.roster.get(pid, {}).get("team")})
        out[pid]["bat"] = Counter(c)
    for pid, c in g.pit.items():
        if pid in out:
            out[pid]["pit"] = Counter(c)
    for pid, c in g.fld.items():
        if pid in out:
            out[pid]["fld"] = Counter(c)
    batted = set()
    for side in ("away", "home"):
        batted |= {pid for _, pid in g.teams[side].slot_history}
    for pid, row in out.items():
        if pid in batted or row["bat"]["PA"]:
            row["bat"]["G"] = 1
        if any(pid in g.teams[s].pitchers_used for s in ("away", "home")):
            row["pit"]["G"] = 1
        if g.fpos.get(pid):
            row["fld"]["G"] = 1
            row["positions"] = sorted(g.fpos[pid])
        dec = None
        if d.get("win") == pid:
            dec, row["pit"]["W"] = "勝", 1
        elif d.get("loss") == pid:
            dec, row["pit"]["L"] = "敗", 1
        elif d.get("save") == pid:
            dec, row["pit"]["SV"] = "S", 1
        elif pid in holds:
            dec, row["pit"]["HLD"] = "H", 1
        row["decision"] = dec
    return out


def box_score(g: Game) -> dict:
    """打撃成績・守備成績（投手成績を含む）の表"""
    stats = player_game_stats(g)
    inn = int(g.rules.get("innings") or 9)
    out: dict[str, Any] = {}
    for side in ("away", "home"):
        t = g.teams[side]
        rows, seen = [], set()
        pos_of = {}
        for order, pid in t.slot_history:
            pos_of.setdefault(pid, order)
        for order, pid in sorted(t.slot_history, key=lambda x: x[0]):
            if pid in seen:
                continue
            seen.add(pid)
            c = stats.get(pid, {}).get("bat", Counter())
            rows.append({"order": order, **(_player(g, pid) or {}),
                         "positions": "".join(nt.POS_JA[n] for n in stats.get(pid, {}).get("positions", [])),
                         **{k: c[k] for k in BAT_KEYS}, **batting_rates(c)})
        tot = Counter()
        for r in rows:
            for k in BAT_KEYS:
                tot[k] += r[k]
        pitchers = []
        for pid in t.pitchers_used:
            st = stats.get(pid, {})
            c = st.get("pit", Counter())
            incomplete = any(pa.get("unrecorded") and pa.get("pitcher") == pid for pa in g.pa_log)
            pitchers.append({**(_player(g, pid) or {}), **{k: c[k] for k in PIT_KEYS},
                             **pitching_rates(c, inn), "decision": st.get("decision"),
                             "pitches_incomplete": incomplete})
        fielders = []
        for pid, st in stats.items():
            if st.get("side") != side or not st["fld"]["G"]:
                continue
            c = st["fld"]
            fielders.append({"id": pid, "name": g.name(pid),
                             "positions": "".join(nt.POS_JA[n] for n in st["positions"]),
                             "order": pos_of.get(pid, 99), **{k: c[k] for k in FLD_KEYS}, **fielding_rates(c)})
        # 選手が登録されていない守備位置の記録
        for key, c in g.fld.items():
            if ":pos" in key and key.split(":pos")[0] == side:
                fielders.append({"id": key, "name": "（選手未登録）", "positions": nt.POS_JA.get(int(key.split(":pos")[1]), ""), "order": 100,
                                 **{k: c[k] for k in FLD_KEYS}, **fielding_rates(c)})
        fielders.sort(key=lambda r: (r["order"], r["name"]))
        out[side] = {
            "batting": rows,
            "batting_total": {**{k: tot[k] for k in BAT_KEYS}, **batting_rates(tot), "LOB": g.team_stats[side]["LOB"]},
            "pitching": pitchers,
            "team_er": g.team_stats[side]["ER"],
            "fielding": fielders,
            "po_unknown": g.team_stats[side]["PO_UNKNOWN"],
        }
    return out


def scorebook(g: Game) -> dict:
    """スコア表（打順 × 回 のマスに記号を入れる）

    cells：画面のスコアタブ用の短い表記
    detail：スコアブック形式の出力用（打者走者がどこまで進んだか、何で進んだか、何番目のアウトか）
    """
    book: dict[str, Any] = {}
    innings = max(len(g.linescore["away"]), len(g.linescore["home"]), 1)
    for side in ("away", "home"):
        cells: dict[int, dict[int, list[str]]] = {}
        detail: dict[int, dict[int, list[dict]]] = {}
        hits_by_inn: dict[int, int] = {}
        for pa in g.pa_log:
            if pa["side"] != side:
                continue
            order = pa.get("order") or 0
            mark = pa.get("code") or "?"
            cells.setdefault(order, {}).setdefault(pa["inning"], []).append(mark)
            segs = g.paths.get(pa["no"], [])
            reached, scored, out_seg = 0, False, None
            for sg in segs:
                if sg["out"]:
                    out_seg = sg
                else:
                    reached = max(reached, sg["to"])
                    if sg["to"] == 4 and not sg.get("no_run"):
                        scored = True
            if RESULT_META.get(pa.get("result"), {}).get("hit"):
                hits_by_inn[pa["inning"]] = hits_by_inn.get(pa["inning"], 0) + 1
            detail.setdefault(order, {}).setdefault(pa["inning"], []).append({
                "code": mark, "label": pa.get("label"), "seq": pa.get("seq"), "rbi": pa.get("rbi", 0),
                "result": pa.get("result"), "pos": pa.get("pos"), "fielders": pa.get("fielders") or [],
                "pitches": pa.get("pitches", []), "outs_on_play": pa.get("outs_on_play", 0),
                "error_pos": pa.get("error_pos"), "looking": pa.get("looking"),
                "inning": pa["inning"], "half": pa["half"],
                "segments": segs, "reached": reached, "scored": scored,
                "out_no": out_seg["out_no"] if out_seg else None,
                "out_from": out_seg["from"] if out_seg else None,
                "unconfirmed": bool(pa.get("unconfirmed")), "unrecorded": bool(pa.get("unrecorded")),
                "batter": g.name(pa.get("batter")),
            })
        names: dict[int, list[str]] = {}
        for order, pid in g.teams[side].slot_history:
            names.setdefault(order, [])
            if g.name(pid) not in names[order]:
                names[order].append(g.name(pid))
        n_rows = max(len(g.teams[side].slots), 9)
        book[side] = {
            "innings": innings,
            "rows": [
                {"order": o, "names": names.get(o, []),
                 "cells": {str(i): cells.get(o, {}).get(i, []) for i in range(1, innings + 1)},
                 "detail": {str(i): detail.get(o, {}).get(i, []) for i in range(1, innings + 1)}}
                for o in range(1, n_rows + 1)
            ],
            "hits_by_inning": {str(i): hits_by_inn.get(i, 0) for i in range(1, innings + 1)},
        }
    return book


def career(rows: list[dict]) -> dict:
    """複数試合の通算成績 rows = [{"bat": Counter, "pit": Counter, "fld": Counter}]"""
    bat, pit, fld = Counter(), Counter(), Counter()
    for r in rows:
        bat.update(r.get("bat") or {})
        pit.update(r.get("pit") or {})
        fld.update(r.get("fld") or {})
    return {
        "games": len(rows),
        "batting": {**{k: bat[k] for k in BAT_KEYS}, **batting_rates(bat)},
        "pitching": {**{k: pit[k] for k in PIT_KEYS}, **pitching_rates(pit)},
        "fielding": {**{k: fld[k] for k in FLD_KEYS}, **fielding_rates(fld)},
    }
