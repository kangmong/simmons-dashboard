# -*- coding: utf-8 -*-
"""슬립테크 기업·시장 규모 '최근 소식' 자동 수집 — 주 1회.

대상
  · public/data/simmons-market.json    국내 슬립테크 6개 기업 + 국내 수면시장 규모
  · public/data/global-sleeptech.json  해외 슬립테크 6개 기업 + 글로벌 기기 시장 규모

방식
  1) 구글 뉴스 RSS(무키)에서 대상마다 최근 기사 제목·요약을 받는다
  2) Gemini 가 그중 '이 기업/주제의 투자·수상·출시·실적·제휴·시장 규모 발표'만 골라
     한 줄로 요약한다
  3) 아래 검사를 모두 통과한 것만 그 대상의 updates 목록에 붙인다(최신 4건 유지)

★ 사람이 정리한 값(설립·투자 유치·매출·CES 건수·그래프 숫자)은 고치지 않는다.
  새 소식은 '최근 소식' 줄로만 붙는다 — AI 가 정리된 사실을 덮어쓰지 않게.
★ 받아들이는 조건
  · AI 가 고른 번호가 실제 받은 기사 목록에 있다(링크는 파이썬이 붙인다)
  · 기업이면 기사 제목·요약에 그 기업 이름이 있다
  · 시장 규모 카드에는 '시장규모' 소식만, 기사에 시장/market 이 있을 때만 붙는다
    (실측: 시장 카드에 개별 기업의 제휴·출시 기사가 섞였다)
  · 요약 문장 속 숫자가 모두 기사 제목·요약에 그대로 있다(지어낸 숫자 차단)
★ 바뀐 것이 없으면 파일을 쓰지 않는다. 실패해도 기존 파일은 그대로다.

    python sleeptech_news.py            # 수집·저장
    python sleeptech_news.py --dry-run  # 찾기만
"""
import argparse
import datetime
import email.utils
import io
import json
import re
import sys
import time
import warnings

import requests
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning

from gemini_json import gemini_json

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

KST = datetime.timezone(datetime.timedelta(hours=9))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
KEEP = 4             # 대상마다 남기는 소식 수
PER_RUN = 2          # 한 번 실행에 대상마다 새로 붙이는 최대 수
LOOKBACK_DAYS = 120  # 처음 실행 때 거슬러 보는 기간
KINDS = ["투자", "수상", "출시", "실적", "제휴", "시장규모"]

SCHEMA = {
    "type": "object",
    "properties": {
        "picks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "kind": {"type": "string", "enum": KINDS},
                    "text": {"type": "string"},
                },
                "required": ["id", "kind", "text"],
            },
        },
    },
    "required": ["picks"],
}

FILES = [
    # (경로, 언어, 기업 목록 위치, [(시장 주제 위치, 검색어)])
    ("public/data/simmons-market.json", "ko", ("sleepTech", "companies"),
     [(("sleepMarket",), "수면산업 시장 규모")]),
    ("public/data/global-sleeptech.json", "en", ("sleepTech", "companies"),
     [(("deviceMarket",), "sleep tech devices market size")]),
]


def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def short_name(name):
    """'에이슬립 (Asleep)' → '에이슬립', 'Withings (프랑스)' → 'Withings'"""
    return norm(re.sub(r"\(.*?\)", " ", name))


