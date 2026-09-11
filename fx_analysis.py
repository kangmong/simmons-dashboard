# -*- coding: utf-8 -*-
"""환율 현황 + 해석 수집 — public/data/fx-analysis.json.

화면(환율 섹션)은 이 JSON 만 읽는다. 브라우저에서 Gemini 나 어떤 API 도 부르지
않는다 — API 키가 브라우저로 내려가는 경로를 아예 만들지 않는다.

구성:
  [1] 시세    Frankfurter(ECB 기반, 무키) — USD/EUR/JPY 대비 원화, 약 13개월
  [2] 거시    FRED fredgraph.csv(무키) + 미 재무부 수익률곡선 XML(무키)
  [3] 뉴스    구글 뉴스 RSS + 연합뉴스 경제 RSS(무키)
  [4] 해석    Google Gemini generateContent — [1]~[3]을 넣어 JSON 으로 생성

★ 배지(급등/3개월 최고 등)와 모든 숫자는 파이썬이 계산한다. AI 가 만들지 않는다.
  AI 는 '왜/앞으로' 부분의 문장만 쓴다. 숫자를 만들지 말라고 프롬프트에 못박고,
  그래도 새 숫자가 나올 수 있으니 화면에는 파이썬이 계산한 값만 쓴다.

★★ 출처는 URL 을 베껴 쓰게 하지 않는다. 수집한 출처에 번호(S1, S2 …)를 붙여
  주고 번호만 돌려받아 파이썬이 URL 로 바꾼다 — 구글 뉴스 링크는 base64 로
  200자가 넘어서, URL 을 직접 쓰게 했을 때 6개 중 2개가 틀리게 옮겨 적혀
  검증에서 떨어졌다. 번호 방식은 베껴 쓸 일이 없어 링크가 틀릴 수가 없다.
  목록에 없는 번호가 오면 문장은 살리고 링크만 생략한다(로그에 남긴다).

★★★ 모델명을 하드코딩하지 않는다. models.list 로 '이 키가 실제로 쓸 수 있는'
  모델을 받아 선호 순서와 교집합해서 고른다. 무료 티어 구성은 계정·지역마다
  다르고 자주 바뀌어서, 코드에 박아 둔 이름은 언젠가 반드시 썩는다.

★★★★ 실패가 배포된 데이터를 지우지 않는다. 수집이 실패하면 기존 정상 파일을
  그대로 둔다(--force 로만 덮어씀). KIPRIS 수집기와 같은 규칙이다.

단독 실행:
    python fx_analysis.py                 # 수집 → public/data/fx-analysis.json
    python fx_analysis.py --probe         # 진단만(파일 안 건드림)
    python fx_analysis.py --no-ai         # 시세·거시·뉴스만(Gemini 호출 없음)
    python fx_analysis.py --model X       # 모델 직접 지정(생략하면 자동 탐색)
    python fx_analysis.py --list-models   # 이 키로 쓸 수 있는 모델 목록만 출력
"""
import os
import io
import re
import sys
import json
import time
import csv
import datetime
import argparse
import xml.etree.ElementTree as ET

import requests

# 윈도우 콘솔(cp949)에서 '—' 같은 글자에 UnicodeEncodeError 로 죽지 않게 한다.
for _s in ("stdout", "stderr"):
    _f = getattr(sys, _s, None)
    if hasattr(_f, "reconfigure"):
        try:
            _f.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 — 못 바꿔도 수집은 계속한다
            pass

OUT_REL = "public/data/fx-analysis.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
HDR = {"User-Agent": UA}
KST = datetime.timezone(datetime.timedelta(hours=9))

# ── 통화 ──────────────────────────────────────────────────────────────────
# app.js 의 FX_META 와 같은 색·같은 순서를 쓴다(화면 두 곳의 색이 어긋나지 않게).
CURS = [
    {"cur": "USD", "name": "미국 달러", "unit": "1달러", "scale": 1, "color": "#C8102E"},
    {"cur": "EUR", "name": "유로", "unit": "1유로", "scale": 1, "color": "#F59E0B"},
    {"cur": "JPY", "name": "엔화", "unit": "100엔", "scale": 100, "color": "#3B82F6"},
]

# ── 배지 기준 ─────────────────────────────────────────────────────────────
# ★ 사람 감각으로 '급등'을 쓰지 않는다. 경계값을 여기 적어 두고 화면 각주에도
#   같은 숫자를 노출한다 — 나중에 왜 그렇게 썼는지 확인할 수 있게.
BADGE_SPIKE_PCT = 0.6     # 전일대비 |%| 이 이상이면 급등/급락
BADGE_MOVE_PCT = 0.3      # 이 이상이면 상승/하락(그 아래는 보합)
HIGH_LOW_WINDOW = 63      # 3개월 최고/최저 판정 구간(영업일 수)


def _load_env_key(name):
    """환경변수 → .env(수동 파싱, 의존성 없이). 값은 절대 로그에 찍지 않는다."""
    v = os.environ.get(name)
    if v:
        return v.strip()
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, ".env"), ".env"):
        try:
            with io.open(path, encoding="utf-8") as f:
                for line in f:
                    s = line.strip()
                    if s.startswith("#") or "=" not in s:
                        continue
                    k, val = s.split("=", 1)
                    if k.strip() == name:
                        val = val.strip().strip('"').strip("'")
                        if val:
                            return val
        except OSError:
            pass
    return None


def _get(url, timeout=25, tries=3, headers=None):
    """GET + 지수 백오프 재시도. 마지막 실패는 예외를 올린다."""
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, headers=headers or HDR, timeout=timeout)
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001
            last = e
            if i < tries - 1:
                time.sleep(1.5 * (2 ** i))
    raise last


