# -*- coding: utf-8 -*-
"""SIMMONS IG — Apify Instagram Scraper 로 공식 계정 최신 게시물을 가져온다.

★★ 토큰은 코드에 적지 않는다. 환경변수 APIFY_TOKEN 에서만 읽는다.
  (로컬은 .env, 배포는 Vercel 환경변수 / GitHub Secrets)
  토큰이 없으면 status='no_key' 를 돌려주고, 화면은 그대로 뜬다 — 빌드가 깨지지 않는다.
★★ 값을 지어내지 않는다. 호출이 실패하면 실패했다고 그대로 알린다.

크레딧 절약(Case 로직) — refresh_cache() 참고:
  캐시의 첫 게시물 id 와 새로 받아온 첫 게시물 id 가 같으면 '변경 없음'으로 보고
  캐시 파일을 다시 쓰지 않는다(changed=False). 다르면 새로 쓴다.

★ 캐시 파일은 public/data/instagram.json 이다. Vercel 서버리스는 파일시스템이
  읽기 전용(/tmp 만 쓸 수 있고 그마저도 인스턴스가 죽으면 사라진다)이라,
  '실제로 남는' 캐시는 GitHub Actions(collect-instagram.yml)가 이 파일을 커밋해서 만든다.
  서버리스 함수는 그 파일을 읽어 주고, ?refresh=1 일 때만 Apify 를 부른다.

Apify: https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items
"""
import datetime
import io
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler

import requests

ACTOR = "apify~instagram-scraper"
BASE = "https://api.apify.com/v2/acts/%s/run-sync-get-dataset-items" % ACTOR

ENV_TOKEN = "APIFY_TOKEN"
ENV_USER = "INSTAGRAM_USERNAME"
DEFAULT_USER = "simmonskorea"

POST_LIMIT = 4        # 화면에 띄울 게시물 수 (= Apify resultsLimit)
CAPTION_MAX = 60      # 캡션은 앞부분만 저장한다
CAPTION_TAIL = "..."
TIMEOUT = 120         # run-sync 는 스크레이핑이 끝날 때까지 기다린다(수십 초)

CACHE_REL = os.path.join("public", "data", "instagram.json")


def _repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cache_path():
    return os.path.join(_repo_root(), CACHE_REL)


def _load_dotenv():
    """로컬 개발용 .env 를 환경변수로 올린다(이미 있는 값은 덮어쓰지 않는다).
    의존성을 늘리지 않으려고 직접 읽는다. 파일이 없으면 조용히 넘어간다."""
    p = os.path.join(_repo_root(), ".env")
    if not os.path.isfile(p):
        return
    try:
        for line in io.open(p, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("\"").strip("'"))
    except Exception:  # noqa: BLE001 — .env 가 깨졌다고 수집을 막지 않는다
        pass


def _token():
    _load_dotenv()
    return (os.environ.get(ENV_TOKEN) or "").strip() or None


def username():
    _load_dotenv()
    return (os.environ.get(ENV_USER) or "").strip() or DEFAULT_USER


def _clip(text, n=CAPTION_MAX):
    """캡션 앞부분만. 줄바꿈은 공백으로 눌러서 카드 안에 가지런히 얹히게 한다."""
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[:n].rstrip() + CAPTION_TAIL


def _date_of(it):
    """게시일. timestamp 가 없으면 takenAt 계열을 본다.
    셋 다 없으면 None — 날짜를 지어내지 않는다."""
    for k in ("timestamp", "takenAt", "taken_at", "takenAtDate"):
        v = it.get(k)
        if isinstance(v, str) and len(v) >= 10:
            return v[:10]
    for k in ("taken_at_timestamp", "takenAtTimestamp", "takenAtUnix"):
        v = it.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return datetime.datetime.utcfromtimestamp(float(v)).strftime("%Y-%m-%d")
    return None


def _link_of(it, user):
    """게시물 링크. Apify 는 보통 url 에 게시물 주소를 담고 inputUrl 에는 호출할 때
    넣은 주소를 담는다. 둘 다 받아 두고, 없으면 shortCode 로 만든다."""
    for k in ("url", "postUrl"):
        v = str(it.get(k) or "").strip()
        if v.startswith("http") and ("/p/" in v or "/reel/" in v):
            return v
    code = str(it.get("shortCode") or it.get("shortcode") or "").strip()
    if code:
        return "https://www.instagram.com/p/%s/" % code
    v = str(it.get("inputUrl") or "").strip()
    if v.startswith("http"):
        return v
    return "https://www.instagram.com/%s/" % user


def _map_item(it, user):
    return {
        "id": str(it.get("id") or it.get("shortCode") or it.get("shortcode") or "").strip(),
        "caption": _clip(it.get("caption")),
        "image": str(it.get("displayUrl") or it.get("display_url") or "").strip(),
        "link": _link_of(it, user),
        "date": _date_of(it),
    }


