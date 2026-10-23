# -*- coding: utf-8 -*-
"""전시·컨퍼런스 일정 자동 갱신 — public/data/exhibitions.json.

끝난 행사만 골라 그 행사의 공식 사이트를 읽고, 다음 회차 날짜를 찾으면 바꾼다.
공식 사이트가 막혀 있거나 날짜가 없으면 구글 뉴스 검색 결과(제목·요약)에서 찾는다.
행사 목록(무엇을 보여 줄지)은 사람이 정한다 — 이 스크립트는 날짜만 따라간다.

★ 받아들이는 조건(하나라도 어긋나면 기존 값을 그대로 둔다):
  1) AI 가 근거로 든 문장이 공식 사이트 본문에 '그대로' 있다
  2) 그 문장 안에 시작 연도와 시작일·종료일 숫자가 들어 있다
  2-1) 그 문장이나 바로 앞(250자)에 행사 이름의 낱말이 모두 있다 — 한 사이트에
       여러 행사가 있을 때 다른 행사 날짜를 집어 오지 않게(실측: interzum.com 에서
       'Forum Italy' 대신 Cologne 날짜를 집었다)
  3) 시작일이 오늘 이후, 3년 이내 / 기간이 1~14일
★ 이름은 AI 에게 받지 않는다 — 기존 이름의 연도만 새 연도로 바꾼다.
  '제57회' 같은 회차는 해가 바뀐 만큼 더한다(매년 열리는 행사만 목록에 있다).
★ 실패가 배포된 데이터를 덮지 않는다. 바뀐 것이 없으면 파일을 쓰지 않는다.

    python exhibitions_update.py            # 끝난 행사 갱신
    python exhibitions_update.py --dry-run  # 찾기만 하고 저장하지 않는다
"""
import argparse
import datetime
import io
import json
import re
import sys

import warnings

import requests
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning

# RSS 를 html.parser 로 읽는다(러너에 lxml 이 없다). 제목·요약만 쓰므로 충분하다.
warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

from gemini_json import gemini_json

PATH = "public/data/exhibitions.json"
KST = datetime.timezone(datetime.timedelta(hours=9))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TEXT_CAP = 14000          # 한 페이지에서 AI 에게 넘기는 글자 수(앞부분 — 날짜는 보통 위에 있다)

SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "start": {"type": "string"},
        "end": {"type": "string"},
        "evidence": {"type": "string"},
    },
    "required": ["found", "start", "end", "evidence"],
}


def norm(s):
    s = re.sub(r"[‐-―−]", "-", s or "")
    return re.sub(r"\s+", " ", s).strip()


def page_text(url):
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en,ko;q=0.8"},
                     timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    for t in soup(["script", "style", "noscript", "svg"]):
        t.decompose()
    meta = " ".join(m.get("content", "") for m in soup.find_all("meta")
                    if (m.get("name") or m.get("property") or "").lower()
                    in ("description", "og:description", "og:title"))
    return norm(meta + " " + soup.get_text(" "))[:TEXT_CAP]


def news_text(name, next_year):
    """구글 뉴스 RSS 의 제목·요약을 이어 붙인다(무키). 한글 이름이면 한국어판."""
    base = norm(re.sub(r"\b20\d\d\b|\(.*?\)|제\d+회", " ", name))
    ko = bool(re.search(r"[가-힣]", name))
    q = requests.utils.quote('"%s" %d' % (base, next_year))
    url = ("https://news.google.com/rss/search?q=%s&hl=%s" % (q, "ko&gl=KR&ceid=KR:ko" if ko
                                                              else "en-US&gl=US&ceid=US:en"))
    r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    parts = []
    for it in soup.find_all("item")[:25]:
        desc = BeautifulSoup(it.description.text if it.description else "", "html.parser").get_text(" ")
        parts.append("%s. %s" % (it.title.text if it.title else "", desc))
    return norm(" | ".join(parts))[:TEXT_CAP]


def ask(item, text, today):
    prompt = (
        "아래는 행사 '%s' 공식 사이트 본문이다. 지난 회차는 %s~%s 에 끝났다.\n"
        "오늘(%s) 이후에 열리는 '다음 회차'의 시작일·종료일을 본문에서 찾아라.\n"
        "- 본문에 날짜가 분명히 적혀 있을 때만 found=true. 추측·계산 금지.\n"
        "- start/end 는 YYYY-MM-DD.\n"
        "- evidence 에는 그 날짜가 적힌 본문 문장을 한 글자도 바꾸지 말고 그대로 옮겨라"
        "(80자 이내로 잘라도 된다. 날짜 부분은 반드시 포함).\n"
        "- 찾지 못하면 found=false, 나머지는 빈 문자열.\n\n본문:\n%s"
        % (item["name"], item["start"], item["end"], today, text))
    return gemini_json(prompt, SCHEMA, tag="exh")


