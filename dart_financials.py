"""시몬스 재무제표 수집 — 금융감독원 전자공시(Open DART).

결과: public/data/simmons-financials.json (단위: 억원)

왜 fnlttSinglAcntAll 만으로는 안 되는가
---------------------------------------
★★ 시몬스는 비상장사다(DART 고유번호 00201557, stock_code 없음). 그래서
   '단일회사 전체 재무제표'(fnlttSinglAcntAll)로는 조회되지 않는다 — 이 API 는
   사업·반기·분기보고서를 낸 회사만 대상이라, 시몬스로 부르면 어느 연도·어느
   fs_div 로 불러도 status=013 '조회된 데이타가 없습니다' 가 돌아온다(실측).
   fnlttXbrl(재무제표 원본 XBRL)도 014 '파일이 존재하지 않습니다' 다.

   시몬스가 내는 정기 공시는 **감사보고서** 하나뿐이고(2019~2025년치 7건),
   재무상태표·손익계산서는 그 감사보고서 본문의 '(첨부)재무제표' 안에 있다.
   그래서 document.xml 로 공시 원문을 받아 그 표를 읽는다. 같은 Open DART
   키·같은 자동화로 돌아가고, 숫자는 감사받은 확정치다(기사 인용치가 아니다).

   ★ fnlttSinglAcntAll 을 먼저 한 번 불러 본다 — 시몬스가 나중에 상장하거나
     사업보고서를 내기 시작하면 그쪽이 더 정확하고 다루기 쉽기 때문이다.
     비어 있으면 조용히 감사보고서 경로로 넘어간다.

표를 읽는 방법
--------------
공시 원문은 DART 고유 XML 이다. <TITLE> 로 '재무상태표'·'손익계산서' 구획을
가르고(목차에도 같은 문구가 있어 TITLE 위치로 갈라야 한다), 표의 <TR>/<TE> 를
훑는다. 숫자 칸은 ADELIM 으로 구분된다 — 1=당기 세부, 2=당기 합계,
3=전기 세부, 4=전기 합계. 합계 행은 2·4 에, 세부 행은 1·3 에 값이 들어간다.
계정 이름은 'Ⅰ. 유동자산', '자 산 총 계', 'Ⅹ.당기순이익(주석21)' 처럼
번호·공백·주석이 섞여 오므로 전부 지우고 맞춘다.

방어 규칙 (수집기 공통)
-----------------------
- 어느 단계든 실패하면 **기존 JSON 을 그대로 두고** 에러만 남긴다.
  빈 파일이나 반쪽짜리로 덮어써서 화면이 비는 일이 없게 한다(--force 로만 덮어씀).
- 계정 9개를 다 찾지 못하면 실패로 본다.
- 합계 검산(유동+비유동=자산총계, 부채+자본=자산총계)을 하고 어긋나면 경고를 남긴다.

사용법
------
    python dart_financials.py                # 수집 → JSON 저장
    python dart_financials.py --years 6      # 추이 그래프용으로 6개 연도까지
    python dart_financials.py --dry-run      # 저장하지 않고 결과만 출력
    python dart_financials.py --relookup     # corp_code 를 DART 에서 다시 찾는다
"""

import argparse
import datetime
import io
import json
import os
import re
import sys
import zipfile

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "public", "data", "simmons-financials.json")

ENV_KEY = "DART_API_KEY"
API = "https://opendart.fss.or.kr/api"
TIMEOUT = 60

# ★ corpCode.xml(3.6MB)에서 한 번 찾아 둔 값. 매번 받지 않는다.
#   DART 등록명은 '주식회사 시몬스'가 아니라 **'시몬스'** 다(법인 등기명과 다름).
#   --relookup 으로 다시 확인할 수 있다.
CORP_CODE = "00201557"
CORP_NAME = "시몬스"

UNIT_DIV = 100000000.0        # 원 → 억원