# ── [1] 시세 — Frankfurter ────────────────────────────────────────────────
def fetch_rates():
    """USD/EUR/JPY 대비 원화 시계열. JPY 는 100엔 단위로 환산한다.
       반환: {"status":..., "cards":[...], "series":{...}, "asOf":...}"""
    base = "https://api.frankfurter.app"
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=400)).isoformat()
    raw = {}
    try:
        for c in CURS:
            r = _get("%s/%s..%s?from=%s&to=KRW" % (base, start, today.isoformat(), c["cur"]))
            rr = r.json().get("rates", {})
            raw[c["cur"]] = {d: o["KRW"] for d, o in rr.items() if o.get("KRW") is not None}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "환율 조회 실패: %s" % e}

    dates = sorted(set().union(*[set(v.keys()) for v in raw.values()])) if raw else []
    cutoff = (today - datetime.timedelta(days=400)).isoformat()
    dates = [d for d in dates if d >= cutoff]
    if not dates:
        return {"status": "error", "reason": "환율 시계열이 비었습니다"}

    series = {"dates": dates}
    cards = []
    for c in CURS:
        cur, sc = c["cur"], c["scale"]
        vals = [round(raw[cur][d] * sc, 2) if d in raw[cur] else None for d in dates]
        series[cur] = vals
        nn = [(d, v) for d, v in zip(dates, vals) if v is not None]
        if not nn:
            cards.append({"cur": cur, "name": c["name"], "unit": c["unit"],
                          "color": c["color"], "status": "error", "now": None})
            continue
        now, prev = nn[-1][1], (nn[-2][1] if len(nn) >= 2 else None)
        change = round(now - prev, 2) if prev is not None else None
        pct = round((now - prev) / prev * 100.0, 2) if prev else None
        win = [v for _, v in nn[-HIGH_LOW_WINDOW:]]
        allv = [v for _, v in nn]
        stats = {
            "high3m": max(win), "low3m": min(win),
            "avg3m": round(sum(win) / len(win), 2),
            "high12m": max(allv), "low12m": min(allv),
            "windowDays": len(win),
        }
        cards.append({
            "cur": cur, "name": c["name"], "unit": c["unit"], "color": c["color"],
            "status": "ok", "now": now, "prev": prev, "change": change, "changePct": pct,
            "asOf": nn[-1][0], "prevAsOf": (nn[-2][0] if len(nn) >= 2 else None),
            "spark": [v for _, v in nn[-HIGH_LOW_WINDOW:]],
            "sparkDates": [d for d, _ in nn[-HIGH_LOW_WINDOW:]],
            "stats": stats,
            "badges": _badges(now, pct, stats),
        })
    return {"status": "ok", "cards": cards, "series": series, "asOf": dates[-1],
            "source": "Frankfurter (ECB 기반)",
            "sourceUrl": "https://www.frankfurter.app/"}


def _badges(now, pct, stats):
    """배지는 전부 계산 결과다. 문구를 지어내지 않는다."""
    out = []
    if pct is not None:
        a = abs(pct)
        if a >= BADGE_SPIKE_PCT:
            out.append({"text": "급등" if pct > 0 else "급락",
                        "tone": "up" if pct > 0 else "down",
                        "why": "전일대비 %+.2f%% (기준 ±%.1f%%)" % (pct, BADGE_SPIKE_PCT)})
        elif a >= BADGE_MOVE_PCT:
            out.append({"text": "상승" if pct > 0 else "하락",
                        "tone": "up" if pct > 0 else "down",
                        "why": "전일대비 %+.2f%% (기준 ±%.1f%%)" % (pct, BADGE_MOVE_PCT)})
        else:
            out.append({"text": "보합", "tone": "flat",
                        "why": "전일대비 %+.2f%% (±%.1f%% 이내)" % (pct, BADGE_MOVE_PCT)})
    if now is not None:
        n = stats.get("windowDays") or HIGH_LOW_WINDOW
        if now >= stats["high3m"]:
            out.append({"text": "3개월 최고", "tone": "up",
                        "why": "최근 %d영업일 최고치" % n})
        elif now <= stats["low3m"]:
            out.append({"text": "3개월 최저", "tone": "down",
                        "why": "최근 %d영업일 최저치" % n})
        if now >= stats["high12m"]:
            out.append({"text": "12개월 최고", "tone": "up", "why": "수집 구간 최고치"})
        elif now <= stats["low12m"]:
            out.append({"text": "12개월 최저", "tone": "down", "why": "수집 구간 최저치"})
    return out


# ── [2] 거시지표 — FRED(무키) + 미 재무부(무키) ───────────────────────────
# ★ FRED 는 키 없이 fredgraph.csv 로 받을 수 있다. 다만 짧은 시간에 여러 번
#   때리면 막힌다(16개를 연달아 받다가 전부 타임아웃했다). 꼭 필요한 것만
#   고르고, 사이에 간격을 두고, 실패는 그 항목만 건너뛴다.
# ★ FRED 는 '브라우저를 자칭하는 UA' 에 응답을 주지 않는다. 브라우저 UA 로 보내면
#   연결은 되고 응답만 오지 않아 읽기 타임아웃으로 죽는다(40초 대기 후 실패).
#   같은 요청을 정직한 봇 UA 로 보내면 1초 안에 200 이 온다 — 재현해서 확인했다.
#     긴 Chrome UA → ReadTimeout(40.8초) / 짧은 UA → 200(1.8초) / UA 없음 → 200(0.7초)
#   그래서 FRED 에만 별도 헤더를 쓴다(다른 소스는 브라우저 UA 가 필요하다).
#   ※ 헤더 값은 latin-1 로만 보낼 수 있다 — 한글을 넣으면 requests 가
#     'latin-1 codec can't encode' 로 죽는다. ASCII 로만 적는다.
FRED_HDR = {"User-Agent": "simmons-dashboard/1.0 (+fx_analysis.py; daily batch)"}

