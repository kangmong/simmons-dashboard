# -*- coding: utf-8 -*-
"""해상 운임 지수 — 국가물류통합정보센터(NLIC) + Drewry WCI.

둘을 모아 public/data/freight-index.json 으로 저장한다. 화면(app.js)은 그 파일만
읽는다.

■ 어디서 무엇을 가져오는가 (실측으로 확인한 구조)

  1) NLIC 「국외 해상운임 지수」 https://www.nlic.go.kr/nlic/transInPortCt.action
     POST 폼이다. command=LIST & S_TRANSIN_SE=CFI|BDI & S_YEAR=시작 & F_YEAR=끝.
     표가 <table> 이 아니라 '가로로 눕힌' ul/li 다 — 왼쪽 고정칸에 행 이름
     (<li class="con_list_2">SCFI</li> …), 오른쪽에 날짜 열이
     <ul class="W_90px"><li>…</li></ul> 로 하나씩 늘어선다.
     그래서 셀을 문서 순서대로 읽으면 [날짜 N개][1행 N개][2행 N개] 가 된다.
     · CFI → SCFI·CCFI (주간)
     · BDI → BDI (일간)
     한 번에 3개년까지만 준다(원본 fn_search 가 막는다). 그래서 3년씩 끊어
     여러 번 부르고 이어 붙인다. 연도 선택은 2014년부터 열려 있다.

  2) Drewry WCI
     https://www.drewry.co.uk/supply-chain-advisors/supply-chain-expertise/
       world-container-index-assessed-by-drewry
     차트는 Canva 디자인 임베드라 기계가 읽을 수 없다. 대신 같은 페이지의
     주간 논평 본문에 그 주 값이 모두 문장으로 적혀 있다:
       "rose 3% to $4,485 per 40ft container"
       "rates from Shanghai to Los Angeles inched up 3% to $7,884 per 40ft"
     동사가 매주 바뀌므로(rose·fell·inched up·grew·increased) 동사에 기대지
     않고 '항로 이름 → 가장 가까운 $금액 per 40ft' 로 집는다.
     ★ 과거 시계열은 기계가 읽을 수 있는 형태로 공개되지 않는다. 그래서
       Drewry 쪽은 '매주 한 점씩 쌓는다' — 기존 JSON 을 읽어 새 날짜만 더한다.
       처음에는 점이 하나뿐이고 주마다 길어진다(없는 과거를 지어내지 않는다).

■ 실패를 다루는 방식
  한쪽이 막혀도 나머지는 저장한다. 둘 다 실패하면 0 이 아닌 코드로 끝나고
  기존 파일을 덮어쓰지 않는다. Drewry 가 실패해도 이미 쌓아 둔 점들은 그대로
  남는다(새 점만 못 더할 뿐이다).

■ 예의
  같은 서버로는 순서대로, 요청 사이를 쉰다. 신원이 드러나는 User-Agent 를 쓰고,
  차단되면 우회하지 않고 실패로 적는다.
"""
import datetime
import io
import json
import os
import re
import sys
import time

import requests

# ★ 윈도 콘솔 기본 인코딩(cp949)으로는 '—' 같은 글자를 못 찍는다. 로그 한 줄
#   때문에 수집이 실패로 잡히는 일이 없도록 먼저 UTF-8 로 돌려 둔다.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:                                    # noqa: BLE001
        pass

OUT = os.path.join("public", "data", "freight-index.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
      "SimmonsDashboard/1.0 (+https://simmons-dashboard-ten.vercel.app)")
HEADERS = {"User-Agent": UA}
# ★ Canva 임베드는 브라우저가 아닌 UA 에는 알맹이 없는 짧은 문서를 준다(실측
#   12KB vs 69KB). 숨기려는 게 아니라 같은 문서를 받으려는 것이라, 크롬 토큰
#   뒤에 우리 이름을 그대로 붙여 누가 요청했는지 드러낸다.
BROWSER_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 " + UA),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = 45
PAUSE = 2.0            # 같은 서버 요청 사이에 쉬는 시간(초)

NLIC_URL = "https://www.nlic.go.kr/nlic/transInPortCt.action"
NLIC_PAGE = NLIC_URL
DREWRY_URL = ("https://www.drewry.co.uk/supply-chain-advisors/supply-chain-expertise/"
              "world-container-index-assessed-by-drewry")

