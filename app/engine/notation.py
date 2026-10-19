"""表示用の文言・スコア記号

入力画面の言葉（一ゴロ など）と、スコア表示の記号（3A など）をここで作る
記録の計算には使わない（計算は core.py が担当）
"""
from __future__ import annotations

# 守備位置の番号と漢字1文字
POS_JA = {1: "投", 2: "捕", 3: "一", 4: "二", 5: "三", 6: "遊", 7: "左", 8: "中", 9: "右"}
# 守備位置コード（画面・DB用）と番号
POS_CODE = {"P": 1, "C": 2, "1B": 3, "2B": 4, "3B": 5, "SS": 6, "LF": 7, "CF": 8, "RF": 9}
POS_NAME = {1: "投手", 2: "捕手", 3: "一塁手", 4: "二塁手", 5: "三塁手", 6: "遊撃手", 7: "左翼手", 8: "中堅手", 9: "右翼手"}

PITCH_LABEL = {
    "ball": "ボール",
    "called_strike": "見逃し",
    "swinging_strike": "空振り",
    "foul": "ファウル",
    "foul_bunt": "バントファウル",
    "foul_tip": "ファウルチップ",
    "hbp": "死球",
    "in_play": "打球",
    "unknown": "投球（内容不明）",
}

HOW_LABEL = {
    "sb": "盗塁",
    "cs": "盗塁死",
    "wp": "暴投",
    "pb": "捕逸",
    "bk": "ボーク",
    "po": "牽制死",
    "error": "失策",
    "adv": "進塁",
    "force": "封殺",
    "tag": "タッチアウト",
    "doubled_off": "帰塁できずアウト",
    "tagup": "タッチアップ",
    "fc": "野選",
    "hit": "安打",
    "obstruction": "走塁妨害",
    "interference": "守備妨害",
    "other": "その他",
}

BASE_JA = {1: "一塁", 2: "二塁", 3: "三塁", 4: "本塁"}


def _seq(fielders: list[int] | None) -> str:
    """守備番号の並び（6-3 など）を作る 1人だけなら 3A のように A を付ける"""
    if not fielders:
        return ""
    if len(fielders) == 1:
        return f"{fielders[0]}A"
    return "-".join(str(f) for f in fielders)


def pa_label(result: str, pos: int | None, extra: dict | None = None) -> str:
    """入力画面・速報で使う結果の文言（一ゴロ、左前安打 など）"""
    extra = extra or {}
    p = POS_JA.get(pos or 0, "")
    infield = (pos or 0) in (1, 2, 3, 4, 5, 6)
    if result == "single":
        return f"{p}安打" if infield else f"{p}前安打" if p else "安打"
    if result == "double":
        return f"{p}二塁打" if p else "二塁打"
    if result == "triple":
        return f"{p}三塁打" if p else "三塁打"
    if result == "home_run":
        return f"{p}本塁打" if p else "本塁打"
    if result == "ground_out":
        return f"{p}ゴロ" if p else "ゴロ"
    if result == "fly_out":
        return f"{p}飛" if p else "飛球"
    if result == "line_out":
        return f"{p}直" if p else "ライナー"
    if result == "foul_fly":
        return f"{p}邪飛" if p else "邪飛"
    if result == "infield_fly":
        return f"{p}飛（インフィールドフライ）" if p else "インフィールドフライ"
    if result == "sac_bunt":
        return f"{p}犠打" if p else "犠打"
    if result == "sac_fly":
        return f"{p}犠飛" if p else "犠飛"
    if result == "reach_on_error":
        return f"{p}ゴロ失策" if extra.get("ground") and p else f"{p}失" if p else "失策"
    if result == "fielders_choice":
        return f"{p}野選" if p else "野選"
    if result == "force_out":
        return f"{p}ゴロ（併殺崩れ）" if p else "封殺の間に出塁"
    if result == "strikeout":
        return "見逃し三振" if extra.get("looking") else "三振"
    if result == "strikeout_dropped":
        return "振り逃げ"
    if result == "walk":
        return "四球"
    if result == "ibb":
        return "申告敬遠"
    if result == "hbp":
        return "死球"
    if result == "interference":
        return "打撃妨害"
    if result == "batter_out_other":
        return "アウト（その他）"
    return result


def score_code(result: str, pos: int | None, fielders: list[int] | None, extra: dict | None = None) -> str:
    """スコア表示用の記号（日本語の略記 ゴロは 6-3、単独刺殺は 3A）"""
    extra = extra or {}
    p = POS_JA.get(pos or 0, "")
    if result in ("single", "double", "triple", "home_run"):
        mark = {"single": "安", "double": "2", "triple": "3", "home_run": "本"}[result]
        return f"{p}{mark}"
    if result == "ground_out":
        return _seq(fielders) or f"{p}ゴ"
    if result == "fly_out":
        return f"{p}飛"
    if result == "line_out":
        return f"{p}直"
    if result == "foul_fly":
        return f"{p}邪飛"
    if result == "infield_fly":
        return f"{p}飛(IF)"
    if result == "sac_bunt":
        return f"犠{_seq(fielders) or p}"
    if result == "sac_fly":
        return f"{p}犠飛"
    if result == "reach_on_error":
        return f"{POS_JA.get(extra.get('error_pos') or pos or 0, '')}失"
    if result == "fielders_choice":
        return f"{p}野選"
    if result == "force_out":
        return f"({_seq(extra.get('runner_fielders')) or p})"
    if result == "strikeout":
        return "見三振" if extra.get("looking") else "三振"
    if result == "strikeout_dropped":
        return "振逃"
    if result == "walk":
        return "四球"
    if result == "ibb":
        return "敬遠"
    if result == "hbp":
        return "死球"
    if result == "interference":
        return "打妨"
    return "?"
