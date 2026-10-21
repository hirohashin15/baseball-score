"""野球スコア記録エンジン

試合中に起きたこと（1球・1プレー・選手交代）を「イベント」として順番に積み、
先頭から再生して試合状態（回・アウト・走者・得点・打順）と成績を計算する

・DBや画面には依存しない純粋な計算部品
・訂正／取消はイベントを書き換えず、別イベントとして積む（effective_events で反映）
・ルール上成立しない入力は RuleError（日本語メッセージ）で止める
"""
from __future__ import annotations

import copy
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

from . import notation as nt


class RuleError(Exception):
    """入力が野球のルール上成立しないときのエラー（メッセージは画面にそのまま出す）"""


# 試合ルールの初期値（試合ごとに上書きできる）
DEFAULT_RULES: dict[str, Any] = {
    "innings": 9,            # 規定回数
    "reentry": True,         # 再出場あり
    "dh": True,              # DH（投手が打順に入らない）を使える
    "temp_runner": True,     # 臨時代走あり
    "extra_hitters": False,  # 打順10人以上
    "starter_min_outs": None,  # 先発が勝利投手になるのに必要なアウト数（None=自動）
}

# 打席結果ごとの性質
#   batter: 打者の行き先（"out" はアウト）
#   ab: 打数に数えるか / hit: 安打の塁打数 / runs: 打者が走者になる（後ろの走者に封殺が生じる）
#   kind: 打球の種類（併殺打・打点の判定に使う）
RESULT_META: dict[str, dict[str, Any]] = {
    "single": dict(batter=1, ab=True, hit=1, runs=True, kind="hit"),
    "double": dict(batter=2, ab=True, hit=2, runs=True, kind="hit"),
    "triple": dict(batter=3, ab=True, hit=3, runs=True, kind="hit"),
    "home_run": dict(batter=4, ab=True, hit=4, runs=True, kind="hit"),
    "ground_out": dict(batter="out", ab=True, hit=0, runs=True, kind="ground"),
    "fly_out": dict(batter="out", ab=True, hit=0, runs=False, kind="fly"),
    "line_out": dict(batter="out", ab=True, hit=0, runs=False, kind="line"),
    "foul_fly": dict(batter="out", ab=True, hit=0, runs=False, kind="fly"),
    "infield_fly": dict(batter="out", ab=True, hit=0, runs=False, kind="fly"),
    "sac_bunt": dict(batter="out", ab=False, hit=0, runs=True, kind="ground"),
    "sac_fly": dict(batter="out", ab=False, hit=0, runs=False, kind="fly"),
    "reach_on_error": dict(batter=1, ab=True, hit=0, runs=True, kind="error"),
    "fielders_choice": dict(batter=1, ab=True, hit=0, runs=True, kind="ground"),
    "force_out": dict(batter=1, ab=True, hit=0, runs=True, kind="ground"),
    "strikeout": dict(batter="out", ab=True, hit=0, runs=False, kind="k"),
    "strikeout_dropped": dict(batter=1, ab=True, hit=0, runs=True, kind="k"),
    "walk": dict(batter=1, ab=False, hit=0, runs=True, kind="bb"),
    "ibb": dict(batter=1, ab=False, hit=0, runs=True, kind="bb"),
    "hbp": dict(batter=1, ab=False, hit=0, runs=True, kind="bb"),
    "interference": dict(batter=1, ab=False, hit=0, runs=True, kind="bb"),
    "batter_out_other": dict(batter="out", ab=True, hit=0, runs=False, kind="other"),
}

# 打点が付きうる打席結果
RBI_RESULTS = {
    "single", "double", "triple", "home_run", "ground_out", "fly_out", "line_out",
    "foul_fly", "infield_fly", "sac_bunt", "sac_fly", "fielders_choice", "force_out",
    "walk", "ibb", "hbp", "interference",
}
# この理由で生還した得点には打点を付けない
NO_RBI_HOW = {"error", "wp", "pb", "bk", "sb", "obstruction", "po"}
# この理由での進塁は「守備側のミスによる進塁」（自責点の判定で差し引く）
ERROR_HOW = {"error", "pb", "obstruction"}
# 3アウト目がこの形なら、同じプレーでの得点は認めない（打者アウト・封殺・帰塁失敗）
NO_RUN_OUT_HOW = {"force", "doubled_off"}

STRIKE_PITCHES = {"called_strike", "swinging_strike", "foul", "foul_bunt", "foul_tip"}
PITCH_TYPES = set(nt.PITCH_LABEL)
RUNNER_HOWS = set(nt.HOW_LABEL)


@dataclass
class Runner:
    """塁上の走者"""
    player_id: str              # 成績を付ける選手（代走が出たら代走の選手）
    pitcher_id: str | None      # この走者を出した責任投手
    reached_by: str             # 出塁の理由（打席結果コード）
    unearned: bool = False      # 失策などで出塁＝生還しても自責点にならない
    pa_no: int | None = None    # 出塁した打席の通し番号
    temp_id: str | None = None  # 臨時代走で実際に走っている選手（成績は player_id に付く）
    err_bases: int = 0          # 失策・捕逸・走塁妨害で進んだ塁の数（自責点の判定用）


@dataclass
class TeamState:
    """片方のチームの出場状況"""
    side: str
    slots: list[str] = field(default_factory=list)          # 打順（0始まり）→ 選手ID
    positions: dict[int, str] = field(default_factory=dict)  # 守備番号 → 選手ID
    pitcher: str | None = None
    batter_idx: int = 0
    lineup_set: bool = False
    used: set[str] = field(default_factory=set)      # 出場した選手
    removed: set[str] = field(default_factory=set)   # 交代で退いた選手
    pitchers_used: list[str] = field(default_factory=list)
    slot_history: list[tuple[int, str]] = field(default_factory=list)  # (打順, 選手) 出場順


def other(side: str) -> str:
    return "home" if side == "away" else "away"


def _norm_to(v: Any) -> int | str:
    """走者の行き先を 1〜4 または "out" にそろえる"""
    if v in ("out", "OUT"):
        return "out"
    if v in ("home", "H", "4", 4):
        return 4
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise RuleError(f"走者の行き先が読み取れません：{v}")
    if n not in (1, 2, 3, 4):
        raise RuleError(f"走者の行き先が範囲外です：{v}")
    return n


def _norm_from(v: Any) -> int | str:
    if v in ("B", "batter"):
        return "B"
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise RuleError(f"走者の元の塁が読み取れません：{v}")
    if n not in (1, 2, 3):
        raise RuleError(f"走者の元の塁が範囲外です：{v}")
    return n


