# -*- coding: utf-8 -*-
"""KOIMA 일일 국제원자재가격 수집 — 순수 추가 모듈(add-only).

★ 월간 부문별 지수(koima_index.py)와는 페이지·경로·파라미터 체계가 완전히 다르다.
  코드를 복사하지 않고 새로 작성했다. 주요 차이:
    - 경로        /koima/price/          (월간은 /koima/item/index/)
    - 부문 번호    73~80                  (월간은 57~64. 숫자를 재사용하면 안 된다)
    - 파라미터     priceSearchVO.*        (월간은 itemIndexSearchVO.*)
    - 소급 단위    '일'  -365 = 1년        (월간은 '년'  -3 = 3년)
    - 응답 키      subItemInfoList        (월간은 koimaItemIndexList)

수집 절차:
  [A] 부문별 품목 목록  POST retrieveList.do (priceSearchVO.mainItemNo)
      → 렌더된 표에서 fncDetailView('<subItemNo>','<품목명>') + 단위/시장/현물선물 파싱
      ※ 명세의 retrieveSubPriceListAjax.do 는 현재 404(존재하지 않음)라 목록 페이지를
        파싱하는 방식으로 대체했다. --raw 로 확인 가능.
  [B] 품목별 시계열      POST retrieveChartAjax.do (priceSearchVO.*)

단독 실행:
    python koima_price.py               # 수집 + 검증 로그
    python koima_price.py --raw         # [A]/[B] 응답 원문을 tmp/koima-price-raw.json 에 저장
    python koima_price.py --out PATH    # 결과 JSON 저장
    python koima_price.py --days -365   # 소급 일수 지정(기본 -365)
    python koima_price.py --limit 3     # 부문당 품목 N개만(빠른 점검용)
"""
import os
import io
import re
import sys
import json
import time
import datetime

import requests

KP_BASE = "https://www.koimaindex.com/koimaindex/koima/price/"
KP_LIST_URL = KP_BASE + "retrieveList.do"
KP_CHART_URL = KP_BASE + "retrieveChartAjax.do"
KP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
         "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# 부문 매핑 — price/retrieveList.do 의 fncTab('<no>','<이름>') 파싱으로 확정(2026-08 확인).
# ★ 번호가 연속이 아니다: 철강재=80 이 비철금속=78·희소금속=79 보다 크다. 정렬하지 말 것.
# 순서는 명세의 탭 순서(유화원료 → 섬유원료 → 철강재 → 비철금속 → 희소금속).
KP_CATEGORIES = [
    (76, "petchem", "유화원료"),
    (77, "textile", "섬유원료"),
    (80, "steel", "철강재"),
    (78, "nonferrous", "비철금속"),
    (79, "rare", "희소금속"),
]

# 소급 '일수'. -365=1년, -1095=3년, -3650 이상은 2019-10-01 로 포화(그 이전 데이터 없음).
# 기본 -1095(3년) — 명세값. 소요 시간은 창 크기와 무관하게 요청 수(품목 60개)로 결정되므로
# 3년으로 늘려도 느려지지 않고 응답 용량만 커진다(1년 1.9MB → 3년 약 5MB).
KP_DAYS = "-1095"
KP_SLEEP = 0.4              # 요청 간 대기(초) — 병렬 요청 금지
KP_SOURCE = "KOIMA 국제원자재가격정보 · 일일 국제원자재가격"


def _kp_num(v):
    """'1,005.00' → 1005.0 / 빈 값·'-' → None"""
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    if not s or s in ("-", "--"):
        return None
    try:
        return round(float(s), 4)
    except ValueError:
        return None


def _kp_text(x):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", x)).replace("&nbsp;", " ").strip()


def _kp_session():
    s = requests.Session()
    s.headers.update({"User-Agent": KP_UA})
    s.get(KP_LIST_URL, timeout=30)   # 세션 쿠키 확보
    return s


