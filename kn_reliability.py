# -*- coding: utf-8 -*-
"""해상 정시성(Kuehne+Nagel seaexplorer Schedule Reliability Report) 수집
→ public/data/kn-reliability.json

출처: Kuehne+Nagel 월간 보고서(매달 중순 발표)
  https://mykn.kuehne-nagel.com/news/article/seaexplorer-schedule-reliability-report-<mon><yy>
  '노선별 정시성' 표는 글자가 아니라 그림이다(PDF 도 Box 뷰어라 바로 받을 수 없다).
  그래서 그 그림을 Gemini 로 읽는다.

★ 그림 읽기를 그대로 믿지 않는다 — 아래를 모두 통과해야 저장한다.
  1) 같은 그림을 두 번 따로 읽어 120칸(20개 노선 × 6개월)이 한 칸도 다르지 않다
  2) 노선 이름 20개가 알고 있는 목록과 같고, 값은 0~100, 달은 'Sept-25' 같은 꼴
  3) 본문에 적힌 '노선 + %' (예: '… led at 93.2%') 가 표 값과 맞는다
★ K+N 은 지난 달 값을 다음 보고서에서 고쳐 싣는다(실측: 아시아↔지중해 2026-01 이
  1월 보고서 41.8% → 3·4월 보고서 47.7%). 그래서 겹치는 달은 '더 최근 보고서' 값을 쓴다
  (보고서 순서는 주소가 아니라 표의 마지막 달로 정한다 — 3월 보고서 주소가 mar25 다).
★ 2025년 일부 보고서는 북미를 동·서로 나누지 않은 옛 표라 노선이 맞지 않아 건너뛴다.
★ 새 보고서가 없으면 Gemini 를 부르지 않는다(대부분의 날은 요청 1~2번으로 끝난다).
★ 실패하면 기존 파일을 그대로 둔다. 바뀐 것이 없으면 쓰지 않는다.

    python kn_reliability.py            # 새 보고서가 있으면 반영
    python kn_reliability.py --backfill # 지난 보고서들도 읽어 과거 달을 채운다(처음 한 번)
"""
import argparse
import datetime
import io
import json
import re
import sys
import time

import requests
from bs4 import BeautifulSoup

from gemini_json import gemini_json

OUT = "public/data/kn-reliability.json"
BASE = "https://mykn.kuehne-nagel.com/news/article/seaexplorer-schedule-reliability-report-"
KST = datetime.timezone(datetime.timedelta(hours=9))
HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
MON_ALT = {"sept": 9, "june": 6, "july": 7}
REGION_KO = {
    "Asia": "아시아", "Mediterranean/Black Sea": "지중해·흑해",
    "North America East Coast": "북미 동안", "North America West Coast": "북미 서안",
    "North Europe": "북유럽", "Oceania": "오세아니아",
    "South America East Coast": "남미 동안", "South America West Coast": "남미 서안",
}
LANES = [
    ("Asia", "Mediterranean/Black Sea"), ("Asia", "North America East Coast"),
    ("Asia", "North America West Coast"), ("Asia", "North Europe"), ("Asia", "Oceania"),
    ("Asia", "South America East Coast"), ("Asia", "South America West Coast"),
    ("Mediterranean/Black Sea", "North America East Coast"),
    ("Mediterranean/Black Sea", "North America West Coast"),
    ("Mediterranean/Black Sea", "North Europe"),
    ("Mediterranean/Black Sea", "South America East Coast"),
    ("Mediterranean/Black Sea", "South America West Coast"),
    ("North America East Coast", "North Europe"),
    ("North America East Coast", "South America East Coast"),
    ("North America East Coast", "South America West Coast"),
    ("North America West Coast", "North Europe"),
    ("North America West Coast", "South America East Coast"),
    ("North America West Coast", "South America West Coast"),
    ("North Europe", "South America East Coast"),
    ("North Europe", "South America West Coast"),
]
LANE_KEYS = ["%s|%s" % l for l in LANES]

SCHEMA = {
    "type": "object",
    "properties": {
        "months": {"type": "array", "items": {"type": "string"}},
        "rows": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "from": {"type": "string"}, "to": {"type": "string"},
                "values": {"type": "array", "items": {"type": "number"}},
            },
            "required": ["from", "to", "values"]}},
    },
    "required": ["months", "rows"],
}


def slug_ym(slug):
    m = re.search(r"report-([a-z]+)(\d{2})$", slug)
    if not m:
        return None
    k = m.group(1)
    mo = MON.index(k[:3]) + 1 if k[:3] in MON else MON_ALT.get(k)
    return (2000 + int(m.group(2)), mo) if mo else None


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, headers=HDR, timeout=40)
            if r.status_code == 200:
                r.encoding = "utf-8"
                return r
            last = "HTTP %s" % r.status_code
        except Exception as e:  # noqa: BLE001
            last = str(e)[:80]
        time.sleep(3 * (i + 1))
    raise RuntimeError(last)


