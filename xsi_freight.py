# -*- coding: utf-8 -*-
"""글로벌 컨테이너 운임지수 — Xeneta Shipping Index by Compass (XSI-C).

항로 8개를 하루 한 번 모아 public/data/xsi-freight-index.json 으로 저장한다.
화면(app.js)은 그 파일만 읽는다.

■ 어디서 무엇을 가져오는가 (실측으로 확인한 구조)
  1) 항로 페이지 https://www.compassft.com/indice/<slug>/
     WordPress + Elementor 정적 HTML. 통계 9개가 '라벨 div → 값 div' 순서로
     그대로 들어 있다(class="elementor-heading-title elementor-size-default").
     같은 페이지 인라인 스크립트에 var currentIndiceId=<숫자> 가 있다.
  2) 그래프 데이터
     https://www.compassft.com/wp-admin/admin-ajax.php
       ?id=<currentIndiceId>&action=compassft_get_indicevalues
     [[epoch_ms, 값], …] 전 구간(2015~)을 그대로 돌려준다.

■ 기간 버튼(1Y/3Y/5Y/All)에 대하여
  원본 사이트의 compassft.js 를 읽어 확인한 결과, 이 버튼은 '차트를 잘라 다시
  그릴 뿐' 통계를 다시 계산하지 않는다(setData 만 호출). 그래서 여기서 받는
  통계 9개는 기간과 무관한 Compass 공표값이고, 화면에도 그렇게 적는다.

■ 예의
  항로 8개 × (페이지 1 + JSON 1) = 16번 요청이 전부이고, 요청 사이를 쉰다.
  하루 한 번만 돈다(.github/workflows/collect-xsi.yml).
"""
import datetime
import io
import json
import os
import re
import sys
import time

import requests

BASE = "https://www.compassft.com"
PAGE = BASE + "/indice/%s/"
AJAX = BASE + "/wp-admin/admin-ajax.php"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
TIMEOUT = 45
PAUSE = 1.5          # 요청 사이 쉬는 시간(초)

OUT = os.path.join("public", "data", "xsi-freight-index.json")

# 항로 — 슬러그 · 한글 이름 · 짧은 탭 라벨
ROUTES = [
    ("xsicfene", "극동 → 북유럽", "극동→북유럽"),
    ("xsicnefe", "북유럽 → 극동", "북유럽→극동"),
    ("xsicfeuw", "극동 → 미국 서해안", "극동→미서안"),
    ("xsicuwfe", "미국 서해안 → 극동", "미서안→극동"),
    ("xsicneue", "북유럽 → 미국 동해안", "북유럽→미동안"),
    ("xsicuene", "미국 동해안 → 북유럽", "미동안→북유럽"),
    ("xsicfese", "극동 → 남미 동해안", "극동→남미동안"),
    ("xsicnese", "북유럽 → 남미 동해안", "북유럽→남미동안"),
]

# 페이지의 라벨 → 우리가 쓰는 키. 라벨은 사이트 표기 그대로 둔다.
FIELDS = [
    ("Date", "date"),
    ("Last Value", "last"),
    ("Annualised Return", "annReturn"),
    ("Annualised Volatility", "annVol"),
    ("1 Day Return", "d1"),
    ("MTD Return", "mtd"),
    ("QTD Return", "qtd"),
    ("YTD Return", "ytd"),
    ("Since Inception", "inception"),
]

HEAD_RE = re.compile(
    r'class="elementor-heading-title elementor-size-default">(.*?)</div>', re.S)
TAG_RE = re.compile(r"<[^>]+>")


def _text(s):
    """HTML 조각에서 글자만. &#8211; 같은 엔티티도 사람이 읽는 모양으로."""
    t = TAG_RE.sub("", s)
    t = (t.replace("&#8211;", "-").replace("&#8212;", "-").replace("&amp;", "&")
          .replace("&nbsp;", " ").replace("&#039;", "'").replace("&quot;", '"'))
    return " ".join(t.split())


