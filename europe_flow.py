# -*- coding: utf-8 -*-
"""유럽 흐름 지표 — Tempur Sealy 지리적 세그먼트 + 이탈리아 소매판매 지수.

배경: 티어별 시장 동향에 올라간 3개 기업이 모두 미국 회사라 유럽 흐름이 보이지
      않았다. SEC companyfacts 는 차원(dimension) 없는 연결 실적만 주므로
      세그먼트가 안 나온다. 대신 공시 원본 XBRL 인스턴스에는 세그먼트 축이
      태깅되어 있어(us-gaap:StatementBusinessSegmentsAxis) 여기서 뽑는다.

★ International 세그먼트는 '북미 외' 전체다. 10-K 정의상 북미부문이
  미국·캐나다·멕시코를 포함하므로, 해외부문은 유럽·아시아태평양·중남미
  (멕시코 제외) 합산이다. 유럽 단독도, 이탈리아 단독도 아니다.
  공시의 지리 축(srt:StatementGeographicalAxis)에도 country:US 와
  us-gaap:NonUsMember 둘뿐이어서 유럽만 떼어낼 수 없다(실측).
  → 이탈리아는 Eurostat 소매판매 지수로 따로 본다(기업 실적이 아니라 시장 수요).

★ 추정치를 만들지 않는다. 값이 없는 분기는 비워 둔다.
"""
import io
import datetime
import xml.etree.ElementTree as ET

import requests

try:  # 브랜드 상수(단일 관리 지점). 로드 실패해도 나머지는 정상.
    from italy_brands import italy_brands_payload
except Exception:  # noqa: BLE001
    italy_brands_payload = None

# Tempur Sealy(현 Somnigroup International) CIK. 사명이 바뀌어도 CIK 는 그대로다.
TPX_CIK = 1206264
SEC_HEADERS = {"User-Agent": "Simmons Dashboard contact@example.com"}
SEC_FILINGS = 6            # 최근 10-Q/10-K 몇 건을 읽을지(6건이면 약 8분기)
SEC_TIMEOUT = 60

# Mattress Firm 인수 완료일 — Somnigroup 10-K(2026-02-27 제출) 본문에
# "Mattress Firm Acquisition" 이 February 5, 2025 로 명시되어 있고,
# 같은 날짜의 8-K(report date 2025-02-05)가 있다. 사명 변경(Somnigroup)은
# 2025-02-18 부터다. 2025 Q1 은 2/5~3/31 부분 기간만 합산된다.
# ★ 현재 화면에서는 사용하지 않는다(인수 표시 제거 지시). 조사 결과를 잃지 않게 기록은 남긴다.
MF_ACQ_DATE = "2025-02-05"
MF_ACQ_TEXT = ("Tempur Sealy 가 2025년 2월 5일 매트리스 유통업체 Mattress Firm 인수를 "
               "완료해 그 실적이 합산되었습니다. 이후 구간의 증가분에는 인수 효과가 "
               "포함되어 있어 시장 성장과 구분해서 보아야 합니다. "
               "인수가 분기 중간에 이뤄져 2025 Q1 은 2월 5일부터의 부분 기간만 "
               "합산되었습니다.")

XBRLI = "{http://www.xbrl.org/2003/instance}"
XBRLDI = "{http://xbrl.org/2006/xbrldi}"
SEG_AXIS = "us-gaap:StatementBusinessSegmentsAxis"
REV_TAG = "RevenueFromContractWithCustomerExcludingAssessedTax"

# 세그먼트 멤버 → (내부 key, 표시명, 짧은 설명). 이름이 바뀌면 여기만 고친다.
# ★ 세그먼트 범위는 Somnigroup 10-K(2026-02-27) 본문에서 확인했다.
#   North America  : "located in the U.S., Canada and Mexico
#                     (other than Mattress Firm retail and distribution locations)"
#   International  : "located in Europe, Asia-Pacific and Latin America
#                     (other than Mexico)"
#   → International 은 미국·캐나다뿐 아니라 멕시코도 제외한 '북미 외' 전체다.
SEGMENTS = [
    ("TempurSealyInternationalSegmentMember", "international",
     "Tempur Sealy 해외부문 (미국·캐나다·멕시코 제외)",
     "유럽·아시아태평양·중남미(멕시코 제외) 합산입니다. "
     "글로벌 업체의 해외 실적이며, 이탈리아 단독 수치는 공시되지 않습니다."),
    ("TempurSealyNorthAmericaSegmentMember", "north_america",
     "Tempur Sealy 북미부문 (미국·캐나다·멕시코)", ""),
    ("MattressFirmSegmentMember", "mattress_firm",
     "Mattress Firm (북미 소매 체인)", ""),
]
_MONTH_Q = {3: "Q1", 6: "Q2", 9: "Q3", 12: "Q4"}

