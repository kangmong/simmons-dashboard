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
import time

import requests
from bs4 import BeautifulSoup

OUT = "public/data/scfi-routes.json"
URL = "https://rackinghub.com/freight-trends/"
KSA_URL = "https://oneksa.kr/shipping_index/lists"
KSA_FROM = "2023-01-01"
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


def fetch_ksa(since):
    """한국해운협회 '해상운임지수'(https://oneksa.kr/shipping_index) — SCFI 유럽·미주 서안·미주 동안
    주간 값. RackingHub 는 2025-01 부터라 그 앞(2023-01~)을 이것으로 채운다.
    ★ 날짜별 표(하루 한 줄, SCFI 는 발표일 줄에만 값)를 쪽마다 넘기며 since 까지 읽는다.
    ★ 겹치는 93개 값 중 90개가 RackingHub 와 같았다(2025-04-30 하루만 달랐다) —
      그래서 이 값은 RackingHub 에 없는 날짜만 채운다(merge)."""
    cols = {4: "us-west", 5: "europe", 6: "us-east"}
    out = {v: {} for v in cols.values()}
    today = datetime.date.today().isoformat()
    for page in range(1, 120):
        r = requests.get(KSA_URL, params={"sdate": since, "edate": today, "page": page},
                         headers=HDR, timeout=60)
        r.raise_for_status()
        rows = [[c.get_text(strip=True) for c in tr.find_all("td")]
                for tr in BeautifulSoup(r.text, "html.parser").select("table.tbl_type1.pc tr")]
        rows = [x for x in rows if len(x) >= 7 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", x[0])]
        if not rows:
            break
        for x in rows:
            for c, lid in cols.items():
                v = x[c].replace(",", "")
                if re.fullmatch(r"\d+(?:\.\d+)?", v):
                    out[lid][x[0]] = float(v) if "." in v else int(v)
        if rows[-1][0] <= since:
            break
        time.sleep(0.7)
    return out


def merge(old, new, extra=None):
    """이미 받은 점을 지우지 않는다 — 날짜별로 합친다(같은 날짜는 새 값).
    extra(한국해운협회)는 비어 있는 날짜만 채운다."""
    prev = {l["id"]: dict(zip(l["dates"], l["values"])) for l in (old or {}).get("lanes", [])}
    for l in new:
        m = prev.get(l["id"], {})
        m.update(zip(l["dates"], l["values"]))
        # ★ 중국 연휴 앞에는 SSE 가 하루이틀 일찍 발표한다(09-30·06-18 등). RackingHub 는
        #   실제 발표일로, 한국해운협회는 그 주 금요일로 적어 같은 값이 두 점이 된다 —
        #   이미 있는 점에서 4일 안쪽이면 같은 발표로 보고 넣지 않는다.
        have = [datetime.date.fromisoformat(d) for d in m]
        added = set()
        for d, v in (extra or {}).get(l["id"], {}).items():
            x = datetime.date.fromisoformat(d)
            if all(abs((x - h).days) > 4 for h in have):
                m[d] = v
                added.add(d)
        # ★ 한국해운협회 값은 사람이 옮겨 적은 표라 오타로 보이는 점이 있다(2025-10-17 유럽
        #   1,955 — 앞뒤 1,068·1,246). 원자료(SSE)는 유료라 맞춰 볼 수 없으니, 채운 점 중
        #   앞뒤 점 '둘 다'와 35% 넘게 같은 쪽으로 튄 한 주짜리 점은 넣지 않는다.
        ds = sorted(m)
        bad = []
        for i in range(1, len(ds) - 1):
            if ds[i] in added:
                a, v, b = m[ds[i - 1]], m[ds[i]], m[ds[i + 1]]
                if (v > a * 1.35 and v > b * 1.35) or (v < a / 1.35 and v < b / 1.35):
                    print("[scfi] %s %s %s 는 앞뒤(%s·%s)와 크게 달라 넣지 않음" % (l["id"], ds[i], v, a, b))
                    bad.append(ds[i])
        for d in bad:
            del m[d]
        ds = sorted(m)
        l["dates"], l["values"] = ds, [m[d] for d in ds]
    return new


def _demo():
    old = {"lanes": [{"id": "europe", "dates": ["2025-01-03"], "values": [1]}]}
    new = [{"id": "europe", "dates": ["2025-01-10"], "values": [2]}]
    l = merge(old, new, {"europe": {"2023-01-06": 9, "2025-01-10": 7, "2025-01-12": 7, "2025-01-17": 5}})[0]
    assert l["dates"] == ["2023-01-06", "2025-01-03", "2025-01-10", "2025-01-17"] and l["values"] == [9, 1, 2, 5]


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
    # 처음(또는 과거가 비었을 때)만 2023-01 부터 다 읽고, 평소에는 최근 두 달만 읽는다
    first = min((l["dates"][0] for l in (old or {}).get("lanes", []) if l["id"] == "europe"), default="9999")
    since = KSA_FROM if first > KSA_FROM[:7] + "-31" else (
        datetime.date.today() - datetime.timedelta(days=60)).isoformat()
    try:
        extra = fetch_ksa(since)
        print("[scfi] 한국해운협회 %s~ : %s" % (since, ", ".join("%s %d주" % (k, len(v)) for k, v in extra.items())))
    except Exception as e:  # noqa: BLE001
        extra = None
        print("[scfi] 한국해운협회 수집 실패(RackingHub 값만 저장): %s" % str(e)[:160])
    lanes = merge(old, lanes, extra)
    data = {
        "status": "ok",
        "source": "RackingHub Ocean Freight Trends",
        "url": URL,
        "source2": "한국해운협회 해상운임지수",
        "url2": KSA_URL.rsplit("/", 1)[0],
        "origin": "상하이해운거래소(SSE)",
        "originUrl": "https://www.sse.net.cn/index/singleIndex?indexType=scfi",
        "note": "SSE 발표치 · RackingHub(2025년은 월 1회, 2026년부터 주 1회) + 한국해운협회(유럽·미주 서안·미주 동안 2023-01~ 주 1회)",
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
    if "--demo" in sys.argv:
        _demo()
        print("ok")
        sys.exit(0)
    sys.exit(main())
