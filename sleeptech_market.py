# -*- coding: utf-8 -*-
"""글로벌 슬립테크 기기 시장 규모 — Global Market Insights 공개 요약에서 자동 갱신(월 1회).

global-sleeptech.json 의 deviceMarket(막대 그래프·요약·출처 표)만 고친다.
'최근 소식(updates)'은 sleeptech_news.py 몫이라 그대로 둔다.

★ 페이지 문장에 적힌 숫자만 쓴다(계산·추정 없음). 원화 환산은 화면이 한다.
★ 실패하면 기존 값을 그대로 두고 last_error 만 남긴다(값이 사라진 JSON 을 만들지 않는다).

    python sleeptech_market.py            # 갱신
    python sleeptech_market.py --print    # 읽기만
"""
import io
import json
import re
import sys
from datetime import datetime

from mattress_market import fetch, to_text, KST

URL = "https://www.gminsights.com/industry-analysis/sleep-tech-devices-market"
OUT = "public/data/global-sleeptech.json"
ORG = "Global Market Insights"


def parse(t):
    """'estimated/valued at USD 29.3 billion in 2025 … from USD 34.6 billion in 2026 to USD 160.6 billion in 2035, at a CAGR of 18.6%'"""
    out = {}
    m = re.search(r"(?:estimated|valued) at USD ([\d.]+) billion in (\d{4})", t)
    if m:
        out["base"] = (int(m.group(2)), float(m.group(1)))
    m = re.search(r"from USD ([\d.]+) billion in (\d{4}) to USD ([\d.]+) billion (?:in|by) (\d{4})", t)
    if m:
        out["next"] = (int(m.group(2)), float(m.group(1)))
        out["target"] = (int(m.group(4)), float(m.group(3)))
    m = re.search(r"CAGR of ([\d.]+)%", t) or re.search(r"CAGR \(\d{4}[–\-]\d{4}\) ([\d.]+)%", t)
    if m:
        out["cagr"] = float(m.group(1))
    m = re.search(r"Published Date: ([A-Z][a-z]+ \d{4})", t)
    if m:
        out["published"] = m.group(1)
    return out


def eok(bn):
    """10억 달러 단위(billion) → 억 달러. 29.3 → 293 (자리 옮김일 뿐 계산 추정 아님)"""
    return int(round(bn * 10))


def lbl(v):
    return "{:,}억 달러".format(v)


def apply(dm, p, now):
    (y0, b0), (y1, b1), (y2, b2) = p["base"], p["next"], p["target"]
    v0, v1, v2 = eok(b0), eok(b1), eok(b2)
    dm["subtitle"] = "%s · %d년 추정~%d년 전망" % (ORG, y0, y2)
    dm["points"] = [
        {"year": y0, "usdEok": v0, "label": lbl(v0), "kind": "actual"},
        {"year": y1, "usdEok": v1, "label": lbl(v1), "kind": "forecast"},
        {"year": y2, "usdEok": v2, "label": lbl(v2), "kind": "forecast"},
    ]
    dm["cagrPct"] = p["cagr"]
    dm["summary"] = ("글로벌 슬립테크 기기 시장은 %d년 %s로 추정되고, %d년 %s, %d년에는 %s까지 "
                     "연평균 %s%%씩 자랄 전망입니다(%s%s)." % (
                         y0, lbl(v0), y1, lbl(v1), y2, lbl(v2), ("%g" % p["cagr"]), ORG,
                         " · %s 발표" % p["published"] if p.get("published") else ""))
    dm["basis"] = [{"year": y0, "value": lbl(v0), "org": ORG},
                   {"year": y1, "value": lbl(v1), "org": ORG, "note": "전망"},
                   {"year": y2, "value": lbl(v2), "org": ORG, "note": "전망"}]
    dm["foot"] = "%s 공개 요약을 매월 자동 확인 · 최근 확인 %s" % (ORG, now)
    dm["sourceUrl"] = URL
    dm["checkedAt"] = now
    dm.pop("last_error", None)


def main():
    only = "--print" in sys.argv
    now = datetime.now(KST).strftime("%Y-%m-%d")
    data = json.load(io.open(OUT, encoding="utf-8"))
    dm = data.setdefault("deviceMarket", {})
    try:
        p = parse(to_text(fetch(URL)))
        miss = [k for k in ("base", "next", "target", "cagr") if k not in p]
        if miss:
            raise ValueError("필수 항목을 못 찾음(%s) — 페이지 구조가 바뀐 듯" % ", ".join(miss))
    except Exception as e:  # noqa: BLE001 — 기존 값은 그대로
        print("X 수집 실패: %s" % e)
        if not only:
            dm["last_error"], dm["last_attempt"] = str(e)[:200], now
            io.open(OUT, "w", encoding="utf-8", newline="\n").write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        return 1
    print("OK", p)
    if only:
        return 0
    before = json.dumps({k: dm.get(k) for k in ("points", "cagrPct")}, ensure_ascii=False)
    apply(dm, p, now)
    after = json.dumps({k: dm.get(k) for k in ("points", "cagrPct")}, ensure_ascii=False)
    print("변경" if before != after else "값 같음(확인 날짜만 갱신)")
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return 0


def _demo():
    t = ("The global sleep tech devices market was estimated at USD 29.3 billion in 2025. The market is expected to grow "
         "from USD 34.6 billion in 2026 to USD 160.6 billion in 2035, at a CAGR of 18.6% during")
    p = parse(t)
    assert p == {"base": (2025, 29.3), "next": (2026, 34.6), "target": (2035, 160.6), "cagr": 18.6}, p
    dm = {}
    apply(dm, p, "2026-11-12")
    assert [x["usdEok"] for x in dm["points"]] == [293, 346, 1606], dm["points"]
    print("demo ok")


if __name__ == "__main__":
    if "--demo" in sys.argv:
        _demo()
        sys.exit(0)
    sys.exit(main())
