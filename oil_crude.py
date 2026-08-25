# -*- coding: utf-8 -*-
"""국제유가(원유) — 한국석유공사 PETRONET '일일국제원유가격'. API 키 불필요 · 무료.

    페이지  국제석유가격 > 일일국제원유가격
            fmuId=KDFQSTAT · smuId=KDFQ01 · tmuId=KDFQ0100 (03 / 03_01 / 03_01_01)
    표      https://www.petronet.co.kr/v4/excel/KDFQ0100_x2.jsp  (GET · 엑셀용 HTML 표)
    단위    $/배럴

★ 유종 코드는 실제 조회 페이지의 체크박스에서 확인했다(2026-08 실측).
    001 Dubai · 002 Brent(ICE) · 003 WTI(NYMEX) · 004 Oman
  기존 카드가 쓰던 KDFQ0200(일일국제제품가격, 휘발유·경유·나프타)과는 다른 표다.

★ 기준선택(term)도 같은 페이지의 라디오에서 확인했다.
    y 년 · q 분기 · m 월 · w 주 · d 일     (화면에는 q 를 빼고 4개만 둔다)
  term 마다 표의 첫 열 형식과 요약행 구성이 다르다 — 실측:
    y : '2016년'      + 전년비 · 평균
    m : '26년 01월'   + 전월비 · 전년동월비 · 평균
    w : '06월 1주'    + 전주비 · 전월동주비 · 전년동주비 · 평균
    d : '08월 03일'   + 전일비 · 전주비 · 전월동일비 · 전년동일비 · 평균

★ 주(w)만 한 번에 약 30행까지다(실측). 2026-02~08(30행)은 오고 2026-01~08은
  빈 응답이 온다. 과거 구간 단독 조회는 정상이므로 '기간이 과거라서'가 아니라
  '행이 많아서' 잘리는 것이다. 그래서 주는 6개월씩 끊어 받아 합친다(_fetch_weekly).
  년·월·일은 상한에 걸리지 않는다(일 940행 정상).

★ 화면의 '조회'는 서버를 다시 부르지 않는다.
  기준별로 넉넉한 구간을 미리 받아 두고(아래 RANGES), 프런트가 사용자가 고른
  기간·유종만 잘라 그린다. 요약행(전일비 등)도 프런트가 '받아둔 전 구간'에서
  계산한다 — 조회 창 밖의 과거 값이 필요해서다(전년동일비는 1년 전 값을 본다).
  PETRONET 이 계산해 주는 요약행은 payload 에 그대로 실어 둔다(대조용).

★ 값을 만들지 않는다. 결측('-')은 None 으로 비운다.
"""
import io
import re
import json
import time
import datetime

import requests

EXCEL_URL = "https://www.petronet.co.kr/v4/excel/KDFQ0100_x2.jsp"
REFERER = "https://www.petronet.co.kr/v4/sub.jsp"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": REFERER}
TIMEOUT = 60

# (PETRONET 코드, 응답키, 표시라벨) — 요청 ProdCDList 순서 = 표의 열 순서
CRUDES = [
    ("001", "dubai", "Dubai"),
    ("002", "brent", "Brent(ICE)"),
    ("003", "wti", "WTI(NYMEX)"),
    ("004", "oman", "Oman"),
]
CODE_PARAM = ",".join(c for c, _, _ in CRUDES)
DEFAULT_ON = ["dubai", "brent", "wti"]      # 실제 사이트 기본 체크(Oman 해제)

# 기준별로 미리 받아 둘 구간. 프런트가 이 안에서 잘라 쓴다.
# ★ 일·주는 '전년동일비'를 계산하려면 보이는 구간보다 1년 이상 더 필요하다.
#   넉넉히 두되 payload 가 커지지 않게 아래 정도로 잡았다(실측 약 80KB).
RANGES = {
    "y": {"label": "년", "years": 27},
    "m": {"label": "월", "years": 15},
    "w": {"label": "주", "years": 3},
    "d": {"label": "일", "years": 3},
}

WEEK_CHUNK_MONTHS = 6     # 주 조회 1회분(약 26행) — 실측 상한 30행 아래로 잡는다
SLEEP = 0.8               # 끊어 받을 때 요청 간격(초)

SOURCE = ("한국석유공사 PETRONET · 일일국제원유가격(KDFQ0100) · "
          "Dubai/Brent(ICE)/WTI(NYMEX)/Oman · 키 불필요")
SOURCE_LINKS = [{"text": "일일국제원유가격", "url": REFERER}]
UNIT = "$/배럴"
NOTE = ("PETRONET 은 화~토 갱신됩니다(직전 영업일 종가 기준). "
        "기준·기간·유종을 고르고 [조회]를 누르면 표와 그래프가 다시 그려집니다.")