class Game:
    """1試合分の状態 イベントを apply() するたびに更新される"""

    def __init__(self, rules: dict | None = None, roster: dict | None = None):
        self.rules = {**DEFAULT_RULES, **(rules or {})}
        self.roster = roster or {}  # 選手ID → {"name", "number", "team"}
        self.inning = 1
        self.half = "top"
        self.outs = 0
        self.balls = 0
        self.strikes = 0
        self.bases: dict[int, Runner | None] = {1: None, 2: None, 3: None}
        self.teams = {"away": TeamState("away"), "home": TeamState("home")}
        self.linescore: dict[str, list[int | None]] = {"away": [], "home": []}
        self.status = "pregame"  # pregame / live / final
        self.final_reason: str | None = None
        self.pa: dict | None = None      # 進行中の打席
        self.pa_no = 0
        self.pa_log: list[dict] = []     # 完了した打席
        self.runs_log: list[dict] = []   # 得点1点ずつ
        self.event_log: list[dict] = []  # イベントごとの説明と直後の状況
        self.bat: dict[str, Counter] = defaultdict(Counter)
        self.pit: dict[str, Counter] = defaultdict(Counter)
        self.fld: dict[str, Counter] = defaultdict(Counter)
        self.team_stats = {"away": Counter(), "home": Counter()}
        self.chances = 0  # この回の「失策がなければアウトだった」数（自責点の判定用）
        self.entry_chances: dict[str, int] = {}  # 回の途中で登板した投手の、登板時点の chances（規則9.16(i)）
        self.stints: list[dict] = []             # 投手ごとの登板記録（セーブ・ホールドの判定用）
        self.open_stint: dict[str, dict | None] = {"away": None, "home": None}
        self.fpos: dict[str, set] = defaultdict(set)  # 守った守備位置（守備の試合数用）
        self._last_pa_no: int | None = None
        self._last_pitch_no: int | None = None
        self._judge: list[str] = []           # 直前プレーの記録判定（H=安打 E=失策 FC=野選）スコアボードのランプ用
        self.paths: dict[int, list[dict]] = defaultdict(list)  # 打席番号 → その打者走者の進塁の記録（スコアブック用）
        self.decisions: dict[str, Any] = {}
        self.decision_override: dict[str, Any] = {}
        self.notes: list[str] = []  # 判定の注意（画面に出す）
        self._cur_event: dict | None = None

    # ------------------------------------------------------------ 参照系
    @property
    def bat_side(self) -> str:
        return "away" if self.half == "top" else "home"

    @property
    def def_side(self) -> str:
        return other(self.bat_side)

    def name(self, pid: str | None) -> str:
        if not pid:
            return "（未登録）"
        p = self.roster.get(pid)
        return p.get("name", pid) if p else pid

    def score(self, side: str) -> int:
        return sum(v or 0 for v in self.linescore[side])

    def current_batter(self) -> tuple[str | None, int | None]:
        t = self.teams[self.bat_side]
        if not t.slots:
            return None, None
        idx = t.batter_idx % len(t.slots)
        return t.slots[idx], idx + 1

    def order_of(self, side: str, pid: str) -> int | None:
        t = self.teams[side]
        if pid in t.slots:
            return t.slots.index(pid) + 1
        return None

    def _fielder(self, n: int) -> str:
        """守備番号 → 成績を付ける先（選手ID、分からなければ「チーム:位置」）"""
        t = self.teams[self.def_side]
        if n == 1 and t.pitcher:
            return t.pitcher
        pid = t.positions.get(n)
        return pid or f"{self.def_side}:pos{n}"

    # ------------------------------------------------------------ 入口
    def apply(self, ev: dict) -> None:
        """イベント1件を反映する ev = {"id", "type", "payload"}"""
        typ = ev.get("type")
        payload = ev.get("payload") or {}
        self._cur_event = ev
        if self.status == "final" and typ not in ("decision", "note"):
            raise RuleError("試合は終了しています（訂正する場合は試合終了を取り消してください）")
        handler = {
            "lineup": self._ev_lineup,
            "pitch": self._ev_pitch,
            "pa_result": self._ev_pa_result,
            "runner": self._ev_runner,
            "sub": self._ev_sub,
            "end": self._ev_end,
            "decision": self._ev_decision,
            "note": lambda p: None,
        }.get(typ)
        if handler is None:
            raise RuleError(f"未対応のイベント種類です：{typ}")
        before = self._brief()
        self._last_pa_no = None
        self._last_pitch_no = None
        self._judge = []
        handler(payload)
        self._mark_fielders()
        after = self._brief()
        # 3アウトで攻守交代した直後は0アウトに戻るため、経過表示用に「このプレー後のアウト数」を別に持つ
        changed = (after["inning"], after["half"]) != (before["inning"], before["half"])
        after["outs_shown"] = 3 if (changed or (self.status == "final" and self.final_reason == "regulation")) \
            and typ != "lineup" and before.get("status") != "pregame" else after["outs"]
        self.event_log.append({
            "id": ev.get("id"),
            "type": typ,
            "desc": self._describe(typ, payload, before),
            "inning": before["inning"],
            "half": before["half"],
            "after": after,
            "pa_no": self._last_pa_no,
            "pitch_no": self._last_pitch_no,
            "judge": list(dict.fromkeys(self._judge)),
            "unconfirmed": bool((ev.get("meta") or {}).get("unconfirmed") or payload.get("unconfirmed")),
        })

    def _brief(self) -> dict:
        return {
            "inning": self.inning, "half": self.half, "outs": self.outs,
            "balls": self.balls, "strikes": self.strikes,
            "bases": {b: (r.player_id if r else None) for b, r in self.bases.items()},
            "score": {"away": self.score("away"), "home": self.score("home")},
            "status": self.status,
            "batter": self.current_batter()[0] if self.status == "live" else None,
            "pitcher": self.teams[self.def_side].pitcher if self.status == "live" else None,
        }

    def _mark_fielders(self) -> None:
        """守備に就いていた選手と位置を記録する（守備の試合数・守備位置別の集計用）"""
        if self.status != "live":
            return
        t = self.teams[self.def_side]
        for n, pid in t.positions.items():
            self.fpos[pid].add(n)
        if t.pitcher:
            self.fpos[t.pitcher].add(1)

    # ------------------------------------------------------------ スタメン
    def _ev_lineup(self, p: dict) -> None:
        side = p.get("side")
        if side not in ("away", "home"):
            raise RuleError("スタメンのチーム（先攻／後攻）が指定されていません")
        if self.status != "pregame":
            raise RuleError("試合開始後はスタメンを変更できません 選手交代で入力してください")
        slots = p.get("slots") or []
        n = len(slots)
        if self.rules.get("extra_hitters"):
            if n < 9:
                raise RuleError("打順は9人以上必要です")
        elif n != 9:
            raise RuleError(f"打順は9人です（現在{n}人） 10人以上で組む場合は試合設定で「打順10人以上」をONにしてください")
        t = TeamState(side)
        seen_pos: dict[int, str] = {}
        for s in slots:
            pid = s.get("player_id")
            if not pid:
                raise RuleError("打順に空きがあります")
            if pid in t.slots:
                raise RuleError(f"{self.name(pid)} が打順に2回入っています")
            t.slots.append(pid)
            pos = s.get("position")
            if pos:
                num = nt.POS_CODE.get(pos)
                if pos == "DH":
                    continue
                if num is None:
                    raise RuleError(f"守備位置が読み取れません：{pos}")
                if num in seen_pos:
                    raise RuleError(f"{nt.POS_NAME[num]}が2人います")
                seen_pos[num] = pid
        t.positions = dict(seen_pos)
        pitcher = p.get("pitcher_id") or seen_pos.get(1)
        if not pitcher:
            raise RuleError("先発投手を指定してください")
        if p.get("pitcher_id") and p["pitcher_id"] not in t.slots and not self.rules.get("dh"):
            raise RuleError("DHを使わない設定では、投手も打順に入れてください")
        t.pitcher = pitcher
        t.positions[1] = pitcher
        t.pitchers_used = [pitcher]
        t.slot_history = [(i + 1, pid) for i, pid in enumerate(t.slots)]
        t.used = set(t.slots) | {pitcher}
        t.lineup_set = True
        self.teams[side] = t

    # ------------------------------------------------------------ 打席の開始・終了
    def _start_live(self) -> None:
        if self.status == "pregame":
            if not (self.teams["away"].lineup_set and self.teams["home"].lineup_set):
                raise RuleError("両チームのスタメンを先に登録してください")
            self.status = "live"
            self._start_half()

    def _start_half(self) -> None:
        side = self.bat_side
        while len(self.linescore[side]) < self.inning:
            self.linescore[side].append(0)
        self.chances = 0
        self.entry_chances = {}

    def _ensure_pa(self) -> dict:
        self._start_live()
        if self.pa is None:
            pid, order = self.current_batter()
            self.pa_no += 1
            self.pa = {
                "no": self.pa_no,
                "side": self.bat_side,
                "inning": self.inning,
                "half": self.half,
                "batter": pid,
                "order": order,
                "pitcher": self.teams[self.def_side].pitcher,
                "pitches": [],
                "unrecorded": False,
                "orig_batter": None, "ph_strikes": None,     # 打席途中の代打（三振の記録先判定）
                "prev_pitcher": None, "change_count": None,  # 打席途中の投手交代（四球の記録先判定）
                "event_ids": [],
            }
        if self._cur_event and self._cur_event.get("id") not in self.pa["event_ids"]:
            self.pa["event_ids"].append(self._cur_event.get("id"))
        self._last_pa_no = self.pa["no"]
        self._touch_stint()
        return self.pa

    def _finish_pa(self, result: str, info: dict) -> None:
        pa = self.pa
        assert pa is not None
        pa.update(info)
        pa["result"] = result
        pa["count"] = f"{self.balls}-{self.strikes}"
        self.pa_log.append(pa)
        t = self.teams[pa["side"]]
        t.batter_idx = (t.batter_idx + 1) % len(t.slots)
        self.pa = None
        self.balls = self.strikes = 0

    # ------------------------------------------------------------ 投球
    def _ev_pitch(self, p: dict) -> None:
        r = p.get("result")
        if r not in PITCH_TYPES:
            raise RuleError(f"投球の種類が読み取れません：{r}")
        pa = self._ensure_pa()
        pitcher = self.teams[self.def_side].pitcher
        pa["pitches"].append(r)
        self._last_pitch_no = len(pa["pitches"])
        self.pit[pitcher]["pitches"] += 1
        moves = p.get("runners") or []
        dropped = p.get("dropped")

        if r == "unknown":
            if moves:
                self._resolve(batter=None, moves=moves, result=None)
                self._after_play()
            return
        if r == "ball":
            self.balls += 1
            if self.balls >= 4:
                self._pa_outcome("walk", {"moves": moves, "pos": None})
            elif moves:
                self._resolve(batter=None, moves=moves, result=None)
                self._after_play()
            return
        if r == "hbp":
            self._pa_outcome("hbp", {"moves": moves, "pos": None})
            return
        if r == "in_play":
            play = p.get("play") or {}
            res = play.get("result")
            if res not in RESULT_META or RESULT_META[res]["kind"] in ("k", "bb"):
                raise RuleError("打球の結果を選んでください")
            self._pa_outcome(res, play)
            return
        # ストライク系
        if r == "foul" and self.strikes >= 2:
            if moves:
                raise RuleError("ファウルの間に走者は進めません（盗塁はファウルで戻ります）")
            return
        self.strikes += 1
        if self.strikes >= 3:
            if dropped and dropped.get("reached"):
                self._pa_outcome("strikeout_dropped", {
                    "moves": moves, "how": dropped.get("how", "wp"),
                    "error_pos": dropped.get("error_pos"),
                    "looking": r == "called_strike",
                })
            else:
                fielders = (dropped or {}).get("fielders")
                self._pa_outcome("strikeout", {
                    "moves": moves, "fielders": fielders, "looking": r == "called_strike",
                })
        elif moves:
            self._resolve(batter=None, moves=moves, result=None)
            self._after_play()

    def _ev_pa_result(self, p: dict) -> None:
        """投球を記録せず、打席の結果だけを入力する（記録漏れの打席・検証データ用）"""
        res = p.get("result")
        if res not in RESULT_META:
            raise RuleError(f"打席結果が読み取れません：{res}")
        pa = self._ensure_pa()
        pa["unrecorded"] = not p.get("pitches_recorded", False)
        if res == "strikeout_dropped":
            p = {**p, "how": p.get("how", "wp")}
        self._pa_outcome(res, p)

    # ------------------------------------------------------------ 打席結果
    def _pa_outcome(self, result: str, play: dict) -> None:
        pa = self._ensure_pa()
        meta = RESULT_META[result]
        cur_pitcher = self.teams[self.def_side].pitcher

        # 記録上の打者（2ストライク後の代打が三振 → 元の打者に三振を付ける）
        batter = pa["batter"]
        if result in ("strikeout", "strikeout_dropped") and pa.get("orig_batter") and pa.get("ph_strikes") == 2:
            batter = pa["orig_batter"]
        # 記録上の投手（ボール先行で交代した後の四球 → 前の投手に付ける）
        pitcher = cur_pitcher
        if result in ("walk", "ibb") and pa.get("prev_pitcher") and pa.get("change_count") in {
            (2, 0), (2, 1), (3, 0), (3, 1), (3, 2)
        }:
            pitcher = pa["prev_pitcher"]

        pos = play.get("pos")
        if pos is not None:
            pos = int(pos)
        fielders = play.get("fielders")
        fielders_unknown = bool(play.get("fielders_unknown"))

        # インフィールドフライの成立条件（一・二塁または満塁、2アウト未満）
        if result == "infield_fly":
            if self.outs >= 2 or not (self.bases[1] and self.bases[2]):
                raise RuleError("インフィールドフライは、無死か一死で一・二塁または満塁のときだけ宣告されます")
        # 振り逃げの成立条件（一塁が空いている、または2アウト）
        if result == "strikeout_dropped":
            if self.bases[1] is not None and self.outs < 2:
                raise RuleError("振り逃げはできません（一塁に走者がいて2アウト未満のときは、捕球できなくても打者アウト）")

        # 打者がアウトになるときの守備者（指定がなければ打球の種類から推定）
        if meta["batter"] == "out" and not fielders and not fielders_unknown:
            fielders = self._default_out_fielders(result, pos)

        batter_dest = play.get("batter_to")
        if batter_dest is None:
            batter_dest = meta["batter"]
        batter_dest = _norm_to(batter_dest)
        # 打者のアウトが確定する打席結果は、行き先を変えられない（三振・凡打・犠打など）
        if meta["batter"] == "out" and batter_dest != "out" and result != "sac_bunt":
            raise RuleError("この打席結果では打者はアウトです")

        how = play.get("how") or {
            "single": "hit", "double": "hit", "triple": "hit", "home_run": "hit",
            "reach_on_error": "error", "fielders_choice": "fc", "force_out": "fc",
            "strikeout_dropped": "wp", "walk": "force", "ibb": "force", "hbp": "force",
            "interference": "interference",
        }.get(result, "out")

        moves = list(play.get("moves") or [])
        bmove = next((m for m in moves if m.get("from") in ("B", "batter")), None)
        if bmove is not None and meta["batter"] == "out" and _norm_to(bmove.get("to")) != "out" \
                and result != "sac_bunt":
            raise RuleError("この打席結果では打者はアウトです（出塁した場合は失策・野選・振り逃げなどを選んでください）")
        # 指定のない走者は既定の進塁にする（画面側が全員分送れば上書きされる）
        explicit = {_norm_from(m.get("from")) for m in moves}
        for m in self.suggest_moves(result, pos, include_batter=False):
            if m["from"] not in explicit:
                moves.append(m)

        error_pos = play.get("error_pos") or (pos if result == "reach_on_error" else None)
        batter_spec = {
            "dest": batter_dest,
            "how": how,
            "fielders": fielders,
            "runs": meta["runs"],
            "result": result,
            "batter": batter,
            "pitcher": pitcher,
            "error_pos": error_pos if result in ("reach_on_error", "strikeout_dropped", "interference") else None,
        }
        if result == "interference":
            batter_spec["error_pos"] = 2
        summary = self._resolve(batter=batter_spec, moves=moves, result=result, rbi_override=play.get("rbi"))

        # サヨナラ安打は、決勝点の走者が進んだ塁数までしか記録しない（規則9.06(f)）
        wf = summary.get("walkoff_from")
        if wf not in (None, "B") and result in ("double", "triple"):
            credited = max(1, min(meta["hit"], 4 - int(wf)))
            if credited != meta["hit"]:
                result = {1: "single", 2: "double", 3: "triple"}[credited]
                meta = RESULT_META[result]

        # ---- 打席の成績
        b = self.bat[batter]
        b["PA"] += 1
        if meta["ab"]:
            b["AB"] += 1
        if meta["hit"]:
            b["H"] += 1
            b["TB"] += meta["hit"]
            b[{1: "1B", 2: "2B", 3: "3B", 4: "HR"}[meta["hit"]]] += 1
            self.pit[pitcher]["H"] += 1
            self.team_stats[self.bat_side]["H"] += 1
            if meta["hit"] == 4:
                self.pit[pitcher]["HR"] += 1
        if result in ("strikeout", "strikeout_dropped"):
            b["SO"] += 1
            self.pit[pitcher]["SO"] += 1
        if result == "walk":
            b["BB"] += 1
            self.pit[pitcher]["BB"] += 1
        if result == "ibb":
            b["BB"] += 1
            b["IBB"] += 1
            self.pit[pitcher]["BB"] += 1
            self.pit[pitcher]["IBB"] += 1
        if result == "hbp":
            b["HBP"] += 1
            self.pit[pitcher]["HBP"] += 1
        if result == "sac_bunt":
            b["SH"] += 1
        if result == "sac_fly":
            b["SF"] += 1
        if result == "reach_on_error":
            b["ROE"] += 1
        if result == "fielders_choice":
            b["FC"] += 1
        if meta["kind"] == "ground" and summary["outs"] >= 2 and batter_dest == "out" and result != "sac_bunt":
            b["GIDP"] += 1
        b["RBI"] += summary["rbi"]
        self.pit[pitcher]["BF"] += 1

        extra = {
            "looking": play.get("looking"),
            "error_pos": error_pos,
            "ground": play.get("ground"),
            "runner_fielders": summary.get("lead_out_fielders"),
        }
        label = play.get("label") or nt.pa_label(result, pos, extra)
        code = nt.score_code(result, pos, fielders, extra)
        seq = list(fielders) if fielders else []
        if summary["outs"] >= 2:
            # 併殺は守備の流れをつなげる（6-4 と 4-3 → 6-4-3）
            rf = summary.get("runner_out_fielders")
            if rf and fielders and batter_dest == "out" and meta["kind"] == "ground":
                seq = list(rf) + (list(fielders)[1:] if rf[-1] == fielders[0] else list(fielders))
            code += "併" if summary["outs"] == 2 else "三重"
        elif result == "force_out" and summary.get("lead_out_fielders"):
            seq = list(summary["lead_out_fielders"])
        seq_text = nt.fielding_seq(seq) if result not in ("strikeout",) else ""
        if summary["outs"] >= 2 and result not in ("strikeout",):
            label += "（併殺）" if summary["outs"] == 2 else "（三重殺）"
        elif result == "strikeout" and summary["outs"] >= 2:
            label += "（三振併殺）"
        self._finish_pa(result, {
            "batter": batter,
            "pitcher": pitcher,
            "label": label,
            "code": code,
            "pos": pos,
            "fielders": fielders,
            "seq": seq_text,
            "error_pos": error_pos if result in ("reach_on_error", "strikeout_dropped") else None,
            "looking": bool(play.get("looking")),
            "rbi": summary["rbi"],
            "runs": summary["runs"],
            "outs_on_play": summary["outs"],
            "outs_after": summary["outs_after"],
            "notes": play.get("notes", ""),
            "unconfirmed": bool(play.get("unconfirmed")),
        })
        self._after_play()

    def _default_out_fielders(self, result: str, pos: int | None) -> list[int] | None:
        """打者アウトの既定の守備者（遊ゴロ→6-3、一ゴロ→3A、三振→捕手）"""
        if result in ("strikeout",):
            return [2]
        if pos is None:
            return None
        if result in ("ground_out", "sac_bunt"):
            return [3] if pos == 3 else [pos, 3]
        if result in ("fly_out", "line_out", "foul_fly", "infield_fly", "sac_fly", "batter_out_other"):
            return [pos]
        return None

    # ------------------------------------------------------------ 既定の進塁
    def forced_bases(self) -> set[int]:
        """打者が走者になったとき、封殺状態になる塁"""
        forced = set()
        for b in (1, 2, 3):
            if self.bases[b] is not None and all(self.bases[x] is not None for x in range(1, b)):
                forced.add(b)
            else:
                break
        return forced

    def suggest_moves(self, result: str, pos: int | None = None, include_batter: bool = True) -> list[dict]:
        """打席結果に対する既定の走者の動き（画面で初期値として表示し、変更できる）"""
        meta = RESULT_META.get(result)
        if meta is None:
            raise RuleError(f"打席結果が読み取れません：{result}")
        forced = self.forced_bases() if meta["runs"] else set()
        moves: list[dict] = []
        if include_batter:
            moves.append({"from": "B", "to": meta["batter"]})
        lead_out_done = False
        for b in (3, 2, 1):
            if self.bases[b] is None:
                continue
            to: int | str = b
            how = "adv"
            if result in ("single", "double", "triple"):
                to = min(4, b + meta["hit"])
            elif result == "home_run":
                to = 4
            elif result in ("walk", "ibb", "hbp", "interference"):
                if b in forced:
                    to, how = b + 1, "force"
            elif result in ("ground_out", "reach_on_error", "fielders_choice", "strikeout_dropped"):
                if b in forced:
                    to = b + 1
            elif result == "force_out":
                # 併殺崩れ：一塁走者が二塁で封殺（一塁走者がいなければ一番後ろの封殺走者）
                lead = 1 if self.bases[1] is not None else None
                if b == lead and not lead_out_done:
                    to, how = "out", "force"
                    lead_out_done = True
                elif b in forced:
                    to = b + 1
            elif result == "sac_bunt":
                if b in forced or (b == 2 and self.bases[3] is None):
                    to = b + 1
            elif result == "sac_fly":
                if b == 3:
                    to, how = 4, "tagup"
            if to != b:
                m = {"from": b, "to": to, "how": how}
                if to == "out" and how == "force" and pos:
                    m["fielders"] = [pos, 4 if pos in (5, 6, 1, 2) else 6]
                moves.append(m)
        if result == "force_out" and not lead_out_done:
            raise RuleError("封殺できる走者がいません（一塁に走者がいるときに使えます）")
        return moves

    # ------------------------------------------------------------ 走塁のみ（盗塁・牽制・暴投など）
    def _ev_runner(self, p: dict) -> None:
        self._start_live()
        moves = p.get("moves") or []
        if not moves and not p.get("attempt"):
            raise RuleError("走者の動きを入力してください")
        if self.pa is None:
            # 打席が始まる前の走塁でも、打席の記録に結び付ける
            self._ensure_pa()
        elif self._cur_event:
            self.pa["event_ids"].append(self._cur_event.get("id"))
        self._last_pa_no = self.pa["no"]
        self._touch_stint()
        if not moves:
            # 牽制球（走者はセーフ）：記録として残すだけで状況は変わらない
            base = p.get("base")
            if base and self.bases.get(int(base)) is None:
                raise RuleError(f"{nt.BASE_JA.get(int(base), '')}に走者がいません")
            return
        hows = {m.get("how") for m in moves}
        if "bk" in hows:
            self.pit[self.teams[self.def_side].pitcher]["BK"] += 1
        self._resolve(batter=None, moves=moves, result=None)
        self._after_play()

    # ------------------------------------------------------------ プレーの解決（共通）
    def _resolve(self, *, batter: dict | None, moves: list[dict], result: str | None,
                 rbi_override: int | None = None) -> dict:
        """打者と走者の動きをまとめて反映し、アウト・得点・成績を更新する"""
        dside = self.def_side
        cur_pitcher = self.teams[dside].pitcher
        start_outs = self.outs

        parsed: dict[int | str, dict] = {}
        for m in moves:
            frm = _norm_from(m.get("from"))
            if frm in parsed:
                raise RuleError(f"{nt.BASE_JA.get(frm, '打者')}の走者の動きが2回入力されています")
            if frm != "B" and self.bases[frm] is None:
                raise RuleError(f"{nt.BASE_JA[frm]}に走者がいません")
            mm = dict(m)
            mm["from"] = frm
            mm["to"] = _norm_to(m.get("to"))
            how = mm.get("how") or "adv"
            if how not in RUNNER_HOWS:
                raise RuleError(f"走塁の理由が読み取れません：{how}")
            mm["how"] = how
            if frm != "B" and mm["to"] != "out" and mm["to"] < frm:
                raise RuleError(f"{nt.BASE_JA[frm]}の走者は前の塁へしか進めません")
            parsed[frm] = mm
        if "B" in parsed and batter is None:
            raise RuleError("打者の動きは打席結果として入力してください")

        # 打者
        entities: list[tuple[int | str, Runner, dict]] = []
        if batter is not None:
            bm = parsed.get("B") or {}
            dest = _norm_to(bm.get("to", batter["dest"]))
            unearned = batter["result"] in ("reach_on_error", "interference") or (
                batter["result"] == "strikeout_dropped" and batter.get("how") in ("pb", "error"))
            br = Runner(player_id=batter["batter"], pitcher_id=batter["pitcher"],
                        reached_by=batter["result"], unearned=unearned, pa_no=self.pa["no"] if self.pa else None)
            bspec = {"from": "B", "to": dest, "how": bm.get("how", batter["how"]),
                     "fielders": bm.get("fielders", batter.get("fielders")),
                     "fielders_unknown": bm.get("fielders_unknown"),
                     "error_pos": bm.get("error_pos", batter.get("error_pos")),
                     "rbi": bm.get("rbi"), "earned": bm.get("earned")}
            entities.append(("B", br, bspec))
        for b in (1, 2, 3):
            r = self.bases[b]
            if r is None:
                continue
            spec = parsed.get(b, {"from": b, "to": b, "how": "stay"})
            entities.append((b, r, spec))

        # 行き先の重複チェック
        dest_used: dict[int, str] = {}
        for frm, r, spec in entities:
            to = spec["to"]
            if to == "out" or to == 4:
                continue
            if to in dest_used:
                raise RuleError(f"{nt.BASE_JA[to]}に走者が2人います（{self.name(dest_used[to])}と{self.name(r.player_id)}）")
            dest_used[to] = r.player_id
        # 追い越しチェック（後ろの走者が前の走者より先の塁に行かない）
        order = sorted([e for e in entities if e[2]["to"] != "out"],
                       key=lambda e: 0 if e[0] == "B" else e[0])
        for i in range(len(order) - 1):
            back, front = order[i], order[i + 1]
            if back[2]["to"] != 4 and front[2]["to"] != 4 and back[2]["to"] >= front[2]["to"]:
                raise RuleError(f"{self.name(back[1].player_id)}が前の走者を追い越しています")
            if back[2]["to"] == 4 and front[2]["to"] != 4:
                raise RuleError(f"{self.name(back[1].player_id)}が前の走者を追い越して生還しています")

        outs_list = [e for e in entities if e[2]["to"] == "out"]
        runner_outs = sorted([e for e in outs_list if e[0] != "B"], key=lambda e: -e[0])
        n_outs = len(outs_list)
        if start_outs + n_outs > 3:
            raise RuleError(f"アウトが多すぎます（{start_outs}アウトから{n_outs}つのアウトは取れません）")

        # 得点の有効判定（3アウト目が打者・封殺・帰塁失敗なら同じプレーの得点は無効）
        third_out_blocks = False
        if start_outs + n_outs == 3:
            for frm, r, spec in outs_list:
                if frm == "B" or spec["how"] in NO_RUN_OUT_HOW:
                    third_out_blocks = True
        scorers = [e for e in entities if e[2]["to"] == 4]

        summary = {"outs": n_outs, "runs": 0, "rbi": 0, "outs_after": start_outs + n_outs,
                   "lead_out_fielders": None,
                   "runner_out_fielders": runner_outs[-1][2].get("fielders") if runner_outs else None}

        # 野選・封殺で前の走者が消えた場合、打者走者の責任投手を引き継ぐ（規則9.16(g)）
        if batter is not None and entities[0][2]["to"] != "out":
            prior_outs = [e for e in outs_list if e[0] != "B" and e[2]["how"] in ("force", "fc", "tag", "out", "adv")]
            if prior_outs:
                lead = max(prior_outs, key=lambda e: e[0])
                if lead[1].pitcher_id and lead[1].pitcher_id != entities[0][1].pitcher_id:
                    entities[0][1].pitcher_id = lead[1].pitcher_id
                summary["lead_out_fielders"] = lead[2].get("fielders")

        # ---- 守備・走塁の成績
        wp_counted = pb_counted = False
        catcher = self._fielder(2)
        if n_outs >= 2:
            # 併殺（三重殺）に関わった野手それぞれに併殺1を付ける
            involved = []
            for frm, r, spec in outs_list:
                if spec.get("fielders") and not spec.get("fielders_unknown"):
                    involved += [int(f) for f in spec["fielders"]]
            for n in dict.fromkeys(involved):
                self.fld[self._fielder(n)]["DP"] += 1
        for frm, r, spec in entities:
            how = spec["how"]
            if spec["to"] == "out":
                self.pit[cur_pitcher]["OUTS"] += 1
                self._credit_out(spec.get("fielders"), spec.get("fielders_unknown"))
                if frm == "B" and result == "strikeout" and not spec.get("fielders_unknown") \
                        and spec.get("fielders") and int(spec["fielders"][-1]) == 2:
                    self.fld[self._fielder(2)]["PO_K"] += 1   # 捕手の刺殺のうち三振によるもの
                if how == "cs":
                    self.bat[r.player_id]["CS"] += 1
                    self.fld[catcher]["CS_C"] += 1   # 捕手の盗塁刺
                continue
            if how == "sb" and spec["to"] != frm:
                self.bat[r.player_id]["SB"] += 1
                self.fld[catcher]["SB_A"] += 1   # 捕手の許盗塁
            if how == "wp" and not wp_counted and spec["to"] != frm:
                self.pit[cur_pitcher]["WP"] += 1
                wp_counted = True
            if how == "pb" and not pb_counted and spec["to"] != frm:
                self.fld[self._fielder(2)]["PB"] += 1
                pb_counted = True
        # 失策（1プレーで同じ野手の失策は1つとして数える）
        err_positions = []
        for frm, r, spec in entities:
            ep = spec.get("error_pos")
            if ep and (frm == "B" or spec["how"] == "error"):
                err_positions.append(int(ep))
        for ep in dict.fromkeys(err_positions):
            self.fld[self._fielder(ep)]["E"] += 1
            self.team_stats[dside]["E"] += 1

        # ---- 得点（前の塁の走者から順に）
        scorers.sort(key=lambda e: -1 if e[0] == "B" else e[0], reverse=True)
        reg = int(self.rules.get("innings") or 9)
        walkoff_cap = (self.half == "bottom" and self.inning >= reg and result != "home_run")
        for frm, r, spec in scorers:
            if third_out_blocks and not spec.get("run_counts"):
                continue
            if walkoff_cap and self.score("home") > self.score("away"):
                break  # サヨナラ：決勝点より後の走者の得点は認めない（本塁打を除く）
            earned, team_earned = self._earned(r, frm, spec, batter, result, start_outs, n_outs)
            if spec.get("earned") is not None:
                earned = team_earned = bool(spec["earned"])
            rbi = False
            if batter is not None:
                if spec.get("rbi") is not None:
                    rbi = bool(spec["rbi"])
                else:
                    rbi = self._auto_rbi(result, spec, frm, n_outs, batter)
            self._score_run(r, earned, rbi, batter["batter"] if (batter and rbi) else None, team_earned)
            summary["runs"] += 1
            if walkoff_cap and self.score("home") > self.score("away"):
                summary["walkoff_from"] = frm
            if rbi:
                summary["rbi"] += 1
        if rbi_override is not None and batter is not None:
            # 打点の手入力（記録員の判断）
            summary["rbi"] = int(rbi_override)
            for run in self.runs_log[-summary["runs"]:] if summary["runs"] else []:
                run["rbi_batter"] = batter["batter"] if summary["rbi"] else None

        # ---- スコアボードの判定ランプ
        if batter is not None and RESULT_META.get(result, {}).get("hit"):
            self._judge.append("H")
        if result == "fielders_choice" or any(sp["how"] == "fc" and sp["to"] != "out" for f, _r, sp in entities if f != "B"):
            self._judge.append("FC")
        if result in ("reach_on_error", "interference") or any(
                sp["how"] == "error" or (f == "B" and sp.get("error_pos")) for f, _r, sp in entities):
            self._judge.append("E")
        # ---- スコアブック用：走者ごとの進塁（どの塁からどこへ、何によって）とアウトの番号
        by = self.pa["order"] if self.pa else None
        out_seq = [e for e in entities if e[0] != "B" and e[2]["to"] == "out"] + \
                  [e for e in entities if e[0] == "B" and e[2]["to"] == "out"]
        out_no = {id(e[1]): start_outs + i + 1 for i, e in enumerate(out_seq)}
        for frm, r, spec in entities:
            if r.pa_no is None:
                continue
            start = 0 if frm == "B" else int(frm)
            to = spec["to"]
            if to == start:
                continue
            seg = {"from": start, "how": spec["how"], "by": by if frm != "B" else None, "inning": self.inning}
            if to == "out":
                seg.update({"to": min(start + 1, 4), "out": True, "out_no": out_no.get(id(r)),
                            "fielders": spec.get("fielders")})
            else:
                seg.update({"to": int(to), "out": False})
                if to == 4 and third_out_blocks and not spec.get("run_counts"):
                    seg["no_run"] = True
            self.paths[r.pa_no].append(seg)

        # ---- 失策などで進んだ塁数を走者ごとに積み上げる（後の得点の自責判定に使う）
        for frm, r, spec in entities:
            if spec["to"] in (1, 2, 3):
                r.err_bases += self._error_bases(frm, spec, batter, result)

        # ---- 塁の更新
        new_bases: dict[int, Runner | None] = {1: None, 2: None, 3: None}
        for frm, r, spec in entities:
            if spec["to"] in (1, 2, 3):
                new_bases[spec["to"]] = r
        self.bases = new_bases
        self.outs = start_outs + n_outs

        # 失策がなければアウトだった数（自責点用）
        if batter is not None and entities[0][1].unearned and entities[0][2]["to"] != "out":
            self.chances += 1
        return summary

    def _error_bases(self, frm: Any, spec: dict, batter: dict | None, result: str | None) -> int:
        """このプレーで、守備側のミス（失策・捕逸・走塁妨害）によって進んだ塁の数

        記録員の判断が要る部分は「投手に有利（＝自責点が少なくなる側）」に倒す（規則9.16(a)）
        """
        to = spec["to"]
        if to == "out":
            return 0
        start = 0 if frm == "B" else int(frm)
        gained = int(to) - start
        if gained <= 0:
            return 0
        if spec["how"] in ERROR_HOW:
            return gained
        if frm == "B" and batter is not None:
            meta = RESULT_META.get(batter["result"], {})
            base = meta.get("hit") or (1 if meta.get("batter") != "out" else 0)
            return max(0, gained - base)  # 安打の塁打数を超えた分は失策での進塁とみなす
        if result == "reach_on_error":
            # 失策で打者が出塁したプレーの走者：押し出された1つ分までは失策と無関係
            forced = 1 if spec["how"] == "force" or self._was_forced(frm) else 0
            return max(0, gained - forced)
        return 0

    def _was_forced(self, frm: Any) -> bool:
        return frm != "B" and int(frm) in self.forced_bases()

    def _earned(self, r: Runner, frm: Any, spec: dict, batter: dict | None, result: str | None,
                start_outs: int, n_outs: int) -> tuple[bool, bool]:
        """得点が自責点かどうか（公認野球規則9.16 日本の記録方式：得点した時点で判定）

        戻り値：(投手個人の自責点か, チームの自責点か)
        ・失策／打撃妨害／捕逸での振り逃げで出塁した走者の得点 → 自責点にしない
        ・失策がなければ3アウトだった後の得点 → 自責点にしない
        ・失策などで余分に進んだ走者 → ミスが無かった場合の塁から、このプレーで本塁まで届くときだけ自責点
        ・回の途中から登板した投手は、登板前の「失策がなければアウト」の恩恵を受けない（規則9.16(i)）
        """
        if r.unearned:
            return False, False
        # ミスが無かった場合にいたはずの塁（ゴースト）から、このプレーで本塁に届くか
        start = 0 if frm == "B" else int(frm)
        ghost = start - r.err_bases
        err_now = self._error_bases(frm, spec, batter, result) if spec["to"] != "out" else 0
        adv = (4 - start) - err_now
        if batter is not None and result in RESULT_META:
            hit = RESULT_META[result]["hit"]
            adv = max(adv, 4 if hit == 4 else hit)
        reach = ghost + adv >= 4
        team_ok = reach and (start_outs + self.chances + n_outs < 3)
        pitcher = r.pitcher_id
        cur = self.teams[self.def_side].pitcher
        if pitcher and pitcher == cur and pitcher in self.entry_chances:
            own_chances = self.chances - self.entry_chances[pitcher]
            pit_ok = reach and (start_outs + own_chances + n_outs < 3)
        else:
            pit_ok = team_ok
        return pit_ok, team_ok

    def _auto_rbi(self, result: str | None, spec: dict, frm: Any, n_outs: int, batter: dict) -> bool:
        """打点の自動判定（公認野球規則9.04の基本形 判断が要る場面は手入力で上書き）"""
        if result not in RBI_RESULTS:
            return False
        if spec["how"] in NO_RBI_HOW:
            return False
        if RESULT_META[result]["kind"] == "ground" and n_outs >= 2:
            return False  # 併殺の間の得点には打点を付けない
        if result in ("walk", "ibb", "hbp", "interference"):
            return spec["how"] == "force"
        return True

    def _credit_out(self, fielders: list[int] | None, unknown: bool | None) -> None:
        """刺殺・補殺を付ける（最後の野手が刺殺、それ以外が補殺）"""
        if not fielders or unknown:
            self.team_stats[self.def_side]["PO_UNKNOWN"] += 1
            return
        *assists, last = [int(f) for f in fielders]
        self.fld[self._fielder(last)]["PO"] += 1
        for a in dict.fromkeys(assists):
            if a != last:
                self.fld[self._fielder(a)]["A"] += 1

    def _score_run(self, r: Runner, earned: bool, rbi: bool, rbi_batter: str | None,
                   team_earned: bool | None = None) -> None:
        side = self.bat_side
        self.linescore[side][self.inning - 1] = (self.linescore[side][self.inning - 1] or 0) + 1
        self.bat[r.player_id]["R"] += 1
        if r.pitcher_id:
            self.pit[r.pitcher_id]["R"] += 1
            if earned:
                self.pit[r.pitcher_id]["ER"] += 1
        if team_earned if team_earned is not None else earned:
            self.team_stats[self.def_side]["ER"] += 1
        # セーブ・ホールドの判定用：守備側のリードが消えたか
        dside = self.def_side
        lead = self.score(dside) - self.score(side)
        st = self.open_stint[dside]
        if st is not None:
            st["runs_during"] += 1
            if lead <= 0:
                st["lead_lost"] = True
        if r.pitcher_id and (st is None or st["pid"] != r.pitcher_id):
            # 降板した投手が残した走者が還って、同点・逆転になった
            for old in self.stints:
                if old["pid"] == r.pitcher_id and old["side"] == dside and lead <= 0:
                    old["left_runner_blown"] = True
        self.runs_log.append({
            "side": side, "inning": self.inning, "half": self.half,
            "runner": r.player_id, "pitcher": r.pitcher_id, "earned": earned,
            "rbi_batter": rbi_batter if rbi else None,
            "score_after": {"away": self.score("away"), "home": self.score("home")},
            "def_pitcher": self.teams[self.def_side].pitcher,
            "event_id": (self._cur_event or {}).get("id"),
        })

    # ------------------------------------------------------------ 投手の登板記録（セーブ・ホールド用）
    def _touch_stint(self) -> None:
        """守備側の投手が、今の投手として登板記録を持っているか確認し、なければ作る"""
        dside = self.def_side
        pid = self.teams[dside].pitcher
        cur = self.open_stint[dside]
        if cur is not None and cur["pid"] == pid:
            return
        if cur is not None:
            self._close_stint(dside)
        st = {
            "pid": pid, "side": dside, "inning": self.inning,
            "lead_in": self.score(dside) - self.score(self.bat_side),
            "runners_in": sum(1 for b in self.bases.values() if b is not None),
            "outs_at": self.pit[pid]["OUTS"], "outs": 0,
            "runs_during": 0, "lead_lost": False, "left_runner_blown": False,
            "lead_out": None, "finished": False,
        }
        self.stints.append(st)
        self.open_stint[dside] = st

    def _close_stint(self, side: str, finished: bool = False) -> None:
        st = self.open_stint[side]
        if st is None:
            return
        st["outs"] = self.pit[st["pid"]]["OUTS"] - st["outs_at"]
        if side == self.def_side or "lead_last_def" not in st:
            st["lead_out"] = self.score(side) - self.score(other(side))
        else:
            st["lead_out"] = st["lead_last_def"]  # 攻撃中に交代が記録された場合は、最後に守っていた時点のリード
        st["finished"] = finished
        self.open_stint[side] = None

    # ------------------------------------------------------------ プレー後の処理
    def _after_play(self) -> None:
        reg = int(self.rules.get("innings") or 9)
        # サヨナラ
        if self.half == "bottom" and self.inning >= reg and self.score("home") > self.score("away"):
            self._end_game("walkoff")
            return
        if self.outs >= 3:
            self._end_half()

    def _end_half(self) -> None:
        reg = int(self.rules.get("innings") or 9)
        lob = sum(1 for r in self.bases.values() if r is not None)
        self.team_stats[self.bat_side]["LOB"] += lob
        st = self.open_stint[self.def_side]
        if st is not None:
            st["lead_last_def"] = self.score(self.def_side) - self.score(self.bat_side)
        # 打席途中に3アウト（盗塁死など）→ 打者は打席未完了のまま、次の回の先頭打者になる
        self.pa = None
        self.bases = {1: None, 2: None, 3: None}
        self.outs = 0
        self.balls = self.strikes = 0
        if self.half == "top":
            if self.inning >= reg and self.score("home") > self.score("away"):
                self.linescore["home"].append(None)  # 裏の攻撃なし（×）
                self._end_game("regulation")
                return
            self.half = "bottom"
        else:
            if self.inning >= reg and self.score("home") != self.score("away"):
                self._end_game("regulation")
                return
            self.half = "top"
            self.inning += 1
        self._start_half()

    def _ev_end(self, p: dict) -> None:
        if self.status == "pregame":
            raise RuleError("試合が始まっていません")
        reason = p.get("reason") or "called"
        if self.outs and self.outs < 3:
            lob = sum(1 for r in self.bases.values() if r is not None)
            self.team_stats[self.bat_side]["LOB"] += lob
        self.pa = None
        self._end_game(reason)

    def _end_game(self, reason: str) -> None:
        self.status = "final"
        self.final_reason = reason
        self.pa = None
        for side in ("away", "home"):
            self._close_stint(side, finished=True)
        self._compute_decisions()

    def _ev_decision(self, p: dict) -> None:
        """勝敗投手の手入力（記録員の判断で上書き）"""
        self.decision_override = {k: v for k, v in p.items() if k in ("win", "loss", "save")}
        if self.status == "final":
            self._compute_decisions()

    # ------------------------------------------------------------ 選手交代
    def _ev_sub(self, p: dict) -> None:
        kind = p.get("kind")
        side = p.get("side")
        if side not in ("away", "home"):
            raise RuleError("交代するチームを指定してください")
        t = self.teams[side]
        if not t.lineup_set:
            raise RuleError("スタメン登録の前に交代はできません")
        if kind == "bulk":
            self._sub_bulk(side, t, p)
            return
        new = p.get("in_player")
        if not new:
            raise RuleError("出場する選手を指定してください")
        if kind != "temp_runner" and new in t.removed and not self.rules.get("reentry"):
            raise RuleError(f"{self.name(new)}は一度退いているため再出場できません（試合設定で再出場がOFF）")
        # 野手から投手への変更（打順はそのまま）は認める
        if kind not in ("temp_runner", "position", "pitcher") and new in t.slots:
            raise RuleError(f"{self.name(new)}はすでに打順に入っています")

        def replace_slot(old: str, new_pid: str) -> None:
            self._replace_slot(t, old, new_pid)

        if kind == "pinch_hitter":
            if side != self.bat_side or self.status != "live":
                raise RuleError("代打は攻撃中のチームだけです")
            old, order = self.current_batter()
            replace_slot(old, new)
            if self.pa is not None:
                self.pa["orig_batter"] = self.pa["batter"]
                self.pa["ph_strikes"] = self.strikes
                self.pa["batter"] = new
        elif kind == "pinch_runner":
            base = int(p.get("base") or 0)
            if side != self.bat_side or base not in (1, 2, 3) or self.bases.get(base) is None:
                raise RuleError("代走を出す塁に走者がいません")
            r = self.bases[base]
            if r.player_id in t.slots:
                replace_slot(r.player_id, new)
            r.player_id = new
            r.temp_id = None
        elif kind == "temp_runner":
            if not self.rules.get("temp_runner"):
                raise RuleError("この試合は臨時代走なしの設定です")
            base = int(p.get("base") or 0)
            if side != self.bat_side or base not in (1, 2, 3) or self.bases.get(base) is None:
                raise RuleError("臨時代走を出す塁に走者がいません")
            self.bases[base].temp_id = new
        elif kind == "pitcher":
            old = t.pitcher
            if old == new:
                raise RuleError("同じ投手です")
            from_field = new in t.slots
            out_player = p.get("out_player")
            if from_field:
                # 野手が投手になる：打順はそのまま 元の守備位置は空く（守備位置の変更で埋める）
                if old not in t.slots:
                    t.removed.add(old)
            elif out_player and out_player in t.slots:
                replace_slot(out_player, new)
            elif old in t.slots and not p.get("keep_in_lineup"):
                replace_slot(old, new)
            else:
                if old not in t.slots:
                    t.removed.add(old)
                t.used.add(new)
            self._set_pitcher(side, t, new)
        elif kind in ("defense", "position"):
            pos = p.get("position")
            num = nt.POS_CODE.get(pos) if pos else None
            if kind == "defense":
                out_player = p.get("out_player")
                if out_player and out_player in t.slots:
                    replace_slot(out_player, new)
                else:
                    t.used.add(new)
            if num:
                if num == 1:
                    raise RuleError("投手の交代は「投手交代」で入力してください")
                for k, v in list(t.positions.items()):
                    if v == new:
                        del t.positions[k]
                t.positions[num] = new
        else:
            raise RuleError(f"交代の種類が読み取れません：{kind}")

    def _replace_slot(self, t: TeamState, old: str, new_pid: str) -> None:
        """打順の入れ替え（old が退いて new_pid がその打順に入る）"""
        if new_pid in t.removed and not self.rules.get("reentry"):
            raise RuleError(f"{self.name(new_pid)}は一度退いているため再出場できません（試合設定で再出場がOFF）")
        idx = t.slots.index(old)
        t.slots[idx] = new_pid
        t.slot_history.append((idx + 1, new_pid))
        t.removed.add(old)
        t.removed.discard(new_pid)
        t.used.add(new_pid)
        for k, v in list(t.positions.items()):
            if v == old:
                del t.positions[k]

    def _set_pitcher(self, side: str, t: TeamState, new: str) -> None:
        """投手を new にする（登板記録・打席途中の交代の扱いも更新）"""
        old = t.pitcher
        if old == new:
            return
        if self.open_stint[side] is not None and self.open_stint[side]["pid"] == old:
            self._close_stint(side)
        for k, v in list(t.positions.items()):
            if v == new:
                del t.positions[k]
        t.pitcher = new
        t.positions[1] = new
        t.used.add(new)
        if new not in t.pitchers_used:
            t.pitchers_used.append(new)
        if self.status == "live" and side == self.def_side:
            self.entry_chances[new] = self.chances
        if self.pa is not None and side == self.def_side:
            self.pa["prev_pitcher"] = self.pa["pitcher"]
            self.pa["change_count"] = (self.balls, self.strikes)
            self.pa["pitcher"] = new

    def _sub_bulk(self, side: str, t: TeamState, p: dict) -> None:
        """守備のまとめて変更（例：投手と二塁手と遊撃手の入れ替え、控え選手の途中出場を同時に）

        p = {"positions": {"P": 選手, "C": 選手, ...}, "order": {入る選手: 退く選手}}
        ・守備に就く選手は1人1か所
        ・控えから入る選手は、order で「誰の打順に入るか」を指定（退く選手は守備から外れる）
        """
        new_pos: dict[int, str] = {}
        seen: set[str] = set()
        for code, pid in (p.get("positions") or {}).items():
            if not pid or code == "DH":
                continue
            num = nt.POS_CODE.get(code)
            if num is None:
                raise RuleError(f"守備位置が読み取れません：{code}")
            if pid in seen:
                raise RuleError(f"{self.name(pid)}が2つの守備位置に入っています")
            seen.add(pid)
            new_pos[num] = pid
        if 1 not in new_pos:
            raise RuleError("投手を指定してください")
        # 控えから入る選手を打順に入れる
        for in_pid, out_pid in (p.get("order") or {}).items():
            if out_pid not in t.slots:
                raise RuleError(f"{self.name(out_pid)}は打順に入っていません")
            if in_pid in t.slots:
                raise RuleError(f"{self.name(in_pid)}はすでに打順に入っています")
            self._replace_slot(t, out_pid, in_pid)
        for num, pid in new_pos.items():
            if pid not in t.slots and not (num == 1 and self.rules.get("dh")):
                raise RuleError(f"{self.name(pid)}は打順に入っていません 誰と交代するか選んでください")
            if pid in t.removed and pid not in t.slots and not self.rules.get("reentry"):
                raise RuleError(f"{self.name(pid)}は一度退いているため再出場できません（試合設定で再出場がOFF）")
        old_pitcher = t.pitcher
        new_pitcher = new_pos[1]
        if new_pitcher != old_pitcher and old_pitcher not in t.slots:
            t.removed.add(old_pitcher)
        self._set_pitcher(side, t, new_pitcher)
        t.positions = dict(new_pos)
        for pid in new_pos.values():
            t.used.add(pid)

    # ------------------------------------------------------------ 勝敗投手
    def _compute_decisions(self) -> None:
        """勝利投手・敗戦投手（公認野球規則9.17の基本形）"""
        a, h = self.score("away"), self.score("home")
        self.decisions = {}
        if a == h:
            self.decisions = {"win": None, "loss": None, "note": "引き分け"}
            return
        win_side = "away" if a > h else "home"
        lose_side = other(win_side)
        # 勝ったチームが最後にリードを奪った得点（以後一度も追いつかれていない）
        go_ahead = None
        for run in self.runs_log:
            if run["side"] != win_side:
                continue
            s = run["score_after"]
            if s[win_side] == s[lose_side] + 1:
                go_ahead = run
        note = []
        loss = go_ahead["pitcher"] if go_ahead else None
        # 勝利投手：リードを奪った時点で勝ったチームの投手（その時点で投げていた／直前まで投げていた投手）
        win = self._pitcher_of_record(win_side, go_ahead) if go_ahead else None
        starter = self.teams[win_side].pitchers_used[0] if self.teams[win_side].pitchers_used else None
        if win and win == starter and len(self.teams[win_side].pitchers_used) > 1:
            need = self.rules.get("starter_min_outs")
            if not need:
                def_innings = self._defense_outs(win_side) / 3
                need = 15 if def_innings >= 6 else 12
            if self.pit[starter]["OUTS"] < need:
                relievers = self.teams[win_side].pitchers_used[1:]
                win = max(relievers, key=lambda pid: self.pit[pid]["OUTS"])
                note.append(f"先発が規定（{need // 3}回）未満のため、救援投手で最も長く投げた投手を勝利投手にしています（記録員の判断で変更可）")
        self.decisions = {"win": win, "loss": loss, "note": " ".join(note)}
        self.decisions["save"] = self._save_pitcher(win_side, win)
        self.decisions["holds"] = self._hold_pitchers(win, loss, self.decisions["save"])
        if self.decision_override:
            self.decisions.update(self.decision_override)
            self.decisions["note"] = "手入力で指定"

    @staticmethod
    def _save_situation(st: dict) -> bool:
        """登板時にセーブがつく条件の場面か（規則9.19 (c)(1)(2)／(3)は投球回で別判定）"""
        lead = st["lead_in"]
        return lead > 0 and (lead <= 3 or lead <= st["runners_in"] + 2)

    def _save_pitcher(self, win_side: str, win: str | None) -> str | None:
        """セーブ（公認野球規則9.19）：勝ったチームの最後の投手で、勝利投手でなく、条件を満たす"""
        team_stints = [s for s in self.stints if s["side"] == win_side]
        if len(team_stints) < 2:
            return None
        last = team_stints[-1]
        if last["pid"] == win or not last["finished"] or last["lead_lost"] or last["lead_in"] <= 0:
            return None
        lead = last["lead_in"]
        ok = (lead <= 3 and last["outs"] >= 3) or (lead <= last["runners_in"] + 2) or last["outs"] >= 9
        return last["pid"] if ok else None

    def _hold_pitchers(self, win: str | None, loss: str | None, save: str | None) -> list[str]:
        """ホールド（NPBの記録規定）：勝敗・セーブがつかない救援投手のうち
        (1) セーブがつく場面で登板し、1アウト以上取り、リードを保って降板
        (2) 同点で登板し、1アウト以上取り、残した走者も含め無失点で降板（自チームが勝ち越していれば失点してもよい）
        """
        holds: list[str] = []
        firsts = {}
        for st in self.stints:
            firsts.setdefault(st["side"], st["pid"])
        for st in self.stints:
            pid = st["pid"]
            if pid in (win, loss, save) or pid == firsts.get(st["side"]) or st["finished"]:
                continue
            if st["outs"] < 1 or st["lead_out"] is None:
                continue
            ok = False
            if self._save_situation(st) and not st["lead_lost"] and st["lead_out"] > 0:
                ok = True
            elif st["lead_in"] == 0 and not st["left_runner_blown"]:
                ok = st["runs_during"] == 0 or (st["lead_out"] > 0 and not st["lead_lost"])
                ok = ok and st["lead_out"] >= 0
            if ok and pid not in holds:
                holds.append(pid)
        return holds

    def _defense_outs(self, side: str) -> int:
        return sum(self.pit[pid]["OUTS"] for pid in self.teams[side].pitchers_used)

    def _pitcher_of_record(self, side: str, run: dict) -> str | None:
        """ある得点の時点で、そのチームの記録上の投手（直近に守備で投げていた投手）"""
        # 得点時に side は攻撃中 → その直前の守備イニングの最後の投手
        # runs_log には守備側投手しかないため、event_log の pitcher 履歴から復元する
        hist = self._pitcher_history.get(side, []) if hasattr(self, "_pitcher_history") else []
        last = None
        for idx, pid in hist:
            if idx <= self._event_index(run["event_id"]):
                last = pid
        return last or (self.teams[side].pitchers_used[0] if self.teams[side].pitchers_used else None)

    def _event_index(self, event_id: Any) -> int:
        for i, e in enumerate(self.event_log):
            if e["id"] == event_id:
                return i
        return len(self.event_log)

    # ------------------------------------------------------------ 説明文
    def _describe(self, typ: str, p: dict, before: dict) -> str:
        head = f"{before['inning']}回{'表' if before['half'] == 'top' else '裏'}"
        if typ == "lineup":
            return f"スタメン登録（{'先攻' if p.get('side') == 'away' else '後攻'}）"
        if typ == "pitch":
            s = nt.PITCH_LABEL.get(p.get("result"), "投球")
            last = self.pa_log[-1] if self.pa_log and self.pa is None else None
            if last and last.get("event_ids") and last["event_ids"][-1] == (self._cur_event or {}).get("id"):
                s += f" → {last['label']}" + (f"（{last['seq']}）" if last.get("seq") else "")
            if p.get("runners"):
                s += "／" + self._moves_text(p["runners"])
            return f"{head} {s}"
        if typ == "pa_result":
            last = self.pa_log[-1] if self.pa_log else None
            who = f"{last['order']}番 {self.name(last['batter'])}" if last else ""
            seq = f"（{last['seq']}）" if last and last.get("seq") else ""
            return f"{head} {who}：{last['label'] if last else ''}{seq}"
        if typ == "runner":
            if not p.get("moves") and p.get("attempt"):
                return f"{head} 牽制（{nt.BASE_JA.get(int(p.get('base') or 1), '')}走者セーフ）"
            return f"{head} {self._moves_text(p.get('moves') or [])}"
        if typ == "sub":
            kind = {"pinch_hitter": "代打", "pinch_runner": "代走", "temp_runner": "臨時代走",
                    "pitcher": "投手交代", "defense": "守備交代", "position": "守備位置変更"}.get(p.get("kind"), "交代")
            if p.get("kind") == "bulk":
                parts = [f"{nt.POS_JA.get(nt.POS_CODE.get(c), c)}：{self.name(pid)}"
                         for c, pid in (p.get("changes") or {}).items()]
                return f"{head} 守備変更（{'、'.join(parts) or 'まとめて'}）"
            return f"{head} {kind}：{self.name(p.get('in_player'))}"
        if typ == "end":
            return "試合終了"
        if typ == "decision":
            return "勝敗投手を手入力"
        return typ

    def _moves_text(self, moves: list[dict]) -> str:
        parts = []
        for m in moves:
            frm = m.get("from")
            to = m.get("to")
            how = nt.HOW_LABEL.get(m.get("how") or "adv", "")
            fb = nt.BASE_JA.get(int(frm), "") if frm not in ("B", None) else "打者"
            tb = "アウト" if to == "out" else nt.BASE_JA.get(_norm_to(to), "") + ("へ" if _norm_to(to) != 4 else "生還")
            parts.append(f"{fb}走者{how}（{tb}）".replace("本塁生還", "生還"))
        return "、".join(parts)


