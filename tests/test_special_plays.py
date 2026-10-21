"""特殊プレー・投手の責任・訂正の架空試合テスト（検証試合には出てこない場面）"""
from app.engine.core import replay

from .helpers import G, roster


# ---------------------------------------------------------------- 三振と盗塁の同時発生
def test_strikeout_and_steal_on_same_pitch():
    t = G()
    t.pa("single", 7)
    t.pitch("swinging_strike")
    t.pitch("swinging_strike")
    t.pitch("swinging_strike", runners=[{"from": 1, "to": 2, "how": "sb"}])
    g = t.ok()
    assert g.outs == 1
    assert g.bases[2].player_id == "A1" and g.bases[1] is None
    assert g.bat["A2"]["SO"] == 1 and g.bat["A1"]["SB"] == 1
    assert g.pit["HP1"]["SO"] == 1


def test_strikeout_caught_stealing_double_play():
    t = G()
    t.pa("single", 7)
    t.pitch("called_strike")
    t.pitch("called_strike")
    t.pitch("swinging_strike", runners=[{"from": 1, "to": "out", "how": "cs", "fielders": [2, 6]}])
    g = t.ok()
    assert g.outs == 2
    assert g.bat["A1"]["CS"] == 1
    assert "三振併殺" in g.pa_log[-1]["label"]
    assert g.fld["H8"]["A"] == 1 and g.fld["H2"]["PO"] == 2 - 1  # 捕手補殺・遊撃手刺殺


# ---------------------------------------------------------------- 振り逃げ
def test_dropped_third_strike_with_two_outs():
    t = G()
    t.pa("single", 7)
    t.pa("strikeout")
    t.pa("strikeout")
    for _ in range(2):
        t.pitch("swinging_strike")
    t.pitch("swinging_strike", dropped={"reached": True, "how": "wp"})
    g = t.ok()
    assert g.outs == 2
    assert g.bases[1].player_id == "A4" and g.bases[2].player_id == "A1"
    assert g.bat["A4"]["SO"] == 1 and g.bat["A4"]["AB"] == 1
    assert g.pit["HP1"]["SO"] == 3 and g.pit["HP1"]["WP"] == 1


def test_dropped_third_strike_not_allowed_with_runner_on_first():
    t = G()
    t.pa("single", 7)
    t.pa("strikeout_dropped")
    g, halted = t.run()
    assert halted is not None and "振り逃げはできません" in halted["message"]


def test_dropped_third_strike_on_passed_ball_run_is_unearned():
    t = G()
    t.pitch("swinging_strike")
    t.pitch("swinging_strike")
    t.pitch("swinging_strike", dropped={"reached": True, "how": "pb"})
    t.pa("home_run", 7)
    g = t.ok()
    assert g.score("away") == 2
    assert g.pit["HP1"]["R"] == 2 and g.pit["HP1"]["ER"] == 1
    assert g.fld["H8"]["PB"] == 1


# ---------------------------------------------------------------- 併殺崩れ・併殺打
def test_force_out_failed_double_play():
    t = G()
    t.pa("single", 7)
    t.pa("force_out", 6)
    g = t.ok()
    assert g.outs == 1
    assert g.bases[1].player_id == "A2" and g.bases[2] is None
    b = g.bat["A2"]
    assert (b["AB"], b["H"], b["GIDP"], b["FC"]) == (1, 0, 0, 0)
    assert g.pa_log[-1]["label"] == "遊ゴロ（併殺崩れ）"
    assert g.fld["H3"]["PO"] == 1 and g.fld["H2"]["A"] == 1  # 6-4


def test_ground_into_double_play():
    t = G()
    t.pa("single", 7)
    t.pa("ground_out", 6, fielders=[4, 3], moves=[{"from": 1, "to": "out", "how": "force", "fielders": [6, 4]}])
    g = t.ok()
    assert g.outs == 2 and g.bases[1] is None
    assert g.bat["A2"]["GIDP"] == 1
    assert "併殺" in g.pa_log[-1]["label"]


# ---------------------------------------------------------------- インフィールドフライ
def test_infield_fly_dropped_runner_scores():
    t = G()
    for _ in range(3):
        t.pa("single", 7)
    t.pa("infield_fly", 6, moves=[{"from": 3, "to": 4, "how": "adv"}])
    g = t.ok()
    assert g.outs == 1 and g.score("away") == 1
    assert g.bases[2].player_id == "A2" and g.bases[1].player_id == "A3"
    assert g.bat["A4"]["AB"] == 1 and g.bat["A4"]["RBI"] == 1
    assert g.pit["HP1"]["ER"] == 1