def _kp_headers():
    return {"Referer": KP_LIST_URL, "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}


def kp_discover_categories(sess):
    """탭에서 (no, 부문명) 쌍 추출. 실패 시 빈 리스트 → 상수 폴백."""
    try:
        h = sess.get(KP_LIST_URL, timeout=30).content.decode("utf-8", "replace")
        return [(int(n), nm) for n, nm in re.findall(r"fncTab\('(\d+)','([^']+)'\)", h)]
    except Exception:  # noqa: BLE001
        return []


def kp_base_date(html):
    """목록 페이지의 '기준일 : 2026년08월04일' → '2026-08-04'."""
    m = re.search(r"기준일[^0-9]{0,10}(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일", _kp_text(html))
    if m:
        return "%04d-%02d-%02d" % (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", _kp_text(html))
    return m.group(0) if m else None


def kp_items(sess, no):
    """[A] 부문 품목 목록 → ([{no,name,unit,market,spotFutures}], 목록 HTML).

    명세의 retrieveSubPriceListAjax.do 가 404 이므로 목록 페이지 표를 파싱한다.
    표 컬럼: 품목/단위/거래시장(조건)/현물·선물/가격/전주평균/전월평균/전일비/전주비/전월비
    """
    r = sess.post(KP_LIST_URL, timeout=40, headers={"Referer": KP_LIST_URL},
                  data={"priceSearchVO.mainItemNo": str(no),
                        "priceSearchVO.searchMainItemNo": str(no),
                        "priceSearchVO.subItemNo": "",
                        "priceSearchVO.subItemName": ""})
    r.raise_for_status()
    html = r.content.decode("utf-8", "replace")
    out, seen = [], set()
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        dv = re.search(r"fncDetailView\('(\d+)',\s*'([^']*)'\)", tr)
        if not dv:
            continue
        sub_no = int(dv.group(1))
        if sub_no in seen:
            continue
        seen.add(sub_no)
        cells = [_kp_text(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)]
        out.append({
            "no": sub_no,
            "name": dv.group(2),
            "unit": cells[1] if len(cells) > 1 else None,
            "market": cells[2] if len(cells) > 2 else None,
            "spotFutures": cells[3] if len(cells) > 3 else None,
        })
    return out, html


def kp_series(sess, main_no, item, days=KP_DAYS, search_date=None):
    """[B] 품목 시계열 → (rows, latest). 예외는 호출부로 올린다."""
    sd = search_date or datetime.date.today().isoformat()
    r = sess.post(KP_CHART_URL, timeout=60, headers=_kp_headers(),
                  data={"priceSearchVO.subItemName": item["name"],
                        "priceSearchVO.subItemNo": str(item["no"]),
                        "priceSearchVO.mainItemNo": str(main_no),
                        "priceSearchVO.searchMainItemNo": str(main_no),
                        "priceSearchVO.searchSubItemNo": "",
                        "priceSearchVO.searchDate": sd,
                        "priceSearchVO.searchCondition": str(days)})
    r.raise_for_status()
    j = r.json()
    if j.get("code") != "200":
        raise ValueError("code=%s" % j.get("code"))
    lst = j.get("subItemInfoList") or []
    rows = []
    for it in lst:
        d = (it.get("priceDate") or "").strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            continue
        price = _kp_num(it.get("pricePrice"))
        if price is None:
            continue
        rows.append({
            "date": d, "price": price,
            "domValue": _kp_num(it.get("dayResult")), "domPct": _kp_num(it.get("dayPer")),
            "wowValue": _kp_num(it.get("weekResult")), "wowPct": _kp_num(it.get("weekPer")),
            "momValue": _kp_num(it.get("monthResult")), "momPct": _kp_num(it.get("monthPer")),
        })
    rows.sort(key=lambda x: x["date"])
    # 최신 행의 부가 정보(요약 바에 쓰는 전주평균·전월평균·단위·시장·현물선물)
    latest = {}
    if lst:
        tail = lst[-1]
        latest = {
            "unit": tail.get("subItemUnit"), "market": tail.get("subItemMarket"),
            "spotFutures": tail.get("subItemSpotFuture"),
            "weekAvg": _kp_num(tail.get("weekAvg")), "monthAvg": _kp_num(tail.get("monthAvg")),
        }
    return rows, latest


def update_koima_price(days=KP_DAYS, limit=None, progress=None):
    """5개 부문 × 품목별 일별 가격 수집.

    개별 품목 실패는 건너뛰고 계속한다(전체 중단 없음). 실패 목록은 결과에 담아 반환.
    """
    log, failures = [], []
    try:
        sess = _kp_session()

        found = kp_discover_categories(sess)
        cats = list(KP_CATEGORIES)
        if found:
            by_no = dict(found)
            cats = [(no, key, by_no.get(no, label)) for no, key, label in KP_CATEGORIES]
            missing = [no for no, _, _ in KP_CATEGORIES if no not in by_no]
            log.append("부문 탐색: 사이트 탭 %d개%s"
                       % (len(found), (" · 상수에 있으나 사이트에 없음 %s" % missing) if missing else ""))
        else:
            log.append("부문 탐색 실패 → 상수 매핑(73~80) 사용")

        # 총 품목 수를 먼저 세어 진행률을 정확히 표시
        listings, total = [], 0
        base_date = None
        for no, key, label in cats:
            items, html = kp_items(sess, no)
            if base_date is None:
                base_date = kp_base_date(html)
            if limit:
                items = items[:int(limit)]
            listings.append((no, key, label, items))
            total += len(items)
            log.append("  [목록] %-3d %-8s 품목 %2d개" % (no, label, len(items)))
            time.sleep(KP_SLEEP)

        log.append("총 %d개 품목 시계열 수집 시작 (요청 간 %.0fms, 수 분 걸릴 수 있음)"
                   % (total, KP_SLEEP * 1000))
        print("[koima-price] 총 %d개 품목 · 소급 %s일 · 첫 실행은 수 분 걸릴 수 있습니다."
              % (total, days))

        categories, done = [], 0
        for no, key, label, items in listings:
            out_items = []
            for i, it in enumerate(items, 1):
                done += 1
                try:
                    rows, latest = kp_series(sess, no, it, days=days)
                    if not rows:
                        raise ValueError("행 없음")
                    rec = dict(it)
                    # 시계열 응답의 단위/시장 정보가 더 정확하므로 있으면 덮어쓴다
                    for f in ("unit", "market", "spotFutures"):
                        if latest.get(f):
                            rec[f] = latest[f]
                    rec["weekAvg"] = latest.get("weekAvg")
                    rec["monthAvg"] = latest.get("monthAvg")
                    rec["rows"] = rows
                    out_items.append(rec)
                    msg = "%s %d/%d %s 완료 (%d행)" % (label, i, len(items), it["name"], len(rows))
                except Exception as e:  # noqa: BLE001  품목 1건 실패로 전체를 멈추지 않는다
                    failures.append({"category": label, "item": it["name"],
                                     "no": it["no"], "reason": str(e)[:120]})
                    msg = "%s %d/%d %s 실패 — 건너뜀 (%s)" % (label, i, len(items), it["name"], str(e)[:60])
                print("[koima-price] (%d/%d) %s" % (done, total, msg))
                if progress:
                    progress(done, total, msg)
                time.sleep(KP_SLEEP)
            categories.append({"no": no, "key": key, "label": label, "items": out_items})

        filled = [c for c in categories if c["items"]]
        if not filled:
            return {"status": "error", "reason": "KOIMA 일일가격 품목 없음(형식 변경/차단 가능)"}

        nrows = sum(len(i["rows"]) for c in categories for i in c["items"])
        span = sorted({i["rows"][0]["date"] for c in categories for i in c["items"]} |
                      {i["rows"][-1]["date"] for c in categories for i in c["items"]})
        for c in categories:
            log.append("  [수집] %-8s 품목 %2d개 / %5d행"
                       % (c["label"], len(c["items"]), sum(len(i["rows"]) for i in c["items"])))
        log.append("합계 부문 %d개 / 품목 %d개 / %d행 · 범위 %s ~ %s · 실패 %d건"
                   % (len(filled), sum(len(c["items"]) for c in categories), nrows,
                      span[0] if span else "-", span[-1] if span else "-", len(failures)))
        for line in log:
            print("[koima-price] " + line)
        if failures:
            print("[koima-price] ── 실패 목록 ──")
            for f in failures:
                print("[koima-price]   %s > %s (%s): %s"
                      % (f["category"], f["item"], f["no"], f["reason"]))

        return {
            "status": "ok",
            "source": KP_SOURCE,
            "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "baseDate": base_date,
            "days": str(days),
            "categories": categories,
            "failures": failures,
        }
    except requests.exceptions.RequestException as e:  # noqa: BLE001
        return {"status": "error", "reason": "KOIMA 일일가격 조회 실패: %s" % e}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "KOIMA 일일가격 파싱 실패: %s" % e}


def _kp_save_raw():
    """--raw: [A] 목록 응답과 [B] 시계열 응답 원문을 tmp/koima-price-raw.json 에 저장."""
    sess = _kp_session()
    no, _, label = KP_CATEGORIES[0]          # 유화원료(76)
    items, html = kp_items(sess, no)
    it = next((x for x in items if "프로필렌" in x["name"]), items[0] if items else None)
    raw_b = None
    if it:
        r = sess.post(KP_CHART_URL, timeout=60, headers=_kp_headers(),
                      data={"priceSearchVO.subItemName": it["name"],
                            "priceSearchVO.subItemNo": str(it["no"]),
                            "priceSearchVO.mainItemNo": str(no),
                            "priceSearchVO.searchMainItemNo": str(no),
                            "priceSearchVO.searchSubItemNo": "",
                            "priceSearchVO.searchDate": datetime.date.today().isoformat(),
                            "priceSearchVO.searchCondition": KP_DAYS})
        raw_b = r.content.decode("utf-8", "replace")

    base = os.path.dirname(os.path.abspath(__file__))
    tmp = os.path.join(base, "tmp")
    if not os.path.isdir(tmp):
        os.makedirs(tmp)
    path = os.path.join(tmp, "koima-price-raw.json")
    payload = {
        "_note": ("[A]는 명세의 retrieveSubPriceListAjax.do 가 404 라서 "
                  "retrieveList.do 목록 페이지를 파싱한 결과와 그 HTML을 함께 담았다."),
        "A_endpoint": KP_LIST_URL,
        "A_request": {"priceSearchVO.mainItemNo": no, "부문": label},
        "A_parsed_items": items,
        "A_raw_html_head": html[:4000],
        "B_endpoint": KP_CHART_URL,
        "B_request": {"priceSearchVO.subItemNo": it["no"] if it else None,
                      "priceSearchVO.subItemName": it["name"] if it else None,
                      "priceSearchVO.mainItemNo": no,
                      "priceSearchVO.searchCondition": KP_DAYS},
        "B_raw_response": json.loads(raw_b) if raw_b else None,
    }
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False, indent=2))
    print("[koima-price] --raw 저장: %s" % path)
    print("[koima-price]   [A] 품목 %d개 / [B] %d행"
          % (len(items), len((payload["B_raw_response"] or {}).get("subItemInfoList") or [])))


