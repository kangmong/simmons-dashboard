# -*- coding: utf-8 -*-
"""국내 실적 화면 파일(simmons-market.json)을 DART 수집 결과로 맞춘다.

dart_financials.py 가 감사보고서·정기보고서에서 받아 둔 값
(public/data/simmons-financials.json)을 국내 섹션 차트 파일에 옮겨 적는다.
네트워크를 쓰지 않는다 — 이미 받은 파일만 읽는다.

옮기는 것
  · simmonsPerformance          시몬스 최근 4개 연도 매출·영업이익(history)
  · competitorRevenueLastYear   시몬스·에이스침대·템퍼코리아·씰리코리아·금성침대
                                매출과 전년 대비(별도·개별 재무제표)
옮기지 않는 것(사람이 관리)
  · 코웨이 — 매트리스 매출을 따로 공시하지 않는다(렌탈사업부 합산 보도치)
  · 지누스 — 화면은 '국내 매출' 보도치인데 DART 는 전체 매출이라 기준이 다르다
  · 점유율(IMARC)·수면시장 규모·슬립테크 기업 — DART 에 없는 자료

★ DART 쪽 회계연도가 화면에 있는 것보다 새것이거나 같을 때만 바꾼다.
★ 바뀐 것이 없으면 파일을 쓰지 않는다.
"""
import datetime
import io
import json
import sys

FIN = "public/data/simmons-financials.json"
MKT = "public/data/simmons-market.json"
DART_PEERS = ("에이스침대", "템퍼코리아", "씰리코리아", "금성침대")
KST = datetime.timezone(datetime.timedelta(hours=9))


def r1(v):
    """화면은 억원 정수로 적어 왔다. 1,000억 미만은 소수 첫째 자리까지 둔다."""
    return round(v) if abs(v) >= 1000 else round(v, 1)


def yoy(cur, prev):
    return round((cur / prev - 1) * 100, 1) if cur is not None and prev else None


def main():
    fin = json.load(io.open(FIN, encoding="utf-8"))
    mkt = json.load(io.open(MKT, encoding="utf-8"))
    if fin.get("status") != "ok":
        print("[sync] DART 결과가 정상이 아님(%s) → 그대로 둠" % fin.get("status"))
        return 0
    before = json.dumps(mkt, ensure_ascii=False, sort_keys=True)

    # 1) 시몬스 최근 4개 연도
    hist = sorted((h for h in fin.get("history") or [] if h.get("revenue") is not None),
                  key=lambda h: h["year"])[-4:]
    if len(hist) >= 2:
        mkt["simmonsPerformance"] = [
            {"year": h["year"], "revenue": round(h["revenue"]),
             "operatingProfit": round(h["operatingProfit"])} for h in hist]

    # 2) 회사별 매출 막대
    comp = mkt["competitorRevenueLastYear"]
    rows = {c["name"]: c for c in comp["companies"]}
    src = {}
    if len(hist) >= 2 and "시몬스" in rows:
        src["시몬스"] = (hist[-1]["year"], hist[-1]["revenue"], hist[-2]["revenue"])
    for p in fin.get("peers") or []:
        rev = ((p.get("accounts") or {}).get("revenue") or {})
        if p.get("name") in DART_PEERS and rev.get("current") is not None:
            src[p["name"]] = (p.get("fiscalYear"), rev["current"], rev.get("previous"))
    for name, (fy, cur, prev) in src.items():
        row = rows.get(name)
        if not row or not fy or fy < (row.get("year") or 0):
            continue
        row.update(revenue=r1(cur), yoyChangePct=yoy(cur, prev), year=fy)
    comp["year"] = max(c.get("year") or 0 for c in comp["companies"])

    # 3) 각주 — 기준 연도·출처는 값에서 다시 만든다(옛 연도가 글에 남지 않게)
    keep = [n for n in comp.get("notes") or [] if n.startswith("코웨이는")]
    auto = [n for n in rows if n in src]
    manual = [n for n in rows if n not in src]
    by_year = {}
    for c in comp["companies"]:
        by_year.setdefault(c.get("year"), []).append(c["name"].split("(")[0])
    comp["notes"] = keep + [
        "%s는 DART 감사보고서·정기보고서의 별도(개별) 재무제표 매출이며 새 보고서가 나오면 "
        "자동으로 바뀝니다. %s는 언론 보도 기준이라 집계 기준이 달라 직접 비교 시 유의가 필요합니다."
        % ("·".join(auto), "·".join(n.split("(")[0] for n in manual)),
        "막대마다 괄호 안에 기준 회계연도를 적었습니다 — "
        + ", ".join("%s는 %s년" % ("·".join(v), y)
                    for y, v in sorted(by_year.items(), key=lambda kv: -(kv[0] or 0)))
        + " 기준입니다.",
    ]

    if json.dumps(mkt, ensure_ascii=False, sort_keys=True) == before:
        print("[sync] 바뀐 값 없음 → 파일을 쓰지 않음")
        return 0
    mkt["lastUpdated"] = datetime.datetime.now(KST).date().isoformat()
    io.open(MKT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(mkt, ensure_ascii=False, indent=2) + "\n")
    for c in comp["companies"]:
        print("[sync] %-24s %8s억  %s  (%s년)" % (c["name"], c["revenue"], c.get("yoyChangePct"), c.get("year")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
