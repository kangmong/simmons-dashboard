# -*- coding: utf-8 -*-
"""국제유가(PETRONET, 휘발유95RON·경유0.05%·나프타) '다음 달' 예측 — 순수 추가 모듈(add-only).

설계: 숫자는 코드가 계산(추세 + 모멘텀 + 평균회귀), 해석 문장만 Anthropic API가 작성.
★ 이 지표는 계절성이 없다(급락·폭락·급등은 지정학·수요충격). 계절성 항을 넣지 않고
  평균회귀 가중치를 가장 높게 둬 최근 급등 구간의 비현실적 외삽을 억제한다.
★ 주원료(icis_forecast)·정시성(sr_forecast) 예측과 공통화하지 않고 별도 작성(중복 허용).
★ 기존 update_oil_prices / 차트 등은 전혀 건드리지 않는다(PETRONET 파싱을 여기 복제).
"""
import os
import re
import json
import math
import statistics
import datetime

import requests

OILF_GET_URL = "https://www.petronet.co.kr/v4/excel/KDFQ0200_x2.jsp"
OILF_POST_URL = "https://www.petronet.co.kr/v4/sub.jsp"
# (코드, 응답키, 라벨, 색상[프론트 OIL_COLORS와 동일])
OILF_PRODS = [
    ("B001", "gasoline95", "휘발유(95RON)", "#C8102E"),
    ("D008", "diesel005", "경유(0.05%)", "#12B981"),
    ("F001", "naphtha", "나프타", "#3B82F6"),
]


def _oilf_num(cell):
    v = re.sub(r"<[^>]+>", "", cell).replace("&nbsp;", " ").strip()
    try:
        return round(float(v), 2)
    except ValueError:
        return None


def _oilf_parse(text):
    """월별 제품가 HTML 표 → rows[{period, gasoline95, diesel005, naphtha}] (update_oil_prices 복제)."""
    n_prod = len(OILF_PRODS)
    rows = []
    year, prev_m = None, None
    for tr in re.findall(r"<tr.*?>(.*?)</tr>", text, re.S | re.I):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
        if len(cells) < 1 + n_prod:
            continue
        first = re.sub(r"<[^>]+>", "", cells[0]).replace("&nbsp;", " ").strip()
        mfull = re.match(r"^\s*(\d{2})\s*년\s*(\d{1,2})\s*월", first)
        mmon = re.match(r"^\s*(\d{1,2})\s*월\s*$", first)
        if mfull:
            year = 2000 + int(mfull.group(1))
            mo = int(mfull.group(2))
        elif mmon:
            mo = int(mmon.group(1))
            if year is None:
                year = 2011
            elif prev_m is not None and mo < prev_m:
                year += 1
        else:
            continue
        prev_m = mo
        vals = [_oilf_num(c) for c in cells[1:1 + n_prod]]
        row = {"period": "%04d-%02d" % (year, mo)}
        for (_, key, _, _), v in zip(OILF_PRODS, vals):
            row[key] = v
        rows.append(row)
    return rows