def _d(s):
    try:
        return datetime.date.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def name_words(name):
    """행사 이름에서 구별에 쓰는 낱말 — 연도·괄호·회차를 빼고 3글자 이상(한글은 2글자)."""
    base = re.sub(r"\b20\d\d\b|\(.*?\)|제\d+회", " ", name)
    return [w.lower() for w in re.findall(r"[A-Za-zÀ-ÿ]{3,}|[가-힣]{2,}", base)]


def accept(res, text, today, name=""):
    """받아들일 수 있으면 (start, end), 아니면 (None, 이유)."""
    if not res or not res.get("found"):
        return None, "본문에서 다음 회차 날짜를 찾지 못함"
    s, e = _d(res.get("start")), _d(res.get("end"))
    if not s or not e:
        return None, "날짜 형식 오류"
    if not (today < s <= today + datetime.timedelta(days=3 * 366)):
        return None, "시작일이 오늘 이후 3년 이내가 아님(%s)" % s
    if not (0 <= (e - s).days <= 14):
        return None, "기간이 이상함(%s~%s)" % (s, e)
    ev = norm(res.get("evidence"))
    if len(ev) < 6 or ev not in text:
        return None, "근거 문장이 본문에 그대로 없음"
    at = text.find(ev)
    win = text[max(0, at - 250):at + len(ev)].lower()
    miss = [w for w in name_words(name) if w not in win]
    if miss:
        return None, "근거 문장 근처에 행사 이름이 없음(%s) — 다른 행사일 수 있음" % ", ".join(miss)
    nums = set(re.findall(r"\d+", ev))
    if str(s.year) not in nums and str(s.year)[2:] not in nums:
        return None, "근거 문장에 연도가 없음"
    if str(s.day) not in {n.lstrip("0") for n in nums} or str(e.day) not in {n.lstrip("0") for n in nums}:
        return None, "근거 문장에 시작일·종료일 숫자가 없음"
    return (s, e), ev


def rename(name, old_year, new_year):
    out = re.sub(r"\b%d\b" % old_year, str(new_year), name, count=1)
    m = re.search(r"제(\d+)회", out)
    if m:
        out = out.replace(m.group(0), "제%d회" % (int(m.group(1)) + new_year - old_year), 1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    today = datetime.datetime.now(KST).date()
    data = json.load(io.open(PATH, encoding="utf-8"))
    changed = []
    for it in data["items"]:
        end = _d(it.get("end"))
        if not end or end >= today:
            continue
        got, why = None, ""
        old = _d(it["start"])
        # 공식 사이트 먼저, 안 되면 뉴스 — 어느 쪽이든 같은 검사를 통과해야 한다
        for where, fetch in (("공식 사이트", lambda: page_text(it["link"])),
                             ("구글 뉴스", lambda: news_text(it["name"], old.year + 1))):
            try:
                text = fetch()
            except Exception as e:  # noqa: BLE001
                print("[exh] %s — %s 못 읽음: %s" % (it["name"], where, str(e)[:90]))
                continue
            res, why = ask(it, text, today.isoformat())
            if res is None:
                print("[exh] %s — AI 실패: %s" % (it["name"], why))
                continue
            got, why = accept(res, text, today, it["name"])
            if got:
                why = "%s · %s" % (where, why)
                break
            print("[exh] %s — %s: %s" % (it["name"], where, why))
        if not got:
            print("[exh] %s — 그대로 둠" % it["name"])
            continue
        s, e = got
        new_name = rename(it["name"], old.year, s.year)
        print("[exh] %s → %s  %s~%s  근거: %s" % (it["name"], new_name, s, e, why[:90]))
        changed.append(it["name"])
        it.update(name=new_name, start=s.isoformat(), end=e.isoformat())
    if not changed:
        print("[exh] 바뀐 행사 없음 → 파일을 쓰지 않음")
        return 0
    if args.dry_run:
        print("[exh] --dry-run: %d건을 찾았지만 저장하지 않음" % len(changed))
        return 0
    data["updatedAt"] = today.isoformat()
    io.open(PATH, "w", encoding="utf-8", newline="\n").write(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print("[exh] 저장 — %d건 갱신" % len(changed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
