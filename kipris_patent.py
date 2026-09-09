# -*- coding: utf-8 -*-
"""KIPRIS 특허 대시보드 수집 — public/data/kipris-patents.json.

수집 대상 (신청·승인된 2개 API):
  [A] 국내  특허·실용 공개·등록공보   patUtiModInfoSearchSevice
  [B] 해외  해외특허(해외공통)        오퍼레이션명은 문서 기준 applicantSearch/freeSearch

★ 무료 티어가 월 1,000회다. 그래서 이 파일은 '하루 1회 배치'로 돌리고,
  대시보드는 결과 JSON 만 읽는다(화면에서 API 를 직접 부르지 않는다).
  한 번 실행의 호출 수는 --max-calls 로 잠근다(기본 30회 = 월 1,000회 / 31일).

★★ 인증 파라미터는 ServiceKey 다. 문서가 accessKey/ServiceKey 로 갈려 있어
  더미 키로 확인했다 — accessKey 는 resultCode 10(파라미터를 못 알아봄),
  ServiceKey 는 resultCode 30(이름은 맞고 키만 무효). 게이트웨이가 바뀔 수 있으니
  두 이름을 순서대로 시도하고 '무엇이 통했는지'를 결과 JSON(probe)에 남긴다.

★★★ 오퍼레이션 경로는 유효한 키가 있어야 확인된다 — 키 검증이 경로 라우팅보다
  먼저라, 없는 경로에도 resultCode 30 이 온다. 그래서 검색은 후보 오퍼레이션을
  순서대로 시도하고(getAdvancedSearch → applicantNameSearchInfo → getWordSearch),
  실제로 통한 경로를 endpoints 에 기록한다.

★★★ 실패를 조용히 넘기지 않는다. 응답의 resultCode/resultMsg 를 그대로 담아
  화면이 "왜 비었는지"를 말할 수 있게 한다.

단독 실행:
    python kipris_patent.py                 # 수집 → public/data/kipris-patents.json
    python kipris_patent.py --probe         # 인증/파라미터 형태만 진단(호출 3~4회)
    python kipris_patent.py --years 3       # 조회 기간(기본 3년)
    python kipris_patent.py --max-calls 30  # 이번 실행의 최대 API 호출 수
    python kipris_patent.py --raw           # 응답 원문을 tmp/ 에 저장
"""
import os
import io
import re
import sys
import json
import time
import datetime
import argparse
import xml.etree.ElementTree as ET
from collections import Counter, OrderedDict

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_REL = os.path.join("public", "data", "kipris-patents.json")
TAXONOMY_REL = "kipris_taxonomy.json"

KIPRIS_HOST = "https://plus.kipris.or.kr/kipo-api/kipi"
SVC_DOMESTIC = "patUtiModInfoSearchSevice"          # ★ 원문 오타(Sevice)가 실제 경로다
SVC_FOREIGN = "ForeignPatentInfoSearchService"

ENV_KEY = "KIPRIS_API_KEY"
# ★ 확인된 값: ServiceKey. 더미 키로 두 이름을 넣어 본 결과
#   accessKey → resultCode 10 (파라미터를 못 알아본다)
#   ServiceKey → resultCode 30 SERVICE_KEY_IS_NOT_REGISTERED (이름은 맞고 키만 무효)
#   그래서 ServiceKey 를 먼저 쓰고, 게이트웨이가 바뀔 경우를 위해 accessKey 를 남긴다.
KEY_PARAM_CANDIDATES = ("ServiceKey", "accessKey")

# resultCode 해설 — 무엇을 고쳐야 하는지 화면과 로그에 같이 실어 준다.
# ★ 키 검증이 경로 라우팅보다 먼저 일어난다(없는 경로에도 30 이 온다).
#   그래서 30 이 뜨는 동안에는 엔드포인트가 맞는지 확인할 방법이 없다.
RESULT_HINTS = {
    "10": " → 요청 파라미터 이름이 맞지 않습니다(키 파라미터명 포함).",
    "20": " → 이 API 사용 권한이 없습니다. KIPRIS Plus 에서 해당 API 신청·승인 상태를 확인하세요.",
    "30": " → 키가 등록되지 않았거나 잘못되었습니다. .env 의 KIPRIS_API_KEY 값을 확인하세요.",
    "31": " → 키 사용 기간이 만료되었습니다.",
    "32": " → 이번 달 무료 호출 한도(1,000회)를 넘었습니다.",
}

