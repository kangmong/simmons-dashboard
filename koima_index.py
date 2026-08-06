# -*- coding: utf-8 -*-
"""KOIMA 월간 부문별 지수(한국수입협회 국제원자재가격정보) 수집 — 순수 추가 모듈(add-only).

전략: 8개 부문의 전 구간을 한 번에 받아 프론트로 넘긴다. 이후 UI 조작(탭·연월·기간)은
      전부 로컬 필터링이므로 재요청이 없다.

★ 기존 카드(스폰지 주원료/해상 정시성/국제유가)의 수집 코드와 공통화하지 않고 별도 작성.
★ 응답의 mainItemNo/mainItemNm은 null로 오므로 요청 시 보낸 값을 코드가 기억해 매칭한다.
★ registUserId / saveToken / save_FLAG_* 등은 프레임워크 잔재이므로 무시한다.

단독 실행(검증용):
    python koima_index.py            # 수집 후 검증 로그 + 요약 JSON 출력
    python koima_index.py --raw      # 첫 부문 응답 원문을 tmp/koima-raw.json 에 저장하고 종료
    python koima_index.py --out PATH # 수집 결과를 PATH 에 JSON으로 저장
"""
import os
import io
import re
import sys
import json
import time
import datetime

import requests

KOIMA_LIST_URL = "https://www.koimaindex.com/koimaindex/koima/item/index/retrieveList.do"
KOIMA_CHART_URL = "https://www.koimaindex.com/koimaindex/koima/item/index/retrieveChartAjax.do"
KOIMA_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# 부문 매핑 — retrieveList.do 의 fncTab('<no>','<이름>') 파싱으로 확정(2026-08 확인).
# 브루트포스(50~70 요청) 결과도 57~64 만 데이터를 반환해 교차 검증됨.
# key/label 은 프론트 탭에서 사용. 순서는 원본 사이트 탭 순서(=탐색 순서) 그대로 둔다.
KOIMA_CATEGORIES = [
    (57, "agri", "농산품"),
    (58, "mining", "광산품"),
    (59, "inorg", "유무기원료"),
    (60, "petchem", "유화원료"),
    (61, "textile", "섬유원료"),
    (62, "steel", "철강재"),
    (63, "nonferrous", "비철금속"),
    (64, "rare", "희소금속"),
]

# 전 구간 소급 연수. -35 이상에서 1995-12 로 포화(그 이전 데이터는 존재하지 않음).
# ※ 명세의 -30 은 1996-09 부터만 받아와 초기 9개월이 누락되므로 -40 으로 조정했다.
KOIMA_CONDITION = "-40"
KOIMA_SLEEP = 0.3          # 서버 부하 고려: 요청 간 대기(초)
KOIMA_BASELINE = "2010.12 = 100 기준"
KOIMA_SOURCE = "KOIMA 국제원자재가격정보 · 월간 부문별 지수"


def _koima_num(v):
    """문자열 숫자 → float. 빈 값/'-'/None → None (콤마·공백 허용)."""
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    if not s or s in ("-", "--"):
        return None
    try:
        return round(float(s), 2)
    except ValueError:
        return None


def _koima_session():
    s = requests.Session()
    s.headers.update({"User-Agent": KOIMA_UA})
    return s


