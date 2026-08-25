# -*- coding: utf-8 -*-
"""국제유가(석유제품) — 한국석유공사 PETRONET '일일국제제품가격'. 키 불필요 · 무료.

    페이지  국제석유가격 > 일일국제제품가격
            fmuId=KDFQSTAT · smuId=KDFQ01 · tmuId=KDFQ0200 (03 / 03_01 / 03_01_02)
    단위    $/배럴  (표 머리의 '(단 위 : $/배럴)' 실측)

★ 원유(oil_crude.py)와 '조회 방식'이 다르다. 원유는 excel jsp 를 GET 하면 되지만
  제품은 그 엔드포인트가 리다이렉트(v3/return.jsp)만 돌려준다 — term 을 무엇으로
  주든 80바이트짜리 스크립트가 온다. 세션을 먼저 만들어도 마찬가지다(실측).
  그래서 제품은 **sub.jsp 에 조회 POST** 를 보내 결과 페이지째 받아 파싱한다.
  (옛 update_oil_prices 가 쓰던 폴백 경로와 같다 — 그쪽이 실제로 동작하던 길이다)

★ 제품 코드는 조회 페이지 체크박스에서 확인했다(2026-08 실측). 사이트 기본값은 9개 전부 체크.
    B001 휘발유(95RON)   B007 휘발유(92RON)   C001 등유
    D001 경유(0.5%)      D008 경유(0.05%)     D009 경유(0.001%)
    E001 고유황중유(180cst/3.5%)   E008 고유황중유(380cst/3.5%)   F001 나프타

★★ 응답의 열 개수는 요청한 코드 수와 다를 수 있다.
  경유(0.5%)는 2012년 12월 1일 게시가 중단됐고(페이지 각주), 최근 구간을 조회하면
  그 열이 통째로 빠져 9개를 요청해도 8열이 온다. 그래서 **위치가 아니라 헤더 라벨로**
  열을 맞춘다. 위치로 맞추면 값이 통째로 한 칸씩 밀린다.

★ Parameter 의 날짜 형식은 term 마다 다르다(실측).
    Y: '2016'~'2026'  ·  M: '201101'~'202608'  ·  W/D: '20260801'~'20260825'

★ 행 상한도 term 마다 다르다(실측).
    년·월·주 : 상한 없음 (월 191행, 주 143행 정상)
    일       : 약 316행까지. 1.2년(316행)은 오고 1.6년은 빈 응답 →
               6개월씩 끊어 받아 합친다(_fetch_daily).
  같은 PETRONET 이라도 원유는 '주'가 30행에서 잘리고 제품은 '일'이 잘린다.
  표마다 다르므로 표별로 실측해서 정한다.

★ 값을 만들지 않는다. 결측('-')은 None 으로 비운다.
"""
import io
import re
import json
import time
import datetime

import requests

POST_URL = "https://www.petronet.co.kr/v4/sub.jsp"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": POST_URL}
TIMEOUT = 60

MENU = [("fmuId", "KDFQSTAT"), ("smuId", "KDFQ01"), ("tmuId", "KDFQ0200"),
        ("fmuOrd", "03"), ("smuOrd", "03_01"), ("tmuOrd", "03_01_02")]

# (코드, 응답키, 표시라벨)
PRODUCTS = [
    ("B001", "gasoline95", "휘발유(95RON)"),
    ("B007", "gasoline92", "휘발유(92RON)"),
    ("C001", "kerosene", "등유"),
    ("D001", "diesel05", "경유(0.5%)"),
    ("D008", "diesel005", "경유(0.05%)"),
    ("D009", "diesel0001", "경유(0.001%)"),
    ("E001", "hsfo180", "고유황중유(180cst/3.5%)"),
    ("E008", "hsfo380", "고유황중유(380cst/3.5%)"),
    ("F001", "naphtha", "나프타"),
]
CODES = [c for c, _, _ in PRODUCTS]
# 라벨 → 키 (공백을 지운 형태로 맞춘다 — 응답이 '휘발유 (95RON)' 처럼 띄어 올 때가 있다)
LABEL_KEY = {re.sub(r"\s+", "", lbl): key for _, key, lbl in PRODUCTS}

# 기본 체크: 경유(0.5%)만 뺀 8개.
# ★ 사이트는 9개를 다 켜 두지만, 경유(0.5%)는 2012-12-01 게시 중단이라 최근 구간에서
#   빈 열만 나온다. 처음 화면에 '전부 -' 인 열을 띄우지 않으려고 이것만 꺼 둔다.
#   체크박스는 그대로 두므로 과거 구간을 볼 때 켤 수 있다.
DEFAULT_ON = [k for _, k, _ in PRODUCTS if k != "diesel05"]

