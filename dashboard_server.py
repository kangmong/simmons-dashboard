# -*- coding: utf-8 -*-
"""
SIMMONS 대시보드 백엔드 — World Bank 핑크시트(월간 원자재 가격) 실시간 업데이트.
API 키 없이 공개 xlsx만 사용한다.

실행:
    pip install flask requests pandas openpyxl
    python dashboard_server.py
    브라우저에서 http://127.0.0.1:5000 접속

정적 파일(index.html/app.js/styles.css/*.csv)도 이 서버가 함께 서빙하므로
프런트의 fetch('/api/update') 가 같은 출처로 동작한다(CORS 불필요).
"""
import io
import re
import datetime
import urllib.parse
import xml.etree.ElementTree as ET

import requests
import pandas as pd
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)  # 대시보드가 다른 주소(예: http-server)에서 열려도 /api 호출 허용

# ── 핑크시트 위치 (링크가 바뀌면 여기만 교체) ─────────────────────────────
# 출처: https://www.worldbank.org/en/research/commodity-markets 의 Monthly prices xlsx
PINK_SHEET_URL = (
    "https://thedocs.worldbank.org/en/doc/"
    "5d903e848db1d1b83e0ec8f744e55570-0350012021/related/"
    "CMO-Historical-Data-Monthly.xlsx"
)
SHEET_NAME = "Monthly Prices"
DATE_RE = re.compile(r"^\d{4}M\d{2}$")  # 예: 2026M06

# 표시 원자재:  (화면 이름, 핑크시트 컬럼 부분일치, 단위)
MATERIALS = [
    ("원유(WTI)", "Crude oil, WTI", "USD/배럴"),
    ("면", "Cotton, A", "USD/kg"),
    ("천연고무", "Rubber", "USD/kg"),
    ("천연가스", "Natural gas, US", "USD/mmbtu"),
]


def _download_pink_sheet():
    """핑크시트 xlsx 원본 바이트를 반환. 실패 시 예외."""
    resp = requests.get(PINK_SHEET_URL, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    return resp.content


def _find_header_row(raw):
    """첫 15행 중 'Crude oil' 또는 'Cotton' 이 들어간 행 번호를 헤더로 자동 탐지."""
    preview = pd.read_excel(io.BytesIO(raw), sheet_name=SHEET_NAME, header=None, nrows=15, engine="openpyxl")
    for i in range(len(preview)):
        rowvals = " ".join(str(v) for v in preview.iloc[i].tolist())
        if "Crude oil" in rowvals or "Cotton" in rowvals:
            return i
    return None


def fetch_materials():
    """원자재 섹션 데이터. 한 항목 실패해도 나머지는 정상 반환. 파일 실패면 status=error."""
    # 1) 다운로드
    try:
        raw = _download_pink_sheet()
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "핑크시트 다운로드 실패: %s" % e}

    # 2) 파싱 (헤더 자동 탐지)
    try:
        header_row = _find_header_row(raw)
        if header_row is None:
            return {"status": "error", "reason": "헤더 행(Crude oil/Cotton)을 찾지 못했습니다"}
        df = pd.read_excel(io.BytesIO(raw), sheet_name=SHEET_NAME, header=header_row, engine="openpyxl")
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "엑셀 파싱 실패: %s" % e}

    # 3) 첫 컬럼(날짜)에서 YYYYMxx 형식 행만 사용
    try:
        date_col = df.columns[0]
        dates = df[date_col].astype(str).str.strip()
        data = df[dates.str.match(DATE_RE)].reset_index(drop=True)
        if len(data) < 1:
            return {"status": "error", "reason": "날짜(YYYYMxx) 형식 데이터 행이 없습니다"}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "날짜 컬럼 처리 실패: %s" % e}

    latest = data.iloc[-1]
    prev = data.iloc[-2] if len(data) >= 2 else None
    period = str(latest[date_col]).strip()

    def find_col(partial):
        low = partial.lower()
        for c in df.columns:
            if low in str(c).lower():
                return c
        return None

    def to_float(v):
        try:
            return float(v) if pd.notna(v) else None
        except Exception:  # noqa: BLE001
            return None

    rows = []
    for label, partial, unit in MATERIALS:
        col = find_col(partial)
        if col is None:
            rows.append({"label": label, "unit": unit, "value": None,
                         "period": period, "change_pct": None, "status": "missing"})
            continue
        try:
            val = to_float(latest[col])
            change = None
            if prev is not None and val is not None:
                pv = to_float(prev[col])
                if pv not in (None, 0):
                    change = round((val - pv) / pv * 100.0, 1)
            rows.append({
                "label": label, "unit": unit,
                "value": round(val, 2) if val is not None else None,
                "period": period, "change_pct": change,
                "status": "ok" if val is not None else "missing",
            })
        except Exception as e:  # noqa: BLE001
            rows.append({"label": label, "unit": unit, "value": None,
                         "period": period, "change_pct": None, "status": "error"})

    # ── 추이용 시계열: 최근 12개월 ──
    tail = data.tail(12).reset_index(drop=True)
    periods = [str(v).strip() for v in tail[date_col].tolist()]
    series = {"periods": periods}
    for label, partial, unit in MATERIALS:
        col = find_col(partial)
        if col is None:
            series[label] = [None] * len(periods)
            continue
        vals = []
        for _, row in tail.iterrows():
            v = to_float(row[col])
            vals.append(round(v, 2) if v is not None else None)
        series[label] = vals

    return {"status": "ok", "period": period, "rows": rows, "series": series}


