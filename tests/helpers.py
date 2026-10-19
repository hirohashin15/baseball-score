"""架空試合を組み立てるテスト用の道具"""
from __future__ import annotations

from app.engine.core import replay

POSITIONS = ["CF", "SS", "2B", "1B", "3B", "LF", "RF", "C", "DH"]


def roster() -> dict:
    r = {}
    for side, pre in (("away", "A"), ("home", "H")):
        for i in range(1, 10):
            r[f"{pre}{i}"] = {"name": f"{pre}{i}", "team": side}
        for i in range(1, 6):
            r[f"{pre}P{i}"] = {"name": f"{pre}投{i}", "team": side}
            r[f"{pre}S{i}"] = {"name": f"{pre}控{i}", "team": side}
    return r


class G:
    """イベントを積んで、その都度再生できる"""

    def __init__(self, rules: dict | None = None):
        self.rules = rules or {}
        self.events: list[dict] = []
        self.lineup("away", "A")
        self.lineup("home", "H")

    def add(self, typ: str, payload: dict) -> str:
        eid = f"x{len(self.events) + 1}"
        self.events.append({"id": eid, "seq": len(self.events) + 1, "type": typ, "payload": payload})
        return eid

    def lineup(self, side: str, pre: str) -> None:
        self.add("lineup", {"side": side, "pitcher_id": f"{pre}P1",
                            "slots": [{"player_id": f"{pre}{i}", "position": POSITIONS[i - 1]} for i in range(1, 10)]})

    def pa(self, result: str, pos: int | None = None, **kw) -> str:
        return self.add("pa_result", {"result": result, "pos": pos, **kw})

    def pitch(self, result: str, **kw) -> str:
        return self.add("pitch", {"result": result, **kw})

    def runner(self, moves: list[dict]) -> str:
        return self.add("runner", {"moves": moves})

    def sub(self, **kw) -> str:
        return self.add("sub", kw)

    def three_outs(self) -> None:
        for _ in range(3):
            self.pa("strikeout")

    def run(self):
        g, halted = replay(self.events, self.rules, roster())
        return g, halted

    def ok(self):
        g, halted = self.run()
        assert halted is None, halted
        return g