FRED_SERIES = [
    ("DTWEXBGS", "달러지수(광범위)", "지수", "일"),
    ("CPIAUCSL", "미국 CPI", "지수", "월"),
    ("UNRATE", "미국 실업률", "%", "월"),
    ("FEDFUNDS", "연방기금금리", "%", "월"),
]
FRED_STALE_DAYS = {"일": 30, "월": 120}   # 이보다 오래되면 '현재값'으로 쓰지 않는다


def _fred_one(sid, label, unit, freq):
    # ★ cosd 로 구간을 자른다. 안 자르면 2006년부터 전부 내려와 104KB 다 —
    #   필요한 건 최근 2년이고, 8.6KB 로 줄면 응답도 훨씬 빠르다.
    #   (전년동월비를 계산하려면 13개월 이상이 필요해서 2년으로 잡았다)
    cosd = (datetime.date.today() - datetime.timedelta(days=760)).isoformat()
    r = _get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=%s&cosd=%s" % (sid, cosd),
             timeout=30, tries=3, headers=FRED_HDR)
    rows = [x for x in csv.reader(io.StringIO(r.text)) if len(x) >= 2 and x[1] not in ("", ".")]
    if len(rows) < 3:
        raise ValueError("데이터 행 부족")
    date_s, val_s = rows[-1][0], rows[-1][1]
    prev_v = float(rows[-2][1])
    cur_v = float(val_s)
    d = datetime.date.fromisoformat(date_s)
    age = (datetime.date.today() - d).days
    if age > FRED_STALE_DAYS.get(freq, 120):
        raise ValueError("자료가 %d일 지났습니다(%s)" % (age, date_s))
    # 전년 동월 대비 변화.
    # ★ 단위에 따라 계산을 달리해야 한다. CPI·달러지수처럼 '지수'는 변화율(%)이
    #   의미 있지만, 금리·실업률처럼 이미 %인 값은 변화율을 쓰면 오해를 부른다 —
    #   연방기금금리 4.33% → 3.63% 은 '-16.17%' 가 아니라 '-0.70%p' 다.
    #   그래서 % 단위는 퍼센트포인트(yoyPp)로, 지수는 변화율(yoyPct)로 낸다.
    yoy_pct = yoy_pp = None
    if freq == "월" and len(rows) >= 13:
        try:
            base = float(rows[-13][1])
            if unit == "%":
                yoy_pp = round(cur_v - base, 2)
            elif base:
                yoy_pct = round((cur_v - base) / base * 100.0, 2)
        except Exception:  # noqa: BLE001
            pass
    return {
        "key": sid, "label": label, "unit": unit,
        "value": round(cur_v, 4), "prev": round(prev_v, 4),
        "change": round(cur_v - prev_v, 4),
        "yoyPct": yoy_pct, "yoyPp": yoy_pp,
        "asOf": date_s, "freq": freq,
        "source": "FRED (세인트루이스 연은)",
        "url": "https://fred.stlouisfed.org/series/" + sid,
    }


def _treasury_yields():
    """미 재무부 일일 국채 수익률곡선 — 2년·10년물과 장단기 스프레드."""
    yr = datetime.date.today().year
    url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
           "pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=%d" % yr)
    r = _get(url, timeout=30, tries=2)
    props = re.findall(r"<m:properties>(.*?)</m:properties>", r.text, re.S)
    if not props:
        raise ValueError("수익률곡선 레코드 없음")

    def pick(block, tag):
        m = re.search(r"<d:%s[^>]*>([^<]*)<" % tag, block)
        if not m or not m.group(1).strip():
            return None
        try:
            return float(m.group(1))
        except ValueError:
            return None

    for block in reversed(props):          # 최신부터 거꾸로 — 값이 빈 날 건너뛴다
        y2, y10 = pick(block, "BC_2YEAR"), pick(block, "BC_10YEAR")
        dm = re.search(r"<d:NEW_DATE[^>]*>([^<T]*)", block)
        if y2 is not None and y10 is not None and dm:
            date_s = dm.group(1)
            return [
                {"key": "UST2Y", "label": "미 국채 2년물", "unit": "%", "value": y2,
                 "asOf": date_s, "freq": "일", "source": "미 재무부",
                 "url": "https://home.treasury.gov/resource-center/data-chart-center/"
                        "interest-rates/TextView?type=daily_treasury_yield_curve"},
                {"key": "UST10Y", "label": "미 국채 10년물", "unit": "%", "value": y10,
                 "asOf": date_s, "freq": "일", "source": "미 재무부",
                 "url": "https://home.treasury.gov/resource-center/data-chart-center/"
                        "interest-rates/TextView?type=daily_treasury_yield_curve"},
                {"key": "UST10Y2Y", "label": "장단기 금리차(10Y-2Y)", "unit": "%p",
                 "value": round(y10 - y2, 2), "asOf": date_s, "freq": "일",
                 "source": "미 재무부(계산)",
                 "url": "https://home.treasury.gov/resource-center/data-chart-center/"
                        "interest-rates/TextView?type=daily_treasury_yield_curve"},
            ]
    raise ValueError("2년·10년물이 모두 있는 날을 못 찾음")


