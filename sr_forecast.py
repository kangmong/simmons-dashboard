# -*- coding: utf-8 -*-
"""해상 정시성(Global Schedule Reliability) '다음 달' 예측 — 순수 추가 모듈(add-only).

설계: 숫자는 코드가 계산(추세 + 모멘텀 + 계절성), 해석 문장만 Anthropic API가 작성.
계절성이 뚜렷한 지표라 계절성 가중치를 가장 높게 둔다. 백분율이라 0~100%로 clamp.

★ 스폰지 예측(icis_forecast.py)과 공통화하지 않고 별도로 작성(중복 허용).
★ 기존 코드/데이터(update_schedule_reliability, 차트 등)는 전혀 건드리지 않는다.
"""
import os
import re
import json
import statistics
import datetime

import requests

SRF_XLSX_URL = ("https://www.sea-intelligence.com/images/press_docs/GLP-May2026/"
                "20260527_-_Sea-Intelligence_GLP_Press_Release_-_May_2026.xlsx")
SRF_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _srf_fetch():
    """Sea-Intelligence xlsx 'Fig 1' 파싱 → years {year:[12 %|None]}. 실패 시 None.
       (기존 update_schedule_reliability 와 동일 로직을 여기 복제 — 공유하지 않음)."""
    hdr = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"}
    try:
        import io
        import openpyxl
        r = requests.get(SRF_XLSX_URL, headers=hdr, allow_redirects=True, timeout=15)
        r.raise_for_status()
        if r.content[:2] != b"PK":
            return None
        wb = openpyxl.load_workbook(io.BytesIO(r.content), data_only=True, read_only=True)
        if "Fig 1" not in wb.sheetnames:
            return None
        ws = wb["Fig 1"]
        header = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]
        month_cols = [i for i, v in enumerate(header)
                      if isinstance(v, str) and v.strip()[:3] in SRF_MONTHS]
        if len(month_cols) < 12:
            month_cols = list(range(1, 13))
        years = {}
        for row in ws.iter_rows(min_row=2):
            cells = [c.value for c in row]
            if not cells:
                continue
            try:
                yi = int(cells[0])
            except (TypeError, ValueError):
                continue
            if not (2000 <= yi <= 2100):
                continue
            vals = []
            for ci in month_cols:
                v = cells[ci] if ci < len(cells) else None
                if isinstance(v, (int, float)):
                    vals.append(round(v * 100.0 if v <= 1.5 else float(v), 1))
                else:
                    vals.append(None)
            years[str(yi)] = vals
        return years or None
    except Exception:  # noqa: BLE001
        return None


def _linreg_next(points, x_next):
    """(x, y) 점들로 단순선형회귀 → x_next 예측값."""
    n = len(points)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    xb, yb = sum(xs) / n, sum(ys) / n
    den = sum((x - xb) ** 2 for x in xs)
    if den == 0:
        return yb
    slope = sum((xs[i] - xb) * (ys[i] - yb) for i in range(n)) / den
    return slope * x_next + (yb - slope * xb)


def _srf_load_key():
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