# 찾을 계정 9개. 값은 (구획, 이름 후보들). 이름은 공백·번호·주석을 지우고 맞춘다.
WANT = [
    ("assetsTotal",      "재무상태표", ("자산총계",)),
    ("currentAssets",    "재무상태표", ("유동자산",)),
    ("nonCurrentAssets", "재무상태표", ("비유동자산",)),
    ("liabilitiesTotal", "재무상태표", ("부채총계",)),
    ("equityTotal",      "재무상태표", ("자본총계",)),
    ("revenue",          "손익계산서", ("매출액",)),
    ("grossProfit",      "손익계산서", ("매출총이익", "매출총손실")),
    ("operatingProfit",  "손익계산서", ("영업이익", "영업손실")),
    ("netIncome",        "손익계산서", ("당기순이익", "당기순손실")),
]
LABEL_KO = {
    "assetsTotal": "자산총계", "currentAssets": "유동자산",
    "nonCurrentAssets": "비유동자산", "liabilitiesTotal": "부채총계",
    "equityTotal": "자본총계", "revenue": "매출액", "grossProfit": "매출총이익",
    "operatingProfit": "영업이익", "netIncome": "당기순이익",
}


# ── 환경 ────────────────────────────────────────────────────────────────
def _load_dotenv():
    """로컬 개발용 .env 를 환경변수로 올린다(기존 값은 덮어쓰지 않는다).
    kipris_patent.py 와 같은 방식 — 의존성을 늘리지 않으려고 직접 읽는다."""
    p = os.path.join(BASE, ".env")
    if not os.path.isfile(p):
        return
    try:
        for line in io.open(p, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except Exception:  # noqa: BLE001 — .env 가 깨졌다고 수집을 막지 않는다
        pass


def api_key():
    _load_dotenv()
    return (os.environ.get(ENV_KEY) or "").strip()


# ── 공통 유틸 ───────────────────────────────────────────────────────────
def _norm(s):
    """계정 이름 정규화: 태그·공백·로마숫자 번호·주석·괄호 표기를 지운다."""
    s = re.sub(r"<[^>]+>", "", s or "")
    s = re.sub(r"\(주석[^)]*\)", "", s)
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ0-9]+[.\)]?", "", s)
    return s


def _money(s):
    """'(4,109,052,772)' · '1,234' → 정수(원). 괄호는 음수. 빈 값은 None."""
    s = re.sub(r"<[^>]+>", "", s or "").strip()
    if not s or s in ("-", "–", "—"):
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()").replace(",", "").replace(" ", "")
    if s.startswith("△") or s.startswith("▲"):
        neg, s = True, s[1:]
    if not re.fullmatch(r"-?\d+", s or ""):
        return None
    v = int(s)
    return -v if neg else v


def _eok(won):
    """원 → 억원(소수 첫째 자리). 화면이 쓰는 단위."""
    if won is None:
        return None
    return round(won / UNIT_DIV, 1)


# ── DART 호출 ───────────────────────────────────────────────────────────
def lookup_corp_code(key, name=CORP_NAME):
    """corpCode.xml 에서 회사 고유번호를 찾는다. 정확히 일치하는 것만 고른다."""
    r = requests.get(API + "/corpCode.xml", params={"crtfc_key": key}, timeout=TIMEOUT)
    r.raise_for_status()
    if r.content[:2] != b"PK":
        raise RuntimeError("corpCode 응답이 zip 이 아닙니다: %s" % r.content[:120])
    import xml.etree.ElementTree as ET
    z = zipfile.ZipFile(io.BytesIO(r.content))
    root = ET.fromstring(z.read(z.namelist()[0]))
    exact, loose = [], []
    for e in root.iter("list"):
        nm = (e.findtext("corp_name") or "").strip()
        cc = (e.findtext("corp_code") or "").strip()
        if nm == name:
            exact.append((nm, cc))
        elif name in nm:
            loose.append((nm, cc))
    if exact:
        return exact[0][1], exact
    return (loose[0][1] if loose else None), loose