# 한 번 실행에서 쓸 기본 호출 상한. 월 1,000회 / 30일 ≈ 33회.
CALL_BUDGET = 30
TIMEOUT = 25
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


# ── 환경변수 ─────────────────────────────────────────────────────────────
def _load_dotenv():
    """로컬 개발용 .env 를 환경변수로 올린다(기존 값은 덮어쓰지 않는다).
    api/instagram.py 와 같은 방식 — 의존성을 늘리지 않으려고 직접 읽는다."""
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
    return (os.environ.get(ENV_KEY) or "").strip() or None


# ── 설정(분류·키워드) ────────────────────────────────────────────────────
def load_taxonomy():
    p = os.path.join(BASE, TAXONOMY_REL)
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


# ── 호출 ─────────────────────────────────────────────────────────────────
class Budget(object):
    """호출 수를 세고 상한에서 멈춘다. 무료 티어를 넘기지 않기 위한 잠금."""

    def __init__(self, limit):
        self.limit = int(limit)
        self.used = 0
        self.stopped = False

    def take(self):
        if self.used >= self.limit:
            self.stopped = True
            return False
        self.used += 1
        return True


def _get(path, params, key, key_param, budget, raw_sink=None):
    """XML 한 번 호출. (root, err) 를 돌려준다 — err 가 있으면 root 는 None."""
    if not budget.take():
        return None, "호출 상한(%d회)에 걸려 중단" % budget.limit
    q = dict(params)
    q[key_param] = key
    url = "%s/%s" % (KIPRIS_HOST, path)
    try:
        r = requests.get(url, params=q, timeout=TIMEOUT,
                         headers={"User-Agent": UA, "Accept": "application/xml"})
    except Exception as e:  # noqa: BLE001
        return None, "네트워크 오류: %s" % e
    if raw_sink is not None:
        raw_sink.append({"url": r.url.replace(key, "***"), "status": r.status_code,
                         "body": r.text[:4000]})
    if r.status_code != 200:
        return None, "HTTP %s" % r.status_code
    body = (r.text or "").lstrip()
    if body.startswith("<!DOCTYPE") or "<html" in body[:200].lower():
        return None, "HTML 응답(엔드포인트 경로가 틀렸을 수 있음)"
    try:
        root = ET.fromstring(r.text)
    except Exception as e:  # noqa: BLE001
        return None, "XML 파싱 실패: %s" % e
    ok = (root.findtext(".//successYN") or "").strip().upper()
    code = (root.findtext(".//resultCode") or "").strip()
    msg = (root.findtext(".//resultMsg") or "").strip()
    if ok == "N" or (code and code not in ("00", "0", "")):
        return None, "API 오류 resultCode=%s resultMsg=%s%s" % (
            code or "?", msg or "?", RESULT_HINTS.get(code, ""))
    return root, None


def _items(root):
    """response/body/items/item → dict 목록. 태그 이름을 그대로 키로 쓴다."""
    out = []
    if root is None:
        return out
    for it in root.iter("item"):
        d = {}
        for ch in it:
            t = (ch.text or "").strip()
            if t:
                d[ch.tag] = t
        if d:
            out.append(d)
    return out


# ── 인증/파라미터 형태 진단 ──────────────────────────────────────────────
def probe(key, budget, raw_sink=None):
    """어떤 키 파라미터와 오퍼레이션이 실제로 통하는지 확인한다.
    ★ 문서가 갈려 있는 부분을 코드가 추측하지 않고 '물어봐서' 정한다."""
    result = {"keyParam": None, "domesticOp": None, "foreignOp": None, "tries": []}
    probes = [
        ("domestic", "%s/getWordSearch" % SVC_DOMESTIC,
         {"word": "매트리스", "numOfRows": 1, "pageNo": 1}),
    ]
    for kp in KEY_PARAM_CANDIDATES:
        for _, path, params in probes:
            root, err = _get(path, params, key, kp, budget, raw_sink)
            result["tries"].append({"keyParam": kp, "path": path, "error": err})
            if err is None:
                result["keyParam"] = kp
                result["domesticOp"] = "getWordSearch"
                break
        if result["keyParam"]:
            break
    if not result["keyParam"]:
        return result
    kp = result["keyParam"]
    # 해외특허 오퍼레이션 — 문서상 후보를 순서대로 확인한다.
    for op, params in (("applicantSearch", {"applicant": "Tempur", "numOfRows": 1, "pageNo": 1}),
                       ("freeSearch", {"free": "mattress", "numOfRows": 1, "pageNo": 1})):
        root, err = _get("%s/%s" % (SVC_FOREIGN, op), params, key, kp, budget, raw_sink)
        result["tries"].append({"keyParam": kp, "path": "%s/%s" % (SVC_FOREIGN, op),
                                "error": err})
        if err is None:
            result["foreignOp"] = op
            break
    return result


