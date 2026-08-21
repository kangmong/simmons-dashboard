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

# ── 티어 구분(단가 기반) ──────────────────────────────────────────────────
# 단가 = 금액 ÷ 순중량(USD/kg). 개당 단가는 산출 불가(qty 가 추정치·단위 없음).
#
# 방식: 하위 50%(저단가) 구간을 먼저 제외하고, 남은 상위 50%를 다시 둘로 나눈다.
#   상위 25%      (단가 ≥ Q3)      → 하이엔드
#   25~50% 구간   (Q2 ≤ 단가 < Q3) → 프리미엄
#   하위 50%      (단가 < Q2)      → 어느 티어에도 넣지 않는다(저가 물량)
# 경계는 전체 관측치의 분위수로 매 실행 재계산하고 payload 에 실어 보낸다.
#
# ★ 대상은 매트리스 3개 하위코드(9404.10/.21/.29)다. HS 9404 합계에는 베개·이불
#   등(9404.30/.90)이 섞여 매트리스 티어로 보기 어렵다.
# ★ 어느 경계를 쓰든 하이엔드는 사실상 수출만 들어간다 — 이탈리아 수입 단가
#   최대치가 수출 단가 하위권보다 낮기 때문이다(실측). 화면에 그 사실을 적는다.
TIER_MODE = "upper_split"
TIER_HS = ("940410", "940421", "940429")
TIER_DISCLAIMER = ("무역 단가 기준 구분이며, 미국 섹션의 브랜드 가격대 기준과 "
                   "산출 방식이 다릅니다.")