RANGES = {
    "y": {"label": "년", "years": 30},
    "m": {"label": "월", "years": 15},
    "w": {"label": "주", "years": 3},
    "d": {"label": "일", "years": 3},
}
DAY_CHUNK_MONTHS = 6      # 일 조회 1회분(약 130행) — 실측 상한 316행 아래로 잡는다
SLEEP = 0.8

TERM_T = {"y": "Y", "m": "M", "w": "W", "d": "D"}

SOURCE = ("한국석유공사 PETRONET · 일일국제제품가격(KDFQ0200) · "
          "휘발유·등유·경유·중유·나프타 · 키 불필요")
SOURCE_LINKS = [{"text": "일일국제제품가격", "url": POST_URL}]
UNIT = "$/배럴"
NOTE = ("싱가포르 현물 기준 석유제품 가격입니다. PETRONET 은 화~토 갱신됩니다. "
        "경유(0.5%)는 2012년 12월 1일 게시가 중단되어 이후 구간은 비어 있습니다.")

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
        return None


def _rows_of(html):
    out = []
    for tr in re.findall(r"<tr.*?>(.*?)</tr>", html, re.S | re.I):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
        if cells and any(_txt(c) for c in cells):
            out.append(cells)
    return out


def _parse(html, term, year_hint=None):
    """표 → (rows, summary).

    ★ 헤더는 ['일', '유종', <제품 라벨들>...] 이고 데이터 행은 ['08월 03일', <값들>...] 이라
      제품 라벨은 헤더의 2번째 칸부터, 값은 데이터 행의 1번째 칸부터다.
    ★ 열은 라벨로 맞춘다(위치로 맞추면 게시 중단된 제품이 빠졌을 때 한 칸씩 밀린다).
    """
    raw = _rows_of(html)
    hdr = next((c for c in raw if len(c) > 2 and _txt(c[1]) == "유종"), None)
    if not hdr:
        return [], {}
    keys = [LABEL_KEY.get(re.sub(r"\s+", "", _txt(c))) for c in hdr[2:]]
    ncol = len(keys)

    # 시작 연도: 표 머리('2026년 06월 1주 ~ ...')에서 찾고, 못 찾으면 요청한 연도를 쓴다.
    # ★ raw 는 페이지 전체의 <tr> 이라 앞 4행이 표 머리라는 보장이 없다 — 전체를 훑는다.
    year = None
    for c in raw:
        m = re.search(r"(\d{4})\s*년.*~", _txt(c[0]))
        if m:
            year = int(m.group(1))
            break
    if year is None:
        year = year_hint
    rows, summary, prev_m = [], {}, None
    sums = set(SUMMARY_ROWS.get(term, []))

    for cells in raw:
        if len(cells) != ncol + 1:
            continue
        first = _txt(cells[0])
        vals = [_num(c) for c in cells[1:]]
        if first in sums:
            summary[first] = {k: v for k, v in zip(keys, vals) if k}
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
            m = re.match(r"^(?:(\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*주$", first)
            if m:
                if m.group(1):
                    year = 2000 + int(m.group(1))
                mo, wk = int(m.group(2)), int(m.group(3))
                if m.group(1) is None and prev_m is not None and mo < prev_m and year:
                    year += 1
                prev_m, period = mo, "%04d-%02d-W%d" % (year, mo, wk)
        else:
            m = re.match(r"^(?:(\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일$", first)
            if m:
                if m.group(1):
                    year = 2000 + int(m.group(1))
                mo, dy = int(m.group(2)), int(m.group(3))
                if m.group(1) is None and prev_m is not None and mo < prev_m and year:
                    year += 1
                prev_m, period = mo, "%04d-%02d-%02d" % (year, mo, dy)

        if period is None or year is None:
            continue
        row = {"period": period}
        for k, v in zip(keys, vals):
            if k:
                row[k] = v
        rows.append(row)

    rows.sort(key=lambda r: r["period"])
    return rows, summary