# ── 이탈리아 소매판매(Eurostat sts_trtu_m) ────────────────────────────────
# G475 = 가정용품 전문점 소매(가구 포함). 이 데이터셋에서 가구만 떼는 더 세분한
# 코드는 제공되지 않아 G475 가 최소 단위다(실측).
EU_URL = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/sts_trtu_m"
EU_PARAMS = {
    "format": "JSON", "lang": "EN",
    "geo": "IT",            # 이탈리아
    "nace_r2": "G475",      # 가정용품 전문점 소매
    "indic_bt": "NETTUR",   # 순매출
    "s_adj": "SCA",         # 계절·영업일 조정
    "unit": "I21",          # 지수 2021=100
}
EU_SINCE = "2023-01"
EU_TIMEOUT = 30


def _get(url, **kw):
    r = requests.get(url, timeout=kw.pop("timeout", SEC_TIMEOUT),
                     headers=kw.pop("headers", SEC_HEADERS), **kw)
    r.raise_for_status()
    return r


def _instance_urls(limit=SEC_FILINGS):
    """최근 10-Q/10-K 의 XBRL 인스턴스(_htm.xml) URL 목록. 최신 우선."""
    sub = _get("https://data.sec.gov/submissions/CIK%s.json" % str(TPX_CIK).zfill(10)).json()
    rec = sub.get("filings", {}).get("recent", {})
    out = []
    for form, accn, doc, rd in zip(rec.get("form", []), rec.get("accessionNumber", []),
                                   rec.get("primaryDocument", []), rec.get("reportDate", [])):
        if form not in ("10-Q", "10-K") or not doc.endswith(".htm"):
            continue
        out.append(("https://www.sec.gov/Archives/edgar/data/%d/%s/%s"
                    % (TPX_CIK, accn.replace("-", ""), doc[:-4] + "_htm.xml"), form, rd))
        if len(out) >= limit:
            break
    return out


def _parse_instance(raw):
    """인스턴스 1건 → {(seg_member, 'YYYY Qn'): 값}. 단일 분기(80~100일)만."""
    root = ET.fromstring(raw)
    ctx = {}
    for c in root.findall(XBRLI + "context"):
        per = c.find(XBRLI + "period")
        if per is None:
            continue
        dims = {m.get("dimension"): (m.text or "").strip()
                for m in c.iter(XBRLDI + "explicitMember")}
        ctx[c.get("id")] = (per.findtext(XBRLI + "startDate"),
                            per.findtext(XBRLI + "endDate"), dims)
    got = {}
    for el in root.iter():
        if not el.tag.endswith(REV_TAG):
            continue
        c = ctx.get(el.get("contextRef"))
        if not c or not c[0] or not c[1]:
            continue
        # 세그먼트 축 하나만 걸린 값만 쓴다(채널·지역이 겹치면 중복 집계가 된다)
        if len(c[2]) != 1 or SEG_AXIS not in c[2]:
            continue
        try:
            a = datetime.date(*map(int, c[0].split("-")))
            b = datetime.date(*map(int, c[1].split("-")))
            val = float(el.text)
        except (TypeError, ValueError):
            continue
        if not (80 <= (b - a).days <= 100):   # 단일 분기만(YTD·연간 배제)
            continue
        q = _MONTH_Q.get(b.month)
        if not q:
            continue
        got[(c[2][SEG_AXIS].split(":")[-1], "%d %s" % (b.year, q))] = val
    return got