def fetch_macro():
    """거시지표. 항목별로 실패를 격리한다 — 하나 실패가 전체를 막지 않는다.
       ★ 한국은행 기준금리·무역수지는 ECOS 키가 필요해서 넣지 않았다. FRED 의
         한국 시계열은 갱신이 늦어(수년 전에서 멈춘 것이 많다) '현재값'으로
         쓰면 오해를 부른다 — 한국 쪽 재료는 뉴스 헤드라인으로만 다룬다."""
    items, errors = [], []
    for sid, label, unit, freq in FRED_SERIES:
        try:
            items.append(_fred_one(sid, label, unit, freq))
        except Exception as e:  # noqa: BLE001
            errors.append({"key": sid, "label": label, "error": str(e)[:160]})
            print("[fx] 거시 %s 실패: %s" % (sid, str(e)[:120]))
        # ★ FRED 는 짧은 시간에 여러 번 때리면 읽기 타임아웃으로 막는다.
        #   (16개를 연달아 받다가 전부 막혔고, 몇 분 뒤 같은 요청이 0.9초에 왔다)
        #   하루 1회 배치라 몇 초 더 쉬는 비용은 없다.
        time.sleep(1.0)
    try:
        items.extend(_treasury_yields())
    except Exception as e:  # noqa: BLE001
        errors.append({"key": "UST", "label": "미 국채 수익률", "error": str(e)[:160]})
        print("[fx] 거시 국채 실패: %s" % str(e)[:120])
    return {"status": "ok" if items else "error", "items": items, "errors": errors}


# ── [3] 뉴스 헤드라인 — RSS(무키) ─────────────────────────────────────────
NEWS_FEEDS = [
    ("구글 뉴스", "https://news.google.com/rss/search"
                  "?q=%EC%9B%90%EB%8B%AC%EB%9F%AC+%ED%99%98%EC%9C%A8&hl=ko&gl=KR&ceid=KR:ko"),
    ("구글 뉴스", "https://news.google.com/rss/search"
                  "?q=%ED%95%9C%EA%B5%AD%EC%9D%80%ED%96%89+%EA%B8%B0%EC%A4%80%EA%B8%88%EB%A6%AC"
                  "&hl=ko&gl=KR&ceid=KR:ko"),
    ("구글 뉴스", "https://news.google.com/rss/search"
                  "?q=%EB%AF%B8%EA%B5%AD+%EC%97%B0%EC%A4%80+%EA%B8%88%EB%A6%AC"
                  "&hl=ko&gl=KR&ceid=KR:ko"),
    ("구글 뉴스", "https://news.google.com/rss/search"
                  "?q=%EB%AC%B4%EC%97%AD%EC%88%98%EC%A7%80+%EA%B2%BD%EC%83%81%EC%88%98%EC%A7%80"
                  "&hl=ko&gl=KR&ceid=KR:ko"),
    ("연합뉴스", "https://www.yna.co.kr/rss/economy.xml"),
]
NEWS_PER_FEED = 8
NEWS_MAX = 26
# 환율과 무관한 기사가 섞이면 모델이 엉뚱한 근거를 든다. 제목 필터로 걸러낸다.
NEWS_KEYWORDS = ["환율", "원달러", "원/달러", "달러", "원화", "연준", "금리", "물가",
                 "인플레", "무역수지", "경상수지", "수출", "외국인", "국채", "엔화",
                 "유로", "한국은행", "기준금리", "고용", "CPI", "FOMC"]


def _rss_items(xml_text, feed_name):
    out = []
    try:
        root = ET.fromstring(xml_text.encode("utf-8") if isinstance(xml_text, str) else xml_text)
    except Exception:  # noqa: BLE001
        return out
    for it in root.iter("item"):
        t = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        if not t or not link:
            continue
        pub = (it.findtext("pubDate") or "").strip()
        src = (it.findtext("source") or "").strip() or feed_name
        # 구글 뉴스 제목은 '기사제목 - 언론사' 꼴이다. 언론사를 떼어 따로 보관한다.
        media = src
        if feed_name == "구글 뉴스" and " - " in t:
            t, media = t.rsplit(" - ", 1)
            t, media = t.strip(), media.strip()
        out.append({"title": t, "link": link, "media": media,
                    "published": pub, "feed": feed_name})
    return out


def fetch_news():
    seen_title, seen_link, rows, errors = set(), set(), [], []
    for name, url in NEWS_FEEDS:
        try:
            r = _get(url, timeout=25, tries=2)
            got = _rss_items(r.text, name)[:NEWS_PER_FEED]
        except Exception as e:  # noqa: BLE001
            errors.append({"feed": url[:70], "error": str(e)[:140]})
            print("[fx] 뉴스 %s 실패: %s" % (name, str(e)[:110]))
            continue
        for it in got:
            key = re.sub(r"\W+", "", it["title"])[:40]
            if not key or key in seen_title or it["link"] in seen_link:
                continue
            if not any(k in it["title"] for k in NEWS_KEYWORDS):
                continue
            seen_title.add(key)
            seen_link.add(it["link"])
            rows.append(it)
    return {"status": "ok" if rows else "error", "items": rows[:NEWS_MAX], "errors": errors}


