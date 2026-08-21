# -*- coding: utf-8 -*-
"""미국 매트리스 가격·교역 지표 — BLS PPI + UN Comtrade 수입단가. 둘 다 키 불필요.

★ 이 모듈은 '시장 규모'를 만들지 않는다. 무료 공개 통계에 티어별·전체 시장
  규모가 존재하지 않음이 조사로 확인됐다(ISPA 회원 전용, Census ASM 수량 없음,
  Current Industrial Reports 폐지). 확보 가능한 것은 두 가지뿐이다.
    · 가격 방향  — BLS 생산자물가지수(PPI)
    · 국경 물량·단가 — UN Comtrade HS 9404

★ BLS 시리즈는 조사에서 실재를 확인한 것만 쓴다. 다른 코드를 추측해 넣지 않는다.
    PCU337910337910  매트리스 제조업 PPI (NAICS 337910)  ← 유일하게 실재
    WPU00000000      PPI 전체 상품 (비교용 · 같은 PPI 계열)
  실측(2026-08): 두 시리즈 모두 2021-M01~2026-M07, 매트리스 최신 266.942.
  후보로 시험한 WPU121103 / WPU1210 / PCU33791033791011 은 모두
  "Series does not exist" 였다.

★ 무역 통계는 Census 에서 UN Comtrade 로 갈아탔다(2026-08).
  Census 는 무료지만 API 키 발급이 필수라(키 없이 호출하면 "Missing Key" HTML)
  키가 없는 동안 수입단가 선이 비었다. UN Comtrade 공개 preview 는 키가 필요
  없고, 이탈리아용으로 이미 검증된 수집기를 reporter 만 바꿔 재사용한다.
  자세한 판정 근거와 '개당 단가를 쓰는 이유'는 us_trade.py 주석에 있다.
"""
import io
import json
import datetime

import requests

try:
    from us_trade import update_us_trade
except Exception:  # noqa: BLE001 — 무역 수집기가 없어도 PPI 는 살린다
    update_us_trade = None

BLS_URL = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
BLS_SERIES = [
    ("PCU337910337910", "매트리스 제조업 PPI", "mattress"),
    ("WPU00000000", "PPI 전체 상품", "allcomm"),
]
BLS_YEARS = 6                 # v1 은 키 없이 10년까지 — 최근 5년 + 여유
BLS_TIMEOUT = 60

PPI_NOTE = ("미국 매트리스 제조업 출고가격 지수입니다. "
            "일반 물가보다 빠르게 오르면 고가 제품 비중 증가를 시사합니다.")
SCOPE_NOTE = ("현재 지표: 가격 지수와 교역 단가 기준. "
              "티어별 시장 규모는 공개 통계에 존재하지 않아 유료 자료가 필요합니다.")


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


def update_us_market():
    """FETCHERS 등록용. PPI(BLS)와 수입단가(UN Comtrade) 둘 다 키가 필요 없다."""
    ppi = fetch_bls_ppi()
    trade = (update_us_trade() if update_us_trade
             else {"status": "error", "reason": "us_trade 모듈을 불러오지 못했습니다"})
    ok = (ppi.get("status") == "ok") or (trade.get("status") == "ok")
    print("[us_market] PPI %s · Comtrade %s" % (ppi.get("status"), trade.get("status")))
    return {"status": "ok" if ok else "error",
            "reason": None if ok else (ppi.get("reason") or trade.get("reason")),
            "ppi": ppi, "trade": trade, "scope_note": SCOPE_NOTE}



if __name__ == "__main__":
    import sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    print(json.dumps(update_us_market(), ensure_ascii=False, indent=1)[:2200])
