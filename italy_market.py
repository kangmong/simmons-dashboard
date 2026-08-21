# -*- coding: utf-8 -*-
"""이탈리아 시장 — 수동 입력 수치 로더 + 시장 특성(정성) 상수.

왜 수동인가:
  시장 규모·프리미엄 세그먼트 비중·브랜드 점유율은 유료 조사기관 추정치로만
  존재하고 공공 통계에 없다. 무료 자동 수집이 원리적으로 불가능하다.
  → 자동으로 되는 수출입 통계(italy_trade.py)와 분리해서 관리한다.

수동 수치 입력 방법:
  public/data/italy-market.json 을 직접 편집한다. README 의
  "이탈리아 시장 수동 입력" 항목에 절차가 정리되어 있다.
  ★ 출처 없는 수치는 넣지 않는다. 값이 비어 있으면 화면에서 블록이 숨는다.
  ★ 검색 엔진 요약을 그대로 넣지 않는다. 원 리포트에서 확인한 수치만 넣는다.
  ★ scope / definition 을 반드시 적는다. 조사기관마다 '매트리스 시장' 범위가
    달라(프레임 포함 여부 등) 적어두지 않으면 다른 리포트와 비교할 수 없다.
"""
import io
import os
import json

BASE = os.path.dirname(os.path.abspath(__file__))
MARKET_REL = os.path.join("public", "data", "italy-market.json")

# ── 시장 특성 (정성 · 고정 텍스트) ────────────────────────────────────────
# ★ source 는 확인된 출처만 적는다. 비어 있으면 화면에 '출처 확인 필요'로
#   표시되므로, 지어낸 출처를 넣지 말고 확인한 뒤 채운다.
MARKET_TRAITS = [
    {"key": "material", "title": "소재 동향",
     "body": "인스프링 비중이 크나 라텍스·폼·하이브리드 수요가 급증하고 있다.",
     "source": ""},
    {"key": "premium", "title": "프리미엄화",
     "body": "고가 킹사이즈 및 기능성 웰니스 제품 수요가 확대되고 있다.",
     "source": ""},
    {"key": "b2b", "title": "B2B 수요",
     "body": "관광·숙박 확충으로 고급 상업용 매트리스 수요가 견조하다.",
     "source": ""},
    {"key": "barrier", "title": "진입장벽",
     "body": "Made in Italy 선호가 강해 해외 브랜드의 진입장벽이 높다.",
     "source": ""},
    {"key": "regulation", "title": "규제",
     "body": "EU 에코디자인 규정으로 친환경 인증이 필수 구매 기준으로 자리 잡고 있다.",
     "source": ""},
]
# 위 정성 항목을 마지막으로 손본 날. 내용을 고치면 함께 갱신한다.
TRAITS_UPDATED_AT = "2026-08-21"
TRAITS_NOTE = "시장조사 기관 · 수동 갱신"


def _market_path():
    return os.path.join(BASE, MARKET_REL)


def _clean(rows, value_keys):
    """값이 하나도 없는 행은 버린다(빈 카드를 띄우지 않기 위해)."""
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        if any(r.get(k) is not None for k in value_keys):
            out.append(dict(r))
    return out


def load_italy_market():
    """수동 입력 JSON 로드. 파일이 없거나 값이 비면 빈 블록을 돌려준다."""
    raw = {}
    try:
        p = _market_path()
        if os.path.isfile(p):
            got = json.load(io.open(p, encoding="utf-8"))
            if isinstance(got, dict):
                raw = got
    except Exception as e:  # noqa: BLE001
        print("[italy_market] 수동 입력 파일 읽기 실패: %s" % e)
    size = _clean(raw.get("marketSize"), ("value", "growthPct"))
    prem = _clean(raw.get("premiumShare"), ("sharePct",))
    brand = [r for r in _clean(raw.get("brandShare"), ("sharePct",)) if r.get("brand")]
    return {
        "updatedAt": raw.get("updatedAt") or "",
        "marketSize": size,
        "premiumShare": prem,
        "brandShare": brand,
        "has_any": bool(size or prem or brand),
        "note": "시장조사 기관 · 수동 갱신",
        "empty_hint": ("시장 규모·세그먼트 비중·브랜드 점유율은 유료 조사기관 추정치로만 "
                       "존재해 자동 수집이 불가능합니다. public/data/italy-market.json 에 "
                       "출처와 함께 입력하면 이 자리에 표시됩니다."),
    }


def italy_traits_payload():
    """시장 특성(정성) — 사본."""
    return {"items": [dict(t) for t in MARKET_TRAITS],
            "updatedAt": TRAITS_UPDATED_AT, "note": TRAITS_NOTE}
