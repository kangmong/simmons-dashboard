# -*- coding: utf-8 -*-
"""미국 매트리스(HS 9404) 수입 — UN Comtrade 자동 수집.

★ Census API 를 대체한다. Census 는 무료지만 **키 발급이 필요**해서(키 없이
  호출하면 "Missing Key" HTML) 키가 없는 동안 수입단가 선이 아예 비었다.
  UN Comtrade 공개 preview 는 키가 필요 없고, 이미 이탈리아용으로 검증된
  코드를 그대로 재사용한다(reporterCode 만 842 로 바꾼다).
  → 양국이 같은 소스·같은 파서라 비교 일관성도 좋아진다.

★ 소스 판정 근거(2026-08 실측, 전부 실제 호출로 확인):
  · reporterCode=842 로 HS 940421 / 940429 세분 조회 정상 (HTTP 200)
  · 금액(primaryValue)과 수량(qty)이 함께 온다 → 단가 계산 가능
  · 2020-01 ~ 2026-05 전 구간 응답 확인
  · reporterCode="842,380" 처럼 두 나라를 한 요청에 넣는 것도 되지만,
    이탈리아 저장 포맷을 건드리지 않기 위해 나라별 파일로 분리했다.
    (한 실행에서 새로 받는 달이 MAX_NEW=4 개뿐이라 호출 수는 문제가 안 된다.
     무간격 연속 8회도 전부 200 이었다. 그래도 간격 1.2초는 유지한다.)

★ 단가는 **개당(USD/개)** 이다. kg 단가가 아니다.
  미국은 netWgt 가 isNetWgtEstimated=True — Comtrade 가 금액을 연도별 고정계수로
  나눠 역산한 값이다(2024년 전월 7.2196, 2025년 전월 6.7784 USD/kg 로 소수
  4자리까지 동일). 월별 정보가 0 이므로 kg 단가로 그래프를 그리면 Comtrade
  계수의 계단만 보인다. 반대로 qty 는 실보고(isQtyEstimated=False)이고 단위가
  코드 5="u"(Number of items, 공식 레퍼런스 QuantityUnits.json 실측)라
  개당 단가가 실제 데이터다. 이탈리아는 정반대(중량 실보고·수량 추정)여서
  kg 단가를 쓴다 — 나라마다 '실제로 보고된 수량'을 쓴다는 원칙은 같다.

★ 추정치를 만들지 않는다. 공표되지 않은 달·수량이 안 온 코드는 비워 둔다.
"""
import io
import os
import json
import time
import datetime

from italy_trade import (HS_CODES, MAX_NEW, SLEEP, PUBLISH_LAG, START_MONTH,
                         _fetch_month, _load, _month_range, _save, _target_end,
                         _unit_prices)

REPORTER = "842"          # USA
DATA_REL = os.path.join("public", "data", "us-trade.json")

SOURCE = "UN Comtrade · HS 9404 · reporter=USA(842) · partner=World · 월별 · 키 불필요"
READ_NOTE = ("매트리스 1개당 수입단가입니다. 오르면 수입 제품의 고가 비중 증가를 시사합니다.")


def update_us_trade():
    """빠진 월만 채워 저장하고 payload 를 돌려준다(italy_trade 와 같은 증분 방식)."""
    store = _load(DATA_REL)
    have = {}
    for m in store["months"]:
        if not isinstance(m, dict) or not m.get("month"):
            continue
        if "impq" not in m:      # 개수가 없는 구버전 레코드는 다시 받는다
            continue
        have[m["month"]] = m
    end = _target_end()
    want = _month_range(START_MONTH, end)
    missing = [m for m in want if m not in have]

    fetched, failed, empty = 0, 0, 0
    for month in missing[:MAX_NEW]:
        time.sleep(SLEEP)
        try:
            got = _fetch_month(month, REPORTER)
        except Exception as e:  # noqa: BLE001 — 한 달 실패해도 나머지는 유지
            failed += 1
            print("[us_trade] %s 실패: %s" % (month, str(e)[:90]))
            continue
        if not got["exp"] and not got["imp"]:
            empty += 1           # 아직 공표되지 않은 달 — 저장하지 않는다
            continue
        have[month] = dict(got, month=month)
        fetched += 1

    months = [have[m] for m in sorted(have)]
    payload = {
        "status": "ok" if months else "error",
        "reason": None if months else "수집된 월이 없습니다",
        "source": SOURCE,
        "currency": "USD",
        "qty_unit": "개",
        "unit_price_unit": "USD/개",
        "codes": [{"code": c, "label": l} for c, l in HS_CODES],
        "read_note": READ_NOTE,
        "months": months,
        "latest": months[-1]["month"] if months else None,
        "target_end": end,
        "pending": max(0, len(missing) - MAX_NEW),
        "unit_prices": _unit_prices(months, "q"),
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    if fetched:
        _save(payload, DATA_REL)
    print("[us_trade] 보유 %d개월(%s~%s) · 신규 %d · 실패 %d · 미공표 %d · 남은 대기 %d"
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
        p = update_us_trade()
        if not p.get("pending"):
            break
    print(json.dumps({k: v for k, v in p.items() if k not in ("months", "unit_prices")},
                     ensure_ascii=False, indent=1))