# ============================================================ 再生（訂正・取消の反映）
def effective_events(raw: list[dict]) -> list[dict]:
    """取消・訂正・挿入を反映した「実際に有効なイベント列」を返す

    raw は seq 順のイベント（取消・訂正も含む全履歴）
      void    {"target": id}                 … 対象を取り消す（取消の取消＝復活）
      correct {"target": id, "event": {...}} … 対象の中身を差し替える
      insert  {"before": id, "event": {...}} … 対象の直前に記録漏れを追加する
    """
    voided: set = set()
    replaced: dict = {}
    inserted: dict = defaultdict(list)
    by_id = {e["id"]: e for e in raw}
    base: list[dict] = []
    for e in raw:
        typ = e["type"]
        p = e.get("payload") or {}
        if typ == "void":
            tgt = p.get("target")
            tgt_ev = by_id.get(tgt)
            if tgt_ev and tgt_ev["type"] == "void":
                voided.discard((tgt_ev.get("payload") or {}).get("target"))
            else:
                voided.add(tgt)
        elif typ == "correct":
            replaced[p.get("target")] = e
        elif typ == "insert":
            inserted[p.get("before")].append(e)
        else:
            base.append(e)

    def materialize(e: dict) -> dict | None:
        if e["id"] in voided:
            return None
        if e["id"] in replaced:
            c = replaced[e["id"]]
            body = (c.get("payload") or {}).get("event") or {}
            return {**e, "type": body.get("type", e["type"]), "payload": body.get("payload", {}),
                    "corrected_by": c["id"], "meta": {**(e.get("meta") or {}), **(body.get("meta") or {})}}
        return e

    out: list[dict] = []
    for e in base:
        for ins in inserted.get(e["id"], []):
            if ins["id"] in voided:
                continue
            body = (ins.get("payload") or {}).get("event") or {}
            out.append(materialize({**ins, "type": body.get("type"), "payload": body.get("payload", {}),
                                    "meta": body.get("meta") or {}}) or {})
        m = materialize(e)
        if m is not None:
            out.append(m)
    return [e for e in out if e]


def replay(raw_events: list[dict], rules: dict | None = None, roster: dict | None = None,
           stop_before: Any = None) -> tuple[Game, dict | None]:
    """全イベントを先頭から再生する

    戻り値：(試合状態, 停止情報) 停止情報は途中で矛盾が起きたときだけ
    stop_before を指定すると、そのイベントの直前の状態で止める（訂正画面用）
    """
    g = Game(rules, roster)
    g._pitcher_history = {"away": [], "home": []}
    halted = None
    evs = effective_events(raw_events)
    for i, ev in enumerate(evs):
        if stop_before is not None and ev["id"] == stop_before:
            break
        try:
            prev_p = {s: g.teams[s].pitcher for s in ("away", "home")}
            g.apply(ev)
            for s in ("away", "home"):
                if g.teams[s].pitcher and g.teams[s].pitcher != prev_p[s]:
                    g._pitcher_history[s].append((len(g.event_log) - 1, g.teams[s].pitcher))
        except RuleError as exc:
            halted = {
                "event_id": ev["id"],
                "message": str(exc),
                "pending": [e["id"] for e in evs[i:]],
            }
            break
    if g.status == "final":
        g._compute_decisions()
    return g, halted
