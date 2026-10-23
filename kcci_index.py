# -*- coding: utf-8 -*-
"""KCCI(한국해양진흥공사 컨테이너선 운임지수) 수집 — public/data/kcci-index.json.

출처: 한국해양진흥공사(KOBC) 해양정보서비스
  · 시계열  https://www.kobc.or.kr/ebz/shippinginfo/timeseries/gridList.do?mId=0304000000
            sDay·eDay 를 POST 하면 그 기간의 주간 값을 표로 준다(최초 발표 2022-11-07).
  · 항로표  https://www.kobc.or.kr/ebz/shippinginfo/kcci/gridList.do?mId=0304000000
            항로 구분(Group)·영문 항로명·비중(Weight)을 읽는다.
  공공데이터포털(15131881)에 같은 자료가 '이용허락범위 제한 없음'으로 등록돼 있다.
  발표: 매주 월요일 14시. 로그인·키가 필요 없다. 실행마다 요청 2번.

★ 받아들이는 조건 — 표 머리의 지수 코드 14개가 예상과 같고, 주가 100개 이상이며,
  모든 칸이 숫자일 때만 저장한다. 하나라도 어긋나면 기존 파일을 그대로 둔다
  (사이트 개편으로 열 순서가 바뀌면 다른 항로 값을 넣게 되므로).
★ 바뀐 것이 없으면 파일을 쓰지 않는다.
"""
import datetime
import io
import json
import re
import sys

import requests
from bs4 import BeautifulSoup

OUT = "public/data/kcci-index.json"
TS_URL = "https://www.kobc.or.kr/ebz/shippinginfo/timeseries/gridList.do?mId=0304000000"
GRID_URL = "https://www.kobc.or.kr/ebz/shippinginfo/kcci/gridList.do?mId=0304000000"
FIRST_DAY = "2022-11-07"
CODES = ["KCCI", "KUWI", "KUEI", "KNEI", "KMDI", "KMEI", "KAUI", "KLEI", "KLWI",
         "KSAI", "KWAI", "KCI", "KJI", "KSEI"]
KST = datetime.timezone(datetime.timedelta(hours=9))
HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


def cells(tr):
    return [re.sub(r"\s+", " ", c.get_text(" ")).strip() for c in tr.find_all(["th", "td"])]


def num(s):
    s = s.replace(",", "").strip()
    if not re.fullmatch(r"-?\d+(\.\d+)?", s):
        raise ValueError("숫자가 아님: %r" % s)
    v = float(s)
    return int(v) if v.is_integer() else v


def fetch_series(today):
    r = requests.post(TS_URL, headers=HDR, timeout=60,
                      data={"sDay": FIRST_DAY, "eDay": today.isoformat()})
    r.raise_for_status()
    t = BeautifulSoup(r.text, "html.parser").find("table")
    if t is None:
        raise ValueError("시계열 표가 없음")
    rows = [cells(tr) for tr in t.find_all("tr")]
    # 머리 두 줄: [Date, KCCI, Mainlane, ...] / [KUWI, KUEI, ... KSEI]
    head2 = next((r for r in rows if r and r[0] == "KUWI"), None)
    if not head2 or ["KCCI"] + head2 != CODES or rows[0][:2] != ["Date", "KCCI"]:
        raise ValueError("표 머리의 지수 코드가 예상과 다름: %s" % (head2,))
    data = [r for r in rows if r and re.fullmatch(r"\d{4}-\d{2}-\d{2}", r[0])]
    if len(data) < 100:
        raise ValueError("주가 너무 적음: %d" % len(data))
    data.sort(key=lambda r: r[0])
    out = {c: [] for c in CODES}
    dates = []
    for r in data:
        if len(r) != 1 + len(CODES):
            raise ValueError("칸 수가 다름: %s" % r)
        dates.append(r[0])
        for c, v in zip(CODES, r[1:]):
            out[c].append(num(v))
    return dates, out


def fetch_meta():
    r = requests.get(GRID_URL, headers=HDR, timeout=60)
    r.raise_for_status()
    t = BeautifulSoup(r.text, "html.parser").find("table")
    meta, group = {}, ""
    for tr in t.find_all("tr"):
        c = cells(tr)
        if len(c) == 7:          # 구분 칸이 있는 줄(rowspan 첫 줄)
            group, c = c[0], c[1:]
        if len(c) == 6 and c[0] in CODES:
            meta[c[0]] = {"group": group, "route": c[1],
                          "weight": num(c[2].rstrip("%"))}
    if set(meta) != set(CODES):
        raise ValueError("항로표 코드가 예상과 다름: %s" % sorted(meta))
    return meta


def main():
    today = datetime.datetime.now(KST).date()
    try:
        dates, series = fetch_series(today)
        meta = fetch_meta()
    except Exception as e:  # noqa: BLE001
        print("[kcci] 수집 실패 → 기존 파일을 그대로 둠: %s" % str(e)[:160])
        return 1
    data = {
        "status": "ok",
        "source": "한국해양진흥공사(KOBC) 해양정보서비스",
        "url": GRID_URL,
        "tsUrl": TS_URL,
        "unitNote": "종합지수(KCCI)는 포인트(pt), 항로별 지수는 $/FEU(40피트 컨테이너 1개)",
        "release": "매주 월요일 14시",
        "codes": CODES,
        "meta": meta,
        "dates": dates,
        "series": series,
    }
    try:
        old = json.load(io.open(OUT, encoding="utf-8"))
        if {k: v for k, v in old.items() if k != "updatedAt"} == data:
            print("[kcci] 바뀐 값 없음(최신 %s) → 파일을 쓰지 않음" % dates[-1])
            return 0
    except (OSError, ValueError):
        pass
    data["updatedAt"] = datetime.datetime.now(KST).strftime("%Y-%m-%d %H:%M")
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("[kcci] 저장 — %d주 (%s ~ %s) · 종합 %s" % (len(dates), dates[0], dates[-1],
                                                 series["KCCI"][-1]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