def find_slugs(seed_pages, back_months=4):
    """알고 있는 보고서 페이지들의 '관련 기사' 목록에서 보고서 주소를 모은다 + 최근 달 추정."""
    found = set()
    for u in seed_pages:
        try:
            found |= set(re.findall(r"seaexplorer-schedule-reliability-report-[a-z]+\d{2}", get(u, 1).text))
        except Exception:  # noqa: BLE001
            pass
    today = datetime.datetime.now(KST).date()
    for back in range(0, back_months):    # 이번 달부터 거꾸로(관련 목록에 아직 없을 수 있다)
        y, m = today.year, today.month - back
        while m <= 0:
            y, m = y - 1, m + 12
        found.add("seaexplorer-schedule-reliability-report-%s%02d" % (MON[m - 1], y % 100))
    return sorted((s for s in found if slug_ym(s)), key=slug_ym, reverse=True)


def table_image(html):
    """'노선별 정시성' 제목 바로 다음 그림 — 없으면 그 제목 바로 앞 그림(6월 보고서가 그렇다)."""
    soup = BeautifulSoup(html, "html.parser")
    art = soup.find("article") or soup
    seq = [el for el in art.find_all(["h2", "h3", "img"])
           if el.name != "img" or "newseditor" in (el.get("src") or "")]
    idx = [i for i, el in enumerate(seq) if el.name in ("h2", "h3")
           and re.search(r"per\s*trade\s*-?\s*lane", el.get_text(" "), re.I)]
    if not idx:
        return None
    i = idx[0]
    for el in seq[i + 1:]:
        if el.name != "img":
            break
        return el["src"]
    for el in reversed(seq[:i]):
        if el.name != "img":
            break
        return el["src"]
    return None


def month_key(s):
    m = re.fullmatch(r"\s*([A-Za-z]+)[\s\-']*(\d{2})\s*", s or "")
    if not m:
        return None
    k = m.group(1).lower()
    mo = MON.index(k[:3]) + 1 if k[:3] in MON else MON_ALT.get(k)
    return "%d-%02d" % (2000 + int(m.group(2)), mo) if mo else None


def norm_region(s):
    s = re.sub(r"\s+", " ", (s or "").replace("↔", " ").strip())
    s = re.sub(r"\s*/\s*", "/", s)
    for k in REGION_KO:
        if s.lower() == k.lower():
            return k
    return None


def read_table(img):
    prompt = ("이 그림은 해운 노선별 정시성(%) 표다. 그림에 적힌 그대로 옮겨라.\n"
              "- months: 머리줄의 달 6개를 왼쪽부터 그림에 적힌 글자 그대로(예: 'Sept-25').\n"
              "- rows: 위에서부터 모든 줄. 노선 이름은 ↔ 양쪽을 from·to 로 나눠 그대로,"
              " values 는 그 줄의 % 숫자 6개를 왼쪽부터(퍼센트 기호 없이).\n"
              "- 추측하거나 계산하지 마라. 흐려서 못 읽는 칸이 있으면 rows 를 빈 배열로.")
    return gemini_json(prompt, SCHEMA, temperature=0.0, tag="kn", images=[("image/jpeg", img)])


def parse(res):
    if not res:
        raise ValueError("빈 응답")
    months = [month_key(m) for m in res.get("months") or []]
    if len(months) != 6 or None in months:
        raise ValueError("달 머리를 못 읽음: %s" % res.get("months"))
    out = {}
    for r in res.get("rows") or []:
        a, b = norm_region(r.get("from")), norm_region(r.get("to"))
        key = "%s|%s" % (a, b)
        vals = r.get("values") or []
        if key not in LANE_KEYS or len(vals) != 6:
            raise ValueError("노선/칸 오류: %s ↔ %s %s" % (r.get("from"), r.get("to"), vals))
        if not all(isinstance(v, (int, float)) and 0 <= v <= 100 for v in vals):
            raise ValueError("값 범위 오류: %s" % vals)
        out[key] = [round(float(v), 1) for v in vals]
    if sorted(out) != sorted(LANE_KEYS):
        raise ValueError("노선 20개가 아님(%d개)" % len(out))
    return months, out


def text_check(html, months, table):
    """본문의 '노선 … NN.N%' 가 표의 마지막 달 값과 맞는지 — 맞지 않는 것이 있으면 실패."""
    soup = BeautifulSoup(html, "html.parser")
    txt = re.sub(r"\s+", " ", (soup.find("article") or soup).get_text(" "))
    bad, hit = [], 0
    for key in LANE_KEYS:
        a, b = key.split("|")
        for m in re.finditer(re.escape(a) + r"\s*↔\s*" + re.escape(b)
                             + r"\s+(?:led at|reached|at|to)\s+(\d{1,3}\.\d)%", txt):
            v = float(m.group(1))
            if v in table[key]:
                hit += 1
            else:
                bad.append("%s %.1f" % (key, v))
    return hit, bad


