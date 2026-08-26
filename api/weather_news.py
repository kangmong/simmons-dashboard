# -*- coding: utf-8 -*-
"""지역 날씨 이슈 뉴스 — Google 뉴스 RSS (무료·키 불필요).

브라우저에서 news.google.com 을 직접 부르면 CORS 로 막히므로 서버가 대신 받아 준다.
★ 제목·링크·언론사·게재일만 돌려준다. 본문 요약을 만들지 않는다(저작권).
★ 검색 결과가 없으면 items 를 빈 배열로 준다 — 화면에서 '없음'을 정직하게 띄운다.
  기사를 지어내지 않는다.
"""
import datetime
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler

import requests

# 재해·이상기후 낱말을 4개씩 묶어 여러 번 검색한 뒤 합친다.
#
# ★★ 왜 나눠 부르는가 — 실측 결과다.
#   '"통영" (홍수 OR … 13개)'  → 결과 0건 (정상 응답인데 빈 피드)
#   '통영 (홍수 OR … 13개)'    → 100건
#   '"통영" (홍수 OR 태풍 OR 호우 OR 폭염)' → 100건
#   구글 뉴스 RSS 는 '따옴표 묶은 지역명 + 긴 OR 묶음'에서 아무것도 돌려주지
#   않는다. 그래서 따옴표를 떼고, 낱말을 4개씩 나눠 부르고 합친다.
#   묶음 하나가 0건이어도 나머지가 채워 준다(실측: 전 지역 모두 결과 확보).
DISASTER_BATCHES = [
    ["홍수", "태풍", "호우", "폭우"],
    ["폭염", "한파", "대설", "강풍"],
    ["침수", "산사태", "기상특보", "재해"],
]
DISASTER_WORDS = [w for b in DISASTER_BATCHES for w in b]

MAX_ITEMS = 6          # 화면에 6건까지
MAX_AGE_DAYS = 365     # 1년보다 오래된 기사는 '최근'이 아니라 버린다
TIMEOUT = 20


def _fmt_pubdate(s):
    """RFC822 pubDate → 'YYYY-MM-DD' (실패하면 앞 16자)."""
    s = (s or "").strip()
    for fmt in ("%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S %z"):
        try:
            return datetime.datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            pass
    return s[:16]


def _clean_title(title, source):
    """구글 뉴스 제목 끝의 ' - 언론사'를 떼어 낸다(언론사는 따로 표시)."""
    t = (title or "").strip()
    if source and t.endswith(" - " + source):
        t = t[: -(len(source) + 3)]
    return t.strip()


def _feed(query):
    """구글 뉴스 RSS 한 번 호출 → item 목록(실패·빈 피드면 [])."""
    url = ("https://news.google.com/rss/search?q=" + urllib.parse.quote(query)
           + "&hl=ko&gl=KR&ceid=KR:ko")
    try:
        res = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": "Mozilla/5.0"})
        res.raise_for_status()
        return list(ET.fromstring(res.content).iter("item")), None
    except Exception as e:  # noqa: BLE001 — 한 묶음 실패해도 나머지는 계속
        return [], str(e)


def fetch_region_news(region, limit=MAX_ITEMS):
    """지역명으로 날씨 이슈 뉴스를 찾는다. 결과가 없으면 items=[] 로 정직하게 준다."""
    region = re.sub(r"\s+", " ", (region or "")).strip()
    if not region:
        return {"status": "error", "reason": "region 이 비어 있습니다", "items": []}

    today = datetime.date.today()
    rows, seen, errs, per = [], set(), [], []
    for batch in DISASTER_BATCHES:
        q = "%s (%s)" % (region, " OR ".join(batch))
        got, err = _feed(q)
        per.append(len(got))
        if err:
            errs.append(err)
        for it in got:
            title = (it.findtext("title") or "").strip()
            if not title:
                continue
            src_el = it.find("source")
            source = (src_el.text.strip() if (src_el is not None and src_el.text) else "")
            date = _fmt_pubdate(it.findtext("pubDate") or "")
            clean = _clean_title(title, source)
            if not clean or clean in seen:
                continue
            # 너무 오래된 기사는 '최근 이슈'가 아니다. 날짜를 못 읽으면 남긴다.
            try:
                d = datetime.datetime.strptime(date, "%Y-%m-%d").date()
                if (today - d).days > MAX_AGE_DAYS:
                    continue
            except Exception:  # noqa: BLE001
                pass
            seen.add(clean)
            rows.append({"title": clean, "link": (it.findtext("link") or "").strip(),
                         "source": source, "date": date})

    rows.sort(key=lambda x: x["date"], reverse=True)   # 최신순

    # ★ 제목에 지역명이 있는 기사를 먼저 쓴다.
    #   구글이 '언론사 이름'만으로도 걸어 주기 때문이다 — 실측: '서울' 검색에
    #   서울뉴스통신이 낸 중국 태풍 기사가 섞였다(제목에 서울이 없다).
    #   제목 매칭이 하나도 없으면 그때만 나머지를 쓴다(실제 결과를 버리지 않는다).
    titled = [x for x in rows if region in x["title"]]
    picked = titled if titled else rows
    items = picked[:limit]
    print("[weather_news][%s] 묶음별 %s → 고유 %d건(제목 매칭 %d건) → 표시 %d건%s"
          % (region, per, len(rows), len(titled), len(items),
             (" · 오류 %d건" % len(errs)) if errs else ""))
    out = {"status": "ok", "region": region, "items": items,
           "total": len(rows), "title_matched": len(titled), "keywords": DISASTER_WORDS,
           "fetched_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    if errs and not rows:      # 전부 실패했으면 그 사실을 알린다(0건과 구분)
        out["status"] = "error"
        out["reason"] = errs[0]
    return out


# ── Vercel 서버리스 진입점 ────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    def _respond(self):
        try:
            q = urllib.parse.urlparse(self.path).query
            region = (urllib.parse.parse_qs(q).get("region") or [""])[0]
            payload = fetch_region_news(region)
            code = 200 if payload.get("status") == "ok" else 200  # 화면이 항상 뜨게
        except Exception as e:  # noqa: BLE001
            payload = {"status": "error", "reason": str(e), "items": []}
            code = 200
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond()

    def do_POST(self):
        self._respond()