def test_infield_fly_requires_runners_on_first_and_second():
    t = G()
    t.pa("single", 7)
    t.pa("infield_fly", 6)
    _, halted = t.run()
    assert halted and "インフィールドフライ" in halted["message"]


# ---------------------------------------------------------------- 投手交代と責任投手
def test_inherited_runner_charged_to_previous_pitcher():
    t = G()
    t.pa("walk")
    t.sub(kind="pitcher", side="home", in_player="HP2")
    t.pa("double", 8, moves=[{"from": 1, "to": 4, "how": "adv"}])
    g = t.ok()
    assert g.pit["HP1"]["R"] == 1 and g.pit["HP1"]["ER"] == 1
    assert g.pit["HP2"]["R"] == 0 and g.pit["HP2"]["H"] == 1


def test_fielders_choice_swaps_responsibility():
    """救援投手の打者が、前任投手の走者を封殺して出塁 → 打者走者は前任投手の責任（規則9.16(g)）"""
    t = G()
    t.pa("single", 7)
    t.sub(kind="pitcher", side="home", in_player="HP2")
    t.pa("force_out", 6)
    t.pa("home_run", 7)
    g = t.ok()
    assert g.pit["HP1"]["R"] == 1   # A2（A1の代わりに塁にいた走者）
    assert g.pit["HP2"]["R"] == 1   # A3 本人


def test_walk_after_mid_count_change_charged_to_previous_pitcher():
    t = G()
    for r in ("ball", "ball", "ball", "called_strike"):
        t.pitch(r)
    t.sub(kind="pitcher", side="home", in_player="HP2")
    t.pitch("ball")
    g = t.ok()
    assert g.pit["HP1"]["BB"] == 1 and g.pit["HP2"]["BB"] == 0
    assert g.bases[1].pitcher_id == "HP1"


def test_walk_after_even_count_change_charged_to_reliever():
    t = G()
    for r in ("ball", "called_strike"):
        t.pitch(r)
    t.sub(kind="pitcher", side="home", in_player="HP2")
    for r in ("ball", "ball", "ball"):
        t.pitch(r)
    g = t.ok()
    assert g.pit["HP2"]["BB"] == 1 and g.pit["HP1"]["BB"] == 0


def test_pinch_hitter_with_two_strikes_strikeout_charged_to_original():
    t = G()
    t.pitch("swinging_strike")
    t.pitch("swinging_strike")
    t.sub(kind="pinch_hitter", side="away", in_player="AS1")
    t.pitch("swinging_strike")
    g = t.ok()
    assert g.bat["A1"]["SO"] == 1 and g.bat["A1"]["AB"] == 1
    assert g.bat["AS1"]["PA"] == 0
    assert g.teams["away"].slots[0] == "AS1"


def test_winning_pitcher_relief_when_starter_short():
    t = G({"innings": 3})
    t.pa("home_run", 7)          # 1回表 A1 本塁打 1-0
    t.pa("strikeout"); t.pa("strikeout"); t.pa("strikeout")
    t.three_outs()               # 1回裏 AP1
    t.three_outs()               # 2回表
    t.sub(kind="pitcher", side="away", in_player="AP2")
    t.three_outs()               # 2回裏 AP2
    t.three_outs()               # 3回表
    t.three_outs()               # 3回裏 → 試合終了 1-0
    g = t.ok()
    assert g.status == "final" and g.score("away") == 1
    assert g.decisions["loss"] == "HP1"
    assert g.decisions["win"] == "AP2"
    assert "先発が規定" in g.decisions["note"]


def test_winning_pitcher_is_reliever_of_record():
    t = G({"innings": 2})
    t.three_outs()                                       # 1回表（HP1）
    t.three_outs()                                       # 1回裏（AP1）
    t.sub(kind="pitcher", side="home", in_player="HP2")
    t.three_outs()                                       # 2回表（HP2）
    t.pa("home_run", 7)                                  # 2回裏サヨナラ
    g = t.ok()
    assert g.final_reason == "walkoff"
    assert g.decisions["win"] == "HP2"
    assert g.decisions["loss"] == "AP1"