NLIC_FIRST_YEAR = 2014   # 원본 드롭다운이 열어 둔 가장 이른 해
NLIC_SPAN = 3            # 한 번에 받을 수 있는 연수

# Drewry 논평에서 집어낼 것 — (키, 화면 이름, 본문에서 찾을 말)
# ★ 닻은 '주간 논평 구간 안에서만' 찾는다. 페이지 위쪽 홍보 문단에도
#   'World Container Index (WCI)' 가 있어서 전체에서 찾으면 그쪽이 먼저 걸린다
#   (그 문단 뒤에는 금액이 없어 값을 놓쳤다).
WCI_PARTS = [
    ("composite", "WCI 종합", "World Container Index"),
    ("shanghai_rotterdam", "상하이 → 로테르담", "Shanghai to Rotterdam"),
    ("shanghai_losangeles", "상하이 → 로스앤젤레스", "Shanghai to Los Angeles"),
    ("shanghai_genoa", "상하이 → 제노바", "Shanghai to Genoa"),
    ("shanghai_newyork", "상하이 → 뉴욕", "Shanghai to New York"),
]


def _now_kst():
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(hours=9)).strftime("%Y-%m-%d %H:%M KST")


def _strip(h):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h)).strip()


def _num(s):
    """'3,679.58' → 3679.58. 숫자가 아니면 None(0 으로 바꾸지 않는다)."""
    s = (s or "").replace(",", "").strip()
    if not re.match(r"^-?\d+(\.\d+)?$", s):
        return None
    return float(s)


# ───────────────────────── NLIC ─────────────────────────
def _nlic_window(sess, kind, y_from, y_to):
    """한 구간을 받아 {행이름: {날짜: 값}} 으로 돌려준다."""
    r = sess.post(NLIC_URL, headers=HEADERS, timeout=TIMEOUT, data={
        "command": "LIST", "S_TRANSIN_SE": kind,
        "S_YEAR": str(y_from), "F_YEAR": str(y_to),
    })
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    html = r.text

    names = [_strip(x) for x in
             re.findall(r'<li class="con_list_2">(.*?)</li>', html, re.S)]
    cells = [_strip(x) for x in
             re.findall(r'<ul class="W_90px">(.*?)</ul>', html, re.S)]
    if not names or not cells:
        raise RuntimeError("표를 찾지 못했습니다 (구조가 바뀌었을 수 있습니다)")
    if len(cells) % (len(names) + 1) != 0:
        raise RuntimeError("셀 수(%d)가 행 수(%d)로 나누어떨어지지 않습니다"
                           % (len(cells), len(names)))

    n = len(cells) // (len(names) + 1)
    dates = cells[:n]
    out = {}
    for i, nm in enumerate(names):
        vals = cells[(i + 1) * n:(i + 2) * n]
        got = {}
        for d, v in zip(dates, vals):
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
                continue
            x = _num(v)
            if x is not None:
                got[d] = x
        out[nm] = got
    return out


def fetch_nlic(verbose=True, full=False):
    """SCFI·CCFI(주간) + BDI(일간). 3년씩 끊어 받는다.

    ★ 평소에는 최근 구간 하나만 받는다(요청 2번). 과거는 이미 파일에 있고
      바뀌지 않는다 — 날마다 12년치를 다시 긁으면 원본 서버에 폐를 끼친다.
    ★ full=True 면 2014년부터 전부 받는다(첫 수집·복구용. --full 로 켠다).
    """
    sess = requests.Session()
    this_year = datetime.date.today().year
    start = NLIC_FIRST_YEAR if full else max(NLIC_FIRST_YEAR,
                                             this_year - NLIC_SPAN + 1)
    merged = {}
    fails = []

    for kind in ("CFI", "BDI"):
        y = start
        while y <= this_year:
            y2 = min(y + NLIC_SPAN - 1, this_year)
            try:
                part = _nlic_window(sess, kind, y, y2)
                for nm, got in part.items():
                    merged.setdefault(nm, {}).update(got)
                if verbose:
                    print("[nlic] %s %d~%d — %s" % (
                        kind, y, y2,
                        ", ".join("%s %d개" % (k, len(v)) for k, v in part.items())))
            except Exception as e:                       # noqa: BLE001
                fails.append({"source": "nlic", "part": "%s %d-%d" % (kind, y, y2),
                              "reason": str(e)[:200]})
                if verbose:
                    print("[nlic] %s %d~%d 실패 — %s" % (kind, y, y2, e),
                          file=sys.stderr)
            y = y2 + 1
            time.sleep(PAUSE)

    if not merged:
        return None, fails

    out = {}
    for nm, got in merged.items():
        ds = sorted(got)
        out[nm.upper()] = {"dates": ds, "values": [got[d] for d in ds]}
    return out, fails