# ── 해외 시장(수요 잠재력) — World Bank Open Data (API 키 불필요) ──────────
WB_INDICATORS = [
    ("population", "인구", "명", "SP.POP.TOTL"),
    ("gdp_percap", "1인당 GDP", "USD", "NY.GDP.PCAP.CD"),
    ("consumption", "가계소비지출", "USD", "NE.CON.PRVT.CD"),
]

# 집계 지역(국가가 아닌 그룹) iso3 코드 — 지도에 안 쓰이므로 제외
WB_AGGREGATES = frozenset([
    "WLD", "ARB", "CEB", "CSS", "EAP", "EAR", "EAS", "ECA", "ECS", "EMU", "EUU",
    "FCS", "HIC", "HPC", "IBD", "IBT", "IDA", "IDB", "IDX", "INX", "LAC", "LCN",
    "LDC", "LIC", "LMC", "LMY", "LTE", "MEA", "MIC", "MNA", "NAC", "OED", "OSS",
    "PRE", "PSS", "PST", "SAS", "SSA", "SSF", "SST", "TEA", "TEC", "TLA", "TMN",
    "TSA", "TSS", "UMC", "AFE", "AFW", "EAR",
])


def _wb_fetch_indicator(code):
    """World Bank 지표 코드 → ({iso3: value}, 대표연도). mrnev=1 = 각국 최신값."""
    url = ("https://api.worldbank.org/v2/country/all/indicator/%s"
           "?format=json&per_page=400&mrnev=1" % code)
    resp = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    js = resp.json()
    data, latest_year = {}, None
    if isinstance(js, list) and len(js) >= 2 and js[1]:
        for rec in js[1]:
            iso3 = (rec.get("countryiso3code") or "").strip()
            val = rec.get("value")
            yr = rec.get("date")
            # iso3 없는/집계 지역 제외
            if len(iso3) != 3 or iso3 in WB_AGGREGATES:
                continue
            if val is None:
                continue
            data[iso3] = val
            if yr and (latest_year is None or yr > latest_year):
                latest_year = yr
    return data, (latest_year or "")