# ---------------------------------------------------------------- 得点の有効・無効
def test_run_does_not_count_on_third_out_force():
    t = G()
    for _ in range(3):
        t.pa("single", 7)
    t.pa("strikeout"); t.pa("strikeout")
    t.pa("force_out", 6)
    g = t.ok()
    assert g.score("away") == 0
    assert g.half == "bottom"


def test_run_counts_before_time_play_third_out():
    t = G()
    t.pa("strikeout"); t.pa("strikeout")
    t.pa("double", 7)
    t.pa("single", 7, moves=[{"from": 2, "to": 3, "how": "adv"}])
    # 一・三塁 → 単打で三塁走者生還、一塁走者は三塁でタッチアウト（3アウト目・タイムプレー）
    t.pa("single", 8, moves=[{"from": 3, "to": 4, "how": "adv"},
                             {"from": 1, "to": "out", "how": "tag", "fielders": [8, 5]}])
    g = t.ok()
    assert g.score("away") == 1
    assert g.bat["A5"]["RBI"] == 1


def test_walkoff_only_winning_run_counts_and_hit_is_capped():
    t = G({"innings": 1})
    t.three_outs()
    t.pa("walk")
    t.pa("walk")
    t.pa("double", 7, moves=[{"from": 2, "to": 4, "how": "adv"}, {"from": 1, "to": 4, "how": "adv"}])
    g = t.ok()
    assert g.status == "final" and g.final_reason == "walkoff"
    assert g.score("home") == 1
    assert g.bat["H3"]["RBI"] == 1 and g.bat["H3"]["2B"] == 1


def test_walkoff_hit_from_third_becomes_single():
    t = G({"innings": 1})
    t.three_outs()
    t.pa("triple", 7)
    t.pa("double", 7)
    g = t.ok()
    assert g.score("home") == 1
    assert g.bat["H2"]["1B"] == 1 and g.bat["H2"]["2B"] == 0 and g.bat["H2"]["TB"] == 1


# ---------------------------------------------------------------- 打席途中の3アウト
def test_third_out_caught_stealing_batter_leads_off_next_inning():
    t = G()
    t.pa("strikeout"); t.pa("strikeout")
    t.pa("single", 7)
    t.pitch("ball", runners=[{"from": 1, "to": "out", "how": "cs", "fielders": [2, 6]}])
    t.three_outs()  # 1回裏
    g = t.ok()
    assert g.inning == 2 and g.half == "top"
    assert g.current_batter() == ("A4", 4)
    assert g.bat["A4"]["PA"] == 0


# ---------------------------------------------------------------- 走塁・交代
def test_balk_advances_and_counts():
    t = G()
    t.pa("single", 7)
    t.runner([{"from": 1, "to": 2, "how": "bk"}])
    g = t.ok()
    assert g.bases[2].player_id == "A1" and g.pit["HP1"]["BK"] == 1


def test_temp_runner_run_credited_to_original():
    t = G()
    t.pa("single", 7)
    t.sub(kind="temp_runner", side="away", base=1, in_player="AS2")
    t.pa("home_run", 7)
    g = t.ok()
    assert g.bat["A1"]["R"] == 1 and g.bat["AS2"]["R"] == 0
    assert g.teams["away"].slots[0] == "A1"


def test_pinch_runner_replaces_slot_and_gets_run():
    t = G()
    t.pa("single", 7)
    t.sub(kind="pinch_runner", side="away", base=1, in_player="AS2")
    t.pa("home_run", 7)
    g = t.ok()
    assert g.bat["AS2"]["R"] == 1 and g.teams["away"].slots[0] == "AS2"


def test_reentry_respects_rule():
    for reentry, ok in ((True, True), (False, False)):
        t = G({"reentry": reentry})
        t.sub(kind="defense", side="home", in_player="HS1", out_player="H1", position="CF")
        t.sub(kind="defense", side="home", in_player="H1", out_player="HS1", position="CF")
        _, halted = t.run()
        assert (halted is None) == ok


def test_ten_man_lineup_needs_rule():
    t = G()
    t.events[0]["payload"]["slots"].append({"player_id": "AS1"})
    _, halted = t.run()
    assert halted and "10人以上" in halted["message"]
    t.rules = {"extra_hitters": True}
    t.ok()