# ── 검색 ─────────────────────────────────────────────────────────────────
def search_domestic(applicant, key, key_param, budget, rows=100, raw_sink=None):
    """국내 특허·실용 — 출원인명으로 찾는다.
    ★ getAdvancedSearch(applicant=…) 를 먼저 쓰고, 파라미터를 거부하면
      applicantNameSearchInfo → getWordSearch(word=출원인) 로 물러난다.
      어느 경로로 얻었는지는 호출부가 기록한다."""
    attempts = [
        ("%s/getAdvancedSearch" % SVC_DOMESTIC,
         {"applicant": applicant, "patent": "true", "utility": "true",
          "numOfRows": rows, "pageNo": 1, "sortSpec": "AD", "descSort": "true"}),
        ("%s/applicantNameSearchInfo" % SVC_DOMESTIC,
         {"applicant": applicant, "patent": "true", "utility": "true",
          "numOfRows": rows, "pageNo": 1}),
        ("%s/getWordSearch" % SVC_DOMESTIC,
         {"word": applicant, "patent": "true", "utility": "true",
          "numOfRows": rows, "pageNo": 1}),
    ]
    last = None
    for path, params in attempts:
        root, err = _get(path, params, key, key_param, budget, raw_sink)
        if err is None:
            return _items(root), path, None
        last = err
        if budget.stopped:
            break
    return [], None, last


def search_foreign(applicant, key, key_param, op, budget, rows=100, raw_sink=None):
    """해외특허 — 출원인명으로 찾는다. op 는 probe 가 정한 오퍼레이션."""
    if not op:
        return [], None, "해외특허 오퍼레이션을 확인하지 못했습니다"
    pname = "applicant" if op == "applicantSearch" else "free"
    path = "%s/%s" % (SVC_FOREIGN, op)
    root, err = _get(path, {pname: applicant, "numOfRows": rows, "pageNo": 1},
                     key, key_param, budget, raw_sink)
    if err:
        return [], None, err
    return _items(root), path, None


# ── 항목 정규화 ──────────────────────────────────────────────────────────
DATE_KEYS = ("applicationDate", "appDate", "applicationDay", "openDate", "publicationDate")
NUM_KEYS = ("applicationNumber", "appNumber", "applicationNo")
TITLE_KEYS = ("inventionTitle", "inventionName", "title", "inventionTitleEng")
ABST_KEYS = ("astrtCont", "abstract", "abstractContent", "astrtContEng")
APPL_KEYS = ("applicantName", "applicant", "applicantNameEng")
KIND_KEYS = ("registerStatus", "applicationStatus", "documentKind", "patentUtility")
COUNTRY_KEYS = ("nationCode", "countryCode", "nation", "country")


def _pick(d, keys, default=""):
    for k in keys:
        v = d.get(k)
        if v:
            return v
    return default


def _norm_date(s):
    """YYYYMMDD / YYYY-MM-DD / YYYY.MM.DD → YYYY-MM-DD (못 읽으면 '')."""
    t = re.sub(r"[^0-9]", "", str(s or ""))
    if len(t) >= 8:
        return "%s-%s-%s" % (t[0:4], t[4:6], t[6:8])
    return ""


def normalize(raw, company, scope):
    d = _norm_date(_pick(raw, DATE_KEYS))
    title = _pick(raw, TITLE_KEYS)
    abst = _pick(raw, ABST_KEYS)
    return OrderedDict([
        ("appNo", _pick(raw, NUM_KEYS)),
        ("date", d),
        ("company", company["label"]),
        ("companyKey", company["key"]),
        ("isOurs", bool(company.get("isOurs"))),
        ("scope", scope),                                  # 'kr' | 'abroad'
        ("country", (_pick(raw, COUNTRY_KEYS) or ("KR" if scope == "kr" else "")).upper()),
        ("title", title),
        ("abstract", abst[:400]),
        ("kind", _pick(raw, KIND_KEYS)),
    ])


