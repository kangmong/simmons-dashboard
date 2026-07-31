# -*- coding: utf-8 -*-
"""ICIS 스폰지 주원료(PPG/TDI/MDI/PO) '다음 달' 가격 예측 — 순수 추가 모듈(add-only).

설계: 숫자는 코드가 계산(선형추세 + 모멘텀 + 평균회귀), 해석 문장만 Anthropic API가 작성.
      LLM에 수치 외삽을 맡기지 않는다. 계산·AI 호출 모두 서버 사이드(Python).

★ 기존 코드/데이터는 전혀 건드리지 않는다. 프론트 app.js 의 ICIS_DATA 를 여기 복제(중복 허용).
"""
import os
import re
import json
import math
import statistics
import datetime

import requests

# ── app.js ICIS_DATA 복제(add-only). 기존 프론트 상수는 그대로 두고 여기서만 사용 ──
ICIS_FC_PERIODS = [
    "2021-01", "2021-02", "2021-03", "2021-04", "2021-05", "2021-06", "2021-07", "2021-08",
    "2021-09", "2021-10", "2021-11", "2021-12", "2022-01", "2022-02", "2022-03", "2022-04",
    "2022-05", "2022-06", "2022-07", "2022-08", "2022-09", "2022-10", "2022-11", "2022-12",
    "2023-01", "2023-02", "2023-03", "2023-04", "2023-05", "2023-06", "2023-07", "2023-08",
    "2023-09", "2023-10", "2023-11", "2023-12", "2024-01", "2024-02", "2024-03", "2024-04",
    "2024-05", "2024-06", "2024-07", "2024-08", "2024-09", "2024-10", "2024-11", "2024-12",
    "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08",
    "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
    "2026-05", "2026-06",
]
ICIS_FC = {
    "PPG": [2600, 2600, 2650, 2550, 2800, 2600, 2300, 2450, 2450, 2350, 2550, 2300, 2300, 1900,
            2000, 2000, 1850, 1850, 1825, 1300, 1350, 1600, 1750, 1400, 1180, 1500, 1600, 1600,
            1550, 1395, 1450, 1435, 1435, 1450, 1350, 1350, 1400, 1370, 1350, 1400, 1400, 1388,
            1350, 1320, 1296, 1299, 1295, 1266, 1261, 1250, 1250, 1182, 1150, 1156, 1160, 1194,
            1188, 1224, 1186, 1191, 1221, 1209, 1776, 2110, 1666, 1350],
    "TDI": [1900, 1950, 2800, 2700, 2500, 2080, 1900, 2050, 2150, 2300, 2450, 2450, 2450, 2600,
            2950, 3000, 2900, 2550, 2600, 2500, 2550, 2750, 3000, 2500, 2600, 2800, 2650, 2400,
            2450, 2200, 2200, 2200, 2050, 2100, 2050, 1950, 1950, 2100, 2100, 2025, 1960, 1900,
            1880, 1872, 1800, 1800, 1800, 1800, 1850, 1938, 1808, 1682, 1680, 1650, 1740, 1975,
            1825, 1800, 1700, 1810, 1825, 1888, 2500, 2890, 2563, 2238],
    "MDI": [2300, 2600, 3300, 2900, 2450, 2200, 2400, 2600, 2600, 3000, 2700, 2500, 2500, 2800,
            2800, 2700, 2650, 2400, 2200, 2050, 1950, 1950, 1850, 1600, 1750, 1850, 2000, 1900,
            1800, 1775, 1850, 1930, 1950, 1900, 1750, 1750, 1800, 2100, 2100, 2063, 2100, 2163,
            2200, 2175, 2113, 2200, 2200, 2100, 2175, 2238, 2150, 2010, 1988, 1925, 1832, 1817,
            1763, 1686, 1650, 1765, 1765, 1750, 2300, 2920, 2688, 2375],
    "PO": [2100, 2100, 2400, 2350, 2275, 1850, 1790, 2070, 2070, 2240, 2250, 2070, 1700, 1800,
           1500, 1450, 1375, 1330, 1220, 1050, 1120, 1250, 1050, 1050, 1050, 1150, 1380, 1165,
           1200, 1210, None, None, None, None, None, None, None, None, None, None, None, None,
           None, None, None, None, None, None, 965, 948, 920, 903, 915, 920, 904, 907,
           910, 925, 955, 962, 994, 1000, 1355, 1710, 1713, 1398],
}
ICIS_FC_COLORS = {"PPG": "#3B82F6", "TDI": "#12B981", "MDI": "#F59E0B", "PO": "#8B5CF6"}
ICIS_FC_CODES = ("PPG", "TDI", "MDI", "PO")