def read_report(slug, old_lanes):
    url = BASE + slug.split("report-")[1]
    html = get(url).text
    src = table_image(html)
    if not src:
        raise ValueError("노선별 표 그림을 못 찾음")
    img = get(src).content
    reads = []
    for _ in range(2):                    # 같은 그림을 두 번 따로 읽는다
        res, why = read_table(img)
        if res is None:
            raise ValueError("AI 실패: %s" % why)
        reads.append(parse(res))
        time.sleep(2)
    if reads[0] != reads[1]:
        diff = [k for k in LANE_KEYS if reads[0][1][k] != reads[1][1][k]]
        raise ValueError("두 번 읽은 값이 다름(%s)" % ", ".join(diff[:4]))
    months, table = reads[0]
    mism = 0                       # 저장된 값과 다른 칸 — K+N 의 개정이라 막지 않고 세기만 한다
    for k in LANE_KEYS:
        for i, ym in enumerate(months):
            ov = (old_lanes.get(k) or {}).get(ym)
            if ov is not None and abs(ov - table[k][i]) > 0.05:
                mism += 1
    hit, bad = text_check(html, months, table)
    if bad:
        raise ValueError("본문 수치와 다름: %s" % "; ".join(bad[:4]))
    glob = re.search(r"[Gg]lobal schedule reliability[^.%]{0,120}?(\d{1,2}\.\d)%",
                     re.sub(r"\s+", " ", BeautifulSoup(html, "html.parser").get_text(" ")))
    pub = re.search(r'article:published_time" content="([^"]+)"', html)
    print("[kn] %s 읽음 — 달 %s · 본문 대조 %d건 일치 · 저장값과 다른 칸 %d(개정)"
          % (slug, ",".join(months), hit, mism))
    return {"slug": slug, "url": url, "months": months, "table": table,
            "global": float(glob.group(1)) if glob else None,
            "published": pub.group(1)[:10] if pub else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    args = ap.parse_args()
    try:
        old = json.load(io.open(OUT, encoding="utf-8"))
    except (OSError, ValueError):
        old = {}
    lanes = {l["key"]: dict(l["values"]) for l in old.get("lanes", [])}
    done = set(old.get("reports", []))
    seeds = [BASE + s.split("report-")[1] for s in (old.get("reports") or [])[-1:]] or [BASE + "sep26"]
    slugs = find_slugs(seeds, 24 if args.backfill else 4)
    todo = [s for s in slugs if s not in done]
    if not args.backfill:
        # 평소: 저장된 것보다 새 달만, 최신부터 — 하나 읽히면 멈춘다(추정한 주소는 404 일 수 있다)
        top = max([slug_ym(s) for s in done] or [(0, 0)])
        todo = [s for s in todo if slug_ym(s) > top]
    if not todo:
        print("[kn] 새 보고서 없음 → 파일을 쓰지 않음")
        return 0
    latest = old.get("latest")
    reps = []
    # 평소: 최신부터 하나 읽히면 멈춘다 / 채우기: 전부 읽는다
    for slug in sorted(todo, key=slug_ym, reverse=True):
        try:
            reps.append(read_report(slug, lanes))
        except Exception as e:  # noqa: BLE001
            print("[kn] %s 건너뜀: %s" % (slug, str(e)[:200]))
            continue
        if not args.backfill:
            break
    got = len(reps)
    # 반영 — 표의 마지막 달이 이른 보고서부터. 겹치는 달은 뒤(더 최근) 보고서 값이 남는다.
    last_month = (latest or {}).get("months", [""])[-1] if latest else ""
    for rep in sorted(reps, key=lambda r: r["months"][-1]):
        if rep["months"][-1] < last_month:
            # 이미 있는 최신 보고서보다 오래된 보고서 — 빈 달만 채우고 덮어쓰지 않는다
            for k in LANE_KEYS:
                for i, ym in enumerate(rep["months"]):
                    lanes.setdefault(k, {}).setdefault(ym, rep["table"][k][i])
        else:
            for k in LANE_KEYS:
                for i, ym in enumerate(rep["months"]):
                    lanes.setdefault(k, {})[ym] = rep["table"][k][i]
        done.add(rep["slug"])
        if not latest or rep["months"][-1] >= latest["months"][-1]:
            latest = {k: rep[k] for k in ("slug", "url", "months", "global", "published")}
            last_month = rep["months"][-1]
    if not got:
        print("[kn] 읽은 보고서 없음 → 파일을 쓰지 않음")
        return 1
    data = {
        "status": "ok",
        "source": "Kuehne+Nagel seaexplorer Schedule Reliability Report",
        "note": "정시 도착 = 도착 14일 전 마지막 공지 일정 대비 ±24시간 안에 도착(K+N 방법론)",
        "latest": latest,
        "reports": sorted(done, key=slug_ym),   # 주소 기준 정렬(내용 순서와 다를 수 있다 — mar25)
        "lanes": [{"key": k, "from": k.split("|")[0], "to": k.split("|")[1],
                   "ko": "%s ↔ %s" % (REGION_KO[k.split("|")[0]], REGION_KO[k.split("|")[1]]),
                   "values": dict(sorted(lanes.get(k, {}).items()))} for k in LANE_KEYS],
        "updatedAt": datetime.datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
    }
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("[kn] 저장 — 보고서 %d개 · 최신 %s" % (len(done), latest["slug"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