def update_market():
    """해외 시장 수요 잠재력 지표. 한 지표만 실패해도 나머지는 반환."""
    indicators = {}
    any_ok = False
    for key, label, unit, code in WB_INDICATORS:
        try:
            data, year = _wb_fetch_indicator(code)
            if data:
                indicators[key] = {"label": label, "unit": unit, "data": data, "year": year}
                any_ok = True
            else:
                indicators[key] = {"label": label, "unit": unit, "data": {}, "year": "", "error": "no data"}
        except Exception as e:  # noqa: BLE001
            indicators[key] = {"label": label, "unit": unit, "data": {}, "year": "", "error": str(e)}

    # ── 조합 지표: 가구 소비력(소비시장 규모) ──
    # 가계소비지출 총액(NE.CON.PRVT.CD)을 그대로 쓰고, 없는 나라는
    # 인구(SP.POP.TOTL) × 1인당 가계소비(NE.CON.PRVT.PC.KD)로 채운다.
    try:
        pop = indicators.get("population", {}).get("data", {})
        cons = indicators.get("consumption", {}).get("data", {})
        percap, pc_year = _wb_fetch_indicator("NE.CON.PRVT.PC.KD")
        cp = {}
        for iso, v in cons.items():
            if v is not None:
                cp[iso] = v
        for iso in (set(pop) & set(percap)):
            if iso not in cp:
                cp[iso] = pop[iso] * percap[iso]
        cp_year = (indicators.get("consumption", {}).get("year")
                   or indicators.get("population", {}).get("year") or pc_year)
        if cp:
            indicators["consumer_power"] = {"label": "가구 소비력(소비시장 규모)", "unit": "USD",
                                            "data": cp, "year": cp_year}
            any_ok = True
        else:
            indicators["consumer_power"] = {"label": "가구 소비력(소비시장 규모)", "unit": "USD",
                                            "data": {}, "year": "", "error": "no data"}
    except Exception as e:  # noqa: BLE001
        indicators["consumer_power"] = {"label": "가구 소비력(소비시장 규모)", "unit": "USD",
                                        "data": {}, "year": "", "error": str(e)}

    if not any_ok:
        return {"status": "error", "reason": "World Bank 지표를 하나도 받지 못했습니다"}
    return {"status": "ok", "indicators": indicators}


# ── 업계 주요 뉴스 — Google News RSS (API 키 불필요) ─────────────────────
NEWS_RSS_URL = "https://news.google.com/rss/search?q=mattress+industry&hl=en-US&gl=US&ceid=US:en"


def _fmt_pubdate(s):
    """RFC822 pubDate → 'YYYY-MM-DD'."""
    s = (s or "").strip()
    for fmt in ("%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S %z"):
        try:
            return datetime.datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            pass
    return s[:16]


def _translate_ko(text):
    """영어 → 한국어 (Google 번역 비공식 엔드포인트, 키 불필요). 실패 시 원문 반환."""
    text = (text or "").strip()
    if not text:
        return text
    try:
        url = ("https://translate.googleapis.com/translate_a/single"
               "?client=gtx&sl=en&tl=ko&dt=t&q=" + urllib.parse.quote(text))
        resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        segments = resp.json()[0]  # [[번역, 원문, ...], ...]
        out = "".join(seg[0] for seg in segments if seg and seg[0])
        return out or text
    except Exception:  # noqa: BLE001
        return text  # 번역 실패 시 원문(영어)이라도 보이게


def update_news():
    """매트리스 업계 뉴스 최신 3건 (Google News RSS) + 제목 한국어 번역. 한 건도 못 받으면 error."""
    try:
        resp = requests.get(NEWS_RSS_URL, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "뉴스 RSS 실패: %s" % e}

    items = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = item.findtext("pubDate") or ""
        src_el = item.find("source")
        source = (src_el.text.strip() if (src_el is not None and src_el.text) else "")
        if not title:
            continue
        items.append({"title": title, "link": link, "source": source, "date": _fmt_pubdate(pub)})
        if len(items) >= 3:
            break

    if not items:
        return {"status": "error", "reason": "뉴스 항목을 받지 못했습니다"}

    # 제목 영어 → 한국어 번역 (번역만, 요약 없음)
    for it in items:
        it["title_ko"] = _translate_ko(it["title"])
    return {"status": "ok", "items": items}


# ── 국내 브랜드 신제품 — Google News RSS (한국어, 무료·무키) ─────────────
# 시몬스 제외 국내 매트리스·가구 브랜드. 브랜드명 + (신제품 OR 출시 OR 론칭)으로 검색.
DOMESTIC_BRANDS = ["에이스침대", "씰리", "한샘", "이케아"]

# 브랜드 공식 도메인 → 무료 로고 서비스(Clearbit, 키 불필요)로 로고 URL 생성.
# 기사 사진이 없을 때 프런트에서 이 주소를 img src 로 바로 사용한다.
BRAND_DOMAINS = {
    "에이스침대": "acebed.com",
    "씰리": "sealy.co.kr",
    "한샘": "hanssem.com",
    "이케아": "ikea.com",
}


def _brand_logo(brand):
    """1순위 로고: Clearbit(무료·무키). ※ 참고: Clearbit 무료 로고 API는 현재
       DNS가 해석되지 않을 때가 있어, 프런트에서 logo_fallback(구글 파비콘)으로 자동 대체한다."""
    dom = BRAND_DOMAINS.get(brand)
    return ("https://logo.clearbit.com/" + dom) if dom else None