def _merge_series(old, new):
    """기존 시계열 위에 새로 받은 구간을 덮는다(과거를 잃지 않는다)."""
    got = dict(zip((old or {}).get("dates", []), (old or {}).get("values", [])))
    got.update(dict(zip(new["dates"], new["values"])))
    ds = sorted(got)
    return {"dates": ds, "values": [got[d] for d in ds]}


# ───────────────────────── Drewry ─────────────────────────
_MONEY = re.compile(r"\$\s?([\d,]+)\s*per\s*40ft", re.I)
# 페이지에 박혀 있는 공식 차트(임베드). 주소가 매주 바뀔 수 있어 그때그때 읽는다.
_EMBED = re.compile(
    r'<iframe[^>]+src="(https://www\.canva\.com/design/[^"]+?\?embed)"', re.I)
OEMBED = "https://api.canva.com/_spi/presentation/_oembed"


# 표 칸 — 임베드 HTML 안에 글자/숫자가 순서대로 박혀 있다.
#   글자: {"A":{"A?":"A","A":"$4,434"}}   숫자: {"A":{"A?":"E","A":0.03}}
# ★ 그림에서 좌표를 되돌려 읽는 게 아니라, 문서에 들어 있는 값을 그대로 읽는다.
_CELL = re.compile(r'\{"A":\{"A\?":"([AE])","A":("(?:[^"\\]|\\.)*"|-?[\d.]+)\}')
# 엑셀 일련번호의 기준일
_XL0 = datetime.date(1899, 12, 30)

# 항로 코드 → 우리말. 모르는 코드가 오면 원문 이름을 그대로 쓴다(지어내지 않는다).
ROUTE_KO = {
    "WCI-COMPOSITE": "WCI 종합",
    "WCI-SHA-RTM": "상하이 → 로테르담",
    "WCI-RTM-SHA": "로테르담 → 상하이",
    "WCI-SHA-GOA": "상하이 → 제노바",
    "WCI-SHA-LAX": "상하이 → 로스앤젤레스",
    "WCI-LAX-SHA": "로스앤젤레스 → 상하이",
    "WCI-SHA-NYC": "상하이 → 뉴욕",
    "WCI-NYC-RTM": "뉴욕 → 로테르담",
    "WCI-RTM-NYC": "로테르담 → 뉴욕",
}


def _cells(html):
    out = []
    for kind, raw in _CELL.findall(html):
        if kind == "A":
            out.append(raw[1:-1].replace('\\"', '"').replace("\\/", "/"))
        else:
            try:
                out.append(float(raw))
            except ValueError:
                out.append(None)
    return out


def _money(v):
    if not isinstance(v, str) or not v.strip().startswith("$"):
        return None
    try:
        return float(v.replace("$", "").replace(",", "").strip())
    except ValueError:
        return None


def parse_route_table(html):
    """항로 9개 × 기준일 3개 + 주간·연간 변동률."""
    cs = _cells(html)
    if "Route" not in cs:
        raise RuntimeError("표 머리글(Route)을 찾지 못했습니다")
    i = cs.index("Route")
    if cs[i + 1] != "Route code":
        raise RuntimeError("머리글이 예상과 다릅니다")
    dates = []
    for k in range(3):
        n = cs[i + 2 + k]
        if not isinstance(n, float):
            raise RuntimeError("기준일 칸이 날짜가 아닙니다")
        dates.append((_XL0 + datetime.timedelta(days=int(n))).isoformat())
    rows, j = [], i + 7
    while j + 6 < len(cs):
        name, code = cs[j], cs[j + 1]
        if not (isinstance(name, str) and isinstance(code, str)):
            break
        if not code.upper().startswith("WCI"):
            break
        wk, an = cs[j + 5], cs[j + 6]
        rows.append({
            "name": name, "code": code, "ko": ROUTE_KO.get(code, name),
            "values": [_money(cs[j + 2 + k]) for k in range(3)],
            "weekly": round(wk * 100, 2) if isinstance(wk, float) else None,
            "annual": round(an * 100, 2) if isinstance(an, float) else None,
        })
        j += 7
    if not rows:
        raise RuntimeError("항로 줄을 하나도 읽지 못했습니다")
    return {"dates": dates, "rows": rows}