# 요약행 라벨 — term 마다 다르다. 프런트가 이 순서·이름 그대로 표 아래에 붙인다.
SUMMARY_ROWS = {
    "y": ["전년비", "평균"],
    "m": ["전월비", "전년동월비", "평균"],
    "w": ["전주비", "전월동주비", "전년동주비", "평균"],
    "d": ["전일비", "전주비", "전월동일비", "전년동일비", "평균"],
}


def _txt(cell):
    return re.sub(r"\s+", " ",
                  re.sub(r"<[^>]+>", "", cell).replace("&nbsp;", " ")).strip()


def _num(cell):
    try:
        return round(float(_txt(cell).replace(",", "")), 2)
    except ValueError:
        return None            # '-' 등 결측 — 값을 만들지 않는다


def _rows_of(html):
    """<tr> → 셀 텍스트 리스트(빈 행 제외)."""
    out = []
    for tr in re.findall(r"<tr.*?>(.*?)</tr>", html, re.S | re.I):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
        if cells and any(_txt(c) for c in cells):
            out.append(cells)
    return out


def _start_year(rows):
    """표 머리의 '2026년 06월 1주 ~ ...' 에서 시작 연도. 못 찾으면 None."""
    for cells in rows[:4]:
        m = re.search(r"(\d{4})\s*년", _txt(cells[0]))
        if m:
            return int(m.group(1))
    return None


def _parse(html, term):
    """표 → (rows, summary). rows=[{period, <유종키>...}] · summary={라벨: {유종키: 값}}

    첫 열 형식이 term 마다 다르다(모듈 상단 실측 표 참고). 연도가 붙지 않는
    행(예: '02월', '08월 04일')은 시작 연도에서 출발해 '월이 줄면 +1' 로 넘긴다.
    """
    n = len(CRUDES)
    raw = _rows_of(html)
    year = _start_year(raw)
    rows, summary, prev_m = [], {}, None
    sums = set(SUMMARY_ROWS.get(term, []))

    for cells in raw:
        if len(cells) < 1 + n:
            continue
        first = _txt(cells[0])
        vals = [_num(c) for c in cells[1:1 + n]]

        if first in sums:                       # 전일비·평균 등 요약행
            summary[first] = {k: v for (_, k, _), v in zip(CRUDES, vals)}
            continue

        period = None
        if term == "y":
            m = re.match(r"^(\d{4})\s*년$", first)
            if m:
                period = m.group(1)
        elif term == "m":
            m = re.match(r"^(?:(\d{2})\s*년\s*)?(\d{1,2})\s*월$", first)
            if m:
                if m.group(1):
                    year = 2000 + int(m.group(1))
                mo = int(m.group(2))
                if m.group(1) is None and prev_m is not None and mo < prev_m and year:
                    year += 1
                prev_m, period = mo, "%04d-%02d" % (year, mo)
        elif term == "w":
            m = re.match(r"^(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*주$", first)
            if m:
                if m.group(1):
                    year = int(m.group(1))
                mo, wk = int(m.group(2)), int(m.group(3))
                if m.group(1) is None and prev_m is not None and mo < prev_m and year:
                    year += 1
                prev_m, period = mo, "%04d-%02d-W%d" % (year, mo, wk)
        elif term == "d":
            m = re.match(r"^(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일$", first)
            if m:
                if m.group(1):
                    year = int(m.group(1))
                mo, dy = int(m.group(2)), int(m.group(3))
                if m.group(1) is None and prev_m is not None and mo < prev_m and year:
                    year += 1
                prev_m, period = mo, "%04d-%02d-%02d" % (year, mo, dy)

        if period is None or year is None:
            continue                            # 제목·헤더·단위 행
        row = {"period": period}
        for (_, key, _), v in zip(CRUDES, vals):
            row[key] = v
        rows.append(row)

    rows.sort(key=lambda r: r["period"])
    return rows, summary


