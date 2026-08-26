# -*- coding: utf-8 -*-
"""기상청 기상특보 조회서비스 (공공데이터포털) — 인증키가 있을 때만 동작.

★★ 인증키가 없으면 status='no_key' 를 돌려준다. 화면은 그때 '특보 연동 준비 중
  (API 키 필요)'이라고 정직하게 띄우고, 나머지 그래프(Open-Meteo)는 그대로 그린다.
  키가 없다고 해서 빌드나 실행이 깨지지 않는다.
★★ 키를 코드에 적지 않는다. 환경변수 KMA_SERVICE_KEY 에서만 읽는다.
  로컬은 .env, 배포는 Vercel 환경변수 / GitHub Secrets 를 쓴다.
★ 값을 지어내지 않는다. 호출이 실패하면 실패했다고 그대로 알린다.

서비스: https://www.data.go.kr/data/15000415/openapi.do
엔드포인트: http://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnList
"""
import datetime
import json
import os
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler

import requests

BASE = "http://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnList"
TIMEOUT = 20
ENV_KEY = "KMA_SERVICE_KEY"

# 특보 지점번호(stnId). 기상청은 178개 시·군 단위로 특보를 낸다.
#   ★ 도시별 정확한 특보구역 코드는 '기상청_지점정보(기상관측, 특보구역) 조회서비스'
#     (data.go.kr/data/15058846)로 조회해서 채우면 된다.
#   ★ 여기서는 확실한 것만 적는다. 모르는 도시는 108(전국)로 두고,
#     화면에도 '전국 기준'이라고 밝힌다 — 번호를 추측해서 넣지 않는다.
CITY_STN = {
    "서울": "108",
}
DEFAULT_STN = "108"      # 전국

# 특보 종류 → 어느 그래프에 음영을 칠지. 화면(app.js)과 같은 이름을 쓴다.
KIND_GROUP = {
    "폭염": "temp", "한파": "temp",
    "태풍": "wind", "강풍": "wind", "풍랑": "wind",
    "건조": "humid",
    "호우": "rain", "대설": "rain",
}


def _service_key():
    k = (os.environ.get(ENV_KEY) or "").strip()
    return k or None


def _parse_title(title):
    """통보문 제목에서 특보 종류·수준을 뽑는다. 예: '호우경보', '폭염주의보'."""
    t = (title or "")
    kind = next((k for k in KIND_GROUP if k in t), None)
    level = "경보" if "경보" in t else ("주의보" if "주의보" in t else None)
    return kind, level


def _yyyymmdd(s):
    s = re.sub(r"[^0-9]", "", str(s or ""))
    return s[:8] if len(s) >= 8 else None


def fetch_alerts(region, days=60, stn=None):
    """최근 days 일간의 특보 목록. 키가 없으면 status='no_key'."""
    key = _service_key()
    if not key:
        return {"status": "no_key", "region": region, "bands": [],
                "reason": "환경변수 %s 가 설정되지 않았습니다" % ENV_KEY}

    stn_id = stn or CITY_STN.get(region) or DEFAULT_STN
    end = datetime.date.today()
    start = end - datetime.timedelta(days=int(days))
    params = {
        "serviceKey": key,               # 발급받은 그대로(디코딩된 키) 사용
        "pageNo": "1", "numOfRows": "300", "dataType": "JSON",
        "stnId": stn_id,
        "fromTmFc": start.strftime("%Y%m%d"),
        "toTmFc": end.strftime("%Y%m%d"),
    }
    try:
        res = requests.get(BASE, params=params, timeout=TIMEOUT)
        res.raise_for_status()
        data = res.json()
    except Exception as e:  # noqa: BLE001 — 실패를 그대로 알린다(지어내지 않는다)
        return {"status": "error", "region": region, "bands": [],
                "reason": str(e)[:200]}

    try:
        body = data["response"]["body"]
        items = body.get("items", {}).get("item", [])
        if isinstance(items, dict):
            items = [items]
    except Exception:  # noqa: BLE001
        head = (data.get("response", {}) or {}).get("header", {})
        return {"status": "error", "region": region, "bands": [],
                "reason": "응답 형식이 예상과 다릅니다 (%s)" % head.get("resultMsg", "")}

    bands = []
    for it in items:
        kind, level = _parse_title(it.get("title") or "")
        if not kind:
            continue
        day = _yyyymmdd(it.get("tmFc"))
        if not day:
            continue
        iso = "%s-%s-%s" % (day[:4], day[4:6], day[6:8])
        bands.append({"kind": kind, "group": KIND_GROUP[kind], "level": level,
                      "from": iso, "to": iso, "title": it.get("title") or "",
                      "stnId": it.get("stnId") or stn_id})

    return {"status": "ok", "region": region, "stnId": stn_id,
            "stn_exact": region in CITY_STN,     # False 면 전국(108) 기준이라는 뜻
            "bands": bands, "total": len(bands),
            "fetched_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}


# ── Vercel 서버리스 진입점 ────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    def _respond(self):
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            region = (q.get("region") or [""])[0]
            days = (q.get("days") or ["60"])[0]
            payload = fetch_alerts(region, days)
        except Exception as e:  # noqa: BLE001
            payload = {"status": "error", "bands": [], "reason": str(e)[:200]}
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
        self._respond()
