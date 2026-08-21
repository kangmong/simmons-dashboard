# -*- coding: utf-8 -*-
"""이탈리아 상장 홈퍼니싱 기업 — 자동 수집 가능한 것만.

★ 조사 결과(2026-08 실측). 추측 없이 실제 호출·조회로 확인했다.

  Natuzzi S.p.A. (NYSE: NTZ, CIK 900391)
    · SEC EDGAR 에 있다. 다만 외국 민간발행인이라 10-Q 가 아니라 20-F(연간)·6-K 다.
    · 20-F 만 XBRL(IFRS 택소노미)로 태깅된다 → **연간 실적만** 구조화되어 있다.
    · 6-K 로 분기 실적을 내지만(예: ntz_1q2026_finresults.htm) XBRL 인스턴스가
      없어 자동 수집 대상이 아니다(HTML 보도자료 본문뿐).
    · 20-F 인스턴스에는 국가별 매출 축이 있어 **이탈리아 매출(country:IT)**을
      떼어낼 수 있다. 이 대시보드에서 유일하게 검증 가능한 '상장사의 이탈리아
      매출' 수치다.

  Caleffi S.p.A. (Milan: CLF)  — 홈텍스타일·침구류, 매트리스 최근접
    · SEC 에 없다(밀라노 상장). IR 은 caleffigroup.it/investors.
    · 공시가 **반기 + 연간**이고 형식은 **PDF** 뿐이다. XBRL·API 없음.
    · → 자동 수집 불가로 판정. PDF 정규식 파싱은 조용히 틀린 값을 낼 위험이
      있어 보고용 지표로 쓰지 않는다.

  Dexelance S.p.A. (Milan: DEX) — 구 Italian Design Brands(2024-05 사명 변경)
    · ★ 사용자가 준 목록의 'Italian Design Brands(IDB.MI)'와 같은 회사다.
      IDB.MI 는 더 이상 조회되지 않는다(Yahoo 404).
    · 공시가 **반기 + 9개월 잠정치**이고 형식은 PDF 보도자료. XBRL·API 없음.
    · 세그먼트가 Furniture/Lighting/Kitchen&Systems/Luxury Contract 로
      매트리스·침구 부문이 없다.
    · → 자동 수집 불가로 판정.

  Pozzi Milano — 지시대로 대상에서 제외(테이블웨어·주방용품).

★ 그래서 차트를 만들지 않는다. 수집되는 것이 Natuzzi 연간 1곳뿐이라
  '분기 추이 + 티어 필터'를 미국 섹션처럼 구성할 근거가 없고, 연간과 반기를
  한 축에 놓으면 왜곡된다. 표로만 제시한다.
"""
import io
import os
import json
import datetime
import xml.etree.ElementTree as ET

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_REL = os.path.join("public", "data", "italy-listed.json")

NTZ_CIK = 900391
SEC_HEADERS = {"User-Agent": "Simmons Dashboard contact@example.com"}
TIMEOUT = 90
XI = "{http://www.xbrl.org/2003/instance}"
XD = "{http://xbrl.org/2006/xbrldi}"
REV_TAGS = ("Revenue", "RevenueFromContractsWithCustomers")
ANNUAL_DAYS = (350, 380)

# 자동 수집이 안 되는 기업 — 카드에 사유를 그대로 적는다(숫자는 만들지 않는다).
NOT_COLLECTIBLE = [
    {"name": "Caleffi S.p.A.", "ticker": "Milan: CLF",
     "business": "홈텍스타일·침구류 (매트리스 최근접)",
     "reason": "밀라노 상장으로 SEC 에 없고, 공시가 반기·연간 PDF 뿐입니다. "
               "XBRL·API 가 없어 자동 수집 대상에서 제외했습니다.",
     "ir": "caleffigroup.it/investors", "period": "반기 + 연간"},
    {"name": "Dexelance S.p.A.", "ticker": "Milan: DEX",
     "business": "디자인 가구·조명·럭셔리 컨트랙트 (침구·매트리스 부문 없음)",
     "reason": "구 Italian Design Brands(2024-05 사명 변경). 공시가 반기·9개월 "
               "잠정치 PDF 뿐이고 XBRL·API 가 없어 자동 수집 대상에서 제외했습니다.",
     "ir": "dexelance.com/en/investor-relations", "period": "반기 + 9개월 잠정"},
]

NOTE = ("이탈리아 상장 홈퍼니싱 기업 중 실적을 자동 수집할 수 있는 곳은 Natuzzi "
        "한 곳(연간)뿐입니다. 연간과 반기를 한 축에 놓으면 왜곡되므로 차트가 아니라 "
        "표로 제시합니다.")
TIER_NOTE = ("티어 매핑은 판단 보류입니다. Natuzzi 는 소파·홈퍼니싱 제조사로 "
             "매트리스 가격대 기준을 그대로 적용할 수 없고, Natuzzi Italia(상위)와 "
             "Natuzzi Editions(중급) 두 브랜드를 함께 운영합니다.")


def _get(url):
    r = requests.get(url, timeout=TIMEOUT, headers=SEC_HEADERS)
    r.raise_for_status()
    return r


def _data_path():
    return os.path.join(BASE, DATA_REL)