def fetch_route_table(url, prev=None, verbose=True):
    """표 임베드를 받아 파싱하고, 지난 기록 위에 이어 붙인다."""
    r = requests.get(url, headers=BROWSER_HEADERS, timeout=TIMEOUT)
    if r.status_code != 200:
        raise RuntimeError("HTTP %d" % r.status_code)
    r.encoding = r.apparent_encoding or "utf-8"
    tb = parse_route_table(r.text)
    old = {x["code"]: x for x in ((prev or {}).get("rows") or [])}
    for row in tb["rows"]:
        got = dict(zip((old.get(row["code"], {}).get("series") or {}).get("dates", []),
                       (old.get(row["code"], {}).get("series") or {}).get("values", [])))
        for d, v in zip(tb["dates"], row["values"]):
            if v is not None:
                got[d] = v
        ds = sorted(got)
        row["series"] = {"dates": ds, "values": [got[d] for d in ds]}
    if verbose:
        print("[drewry] 항로 표 %d개 · 기준일 %s" % (len(tb["rows"]), tb["dates"][-1]))
    return tb


def _canva_size(url, sess=None):
    """디자인의 실제 가로·세로. 못 받으면 (None, None).

    ★ 원본 페이지가 적어 둔 padding-top 은 Drewry 칸에 맞춘 값이라 실제 비율과
      다르다 — 그 차이만큼 Canva 가 검은 띠를 채운다. oEmbed 가 주는 치수를 쓰면
      띠가 없다.
    """
    try:
        get = (sess or requests).get
        view = url.split("?")[0]
        r = get(OEMBED, params={"url": view, "format": "json"},
                headers=HEADERS, timeout=TIMEOUT)
        if r.status_code != 200:
            return None, None
        h = (r.json() or {}).get("html") or ""
        w = re.search(r'width="(\d+)"', h)
        t = re.search(r'height="(\d+)"', h)
        return (int(w.group(1)), int(t.group(1))) if (w and t) else (None, None)
    except Exception:                                    # noqa: BLE001
        return None, None
_ASSESS = re.compile(
    r"assessment for\s+\w+day,\s*(\d{1,2}\s+\w{3,}\s+\d{4})", re.I)


# 변동률 — 동사가 방향을 말한다(rose/fell …). Drewry 가 직접 적은 값이라
# 우리가 계산한 것보다 믿을 만하다(우리에게는 아직 그 주 한 점뿐이다).
_UP = ("rose", "increased", "grew", "climbed", "gained", "jumped", "surged",
       "inched up", "edged up", "ticked up", "moved up", "rebounded")
_DOWN = ("fell", "dropped", "declined", "slipped", "eased", "decreased",
         "slid", "inched down", "edged down", "ticked down", "retreated")
_CHG = re.compile(
    r"\b(" + "|".join(_UP + _DOWN) + r")\b\s+(?:by\s+)?([\d.]+)\s*%\s+to", re.I)
_DOWN_L = [x.lower() for x in _DOWN]


def _wci_change(text, anchor):
    """닻 뒤 '<동사> N% to' 에서 부호 붙은 변동률을 집는다. 없으면 None."""
    i = text.find(anchor)
    if i < 0:
        return None
    m = _CHG.search(text, i, i + 300)
    if not m:
        return None
    v = float(m.group(2))
    return -v if m.group(1).lower() in _DOWN_L else v


def _wci_value(text, anchor):
    """닻 문구 뒤에서 가장 먼저 나오는 '$N,NNN per 40ft' 를 집는다.

    ★ 동사(rose·fell·inched up·grew)는 매주 바뀌므로 기대지 않는다.
    ★ 닻에서 300자 안쪽만 본다 — 더 멀면 다른 항로 이야기로 넘어간 것이다.
    """
    i = text.find(anchor)
    if i < 0:
        return None
    m = _MONEY.search(text, i, i + 300)
    if not m:
        return None
    return _num(m.group(1))