# ---------------------------------------------------------------- 入力ミスの検出
def test_two_runners_on_same_base_rejected():
    t = G()
    t.pa("single", 7)
    t.pa("single", 7, moves=[{"from": 1, "to": 1}])
    _, halted = t.run()
    assert halted and "2人" in halted["message"]


def test_too_many_outs_rejected():
    t = G()
    t.pa("single", 7)
    t.pa("strikeout"); t.pa("strikeout")
    t.pa("ground_out", 6, moves=[{"from": 1, "to": "out", "how": "force"}])
    _, halted = t.run()
    assert halted and "アウトが多すぎます" in halted["message"]


# ---------------------------------------------------------------- 取消・訂正・挿入
def test_void_last_play_restores_state():
    t = G()
    t.pa("single", 7)
    eid = t.pa("double", 7)
    t.add("void", {"target": eid})
    g = t.ok()
    assert g.bases[1].player_id == "A1" and g.bases[2] is None
    assert g.current_batter() == ("A2", 2)
    assert g.bat["A2"]["PA"] == 0


def test_void_of_void_restores_original():
    t = G()
    eid = t.pa("single", 7)
    vid = t.add("void", {"target": eid})
    t.add("void", {"target": vid})
    g = t.ok()
    assert g.bat["A1"]["H"] == 1


def test_correct_middle_play_recalculates_everything():
    t = G()
    t.pa("single", 7)
    mid = t.pa("strikeout")
    t.pa("home_run", 7)
    g = t.ok()
    assert g.score("away") == 2
    t.add("correct", {"target": mid, "event": {"type": "pa_result", "payload": {"result": "walk"}}})
    g = t.ok()
    assert g.score("away") == 3            # A1・A2・A3 が本塁打で生還
    assert g.bat["A2"]["BB"] == 1 and g.bat["A2"]["SO"] == 0
    assert g.bat["A3"]["RBI"] == 3


def test_correction_that_breaks_later_play_halts_there():
    t = G()
    first = t.pa("single", 7)
    later = t.runner([{"from": 1, "to": 2, "how": "sb"}])
    t.add("correct", {"target": first, "event": {"type": "pa_result", "payload": {"result": "strikeout"}}})
    g, halted = t.run()
    assert halted["event_id"] == later
    assert "一塁に走者がいません" in halted["message"]
    assert g.outs == 1  # 矛盾の直前までは計算済み


def test_insert_missing_play():
    t = G()
    t.pa("single", 7)
    nxt = t.pa("fly_out", 8)
    t.add("insert", {"before": nxt, "event": {"type": "pa_result", "payload": {"result": "walk"}}})
    g = t.ok()
    assert g.bat["A2"]["BB"] == 1      # 挿入した四球が2番
    assert g.bat["A3"]["AB"] == 1      # 中飛は3番に繰り下がる
    assert g.bases[2].player_id == "A1" and g.bases[1].player_id == "A2"


def test_replay_stop_before_gives_state_for_correction():
    t = G()
    t.pa("single", 7)
    target = t.pa("double", 7)
    g, _ = replay(t.events, {}, roster(), stop_before=target)
    assert g.bases[1].player_id == "A1" and g.current_batter() == ("A2", 2)


def test_double_play_score_code_is_joined():
    t = G()
    t.pa("single", 7)
    t.pa("ground_out", 6, fielders=[4, 3], moves=[{"from": 1, "to": "out", "how": "force", "fielders": [6, 4]}])
    g = t.ok()
    assert g.pa_log[-1]["code"] == "遊ゴロ併"
    assert g.pa_log[-1]["seq"] == "6-4-3"


# ---------------------------------------------------------------- 自責点（公認野球規則9.16）
def test_runner_advanced_by_passed_ball_then_single_is_unearned():
    t = G()
    t.pa("single", 7)
    t.runner([{"from": 1, "to": 2, "how": "pb"}])
    t.pa("single", 8, moves=[{"from": 2, "to": 4, "how": "adv"}])
    g = t.ok()
    assert g.pit["HP1"]["R"] == 1 and g.pit["HP1"]["ER"] == 0


def test_runner_advanced_by_passed_ball_then_home_run_is_earned():
    t = G()
    t.pa("single", 7)
    t.runner([{"from": 1, "to": 2, "how": "pb"}])
    t.pa("home_run", 8)
    g = t.ok()
    assert g.pit["HP1"]["R"] == 2 and g.pit["HP1"]["ER"] == 2