def _arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


if __name__ == "__main__":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    if "--raw" in sys.argv:
        _kp_save_raw()
        sys.exit(0)

    t0 = time.time()
    res = update_koima_price(days=_arg("--days", KP_DAYS), limit=_arg("--limit"))
    if res.get("status") != "ok":
        print("[koima-price] 실패: %s" % res.get("reason"))
        sys.exit(1)
    print("[koima-price] 소요 %.1f초" % (time.time() - t0))

    out = _arg("--out")
    if out:
        d = os.path.dirname(os.path.abspath(out))
        if d and not os.path.isdir(d):
            os.makedirs(d)
        with io.open(out, "w", encoding="utf-8") as f:
            f.write(json.dumps(res, ensure_ascii=False, indent=2))
        size = os.path.getsize(out)
        print("[koima-price] 저장: %s (%.1f MB)" % (out, size / 1048576.0))
    else:
        brief = dict(res)
        brief["categories"] = [
            {"label": c["label"], "no": c["no"], "itemCount": len(c["items"]),
             "items": [{"name": i["name"], "no": i["no"], "unit": i["unit"],
                        "rows": len(i["rows"]),
                        "first": i["rows"][0]["date"], "last": i["rows"][-1]["date"]}
                       for i in c["items"]]}
            for c in res["categories"]]
        print(json.dumps(brief, ensure_ascii=False, indent=2)[:3000])
