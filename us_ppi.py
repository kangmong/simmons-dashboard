# -*- coding: utf-8 -*-
"""미국 매트리스 제조업 PPI — BLS 공개 API v1 (API 키 불필요 · 무료).

    시리즈  PCU337910337910  "PPI industry data for Mattress mfg, not seasonally adjusted"
    기준월  1983년 6월 = 100   (data.bls.gov 시리즈 페이지의 Base Date = 198306 실측 확인)
    출처    미국 노동통계국(BLS) https://www.bls.gov/developers/

★ 단일 지표다. 하이엔드·프리미엄 같은 가격대 구분을 만들지 않는다.
  이 시리즈는 스프링·폼·에어 등 미국 내 전 매트리스를 하나로 평균한 값이고,
  BLS 는 NAICS 337910 아래에 가격대별 하위 시리즈를 발표하지 않는다.
  (과거 화면의 '하이엔드/프리미엄' 버튼은 HS 코드 = 소재 구분이었고 가격대가
   아니었다. 근거 없는 구분이라 걷어냈다.)

★ v1 API 의 실측 제약(2026-08, 실제 호출로 확인):
  · 한 요청에 **10년까지만** — 2016~2026 을 한 번에 넣으면 응답에
    "Year range has been reduced to the system-allowed limit of 10 years." 가
    붙고 뒤쪽 연도가 잘린다. 그래서 10년 단위로 쪼개 두 번 호출한다.
  · 일 25회 제한 — 하루 1회 자동 수집에서 2회만 쓰므로 여유가 크다.
  · 최근 4개월은 잠정치다(footnote code "P"). 매 실행에서 2016년부터 전 구간을
    다시 받으므로 개정치가 자동 반영된다 — 증분 저장을 두지 않는 이유다.

★ 값을 만들지 않는다. 표의 모든 숫자·추세 문구는 받은 월별 관측치에서 계산한다
  (아래 _bands / _summary). 진행 중인 해는 부분 연도임을 그대로 표시한다.
"""
import io
import json
import datetime

import requests

BLS_URL = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
SERIES_ID = "PCU337910337910"
START_YEAR = 2016
CHUNK_YEARS = 10          # v1 하드 상한 — 이 값을 넘겨 요청하면 뒤 연도가 잘린다
TIMEOUT = 60
HEADERS = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}

# ── 설명표의 고정 문구 (화면 표의 '설명' 칸) ──────────────────────────────
# ★ 표 문구를 바꿀 일이 생기면 이 파일만 고친다. 프런트(app.js)는 k/v 를 그대로 그린다.
NAME_FULL = "미국 매트리스 제조업 PPI (생산자물가지수)"
PUBLISHER = "미국 정부기관 BLS(노동통계국)"
MEASURES = '미국 매트리스 "공장"이 도매로 파는 판매가격의 변화 (소비자 매장가 아님)'
BASE_PERIOD = "1983년 6월 = 100"
BASE_MONTH_TXT = "1983년 6월"
COVERAGE = ("스프링형, 폼형, 에어매트리스, 특수 매트리스 등 미국에서 만드는 "
            "모든 종류의 매트리스를 통틀어 하나의 평균낸 것")
TIER_ANSWER = ("❌ 불가능 — 애초에 전체를 뭉뚱그려 평균 낸 수치라서, 그 안에서 "
               '"프리미엄만" 분리해서 볼 방법이 데이터 구조상 없음')
TIER_QUESTION = "프리미엄/하이엔드만 따로 볼 수 있나"

LABEL = "미국 매트리스 제조업 PPI"
UNIT = "지수 (%s)" % BASE_PERIOD
SOURCE = ("미국 노동통계국(BLS) 생산자물가지수(PPI) · 매트리스 제조업"
          "(NAICS 337910 · %s) · v1 API · 키 불필요" % SERIES_ID)