def test_relief_pitcher_gets_no_benefit_of_earlier_chances():
    t = G()
    t.pa("reach_on_error", 6)          # 失策がなければ1アウト目
    t.pa("strikeout")
    t.pa("strikeout")                  # 実際は2アウト（失策がなければ3アウト）
    t.sub(kind="pitcher", side="home", in_player="HP2")
    t.pa("home_run", 7)
    g = t.ok()
    assert g.pit["HP1"]["R"] == 1 and g.pit["HP1"]["ER"] == 0   # 失策出塁の走者
    assert g.pit["HP2"]["R"] == 1 and g.pit["HP2"]["ER"] == 1   # 救援投手には登板前の機会の恩恵なし
    assert g.team_stats["home"]["ER"] == 0                       # チームとしては自責点0


def test_error_play_extra_advance_is_unearned():
    t = G()
    t.pa("double", 7)                                           # 二塁
    t.pa("reach_on_error", 5, moves=[{"from": 2, "to": 3, "how": "adv"}])
    t.pa("sac_fly", 8)                                          # 三塁走者生還
    g = t.ok()
    # 失策のプレーで二塁→三塁（押し出しではない）は失策による進塁 → 犠飛での生還は自責点にしない
    assert g.pit["HP1"]["R"] == 1 and g.pit["HP1"]["ER"] == 0


# ---------------------------------------------------------------- セーブ・ホールド
def _closing_game(extra_reliever: bool):
    t = G({"innings": 3, "starter_min_outs": 3})
    t.three_outs()                                  # 1回表（HP1）
    t.pa("home_run", 7); t.pa("home_run", 7)        # 1回裏 2-0
    t.three_outs()
    t.three_outs()                                  # 2回表（HP1）
    t.three_outs()                                  # 2回裏
    t.sub(kind="pitcher", side="home", in_player="HP2")
    if extra_reliever:
        t.pa("strikeout")
        t.sub(kind="pitcher", side="home", in_player="HP3")
        t.pa("strikeout"); t.pa("strikeout")
    else:
        t.three_outs()                              # 3回表（HP2）→ 試合終了
    return t.ok()


def test_save_awarded_to_closer():
    g = _closing_game(False)
    assert g.decisions["win"] == "HP1" and g.decisions["save"] == "HP2"


def test_hold_awarded_to_middle_reliever():
    g = _closing_game(True)
    assert g.decisions["save"] == "HP3"
    assert g.decisions["holds"] == ["HP2"]


# ---------------------------------------------------------------- 守備
def test_double_play_credited_to_each_fielder_and_catcher_steals():
    t = G()
    t.pa("single", 7)
    t.runner([{"from": 1, "to": 2, "how": "sb"}])
    t.pa("single", 7, moves=[{"from": 2, "to": 3, "how": "adv"}])
    t.runner([{"from": 1, "to": "out", "how": "cs", "fielders": [2, 6]}])
    t.pa("single", 7)
    t.pa("ground_out", 6, fielders=[4, 3], moves=[{"from": 1, "to": "out", "how": "force", "fielders": [6, 4]}])
    g = t.ok()
    # H2=遊撃手 H3=二塁手 H4=一塁手 H8=捕手
    assert g.fld["H2"]["DP"] == 1 and g.fld["H3"]["DP"] == 1 and g.fld["H4"]["DP"] == 1
    assert g.fld["H8"]["SB_A"] == 1 and g.fld["H8"]["CS_C"] == 1


def test_pickoff_attempt_is_logged_without_change():
    t = G()
    t.pa("single", 7)
    t.runner([])  # moves 空 → エラー
    _, halted = t.run()
    assert halted
    t.events.pop()
    t.add("runner", {"moves": [], "attempt": True, "base": 1})
    g = t.ok()
    assert g.bases[1].player_id == "A1" and g.outs == 0


# ---------------------------------------------------------------- スコアボードの判定ランプ・スコアブック
def test_judge_lamps():
    t = G()
    t.pa("single", 7)
    g = t.ok()
    assert g.event_log[-1]["judge"] == ["H"]
    t.pa("reach_on_error", 6)
    assert t.ok().event_log[-1]["judge"] == ["E"]
    t.pa("fielders_choice", 5, moves=[{"from": 2, "to": 3, "how": "fc"}, {"from": 1, "to": 2, "how": "fc"}])
    assert "FC" in t.ok().event_log[-1]["judge"]


