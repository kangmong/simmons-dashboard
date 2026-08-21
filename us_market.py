# -*- coding: utf-8 -*-
"""미국 매트리스 가격·교역 지표 — BLS PPI(항상) + Census 무역(키 있을 때만).

★ 이 모듈은 '시장 규모'를 만들지 않는다. 무료 공개 통계에 티어별·전체 시장
  규모가 존재하지 않음이 조사로 확인됐다(ISPA 회원 전용, Census ASM 수량 없음,
  Current Industrial Reports 폐지). 확보 가능한 것은 두 가지뿐이다.
    · 가격 방향  — BLS 생산자물가지수(PPI)
    · 국경 물량·단가 — Census 무역 통계

★ BLS 시리즈는 조사에서 실재를 확인한 것만 쓴다. 다른 코드를 추측해 넣지 않는다.
    PCU337910337910  매트리스 제조업 PPI (NAICS 337910)  ← 유일하게 실재
    WPU00000000      PPI 전체 상품 (비교용 · 같은 PPI 계열)
  실측(2026-08): 두 시리즈 모두 2021-M01~2026-M07, 매트리스 최신 266.942.
  후보로 시험한 WPU121103 / WPU1210 / PCU33791033791011 은 모두
  "Series does not exist" 였다.

★ Census 무역 API 는 무료지만 **키 발급이 필요**하다(키 없이 호출하면
  "Missing Key" HTML 을 돌려준다). 키가 없으면 무역 블록을 만들지 않고
  PPI 만 반환한다 — 카드가 깨지지 않게 한다.
  키 발급: https://api.census.gov/data/key_signup.html (무료·즉시)
  발급 후 .env 에 CENSUS_API_KEY=... 로 넣거나 환경변수로 준다.
"""
import io
import os
import json
import datetime

import requests

BLS_URL = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
BLS_SERIES = [
    ("PCU337910337910", "매트리스 제조업 PPI", "mattress"),
    ("WPU00000000", "PPI 전체 상품", "allcomm"),
]
BLS_YEARS = 6                 # v1 은 키 없이 10년까지 — 최근 5년 + 여유
BLS_TIMEOUT = 60

CENSUS_URL = "https://api.census.gov/data/timeseries/intltrade/imports/hs"
CENSUS_MONTHS = 24
CENSUS_TIMEOUT = 60
# HS 코드 → 표시명. 이탈리아(UN Comtrade)와 같은 구성으로 맞춰 양국 비교가 되게 한다.
HS_CODES = [
    ("9404", "전체 (매트리스·침구류)"),
    ("940410", "매트리스 서포트 (프레임·베이스)"),
    ("940421", "폼 매트리스 (셀룰러 고무·플라스틱)"),
    ("940429", "기타 재질 매트리스 (스프링 등)"),
]

PPI_NOTE = ("미국 매트리스 제조업 출고가격 지수입니다. "
            "일반 물가보다 빠르게 오르면 고가 제품 비중 증가를 시사합니다.")
TRADE_NOTE = ("kg당 수입 단가입니다. 제품 등급이 아니라 무게 구성을 반영하므로 "
              "절대 수준보다 추이 방향을 보십시오.")
SCOPE_NOTE = ("현재 지표: 가격 지수와 교역 단가 기준. "
              "티어별 시장 규모는 공개 통계에 존재하지 않아 유료 자료가 필요합니다.")
KEY_HINT = ("Census 무역 통계는 무료지만 API 키가 필요합니다. "
            "api.census.gov/data/key_signup.html 에서 발급한 뒤 "
            ".env 에 CENSUS_API_KEY=... 로 넣으면 이 자리에 표시됩니다.")


def _census_key():
    """CENSUS_API_KEY: 환경변수 → .env(수동 파싱, 의존성 없이)."""
    key = os.environ.get("CENSUS_API_KEY")
    if key:
        return key.strip()
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, ".env"), ".env"):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    s = line.strip()
                    if s.startswith("CENSUS_API_KEY"):
                        return s.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            pass
    return None


def _yoy(points):
    """[{month, value}] → 최신값의 전년 동월 대비 %. 12개월 전 값이 없으면 None."""
    if len(points) < 13:
        return None
    cur, prev = points[-1]["value"], points[-13]["value"]
    if not prev:
        return None
    return round((cur - prev) / abs(prev) * 100.0, 2)