# ── [4] 해석 — Google Gemini ──────────────────────────────────────────────
GEM_BASE = "https://generativelanguage.googleapis.com/v1beta"
# 선호 순서. 실제로 쓸 모델은 models.list 결과와 교집합해서 고른다 —
# 여기 이름이 없어지거나 계정에서 못 쓰더라도 자동으로 다음이 선택된다.
# ★★ models.list 에 이름이 있어도 실제로 쓸 수 있다는 뜻이 아니다. 새로 발급한
#   키로 확인해 보니 gemini-2.5-flash / 2.5-flash-lite 는 목록에는 나오면서
#   generateContent 에서 404 를 준다:
#     "This model models/gemini-2.5-flash is no longer available to new users.
#      Please update your code to use models/gemini-3.6-flash"
#   그래서 목록만 믿지 않고, 404/400 이면 다음 후보로 넘어간다(아래 루프).
#   순서는 구글이 직접 후속 모델로 안내한 것을 앞에 둔다. 2.5 계열은 이미
#   권한이 있는 오래된 키를 위해 맨 뒤에 남겨 둔다.
MODEL_PREFS = [
    "gemini-3.6-flash",        # 2.5-flash 의 후속(구글 안내). 추론 품질 우선
    "gemini-3.5-flash-lite",   # 2.5-flash-lite 의 후속(구글 안내)
    "gemini-3.1-flash-lite",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-2.5-flash",        # 레거시 — 기존 키만 통한다
    "gemini-2.5-flash-lite",
]
# 위 선호 목록이 모두 없을 때 쓰는 규칙: generateContent 를 지원하는
# flash/lite 계열 중 아무거나. pro·image·tts·audio·live 는 제외한다
# (유료거나 목적이 다르다).
MODEL_AVOID = ("pro", "image", "tts", "audio", "live", "transcribe", "embedding",
               "vision", "learnlm", "gemma")

ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "current": {"type": "string"},
        "upsideLimiters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "point": {"type": "string"},
                    "evidence": {"type": "string"},
                    "sourceId": {"type": "string"},
                },
                "required": ["point", "evidence", "sourceId"],
            },
        },
        "downsideSupports": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "point": {"type": "string"},
                    "evidence": {"type": "string"},
                    "sourceId": {"type": "string"},
                },
                "required": ["point", "evidence", "sourceId"],
            },
        },
        "outlook": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["박스권", "상승", "하락"]},
                "rationale": {"type": "string"},
                "confidence": {"type": "string", "enum": ["높음", "중간", "낮음"]},
            },
            "required": ["direction", "rationale", "confidence"],
        },
    },
    "required": ["current", "upsideLimiters", "downsideSupports", "outlook"],
}


def list_models(key):
    """이 키로 generateContent 를 쓸 수 있는 모델 이름 목록(models/ 접두사 제거)."""
    names, token = [], None
    for _ in range(5):                     # 페이지네이션 상한
        url = GEM_BASE + "/models?pageSize=200" + ("&pageToken=" + token if token else "")
        r = _get(url, timeout=25, tries=2, headers=dict(HDR, **{"x-goog-api-key": key}))
        d = r.json()
        for m in d.get("models") or []:
            methods = m.get("supportedGenerationMethods") or []
            if "generateContent" not in methods:
                continue
            nm = (m.get("name") or "").split("/", 1)[-1]
            if nm:
                names.append(nm)
        token = d.get("nextPageToken")
        if not token:
            break
    return names


def pick_model(key, want=None):
    """실제로 존재하고 쓸 수 있는 모델을 고른다.
       반환: (모델명, 시도 순서 리스트, 탐색 메모)"""
    if want:
        return want, [want], "직접 지정(--model/GEMINI_MODEL)"
    try:
        avail = list_models(key)
    except Exception as e:  # noqa: BLE001
        print("[fx] models.list 실패(%s) → 선호 목록을 순서대로 시도" % str(e)[:110])
        return MODEL_PREFS[0], list(MODEL_PREFS), "models.list 실패 — 선호 목록 사용"
    if not avail:
        return MODEL_PREFS[0], list(MODEL_PREFS), "models.list 가 비었음 — 선호 목록 사용"
    print("[fx] 사용 가능 모델 %d개 (예: %s)" % (len(avail), ", ".join(avail[:6])))
    order = [m for m in MODEL_PREFS if m in avail]
    # 선호 목록에 없으면, 지원 목록에서 flash/lite 계열을 직접 추린다.
    extra = [m for m in avail
             if ("flash" in m or "lite" in m)
             and not any(b in m for b in MODEL_AVOID)
             and m not in order]
    extra.sort(key=lambda m: ("preview" in m or "exp" in m, len(m)))
    order += extra
    if not order:
        return None, [], "쓸 수 있는 flash/lite 모델이 없습니다(사용 가능: %s)" % ", ".join(avail[:8])
    return order[0], order, "models.list 로 확인한 %d개 중 선택" % len(avail)


def _macro_lines(macro):
    out = []
    for m in macro.get("items") or []:
        s = "- %s: %s%s (기준 %s)" % (m["label"], m["value"], m.get("unit") or "", m["asOf"])
        if m.get("yoyPct") is not None:
            s += " · 전년동월비 %+.2f%%" % m["yoyPct"]
        elif m.get("yoyPp") is not None:
            s += " · 전년동월비 %+.2f%%p" % m["yoyPp"]
        elif m.get("change") is not None:
            s += " · 직전대비 %+.4g" % m["change"]
        s += " [출처 %s]" % m["url"]
        out.append(s)
    return out


def _rate_lines(rates):
    out = []
    for c in rates.get("cards") or []:
        if c.get("status") != "ok":
            continue
        st = c["stats"]
        out.append(
            "- %s(%s): 현재 %.2f원 (기준 %s), 전일대비 %+.2f원 %+.2f%% / "
            "3개월 최고 %.2f 최저 %.2f 평균 %.2f / 12개월 최고 %.2f 최저 %.2f / 배지: %s"
            % (c["name"], c["unit"], c["now"], c["asOf"], c["change"] or 0,
               c["changePct"] or 0, st["high3m"], st["low3m"], st["avg3m"],
               st["high12m"], st["low12m"],
               ", ".join(b["text"] for b in c.get("badges") or []) or "없음"))
    return out


