# 野球スコア β

スマホ（iPhoneのSafari）で、1球ごとに試合を記録するWebアプリ
記録から打撃・投手・守備の成績とスコア表を自動で作る

## 構成

| 部分 | 中身 |
|---|---|
| `app/engine/` | 記録エンジン（アウト・走者・得点・打順・成績の計算）DBにも画面にも依存しない |
| `app/main.py` | Webサーバー（FastAPI）と画面用のデータ出入り口 |
| `app/db.py` | DBの表の定義 正本は `game_events`（1球・1プレーごとの記録） |
| `app/static/` | 画面（HTML・CSS・JavaScript） |
| `fixtures/` | 検証試合（2026-10-18 Nexus Tokyo 2－6 EDOSEN）の資料と入力データ |
| `tests/` | 自動テスト（検証試合の照合・特殊プレー・API） |

## 手元で動かす

```
pip install -r requirements-dev.txt
python -m pytest -q          # 自動テスト
uvicorn app.main:app --reload  # http://localhost:8000
```

## 公開（無料）

Render（アプリ本体）＋ Neon（DB）＋ GitHub（プログラムの置き場）

1. Neon で無料プロジェクトを作り、接続文字列（`postgresql://...`）を控える 地域はシンガポール推奨
2. このフォルダを GitHub のリポジトリに置く
3. Render で「New → Blueprint」からリポジトリを選ぶ（`render.yaml` を読み込む）
4. 環境変数を入れる
   - `DATABASE_URL`：Neon の接続文字列
   - `ADMIN_PASSCODE`：チーム登録・試合作成に使う合言葉（好きな文字列）
5. 公開URL（`https://〜.onrender.com`）を iPhone の Safari で開く

無料プランの注意
- Render は15分アクセスがないと休止し、次に開くとき起動に約1分かかる（試合中は閲覧画面の自動更新で休止しない）
- Neon の無料枠は1GB 放置してもデータは消えない

## 記録の考え方

- 1球・1プレー・交代を「イベント」として順番に積み、毎回先頭から再生して状態と成績を計算する
- 取消・訂正・記録漏れの追加も、元の記録を消さずに新しいイベントとして積む
- 訂正の結果、後のプレーと矛盾が出たら、その地点で計算を止めて「要確認」と表示する
- 判断が要る記録（打点・自責点・勝敗投手）は自動判定 打点は画面から手入力で上書きできる（自責点・勝敗投手の手入力画面はβ版では未実装）
