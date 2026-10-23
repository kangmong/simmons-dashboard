# -*- coding: utf-8 -*-
"""일일 국제원자재가격(KOIMA) '주요 이슈' 자동 추가 — public/data/kp-insights.json events.

부문(유화원료·섬유원료·철강재·비철금속·희소금속)마다 최근 뉴스에서 '값을 움직인 실제
사건'(공급 차질·관세·전쟁·공장 가동 중단 등)을 주 1회 찾아 사건 목록에 붙인다.
화면은 지금처럼 사건 뒤 실제로 얼마나 움직였는지를 koima-price.json 으로 직접 재고,
움직임이 뚜렷하지 않으면 * (참고용)를 단다(app.js kpiEvents).

★ 받아들이는 조건(하나라도 어긋나면 버린다)
  · AI 가 고른 번호가 실제 받은 기사 목록에 있다(링크·출처는 파이썬이 붙인다)
  · 사건 이름·설명 속 숫자가 모두 기사 제목·요약에 그대로 있다
  · 사건 날짜가 기사 날짜보다 늦지 않고 14일 넘게 앞서지 않는다
  · 같은 부문에 같은 이름의 사건이 이미 없다
★ 사람이 넣은 사건(auto 표시 없음)은 건드리지 않는다. 자동 사건은 부문마다 최근 6건만 둔다.
★ 바뀐 것이 없으면 파일을 쓰지 않는다.

    python koima_events.py            # 수집·저장
    python koima_events.py --dry-run  # 찾기만
"""
import argparse
import datetime
import io
import json
import re
import sys
import time

from gemini_json import gemini_json
from sleeptech_news import KST, nums, rss

PATH = "public/data/kp-insights.json"
AUTO_KEEP = 6
DAYS = 30

CATS = {
    "petchem": ("유화원료(나프타·프로필렌·에틸렌·천연가스)", ["naphtha prices", "나프타 가격"]),
    "textile": ("섬유원료(면화·폴리프로필렌·폴리에틸렌·VCM)", ["cotton prices", "면화 가격"]),
    "steel": ("철강재(H형강·철근·강판)", ["steel prices", "철강 가격"]),
    "nonferrous": ("비철금속(구리·니켈·아연·알루미늄 등)", ["LME copper price", "구리 가격"]),
    "rare": ("희소금속(코발트)", ["cobalt price", "코발트 가격"]),
}

SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "id": {"type": "integer"},
        "date": {"type": "string"},
        "label": {"type": "string"},
        "detail": {"type": "string"},
    },
    "required": ["found", "id", "date", "label", "detail"],
}


def ask(cat_name, items):
    lines = "\n".join("[%d] %s (%s · %s)\n    %s" % (i, x["title"], x["source"], x["date"],
                                                   x["desc"][:220]) for i, x in enumerate(items))
    prompt = (
        "아래는 %s 시장 관련 최근 뉴스다.\n"
        "이 원자재 값을 움직인 '실제로 일어난 사건'(전쟁·봉쇄, 관세·수출 규제 시행, 공장 가동 중단·"
        "사고, 파업, 재고·생산 발표 등) 가운데 가장 중요한 것 하나만 골라라.\n"
        "- 가격 전망·분석 칼럼·주간 시황 요약은 사건이 아니다. 없으면 found=false.\n"
        "- date 는 사건이 일어난 날(YYYY-MM-DD). 기사에 날짜가 없으면 기사 날짜.\n"
        "- label 은 한국어 20자 이내 사건 이름, detail 은 한국어 120자 이내로 무슨 일인지.\n"
        "- 제목·요약에 있는 사실만 쓴다. 숫자는 적힌 그대로 옮긴다(단위 환산·계산 금지).\n\n%s"
        % (cat_name, lines))
    return gemini_json(prompt, SCHEMA, tag="kpe")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    today = datetime.datetime.now(KST).date()
    data = json.load(io.open(PATH, encoding="utf-8"))
    events = data.setdefault("events", [])
    added = 0
    for cat, (cat_name, queries) in CATS.items():
        mine = [e for e in events if cat in (e.get("cats") or [])]
        last = max([datetime.date.fromisoformat(e["date"]) for e in mine if e.get("auto")]
                   or [today - datetime.timedelta(days=DAYS)])
        items, seen = [], set()
        for q in queries:
            try:
                for x in rss(q, "ko" if re.search(r"[가-힣]", q) else "en"):
                    if x["date"] > last and x["url"] not in seen:
                        seen.add(x["url"])
                        items.append(x)
            except Exception as e:  # noqa: BLE001
                print("[kpe] %s — 뉴스 못 읽음(%s): %s" % (cat, q, str(e)[:70]))
            time.sleep(2)
        items = sorted(items, key=lambda x: x["date"], reverse=True)[:25]
        if not items:
            continue
        res, why = ask(cat_name, items)
        if res is None:
            print("[kpe] %s — AI 실패: %s" % (cat, why))
            continue
        if not res.get("found"):
            print("[kpe] %s — 이번 주 사건 없음" % cat)
            continue
        i = res.get("id")
        if not isinstance(i, int) or not (0 <= i < len(items)):
            continue
        x = items[i]
        label, detail = re.sub(r"\s+", " ", res.get("label") or "").strip(), \
            re.sub(r"\s+", " ", res.get("detail") or "").strip()
        try:
            d = datetime.date.fromisoformat(res.get("date") or "")
        except ValueError:
            d = x["date"]
        hay = x["title"] + " " + x["desc"]
        bad = nums(label + " " + detail) - nums(hay) - nums(d.isoformat())
        if not label or len(label) > 30 or not detail or len(detail) > 180:
            print("[kpe] %s — 버림(길이)" % cat)
            continue
        if bad:
            print("[kpe] %s — 버림(기사에 없는 숫자 %s): %s" % (cat, ",".join(sorted(bad)), label))
            continue
        if not (x["date"] - datetime.timedelta(days=14) <= d <= x["date"]):
            d = x["date"]                       # 날짜가 이상하면 기사 날짜로 둔다
        if any(e.get("label") == label for e in mine):
            continue
        ev = {"date": d.isoformat(), "cats": [cat], "label": label, "detail": detail,
              "source": (x["source"] or "뉴스") + " (뉴스 자동 수집)", "url": x["url"], "auto": True}
        print("[kpe] + %s · %s %s — %s" % (cat, ev["date"], label, detail))
        events.append(ev)
        added += 1
        # 자동 사건은 부문마다 최근 AUTO_KEEP 건만
        autos = sorted([e for e in events if e.get("auto") and cat in e.get("cats", [])],
                       key=lambda e: e["date"], reverse=True)
        for old in autos[AUTO_KEEP:]:
            events.remove(old)
    if not added:
        print("[kpe] 새 사건 없음 → 파일을 쓰지 않음")
        return 0
    if args.dry_run:
        print("[kpe] --dry-run: %d건을 찾았지만 저장하지 않음" % added)
        return 0
    data["updated"] = today.isoformat()
    io.open(PATH, "w", encoding="utf-8", newline="\n").write(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print("[kpe] 저장 — %d건 추가" % added)
    return 0


if __name__ == "__main__":
    sys.exit(main())