NOTE = ("미국 매트리스 공장의 도매 출고가격 지수입니다. 소비자 매장가가 아니며, "
        "가격대(프리미엄·저가)별로는 나뉘지 않습니다.")

# 구간 경계는 '편집 판단'이다(코로나 전 / 코로나 인플레 / 그 이후). 숫자와 추세
# 문구는 전부 실데이터에서 계산하고, 마지막 구간과 진행 중인 해는 자동으로 늘어난다.
#   None = "마지막 완전 연도까지" — 해가 바뀌면 스스로 확장된다.
BAND_EDGES = [(2016, 2020), (2021, 2022), (2023, None)]

FLAT = 1.5                # 연 환산 |변화율| 이 이 아래면 '정체'로 본다(%)
STEEP = 4.0               # 이 이상이면 '급격'으로 본다(%)


# ── 수집 ──────────────────────────────────────────────────────────────────
def _year_chunks(start, end):
    """[start, end] 를 v1 상한(10년) 이하 구간으로 쪼갠다."""
    out, y = [], start
    while y <= end:
        out.append((y, min(y + CHUNK_YEARS - 1, end)))
        y += CHUNK_YEARS
    return out


def _fetch_chunk(y0, y1):
    """한 구간의 월별 관측치. [{month, value, prelim}] (오래된 달 먼저)."""
    body = {"seriesid": [SERIES_ID], "startyear": str(y0), "endyear": str(y1)}
    r = requests.post(BLS_URL, data=json.dumps(body), timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    j = r.json()
    if j.get("status") != "REQUEST_SUCCEEDED":
        raise RuntimeError("BLS 응답 오류: %s" % str(j.get("message"))[:120])
    series = (j.get("Results") or {}).get("series") or []
    rows = series[0].get("data") or [] if series else []
    out = []
    for x in rows:
        p = str(x.get("period") or "")
        if not p.startswith("M") or p == "M13":      # M13 은 BLS 가 주는 연평균
            continue
        try:
            month = "%s-%02d" % (x["year"], int(p[1:]))
            value = float(x["value"])
        except (KeyError, TypeError, ValueError):
            continue
        prelim = any((f or {}).get("code") == "P" for f in (x.get("footnotes") or []))
        out.append({"month": month, "value": value, "prelim": prelim})
    return out


def _fetch_months():
    """2016년~올해 전 구간의 월별 관측치(중복 제거·오름차순)."""
    this_year = datetime.date.today().year
    by_month = {}
    for y0, y1 in _year_chunks(START_YEAR, this_year):
        for m in _fetch_chunk(y0, y1):
            by_month[m["month"]] = m       # 구간이 겹쳐도 마지막 값으로 덮어쓴다
    return [by_month[k] for k in sorted(by_month)]


# ── 집계 ──────────────────────────────────────────────────────────────────
def _years(months):
    """월별 → 연평균. [{year, value, months, complete}]"""
    acc = {}
    for m in months:
        y = int(m["month"][:4])
        a = acc.setdefault(y, [])
        a.append(m["value"])
    out = []
    for y in sorted(acc):
        vs = acc[y]
        out.append({"year": y, "value": round(sum(vs) / len(vs), 3),
                    "months": len(vs), "complete": len(vs) >= 12})
    return out


def _rate(start, end, span_years):
    """연 환산 변화율(%). 계산 불가면 None."""
    if not start or end is None or span_years <= 0:
        return None
    return ((end / start) ** (1.0 / span_years) - 1.0) * 100.0


def _trend_word(rate, ongoing=False):
    """연 환산 변화율 → 추세 문구. ongoing=True 면 '진행 중' 어투."""
    if rate is None:
        return "판단 보류"
    if ongoing:
        if rate >= STEEP:
            return "급등 중"
        if rate >= FLAT:
            return "상승 중"
        if rate > -FLAT:
            return "거의 보합"
        return "급락 중" if rate <= -STEEP else "하락 중"
    if rate >= STEEP:
        return "급격하게 상승"
    if rate >= FLAT:
        return "완만하게 상승"
    if rate > -FLAT:
        return "거의 정체"
    return "급격하게 하락" if rate <= -STEEP else "완만하게 하락"


def _n(v):
    """표에 쓸 정수 표기(191, 213 …)."""
    return "%d" % round(v)


def _slice(months, lo, hi):
    """[lo, hi] 연도에 걸친 월별 관측치."""
    return [m for m in months if lo <= int(m["month"][:4]) <= hi]


def _band(months, lo, hi, label, ongoing=False, prev_flat=False):
    """한 구간 → {label, text, rate, ...}. 관측치가 2개 미만이면 None.

    ★ 구간의 시작·끝은 '연평균'이 아니라 **구간 첫 달·마지막 달의 월값**이다.
      그래야 앞 구간의 끝과 뒤 구간의 시작이 이어져(213 → 218 → …) 표를 위에서
      아래로 읽을 때 흐름이 끊기지 않는다.
    ★ '정체' 구간은 끝값 한 점 대신 구간 최소~최대를 보인다 —
      한 점만 찍으면 '정체'라는 말과 숫자가 어긋나 보인다.
    """
    ms = _slice(months, lo, hi)
    if len(ms) < 2:
        return None
    start, end = ms[0]["value"], ms[-1]["value"]
    rate = _rate(start, end, (len(ms) - 1) / 12.0)
    word = _trend_word(rate, ongoing=ongoing)
    vals = [m["value"] for m in ms]
    lo_v, hi_v = min(vals), max(vals)
    if word == "거의 정체" and _n(lo_v) != _n(hi_v):
        shown = "%s~%s" % (_n(lo_v), _n(hi_v))       # 정체 구간은 폭으로 보인다
    else:
        shown = _n(end)
    # 직전 구간이 정체였는데 지금 오르면 '다시' — 데이터에서 나온 판단이다
    if ongoing and prev_flat and rate is not None and rate >= FLAT:
        word = "다시 " + word
    tail = ""
    if ongoing:
        nprelim = sum(1 for m in ms if m["prelim"])
        if nprelim:
            tail = ' (단, 최근 %d개월치는 "잠정치"라 나중에 수정될 수 있음)' % nprelim
    return {"label": label, "from_year": lo, "to_year": hi, "ongoing": ongoing,
            "months": len(ms), "rate": None if rate is None else round(rate, 2),
            "flat": word == "거의 정체",
            "text": "%s → %s, %s%s" % (_n(start), shown, word, tail)}


def _bands(months, years):
    """구간별 흐름. 완전 연도 구간들 + 진행 중인 해(부분 연도) 하나."""
    if not years:
        return []
    done = [y["year"] for y in years if y["complete"]]
    last_done = done[-1] if done else None
    out = []

    for lo, hi in BAND_EDGES:
        if last_done is None:
            break
        hi = last_done if hi is None else min(hi, last_done)
        if lo > hi:
            continue
        label = ("%d년 흐름" % lo) if lo == hi else ("%d~%d년 흐름" % (lo, hi))
        b = _band(months, lo, hi, label)
        if b:
            out.append(b)

    # 진행 중인 해(부분 연도) — 해가 바뀌면 자동으로 다음 해로 옮겨 간다
    part = [y for y in years if not y["complete"]]
    if part:
        py = part[-1]["year"]
        n = part[-1]["months"]
        label = ("%d년 초 흐름" if n <= 8 else "%d년 흐름") % py
        b = _band(months, py, py, label, ongoing=True,
                  prev_flat=bool(out) and out[-1].get("flat"))
        if b:
            out.append(b)
    return out


def _summary(years, months, bands):
    """한 줄 요약 — 시작 연도·전체 방향·가장 급했던 구간을 실데이터에서 뽑는다."""
    if not years or not months:
        return ""
    rate = _rate(months[0]["value"], months[-1]["value"], (len(months) - 1) / 12.0)
    if rate is None:
        move = "움직였고"
    elif rate >= FLAT:
        move = "꾸준히 올랐고"
    elif rate > -FLAT:
        move = "거의 제자리였고"
    else:
        move = "꾸준히 내렸고"
    # ★ 진행 중인 해는 제외한다. 몇 달치를 연 환산하면 비율이 과장되고,
    #   게다가 잠정치라 "특히 …에 크게 뛰었다"는 회고 문장의 근거가 못 된다.
    rated = [b for b in bands if b.get("rate") is not None and not b.get("ongoing")]
    steep = max(rated, key=lambda b: b["rate"]) if rated else None
    if steep:
        rng = ("%d년" % steep["from_year"] if steep["from_year"] == steep["to_year"]
               else "%d~%d년" % (steep["from_year"], steep["to_year"]))
        tail = "특히 %s에 크게 뛰었다" % rng
    else:
        tail = "구간별 편차는 크지 않았다"
    return ('"미국에서 만드는 매트리스 전체의 평균 공장 출고가가 %d년부터 %s, %s"'
            " — 단, 프리미엄과 저가형을 구분하진 못함"
            % (int(months[0]["month"][:4]), move, tail))


def _table(series_id, years, months, bands):
    """화면 설명표. [{k, v}] — 프런트는 이 목록을 그대로 그린다(HTML 없음)."""
    last = months[-1]
    ratio = last["value"] / 100.0
    rows = [
        {"k": "이 지수의 이름", "v": NAME_FULL},
        {"k": "시리즈 코드", "v": series_id},
        {"k": "누가 발표하나", "v": PUBLISHER},
        {"k": "무엇을 재나", "v": MEASURES},
        {"k": "기준 시점", "v": BASE_PERIOD},
        {"k": "최근 값 (%s · %s)" % (last["month"], ("%.3f" % last["value"]).rstrip("0").rstrip(".")),
         "v": "%s보다 지금 가격이 약 %.1f배 높다는 뜻 (실제 금액 아니고 비율)"
              % (BASE_MONTH_TXT, ratio)},
        {"k": "포함 범위", "v": COVERAGE},
        {"k": TIER_QUESTION, "v": TIER_ANSWER},
    ]
    rows += [{"k": b["label"], "v": b["text"]} for b in bands]
    rows.append({"k": "한 줄 요약", "v": _summary(years, months, bands)})
    return rows


# ── FETCHERS 등록용 ───────────────────────────────────────────────────────
def update_us_ppi():
    """미국 매트리스 제조업 PPI. 실패하면 reason 을 담아 돌려준다(값을 만들지 않는다)."""
    try:
        months = _fetch_months()
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": "BLS 조회 실패: %s" % str(e)[:90]}
    if len(months) < 2:
        return {"status": "error", "reason": "BLS 관측치가 부족합니다(%d개월)" % len(months)}

    years = _years(months)
    bands = _bands(months, years)
    prelim = [m["month"] for m in months if m["prelim"]]
    part = [y for y in years if not y["complete"]]
    print("[us_ppi] %d개월(%s~%s) · %d개 연도 · 잠정 %d개월"
          % (len(months), months[0]["month"], months[-1]["month"], len(years), len(prelim)))
    return {
        "status": "ok",
        "series_id": SERIES_ID,
        "label": LABEL,
        "unit": UNIT,
        "base_period": BASE_PERIOD,
        "start_year": START_YEAR,
        "months": months,
        "years": years,
        "latest": months[-1],
        "partial_year": part[-1] if part else None,
        "prelim_months": len(prelim),
        "bands": bands,
        "summary": _summary(years, months, bands),
        "table": _table(SERIES_ID, years, months, bands),
        "note": NOTE,
        "source": SOURCE,
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


if __name__ == "__main__":
    import sys
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    p = update_us_ppi()
    slim = {k: v for k, v in p.items() if k != "months"}
    print(json.dumps(slim, ensure_ascii=False, indent=1))