TIER_SCOPE_NOTE = ("매트리스 3개 하위코드(HS 9404.10·.21·.29) 기준입니다. "
                   "저단가 하위 50% 구간은 제외했고, 하이엔드는 단가 특성상 "
                   "대부분 수출로 채워집니다.")

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
    """한 달 조회 → 금액(exp/imp)과 순중량(expw/impw)을 함께 담는다.
       ★ 단가(=금액÷중량) 계산에 중량이 필수다. netWgt 는 isNetWgtEstimated=False
         (추정치 아님)이고, qty 는 isQtyEstimated=True + 단위 라벨이 없어 쓰지 않는다.
         일부 조합(예: 940421 수입)은 netWgt 가 비어 오므로 그 달·그 코드의
         단가는 계산하지 않고 비워 둔다."""
    r = requests.get(URL, params={"reporterCode": REPORTER, "partnerCode": PARTNER,
                                  "period": month.replace("-", ""), "cmdCode": CODE_PARAM,
                                  "flowCode": FLOWS}, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    rows = r.json().get("data") or []
    exp, imp, expw, impw = {}, {}, {}, {}
    known = dict(HS_CODES)
    for x in rows:
        code = str(x.get("cmdCode") or "")
        if code not in known:
            continue
        out_v = exp if x.get("flowCode") == "X" else imp
        out_w = expw if x.get("flowCode") == "X" else impw
        val, wgt = x.get("primaryValue"), x.get("netWgt")
        if val is not None:
            out_v[code] = round(float(val))
        if wgt:                      # 0·None 은 담지 않는다(단가가 무한이 된다)
            out_w[code] = round(float(wgt))
    return {"exp": exp, "imp": imp, "expw": expw, "impw": impw}


def _unit_prices(months):
    """월별 단가(USD/kg) = 금액 ÷ 순중량. 중량이 없는 조합은 None 으로 비운다.
       ★ 추정치를 만들지 않는다 — 중량이 안 온 달은 계산하지 않는다."""
    out = []
    for m in months:
        row = {"month": m["month"], "exp": {}, "imp": {}}
        for flow, vk, wk in (("exp", "exp", "expw"), ("imp", "imp", "impw")):
            vals, wgts = m.get(vk) or {}, m.get(wk) or {}
            for code, _ in HS_CODES:
                v, w = vals.get(code), wgts.get(code)
                row[flow][code] = round(v / w, 3) if (v and w) else None
        out.append(row)
    return out


def _tier_block(months):
    """단가 분위로 티어 경계를 잡고 월별 티어 합계를 만든다.
       ★ 추정치를 만들지 않는다 — 중량이 없어 단가를 못 구한 관측치는 제외한다."""
    obs = []          # (month, flow, code, unit_price, value)
    for m in months:
        for flow, vk, wk in (("exp", "exp", "expw"), ("imp", "imp", "impw")):
            vals, wgts = m.get(vk) or {}, m.get(wk) or {}
            for code in TIER_HS:
                v, w = vals.get(code), wgts.get(code)
                if v and w:
                    obs.append((m["month"], flow, code, v / w, v))
    if len(obs) < 8:
        return {"mode": None, "reason": "단가 관측치가 부족합니다(%d건)" % len(obs)}
    ps = sorted(o[3] for o in obs)

    def pct(q):
        return ps[min(len(ps) - 1, int(round(q * (len(ps) - 1))))]

    q1, q2, q3 = pct(.25), pct(.5), pct(.75)
    band = {}
    for month, flow, code, price, val in obs:
        if price < q2:
            key = "excluded"
        elif price < q3:
            key = "premium"
        else:
            key = "high"
        d = band.setdefault(month, {"high": {"exp": 0, "imp": 0}, "premium": {"exp": 0, "imp": 0},
                                    "excluded": {"exp": 0, "imp": 0}})
        d[key][flow] += val
    series = []
    for m in months:
        d = band.get(m["month"])
        if not d:
            continue
        row = {"month": m["month"]}
        for k in ("high", "premium"):
            row[k] = {"exp": d[k]["exp"] or None, "imp": d[k]["imp"] or None}
        # 전체 = 하이엔드 + 프리미엄 (저단가 제외 구간은 넣지 않는다 → 세 값이 맞물린다)
        row["all"] = {"exp": (d["high"]["exp"] + d["premium"]["exp"]) or None,
                      "imp": (d["high"]["imp"] + d["premium"]["imp"]) or None}
        series.append(row)
    cnt = {"high": 0, "premium": 0, "excluded": 0}
    for _, _, _, price, _ in obs:
        cnt["excluded" if price < q2 else ("premium" if price < q3 else "high")] += 1
    print("[italy_trade] 단가 분포(USD/kg, n=%d) 최소 %.2f · Q1 %.2f · 중앙 %.2f · Q3 %.2f · 최대 %.2f"
          % (len(ps), ps[0], q1, q2, q3, ps[-1]))
    print("[italy_trade] 티어 경계 — 하이엔드 ≥ %.2f · 프리미엄 %.2f~%.2f · 제외 < %.2f"
          % (q3, q2, q3, q2))
    print("[italy_trade] 티어별 관측 건수 — 하이엔드 %d · 프리미엄 %d · 제외 %d"
          % (cnt["high"], cnt["premium"], cnt["excluded"]))
    return {"mode": TIER_MODE, "unit": "USD/kg",
            "dist": {"n": len(ps), "min": round(ps[0], 2), "q1": round(q1, 2),
                     "median": round(q2, 2), "q3": round(q3, 2), "max": round(ps[-1], 2)},
            "boundary": {"high_min": round(q3, 2), "premium_min": round(q2, 2)},
            "counts": cnt, "codes": list(TIER_HS),
            "series": series,
            "disclaimer": TIER_DISCLAIMER, "scope_note": TIER_SCOPE_NOTE}


def update_italy_trade():
    """빠진 월만 채워 저장하고 payload 를 돌려준다."""
    store = _load()
    have = {}
    for m in store["months"]:
        if not isinstance(m, dict) or not m.get("month"):
            continue
        # 중량(expw/impw)이 없는 구버전 레코드는 다시 받는다(단가 계산에 필요).
        if "expw" not in m and "impw" not in m:
            continue
        have[m["month"]] = m
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
        "weight_unit": "kg",
        "unit_price_unit": "USD/kg",
        "codes": [{"code": c, "label": l} for c, l in HS_CODES],
        "read_note": READ_NOTE,
        "months": months,
        "latest": months[-1]["month"] if months else None,
        "target_end": end,
        "pending": max(0, len(missing) - MAX_NEW),
        "unit_prices": _unit_prices(months),
        "tier": _tier_block(months),
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