def _post(session, term, frm, to, b, a):
    """조회 POST → (rows, summary, 조회기간표시)."""
    inner = "\\,".join("\\'%s\\'" % c for c in CODES)
    param = ":T='%s',:FromDate='%s',:ToDate='%s',:ProdCD='%s '" % (TERM_T[term], frm, to, inner)
    data = list(MENU) + [
        ("Parameter", param), ("ProdCDList", ",".join(CODES)),
        ("firstFlag", "T"), ("term", term)] + list(b.items()) + list(a.items())
    data += [("ProdCd", c) for c in CODES]
    r = session.post(POST_URL, data=data, timeout=TIMEOUT)
    r.raise_for_status()
    html = r.content.decode("utf-8", "replace")
    if html.count("�") > 10:
        html = r.content.decode("euc-kr", "replace")
    rows, summary = _parse(html, term, year_hint=int(str(frm)[:4]))
    head = next((_txt(c[0]) for c in _rows_of(html) if "~" in _txt(c[0])), "")
    return rows, summary, head


def _bp(y, m=1, d=1):
    return {"by": str(y), "bq": str((m - 1) // 3 + 1), "bm": "%02d" % m,
            "bw": "1", "bd": "%02d" % d}


def _ap(t):
    return {"ay": str(t.year), "aq": str((t.month - 1) // 3 + 1),
            "am": "%02d" % t.month, "aw": "5", "ad": "%02d" % t.day}


def _month_steps(y0, m0, y1, m1, step):
    out, y, m = [], y0, m0
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


def _fetch_daily(session, today):
    """일(d)은 약 316행 상한이라 6개월씩 끊어 받아 합친다."""
    steps = _month_steps(today.year - RANGES["d"]["years"], 1, today.year, today.month,
                         DAY_CHUNK_MONTHS)
    merged, summary, head = {}, {}, ""
    for i, (y0, m0, y1, m1) in enumerate(steps):
        if i:
            time.sleep(SLEEP)
        last = (datetime.date(y1 + (m1 == 12), (m1 % 12) + 1, 1)
                - datetime.timedelta(days=1))
        if last > today:
            last = today
        rows, sm, hd = _post(session, "d", "%04d%02d01" % (y0, m0),
                             last.strftime("%Y%m%d"), _bp(y0, m0, 1), _ap(last))
        for r in rows:
            merged[r["period"]] = r
        if rows:
            summary, head = sm, hd
    return [merged[k] for k in sorted(merged)], summary, head


def fetch_term(term, today=None):
    t = today or datetime.date.today()
    s = requests.Session()
    s.headers.update(HEADERS)
    if term == "d":
        rows, summary, head = _fetch_daily(s, t)
    else:
        y0 = t.year - RANGES[term]["years"]
        frm = {"y": "%04d" % y0, "m": "%04d01" % y0}.get(term, "%04d0101" % y0)
        to = {"y": "%04d" % t.year, "m": t.strftime("%Y%m")}.get(term, t.strftime("%Y%m%d"))
        rows, summary, head = _post(s, term, frm, to, _bp(y0), _ap(t))
    if not rows:
        raise RuntimeError("데이터 행 없음(형식 변경 가능)")
    return rows, summary, head


def update_oil_product():
    """FETCHERS 등록용. 기준 4개(년·월·주·일)를 각각 받아 한 payload 로 묶는다."""
    terms, errs = {}, []
    for term in ("y", "m", "w", "d"):
        try:
            rows, summary, head = fetch_term(term)
            terms[term] = {"label": RANGES[term]["label"], "rows": rows,
                           "summary_rows": SUMMARY_ROWS[term],
                           "petronet_summary": summary, "petronet_span": head}
            print("[oil_product] term=%s %d행 (%s~%s)"
                  % (term, len(rows), rows[0]["period"], rows[-1]["period"]))
        except Exception as e:  # noqa: BLE001
            errs.append("%s: %s" % (term, str(e)[:70]))
            print("[oil_product] term=%s 실패: %s" % (term, str(e)[:90]))
    if not terms:
        return {"status": "error",
                "reason": "PETRONET 제품가 조회 실패 — %s" % ("; ".join(errs) or "원인 불명")}
    return {
        "status": "ok",
        "reason": None,
        "source": SOURCE,
        "source_links": SOURCE_LINKS,
        "unit": UNIT,
        "note": NOTE,
        "series": [{"key": k, "label": lbl, "code": c} for c, k, lbl in PRODUCTS],
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
    p = update_oil_product()
    slim = dict(p)
    slim["terms"] = {k: {"label": v["label"], "n": len(v["rows"]),
                         "first": v["rows"][0], "last": v["rows"][-1],
                         "petronet_span": v["petronet_span"],
                         "petronet_summary": v["petronet_summary"]}
                     for k, v in (p.get("terms") or {}).items()}
    print(json.dumps(slim, ensure_ascii=False, indent=1))