def latest_reports(key, corp_code, want):
    """감사보고서(정기) 목록을 최신순으로. [{year, rcept_no, report_nm}]"""
    today = datetime.date.today()
    r = requests.get(API + "/list.json", params={
        "crtfc_key": key, "corp_code": corp_code,
        "bgn_de": "%d0101" % (today.year - 12), "end_de": today.strftime("%Y%m%d"),
        "page_count": "100"}, timeout=TIMEOUT)
    r.raise_for_status()
    d = r.json()
    if d.get("status") != "000":
        raise RuntimeError("공시목록 조회 실패 %s (%s)" % (d.get("status"), d.get("message")))
    out = []
    for it in (d.get("list") or []):
        nm = (it.get("report_nm") or "").strip()
        m = re.search(r"\((\d{4})\.(\d{2})\)", nm)
        if "감사보고서" not in nm or not m:
            continue
        if "연결" in nm:          # 개별 재무제표 기준으로 통일한다
            continue
        out.append({"year": int(m.group(1)), "rceptNo": (it.get("rcept_no") or "").strip(),
                    "reportName": nm, "receiptDate": (it.get("rcept_dt") or "").strip()})
    out.sort(key=lambda x: x["year"], reverse=True)
    return out[:want]


def try_fnltt_all(key, corp_code, year):
    """'단일회사 전체 재무제표'. 시몬스는 비어 있지만, 상장/사업보고서 제출로
       바뀌면 이쪽이 정확하므로 먼저 한 번 확인한다. 값이 없으면 None."""
    for fs in ("OFS", "CFS"):
        try:
            r = requests.get(API + "/fnlttSinglAcntAll.json", params={
                "crtfc_key": key, "corp_code": corp_code, "bsns_year": str(year),
                "reprt_code": "11011", "fs_div": fs}, timeout=TIMEOUT)
            d = r.json()
        except Exception:  # noqa: BLE001
            continue
        if d.get("status") == "000" and (d.get("list") or []):
            return d["list"]
    return None


def fetch_document(key, rcept_no):
    """공시 원문(zip 안의 XML) 문자열."""
    r = requests.get(API + "/document.xml",
                     params={"crtfc_key": key, "rcept_no": rcept_no}, timeout=90)
    r.raise_for_status()
    if r.content[:2] != b"PK":
        raise RuntimeError("원문이 zip 이 아닙니다: %s" % r.content[:160])
    z = zipfile.ZipFile(io.BytesIO(r.content))
    raw = z.read(z.namelist()[0])
    for enc in ("utf-8", "cp949", "euc-kr"):
        try:
            return raw.decode(enc)
        except Exception:  # noqa: BLE001
            continue
    return raw.decode("utf-8", "replace")


# ── 원문 파싱 ───────────────────────────────────────────────────────────
def _sections(doc):
    """<TITLE> 위치로 구획을 가른다.
       ★ 목차에도 '재무상태표' 같은 같은 문구가 있어서 문자열 검색으로 자르면
         목차를 집는다 — TITLE 태그 위치로만 가른다."""
    marks = [(m.start(), _norm(m.group(1)))
             for m in re.finditer(r"<TITLE[^>]*>(.*?)</TITLE>", doc, re.S)]
    out = {}
    for i, (pos, name) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(doc)
        out.setdefault(name, doc[pos:end])
    return out


def _rows(section):
    """구획 안 가장 큰 표의 행들 → [(정규화된 이름, {ADELIM: 원문값})]"""
    tables = re.findall(r"<TABLE\b.*?</TABLE>", section, re.S)
    if not tables:
        return []
    tb = max(tables, key=len)
    rows = []
    for tr in re.findall(r"<TR\b.*?</TR>", tb, re.S):
        cells = re.findall(r"<TE\b([^>]*)>(.*?)</TE>", tr, re.S)
        if not cells:
            continue
        vals = {}
        for attrs, val in cells:
            m = re.search(r'ADELIM="(\d+)"', attrs)
            if m:
                vals[m.group(1)] = val
        rows.append((_norm(cells[0][1]), vals))
    return rows


def _pick(rows, names):
    """이름이 정확히 맞는 행의 (당기, 전기) 값(원). 못 찾으면 (None, None).
       ★ 합계 행은 ADELIM 2·4 에, 세부 행은 1·3 에 값이 온다."""
    for label, vals in rows:
        if label in names:
            cur = _money(vals.get("2"))
            if cur is None:
                cur = _money(vals.get("1"))
            pre = _money(vals.get("4"))
            if pre is None:
                pre = _money(vals.get("3"))
            if cur is not None or pre is not None:
                return cur, pre
    return None, None