def build_sources(rates, macro, news):
    """출처에 짧은 번호(S1, S2 …)를 붙인다.
       ★ 모델에게 긴 URL 을 베껴 쓰게 하면 안 된다 — 구글 뉴스 링크는 base64 로
         200자가 넘어서, 실제로 6개 요인 중 2개가 URL 을 틀리게 옮겨 적어
         검증에서 떨어졌다. 번호만 돌려받아 파이썬이 URL 로 바꾸면 베껴 쓸
         일이 없어 링크가 틀릴 수가 없다."""
    src, n = {}, 0
    for m in (macro.get("items") or []):
        n += 1
        src["S%d" % n] = {"url": m["url"], "label": "%s (%s)" % (m["label"], m["source"])}
    for it in (news.get("items") or []):
        n += 1
        src["S%d" % n] = {"url": it["link"],
                          "label": "%s — %s" % (it["title"], it.get("media") or it.get("feed"))}
    if rates.get("sourceUrl"):
        n += 1
        src["S%d" % n] = {"url": rates["sourceUrl"], "label": "환율 시세 (Frankfurter)"}
    return src


def build_prompt(rates, macro, news, sources):
    news_lines = []
    id_by_url = {v["url"]: k for k, v in sources.items()}
    for it in (news.get("items") or []):
        news_lines.append("- [%s] %s (%s) [출처 %s]"
                          % (it.get("media") or it.get("feed"), it["title"],
                             it.get("published") or "날짜미상",
                             id_by_url.get(it["link"], "?")))
    return (
        "너는 원/달러 환율을 다루는 외환 애널리스트다. 아래는 코드가 공개 소스에서 "
        "그대로 받아 온 자료다. 이것만 근거로 한국어 분석을 작성하라.\n\n"
        "[환율 현황]\n%s\n\n[거시지표]\n%s\n\n[관련 뉴스 헤드라인]\n%s\n\n"
        "작성 규칙(반드시 지켜라):\n"
        "1. 위에 제시된 숫자만 사용하라. 제시되지 않은 수치를 새로 만들지 마라. "
        "특정 환율 목표치나 전망 레인지 숫자를 지어내지 마라.\n"
        "2. 'sourceId' 에는 아래 '출처 목록' 의 번호(S1, S2 …)를 그대로 하나만 적어라. "
        "URL 을 직접 쓰지 마라. 목록에 없는 번호를 쓰면 링크가 삭제된다.\n"
        "3. 'upsideLimiters' 는 원/달러 환율의 상승(원화 약세)을 제한하는 요인, 즉 "
        "환율 상단을 누르는 재료다(예: 달러 약세 재료, 외국인 자금 유입, 수출 호조).\n"
        "4. 'downsideSupports' 는 환율의 하락을 막고 하단을 지지하는 요인, 즉 "
        "환율 하단을 받치는 재료다(예: 미 금리 상승, 위험회피, 수입 결제 수요). "
        "3번과 4번은 서로 반대 방향의 힘이다 — 같은 내용을 양쪽에 쓰지 마라.\n"
        "5. 각 요인은 3~4개. 'point' 는 15자 내외 제목, 'evidence' 는 위 자료를 "
        "인용한 1~2문장 근거.\n"
        "6. 'outlook.direction' 은 3번과 4번의 균형으로 판단하라. 양쪽이 팽팽하면 "
        "'박스권'. 'rationale' 에 그렇게 본 이유를 2~3문장으로 쓰되, 구체적 목표 "
        "환율 숫자는 제시하지 마라.\n"
        "7. 'current' 는 지금 환율 상태를 사실만으로 2~3문장 서술. 원인 추정은 넣지 마라.\n"
        "8. 단정하지 말고 '~로 보인다', '~할 전망' 같은 추정 어조를 쓰라.\n"
        "9. 투자 권유·매매 조언을 쓰지 마라.\n"
        % ("\n".join(_rate_lines(rates)) or "(없음)",
           "\n".join(_macro_lines(macro)) or "(없음)",
           "\n".join(news_lines) or "(없음)")
    ) + "\n출처 목록(sourceId 로 쓸 번호):\n" + "\n".join(
        "- %s: %s" % (k, sources[k]["label"][:140])
        for k in sorted(sources, key=lambda x: int(x[1:]))) + "\n"


def _strip_fence(text):
    """```json ... ``` 코드펜스를 벗긴다. responseSchema 를 쓰면 보통 없지만,
       모델이 붙여 보내는 경우가 있어 방어한다."""
    s = (text or "").strip()
    s = re.sub(r"^\s*```(?:json)?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*```\s*$", "", s)
    return s.strip()


def _clean_analysis(data, sources):
    """모델 출력 정리: 타입 확인 + 개수 제한 + 출처 번호를 URL 로 치환.
       번호가 목록에 없으면(환각) 링크 없이 둔다 — 문장은 살리되 잘못된 링크는
       달지 않는다. 무엇을 떨어뜨렸는지는 로그에 남긴다(조용히 지우지 않는다)."""
    def factors(key):
        out = []
        for f in (data.get(key) or [])[:4]:
            if not isinstance(f, dict):
                continue
            point = str(f.get("point") or "").strip()
            ev = str(f.get("evidence") or "").strip()
            if not point or not ev:
                continue
            item = {"point": point[:60], "evidence": ev[:400]}
            sid = str(f.get("sourceId") or "").strip().upper()
            m = re.search(r"S\d+", sid)
            sid = m.group(0) if m else sid       # 'S3 (뉴스)' 같은 군더더기 제거
            if sid in sources:
                item["sourceUrl"] = sources[sid]["url"]
                item["sourceLabel"] = sources[sid]["label"][:120]
            else:
                # 구버전 응답(URL 직접 기입)도 받아 준다 — 목록에 있으면 인정.
                url = str(f.get("sourceUrl") or "").strip()
                by_url = {v["url"]: v for v in sources.values()}
                if url in by_url:
                    item["sourceUrl"] = url
                    item["sourceLabel"] = by_url[url]["label"][:120]
                elif sid or url:
                    print("[fx] 출처 검증 실패 → 링크 생략: %s" % (sid or url)[:80])
            out.append(item)
        return out

    ol = data.get("outlook") or {}
    direction = str(ol.get("direction") or "").strip()
    if direction not in ("박스권", "상승", "하락"):
        direction = "박스권"
    conf = str(ol.get("confidence") or "").strip()
    if conf not in ("높음", "중간", "낮음"):
        conf = "중간"
    up, down = factors("upsideLimiters"), factors("downsideSupports")
    if not up and not down:
        return None
    return {
        "status": "ok",
        "current": str(data.get("current") or "").strip()[:600],
        "upsideLimiters": up,
        "downsideSupports": down,
        "outlook": {"direction": direction,
                    "rationale": str(ol.get("rationale") or "").strip()[:600],
                    "confidence": conf},
    }