def _brand_logo_fallback(brand):
    """폴백 로고: 구글 파비콘 서비스(무료·무키). Clearbit 실패 시 사용."""
    dom = BRAND_DOMAINS.get(brand)
    return ("https://www.google.com/s2/favicons?sz=128&domain=" + dom) if dom else None


# og:image 두 가지 속성 순서(content 앞/뒤) 모두 대응
_OG_IMAGE_RE = [
    re.compile(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', re.I),
]


# Google News 링크는 자체 뷰어의 일반 로고(lh3.googleusercontent 등)만 노출하므로,
# 아래 도메인의 이미지는 "대표 이미지 아님"으로 보고 버린다(→ 프런트에서 브랜드 이니셜로 대체).
_GENERIC_IMG_HOSTS = ("googleusercontent.com", "gstatic.com", "google.com")


def _og_image(url):
    """기사 링크에서 <meta property="og:image"> 값을 추출. 실패/일반로고면 None(에러 내지 않음)."""
    if not url:
        return None
    try:
        r = requests.get(url, timeout=5, allow_redirects=True,
                         headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        html = r.text
        for rx in _OG_IMAGE_RE:
            m = rx.search(html)
            if m:
                img = m.group(1).strip()
                if not img.startswith("http"):
                    continue
                host = urllib.parse.urlparse(img).netloc.lower()
                if any(h in host for h in _GENERIC_IMG_HOSTS):
                    return None  # 구글 뷰어 일반 로고 → 대표 이미지로 쓰지 않음
                return img
    except Exception:  # noqa: BLE001 — 이미지 실패는 조용히 넘어감
        pass
    return None


# RSS <item> 안의 이미지 태그(media:content / media:thumbnail / enclosure)
_MRSS = "{http://search.yahoo.com/mrss/}"


def _rss_media(item):
    """RSS item 의 media:content/thumbnail 또는 이미지 enclosure URL. 없으면 None."""
    try:
        for tag in (_MRSS + "content", _MRSS + "thumbnail"):
            el = item.find(tag)
            if el is not None and el.get("url", "").startswith("http"):
                return el.get("url")
        enc = item.find("enclosure")
        if enc is not None and enc.get("url", "").startswith("http") \
                and "image" in (enc.get("type") or "image"):
            return enc.get("url")
    except Exception:  # noqa: BLE001
        pass
    return None


def _product_name(title, brand, source):
    """기사 제목에서 상품명 추출: 따옴표 안 텍스트 우선 → 없으면 '- 언론사' 제거 + 앞 '브랜드,' 제거."""
    t = (title or "").strip()
    # 1) 따옴표(' ' " " ‘ ’ “ ”) 안 텍스트
    m = re.search(r'[\'"‘’“”]([^\'"‘’“”]{2,})[\'"‘’“”]', t)
    if m:
        return m.group(1).strip()
    # 2) 뒤쪽 " - 언론사" 제거
    if source and t.endswith(" - " + source):
        t = t[:-(len(source) + 3)]
    else:
        t = re.sub(r'\s*[-–—]\s*[^-–—]+$', '', t)
    # 3) 앞쪽 "브랜드," 제거
    if brand:
        t = re.sub(r'^\s*' + re.escape(brand) + r'\s*[,·:\-]?\s*', '', t)
    return t.strip() or (title or "").strip()


def update_domestic():
    """브랜드별 신제품/출시 뉴스를 모아 전체 최신순 상위 6개 반환.
       한 브랜드 검색이 실패해도 나머지는 반환. 전부 실패면 status=error."""
    collected = []
    media_by_link = {}  # link -> RSS 미디어(media:content/enclosure) 이미지 URL
    for brand in DOMESTIC_BRANDS:
        try:
            q = '"%s" (신제품 OR 출시 OR 론칭)' % brand
            url = ("https://news.google.com/rss/search?q=" + urllib.parse.quote(q)
                   + "&hl=ko&gl=KR&ceid=KR:ko")
            resp = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
        except Exception:  # noqa: BLE001 — 한 브랜드 실패해도 계속
            continue
        cnt = 0
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            if not title:
                continue
            link = (item.findtext("link") or "").strip()
            pub = item.findtext("pubDate") or ""
            src_el = item.find("source")
            source = (src_el.text.strip() if (src_el is not None and src_el.text) else "")
            media = _rss_media(item)  # RSS 안 이미지 태그(og:image 실패 시 폴백)
            if link and media:
                media_by_link[link] = media
            collected.append({"brand": brand, "title": title, "source": source,
                              "date": _fmt_pubdate(pub), "link": link,
                              "product_name": _product_name(title, brand, source)})
            cnt += 1
            if cnt >= 2:  # 브랜드별 최신 1~2개
                break

    if not collected:
        return {"status": "error", "reason": "국내 브랜드 뉴스를 받지 못했습니다"}

    collected.sort(key=lambda x: x["date"], reverse=True)  # 날짜 최신순

    # 이미지 해석(링크별 1회 캐시): 최종 기사까지 리다이렉트 추적 og:image → 없으면 RSS 미디어
    img_cache = {}

    def _resolve_img(link):
        if link not in img_cache:
            img_cache[link] = _og_image(link) or media_by_link.get(link)
        return img_cache[link]

    # 전체 목록: 최신순 상위 6개
    items = collected[:6]
    for it in items:
        it["image"] = _resolve_img(it["link"])

    # 대표 상품(featured): 브랜드당 최신 1건만 → 최신순 → 상위 3개 (브랜드 중복 없음)
    best = {}
    for it in collected:  # 이미 최신순이라 브랜드별 첫 등장이 그 브랜드의 최신 기사
        if it["brand"] not in best:
            best[it["brand"]] = it
    reps = sorted(best.values(), key=lambda x: x["date"], reverse=True)[:3]
    featured = [{"brand": it["brand"], "product_name": it.get("product_name"),
                 "image": _resolve_img(it["link"]),
                 "logo_url": _brand_logo(it["brand"]),
                 "logo_fallback": _brand_logo_fallback(it["brand"]),
                 "source": it["source"], "date": it["date"], "link": it["link"]}
                for it in reps]

    return {"status": "ok", "items": items, "featured": featured}


# ── 경쟁사 분석 — SEC EDGAR (무료·무키, 미국 상장사) ─────────────────────
# SEC 규칙: data.sec.gov / www.sec.gov 요청에는 반드시 User-Agent 헤더 필요(없으면 403)
SEC_HEADERS = {"User-Agent": "Simmons Dashboard contact@example.com"}
# 국외(Global) 경쟁사: (표시명, 티커, 폴백 CIK, 로고 도메인). CIK 매칭 실패 시 폴백 사용.
# 참고: SEC 파일상 Sleep Number 티커는 'SNBRQ', Tempur Sealy는 사명 변경(Somnigroup, CIK 1206264).
GLOBAL_COMPETITORS = [
    ("Sleep Number", "SNBR", 827187, "sleepnumber.com"),
    ("Tempur Sealy", "TPX", 1206264, "tempursealy.com"),
    ("Purple Innovation", "PRPL", 1643953, "purple.com"),
    ("Leggett & Platt", "LEG", 58492, "leggett.com"),
]
REVENUE_KEYS = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
]
_cik_cache = None


def _sec_get(url):
    resp = requests.get(url, timeout=30, headers=SEC_HEADERS)
    resp.raise_for_status()
    return resp.json()


def _load_cik_map():
    """티커(대문자) → CIK(int). company_tickers.json 1회 로드 후 캐시."""
    global _cik_cache
    if _cik_cache is not None:
        return _cik_cache
    data = _sec_get("https://www.sec.gov/files/company_tickers.json")
    m = {}
    for v in data.values():
        try:
            m[str(v.get("ticker", "")).upper()] = int(v.get("cik_str"))
        except Exception:  # noqa: BLE001
            pass
    _cik_cache = m
    return m


def _resolve_cik(ticker, cikmap, fallback):
    """티커 → CIK. 정확 매칭 → 접두 매칭(SNBR→SNBRQ) → 폴백."""
    t = str(ticker).upper()
    if t in cikmap:
        return cikmap[t]
    for k, v in cikmap.items():
        if k.startswith(t):
            return v
    return fallback


def _quarterly_series(facts, keys, unit="USD"):
    """분기(약 3개월, 10-Q) 값. return {(fy:int, fp:str): {'val','end','label'}}.
       10-Q 이고 기간이 ~90일(단일 분기)인 항목만 사용해 YTD(누적) 값을 배제한다."""
    usgaap = facts.get("facts", {}).get("us-gaap", {})
    for k in keys:
        node = usgaap.get(k)
        if not node:
            continue
        arr = node.get("units", {}).get(unit)
        if not arr:
            continue
        out = {}
        for d in arr:
            val, fp, form = d.get("val"), d.get("fp"), d.get("form")
            start, end, fy = d.get("start"), d.get("end"), d.get("fy")
            if val is None or not start or not end or form != "10-Q":
                continue
            if fp not in ("Q1", "Q2", "Q3", "Q4"):
                continue
            try:
                s = datetime.datetime.strptime(start, "%Y-%m-%d").date()
                e = datetime.datetime.strptime(end, "%Y-%m-%d").date()
            except Exception:  # noqa: BLE001
                continue
            if not (80 <= (e - s).days <= 100):  # 단일 분기(3개월)만 → YTD 제외
                continue
            key = (int(fy) if fy is not None else e.year, fp)
            if key not in out or e > out[key]["end"]:  # 정정치는 end 최신 우선
                out[key] = {"val": val, "end": e, "label": "%s %s" % (key[0], fp)}
        if out:
            return out
    return {}


def _quarter_metric(facts, keys):
    """가장 최근 분기의 (값, 전년 동기 대비 %, 라벨). 없으면 (None, None, None)."""
    qs = _quarterly_series(facts, keys)
    if not qs:
        return (None, None, None)
    latest = max(qs, key=lambda kk: qs[kk]["end"])
    val = qs[latest]["val"]
    fy, fp = latest
    prev = qs.get((fy - 1, fp))  # 전년 동일 분기
    yoy = None
    if prev and prev["val"]:
        yoy = round((val - prev["val"]) / abs(prev["val"]) * 100.0, 1)
    return (val, yoy, qs[latest]["label"])


def _logo_candidates(domain):
    """로고 자동 소스 후보(앞에서부터 시도, 프런트에서 onerror 체인으로 대체):
       1) Clearbit  2) Google 파비콘(고해상)  3) 도메인 파비콘 직접."""
    return [
        "https://logo.clearbit.com/%s" % domain,
        "https://www.google.com/s2/favicons?domain=%s&sz=128" % domain,
        "https://%s/favicon.ico" % domain,
    ]


def _usd_krw_rate():
    """경쟁사 금액(USD) → 원화 환산용 USD/KRW 환율. 실패 시 None(원화 표시 생략)."""
    try:
        r = requests.get("https://api.frankfurter.app/latest?from=USD&to=KRW",
                         timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        return r.json()["rates"]["KRW"]
    except Exception:  # noqa: BLE001
        return None


def update_competitors():
    """경쟁사 분석 — 국외(Global) 4곳의 최근 분기(10-Q) 매출·순이익 + 전년 동기 대비(YoY).
       국내(Korea)는 다음 단계(DART)에서 채우므로 준비중. 한 회사 실패해도 나머지 반환."""
    try:
        cikmap = _load_cik_map()
    except Exception:  # noqa: BLE001 — 티커 파일 실패해도 폴백 CIK로 진행
        cikmap = {}
    usd_krw = _usd_krw_rate()  # USD→KRW 환산 환율(없으면 None)

    glob, any_ok = [], False
    for name, ticker, fallback, domain in GLOBAL_COMPETITORS:
        entry = {"name": name, "ticker": ticker, "quarter": None,
                 "revenue": None, "revenue_yoy": None,
                 "net_income": None, "net_income_yoy": None,
                 "logo_urls": _logo_candidates(domain)}
        cik = _resolve_cik(ticker, cikmap, fallback)
        if cik is None:
            entry["error"] = "CIK 없음"
            glob.append(entry)
            continue
        try:
            facts = _sec_get("https://data.sec.gov/api/xbrl/companyfacts/CIK%s.json"
                             % str(cik).zfill(10))
            qrev, qrev_yoy, qlabel = _quarter_metric(facts, REVENUE_KEYS)
            qni, qni_yoy, qlabel2 = _quarter_metric(facts, ["NetIncomeLoss"])
            entry["quarter"] = qlabel or qlabel2
            entry["revenue"], entry["revenue_yoy"] = qrev, qrev_yoy
            entry["net_income"], entry["net_income_yoy"] = qni, qni_yoy
            if qrev is not None or qni is not None:
                any_ok = True
        except Exception as e:  # noqa: BLE001
            entry["error"] = str(e)
        glob.append(entry)

    korea = {"status": "준비중"}
    if not any_ok:
        return {"status": "error", "reason": "SEC 분기 데이터를 받지 못했습니다",
                "global": glob, "korea": korea, "usd_krw_rate": usd_krw}
    return {"status": "ok", "global": glob, "korea": korea, "usd_krw_rate": usd_krw}


# ── 환율 EUR/KRW — Frankfurter(ECB 기반, 무료·무키) ──────────────────────
def update_fx():
    """EUR/KRW 최신 환율 + 전일(직전 영업일) 대비 변화율 + 최근 5년 월별 추이.
       현재값 실패 시 error. 추이(series)만 실패하면 현재값은 그대로 반환."""
    base = "https://api.frankfurter.app"
    hdr = {"User-Agent": "Mozilla/5.0"}

    # 1) 현재값 + 기준일 (기준통화 EUR, 대상통화 KRW)
    try:
        lj = requests.get(base + "/latest?from=EUR&to=KRW", timeout=20, headers=hdr)
        lj.raise_for_status()
        lj = lj.json()
        rate = lj["rates"]["KRW"]
        date = lj["date"]
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "환율 조회 실패: %s" % e}

    # 2) 전일 대비: 최근 7일 시계열에서 직전 영업일 값으로 계산(주말·공휴일 대응)
    change = None
    try:
        start = (datetime.datetime.strptime(date, "%Y-%m-%d").date()
                 - datetime.timedelta(days=7)).isoformat()
        ser = requests.get(base + "/%s..%s?from=EUR&to=KRW" % (start, date), timeout=20, headers=hdr)
        ser.raise_for_status()
        rates = ser.json().get("rates", {})
        days = sorted(rates.keys())
        if len(days) >= 2:
            prev = rates[days[-2]].get("KRW")
            if prev:
                change = round((rate - prev) / prev * 100.0, 2)
    except Exception:  # noqa: BLE001 — 변화율만 실패해도 최신값은 반환
        change = None

    # 3) 최근 5년 추이: 일별은 과하므로 월 단위(각 달의 마지막 관측치)로 샘플링
    series = None
    try:
        end = datetime.datetime.strptime(date, "%Y-%m-%d").date()
        start5 = (end - datetime.timedelta(days=365 * 5)).isoformat()
        sr = requests.get(base + "/%s..%s?from=EUR&to=KRW" % (start5, end.isoformat()),
                          timeout=30, headers=hdr)
        sr.raise_for_status()
        rr = sr.json().get("rates", {})
        monthly = {}  # 'YYYY-MM' → (날짜, 값). 오름차순 순회이므로 뒤 값이 그 달의 최신
        for d in sorted(rr.keys()):
            v = rr[d].get("KRW")
            if v is not None:
                monthly[d[:7]] = (d, v)
        dates, values = [], []
        for ym in sorted(monthly.keys()):
            d, v = monthly[ym]
            dates.append(d)
            values.append(round(v, 2))
        if dates:
            series = {"dates": dates, "values": values}
    except Exception:  # noqa: BLE001 — 추이만 실패해도 현재값은 반환
        series = None

    out = {"status": "ok", "pair": "EUR/KRW", "rate": round(rate, 2),
           "change_pct": change, "date": date}
    if series:
        out["series"] = series
    return out


# 섹션별 fetcher — 버튼 한 번에 모두 실행. 추후 같은 패턴으로 확장 가능.
FETCHERS = {
    "materials": fetch_materials,
    "market": update_market,
    "news": update_news,
    "domestic": update_domestic,
    "competitors": update_competitors,
    "fx": update_fx,
}


@app.route("/api/update", methods=["GET", "POST"])
def api_update():
    sections = {}
    for name, fn in FETCHERS.items():
        try:
            sections[name] = fn()
        except Exception as e:  # noqa: BLE001
            sections[name] = {"status": "error", "reason": str(e)}
    updated_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return jsonify({"updated_at": updated_at, "sections": sections})


@app.route("/")
def index():
    return send_from_directory(".", "index.html")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