def fetch_posts(limit=POST_LIMIT, verbose=False):
    """Apify 에서 최신 게시물을 받아 화면이 쓰는 모양으로 바꾼다."""
    token = _token()
    if not token:
        return {"status": "no_key", "items": [],
                "reason": "환경변수 %s 가 설정되지 않았습니다" % ENV_TOKEN}

    user = username()
    body = {
        "directUrls": ["https://www.instagram.com/%s/" % user],
        "resultsType": "posts",
        "resultsLimit": int(limit),
    }
    try:
        res = requests.post(BASE, params={"token": token}, json=body, timeout=TIMEOUT)
        res.raise_for_status()
        raw = res.json()
    except Exception as e:  # noqa: BLE001 — 실패를 그대로 알린다
        return {"status": "error", "items": [], "username": user, "reason": str(e)[:200]}

    if not isinstance(raw, list):
        return {"status": "error", "items": [], "username": user,
                "reason": "응답 형식이 예상과 다릅니다 (%s)" % type(raw).__name__}
    if verbose and raw and isinstance(raw[0], dict):
        # 필드명이 바뀌면 여기서 바로 드러난다 — 매핑을 눈으로 확인할 수 있게 남긴다.
        print("[instagram] 응답 첫 항목 필드: %s" % ", ".join(sorted(raw[0].keys())),
              file=sys.stderr)

    items = [m for m in (_map_item(it, user) for it in raw if isinstance(it, dict)) if m["id"]]
    items = items[:int(limit)]
    if not items:
        return {"status": "error", "items": [], "username": user,
                "reason": "게시물을 찾지 못했습니다 (응답 %d건)" % len(raw)}

    return {"status": "ok", "username": user, "items": items,
            "profile": "https://www.instagram.com/%s/" % user,
            "source": "Apify Instagram Scraper",
            "fetched_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}


def load_cache(path=None):
    p = path or cache_path()
    try:
        d = json.load(io.open(p, encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except Exception:  # noqa: BLE001 — 캐시가 없거나 깨졌으면 없는 셈 친다
        return None


def _first_id(payload):
    items = (payload or {}).get("items") or []
    return items[0].get("id") if items else None


def refresh_cache(path=None, limit=POST_LIMIT, verbose=True):
    """Apify 를 한 번 부르고, 최신 게시물 id 가 캐시와 다를 때만 파일을 다시 쓴다.

    돌려주는 dict 에 changed(bool) 를 얹어 준다 — 워크플로가 커밋 여부를 판단할 때 쓴다.
    호출이 실패하면 기존 캐시를 절대 덮어쓰지 않는다(멀쩡한 데이터를 잃지 않게)."""
    p = path or cache_path()
    old = load_cache(p)
    fresh = fetch_posts(limit=limit, verbose=verbose)

    if fresh.get("status") != "ok":
        if verbose:
            print("[instagram] 수집 실패(%s) — 기존 캐시 유지: %s"
                  % (fresh.get("status"), fresh.get("reason")), file=sys.stderr)
        out = dict(old) if old else fresh
        out["changed"] = False
        out["last_error"] = fresh.get("reason") or fresh.get("status")
        return out

    if old and _first_id(old) and _first_id(old) == _first_id(fresh):
        if verbose:
            print("[instagram] 최신 게시물 id 동일(%s) → 캐시 유지, 재작성 생략"
                  % _first_id(fresh), file=sys.stderr)
        out = dict(old)
        out["changed"] = False
        out["checked_at"] = fresh["fetched_at"]
        return out

    os.makedirs(os.path.dirname(p), exist_ok=True)
    io.open(p, "w", encoding="utf-8", newline="").write(
        json.dumps(fresh, ensure_ascii=False, indent=2) + "\n")
    if verbose:
        print("[instagram] 갱신: %s → %s (게시물 %d건)"
              % (_first_id(old), _first_id(fresh), len(fresh["items"])), file=sys.stderr)
    out = dict(fresh)
    out["changed"] = True
    return out


# ── Vercel 서버리스 진입점 ────────────────────────────────────────────────
# GET  /api/instagram            → 커밋된 캐시를 그대로 준다(Apify 호출 없음 = 크레딧 0)
# GET  /api/instagram?refresh=1  → Apify 를 부른다(Case 로직 적용)
class handler(BaseHTTPRequestHandler):
    def _respond(self, force_refresh=False):
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            want = force_refresh or (q.get("refresh") or ["0"])[0] not in ("0", "", "false")
            if want:
                payload = refresh_cache(verbose=False)
            else:
                # 쓸 만한 캐시(게시물이 실제로 들어 있는)가 있을 때만 그걸 준다.
                # 빈 자리표시 파일뿐이면 그때는 수집한다.
                cached = load_cache()
                payload = cached if (cached and cached.get("items")) else fetch_posts()
        except Exception as e:  # noqa: BLE001
            payload = {"status": "error", "items": [], "reason": str(e)[:200]}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)          # 화면이 항상 뜨게 200 으로 준다
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond()

    def do_POST(self):
        self._respond(force_refresh=True)


# ── CLI (GitHub Actions 에서 실행) ────────────────────────────────────────
if __name__ == "__main__":
    r = refresh_cache()
    print("[instagram] status=%s changed=%s 게시물=%d"
          % (r.get("status"), r.get("changed"), len(r.get("items") or [])))
    # 수집에 실패했고 쓸 캐시도 없으면 0이 아닌 코드로 끝낸다(워크플로가 알아채게).
    sys.exit(0 if (r.get("items") or r.get("status") == "no_key") else 1)