# ── 분류·키워드 ──────────────────────────────────────────────────────────
def classify(text, tax):
    """categories 순서대로 먼저 맞은 분류로 확정한다(중복 집계 없음)."""
    low = (text or "").lower()
    for c in tax["categories"]:
        for kw in c["keywords"]:
            if kw.lower() in low:
                return c["key"], c["label"]
    return "etc", "기타/미분류"


def is_new_material(text, tax):
    low = (text or "").lower()
    return any(kw.lower() in low for kw in tax["newMaterialKeywords"])


def match_words(text, tax):
    """형태소 분석 없이 사전 매칭 — keywordCloud 목록에 있는 말만 찾아 붙인다.
    ★ 사전에 없는 말은 세지 않는다. 형태소 분석기를 쓰지 않는 대신,
      무엇을 세는지 설정 파일(kipris_taxonomy.json)에 드러내는 방식을 택했다.
    ★★ 여기서 '행별로' 붙여 두면, 화면에서 기간을 좁혀도 그 기간만 다시 셀 수 있다."""
    low = (text or "").lower()
    stop = set(w.lower() for w in tax.get("stopwords", []))
    out = []
    for kw in tax["keywordCloud"]:
        k = kw.lower()
        if k in stop:
            continue
        if k in low:
            out.append(kw)
    return out


# ── 행 출력 ─────────────────────────────────────────────────────────────
# ★ 집계(KPI·월별·분류별…)는 화면에서 한다. 기간 선택 필터가 화면에 있으므로,
#   같은 집계를 파이썬에도 두면 두 곳이 서로 어긋난다. 여기서는 '행'만 낸다.
def row_out(r):
    return OrderedDict([
        ("appNo", r["appNo"]), ("date", r["date"]),
        ("company", r["company"]), ("companyKey", r["companyKey"]),
        ("isOurs", r["isOurs"]), ("scope", r["scope"]), ("country", r["country"]),
        ("kind", r["kind"] or "미표기"),
        ("catKey", r["_catKey"]), ("catLabel", r["_catLabel"]),
        ("newMaterial", r["_newMaterial"]),
        ("title", r["title"]), ("summary", (r["abstract"] or "")[:200]),
        ("words", r["_words"]),
    ])


