"""検証試合（2026-10-18 Nexus Tokyo 2－6 EDOSEN）の照合テスト

資料 nexus_edo_20261018_fixture_v2.json の確認済みの数字と、エンジンの計算結果が一致するかを見る
"""
import json
from pathlib import Path

import pytest

from app.engine.core import replay
from app.engine.views import game_view
from fixtures import nexus_edo_20261018 as fx

FIXTURE = json.loads((Path(__file__).parent.parent / "fixtures" / "nexus_edo_20261018_fixture_v2.json")
                     .read_text(encoding="utf-8"))
PREFIX = {"Nexus Tokyo": "NX", "EDOSEN": "ED"}


@pytest.fixture(scope="module")
def game():
    evs, _ = fx.events()
    g, halted = replay(evs, fx.RULES, fx.roster())
    assert halted is None, halted
    return g


def test_final_score_and_linescore(game):
    assert game.status == "final"
    assert game.score("away") == 2
    assert game.score("home") == 6
    assert game.linescore["away"] == FIXTURE["game"]["score_by_inning"]["Nexus Tokyo"]
    assert game.linescore["home"] == FIXTURE["game"]["score_by_inning"]["EDOSEN"]  # 7回裏は×


def test_plate_appearance_count(game):
    assert len(game.pa_log) == 53
    assert sum(1 for p in game.pa_log if p["side"] == "away") == 24
    assert sum(1 for p in game.pa_log if p["side"] == "home") == 29


@pytest.mark.parametrize("team", ["Nexus Tokyo", "EDOSEN"])
def test_batting_by_order(game, team):
    """打順ごとの暫定集計（PA/AB/H/R/RBI/BB/SO/TB/確認済み盗塁）が資料と一致する"""
    for row in FIXTURE["batting_by_order"][team]:
        c = game.bat[f"{PREFIX[team]}{row['order']}"]
        got = {"pa": c["PA"], "ab": c["AB"], "h": c["H"], "r": c["R"], "rbi": c["RBI"],
               "bb": c["BB"], "so": c["SO"], "tb": c["TB"], "sb": c["SB"]}
        want = {k: row[k] for k in ("pa", "ab", "h", "r", "rbi", "bb", "so", "tb")}
        want["sb"] = row["sb_confirmed_minimum"]
        assert got == want, f"{team} {row['order']}番"


@pytest.mark.parametrize("team,side", [("Nexus Tokyo", "away"), ("EDOSEN", "home")])
def test_team_batting_totals(game, team, side):
    v = game_view(game, None)
    tot = v["box"][side]["batting_total"]
    want = FIXTURE["batting_team_stats"][team]
    assert tot["PA"] == want["pa"]
    assert tot["AB"] == want["ab"]
    assert tot["H"] == want["hits"]
    assert tot["TB"] == want["total_bases"]
    assert tot["BB"] == want["walks"]
    assert tot["SO"] == want["strikeouts"]
    assert tot["R"] == want["runs"]
    assert tot["RBI"] == want["rbi"]
    assert tot["AVG"] == f"{want['batting_average']:.3f}"[1:]
    assert tot["SLG"] == f"{want['slugging']:.3f}"[1:]
    assert tot["OBP"] == f"{want['on_base_percentage_provisional']:.3f}"[1:]


def test_bottom6_step_by_step():
    """6回裏：資料の表（順序1〜8）どおりにアウト・走者・得点が推移する"""
    evs, marks = fx.events()
    table = {
        1: (0, {1: "ED6"}, 0),
        2: (0, {2: "ED6"}, 0),
        3: (1, {3: "ED6"}, 0),
        4: (1, {1: "ED8"}, 1),
        5: (1, {2: "ED8"}, 0),
        6: (2, {2: "ED8"}, 0),
        7: (2, {1: "ED1", 2: "ED8"}, 0),
    }
    g, _ = replay(evs, fx.RULES, fx.roster())
    log = {e["id"]: e for e in g.event_log}
    prev_runs = None
    for eid, step in sorted(marks.items(), key=lambda x: x[1]):
        after = log[eid]["after"]
        runs_now = after["score"]["home"]
        if step == 8:
            # 3アウトで攻撃終了 → 7回表へ
            assert after["inning"] == 7 and after["half"] == "top"
            assert after["outs"] == 0
            continue
        outs, bases, runs = table[step]
        assert after["outs"] == outs, f"順序{step} アウト"
        assert {b: p for b, p in after["bases"].items() if p} == bases, f"順序{step} 走者"
        if prev_runs is not None:
            assert runs_now - prev_runs == runs, f"順序{step} 得点"
        prev_runs = runs_now


def test_bottom6_run_and_rbi_attribution(game):
    runs = [r for r in game.runs_log if r["inning"] == 6 and r["side"] == "home"]
    assert len(runs) == 1
    assert runs[0]["runner"] == "ED6"
    assert runs[0]["rbi_batter"] == "ED8"
    # 6回裏の残塁2（1番・8番）
    assert game.team_stats["home"]["LOB"] == 5  # 3回1・4回2・6回2


def test_special_events_wp_runs_have_no_rbi(game):
    # 4回表：4番の打席中のWPで2番が生還（打点なし）
    r = [x for x in game.runs_log if x["inning"] == 4 and x["side"] == "away"]
    assert len(r) == 1 and r[0]["runner"] == "NX2" and r[0]["rbi_batter"] is None
    # 4回裏：5番打席中WPで2番生還（打点なし）、四球の5番が7番の右前打で生還（打点7番）
    r = [x for x in game.runs_log if x["inning"] == 4 and x["side"] == "home"]
    assert [(x["runner"], x["rbi_batter"]) for x in r] == [("ED2", None), ("ED5", "ED7")]
    # 5回裏：中失の1番・四球の2番が3ラン本塁打で生還
    r = [x for x in game.runs_log if x["inning"] == 5]
    assert [(x["runner"], x["rbi_batter"]) for x in r] == [("ED1", "ED3"), ("ED2", "ED3"), ("ED3", "ED3")]


def test_double_play_top4(game):
    pa = [p for p in game.pa_log if p["inning"] == 4 and p["side"] == "away"][-1]
    assert pa["order"] == 6 and pa["outs_on_play"] == 2
    assert "併殺" in pa["label"]
    assert pa["code"] == "三直併"


def test_scorebook_notation(game):
    pa = [p for p in game.pa_log if p["inning"] == 1 and p["side"] == "home"][0]
    assert pa["label"] == "一ゴロ"   # 入力・速報は一ゴロ
    assert pa["code"] == "一ゴロ"   # スコア表示も一ゴロ
    assert pa["seq"] == "3A"        # 守備の流れ（経過に表示）は3A


def test_reference_earned_runs_and_decisions(game):
    """参考値：投手交代なし前提の自責点と勝敗投手（資料では未確定 確定値ではない）"""
    assert game.pit["NXP"]["R"] == 6 and game.pit["NXP"]["ER"] == 4
    assert game.pit["EDP"]["R"] == 2 and game.pit["EDP"]["ER"] == 2
    assert game.decisions["win"] == "EDP"
    assert game.decisions["loss"] == "NXP"


def test_unconfirmed_events_are_flagged(game):
    flagged = [e for e in game.event_log if e["unconfirmed"]]
    assert len(flagged) == 4


def test_errors_belong_to_fielding_team(game):
    v = game_view(game, None)
    assert v["rhe"]["away"]["E"] == 2   # Nexus：中失・遊失
    assert v["rhe"]["home"]["E"] == 1   # EDOSEN：三失
    assert v["box"]["home"]["po_unknown"] == 2  # EDOSEN守備で守備者未確認のアウト2つ