def test_scorebook_paths():
    from app.engine.views import scorebook
    t = G()
    t.pa("single", 7)                                        # 1番 単打
    t.runner([{"from": 1, "to": 2, "how": "sb"}])            # 盗塁
    t.pa("ground_out", 6, fielders=[6, 3], moves=[{"from": 2, "to": 3, "how": "adv"}])  # 2番 遊ゴロ 進塁
    t.pa("single", 8)                                        # 3番 単打で生還
    g = t.ok()
    b = scorebook(g)["away"]
    c1 = b["rows"][0]["detail"]["1"][0]
    assert c1["scored"] and c1["reached"] == 4
    hows = [(sg["from"], sg["to"], sg["how"], sg["by"]) for sg in c1["segments"]]
    assert hows == [(0, 1, "hit", None), (1, 2, "sb", 2), (2, 3, "adv", 2), (3, 4, "adv", 3)]
    c2 = b["rows"][1]["detail"]["1"][0]
    assert c2["out_no"] == 1 and c2["code"] == "遊ゴロ"


def test_catcher_strikeout_putouts():
    t = G()
    t.pa("strikeout"); t.pa("fly_out", 2)
    g = t.ok()
    assert g.fld["H8"]["PO"] == 2 and g.fld["H8"]["PO_K"] == 1


def test_left_right_splits():
    from app.engine.core import replay
    from app.engine.views import player_game_stats, splits
    from .helpers import roster
    r = roster()
    r["HP1"]["throws"] = "L"
    r["HP2"]["throws"] = "R"
    r["A1"]["bats"] = "S"
    t = G()
    t.pa("home_run", 7)                       # A1 対左投手 本塁打（両打→右打席）
    t.pa("strikeout")
    t.pa("strikeout")
    t.sub(kind="pitcher", side="home", in_player="HP2")
    t.pa("single", 8)                         # A4 対右投手 単打（A4の打は未登録）
    g, _ = replay(t.events, {}, r)
    st = player_game_stats(g)
    a1 = splits(st["A1"]["bat"])
    assert a1["L"]["HR"] == 1 and "R" not in a1
    a4 = splits(st["A4"]["bat"])
    assert a4["R"]["H"] == 1
    hp1 = splits(st["HP1"]["pit"])
    assert hp1["R"]["HR"] == 1                # 両打のA1は右打者として数える


# ---------------------------------------------------------------- 守備のまとめて変更
def test_fielder_becomes_pitcher():
    t = G()
    t.three_outs()
    t.sub(kind="pitcher", side="home", in_player="H2")   # 遊撃手H2が投手へ
    g = t.ok()
    tm = g.teams["home"]
    assert tm.pitcher == "H2" and tm.positions[1] == "H2"
    assert "H2" in tm.slots and "H9" in tm.slots           # 打順は変わらない


def test_bulk_rotation_p_2b_ss_and_bench_entry():
    t = G()
    t.three_outs()                                          # 1回表（HP1）
    # 投手HP1(打順外)→遊撃、遊撃H2→二塁、二塁H3→投手 （DHなので投手の打順なし）
    t.sub(kind="bulk", side="home", positions={"P": "H3", "C": "H8", "1B": "H4", "2B": "H2", "3B": "H5",
                                                "SS": "HS1", "LF": "H6", "RF": "H7", "CF": "H1"},
          order={"HS1": "H9"})                              # 控えHS1がDHのH9の打順に入って遊撃へ
    t.pa("strikeout")
    g = t.ok()
    tm = g.teams["home"]
    assert tm.pitcher == "H3" and tm.positions[4] == "H2" and tm.positions[6] == "HS1"
    assert tm.slots[8] == "HS1" and "H9" in tm.removed and "HP1" in tm.removed
    assert g.pit["H3"]["SO"] == 0 and g.pit["H3"]["BF"] == 0   # 1回裏は赤の攻撃→青の投手は投げていない
    assert "H3" in tm.pitchers_used


def test_bulk_requires_order_for_bench_player():
    t = G()
    t.sub(kind="bulk", side="home", positions={"P": "HP1", "C": "H8", "1B": "H4", "2B": "H3", "3B": "H5",
                                                "SS": "HS1", "LF": "H6", "RF": "H7", "CF": "H1"})
    _, halted = t.run()
    assert halted and "誰と交代" in halted["message"]