def _num(s):
    """'4323' · '-6.61%' → 숫자. 못 읽으면 None(추측해서 채우지 않는다)."""
    if s is None:
        return None
    m = re.search(r"-?\d[\d,]*\.?\d*", str(s))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def fetch_page(slug):
    """항로 페이지에서 통계 9개 + indiceId + 지수명을 뽑는다."""
    r = requests.get(PAGE % slug, headers=UA, timeout=TIMEOUT)
    r.raise_for_status()
    h = r.text
    heads = [_text(x) for x in HEAD_RE.findall(h)]

    # 라벨 바로 다음 칸이 값이다 — 사이트가 그렇게 짜여 있다.
    raw = {}
    for i, x in enumerate(heads):
        for label, key in FIELDS:
            if x == label and i + 1 < len(heads):
                raw.setdefault(key, heads[i + 1])

    missing = [k for _, k in FIELDS if k not in raw]
    if missing:
        raise ValueError("페이지에서 못 찾은 항목: %s" % ", ".join(missing))

    m = re.search(r"currentIndiceId\s*=\s*(\d+)", h)
    if not m:
        raise ValueError("currentIndiceId 를 찾지 못했습니다(페이지 구조 변경 가능)")

    name = next((x for x in heads if "Xeneta Shipping Index" in x), "")
    stats = {"date": raw["date"]}
    for _, key in FIELDS:
        if key == "date":
            continue
        stats[key] = _num(raw[key])
    return {"indiceId": int(m.group(1)), "name": name, "stats": stats,
            "rawStats": {k: raw[k] for k in raw}}


def fetch_series(indice_id, slug):
    """그래프 데이터 [[epoch_ms, 값], …] → {dates:[YYYY-MM-DD], values:[…]}"""
    r = requests.get(AJAX, headers=dict(UA, Referer=PAGE % slug), timeout=TIMEOUT,
                     params={"id": indice_id, "action": "compassft_get_indicevalues",
                             "t": int(time.time())})
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, list) or not data:
        raise ValueError("그래프 데이터 형식이 예상과 다릅니다")
    dates, values = [], []
    for row in data:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        ms, v = row[0], row[1]
        if ms is None or v is None:
            continue
        d = datetime.datetime.fromtimestamp(
            float(ms) / 1000.0, datetime.timezone.utc).strftime("%Y-%m-%d")
        dates.append(d)
        values.append(round(float(v), 2))
    if not dates:
        raise ValueError("그래프 데이터가 비어 있습니다")
    return {"dates": dates, "values": values}


def collect():
    routes, failures = [], []
    for slug, ko, short in ROUTES:
        try:
            page = fetch_page(slug)
            time.sleep(PAUSE)
            try:
                series = fetch_series(page["indiceId"], slug)
            except Exception as e:  # noqa: BLE001 — 그래프만 실패해도 통계는 살린다
                series = None
                failures.append({"route": slug, "part": "series", "reason": str(e)[:160]})
                print("  ! %s 그래프 실패: %s" % (slug, str(e)[:100]), file=sys.stderr)
            routes.append({
                "key": slug, "name": ko, "short": short,
                "title": page["name"], "code": slug.upper(),
                "url": PAGE % slug,
                "stats": page["stats"],
                "series": series,
            })
            print("  %-9s %-16s 최근 %s (%s) · 시계열 %s"
                  % (slug, ko, page["stats"]["last"], page["stats"]["date"],
                     ("%d행 %s~%s" % (len(series["dates"]), series["dates"][0],
                                      series["dates"][-1])) if series else "없음"))
        except Exception as e:  # noqa: BLE001 — 한 항로가 막혀도 나머지는 저장한다
            failures.append({"route": slug, "part": "page", "reason": str(e)[:160]})
            print("  X %-9s 실패: %s" % (slug, str(e)[:110]), file=sys.stderr)
        time.sleep(PAUSE)
    return routes, failures


def main():
    print("[xsi] 항로 %d개 수집 시작" % len(ROUTES))
    routes, failures = collect()
    if not routes:
        print("[xsi] 전 항로 실패 — 기존 파일을 덮어쓰지 않습니다", file=sys.stderr)
        return 1
    payload = {
        "status": "ok",
        "source": "Compass Financial Technologies (Xeneta Shipping Index)",
        "sourceUrl": BASE + "/indices/?family=xsi",
        # 기간 버튼은 차트만 자를 뿐 통계를 다시 계산하지 않는다(원본 JS 확인).
        "statsNote": "통계는 Compass 가 공표한 값으로, 기간 선택과 무관한 전체 기간 기준입니다.",
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "routes": routes,
        "failures": failures,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, "w", encoding="utf-8", newline="").write(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    size = os.path.getsize(OUT) / 1024.0
    print("[xsi] 항로 %d개 저장 · 실패 %d건 · %.0f KB → %s"
          % (len(routes), len(failures), size, OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