def _load():
    try:
        p = _data_path()
        if os.path.isfile(p):
            got = json.load(io.open(p, encoding="utf-8"))
            if isinstance(got, dict):
                return got
    except Exception:  # noqa: BLE001
        pass
    return {}


def _save(payload):
    try:
        p = _data_path()
        d = os.path.dirname(p)
        if not os.path.isdir(d):
            os.makedirs(d)
        with io.open(p, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    except Exception as e:  # noqa: BLE001
        print("[italy_listed] 저장 생략(쓰기 불가): %s" % e)


def _latest_20f():
    """최신 20-F 의 (accession, 회계연도말, 인스턴스 URL)."""
    sub = _get("https://data.sec.gov/submissions/CIK%s.json" % str(NTZ_CIK).zfill(10)).json()
    rec = sub.get("filings", {}).get("recent", {})
    for form, accn, rd, doc in zip(rec.get("form", []), rec.get("accessionNumber", []),
                                   rec.get("reportDate", []), rec.get("primaryDocument", [])):
        if form == "20-F" and doc.endswith(".htm"):
            url = ("https://www.sec.gov/Archives/edgar/data/%d/%s/%s"
                   % (NTZ_CIK, accn.replace("-", ""), doc[:-4] + "_htm.xml"))
            return accn, rd, url
    return None, None, None


def _parse_annual(raw):
    """인스턴스 → {'total': {year: EUR}, 'italy': {year: EUR}}. 연간(350~380일)만."""
    root = ET.fromstring(raw)
    ctx = {}
    for c in root.findall(XI + "context"):
        per = c.find(XI + "period")
        if per is None:
            continue
        dims = {m.get("dimension"): (m.text or "").strip()
                for m in c.iter(XD + "explicitMember")}
        ctx[c.get("id")] = (per.findtext(XI + "startDate"), per.findtext(XI + "endDate"), dims)
    total, italy = {}, {}
    for el in root.iter():
        if el.tag.split("}")[-1] not in REV_TAGS:
            continue
        c = ctx.get(el.get("contextRef"))
        if not c or not c[0] or not c[1]:
            continue
        try:
            a = datetime.date(*map(int, c[0].split("-")))
            b = datetime.date(*map(int, c[1].split("-")))
            v = float(el.text)
        except (TypeError, ValueError):
            continue
        if not (ANNUAL_DAYS[0] <= (b - a).days <= ANNUAL_DAYS[1]):
            continue
        if not c[2]:
            total.setdefault(b.year, v)
        elif "country:IT" in c[2].values():
            italy.setdefault(b.year, v)
    return {"total": total, "italy": italy}


def update_italy_listed():
    """Natuzzi 연간 실적(+이탈리아 매출)만 갱신. 20-F 가 그대로면 재다운로드하지 않는다."""
    store = _load()
    try:
        accn, fy_end, url = _latest_20f()
    except Exception as e:  # noqa: BLE001
        accn = fy_end = url = None
        print("[italy_listed] 공시 목록 조회 실패: %s" % str(e)[:90])

    rows = store.get("natuzzi_years") or []
    if accn and accn != store.get("accn"):
        try:
            got = _parse_annual(_get(url).content)   # 인스턴스는 20-F 가 바뀔 때만 받는다
            merged = {}
            for r in rows:
                merged[r["year"]] = r
            for y, v in got["total"].items():
                merged.setdefault(y, {"year": y})["total"] = round(v)
            for y, v in got["italy"].items():
                merged.setdefault(y, {"year": y})["italy"] = round(v)
            rows = [merged[y] for y in sorted(merged)]
            store = {"accn": accn, "fy_end": fy_end, "natuzzi_years": rows}
            _save(store)
            print("[italy_listed] Natuzzi 20-F(%s) 파싱 — 연도 %d개" % (fy_end, len(rows)))
        except Exception as e:  # noqa: BLE001
            print("[italy_listed] 인스턴스 파싱 실패(기존 값 유지): %s" % str(e)[:90])
    else:
        print("[italy_listed] Natuzzi 20-F 변경 없음 — 보유 연도 %d개" % len(rows))

    for r in rows:      # 이탈리아 비중은 표시 시점에 계산하지 않고 미리 넣어둔다
        t, i = r.get("total"), r.get("italy")
        r["italy_pct"] = round(100.0 * i / t, 1) if (t and i) else None
    return {
        "status": "ok" if rows else "error",
        "reason": None if rows else "Natuzzi 연간 실적을 확보하지 못했습니다",
        "note": NOTE, "tier_note": TIER_NOTE,
        "collected": [{
            "name": "Natuzzi S.p.A.", "ticker": "NYSE: NTZ",
            "business": "프리미엄 가죽 소파·홈퍼니싱",
            "period": "연간 (20-F)",
            "source": "SEC EDGAR · 20-F XBRL(IFRS) · CIK 900391",
            "fy_end": store.get("fy_end"),
            "currency": "EUR",
            "years": rows[-6:],
        }],
        "not_collectible": [dict(x) for x in NOT_COLLECTIBLE],
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


if __name__ == "__main__":
    import sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    print(json.dumps(update_italy_listed(), ensure_ascii=False, indent=1)[:2500])
