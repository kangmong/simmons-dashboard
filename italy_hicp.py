# -*- coding: utf-8 -*-
"""이탈리아 가격지수 — Eurostat HICP.

★ 매트리스 전용 품목 코드는 존재하지 않는다(실측). HICP COICOP 468개를 전수
  조회해 mattress/bed 로 걸리는 코드가 없음을 확인했고, CP051* 계열 중 가장
  근접한 것은 CP05111 "Household furniture" 였다. 매트리스가 이 안에 들어가지만
  책상·의자·장롱도 함께 들어간다 → 화면에 그 사실을 밝힌다.

    CP0511   Furniture and furnishings          (상위)
    CP05111  Household furniture                ← 사용
    CP05112  Garden furniture
    CP05113  Lighting equipment
    CP05119  Other furniture and furnishings

★ 데이터셋 라벨이 "HICP - monthly data (index) (1996-2025)" 로, 2026년치는 아직
  이 데이터셋에 없다. 최신 연도가 비는 것은 정상이며 값을 만들지 않는다.
"""
import io
import collections
import datetime

import requests

URL = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_midx"
PARAMS = {
    "format": "JSON", "lang": "EN",
    "geo": "IT",
    "coicop": "CP05111",     # Household furniture — 매트리스 최근접
    "unit": "I15",           # 지수 2015=100 (화면에서 2020=100 으로 재산정)
}
SINCE = "2019-01"
TIMEOUT = 60
LABEL = "가구 가격지수 (HICP · Household furniture)"
SCOPE_NOTE = ("이탈리아는 매트리스 전용 가격지수가 없어 가정용 가구(HICP "
              "CP05111) 지수를 씁니다. 책상·의자 등이 함께 포함됩니다.")
SOURCE = "Eurostat HICP · prc_hicp_midx · COICOP CP05111 · geo IT"


def fetch_italy_hicp():
    """월별 지수를 받아 연평균으로 집계. 실패하면 reason 을 담아 돌려준다."""
    try:
        r = requests.get(URL, params=dict(PARAMS, sinceTimePeriod=SINCE),
                         timeout=TIMEOUT, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        j = r.json()
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "Eurostat HICP 조회 실패: %s" % str(e)[:90]}
    cat = j.get("dimension", {}).get("time", {}).get("category", {})
    idx, vals = cat.get("index", {}), j.get("value", {})
    if not idx or not vals:
        return {"status": "error", "reason": "HICP 응답에 관측치가 없습니다"}
    by_year = collections.defaultdict(list)
    for month in sorted(idx, key=lambda k: idx[k]):
        v = vals.get(str(idx[month]))
        if v is not None:
            by_year[month[:4]].append(float(v))
    years = [{"year": int(y), "value": round(sum(vs) / len(vs), 2), "months": len(vs)}
             for y, vs in sorted(by_year.items())]
    if not years:
        return {"status": "error", "reason": "HICP 연평균을 만들 수 없습니다"}
    return {"status": "ok", "label": LABEL, "unit": "지수 (원자료 2015=100)",
            "years": years, "scope_note": SCOPE_NOTE, "source": SOURCE,
            "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}


if __name__ == "__main__":
    import json
    import sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    print(json.dumps(fetch_italy_hicp(), ensure_ascii=False, indent=1))