def parse_document(doc):
    """공시 원문 → {계정키: (당기 원, 전기 원)} + 기수 라벨"""
    secs = _sections(doc)
    bs = _rows(secs.get("재무상태표", ""))
    is_ = _rows(secs.get("손익계산서", ""))
    if not bs or not is_:
        raise RuntimeError("재무상태표/손익계산서 표를 찾지 못했습니다 "
                           "(구획: %s)" % ", ".join(list(secs)[:8]))
    got = {}
    missing = []
    for key_, which, names in WANT:
        cur, pre = _pick(bs if which == "재무상태표" else is_, names)
        if cur is None and pre is None:
            missing.append(LABEL_KO[key_])
        got[key_] = (cur, pre)
    if missing:
        raise RuntimeError("계정을 찾지 못했습니다: %s" % ", ".join(missing))
    # 기수 라벨(제 34(당) 기 / 제 33(전) 기)
    terms = re.findall(r"제\s*(\d+)\s*\((?:당|전)\)\s*기", secs.get("재무상태표", ""))
    labels = {}
    if len(terms) >= 2:
        labels = {"current": "제%s기" % terms[0], "previous": "제%s기" % terms[1]}
    return got, labels


def _check_sums(got, warn):
    """검산 — 어긋나면 경고만 남긴다(수집을 막지는 않는다)."""
    def g(k, i):
        return (got.get(k) or (None, None))[i]
    for i, who in ((0, "당기"), (1, "전기")):
        a, ca, nca = g("assetsTotal", i), g("currentAssets", i), g("nonCurrentAssets", i)
        if None not in (a, ca, nca) and abs((ca + nca) - a) > 1:
            warn.append("%s 유동+비유동(%d) ≠ 자산총계(%d)" % (who, ca + nca, a))
        li, eq = g("liabilitiesTotal", i), g("equityTotal", i)
        if None not in (a, li, eq) and abs((li + eq) - a) > 1:
            warn.append("%s 부채+자본(%d) ≠ 자산총계(%d)" % (who, li + eq, a))


# ── 수집 ────────────────────────────────────────────────────────────────
def collect(key, years):
    warn, errs = [], []
    reports = latest_reports(key, CORP_CODE, years)
    if not reports:
        raise RuntimeError("감사보고서 공시를 찾지 못했습니다")

    # ★ 상장/사업보고서 제출로 바뀌었는지 최신 연도로 한 번만 확인한다.
    alt = try_fnltt_all(key, CORP_CODE, reports[0]["year"])
    if alt:
        warn.append("fnlttSinglAcntAll 에 데이터가 생겼습니다(%d건) — 그쪽이 더 정확하니 "
                    "수집 방식을 바꾸는 것을 검토하세요" % len(alt))

    latest = reports[0]
    doc = fetch_document(key, latest["rceptNo"])
    got, labels = parse_document(doc)
    _check_sums(got, warn)

    accounts = {}
    for key_, _which, _names in WANT:
        cur, pre = got[key_]
        accounts[key_] = {"label": LABEL_KO[key_], "current": _eok(cur), "previous": _eok(pre)}

    # 추이 그래프용 — 보고서마다 (당기) 손익 3개만 모은다. 실패한 해는 건너뛴다.
    history, seen = [], set()
    for rep in reports:
        try:
            g2, _ = parse_document(doc if rep is latest else fetch_document(key, rep["rceptNo"]))
        except Exception as e:  # noqa: BLE001 — 한 해가 실패해도 나머지는 살린다
            errs.append({"year": rep["year"], "error": str(e)[:160]})
            continue
        for idx, yr in ((0, rep["year"]), (1, rep["year"] - 1)):
            if yr in seen:
                continue
            seen.add(yr)
            history.append({
                "year": yr,
                "revenue": _eok(g2["revenue"][idx]),
                "operatingProfit": _eok(g2["operatingProfit"][idx]),
                "netIncome": _eok(g2["netIncome"][idx]),
            })
    history = [h for h in history if h["revenue"] is not None]
    history.sort(key=lambda x: x["year"])

    cur_year = latest["year"]
    return {
        "status": "ok",
        "corpCode": CORP_CODE,
        "corpName": CORP_NAME,
        "unit": "억원",
        "source": "금융감독원 전자공시(DART) 감사보고서",
        "sourceUrl": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + latest["rceptNo"],
        "sourceNote": "시몬스는 비상장사라 사업보고서를 내지 않습니다. 감사받은 "
                      "개별 재무제표(감사보고서 첨부)를 그대로 옮긴 값입니다.",
        "reportName": latest["reportName"],
        "rceptNo": latest["rceptNo"],
        "receiptDate": latest["receiptDate"],
        "fiscalYear": cur_year,
        "current": {"year": cur_year, "label": labels.get("current") or ("%d년" % cur_year)},
        "previous": {"year": cur_year - 1,
                     "label": labels.get("previous") or ("%d년" % (cur_year - 1))},
        "accounts": accounts,
        "history": history,
        "lastUpdated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "warnings": warn,
        "errors": errs,
    }