def rss(query, lang):
    q = requests.utils.quote(query + " when:%dd" % LOOKBACK_DAYS)
    loc = "hl=ko&gl=KR&ceid=KR:ko" if lang == "ko" else "hl=en-US&gl=US&ceid=US:en"
    r = requests.get("https://news.google.com/rss/search?q=%s&%s" % (q, loc),
                     headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    out = []
    for it in BeautifulSoup(r.text, "html.parser").find_all("item")[:30]:
        title = norm(it.title.text if it.title else "")
        desc = norm(BeautifulSoup(it.description.text if it.description else "",
                                  "html.parser").get_text(" "))
        link = ""
        # html.parser 에서 <link> 는 빈 태그로 읽혀 주소가 다음 형제 텍스트로 붙는다
        if it.link is not None:
            link = norm(it.link.text) or norm(str(it.link.next_sibling or ""))
        try:
            dt = email.utils.parsedate_to_datetime(it.pubdate.text).astimezone(KST).date()
        except Exception:  # noqa: BLE001
            continue
        src = norm(it.source.text) if it.source else ""
        if title and link.startswith("http"):
            out.append({"title": title, "desc": desc, "url": link, "date": dt, "source": src})
    return out


def nums(s):
    return {n.replace(",", "") for n in re.findall(r"\d[\d,]*(?:\.\d+)?", s or "")}


def pick(target_name, items, is_company, lang):
    lines = "\n".join("[%d] %s (%s · %s)\n    %s" % (i, x["title"], x["source"], x["date"],
                                                   x["desc"][:220]) for i, x in enumerate(items))
    prompt = (
        "아래는 '%s' 관련 최근 뉴스 목록이다.\n"
        "%s 소식 중 다음에 해당하는 것만 골라라: 투자 유치, 수상(CES 혁신상 등), 신제품 출시, "
        "실적 발표, 제휴, 시장 규모 발표.\n"
        "- 다른 회사·다른 주제 기사, 광고·칼럼·일반 소개 기사는 고르지 마라.\n"
        "- 같은 사건을 다룬 기사가 여럿이면 하나만.\n"
        "- text 는 한국어 한 문장 60자 이내. 제목·요약에 있는 사실만, 숫자는 적힌 그대로 옮겨라"
        "(단위 환산·계산 금지). 추측 금지.\n"
        "- 해당하는 것이 없으면 picks 를 빈 배열로.\n\n%s"
        % (target_name, "이 기업 자체의" if is_company else "이 시장(산업 전체) 규모에 관한",
           lines))
    return gemini_json(prompt, SCHEMA, tag="stn")


def collect_target(name, query, lang, existing, is_company, today):
    seen = {u.get("url") for u in existing} | {u.get("label") for u in existing}
    newest = max([datetime.date.fromisoformat(u["date"]) for u in existing if u.get("date")]
                 or [today - datetime.timedelta(days=LOOKBACK_DAYS)])
    got = None
    # 검색어가 길면 구글 뉴스가 가끔 404 를 준다 — 이름만으로 한 번 더 찾는다
    for q in (query, '"%s"' % short_name(name) if is_company else query):
        try:
            got = rss(q, lang)
            break
        except Exception as e:  # noqa: BLE001
            print("[stn] %s — 뉴스 못 읽음: %s" % (name, str(e)[:70]))
            time.sleep(3)
    if got is None:
        return []
    items = [x for x in got
             if x["date"] > newest and x["url"] not in seen and x["title"] not in seen]
    if not items:
        return []
    items = items[:15]
    res, why = pick(name, items, is_company, lang)
    if res is None:
        print("[stn] %s — AI 실패: %s" % (name, why))
        return []
    added = []
    key = short_name(name).lower()
    for p in res.get("picks") or []:
        i = p.get("id")
        if not isinstance(i, int) or not (0 <= i < len(items)):
            continue
        x = items[i]
        hay = (x["title"] + " " + x["desc"])
        text = norm(p.get("text"))
        if not text or len(text) > 90 or p.get("kind") not in KINDS:
            continue
        if not is_company and (p.get("kind") != "시장규모"
                               or not re.search(r"시장|market", hay, re.I)):
            continue
        if is_company and key not in hay.lower():
            print("[stn] %s — 버림(기사에 기업 이름 없음): %s" % (name, x["title"][:60]))
            continue
        bad = nums(text) - nums(hay)
        if bad:
            print("[stn] %s — 버림(기사에 없는 숫자 %s): %s" % (name, ",".join(sorted(bad)), text))
            continue
        added.append({"date": x["date"].isoformat(), "kind": p["kind"], "text": text,
                      "label": x["title"], "source": x["source"], "url": x["url"]})
        if len(added) >= PER_RUN:
            break
    return added


def dig(d, path):
    for k in path:
        d = d.get(k) if isinstance(d, dict) else None
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    today = datetime.datetime.now(KST).date()
    total = 0
    for path, lang, cpath, topics in FILES:
        data = json.load(io.open(path, encoding="utf-8"))
        changed = 0
        targets = []
        for c in dig(data, cpath) or []:
            nm = short_name(c["name"])
            q = ('"%s" (투자 OR 혁신상 OR 출시 OR 매출 OR 제휴)' % nm if lang == "ko"
                 else '"%s" (funding OR raises OR CES OR launches OR revenue OR partnership)' % nm)
            targets.append((c, c["name"], q, True))
        for tpath, q in topics:
            t = dig(data, tpath)
            if isinstance(t, dict):
                targets.append((t, t.get("title") or t.get("cardTitle") or q, q, False))
        for obj, name, q, is_co in targets:
            got = collect_target(name, q, lang, obj.get("updates") or [], is_co, today)
            for g in got:
                print("[stn] + %s · %s %s — %s" % (name, g["date"], g["kind"], g["text"]))
            if got:
                obj["updates"] = sorted((obj.get("updates") or []) + got,
                                        key=lambda u: u["date"], reverse=True)[:KEEP]
                changed += len(got)
            time.sleep(2)          # 뉴스·AI 요청 사이를 쉰다
        if changed and not args.dry_run:
            io.open(path, "w", encoding="utf-8", newline="\n").write(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            print("[stn] 저장 %s — %d건" % (path, changed))
        total += changed
    if not total:
        print("[stn] 새 소식 없음 → 파일을 쓰지 않음")
    elif args.dry_run:
        print("[stn] --dry-run: %d건을 찾았지만 저장하지 않음" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
