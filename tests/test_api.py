"""APIの通しテスト（DB保存・取消・訂正・入力ロック・閲覧）"""
import os
import tempfile

import pytest

os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or ("sqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db"))
os.environ.pop("ADMIN_PASSCODE", None)
os.environ["ENABLE_FIXTURE"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

POS = ["CF", "SS", "2B", "1B", "3B", "LF", "RF", "C", "P"]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _team(c, name):
    t = c.post("/api/teams", json={"name": name, "short_name": name[:2]}).json()
    pids = [c.post(f"/api/teams/{t['id']}/players", json={"name": f"{name}{i}", "number": str(i)}).json()["id"]
            for i in range(1, 12)]
    return t["id"], pids


@pytest.fixture(scope="module")
def game(client):
    a, ap = _team(client, "赤")
    h, hp = _team(client, "青")
    g = client.post("/api/games", json={"date": "2026-10-25", "away_team_id": a, "home_team_id": h}).json()
    tok = g["edit_token"]
    for side, pids in (("away", ap), ("home", hp)):
        r = client.post(f"/api/edit/{tok}/events", json={
            "type": "lineup", "client_id": "devA", "author": "しん",
            "payload": {"side": side, "slots": [{"player_id": pids[i], "position": POS[i]} for i in range(9)]}})
        assert r.status_code == 200, r.json()
    return {"tok": tok, "view": g["view_token"], "ap": ap, "hp": hp}


def ev(client, tok, typ, payload, cid="devA", **kw):
    return client.post(f"/api/edit/{tok}/events", json={"type": typ, "payload": payload, "client_id": cid,
                                                         "author": "しん", **kw})


def test_pitch_flow_and_view(client, game):
    tok = game["tok"]
    for r in ("ball", "called_strike", "foul"):
        assert ev(client, tok, "pitch", {"result": r}).status_code == 200
    v = ev(client, tok, "pitch", {"result": "in_play", "play": {"result": "single", "pos": 8}}).json()
    assert v["bases"]["1"]["id"] == game["ap"][0]
    assert v["batter"]["order"] == 2
    view = client.get(f"/api/view/{game['view']}").json()
    assert view["mode"] == "view" and view["bases"]["1"]["name"] == "赤1"
    again = client.get(f"/api/view/{game['view']}", params={"since": view["game"]["version"]}).json()
    assert again["unchanged"] is True


def test_rule_error_is_not_saved(client, game):
    tok = game["tok"]
    before = client.get(f"/api/edit/{tok}").json()["game"]["version"]
    r = ev(client, tok, "runner", {"moves": [{"from": 3, "to": 4, "how": "wp"}]})
    assert r.status_code == 422 and "三塁に走者がいません" in r.json()["message"]
    assert client.get(f"/api/edit/{tok}").json()["game"]["version"] == before


def test_lock_blocks_other_device_until_takeover(client, game):
    tok = game["tok"]
    r = ev(client, tok, "pitch", {"result": "ball"}, cid="devB")
    assert r.status_code == 423
    assert client.post(f"/api/edit/{tok}/lock", json={"client_id": "devB", "name": "代理", "takeover": True}).json()["ok"]
    assert ev(client, tok, "pitch", {"result": "ball"}, cid="devB").status_code == 200
    assert client.post(f"/api/edit/{tok}/lock", json={"client_id": "devA", "takeover": True}).json()["ok"]


def test_version_conflict(client, game):
    tok = game["tok"]
    r = ev(client, tok, "pitch", {"result": "ball"}, expected_version=1)
    assert r.status_code == 409


def test_undo_and_correct(client, game):
    tok = game["tok"]
    v = client.get(f"/api/edit/{tok}").json()
    balls = v["balls"]
    v = client.post(f"/api/edit/{tok}/undo", json={"client_id": "devA"}).json()
    assert v["balls"] == balls - 1
    # 1打席目の単打を二塁打に訂正 → 走者が二塁に
    single = next(e for e in v["events"] if e["type"] == "pitch" and "打球" in (e["desc"] or ""))
    v = ev(client, tok, "correct", {"target": single["id"], "event": {
        "type": "pitch", "payload": {"result": "in_play", "play": {"result": "double", "pos": 8}}}}).json()
    assert v["bases"]["2"]["id"] == game["ap"][0] and v["bases"]["1"] is None
    assert v["fix_count"] == 2


def test_suggest_moves(client, game):
    tok = game["tok"]
    r = client.post(f"/api/edit/{tok}/suggest", json={"result": "single", "pos": 7}).json()
    assert {"from": 2, "to": 3, "how": "adv"} in r["moves"]


def test_import_fixture_and_player_stats(client):
    r = client.post("/api/admin/import-fixture").json()
    v = client.get(f"/api/view/{r['view_token']}").json()
    assert v["status"] == "final"
    assert v["rhe"]["away"]["R"] == 2 and v["rhe"]["home"]["R"] == 6
    games = client.get("/api/games").json()
    assert any(g["summary"].get("home") == 6 for g in games)
    pid = v["box"]["home"]["batting"][2]["id"]  # EDOSEN 3番
    st = client.get(f"/api/players/{pid}/stats").json()
    assert st["career"]["batting"]["RBI"] == 3 and st["career"]["batting"]["HR"] == 1


def test_export(client, game):
    r = client.get(f"/api/edit/{game['tok']}/export")
    assert r.status_code == 200 and r.json()["format"] == "baseball-score-backup/1"


def test_pages_served(client, game):
    for path in ("/", "/teams", "/new", f"/e/{game['tok']}", f"/g/{game['view']}"):
        assert client.get(path).status_code == 200


def test_team_requires_short_name(client):
    r = client.post("/api/teams", json={"name": "略称なし"})
    assert r.status_code == 422


def test_delete_game_and_team(client):
    a, _ = _team(client, "消す赤")
    h, _ = _team(client, "消す青")
    g = client.post("/api/games", json={"date": "2026-11-01", "away_team_id": a, "home_team_id": h}).json()
    assert client.delete(f"/api/teams/{a}").status_code == 409   # 試合が残っている
    assert client.delete(f"/api/edit/{g['edit_token']}").status_code == 200
    assert client.get(f"/api/view/{g['view_token']}").status_code == 404
    assert client.delete(f"/api/teams/{a}").status_code == 200


def test_fixture_teams_removed_with_game(client):
    r = client.post("/api/admin/import-fixture").json()
    v = client.get(f"/api/edit/{r['edit_token']}").json()
    tid = v["game"]["away_team"]["id"]
    client.delete(f"/api/edit/{r['edit_token']}")
    assert client.get(f"/api/teams/{tid}").status_code == 404


def test_event_history_has_pitch_numbers_and_names(client, game):
    v = client.get(f"/api/edit/{game['tok']}").json()
    pitches = [e for e in v["events"] if e["type"] == "pitch"]
    assert pitches[0]["pitch_no"] == 1 and pitches[0]["pa_no"] == 1
    assert "batter_name" in pitches[0]["after"]