def _existing_ok(path):
    """이미 저장된 정상 결과. 실패했을 때 이것을 지킨다."""
    try:
        d = json.load(io.open(path, encoding="utf-8"))
        return d if d.get("status") == "ok" and d.get("accounts") else None
    except Exception:  # noqa: BLE001
        return None


def main():
    ap = argparse.ArgumentParser(description="시몬스 재무제표 수집 (Open DART)")
    ap.add_argument("--years", type=int, default=5,
                    help="추이 그래프용으로 훑을 감사보고서 수 (기본 5 → 약 6개 연도)")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--dry-run", action="store_true", help="저장하지 않고 결과만 출력")
    ap.add_argument("--force", action="store_true",
                    help="실패해도 결과를 덮어쓴다(기본은 기존 파일 유지)")
    ap.add_argument("--relookup", action="store_true",
                    help="corp_code 를 corpCode.xml 에서 다시 찾는다")
    a = ap.parse_args()

    key = api_key()
    if not key:
        print("error  : %s 가 없습니다(.env 또는 환경변수)" % ENV_KEY)
        keep = _existing_ok(a.out)
        print("keep   : 기존 데이터 유지" if keep else "keep   : 기존 데이터도 없음")
        return 1

    if a.relookup:
        try:
            cc, hits = lookup_corp_code(key)
            print("lookup : '%s' 후보 %d건 → %s" % (CORP_NAME, len(hits), hits[:5]))
            print("         corp_code = %s (코드에 박힌 값 %s)" % (cc, CORP_CODE))
        except Exception as e:  # noqa: BLE001
            print("lookup : 실패 — %r" % (e,))

    try:
        res = collect(key, max(1, a.years))
    except Exception as e:  # noqa: BLE001 — 어떤 실패든 기존 데이터를 지킨다
        print("error  : %s" % e)
        keep = _existing_ok(a.out)
        if keep and not a.force:
            print("keep   : 기존 정상 데이터(%s 기준, %s)를 유지했습니다 — 덮어쓰지 않음"
                  % (keep.get("fiscalYear"), keep.get("lastUpdated")))
            print("         덮어쓰려면 --force")
            return 1
        if a.force:
            res = {"status": "error", "reason": str(e)[:300],
                   "lastUpdated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        else:
            return 1

    ac = res.get("accounts") or {}
    print("company: %s (corp_code %s)" % (res.get("corpName"), res.get("corpCode")))
    print("report : %s · 접수 %s" % (res.get("reportName"), res.get("receiptDate")))
    print("period : %s(%s) vs %s(%s)  단위 억원"
          % (res.get("current", {}).get("label"), res.get("current", {}).get("year"),
             res.get("previous", {}).get("label"), res.get("previous", {}).get("year")))
    for k, _w, _n in WANT:
        v = ac.get(k) or {}
        print("   %-10s %14s %14s" % (LABEL_KO[k],
                                      "{:,}".format(v.get("current")) if v.get("current") is not None else "—",
                                      "{:,}".format(v.get("previous")) if v.get("previous") is not None else "—"))
    print("history: %s" % ", ".join("%d" % h["year"] for h in (res.get("history") or [])))
    for w in (res.get("warnings") or []):
        print("warn   : %s" % w)
    for e in (res.get("errors") or []):
        print("err    : %s" % e)

    if a.dry_run:
        print("dry-run: 저장하지 않았습니다")
        return 0

    d = os.path.dirname(a.out)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with io.open(a.out, "w", encoding="utf-8") as f:
        f.write(json.dumps(res, ensure_ascii=False, indent=2) + "\n")
    print("saved  : %s" % a.out)
    return 0 if res.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