def fetch_bls_ppi():
    """매트리스 PPI + 비교용 전체 상품 PPI. 월별."""
    yr = datetime.date.today().year
    body = {"seriesid": [s for s, _, _ in BLS_SERIES],
            "startyear": str(yr - BLS_YEARS), "endyear": str(yr)}
    try:
        r = requests.post(BLS_URL, data=json.dumps(body), timeout=BLS_TIMEOUT,
                          headers={"Content-Type": "application/json",
                                   "User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        j = r.json()
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "BLS 조회 실패: %s" % str(e)[:90]}
    if j.get("status") != "REQUEST_SUCCEEDED":
        return {"status": "error",
                "reason": "BLS 응답 오류: %s" % str(j.get("message"))[:120]}
    raw = {s["seriesID"]: (s.get("data") or [])
           for s in (j.get("Results") or {}).get("series", [])}
    series = {}
    for sid, label, key in BLS_SERIES:
        pts = []
        for x in raw.get(sid, []):
            p = x.get("period") or ""
            if not p.startswith("M") or p == "M13":     # M13 은 연평균
                continue
            try:
                pts.append({"month": "%s-%02d" % (x["year"], int(p[1:])),
                            "value": float(x["value"])})
            except (KeyError, TypeError, ValueError):
                continue
        pts.sort(key=lambda z: z["month"])
        if pts:
            series[key] = {"series_id": sid, "label": label, "points": pts,
                           "latest": pts[-1], "yoy": _yoy(pts)}
    if "mattress" not in series:
        return {"status": "error", "reason": "매트리스 PPI 시리즈를 받지 못했습니다"}
    m, a = series.get("mattress"), series.get("allcomm")
    gap = None
    if m and a and m.get("yoy") is not None and a.get("yoy") is not None:
        gap = round(m["yoy"] - a["yoy"], 2)
    return {"status": "ok", "series": series, "gap_pp": gap,
            "note": PPI_NOTE, "source": "BLS 생산자물가지수(PPI) · v1 API · 키 불필요",
            "unit": "지수 (BLS 원지수 · 비교를 위해 화면에서 기준월=100 으로 재산정)"}


def _months(n):
    """최근 n개월의 'YYYY-MM'. Census 공표 지연을 감안해 2개월 전부터."""
    t = datetime.date.today()
    y, mo = t.year, t.month - 2
    while mo <= 0:
        y, mo = y - 1, mo + 12
    out = []
    for _ in range(n):
        out.append("%04d-%02d" % (y, mo))
        mo -= 1
        if mo <= 0:
            y, mo = y - 1, 12
    return list(reversed(out))


def fetch_census_imports(key):
    """HS 9404 미국 월별 수입액·수입수량. 키가 없으면 호출하지 않는다."""
    if not key:
        return {"status": "no_key", "reason": KEY_HINT}
    got, failed = {}, 0
    for month in _months(CENSUS_MONTHS):
        try:
            r = requests.get(CENSUS_URL, timeout=CENSUS_TIMEOUT,
                             headers={"User-Agent": "Mozilla/5.0"},
                             params={"get": "I_COMMODITY,GEN_VAL_MO,GEN_QY1_MO,UNIT_QY1",
                                     "time": month, "COMM_LVL": "HS6",
                                     "I_COMMODITY": ",".join(c for c, _ in HS_CODES),
                                     "key": key})
            if r.status_code != 200 or not r.text.lstrip().startswith("["):
                failed += 1
                continue
            rows = r.json()
        except Exception:  # noqa: BLE001
            failed += 1
            continue
        hdr = rows[0]
        ci = {name: hdr.index(name) for name in hdr}
        val, qty, unit = {}, {}, {}
        for row in rows[1:]:
            code = str(row[ci["I_COMMODITY"]]).strip()
            if code not in dict(HS_CODES):
                continue
            try:
                v = float(row[ci["GEN_VAL_MO"]])
                q = float(row[ci["GEN_QY1_MO"]])
            except (TypeError, ValueError):
                continue
            val[code] = round(v)
            if q:
                qty[code] = round(q)
                unit[code] = str(row[ci["UNIT_QY1"]]).strip()
        if val:
            got[month] = {"month": month, "val": val, "qty": qty, "unit": unit}
    months = [got[m] for m in sorted(got)]
    if not months:
        return {"status": "error",
                "reason": "Census 응답을 받지 못했습니다(실패 %d건). 키가 유효한지 확인하세요." % failed}
    return {"status": "ok", "months": months, "failed": failed,
            "codes": [{"code": c, "label": l} for c, l in HS_CODES],
            "currency": "USD", "note": TRADE_NOTE,
            "source": "미국 인구조사국 국제무역 API · HS 9404 일반수입(General Imports) · 월별"}


def update_us_market():
    """FETCHERS 등록용. PPI 는 항상, 무역은 키가 있을 때만."""
    ppi = fetch_bls_ppi()
    trade = fetch_census_imports(_census_key())
    ok = (ppi.get("status") == "ok") or (trade.get("status") == "ok")
    print("[us_market] PPI %s · Census %s%s"
          % (ppi.get("status"),
             trade.get("status"),
             " (키 없음 — PPI 만 표시)" if trade.get("status") == "no_key" else ""))
    return {"status": "ok" if ok else "error",
            "reason": None if ok else (ppi.get("reason") or trade.get("reason")),
            "ppi": ppi, "trade": trade, "scope_note": SCOPE_NOTE}


if __name__ == "__main__":
    import sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    print(json.dumps(update_us_market(), ensure_ascii=False, indent=1)[:2200])
