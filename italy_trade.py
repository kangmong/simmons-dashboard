# -*- coding: utf-8 -*-
"""이탈리아 매트리스·침구류(HS 9404) 수출입 — UN Comtrade 자동 수집.

★ 소스 선택 근거(2026-08 실측):
  a) Eurostat Comext(ds-045409)는 dissemination API 에서 제공되지 않는다.
     → HTTP 404 "DS-045409 (DATA_FLOW:ALL,1.0) is not available for dissemination."
     카탈로그의 무역 데이터셋(ext_*)은 전부 SITC/BEC 집계라 HS 코드가 없다.
  b) UN Comtrade 공개 preview 엔드포인트는 키 없이 동작한다. → 이쪽을 쓴다.

★ 실측으로 확인한 제약:
  · 한 요청에 기간(period) 1개만 허용 — "Maximum number of periods for preview is 1"
  · 품목 코드는 여러 개 동시 조회 가능(HS4 + HS6 를 한 번에 받는다)
  · 초당 1회 수준의 레이트 리밋(간격 1.2초로 14회 연속 성공, 실패 0)
  · 값 통화는 EUR 이 아니라 **USD**(primaryValue)
  · 공표 지연 약 3개월 — 2026-08 시점의 최신 확정치는 2026-05

★ 그래서 '증분 수집'이다. 받아둔 월은 public/data/italy-trade.json 에 커밋해
  두고, 매 실행에서 빠진 월만 몇 개씩 채운다. 과거 월은 다시 받지 않는다.
  (tmp/ 캐시는 CI 에서 날아가므로 데이터 파일 자체를 저장소에 둔다)

★ 추정치를 만들지 않는다. 공표되지 않은 월은 비워 둔다.
"""
import io
import os
import json
import time
import datetime

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_REL = os.path.join("public", "data", "italy-trade.json")

URL = "https://comtradeapi.un.org/public/v1/preview/C/M/HS"
REPORTER = "380"        # Italy
PARTNER = "0"           # World
FLOWS = "X,M"           # X=수출, M=수입

# HS 코드 → 표시명. 9404 는 합계, 나머지는 하위 세분.
HS_CODES = [
    ("9404", "전체 (매트리스·침구류)"),
    ("940410", "매트리스 서포트 (프레임·베이스)"),
    ("940421", "폼 매트리스 (셀룰러 고무·플라스틱)"),
    ("940429", "기타 재질 매트리스 (스프링 등)"),
]
CODE_PARAM = ",".join(c for c, _ in HS_CODES)

START_MONTH = "2024-01"   # 이 달부터 채운다
PUBLISH_LAG = 3           # 공표 지연(개월) — 이보다 최근 달은 조회하지 않는다
MAX_NEW = 4               # 한 실행에서 새로 받을 최대 개월(콜드 실행 타임아웃 방지)
SLEEP = 1.2               # 요청 간격(초) — 레이트 리밋 회피
TIMEOUT = 60
HEADERS = {"User-Agent": "Mozilla/5.0"}

SOURCE = "UN Comtrade · HS 9404 · reporter=Italy(380) · partner=World · 월별"
READ_NOTE = ("수입 증가는 해외 브랜드 침투를, 수출 증가는 자국 생산 호조를 시사합니다. "
             "Made in Italy 선호가 강한 시장이라 이 균형이 시장 구도 변화를 보여줍니다.")


def _data_path():
    return os.path.join(BASE, DATA_REL)


def _load():
    """기존 수집분. 없으면 빈 구조."""
    try:
        p = _data_path()
        if os.path.isfile(p):
            got = json.load(io.open(p, encoding="utf-8"))
            if isinstance(got, dict) and isinstance(got.get("months"), list):
                return got
    except Exception:  # noqa: BLE001
        pass
    return {"months": []}