def gemini_analyze(rates, macro, news, want_model=None):
    """Gemini 로 해석 생성. 실패하면 status=error 와 이유만 담아 돌려준다
       (화면이 '왜 비었는지' 말할 수 있게 — 조용히 비우지 않는다)."""
    key = _load_env_key("GEMINI_API_KEY")
    if not key:
        return {"status": "error",
                "reason": "GEMINI_API_KEY가 설정되지 않았습니다 "
                          "(.env 또는 GitHub Secrets에 등록하세요)"}, None
    model, order, memo = pick_model(key, want_model or os.environ.get("GEMINI_MODEL"))
    print("[fx] 모델 선택: %s (%s)" % (model, memo))
    if not model:
        return {"status": "error", "reason": "쓸 수 있는 Gemini 모델을 찾지 못했습니다: %s" % memo}, None

    sources = build_sources(rates, macro, news)
    prompt = build_prompt(rates, macro, news, sources)
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            # ★ Gemini 3.x 의 '풀' Flash 는 사고(thinking) 토큰을 이 한도에서 먼저
            #   쓴다. 2400 으로 두니 사고에 2300 을 쓰고 출력에 81 토큰만 남아
            #   JSON 이 잘렸다(finishReason=MAX_TOKENS). 8192 면 사고 4259 +
            #   출력 1110 으로 정상 완료된다 — 실측해서 잡은 값이다.
            #   thinkingConfig.thinkingBudget=0 은 이 모델이 400 으로 거부한다.
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
            "responseSchema": ANALYSIS_SCHEMA,
        },
    }
    hdr = dict(HDR, **{"x-goog-api-key": key, "content-type": "application/json"})
    errors = []
    for mdl in order[:4]:
        url = "%s/models/%s:generateContent" % (GEM_BASE, mdl)
        for attempt in range(3):
            try:
                r = requests.post(url, headers=hdr, json=body, timeout=90)
                if r.status_code in (404, 400) and attempt == 0:
                    # 이 모델을 이 키로 못 쓰거나 스키마를 안 받는다 → 다음 모델
                    errors.append({"model": mdl, "error": "HTTP %s %s"
                                   % (r.status_code, r.text[:140])})
                    break
                if r.status_code in (429, 500, 503):
                    wait = 4 * (2 ** attempt)
                    print("[fx] %s HTTP %s → %d초 후 재시도" % (mdl, r.status_code, wait))
                    errors.append({"model": mdl, "error": "HTTP %s" % r.status_code})
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                d = r.json()
                fb = d.get("promptFeedback") or {}
                if fb.get("blockReason"):
                    errors.append({"model": mdl, "error": "안전 필터 차단: %s" % fb["blockReason"]})
                    break
                cands = d.get("candidates") or []
                if not cands:
                    errors.append({"model": mdl, "error": "candidates 비어 있음"})
                    break
                cand = cands[0]
                text = "".join(p.get("text", "")
                               for p in (cand.get("content") or {}).get("parts") or [])
                if cand.get("finishReason") == "MAX_TOKENS" and not text.strip():
                    errors.append({"model": mdl, "error": "출력 토큰 상한에서 잘렸습니다"})
                    break
                parsed = json.loads(_strip_fence(text))
                cleaned = _clean_analysis(parsed, sources)
                if not cleaned:
                    errors.append({"model": mdl, "error": "요인이 비어 있어 사용하지 않음"})
                    break
                usage = d.get("usageMetadata") or {}
                cleaned["model"] = mdl
                cleaned["tokens"] = usage.get("totalTokenCount")
                print("[fx] 해석 생성 성공 — %s · 상단제한 %d개 · 하단지지 %d개 · %s"
                      % (mdl, len(cleaned["upsideLimiters"]),
                         len(cleaned["downsideSupports"]), cleaned["outlook"]["direction"]))
                return cleaned, mdl
            except json.JSONDecodeError as e:
                errors.append({"model": mdl, "error": "JSON 파싱 실패: %s" % e})
                break
            except Exception as e:  # noqa: BLE001
                errors.append({"model": mdl, "error": str(e)[:160]})
                if attempt < 2:
                    time.sleep(4 * (2 ** attempt))
                    continue
                break
        print("[fx] 모델 %s 실패 → 다음 후보" % mdl)
    return {"status": "error",
            "reason": "Gemini 해석 실패: %s" % (errors[-1]["error"] if errors else "원인 미기록"),
            "errors": errors[:6]}, None


