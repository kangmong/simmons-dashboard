"""이미 수집해 둔 dashboard.json 에서 '사진이 비어 있는' 브랜드 기사만 다시 훑어 채운다.

왜 필요한가
-----------
이미지 추출 로직을 고쳐도(api/update.py), 이미 커밋된 dashboard.json 의
image: null 은 다음 정기 수집이 돌기 전까지 그대로다. 화면에서는 브랜드 첫 글자
플레이스홀더로 남는다. 이 스크립트는 그 빈 칸만 지금 채운다.

안전 규칙 (수집기 방어 규칙과 같다)
-----------------------------------
- ★ 비어 있는 image 만 건드린다. 이미 값이 있는 항목·다른 필드·다른 섹션은
  읽기만 하고 절대 덮어쓰지 않는다. 실패하면 그 항목은 그냥 두고 넘어간다.
- ★ 파일은 수집기와 똑같은 한 줄 압축 형식으로 다시 쓴다
  (separators=(',',':') · ensure_ascii=False). 예쁘게 들여쓰면 5만 줄짜리
  diff 가 나서 무엇이 바뀌었는지 볼 수 없게 된다 — 실제로 한 번 그랬다.

사용법
------
    python scripts/fill_brand_images.py            # 채울 것만 채운다
    python scripts/fill_brand_images.py --dry-run  # 무엇이 채워질지만 본다
"""

import collections
import concurrent.futures
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "api"))
import update as U  # noqa: E402  (api/update.py 의 추출 로직을 그대로 쓴다)

DATA = os.path.join(ROOT, "public", "data", "dashboard.json")
SECTIONS = ("domestic", "global_brands")
GROUPS = ("items", "featured")
WORKERS = 6


def _targets(doc):
    """사진이 비어 있는 항목만 모은다. 같은 링크는 한 번만 조회한다."""
    out, seen = [], set()
    for sec in SECTIONS:
        blk = (doc.get("sections") or {}).get(sec) or {}
        for grp in GROUPS:
            for it in (blk.get(grp) or []):
                link = it.get("link")
                if it.get("image") or not link or link in seen:
                    continue
                seen.add(link)
                out.append((sec, it.get("brand"), (it.get("title") or "")[:40], link))
    return out


def _lookup(t):
    sec, brand, title, link = t
    try:
        real = U._decode_gnews_url(link) or link
        img, why = U._meta_image(real)
    except Exception as e:  # noqa: BLE001
        img, why = None, "예외(%s)" % type(e).__name__
    return (link, brand, title, img, why)


def main():
    dry = "--dry-run" in sys.argv
    doc = json.load(io.open(DATA, encoding="utf-8"),
                    object_pairs_hook=collections.OrderedDict)
    targets = _targets(doc)
    print("사진이 비어 있는 기사 %d건 — 다시 조회합니다\n" % len(targets))
    if not targets:
        return

    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        found = list(ex.map(_lookup, targets))

    by_link = {}
    for link, brand, title, img, why in found:
        mark = "채움" if img else "그대로"
        print("[%s] %s — %s" % (mark, brand, title))
        print("        %s" % ((img or ("사유: " + str(why)))[:96]))
        if img:
            by_link[link] = img

    if not by_link:
        print("\n채울 것이 없습니다 (파일 그대로).")
        return

    # ★ 비어 있는 image 만 채운다 — 다른 필드는 손대지 않는다.
    n = 0
    for sec in SECTIONS:
        blk = (doc.get("sections") or {}).get(sec) or {}
        for grp in GROUPS:
            for it in (blk.get(grp) or []):
                if not it.get("image") and it.get("link") in by_link:
                    it["image"] = by_link[it["link"]]
                    n += 1

    if dry:
        print("\n--dry-run: %d칸을 채울 수 있습니다(파일은 그대로 둡니다)." % n)
        return

    # ★ 수집기와 같은 한 줄 압축 형식으로 쓴다(diff 를 읽을 수 있게)
    io.open(DATA, "w", encoding="utf-8", newline="").write(
        json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print("\n%d칸을 채웠습니다." % n)


if __name__ == "__main__":
    main()
