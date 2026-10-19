"""検証試合：2026-10-18 Nexus Tokyo（先攻） 2－6 EDOSEN（後攻）

nexus_edo_20261018_fixture_v2.json の確認済み打席結果を、アプリの入力イベントに置き換えたもの

・選手名と出場IDは未確定のため、打順ごとの仮選手（NX1〜NX9 / ED1〜ED9）で登録する
・投手は不明のため「投手（未確認）」の仮選手を1人ずつ置く（DH扱いで打順外）
・投球内容はほぼ不明のため「打席結果のみ入力」を使う
・資料で未確認とされている走塁は meta.unconfirmed=True を付けて区別する
・試合は7回表3アウトで終了（7回制として登録 ※7回制か時間切れかは未確認）
"""
from __future__ import annotations

RULES = {"innings": 7}


def roster() -> dict:
    r = {}
    for i in range(1, 10):
        r[f"NX{i}"] = {"name": f"Nexus {i}番", "team": "away"}
        r[f"ED{i}"] = {"name": f"EDOSEN {i}番", "team": "home"}
    r["NXP"] = {"name": "Nexus 投手（未確認）", "team": "away"}
    r["EDP"] = {"name": "EDOSEN 投手（未確認）", "team": "home"}
    return r


class _Builder:
    def __init__(self) -> None:
        self.events: list[dict] = []
        # 6回裏の各プレー直後を照合するための目印（イベントID → 表の順序番号）
        self.marks: dict[str, int] = {}

    def add(self, typ: str, payload: dict, unconfirmed: bool = False, note: str = "") -> str:
        eid = f"e{len(self.events) + 1:03d}"
        self.events.append({
            "id": eid, "seq": len(self.events) + 1, "type": typ, "payload": payload,
            "meta": {"unconfirmed": unconfirmed, "note": note},
        })
        return eid

    def pa(self, result: str, pos: int | None = None, fielders: list[int] | None = None,
           moves: list[dict] | None = None, unconfirmed: bool = False, note: str = "", **kw) -> str:
        payload = {"result": result, "pos": pos, "moves": moves or []}
        if fielders is not None:
            payload["fielders"] = fielders
        payload.update(kw)
        if unconfirmed:
            payload["unconfirmed"] = True
        return self.add("pa_result", payload, unconfirmed, note)

    def runner(self, moves: list[dict], unconfirmed: bool = False, note: str = "") -> str:
        return self.add("runner", {"moves": moves}, unconfirmed, note)

    def pitch(self, result: str, runners: list[dict] | None = None, note: str = "") -> str:
        return self.add("pitch", {"result": result, "runners": runners or []}, note=note)