def _srf_ai(target_month, recent12, samemonth_hist, o):
    """Anthropic API로 해석 문장만 생성. 실패 시 None(→ 통계값만 표시)."""
    key = _srf_load_key()
    if not key:
        print("[sr_forecast] ANTHROPIC_API_KEY 없음 → AI 해석 생략(통계 예측값만 표시)")
        return None
    hist = ", ".join("%d년 %.1f%%" % (y, v) for y, v in samemonth_hist) or "없음"
    prompt = (
        "너는 글로벌 해상 정시성(정시 도착 비율) 애널리스트다. 아래는 코드가 통계로 계산한 "
        "%s 다음 달 예측이다. 이 수치를 해석하는 짧은 문장만 작성하라.\n\n"
        "최근 12개월 실제 정시성(%%): %s\n"
        "예측 대상월(%s)의 과거 연도 동월 값: %s\n"
        "예측=%.1f%% (신뢰구간 %.1f~%.1f), 계절성 변화폭(직전월→대상월 과거평균)=%+.2f%%p, "
        "직전월 대비=%+.1f%%p, 전년 동월 대비=%s\n\n"
        "제약:\n"
        "- 제시된 수치 외의 숫자를 만들어내지 말 것.\n"
        "- 특정 선사·항만·파업·지정학 이벤트를 아는 척하지 말 것(학습 시점이 오래됐고 해운은 외부 충격에 크게 좌우됨).\n"
        "- 단정하지 말고 '~할 전망' 같은 추정 어조.\n"
        "- 한국어.\n\n"
        "아래 JSON만 출력(코드펜스·설명 없이 JSON only):\n"
        '{"summary":"현재 정시성 수준과 다음 달 전망 2~3문장",'
        '"seasonal":"계절 패턴상 이 시기의 일반적 흐름 1~2문장",'
        '"yoy":"전년 동월 대비 평가 1문장","risk":"상방|하방|중립","caution":"예측의 한계 1문장"}'
    ) % (target_month, recent12, target_month, hist, o["predict"], o["ci_low"], o["ci_high"],
         o["seasonal_delta"], o["delta_pp"],
         ("%+.1f%%p" % o["yoy_pp"] if o["yoy_pp"] is not None else "데이터 없음"))
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
        print("[sr_forecast] AI 응답 원문:\n%s" % text)
        cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.I | re.M).strip()
        data = json.loads(cleaned)
        print("[sr_forecast] AI 파싱 성공")
        return data
    except Exception as e:  # noqa: BLE001
        print("[sr_forecast] AI 실패(%s) → 통계 예측값만 표시" % e)
        return None