def _next_month(period):
    y, m = (int(x) for x in period.split("-"))
    m += 1
    if m > 12:
        y, m = y + 1, 1
    return "%04d-%02d" % (y, m)


def _months_between(a, b):
    """'YYYY-MM' a→b 개월 수(b가 뒤면 양수)."""
    ay, am = (int(x) for x in a.split("-"))
    by, bm = (int(x) for x in b.split("-"))
    return (by - ay) * 12 + (bm - am)


def _step_weights(step):
    """단계가 멀어질수록 추세·모멘텀↓ 평균회귀↑ (원자재는 급등 후 되돌림이 잦음)."""
    if step <= 1:
        return 0.35, 0.25, 0.40
    if step == 2:
        return 0.25, 0.15, 0.60
    return 0.15, 0.05, 0.80


def _linreg_next(points, x_next):
    """(x, y) 점들로 단순선형회귀 → x_next 예측값과 기울기 반환."""
    n = len(points)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    xb, yb = sum(xs) / n, sum(ys) / n
    denom = sum((x - xb) ** 2 for x in xs)
    if denom == 0:
        return yb, 0.0
    slope = sum((xs[i] - xb) * (ys[i] - yb) for i in range(n)) / denom
    return slope * x_next + (yb - slope * xb), slope


def _forecast_one(code, target_ym):
    """원료 1개 예측. 마지막 실측월→대상월 간격만큼 1개월 예측을 재귀로 이어붙임(다단계).
    각 단계는 기존 방식(a 추세/b 모멘텀/c 평균회귀) 유지, 단계가 멀어질수록 평균회귀 가중치↑.
    결측 규칙 위반 시 status='insufficient'."""
    vals = ICIS_FC[code]
    n = len(vals)
    last6 = vals[-6:]
    valid6 = [v for v in last6 if v is not None]
    if len(valid6) < 3:  # 최근 6개월 유효값 3개 미만 → 예측 생략
        return {"code": code, "status": "insufficient",
                "reason": "최근 6개월 유효값 %d개(<3)" % len(valid6)}
    last_valid_idx = max(i for i, v in enumerate(vals) if v is not None)
    months_behind = (n - 1) - last_valid_idx
    if months_behind >= 3:  # 마지막 유효값이 3개월 이상 지남 → 예측 생략
        return {"code": code, "status": "insufficient",
                "reason": "마지막 유효값이 %d개월 전(≥3)" % months_behind}
    last_period = ICIS_FC_PERIODS[last_valid_idx]
    last_val = vals[last_valid_idx]
    steps = max(1, _months_between(last_period, target_ym))  # 마지막 실측월→대상월 간격

    # 기본 변동성: 최근 12개월 월간 변화율 표준편차(1σ, 비율). 다단계는 √단계수로 확대
    v13 = [v for v in vals[-13:] if v is not None]
    rate12 = [(v13[i] - v13[i - 1]) / v13[i - 1] for i in range(1, len(v13)) if v13[i - 1]]
    sigma = statistics.pstdev(rate12) if len(rate12) >= 2 else 0.0
    max12 = max(v for v in vals[-12:] if v is not None)

    work = list(vals[:last_valid_idx + 1])  # 내부 결측(None) 유지
    cur = last_val
    cy, cm = (int(x) for x in last_period.split("-"))
    path, dbg = [], []
    last_slope = 0.0
    for s in range(1, steps + 1):
        cm += 1
        if cm > 12:
            cy, cm = cy + 1, 1
        step_ym = "%04d-%02d" % (cy, cm)
        # a) 선형 추세: 최근 6개월 유효점 단순선형회귀의 다음 달 외삽
        last6w = work[-6:]
        pts = [(i, last6w[i]) for i in range(len(last6w)) if last6w[i] is not None]
        if len(pts) >= 2:
            a_val, last_slope = _linreg_next(pts, len(last6w))
        else:
            a_val = cur
        # b) 모멘텀: 최근 3개월 평균 변화율을 현재 값에 적용
        vseq = [v for v in work if v is not None]
        rates = [(vseq[i] - vseq[i - 1]) / vseq[i - 1]
                 for i in range(1, len(vseq)) if vseq[i - 1]]
        last3 = rates[-3:]
        b_val = cur * (1 + (sum(last3) / len(last3) if last3 else 0.0))
        # c) 평균회귀: 최근 12개월 평균으로 θ=0.3 회귀
        last12 = [v for v in work[-12:] if v is not None]
        mean12 = (sum(last12) / len(last12)) if last12 else cur
        c_val = cur + 0.3 * (mean12 - cur)
        wa, wb, wc = _step_weights(s)
        pred = max(0.0, a_val * wa + b_val * wb + c_val * wc)  # 하한 0 clamp
        halfw = pred * sigma * math.sqrt(s)  # 누적 신뢰구간(√단계수)
        dbg.append({"step": s, "ym": step_ym, "a": round(a_val), "b": round(b_val),
                    "c": round(c_val), "w": (wa, wb, wc), "pred": round(pred),
                    "ci": (round(max(0.0, pred - halfw)), round(pred + halfw))})
        path.append({"ym": step_ym, "value": round(pred)})
        work.append(pred)
        cur = pred

    final = cur
    halfw = final * sigma * math.sqrt(steps)
    delta = final - last_val
    delta_pct = (delta / last_val * 100.0) if last_val else 0.0
    return {
        "code": code, "status": "ok",
        "predict": round(final), "prev": round(last_val), "prev_month": last_period,
        "delta": round(delta), "delta_pct": round(delta_pct, 1),
        "ci_low": round(max(0.0, final - halfw)), "ci_high": round(final + halfw),
        "steps": steps, "path": path, "max12": round(max12),
        "sigma_pct": round(sigma * 100.0, 1),
        "trend": "상승" if last_slope > 0 else ("하락" if last_slope < 0 else "보합"),
        "risk": "상방" if delta_pct > 2 else ("하방" if delta_pct < -2 else "중립"),
        "comment": "",
        "recent12": vals[-12:],
        "_dbg": dbg,
    }