def _charts(html):
    """공식 차트 임베드 주소 + 바로 앞에 적힌 설명을 짝지어 돌려준다.

    ★ 수치는 가져오지 않는다(Canva 가 글자를 벡터로 바꿔 둬 읽히지 않는다).
      Drewry 가 공표하는 그림을 그대로 싣고 출처를 밝히는 쪽을 택했다.
    """
    out = []
    for m in _EMBED.finditer(html):
        # 차트마다 바로 앞에 <h3>제목</h3> (가끔 <p>부제</p>) 가 붙어 있다.
        # 그냥 앞 글자를 잘라 오면 앞 문단 끝자락·이미지 속성까지 묻어 온다.
        before = html[max(0, m.start() - 1500):m.start()]
        hs = re.findall(r"<h[1-4][^>]*>(.*?)</h[1-4]>", before, re.S | re.I)
        cap = _strip(hs[-1]) if hs else ""
        tail = before.rsplit("</h", 1)[-1] if hs else ""
        ps = re.findall(r"<p[^>]*>(.*?)</p>", tail, re.S | re.I)
        sub = _strip(ps[-1]) if ps else ""
        # 임베드는 가로세로 비율이 고정이다. 원본 페이지가 감싸는 div 에 적어 둔
        # padding-top 을 그대로 가져온다 — 우리가 어림잡으면 좌우에 검은 띠가 남는다.
        ar = re.search(r"padding-top:\s*([\d.]+)%", html[m.start() - 400:m.start()])
        page_ratio = float(ar.group(1)) if ar else None
        w, h = _canva_size(m.group(1))
        time.sleep(1.0)                      # oEmbed 도 남의 서버다 — 사이를 쉰다
        out.append({"url": m.group(1), "caption": cap,
                    "sub": sub if (sub and len(sub) < 120) else "",
                    "w": w, "h": h,
                    # 실제 치수가 있으면 그것을, 없으면 페이지 값을 쓴다
                    "ratio": round(h / float(w) * 100, 3) if (w and h)
                             else (page_ratio or 75.0)})
    return out


def fetch_drewry(verbose=True):
    """그 주의 WCI 종합 + 항로 4개, 그리고 공식 차트 주소."""
    r = requests.get(DREWRY_URL, headers=HEADERS, timeout=TIMEOUT)
    if r.status_code != 200:
        raise RuntimeError("HTTP %d — 차단되면 우회하지 않고 실패로 둡니다"
                           % r.status_code)
    r.encoding = r.apparent_encoding or "utf-8"
    charts = _charts(r.text)
    text = _strip(re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", r.text,
                         flags=re.S | re.I))

    m = _ASSESS.search(text)
    if not m:
        raise RuntimeError("기준일(assessment for …)을 찾지 못했습니다")
    day = datetime.datetime.strptime(
        re.sub(r"\s+", " ", m.group(1)), "%d %b %Y").date().isoformat()

    # ★ 그 주의 논평 구간만 본다 — 위쪽 홍보 문단·아래쪽 FAK 범위에 걸리지 않게.
    body = text[m.end():m.end() + 4000]

    vals, chg = {}, {}
    for key, _name, anchor in WCI_PARTS:
        v = _wci_value(body, anchor)
        if v is not None:
            vals[key] = v
            c = _wci_change(body, anchor)
            if c is not None:
                chg[key] = c
    if not vals:
        raise RuntimeError("논평에서 값을 하나도 찾지 못했습니다")
    if verbose:
        print("[drewry] %s — %s" % (day, vals))
        print("[drewry] 전주 대비 — %s" % chg)
        print("[drewry] 공식 차트 %d개 — %s"
              % (len(charts), " / ".join(c["caption"][:40] for c in charts)))
    return day, vals, charts, chg


def _merge_point(prev_series, day, value):
    """기존 시계열에 한 점을 더한다. 같은 날짜면 값만 갈아 끼운다."""
    got = dict(zip(prev_series.get("dates", []), prev_series.get("values", [])))
    got[day] = value
    ds = sorted(got)
    return {"dates": ds, "values": [got[d] for d in ds]}


# ───────────────────────── 저장 ─────────────────────────
def _load_prev():
    try:
        return json.load(io.open(OUT, encoding="utf-8"))
    except Exception:                                    # noqa: BLE001
        return {}


