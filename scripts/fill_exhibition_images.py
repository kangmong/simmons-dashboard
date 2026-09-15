"""행사 공식 사이트에서 대표 이미지를 뽑아 exhibitions.json 의 image 를 채운다.

시몬스 코리아 소식이 기사 페이지에서 og:image 를 뽑아 쓰는 것과 같은 방식이다.
(api/update.py 의 _IMG_METAS · _https_img 를 그대로 재사용한다)

왜 '첫 후보'만 쓰면 안 되나
--------------------------
og:image 가 이미 사라진 주소를 가리키거나(CES 는 404), 1×1 추적 픽셀 같은
아주 작은 파일을 주는 사이트가 있다(Salone 는 405바이트). 그래서 후보를
여러 개 모아 두고 '실제로 받아지고 · 이미지이고 · 너무 작지 않은' 첫 번째를 고른다.

사용법
------
    python scripts/fill_exhibition_images.py            # 비어 있는 것만 채움
    python scripts/fill_exhibition_images.py --all      # 전부 다시 뽑음

★ 페이지를 못 읽으면 그 항목은 건드리지 않는다. 다만 '후보는 있는데 전부
  쓸 수 없는' 경우에는 기존 값을 비운다 — 예전에 받아 둔 추적 픽셀 주소를
  남겨 두면 카드에 1×1 이미지가 늘어난 채로 뜨기 때문이다.
"""

import io
import json
import os
import re
import sys
import collections
import urllib.parse

import html as _html

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))
import update as U  # noqa: E402  (api/update.py 재사용)

requests.packages.urllib3.disable_warnings()  # noqa: E501  인증서 만료 사이트 대응

DATA = os.path.join(ROOT, "public", "data", "exhibitions.json")
UA = {"User-Agent": "Mozilla/5.0 (compatible; SimmonsDashboard/1.0)"}
MIN_BYTES = 6000          # 이보다 작으면 추적 픽셀·아이콘으로 보고 버린다
TIMEOUT = 15
MAX_CANDIDATES = 8


def candidates(page_url):
    """페이지에서 대표 이미지 후보를 순서대로 모은다(중복 제거)."""
    try:
        r = requests.get(page_url, headers=UA, timeout=TIMEOUT, verify=False)
        r.raise_for_status()
        html = r.text
    except Exception as e:  # noqa: BLE001
        print("    페이지를 못 읽음: %s" % repr(e)[:70])
        return []

    out, seen = [], set()

    def add(raw):
        # ★ HTML 안의 주소는 &amp; 처럼 이스케이프돼 있다. 풀지 않으면
        #   '?v=..&amp;width=1000' 이 그대로 요청돼 엉뚱한 파라미터가 된다(CES 가 그랬다).
        raw = _html.unescape((raw or "").strip())
        u = urllib.parse.urljoin(page_url, raw)
        if not u.startswith("http") or "googleusercontent" in u:
            return
        u = U._https_img(u)
        if u not in seen:
            seen.add(u)
            out.append(u)

    for rx in U._IMG_METAS:                    # og:image → twitter:image → image_src
        for m in rx.finditer(html):
            add(m.group(1))
    # 본문 이미지도 뒤에 붙인다(메타가 죽어 있을 때의 대비)
    for m in re.finditer(
            r'<img[^>]+(?:data-src|src)=["\']([^"\']+\.(?:jpe?g|png|webp)[^"\']*)', html, re.I):
        add(m.group(1))
    return out[:MAX_CANDIDATES]


def pick(page_url):
    """실제로 받아지고 · 이미지이고 · 너무 작지 않은 첫 후보. 없으면 None."""
    for u in candidates(page_url):
        try:
            r = requests.get(u, headers=UA, timeout=TIMEOUT, stream=True, verify=False)
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if r.status_code != 200 or not ctype.startswith("image/"):
                r.close()
                continue
            body = r.raw.read(MIN_BYTES + 1, decode_content=True)
            r.close()
            if len(body) <= MIN_BYTES:
                print("    너무 작음(%dB 이하) → 건너뜀: %s" % (MIN_BYTES, u[:64]))
                continue
            return u
        except Exception:  # noqa: BLE001
            continue
    return None


def main():
    refill_all = "--all" in sys.argv
    d = json.load(io.open(DATA, encoding="utf-8"),
                  object_pairs_hook=collections.OrderedDict)
    changed = 0
    for it in d.get("items", []):
        name = it.get("name", "")
        if it.get("image") and not refill_all:
            continue
        link = it.get("link")
        if not link:
            print("%s → 링크 없음" % name)
            continue
        print("%s" % name)
        img = pick(link)
        if img:
            it["image"] = img
            changed += 1
            print("    OK %s" % img[:80])
        else:
            # 못 찾으면 비워 둔다 — 예전에 받아 둔 깨진 주소(추적 픽셀 등)를 그대로
            # 남기면 카드에 1x1 이미지가 늘어난 채로 뜬다. 비우면 분야 색 배너로 돌아간다.
            if it.get("image"):
                it["image"] = ""
                changed += 1
            print("    쓸 만한 이미지를 못 찾음 — 비움(분야 색 배너로 표시)")

    if changed:
        io.open(DATA, "w", encoding="utf-8", newline="").write(
            json.dumps(d, ensure_ascii=False, indent=2) + "\n")
    print("\n%d건 갱신%s" % (changed, "" if changed else " (파일 그대로)"))


if __name__ == "__main__":
    main()