# ── 조립 ──────────────────────────────────────────────────────────────────
def collect(use_ai=True, want_model=None):
    now = datetime.datetime.now(KST)
    rates = fetch_rates()
    if rates.get("status") != "ok":
        return {"status": "error", "reason": rates.get("reason"),
                "generatedAt": now.isoformat(timespec="seconds")}
    print("[fx] 시세 OK — 기준 %s · %d영업일"
          % (rates["asOf"], len(rates["series"]["dates"])))
    macro = fetch_macro()
    print("[fx] 거시 %d개 수집(실패 %d개)" % (len(macro["items"]), len(macro["errors"])))
    news = fetch_news()
    print("[fx] 뉴스 %d건 수집(실패 %d개)" % (len(news["items"]), len(news["errors"])))

    analysis, model = ({"status": "skipped", "reason": "--no-ai 로 실행"}, None)
    if use_ai:
        analysis, model = gemini_analyze(rates, macro, news, want_model)

    return {
        "status": "ok",
        "generatedAt": now.isoformat(timespec="seconds"),
        "asOf": rates["asOf"],
        "cards": rates["cards"],
        "series": rates["series"],
        "rateSource": rates["source"],
        "rateSourceUrl": rates["sourceUrl"],
        "macro": macro,
        "news": news,
        "analysis": analysis,
        "model": model,
        "badgeRule": {"spikePct": BADGE_SPIKE_PCT, "movePct": BADGE_MOVE_PCT,
                      "window": HIGH_LOW_WINDOW},
    }


def _existing_ok(path):
    """이미 있는 결과 파일이 '쓸 만한 데이터'인지 본다(status ok + 카드 있음)."""
    try:
        with io.open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001 — 없거나 깨졌으면 지킬 것도 없다
        return None
    if d.get("status") == "ok" and (d.get("cards") or []):
        return d
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-ai", action="store_true", help="Gemini 호출 없이 시세·거시·뉴스만")
    ap.add_argument("--model", default=None, help="Gemini 모델 직접 지정")
    ap.add_argument("--list-models", action="store_true", help="쓸 수 있는 모델만 출력")
    ap.add_argument("--probe", action="store_true", help="진단만 — 결과 파일을 쓰지 않는다")
    ap.add_argument("--force", action="store_true", help="실패해도 기존 파일을 덮어쓴다")
    a = ap.parse_args()

    if a.list_models:
        key = _load_env_key("GEMINI_API_KEY")
        if not key:
            print("GEMINI_API_KEY 가 없습니다 (.env 확인)")
            return 1
        try:
            names = list_models(key)
        except Exception as e:  # noqa: BLE001
            print("models.list 실패: %s" % e)
            return 1
        print("generateContent 지원 모델 %d개:" % len(names))
        for n in names:
            print("  %s%s" % (n, "   <- 선호" if n in MODEL_PREFS else ""))
        mdl, order, memo = pick_model(key)
        print("선택: %s (%s)" % (mdl, memo))
        print("시도 순서: %s" % ", ".join(order[:5]))
        return 0

    out = a.out or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                *OUT_REL.split("/"))
    res = collect(use_ai=not a.no_ai, want_model=a.model)

    print("status : %s" % res.get("status"))
    if res.get("status") == "ok":
        for c in res["cards"]:
            if c.get("status") == "ok":
                print("  %s %10.2f원  전일대비 %+7.2f (%+.2f%%)  %s"
                      % (c["cur"], c["now"], c["change"] or 0, c["changePct"] or 0,
                         " ".join(b["text"] for b in c.get("badges") or [])))
        an = res.get("analysis") or {}
        print("  해석 : %s%s" % (an.get("status"),
                              "" if an.get("status") == "ok"
                              else " — %s" % an.get("reason")))
        if an.get("status") == "ok":
            print("  전망 : %s (확신 %s)" % (an["outlook"]["direction"],
                                          an["outlook"]["confidence"]))

    # ★ --probe 는 진단이다. 결과 파일에 쓰지 않는다.
    if a.probe and not a.out:
        print("probe  : 진단만 수행 — %s 는 건드리지 않았습니다" % OUT_REL)
        return 0 if res.get("status") == "ok" else 1

    # ★★ 수집이 실패했으면 이미 있는 정상 데이터를 덮지 않는다(KIPRIS 와 같은 규칙).
    #   키가 없거나 한도를 넘긴 '한 번의 실패'가 배포된 화면을 비우면,
    #   고칠 때까지 대시보드가 빈 채로 서비스된다.
    if res.get("status") != "ok" and not a.force:
        keep = _existing_ok(out)
        if keep:
            print("reason : %s" % res.get("reason"))
            print("keep   : 기존 정상 데이터(%s, 카드 %d개)를 유지했습니다 — 덮어쓰지 않음"
                  % (keep.get("generatedAt"), len(keep.get("cards") or [])))
            print("         덮어쓰려면 --force")
            return 1

    # ★★★ 시세는 받았는데 해석만 실패한 경우: 기존 파일에 쓸 만한 해석이 있으면
    #   그것을 살려 둔다(생성 시각을 함께 남겨 언제 기준인지 알 수 있게).
    if (res.get("status") == "ok"
            and (res.get("analysis") or {}).get("status") != "ok" and not a.force):
        prev = _existing_ok(out)
        prev_an = (prev or {}).get("analysis") or {}
        if prev_an.get("status") == "ok":
            res["analysis"] = dict(prev_an, stale=True,
                                   staleReason=(res.get("analysis") or {}).get("reason"),
                                   generatedAt=prev.get("generatedAt"))
            print("keep   : 해석 생성 실패 → 이전 해석(%s)을 유지했습니다"
                  % prev.get("generatedAt"))

    d = os.path.dirname(out)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with io.open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps(res, ensure_ascii=False, indent=2) + "\n")

    if res.get("status") != "ok":
        print("reason : %s" % res.get("reason"))
        print("saved  : %s" % out)
        return 1
    print("saved  : %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
