# -*- coding: utf-8 -*-
"""국외(Global) 경쟁사 — 가격 티어 정의와 기업/브랜드 매핑 (단일 관리 지점).

★ 가격대·브랜드 구성·본사 소재지를 바꿀 일이 생기면 **이 파일만** 고친다.
  백엔드(dashboard_server.py / api/update.py)는 이 정의를 그대로 payload 에 실어
  보내고, 프런트(app.js)는 payload 를 읽어 화면을 만든다. 프런트에 티어 정보를
  중복 정의하지 않는다.

★★ 반드시 화면에 남겨야 하는 한계:
  기업 실적은 티어별로 공시되지 않는다(SEC 10-Q 는 연결 기준 전사 실적뿐).
  티어 필터는 "그 티어에 진출한 기업들의 전사 실적을 묶어 보는 것"이며
  그 티어만의 매출이 아니다. TIER_NOTE 를 필터 바로 아래에 상시 노출한다.
"""

# ── 티어 정의 (퀸 사이즈 미국 소매가 기준) ─────────────────────────────────
# key   : 내부 식별자(프런트 필터 값). 표시 텍스트가 아니므로 바꾸지 말 것.
# name  : 화면 표시 이름
# price : 가격대 표시 문자열
# brands: 그 티어에 해당하는 제품 라인(뉴스 티어 분류에도 쓰인다)
TIERS = [
    {
        "key": "high",
        "name": "하이엔드",
        "price": "$3,000+",
        "brands": ["Tempur-Pedic", "Stearns & Foster", "Beautyrest Black"],
    },
    {
        "key": "premium",
        "name": "프리미엄",
        "price": "$1,500~3,000",
        "brands": ["Sealy Posturepedic Plus", "Beautyrest Harmony",
                   "Sleep Number i-Series", "Purple Restore"],
    },
    {
        "key": "mid",
        "name": "미드",
        "price": "$700~1,500",
        "brands": ["Serta Perfect Sleeper", "Sealy Essentials",
                   "Purple Original", "Sleep Number c-Series"],
    },
]

TIER_KEYS = [t["key"] for t in TIERS]
TIER_NAME = {t["key"]: t["name"] for t in TIERS}

# ── 기업 ↔ 티어 진출 매핑 ──────────────────────────────────────────────────
# 티커를 키로 쓴다(SEC 수집 결과와 붙이는 기준). 비상장은 의사 티커.
COMPANY_TIERS = {
    "TPX": ["high", "premium", "mid"],
    "SSB": ["high", "premium", "mid"],   # 비상장
    "SNBR": ["premium", "mid"],
    "PRPL": ["premium", "mid"],
    "LEG": [],                            # 부품 공급사 — 티어에 속하지 않는다
}

# ── 기업 메타 (대표 브랜드 · 본사 소재지 · 상장 여부 · 역할) ───────────────
# role: "brand" = 매트리스 브랜드사(티어 집계 대상) / "supplier" = 부품 공급사(집계 제외)
# public: False 면 실적이 없다. 추정치를 만들지 않고 "비상장 · 실적 미공시"로 표시한다.
COMPANY_META = {
    "TPX": {
        "brands": ["Tempur-Pedic", "Stearns & Foster",
                   "Sealy Posturepedic Plus", "Sealy Essentials"],
        "hq": "렉싱턴, KY",
        "hq_note": "유럽 사업은 International 세그먼트",
        "public": True,
        "role": "brand",
    },
    "SSB": {
        "brands": ["Beautyrest Black", "Beautyrest Harmony", "Serta Perfect Sleeper"],
        "hq": "애틀랜타(도라빌), GA",
        "hq_note": "",
        "public": False,
        "role": "brand",
    },
    "SNBR": {
        "brands": ["Sleep Number i-Series", "Sleep Number c-Series"],
        "hq": "미니애폴리스, MN",
        "hq_note": "",
        "public": True,
        "role": "brand",
    },
    "PRPL": {
        "brands": ["Purple Restore", "Purple Original"],
        "hq": "리하이, UT",
        "hq_note": "",
        "public": True,
        "role": "brand",
    },
    "LEG": {
        "brands": ["매트리스 스프링·폼 등 부품"],
        "hq": "카시지, MO",
        "hq_note": "완제품 브랜드가 아니라 부품 공급사",
        "public": True,
        "role": "supplier",
    },
}

# 비상장 기업(실적 없음) — 카드 자리는 만들되 숫자는 만들지 않는다.
PRIVATE_COMPANIES = [
    {"name": "Serta Simmons Bedding", "ticker": "SSB", "domain": "serta.com"},
]

# ── 뉴스 → 티어 분류 ──────────────────────────────────────────────────────
# 1순위: 제목에 제품 라인명이 있으면 그 라인의 티어(가장 정확).
# 2순위: 라인명이 없으면 기사에 붙은 브랜드가 진출한 티어 전체.
# ★ 브랜드도 라인명도 못 찾으면 분류하지 않는다(억지로 넣지 않는다).
NEWS_BRAND_TIERS = {
    "Tempur-Pedic": ["high"],
    "Sleep Number": ["premium", "mid"],
    "Purple": ["premium", "mid"],
    "Serta": ["mid"],
}

TIER_NOTE = ("기업 실적은 티어별로 공시되지 않습니다. 아래 수치는 "
             "선택한 티어에 진출한 기업들의 전사(연결) 실적을 묶어 본 것이며, "
             "그 티어만의 매출이 아닙니다.")

# 카드 수치의 기준. companyfacts 는 차원(dimension) 없는 연결 실적만 주므로 카드는
# 전사 기준이다. 지리 세그먼트는 공시 원본 XBRL 에서 따로 뽑아(europe_flow.py)
# 추이 차트에만 점선으로 얹는다.
SEGMENT_NOTE = ("기업 카드 수치는 전사(연결) 기준입니다. "
                "지리 세그먼트는 공시 원본에서 따로 추출해 추이 차트에만 표시합니다.")


def _line_tier_index():
    """제품 라인명(소문자) → 티어 key. 긴 이름을 먼저 맞춘다."""
    pairs = []
    for t in TIERS:
        for b in t["brands"]:
            pairs.append((b.lower(), t["key"]))
    pairs.sort(key=lambda x: -len(x[0]))
    return pairs


_LINE_TIERS = _line_tier_index()


def tiers_for(ticker):
    """티커 → 진출 티어 key 리스트(없으면 빈 리스트)."""
    return list(COMPANY_TIERS.get(str(ticker).upper(), []))


def meta_for(ticker):
    """티커 → 메타 dict(사본). 없으면 기본값."""
    m = COMPANY_META.get(str(ticker).upper())
    if not m:
        return {"brands": [], "hq": "", "hq_note": "", "public": True, "role": "brand"}
    return dict(m)


def news_tiers(title, brand):
    """기사 제목·브랜드 → 티어 key 리스트. 분류 불가면 빈 리스트."""
    t = str(title or "").lower()
    hit = []
    for line, key in _LINE_TIERS:
        if line in t and key not in hit:
            hit.append(key)
    if hit:  # 라인명이 잡히면 그것만 쓴다(가장 구체적인 신호)
        return [k for k in TIER_KEYS if k in hit]
    got = NEWS_BRAND_TIERS.get(str(brand or "").strip())
    return list(got) if got else []


def tier_defs_payload():
    """프런트로 보낼 티어 정의(사본)."""
    return [dict(t, brands=list(t["brands"])) for t in TIERS]