def _oilf_fetch():
    """PETRONET 월별 제품가 rows. GET→POST 폴백(update_oil_prices와 동일 로직 복제). 실패 시 []."""
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")
    ref = "https://www.petronet.co.kr/v4/sub.jsp"
    prods = [p[0] for p in OILF_PRODS]
    try:
        today = datetime.date.today()
        todate = "%04d%02d" % (today.year, today.month)
        rows = []
        try:
            qs = {"term": "m", "by": "2011", "bq": "3", "bm": "07", "bw": "1", "bd": "16",
                  "ay": str(today.year), "aq": str((today.month - 1) // 3 + 1),
                  "am": "%02d" % today.month, "aw": "1", "ad": "%02d" % today.day,
                  "ProdCDList": ",".join(prods)}
            g = requests.get(OILF_GET_URL, params=qs,
                             headers={"User-Agent": ua, "Referer": ref}, timeout=30)
            gt = g.content.decode("utf-8", "replace")
            if g.status_code == 200 and "<tr" in gt.lower():
                rows = _oilf_parse(gt)
        except requests.exceptions.RequestException:
            rows = []
        if not rows:
            inner = "\\,".join("\\'%s\\'" % c for c in prods)
            param = ":T='M',:FromDate='201107',:ToDate='%s',:ProdCD='%s '" % (todate, inner)
            data = [("fmuId", "KDFQSTAT"), ("smuId", "KDFQ01"), ("tmuId", "KDFQ0200"),
                    ("fmuOrd", "03"), ("smuOrd", "03_01"), ("tmuOrd", "03_01_02"),
                    ("Parameter", param), ("ProdCDList", ",".join(prods)),
                    ("firstFlag", "T"), ("term", "m"),
                    ("by", "2011"), ("bq", "3"), ("bm", "07"), ("bw", "1"), ("bd", "16"),
                    ("ay", str(today.year)), ("aq", str((today.month - 1) // 3 + 1)),
                    ("am", "%02d" % today.month), ("aw", "1"), ("ad", "%02d" % today.day)]
            data += [("ProdCd", p) for p in prods]
            pr = requests.post(OILF_POST_URL, data=data, timeout=40,
                               headers={"User-Agent": ua, "Referer": ref,
                                        "Content-Type": "application/x-www-form-urlencoded"})
            pr.raise_for_status()
            txt = pr.content.decode("utf-8", "replace")
            if txt.count("�") > 10:
                txt = pr.content.decode("euc-kr", "replace")
            rows = _oilf_parse(txt)
        return rows
    except Exception:  # noqa: BLE001
        return []


def _linreg_next(points, x_next):
    n = len(points)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    xb, yb = sum(xs) / n, sum(ys) / n
    den = sum((x - xb) ** 2 for x in xs)
    if den == 0:
        return yb
    slope = sum((xs[i] - xb) * (ys[i] - yb) for i in range(n)) / den
    return slope * x_next + (yb - slope * xb), slope


def _months_between(p_from, p_to):
    fy, fm = (int(x) for x in p_from.split("-"))
    ty, tm = (int(x) for x in p_to.split("-"))
    return (ty - fy) * 12 + (tm - fm)


def _forecast_product(rows, key, target_ym):
    """제품 1개 다단계 예측(계절성 없음: 추세0.35 + 모멘텀0.25 + 평균회귀0.40, 하한 0)."""
    series = [(r["period"], r.get(key)) for r in rows]
    last_idx = next((i for i in range(len(series) - 1, -1, -1) if series[i][1] is not None), None)
    if last_idx is None:
        return {"code": key, "status": "insufficient", "reason": "유효값 없음"}
    lp, lv = series[last_idx]
    recent3 = [series[i][1] for i in range(max(0, last_idx - 2), last_idx + 1)]
    if len([v for v in recent3 if v is not None]) < 2:
        return {"code": key, "status": "insufficient", "reason": "최근 3개월 유효값 <2"}

    steps = max(1, _months_between(lp, target_ym))
    work = [v for (_, v) in series[:last_idx + 1]]  # 값(Nones 포함)
    # 기본 σ: 최근 12개월 '월간 변화율' 표준편차(비율)
    vseq0 = [v for v in work if v is not None]
    rates0 = [(vseq0[i] - vseq0[i - 1]) / vseq0[i - 1] for i in range(1, len(vseq0)) if vseq0[i - 1]]
    sigma_rate = statistics.pstdev(rates0[-12:]) if len(rates0[-12:]) >= 2 else 0.0

    cur, path, dbg = lv, [], []
    cy, cm = (int(x) for x in lp.split("-"))
    for s in range(1, steps + 1):
        cm += 1
        if cm > 12:
            cy, cm = cy + 1, 1
        # a) 추세: 최근 6개 유효점 회귀
        last6 = work[-6:]
        pts = [(k, last6[k]) for k in range(len(last6)) if last6[k] is not None]
        a, slope = _linreg_next(pts, len(last6)) if len(pts) >= 2 else (cur, 0.0)
        # b) 모멘텀: 최근 3개월 평균 변화율 적용
        vseq = [v for v in work if v is not None]
        rates = [(vseq[i] - vseq[i - 1]) / vseq[i - 1] for i in range(1, len(vseq)) if vseq[i - 1]]
        b = cur * (1 + (sum(rates[-3:]) / len(rates[-3:]) if rates[-3:] else 0.0))
        # c) 평균회귀: 최근 12개월 평균 대비 현재 위치 보정(θ=0.5, 급등 되돌림 반영)
        last12 = [v for v in work[-12:] if v is not None]
        mean12 = sum(last12) / len(last12) if last12 else cur
        c = cur + 0.5 * (mean12 - cur)
        pred = max(0.0, a * 0.35 + b * 0.25 + c * 0.40)  # 하한 clamp
        dbg.append((s, "%04d-%02d" % (cy, cm), cur, a, b, c, mean12, pred))
        path.append({"m": "%04d-%02d" % (cy, cm), "label": "%d월" % cm, "v": round(pred, 1)})
        work.append(pred)
        cur = pred

    final = round(cur, 1)
    halfw = final * sigma_rate * math.sqrt(steps)  # ±1σ, 다단계면 √단계 배
    ci_low = round(max(0.0, final - halfw), 1)
    ci_high = round(final + halfw, 1)
    delta = round(final - lv, 1)
    delta_pct = round((delta / lv * 100.0) if lv else 0.0, 1)
    risk = "상방" if delta_pct > 2 else ("하방" if delta_pct < -2 else "중립")
    last12v = [v for v in work[:last_idx + 1] if v is not None][-12:]
    return {
        "code": key, "status": "ok",
        "predict": final, "prev": round(lv, 1), "prev_month": lp,
        "delta": delta, "delta_pct": delta_pct,
        "ci_low": ci_low, "ci_high": ci_high, "steps": steps,
        "sigma_pct": round(sigma_rate * 100.0, 1),
        "trend": "상승" if slope > 0 else ("하락" if slope < 0 else "보합"),
        "mean12": round(sum(last12v) / len(last12v), 1) if last12v else final,
        "path": path, "risk": risk, "comment": "",
        "_dbg": dbg, "_recent12": last12v,
    }


def _avg_spread(rows, k1, k2):
    """최근 12개월 (k1 - k2) 평균 스프레드."""
    diffs = [r[k1] - r[k2] for r in rows[-12:] if r.get(k1) is not None and r.get(k2) is not None]
    return (sum(diffs) / len(diffs)) if diffs else None


def _oilf_key():
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


def _oilf_ai(target_month, mats, spread_txt):
    key = _oilf_key()
    if not key:
        print("[oil_forecast] ANTHROPIC_API_KEY 없음 → AI 해석 생략(통계 예측값만 표시)")
        return None
    ok = [m for m in mats if m["status"] == "ok"]
    if not ok:
        return None
    label = {p[1]: p[2] for p in OILF_PRODS}
    lines = ["%s(%s): 최근12개월=%s, 예측=%.1f(신뢰 %.1f~%.1f), 추세=%s, 변동성σ=%.1f%%"
             % (m["code"], label.get(m["code"], ""), m["_recent12"], m["predict"],
                m["ci_low"], m["ci_high"], m["trend"], m["sigma_pct"]) for m in ok]
    prompt = (
        "너는 국제 석유제품 가격 애널리스트다. 아래는 코드가 통계로 계산한 %s 다음 달 예측이다"
        "(USD/배럴). 이 수치를 해석하는 짧은 문장만 작성하라.\n\n%s\n제품 간 스프레드: %s\n\n"
        "제약:\n- 제시된 수치 외의 숫자를 만들어내지 말 것.\n"
        "- OPEC 결정·지정학 분쟁·재고 통계 등 외부 이벤트를 아는 척하지 말 것(유가는 뉴스 민감 지표라 아는 척하면 오답).\n"
        "- 단정하지 말고 '~할 전망' 같은 추정 어조.\n- 한국어.\n\n"
        "JSON only(코드펜스 없이):\n"
        '{"summary":"3개 제품 전반 흐름과 다음 달 전망 2~3문장",'
        '"products":[{"code":"gasoline95","comment":"흐름과 근거 1~2문장","risk":"상방|하방|중립"}],'
        '"spread":"제품 간 가격차 코멘트 1문장","caution":"예측의 한계 1문장"}'
    ) % (target_month, "\n".join(lines), spread_txt)
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
        print("[oil_forecast] AI 응답 원문:\n%s" % text)
        cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.I | re.M).strip()
        data = json.loads(cleaned)
        print("[oil_forecast] AI 파싱 성공")
        return data
    except Exception as e:  # noqa: BLE001
        print("[oil_forecast] AI 실패(%s) → 통계 예측값만 표시" % e)
        return None


def compute_oil_forecast():
    """FETCHERS용 진입점. 현재 날짜 다음 달까지 다단계 예측 + 제품 정합성 경고 + AI 해석."""
    rows = _oilf_fetch()
    if not rows:
        print("[oil_forecast] 유가 데이터 로드 실패 → 예측 섹션 표시 안 함")
        return {"status": "error", "reason": "유가 데이터 없음"}

    last_data_month = rows[-1]["period"]
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    today = datetime.date.today()
    ty, tm = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)  # 다음 달
    target_month = "%04d-%02d" % (ty, tm)
    months_ahead = max(1, _months_between(last_data_month, target_month))
    print("[oil_forecast] 최신 데이터 %s, 현재 %s → 대상 월 %s (%d개월 후)"
          % (last_data_month, today.strftime("%Y-%m"), target_month, months_ahead))

    mats = [_forecast_product(rows, key, target_month) for _, key, _, _ in OILF_PRODS]
    meta = {p[1]: (p[2], p[3]) for p in OILF_PRODS}
    for m in mats:
        lbl, color = meta.get(m["code"], ("", "#64748B"))
        m["label"], m["color"] = lbl, color
        if m["status"] == "ok":
            for (s, mm, cur, a, b, c, mean12, pred) in m.pop("_dbg", []):
                print("[oil_forecast]  %s %d단계 %s | 입력=%.1f | a=%.1f b=%.1f c=%.1f(평균회귀→12M평균 %.1f) → %.1f"
                      % (m["code"], s, mm, cur, a, b, c, mean12, pred))
            print("[oil_forecast] %s(%s) 최종=%.1f (직전 %s %.1f, Δ%+.1f %.1f%%) | 12M평균 %.1f | CI %.1f~%.1f(σ%.1f%%×√%d)"
                  % (m["code"], m["label"], m["predict"], m["prev_month"], m["prev"], m["delta"],
                     m["delta_pct"], m["mean12"], m["ci_low"], m["ci_high"], m["sigma_pct"], m["steps"]))
        else:
            print("[oil_forecast] %s 예측 생략 — %s" % (m["code"], m.get("reason")))
        m.pop("_recent12", None)
        m.pop("_dbg", None)

    # ── 제품 정합성 검증(경고만, 자동 보정 없음) ──
    warnings = []
    pv = {m["code"]: m["predict"] for m in mats if m["status"] == "ok"}
    if all(k in pv for k in ("gasoline95", "diesel005", "naphtha")):
        g, d, n = pv["gasoline95"], pv["diesel005"], pv["naphtha"]
        # 통상 순서: 경유 ≥ 휘발유 > 나프타
        if not (d >= g > n):
            w = "예상 순서(경유≥휘발유>나프타) 벗어남: 경유 %.1f / 휘발유 %.1f / 나프타 %.1f" % (d, g, n)
            warnings.append(w)
            print("[oil_forecast] ⚠ %s" % w)
        for (k1, k2, nm) in (("diesel005", "gasoline95", "경유-휘발유"),
                             ("gasoline95", "naphtha", "휘발유-나프타"),
                             ("diesel005", "naphtha", "경유-나프타")):
            avg = _avg_spread(rows, k1, k2)
            cur_sp = pv[k1] - pv[k2]
            if avg is not None and abs(avg) > 1e-6 and abs(cur_sp - avg) > 0.5 * abs(avg):
                w = "%s 스프레드 예측 %.1f 이 과거12M평균 %.1f 대비 ±50%% 벗어남" % (nm, cur_sp, avg)
                warnings.append(w)
                print("[oil_forecast] ⚠ %s" % w)
        if not warnings:
            print("[oil_forecast] 제품 정합성 OK (순서·스프레드 정상 범위)")

    spread_txt = " / ".join(
        "%s-%s 예측 %.1f(과거평균 %s)" % (
            nm, "", pv[k1] - pv[k2],
            ("%.1f" % _avg_spread(rows, k1, k2)) if _avg_spread(rows, k1, k2) is not None else "N/A")
        for (k1, k2, nm) in (("diesel005", "gasoline95", "경유-휘발유"),
                             ("gasoline95", "naphtha", "휘발유-나프타"))
        if all(k in pv for k in (k1, k2))) or "N/A"

    ai = _oilf_ai(target_month, mats, spread_txt)
    summary = spread = caution = ""
    ai_ok = False
    if ai:
        ai_ok = True
        summary = ai.get("summary", "") or ""
        spread = ai.get("spread", "") or ""
        caution = ai.get("caution", "") or ""
        by_code = {x.get("code"): x for x in (ai.get("products") or []) if isinstance(x, dict)}
        for m in mats:
            a = by_code.get(m["code"])
            if a:
                m["comment"] = a.get("comment", "") or ""
                if a.get("risk") in ("상방", "하방", "중립"):
                    m["risk"] = a["risk"]

    return {
        "status": "ok", "target_month": target_month, "last_data_month": last_data_month,
        "months_ahead": months_ahead, "generated_at": now, "unit": "USD/배럴",
        "products": mats, "spread_warnings": warnings,
        "summary": summary, "spread": spread, "caution": caution, "ai_ok": ai_ok,
    }


if __name__ == "__main__":
    print(json.dumps(compute_oil_forecast(), ensure_ascii=False, indent=2))