def _load_api_key():
    """ANTHROPIC_API_KEY: 환경변수 → .env(수동 파싱, 의존성 없이)."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, ".env"), ".env"):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    s = line.strip()
                    if s.startswith("ANTHROPIC_API_KEY"):
                        return s.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            pass
    return None


def _ai_interpret(target_month, months_ahead, last_data_month, mats):
    """Anthropic API로 해석 문장만 생성. 실패 시 None(→ 통계값만 표시)."""
    key = _load_api_key()
    if not key:
        print("[icis_forecast] ANTHROPIC_API_KEY 없음 → AI 해석 생략(통계 예측값만 표시)")
        return None
    ok = [m for m in mats if m["status"] == "ok"]
    if not ok:
        return None
    lines = ["%s: 최근12개월=%s, 예측=%d(신뢰구간 %d~%d, %d단계), 추세=%s, 변동성σ=%.1f%%"
             % (m["code"], m["recent12"], m["predict"], m["ci_low"], m["ci_high"],
                m["steps"], m["trend"], m["sigma_pct"]) for m in ok]
    prompt = (
        "너는 폴리우레탄 원료(스폰지 주원료) 가격 애널리스트다. 아래는 코드가 통계로 계산한 "
        "%s 예측이다(최신 실측 %s 기준 %d개월 후). 이 수치를 해석하는 짧은 문장만 작성하라.\n\n%s\n\n"
        "제약:\n"
        "- 제시된 수치 외의 숫자를 만들어내지 말 것.\n"
        "- 외부 뉴스·시장 이벤트를 아는 척하지 말 것.\n"
        "- 단정하지 말고 '~할 전망' 같은 추정 어조.\n"
        "- 한국어.\n\n"
        "아래 JSON 형식만 출력(코드펜스·설명 없이 JSON only):\n"
        '{"summary":"4개 원료 전반 흐름 2~3문장",'
        '"materials":[{"code":"PPG","comment":"흐름과 예측 근거 1~2문장","risk":"상방|하방|중립"}],'
        '"caution":"예측의 한계 1문장"}'
    ) % (target_month, last_data_month, months_ahead, "\n".join(lines))
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": "claude-sonnet-4-6", "max_tokens": 1024,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=30)
        r.raise_for_status()
        text = "".join(b.get("text", "") for b in r.json().get("content", [])
                       if b.get("type") == "text").strip()
        print("[icis_forecast] AI 응답 원문:\n%s" % text)
        cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.I | re.M).strip()
        data = json.loads(cleaned)
        print("[icis_forecast] AI 파싱 성공")
        return data
    except Exception as e:  # noqa: BLE001 — AI 실패가 카드를 깨뜨리면 안 됨
        print("[icis_forecast] AI 실패(%s) → 통계 예측값만 표시" % e)
        return None


def compute_icis_forecast():
    """FETCHERS용 진입점. '실행 시점의 다음 달'을 예측(달력 기준, 하드코딩 없음) + AI 해석."""
    today = datetime.date.today()
    ty, tm = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
    target = "%04d-%02d" % (ty, tm)  # 실행 시점 시스템 날짜의 다음 달
    last_data = ICIS_FC_PERIODS[-1]
    months_ahead = max(1, _months_between(last_data, target))
    print("[icis_forecast] 실행일 %s → 예측 대상 %s | 마지막 실측 %s | %d개월 후(다단계 %d단계)"
          % (today.isoformat(), target, last_data, months_ahead, months_ahead))
    mats = [_forecast_one(c, target) for c in ICIS_FC_CODES]
    for m in mats:
        if m["status"] == "ok":
            for d in m["_dbg"]:
                print("[icis_forecast]   %s %d단계 %s | a=%d b=%d c=%d w=%.2f/%.2f/%.2f → %d (CI %d~%d)"
                      % (m["code"], d["step"], d["ym"], d["a"], d["b"], d["c"],
                         d["w"][0], d["w"][1], d["w"][2], d["pred"], d["ci"][0], d["ci"][1]))
            flag = "  ⚠최근12개월 최고치 초과!" if m["predict"] > m["max12"] else ""
            print("[icis_forecast] %s  최종=%d (직전 %s 실측 %d, Δ%+d %.1f%%)  CI %d~%d  12M최고 %d%s"
                  % (m["code"], m["predict"], m["prev_month"], m["prev"], m["delta"],
                     m["delta_pct"], m["ci_low"], m["ci_high"], m["max12"], flag))
        else:
            print("[icis_forecast] %s  예측 생략 — %s" % (m["code"], m["reason"]))

    ai = _ai_interpret(target, months_ahead, last_data, mats)
    summary, caution, ai_ok = "", "", False
    if ai:
        ai_ok = True
        summary = ai.get("summary", "") or ""
        caution = ai.get("caution", "") or ""
        by_code = {x.get("code"): x for x in (ai.get("materials") or []) if isinstance(x, dict)}
        for m in mats:
            a = by_code.get(m["code"])
            if a:
                m["comment"] = a.get("comment", "") or ""
                if a.get("risk") in ("상방", "하방", "중립"):
                    m["risk"] = a["risk"]

    for m in mats:  # 색상 부여 + 내부 필드 제거
        m["color"] = ICIS_FC_COLORS.get(m["code"])
        m.pop("recent12", None)
        m.pop("_dbg", None)

    return {
        "status": "ok",
        "target_month": target,
        "last_data_month": last_data,
        "months_ahead": months_ahead,
        "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "materials": mats,
        "summary": summary,
        "caution": caution,
        "ai_ok": ai_ok,
    }


if __name__ == "__main__":  # 단독 실행 검증용
    print(json.dumps(compute_icis_forecast(), ensure_ascii=False, indent=2))