def fetch_tpx_segments():
    """Tempur Sealy 세그먼트별 분기 매출. 실패하면 reason 을 담아 돌려준다."""
    try:
        urls = _instance_urls()
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "공시 목록 조회 실패: %s" % e}
    if not urls:
        return {"status": "error", "reason": "10-Q/10-K 공시를 찾지 못했습니다"}

    merged, read, failed = {}, 0, 0
    for url, form, rd in urls:
        try:
            got = _parse_instance(_get(url).content)
        except Exception:  # noqa: BLE001 — 한 건 실패해도 나머지로 진행
            failed += 1
            continue
        read += 1
        for k, v in got.items():
            merged.setdefault(k, v)      # 최신 공시 값을 우선(먼저 들어온 것 유지)

    series = {}
    for member, key, label, note in SEGMENTS:
        pts = sorted(((q, v) for (m, q), v in merged.items() if m == member),
                     key=lambda z: _qord(z[0]))
        if pts:
            series[key] = {"label": label, "note": note,
                           "quarters": [{"q": q, "revenue": v} for q, v in pts]}
    if not series:
        return {"status": "error",
                "reason": "공시 %d건을 읽었지만 세그먼트 매출 태그를 찾지 못했습니다" % read}

    # Mattress Firm 세그먼트가 0에서 처음 값이 생긴 분기(현재 화면에서는 쓰지 않는다).
    acq = None
    mf = series.get("mattress_firm", {}).get("quarters") or []
    for p in mf:
        if p["revenue"]:
            acq = p["q"]
            break
    return {"status": "ok", "series": series, "filings_read": read,
            "filings_failed": failed, "acq_quarter": acq,
            "note": ("해외부문은 유럽·아시아태평양·중남미(멕시코 제외) 합산입니다. "
                     "공시가 북미/북미 외로만 나뉘어 이탈리아만 분리할 수 없습니다.")}


def _qord(q):
    """'YYYY Qn' → 정렬용 정수."""
    try:
        y, qq = q.split()
        return int(y) * 10 + int(qq[1])
    except Exception:  # noqa: BLE001
        return 0


def fetch_italy_retail():
    """이탈리아 가정용품 전문점 소매 순매출 지수(월간, 2021=100)."""
    try:
        p = dict(EU_PARAMS, sinceTimePeriod=EU_SINCE)
        j = _get(EU_URL, params=p, timeout=EU_TIMEOUT,
                 headers={"User-Agent": "Mozilla/5.0"}).json()
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "Eurostat 조회 실패: %s" % e}
    dim = j.get("dimension", {})
    idx = dim.get("time", {}).get("category", {}).get("index", {})
    vals = j.get("value", {})
    if not idx or not vals:
        return {"status": "error", "reason": "Eurostat 응답에 관측치가 없습니다"}
    pts = []
    for month in sorted(idx, key=lambda k: idx[k]):
        v = vals.get(str(idx[month]))
        if v is not None:
            pts.append({"month": month, "value": round(float(v), 1)})
    if not pts:
        return {"status": "error", "reason": "Eurostat 관측치가 비어 있습니다"}
    latest = pts[-1]
    prev = None
    want = "%d-%s" % (int(latest["month"][:4]) - 1, latest["month"][5:])
    for p2 in pts:
        if p2["month"] == want:
            prev = p2
            break
    yoy = None
    if prev and prev["value"]:
        yoy = round((latest["value"] - prev["value"]) / abs(prev["value"]) * 100.0, 1)
    return {"status": "ok", "points": pts, "latest": latest, "yoy": yoy,
            "unit": "지수 (2021=100, 계절·영업일 조정)",
            "label": "이탈리아 가정용품 전문점 소매 순매출",
            "source": "Eurostat sts_trtu_m · NACE G475 · geo IT"}


def update_europe_flow():
    """FETCHERS 등록용 — 세그먼트와 이탈리아 지수를 한 섹션으로 묶어 반환."""
    seg = fetch_tpx_segments()
    ita = fetch_italy_retail()
    ok = (seg.get("status") == "ok") or (ita.get("status") == "ok")
    brands = italy_brands_payload() if italy_brands_payload else None
    return {"status": "ok" if ok else "error",
            "reason": None if ok else (seg.get("reason") or ita.get("reason")),
            "segments": seg, "italy": ita, "italy_brands": brands}


if __name__ == "__main__":
    import json
    import sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    print(json.dumps(update_europe_flow(), ensure_ascii=False, indent=1)[:4000])