def _save(payload):
    """저장. 쓰기 불가(배포 번들)여도 예외를 내지 않는다."""
    try:
        p = _data_path()
        d = os.path.dirname(p)
        if not os.path.isdir(d):
            os.makedirs(d)
        with io.open(p, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        return True
    except Exception as e:  # noqa: BLE001
        print("[italy_trade] 저장 생략(쓰기 불가): %s" % e)
        return False


def _month_range(start, end):
    """'YYYY-MM' 두 개 사이의 월 목록(양끝 포함)."""
    ys, ms = int(start[:4]), int(start[5:7])
    ye, me = int(end[:4]), int(end[5:7])
    out = []
    while (ys, ms) <= (ye, me):
        out.append("%04d-%02d" % (ys, ms))
        ms += 1
        if ms > 12:
            ys, ms = ys + 1, 1
    return out


def _target_end(today=None):
    """공표 지연을 감안한 마지막 조회 대상 월."""
    t = today or datetime.date.today()
    y, m = t.year, t.month - PUBLISH_LAG
    while m <= 0:
        y, m = y - 1, m + 12
    return "%04d-%02d" % (y, m)


def _fetch_month(month):
    """한 달 조회 → {'exp': {code: val}, 'imp': {...}}. 미공표면 빈 dict."""
    r = requests.get(URL, params={"reporterCode": REPORTER, "partnerCode": PARTNER,
                                  "period": month.replace("-", ""), "cmdCode": CODE_PARAM,
                                  "flowCode": FLOWS}, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    rows = r.json().get("data") or []
    exp, imp = {}, {}
    for x in rows:
        code = str(x.get("cmdCode") or "")
        val = x.get("primaryValue")
        if val is None or code not in dict(HS_CODES):
            continue
        (exp if x.get("flowCode") == "X" else imp)[code] = round(float(val))
    return {"exp": exp, "imp": imp}


def update_italy_trade():
    """빠진 월만 채워 저장하고 payload 를 돌려준다."""
    store = _load()
    have = {m["month"]: m for m in store["months"] if isinstance(m, dict) and m.get("month")}
    end = _target_end()
    want = _month_range(START_MONTH, end)
    missing = [m for m in want if m not in have]

    fetched, failed, empty = 0, 0, 0
    for month in missing[:MAX_NEW]:
        time.sleep(SLEEP)   # 매 요청 앞에 항상 둔다(직전 실행 직후 429 가 났다)
        try:
            got = _fetch_month(month)
        except Exception as e:  # noqa: BLE001 — 한 달 실패해도 나머지는 유지
            failed += 1
            print("[italy_trade] %s 실패: %s" % (month, str(e)[:90]))
            continue
        if not got["exp"] and not got["imp"]:
            empty += 1          # 아직 공표되지 않은 달 — 저장하지 않는다
            continue
        have[month] = dict(got, month=month)
        fetched += 1

    months = [have[m] for m in sorted(have)]
    payload = {
        "status": "ok" if months else "error",
        "reason": None if months else "수집된 월이 없습니다",
        "source": SOURCE,
        "currency": "USD",
        "codes": [{"code": c, "label": l} for c, l in HS_CODES],
        "read_note": READ_NOTE,
        "months": months,
        "latest": months[-1]["month"] if months else None,
        "target_end": end,
        "pending": max(0, len(missing) - MAX_NEW),
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    if fetched:
        _save(payload)
    print("[italy_trade] 보유 %d개월(%s~%s) · 신규 %d · 실패 %d · 미공표 %d · 남은 대기 %d"
          % (len(months), months[0]["month"] if months else "-",
             payload["latest"] or "-", fetched, failed, empty, payload["pending"]))
    return payload


if __name__ == "__main__":
    import sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    n = 1
    if "--fill" in sys.argv:          # 최초 적재용: 반복 실행으로 전 구간 채운다
        n = int(sys.argv[sys.argv.index("--fill") + 1])
    for i in range(n):
        p = update_italy_trade()
        if not p.get("pending"):
            break
