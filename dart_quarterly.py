# -*- coding: utf-8 -*-
"""상장 경쟁사 분기 실적 — DART 정기보고서(분기·반기·사업보고서)에서 자동 수집(주 1회).

· 대상: 상장사만(에이스침대·지누스·코웨이). 시몬스·템퍼·씰리·금성은 비상장이라 분기 공시가 없다.
· 별도(OFS) 재무제표 — 기존 연간 비교(dart_financials.py)와 같은 기준.
· 1~3분기: 보고서의 '3개월' 값(thstrm_amount) 그대로.
  4분기: 사업보고서 연간 값 − 1~3분기 합(공시 값끼리의 뺄셈, derived 표시). 하나라도 없으면 비운다.
· 이미 받은 분기는 다시 받지 않는다(올해와 직전 해만 매번 확인).
★ 실패해도 기존 파일을 덮어쓰지 않는다. 바뀐 게 없으면 쓰지 않는다.

    python dart_quarterly.py           # 갱신
    python dart_quarterly.py --print   # 받기만
"""
import datetime
import io
import json
import re
import sys

import requests

from dart_financials import API, TIMEOUT, api_key

OUT = "public/data/peer-quarterly.json"
COMPANIES = [("에이스침대", "00140052"), ("지누스", "00150633"), ("코웨이", "00170558")]
RC = {"Q1": "11013", "H1": "11012", "Q3": "11014", "FY": "11011"}
REV = ("매출액", "수익(매출액)", "영업수익")
OP = ("영업이익", "영업이익(손실)")
EOK = 100000000.0


def won(s):
    s = (s or "").replace(",", "").strip()
    return int(s) if re.fullmatch(r"-?\d+", s) else None


def fetch(key, code, year, rc):
    d = requests.get(API + "/fnlttSinglAcntAll.json", params={"crtfc_key": key, "corp_code": code, "bsns_year": str(year),
                                                               "reprt_code": rc, "fs_div": "OFS"}, timeout=TIMEOUT).json()
    if d.get("status") == "013":
        return None                       # 아직 제출 전
    if d.get("status") != "000":
        raise RuntimeError("DART %s %s" % (d.get("status"), d.get("message")))
    rows = d.get("list") or []

    def pick(names):
        for r in rows:
            if r.get("sj_div") in ("IS", "CIS") and re.sub(r"\s+", "", r.get("account_nm") or "") in names:
                return won(r.get("thstrm_amount"))
        return None
    return {"rev": pick(REV), "op": pick(OP), "rcept": rows[0].get("rcept_no") if rows else ""}


def collect_year(key, code, year, have):
    """{'2026Q1': {...}} — have 에 이미 있는 분기는 건너뛴다(4분기는 사업보고서가 있어야)."""
    out = {}
    got = {}
    for q, part in (("Q1", "Q1"), ("Q2", "H1"), ("Q3", "Q3")):
        k = "%dQ%s" % (year, q[1])
        if k in have:
            got[q] = have[k]
            continue
        r = fetch(key, code, year, RC[part])
        if r and r["rev"] is not None:
            got[q] = out[k] = {"rev": round(r["rev"] / EOK, 1), "op": round(r["op"] / EOK, 1) if r["op"] is not None else None,
                               "rcept": r["rcept"]}
    k4 = "%dQ4" % year
    if k4 not in have and all(q in got for q in ("Q1", "Q2", "Q3")):
        fy = fetch(key, code, year, RC["FY"])
        if fy and fy["rev"] is not None:
            rev = fy["rev"] / EOK - sum(got[q]["rev"] for q in ("Q1", "Q2", "Q3"))
            op = (fy["op"] / EOK - sum(got[q]["op"] for q in ("Q1", "Q2", "Q3"))) \
                if fy["op"] is not None and all(got[q]["op"] is not None for q in ("Q1", "Q2", "Q3")) else None
            out[k4] = {"rev": round(rev, 1), "op": round(op, 1) if op is not None else None, "rcept": fy["rcept"], "derived": True}
    return out


def main():
    only = "--print" in sys.argv
    key = api_key()
    if not key:
        print("X DART_API_KEY 없음 — 기존 파일 유지")
        return 1
    try:
        data = json.load(io.open(OUT, encoding="utf-8"))
    except Exception:  # noqa: BLE001
        data = {"companies": []}
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    years = [now.year - 2, now.year - 1, now.year]
    before = json.dumps(data.get("companies"), ensure_ascii=False, sort_keys=True)
    comps = {c["name"]: c for c in data.get("companies") or []}
    try:
        for name, code in COMPANIES:
            c = comps.setdefault(name, {"name": name, "corpCode": code, "quarters": {}})
            for y in years:
                new = collect_year(key, code, y, c["quarters"])
                for k, v in new.items():
                    print("[dq] %s %s 매출 %s억 · 영업이익 %s억%s" % (name, k, v["rev"], v["op"], " (연간−1~3분기)" if v.get("derived") else ""))
                c["quarters"].update(new)
            c["quarters"] = dict(sorted(c["quarters"].items()))
    except Exception as e:  # noqa: BLE001
        print("X 수집 실패 — 기존 파일 유지: %s" % e)
        return 1
    data.update({"status": "ok", "unit": "억원", "basis": "별도 재무제표",
                 "source": "금융감독원 DART 분기·반기·사업보고서", "checkedAt": now.strftime("%Y-%m-%d"),
                 "companies": [comps[n] for n, _ in COMPANIES]})
    if only:
        return 0
    if json.dumps(data["companies"], ensure_ascii=False, sort_keys=True) == before:
        print("[dq] 새 분기 없음")
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