def _koima_post(sess, no, nm, year, month, condition=KOIMA_CONDITION):
    """부문 1개 차트 조회. (code, list) 반환. 예외는 호출부로 올린다."""
    r = sess.post(
        KOIMA_CHART_URL, timeout=40,
        headers={"Referer": KOIMA_LIST_URL,
                 "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                 "X-Requested-With": "XMLHttpRequest"},
        data={"itemIndexSearchVO.mainItemNo": str(no),
              "itemIndexSearchVO.mainItemNm": nm,
              "itemIndexSearchVO.searchYear": str(year),
              "itemIndexSearchVO.searchMonth": "%02d" % int(month),
              "itemIndexSearchVO.searchCondition": str(condition)})
    r.raise_for_status()
    j = r.json()
    return j.get("code"), (j.get("koimaItemIndexList") or [])


def discover_koima_categories(sess=None):
    """retrieveList.do 의 탭 onclick(fncTab)에서 (no, 부문명) 쌍을 추출.
       실패하면 빈 리스트 → 호출부는 상수 KOIMA_CATEGORIES 를 그대로 쓴다."""
    try:
        sess = sess or _koima_session()
        r = sess.get(KOIMA_LIST_URL, timeout=30)
        r.raise_for_status()
        txt = r.content.decode("utf-8", "replace")
        return [(int(n), nm) for n, nm in re.findall(r"fncTab\('(\d+)','([^']+)'\)", txt)]
    except Exception:  # noqa: BLE001  탐색 실패는 치명적이지 않음(상수 폴백)
        return []


def _koima_rows(lst):
    """응답 배열 → rows[{period, index, momValue, momPct, yoyValue, yoyPct}] (기간 오름차순)."""
    rows = []
    for it in lst:
        period = (it.get("indexYearMonth") or "").strip()
        if not re.match(r"^\d{4}-\d{2}$", period):
            continue
        idx = _koima_num(it.get("nowSum"))
        if idx is None:
            continue  # 지수값 없는 행은 차트/표에 쓸 수 없으므로 제외
        rows.append({
            "period": period,
            "index": idx,
            "momValue": _koima_num(it.get("monthResult")),
            "momPct": _koima_num(it.get("monthPer")),
            "yoyValue": _koima_num(it.get("yearResult")),
            "yoyPct": _koima_num(it.get("yearPer")),
        })
    rows.sort(key=lambda r: r["period"])
    return rows


def update_koima_index():
    """8개 부문 월간 지수 전 구간 수집 → 프론트가 로컬 필터링할 payload.

    기준월은 오늘(연·월)을 그대로 보낸다. 서버가 가용 최신월까지만 잘라서 주므로
    별도의 '이전 달 폴백'이 필요 없다(요청 2026-08 → 응답 마지막 2026-05).
    """
    log = []          # 검증 로그(서버 콘솔 출력용)
    bad_code = []     # code != "200" 이었던 부문
    try:
        sess = _koima_session()
        today = datetime.date.today()

        # 부문 매핑: 사이트에서 재탐색해 상수와 비교(이름이 바뀌면 사이트 쪽을 신뢰)
        found = discover_koima_categories(sess)
        cats = list(KOIMA_CATEGORIES)
        if found:
            by_no = dict(found)
            cats = [(no, key, by_no.get(no, label)) for no, key, label in KOIMA_CATEGORIES]
            missing = [no for no, _, _ in KOIMA_CATEGORIES if no not in by_no]
            extra = [no for no, _ in found if no not in [c[0] for c in KOIMA_CATEGORIES]]
            log.append("부문 탐색: %d개 발견%s%s" % (
                len(found),
                (" · 상수에 있으나 사이트에 없음 %s" % missing) if missing else "",
                (" · 사이트에 새로 생김 %s" % extra) if extra else ""))
        else:
            log.append("부문 탐색 실패 → 상수 매핑(57~64) 사용")

        categories, latest = [], ""
        for i, (no, key, label) in enumerate(cats):
            if i:
                time.sleep(KOIMA_SLEEP)
            code, lst = _koima_post(sess, no, label, today.year, today.month)
            if code != "200":
                bad_code.append("%s(code=%s)" % (label, code))
            rows = _koima_rows(lst)
            if rows and rows[-1]["period"] > latest:
                latest = rows[-1]["period"]
            categories.append({"no": no, "key": key, "label": label, "rows": rows})
            log.append("  %-3d %-6s %-10s rows=%-4d %s .. %s" % (
                no, key, label, len(rows),
                rows[0]["period"] if rows else "-",
                rows[-1]["period"] if rows else "-"))

        filled = [c for c in categories if c["rows"]]
        if not filled:
            return {"status": "error", "reason": "KOIMA 지수 행 없음(형식 변경/차단 가능)"}

        log.append("합계 %d개 부문 / %d행 · 최신월 %s%s" % (
            len(filled), sum(len(c["rows"]) for c in categories), latest,
            (" · ⚠ code≠200: %s" % ", ".join(bad_code)) if bad_code else " · 전 부문 code=200"))
        for line in log:
            print("[koima] " + line)

        return {
            "status": "ok",
            "source": KOIMA_SOURCE,
            "baseline": KOIMA_BASELINE,
            "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "latestPeriod": latest,
            "categories": categories,
        }
    except requests.exceptions.RequestException as e:  # noqa: BLE001
        return {"status": "error", "reason": "KOIMA 조회 실패: %s" % e}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "KOIMA 파싱 실패: %s" % e}


def _save_raw():
    """--raw: 첫 부문(농산품) 응답 원문을 tmp/koima-raw.json 에 저장하고 종료."""
    sess = _koima_session()
    today = datetime.date.today()
    no, _, label = KOIMA_CATEGORIES[0]
    r = sess.post(
        KOIMA_CHART_URL, timeout=40,
        headers={"Referer": KOIMA_LIST_URL,
                 "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                 "X-Requested-With": "XMLHttpRequest"},
        data={"itemIndexSearchVO.mainItemNo": str(no),
              "itemIndexSearchVO.mainItemNm": label,
              "itemIndexSearchVO.searchYear": str(today.year),
              "itemIndexSearchVO.searchMonth": "%02d" % today.month,
              "itemIndexSearchVO.searchCondition": KOIMA_CONDITION})
    base = os.path.dirname(os.path.abspath(__file__))
    tmp = os.path.join(base, "tmp")
    if not os.path.isdir(tmp):
        os.makedirs(tmp)
    path = os.path.join(tmp, "koima-raw.json")
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(r.content.decode("utf-8", "replace"))
    print("[koima] --raw 저장: %s (%d bytes, HTTP %d, 부문=%s)"
          % (path, len(r.content), r.status_code, label))


if __name__ == "__main__":
    try:  # 윈도우 콘솔(cp949)에서 한글/로그가 깨지지 않도록
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    if "--raw" in sys.argv:
        _save_raw()
        sys.exit(0)

    res = update_koima_index()
    if res.get("status") != "ok":
        print("[koima] 실패: %s" % res.get("reason"))
        sys.exit(1)

    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
        d = os.path.dirname(os.path.abspath(out))
        if d and not os.path.isdir(d):
            os.makedirs(d)
        with io.open(out, "w", encoding="utf-8") as f:
            f.write(json.dumps(res, ensure_ascii=False, indent=2))
        print("[koima] 저장: %s" % out)
    else:
        brief = dict(res)
        brief["categories"] = [
            {"no": c["no"], "key": c["key"], "label": c["label"], "rowCount": len(c["rows"]),
             "first": c["rows"][0] if c["rows"] else None,
             "last": c["rows"][-1] if c["rows"] else None}
            for c in res["categories"]]
        print(json.dumps(brief, ensure_ascii=False, indent=2))