def _span(term, today=None):
    """term 별 조회 구간 → (시작 파라미터, 끝 파라미터)."""
    t = today or datetime.date.today()
    back = RANGES[term]["years"]
    y0 = t.year - back
    b = {"by": str(y0), "bq": "1", "bm": "01", "bw": "1", "bd": "01"}
    a = {"ay": str(t.year), "aq": str((t.month - 1) // 3 + 1),
         "am": "%02d" % t.month, "aw": "5", "ad": "%02d" % t.day}
    if term in ("w", "d"):                      # 주·일은 그 해 1월부터면 충분히 넉넉하다
        b["bm"], b["bd"], b["bw"] = "01", "01", "1"
    return b, a


def _get(term, b, a):
    """한 번 조회 → (rows, summary, 조회기간표시). 행이 없으면 빈 리스트."""
    qs = dict(b, **a)
    qs["term"] = term
    qs["ProdCDList"] = CODE_PARAM
    r = requests.get(EXCEL_URL, params=qs, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    html = r.content.decode("utf-8", "replace")
    if html.count("�") > 10:               # utf-8 이 깨지면 euc-kr
        html = r.content.decode("euc-kr", "replace")
    if "<tr" not in html.lower():
        raise RuntimeError("표가 없는 응답(차단/형식 변경 가능)")
    rows, summary = _parse(html, term)
    head = next((_txt(c[0]) for c in _rows_of(html)[:4] if "~" in _txt(c[0])), "")
    return rows, summary, head


def _month_steps(y0, m0, y1, m1, step):
    """[y0-m0, y1-m1] 을 step 개월씩 끊은 (시작y, 시작m, 끝y, 끝m) 목록."""
    out = []
    y, m = y0, m0
    while (y, m) <= (y1, m1):
        ey, em = y, m + step - 1
        ey, em = ey + (em - 1) // 12, (em - 1) % 12 + 1
        if (ey, em) > (y1, m1):
            ey, em = y1, m1
        out.append((y, m, ey, em))
        y, m = ey, em + 1
        if m > 12:
            y, m = y + 1, 1
    return out


def _fetch_weekly(today=None):
    """주(w)는 한 번에 약 30행까지라 6개월씩 끊어 받아 합친다."""
    t = today or datetime.date.today()
    steps = _month_steps(t.year - RANGES["w"]["years"], 1, t.year, t.month, WEEK_CHUNK_MONTHS)
    merged, summary, head = {}, {}, ""
    for i, (y0, m0, y1, m1) in enumerate(steps):
        if i:
            time.sleep(SLEEP)
        b = {"by": str(y0), "bq": "1", "bm": "%02d" % m0, "bw": "1", "bd": "01"}
        a = {"ay": str(y1), "aq": str((m1 - 1) // 3 + 1), "am": "%02d" % m1,
             "aw": "5", "ad": "28"}
        rows, sm, hd = _get("w", b, a)
        for r in rows:
            merged[r["period"]] = r      # 청크가 겹쳐도 뒤 값으로 덮어쓴다
        if rows:                          # 마지막으로 성공한 청크의 요약을 남긴다
            summary, head = sm, hd
    return [merged[k] for k in sorted(merged)], summary, head


def fetch_term(term, today=None):
    """한 기준(term)의 전 구간을 받아 (rows, summary, 조회기간표시)."""
    if term == "w":
        rows, summary, head = _fetch_weekly(today)
    else:
        b, a = _span(term, today)
        rows, summary, head = _get(term, b, a)
    if not rows:
        raise RuntimeError("데이터 행 없음(형식 변경 가능)")
    return rows, summary, head


def update_oil_crude():
    """FETCHERS 등록용. 기준 4개(년·월·주·일)를 각각 받아 한 payload 로 묶는다."""
    terms, errs = {}, []
    for term in ("y", "m", "w", "d"):
        try:
            rows, summary, head = fetch_term(term)
            terms[term] = {"label": RANGES[term]["label"], "rows": rows,
                           "summary_rows": SUMMARY_ROWS[term],
                           "petronet_summary": summary, "petronet_span": head}
            print("[oil_crude] term=%s %d행 (%s~%s)"
                  % (term, len(rows), rows[0]["period"], rows[-1]["period"]))
        except Exception as e:  # noqa: BLE001 — 한 기준이 실패해도 나머지는 살린다
            errs.append("%s: %s" % (term, str(e)[:70]))
            print("[oil_crude] term=%s 실패: %s" % (term, str(e)[:90]))
    if not terms:
        return {"status": "error",
                "reason": "PETRONET 원유 조회 실패 — %s" % ("; ".join(errs) or "원인 불명")}
    return {
        "status": "ok",
        "reason": None,
        "source": SOURCE,
        "source_links": SOURCE_LINKS,
        "unit": UNIT,
        "note": NOTE,
        "series": [{"key": k, "label": lbl, "code": c} for c, k, lbl in CRUDES],
        "default_on": list(DEFAULT_ON),
        "terms": terms,
        "partial": errs or None,
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


if __name__ == "__main__":
    import sys
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    p = update_oil_crude()
    slim = dict(p)
    slim["terms"] = {k: {"label": v["label"], "n": len(v["rows"]),
                         "first": v["rows"][0], "last": v["rows"][-1],
                         "petronet_span": v["petronet_span"],
                         "petronet_summary": v["petronet_summary"]}
                     for k, v in (p.get("terms") or {}).items()}
    print(json.dumps(slim, ensure_ascii=False, indent=1))