def events() -> tuple[list[dict], dict[str, int]]:
    b = _Builder()
    # スタメン（守備位置は未確認のため空欄）
    b.add("lineup", {"side": "away", "slots": [{"player_id": f"NX{i}"} for i in range(1, 10)], "pitcher_id": "NXP"})
    b.add("lineup", {"side": "home", "slots": [{"player_id": f"ED{i}"} for i in range(1, 10)], "pitcher_id": "EDP"})

    # 1回表
    b.pa("fly_out", 3)
    b.pa("ground_out", 6, [6, 3])
    b.pa("home_run", 9, label="右越えソロ本塁打")
    b.pa("ground_out", 4, [4, 3])
    # 1回裏
    b.pa("ground_out", 3, [3])  # 一ゴロ・一塁手が自ら一塁を踏む → スコア表示 3A
    b.pa("ground_out", 6, [6, 3])
    b.pa("strikeout")
    # 2回表
    b.pa("fly_out", 6)
    b.pa("fly_out", 6)
    b.pa("strikeout")
    # 2回裏
    b.pa("strikeout")
    b.pa("strikeout")
    b.pa("strikeout")
    # 3回表
    b.pa("strikeout")
    b.pa("fly_out", 5)
    b.pa("fly_out", 3)
    # 3回裏
    b.pa("single", 7, notes="ポテン", label="左前安打（ポテン）")
    b.pa("ground_out", 5, [5, 3], moves=[{"from": 1, "to": 2, "how": "adv"}])
    b.pa("ground_out", 3, [3, 1], unconfirmed=True, note="二塁走者の動きは未確認（二塁にとどまったものとして仮置き）")
    b.pa("line_out", 4)
    # 4回表
    b.pa("triple", 7, label="左越え三塁打")
    b.pa("fly_out", 7)
    #   4番の打席：4球目の暴投で三塁走者（2番）生還 → 四球
    b.pitch("unknown")
    b.pitch("unknown")
    b.pitch("unknown")
    b.pitch("unknown", runners=[{"from": 3, "to": 4, "how": "wp"}], note="4球目WP（球種は未確認）")
    b.pa("walk", note="5球目以降の投球は未記録")
    #   5番の打席：初球暴投で一塁走者（4番）二塁へ → 三ゴロ失策、4番は三塁へ
    b.pitch("unknown", runners=[{"from": 1, "to": 2, "how": "wp"}], note="初球WP（球種は未確認）")
    b.pa("reach_on_error", 5, ground=True, moves=[{"from": 2, "to": 3, "how": "adv"}], label="三ゴロ失策（三失）")
    #   6番：三直、三塁走者が帰塁できず併殺（アウトの取り方は未確認）
    b.pa("line_out", 5, [5], moves=[{"from": 3, "to": "out", "how": "doubled_off", "fielders_unknown": True}],
         unconfirmed=True, note="三塁走者アウトの守備の流れは未確認")
    # 4回裏
    b.pa("triple", 9, label="右越え三塁打")
    b.pa("ground_out", 5, [5, 3])
    b.pa("strikeout")
    b.runner([{"from": 3, "to": 4, "how": "wp"}], unconfirmed=True, note="5番の打席中のWP 何球目かは未確認")
    b.pa("walk")
    b.pa("single", 7, notes="ポテン", label="左前安打（ポテン）")
    b.pa("single", 9, moves=[{"from": 2, "to": 4, "how": "adv"}, {"from": 1, "to": 3, "how": "adv"}])
    b.pa("ground_out", 5, [5, 3])
    # 5回表
    b.pa("strikeout")
    b.pa("strikeout")
    b.pa("strikeout")
    # 5回裏
    b.pa("fly_out", 7)
    b.pa("reach_on_error", 8, label="中失（中堅手の失策）")
    b.runner([{"from": 1, "to": 2, "how": "wp"}], unconfirmed=True, note="1番走者のWP進塁 どの打席中かは未確認（2番の打席中として仮置き）")
    b.pa("walk")
    b.pa("home_run", 7, label="左越え3ラン本塁打")
    b.pa("fly_out", 6)
    b.pa("strikeout")
    # 6回表
    b.pa("fly_out", 3)
    b.pa("strikeout")
    b.pa("strikeout")
    # 6回裏（正解として固定するテストケース 表の順序1〜8）
    b.marks[b.pa("reach_on_error", 6, ground=True, label="遊ゴ失")] = 1
    b.marks[b.runner([{"from": 1, "to": 2, "how": "sb"}], note="二盗（何球目かは未確認）")] = 2
    b.marks[b.pa("ground_out", 4, [4, 3], moves=[{"from": 2, "to": 3, "how": "adv"}])] = 3
    b.marks[b.pa("single", 8, moves=[{"from": 3, "to": 4, "how": "adv"}])] = 4
    b.marks[b.runner([{"from": 1, "to": 2, "how": "sb"}], note="二盗（何球目かは未確認）")] = 5
    b.marks[b.pa("strikeout")] = 6
    b.marks[b.pa("walk")] = 7
    b.marks[b.pa("fly_out", 5)] = 8
    # 7回表
    b.pa("ground_out", 6, fielders_unknown=True, note="守備の流れ（6-3か等）は未確認")
    b.pa("strikeout")
    b.pa("strikeout")
    return b.events, b.marks
