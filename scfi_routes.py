# -*- coding: utf-8 -*-
"""SCFI 항로별 운임 수집 — public/data/scfi-routes.json.

출처: RackingHub 'Ocean Freight Trends'(https://rackinghub.com/freight-trends/)
  상하이해운거래소(SSE)가 매주 금요일 발표하는 SCFI 종합지수·항로별 운임을 매주 월요일
  정리해 싣는 페이지다. 페이지 안의 <script id="ft-series"> JSON 에 항로마다
  {date, value} 가 있다(2025년은 월 1회, 2026년부터 주 1회). 이번 주 카드(.ft-card)에서
  항로 이름·단위(TEU/FEU)·전주 대비를 읽는다.
  ★ 원 발표 기관은 SSE 이고, 페이지는 '참고용'이라 밝히고 원자료 내려받기는 제공하지
    않는다고 적었다. 사용자 결정(2026-10-24)에 따라 주 1회만 읽어 대시보드에 싣는다.
    화면에는 원 발표 기관과 이 페이지를 출처로 함께 밝힌다.

★ 받아들이는 조건 — 종합지수와 항로 7개 이상, 항로마다 점 10개 이상, 모든 값이 숫자일
  때만 저장한다. 하나라도 어긋나면 기존 파일을 그대로 둔다.
★ 이미 받은 점은 지우지 않는다 — 페이지가 오래된 점을 빼더라도 파일에는 쌓인다.
★ 바뀐 것이 없으면 파일을 쓰지 않는다. 요청은 실행마다 1번.
"""
import datetime
import io
import json
import re
import sys

import requests
from bs4 import BeautifulSoup

OUT = "public/data/scfi-routes.json"
URL = "https://rackinghub.com/freight-trends/"
KST = datetime.timezone(datetime.timedelta(hours=9))
HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
KO = {
    "composite": "종합지수", "europe": "유럽", "mediterranean": "지중해",
    "us-west": "미주 서안", "us-east": "미주 동안", "persian-gulf": "페르시아만(중동)",
    "australia-nz": "호주·뉴질랜드", "south-america": "남미",
}


def fetch():
    r = requests.get(URL, headers=HDR, timeout=60)
    r.raise_for_status()
    r.encoding = "utf-8"          # 서버가 문자 집합을 안 밝혀 ISO-8859-1 로 읽히면 − 가 깨진다
    soup = BeautifulSoup(r.text, "html.parser")
    js = soup.find("script", id="ft-series")
    if js is None or not js.string:
        raise ValueError("ft-series 데이터가 없음(페이지 구조가 바뀌었을 수 있음)")
    raw = json.loads(js.string)
    cards = {}
    for c in soup.select(".ft-card"):
        lane = c.get("data-lane")
        name = c.select_one(".ft-lane")
        val = c.select_one(".ft-value")
        wow = c.select_one(".ft-wow")
        if not lane or not val:
            continue
        unit = re.search(r"/\s*(TEU|FEU)", val.get_text(" ")) if lane != "composite" else None
        m = re.search(r"([+\-−])\s*(\d+(?:\.\d+)?)%", wow.get_text(" ") if wow else "")
        cards[lane] = {
            "en": name.get_text(" ", strip=True) if name else lane,
            "unit": "pt" if lane == "composite" else (unit.group(1) if unit else ""),
            "wow": (-1 if m and m.group(1) in "-−" else 1) * float(m.group(2)) if m else None,
        }
    if "composite" not in raw or len(raw) < 8:
        raise ValueError("항로 수가 모자람: %s" % list(raw))
    lanes = []
    for lid, pts in raw.items():
        if not isinstance(pts, list) or len(pts) < 10:
            raise ValueError("%s 점이 모자람" % lid)
        dates, vals = [], []
        for p in pts:
            d, v = p.get("date"), p.get("value")
            if not (isinstance(d, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d)
                    and isinstance(v, (int, float))):
                raise ValueError("%s 값 형식 오류: %s" % (lid, p))
            dates.append(d)
            vals.append(v)
        cd = cards.get(lid, {})
        if lid != "composite" and cd.get("unit") not in ("TEU", "FEU"):
            raise ValueError("%s 단위를 못 읽음" % lid)
        lanes.append({"id": lid, "ko": KO.get(lid, lid), "en": cd.get("en", lid),
                      "unit": cd.get("unit", ""), "wow": cd.get("wow"),
                      "dates": dates, "values": vals})
    return lanes


def merge(old, new):
    """이미 받은 점을 지우지 않는다 — 날짜별로 합친다(같은 날짜는 새 값)."""
    prev = {l["id"]: dict(zip(l["dates"], l["values"])) for l in (old or {}).get("lanes", [])}
    for l in new:
        m = prev.get(l["id"], {})
        m.update(zip(l["dates"], l["values"]))
        ds = sorted(m)
        l["dates"], l["values"] = ds, [m[d] for d in ds]
    return new


def main():
    try:
        lanes = fetch()
    except Exception as e:  # noqa: BLE001
        print("[scfi] 수집 실패 → 기존 파일을 그대로 둠: %s" % str(e)[:160])
        return 1
    try:
        old = json.load(io.open(OUT, encoding="utf-8"))
    except (OSError, ValueError):
        old = None
    lanes = merge(old, lanes)
    data = {
        "status": "ok",
        "source": "RackingHub Ocean Freight Trends",
        "url": URL,
        "origin": "상하이해운거래소(SSE)",
        "originUrl": "https://www.sse.net.cn/index/singleIndex?indexType=scfi",
        "note": "SSE 발표치를 RackingHub 가 정리해 싣는 값 · 2025년은 월 1회, 2026년부터 주 1회 점",
        "asOf": max(l["dates"][-1] for l in lanes),
        "lanes": lanes,
    }
    if old and {k: v for k, v in old.items() if k != "updatedAt"} == data:
        print("[scfi] 바뀐 값 없음(최신 %s) → 파일을 쓰지 않음" % data["asOf"])
        return 0
    data["updatedAt"] = datetime.datetime.now(KST).strftime("%Y-%m-%d %H:%M")
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("[scfi] 저장 — %d개 항로 · 기준 %s · %s" % (
        len(lanes), data["asOf"], ", ".join("%s %s" % (l["ko"], l["values"][-1]) for l in lanes)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