def main():
    full = "--full" in sys.argv
    prev = _load_prev()
    prev_idx = (prev.get("indices") or {})
    fails = []
    indices = {}

    # 1) NLIC
    try:
        # 파일이 아직 없거나 과거가 비어 있으면 처음부터 전부 받는다
        need_full = full or not (prev.get("indices") or {}).get("SCFI")
        nlic, nf = fetch_nlic(full=need_full)
        fails += nf
    except Exception as e:                               # noqa: BLE001
        nlic, _ = None, None
        fails.append({"source": "nlic", "part": "all", "reason": str(e)[:200]})
        print("[nlic] 실패 — %s" % e, file=sys.stderr)

    NLIC_META = {
        "SCFI": ("SCFI", "상하이컨테이너 운임지수", "포인트", "주간",
                 "상하이항운교역연구소(SSE)"),
        "CCFI": ("CCFI", "중국컨테이너 운임지수", "포인트", "주간",
                 "상하이항운교역연구소(SSE)"),
        "BDI": ("BDI", "발틱 건화물 운임지수", "포인트", "일간",
                "발틱해운거래소(Baltic Exchange)"),
    }
    for key, meta in NLIC_META.items():
        old = (prev_idx.get(key) or {}).get("series")
        got = (nlic or {}).get(key)
        # 새로 받은 구간을 기존 위에 덮는다. 못 받았으면 기존을 그대로 둔다.
        ser = _merge_series(old, got) if got else old
        if not ser:
            continue
        code, name, unit, freq, origin = meta
        indices[key] = {
            "code": code, "name": name, "unit": unit, "freq": freq,
            "origin": origin, "via": "국가물류통합정보센터",
            "viaUrl": NLIC_PAGE, "series": ser,
        }

    # 2) Drewry — 논평(값·변동률) + 공식 차트 주소
    try:
        day, vals, charts, chg = fetch_drewry()
    except Exception as e:                               # noqa: BLE001
        day, vals, chg = None, {}, {}
        # 못 받았으면 지난번 차트 주소를 그대로 둔다(화면이 비지 않게)
        charts = prev.get("drewryCharts") or []
        fails.append({"source": "drewry", "part": "weekly", "reason": str(e)[:200]})
        print("[drewry] 실패 — %s" % e, file=sys.stderr)

    for key, name, _anchor in WCI_PARTS:
        pk = "WCI_" + key.upper()
        old = ((prev_idx.get(pk) or {}).get("series")
               or {"dates": [], "values": []})
        ser = _merge_point(old, day, vals[key]) if (day and key in vals) else old
        if not ser["dates"]:
            continue
        indices[pk] = {
            "code": "WCI", "name": name, "unit": "US$/40ft", "freq": "주간",
            "origin": "Drewry Shipping Consultants", "via": "Drewry",
            "viaUrl": DREWRY_URL, "series": ser,
            # Drewry 가 그 주 논평에 적은 전주 대비(%). 우리가 계산한 값이 아니다.
            "changePct": chg.get(key, (prev_idx.get(pk) or {}).get("changePct")),
        }

    if not indices:
        print("[freight] 전부 실패 — 기존 파일을 덮어쓰지 않습니다", file=sys.stderr)
        return 1

    # 2-1) 항로 표 9개 — 표 임베드에 값이 글자로 들어 있다.
    #      ★ 논평 본문에는 상하이발 4개뿐이라 복항 4개는 여기서만 얻는다.
    #      ★ 실패하면 지난번 표를 그대로 둔다(화면이 비지 않게).
    route_tb = prev.get("wciRoutes")
    tb_url = ""
    for c in charts:
        if "route" in (c.get("caption") or "").lower() or "Route" in (c.get("caption") or ""):
            tb_url = c.get("url") or ""
    if not tb_url and len(charts) >= 3:
        tb_url = charts[2].get("url") or ""      # 세 번째가 표다(원본 배치)
    if tb_url:
        try:
            time.sleep(PAUSE)
            route_tb = fetch_route_table(tb_url, prev=route_tb)
        except Exception as e:                           # noqa: BLE001
            fails.append({"source": "drewry", "part": "route-table",
                          "reason": str(e)[:200]})
            print("[drewry] 항로 표 실패 — %s" % e, file=sys.stderr)
    else:
        fails.append({"source": "drewry", "part": "route-table",
                      "reason": "표 임베드 주소를 찾지 못했습니다"})

    payload = {
        "status": "ok",
        "updatedAt": _now_kst(),
        "drewryCharts": charts,
        "wciRoutes": route_tb,
        "drewryUrl": DREWRY_URL,
        "indices": indices,
        "failures": fails,
        "notice": "지수마다 산출 기관과 방식, 단위가 달라 값을 서로 직접 비교할 수 없습니다.",
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("[freight] 저장 %s — 지수 %d개%s"
          % (OUT, len(indices), (" / 실패 %d건" % len(fails)) if fails else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