def compute_sr_forecast():
    """FETCHERS용 진입점. 다음 달 정시성 예측(통계) + AI 해석. 데이터 실패 시 status=error(섹션 숨김)."""
    years = _srf_fetch()
    if not years:
        print("[sr_forecast] 정시성 데이터 로드 실패 → 예측 섹션 표시 안 함")
        return {"status": "error", "reason": "정시성 데이터 없음"}

    yrs = sorted(years.keys())
    flat = [(int(y), m, years[y][m]) for y in yrs for m in range(12)]  # (year, monthIdx, value)
    last_pos = next((i for i in range(len(flat) - 1, -1, -1) if flat[i][2] is not None), None)
    if last_pos is None:
        return {"status": "error", "reason": "유효 정시성 값 없음"}
    ly, lm, lv = flat[last_pos]
    ty, tmidx = (ly + 1, 0) if lm == 11 else (ly, lm + 1)  # 대상 월 = 다음 달(자동 판별)
    target_month = "%04d-%02d" % (ty, tmidx + 1)
    prev_month = "%04d-%02d" % (ly, lm + 1)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print("[sr_forecast] 마지막 유효 월 %s(%.1f%%) → 예측 대상 월 %s (자동 판별)" % (prev_month, lv, target_month))

    # 결측: 최근 3개월(대상 직전 3슬롯) 유효값 2개 미만이면 예측 생략
    recent3 = [flat[i][2] for i in range(max(0, last_pos - 2), last_pos + 1)]
    valid3 = [v for v in recent3 if v is not None]
    if len(valid3) < 2:
        print("[sr_forecast] 최근 3개월 유효값 %d개(<2) → 데이터 부족" % len(valid3))
        return {"status": "ok", "forecast_status": "insufficient",
                "reason": "최근 3개월 유효값 %d개(<2)" % len(valid3),
                "target_month": target_month, "generated_at": now}

    # a) 추세: 최근 6개월 선형회귀 → 다음 달 외삽
    win6 = flat[max(0, last_pos - 5):last_pos + 1]
    pts = [(k, win6[k][2]) for k in range(len(win6)) if win6[k][2] is not None]
    a = _linreg_next(pts, len(win6)) if len(pts) >= 2 else lv

    # b) 모멘텀: 최근 3개월 평균 '변화폭'(%p diff)을 마지막 값에 적용
    seq = [v for (_, _, v) in flat[:last_pos + 1] if v is not None]
    diffs = [seq[i] - seq[i - 1] for i in range(1, len(seq))]
    last3d = diffs[-3:]
    b = lv + (sum(last3d) / len(last3d) if last3d else 0.0)

    # c) 계절성: 과거 연도들의 (직전월→대상월) 변화폭 평균을 현재값에 적용
    seasonal = [flat[i][2] - flat[i - 1][2]
                for i in range(1, len(flat))
                if flat[i][1] == tmidx and flat[i - 1][1] == lm
                and flat[i][2] is not None and flat[i - 1][2] is not None and flat[i][0] < ty]
    seas_delta = sum(seasonal) / len(seasonal) if seasonal else 0.0
    c = lv + seas_delta

    final = max(0.0, min(100.0, a * 0.3 + b * 0.3 + c * 0.4))  # 계절성 가중 최대, 0~100 clamp
    sigma = statistics.pstdev(seasonal) if len(seasonal) >= 2 else 0.0
    ci_low = max(0.0, final - sigma)
    ci_high = min(100.0, final + sigma)  # 상한 100% clamp

    delta_pp = final - lv
    yoy_prev = years[str(ty - 1)][tmidx] if str(ty - 1) in years else None
    yoy_pp = (final - yoy_prev) if yoy_prev is not None else None
    risk = "상방" if delta_pp > 1 else ("하방" if delta_pp < -1 else "중립")

    print("[sr_forecast] a=%.1f b=%.1f c=%.1f (계절Δ%+.2f%%p, 표본 %d) → 최종=%.1f%% (직전 %.1f, Δ%+.1f%%p)  CI %.1f~%.1f  σ=%.2f"
          % (a, b, c, seas_delta, len(seasonal), final, lv, delta_pp, ci_low, ci_high, sigma))
    if yoy_pp is not None:
        print("[sr_forecast] 전년 동월(%s) %.1f%% 대비 %+.1f%%p" % (SRF_MONTHS[tmidx], yoy_prev, yoy_pp))

    recent12 = [v for (_, _, v) in flat[max(0, last_pos - 11):last_pos + 1]]
    samemonth_hist = [(int(y), years[y][tmidx]) for y in yrs
                      if years[y][tmidx] is not None and int(y) < ty]

    out = {
        "status": "ok", "forecast_status": "ok",
        "target_month": target_month, "prev_month": prev_month, "generated_at": now,
        "predict": round(final, 1), "prev": round(lv, 1),
        "delta_pp": round(delta_pp, 1),
        "yoy_pp": (round(yoy_pp, 1) if yoy_pp is not None else None),
        "yoy_prev": (round(yoy_prev, 1) if yoy_prev is not None else None),
        "ci_low": round(ci_low, 1), "ci_high": round(ci_high, 1),
        "seasonal_delta": round(seas_delta, 2), "seasonal_n": len(seasonal),
        "a": round(a, 1), "b": round(b, 1), "c": round(c, 1),
        "risk": risk,
        "summary": "", "seasonal_txt": "", "yoy_txt": "", "caution": "", "ai_ok": False,
    }
    ai = _srf_ai(target_month, recent12, samemonth_hist, out)
    if ai:
        out["ai_ok"] = True
        out["summary"] = ai.get("summary", "") or ""
        out["seasonal_txt"] = ai.get("seasonal", "") or ""
        out["yoy_txt"] = ai.get("yoy", "") or ""
        out["caution"] = ai.get("caution", "") or ""
        if ai.get("risk") in ("상방", "하방", "중립"):
            out["risk"] = ai["risk"]
    return out


if __name__ == "__main__":
    print(json.dumps(compute_sr_forecast(), ensure_ascii=False, indent=2))