# ── 수집 본체 ────────────────────────────────────────────────────────────
def collect(years=3, max_calls=CALL_BUDGET, raw=False, probe_only=False):
    tax = load_taxonomy()
    key = api_key()
    now = datetime.date.today()
    out = OrderedDict([
        ("status", "error"),
        ("reason", None),
        ("lastUpdated", now.isoformat()),
        ("source", "KIPRIS (특허정보검색서비스)"),
        ("techNote", tax.get("techNote", "")),
        ("keyParamUsed", None),
        ("calls", 0),
        ("probe", None),
    ])
    if not key:
        out["reason"] = ("환경변수 %s 가 설정되지 않았습니다. .env 에 %s=발급받은키 를 "
                         "넣고 python kipris_patent.py 를 다시 실행하세요."
                         % (ENV_KEY, ENV_KEY))
        return out

    budget = Budget(max_calls)
    raw_sink = [] if raw else None

    pr = probe(key, budget, raw_sink)
    out["probe"] = pr
    out["calls"] = budget.used
    if not pr["keyParam"]:
        errs = "; ".join(t["error"] or "" for t in pr["tries"] if t.get("error"))
        out["reason"] = ("KIPRIS 인증에 실패했습니다(accessKey·ServiceKey 두 이름 모두 "
                         "거부). 응답: %s" % (errs or "알 수 없음"))
        if raw:
            _dump_raw(raw_sink)
        return out
    out["keyParamUsed"] = pr["keyParam"]
    if probe_only:
        out["status"] = "ok"
        out["reason"] = None
        out["calls"] = budget.used
        if raw:
            _dump_raw(raw_sink)
        return out

    # 조회 기간과 전년 동기
    frm = now.replace(year=now.year - years)
    period = {"from": frm.isoformat(), "to": now.isoformat()}
    pfrm = frm.replace(year=frm.year - 1)
    pto = now.replace(year=now.year - 1)
    prev_period = {"from": pfrm.isoformat(), "to": pto.isoformat()}

    rows, errors, paths = [], [], set()
    for co in tax["companies"]:
        got = []
        used_variant = None
        for variant in co["variants"]:
            items, path, err = search_domestic(variant, key, pr["keyParam"], budget,
                                               raw_sink=raw_sink)
            if err:
                errors.append({"company": co["label"], "variant": variant,
                               "scope": "kr", "error": err})
            if path:
                paths.add(path)
            if items:
                got = items
                used_variant = variant
                break          # ★ 결과가 나온 첫 표기를 쓴다(변형을 계속 뒤지지 않는다)
            if budget.stopped:
                break
        for it in got:
            rows.append(normalize(it, co, "kr"))
        if used_variant:
            co["_matched"] = used_variant
        if budget.stopped:
            break

    if pr["foreignOp"] and not budget.stopped:
        for co in tax["companies"]:
            for variant in co["variants"][:2]:      # 해외는 표기 2개까지만(호출 절약)
                items, path, err = search_foreign(variant, key, pr["keyParam"],
                                                  pr["foreignOp"], budget,
                                                  raw_sink=raw_sink)
                if err:
                    errors.append({"company": co["label"], "variant": variant,
                                   "scope": "abroad", "error": err})
                if path:
                    paths.add(path)
                if items:
                    for it in items:
                        rows.append(normalize(it, co, "abroad"))
                    break
                if budget.stopped:
                    break
            if budget.stopped:
                break

    # 분류·신소재 판정을 한 번만 해서 붙인다
    for r in rows:
        text = (r["title"] or "") + " " + (r["abstract"] or "")
        r["_catKey"], r["_catLabel"] = classify(text, tax)
        r["_newMaterial"] = is_new_material(text, tax)
        r["_words"] = match_words(text, tax)

    out["calls"] = budget.used
    out["endpoints"] = sorted(paths)
    out["errors"] = errors[:20]
    out["truncated"] = budget.stopped
    out["period"] = period
    out["prevPeriod"] = prev_period
    out["companies"] = [{"key": c["key"], "label": c["label"],
                         "isOurs": bool(c.get("isOurs")),
                         "matchedName": c.get("_matched")} for c in tax["companies"]]
    out["categories"] = [{"key": c["key"], "label": c["label"]} for c in tax["categories"]]

    if not rows:
        out["reason"] = ("조회 결과가 0건입니다. 출원인명 표기나 오퍼레이션 파라미터가 "
                         "맞지 않을 수 있습니다. errors 항목을 확인하세요.")
        if raw:
            _dump_raw(raw_sink)
        return out

    # 날짜를 읽을 수 없는 행은 기간 필터에 걸 수 없어 화면에서 쓰지 않는다.
    keep = [r for r in rows if r["date"]]
    out["rows"] = [row_out(r) for r in sorted(keep, key=lambda x: x["date"], reverse=True)]
    out["droppedNoDate"] = len(rows) - len(keep)
    out["status"] = "ok"
    out["reason"] = None
    out["totalRows"] = len(out["rows"])
    if raw:
        _dump_raw(raw_sink)
    return out


def _dump_raw(sink):
    if not sink:
        return
    d = os.path.join(BASE, "tmp")
    if not os.path.isdir(d):
        os.makedirs(d)
    p = os.path.join(d, "kipris-raw.json")
    with io.open(p, "w", encoding="utf-8") as f:
        f.write(json.dumps(sink, ensure_ascii=False, indent=2))
    print("[raw] %s (%d건)" % (p, len(sink)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=3)
    ap.add_argument("--max-calls", type=int, default=CALL_BUDGET)
    ap.add_argument("--out", default=None)
    ap.add_argument("--raw", action="store_true")
    ap.add_argument("--probe", action="store_true")
    a = ap.parse_args()

    res = collect(years=a.years, max_calls=a.max_calls, raw=a.raw, probe_only=a.probe)
    out = a.out or os.path.join(BASE, OUT_REL)
    d = os.path.dirname(out)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with io.open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps(res, ensure_ascii=False, indent=2) + "\n")

    print("status : %s" % res["status"])
    print("calls  : %s" % res.get("calls"))
    print("keyParam: %s" % res.get("keyParamUsed"))
    if res.get("probe"):
        for t in res["probe"].get("tries", []):
            print("  probe %-14s %-52s %s"
                  % (t.get("keyParam"), t.get("path"), t.get("error") or "OK"))
    if res["status"] != "ok":
        print("reason : %s" % res.get("reason"))
        for e in (res.get("errors") or [])[:8]:
            print("  err %s/%s (%s): %s"
                  % (e.get("company"), e.get("variant"), e.get("scope"), e.get("error")))
        print("saved  : %s" % out)
        return 1
    print("rows   : %s" % res.get("totalRows"))
    print("saved  : %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
