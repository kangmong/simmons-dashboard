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
# ★ 실제 서비스명은 명세 페이지(DBII_000000000000036)에서 확인했다.
#   원문 오타 'Advenced' 가 실제 경로다(국내의 'Sevice' 오타와 같은 부류).
#   설정(kipris_taxonomy.json > foreignApi)으로 뺐으니 여기 값은 기본값일 뿐이다.
SVC_FOREIGN = "ForeignPatentAdvencedSearchService"

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
    # ★ 실측: 유효한 키로 존재하지 않는 서비스를 불러도 31 이 온다. 즉 31 은
    #   '만료'만 뜻하지 않고 '이 키로 이 서비스에 접근할 수 없다'는 뜻이다.
    #   (국내 API 는 같은 키로 정상 동작 → 키 자체가 만료된 것이 아니다)
    "31": (" → 이 키로 해당 API 에 접근할 수 없습니다(미승인·기간만료, 또는 서비스명이"
           " 틀린 경우도 같은 코드). KIPRIS Plus 마이페이지에서 해당 API 신청·승인"
           " 상태와 사용기간을 확인하세요."),
    "32": " → 이번 달 무료 호출 한도(1,000회)를 넘었습니다.",
}

# 한 번 실행에서 쓸 기본 호출 상한. 월 1,000회 / 31일 ≈ 32회.
CALL_BUDGET = 30
ROWS_PER_CALL = 100      # 한 호출에 받을 건수
MAX_PAGES = 3            # 출원인당 최대 페이지(호출 절약 — 최신순이라 앞쪽이 중요)
VARIANTS_PER_CO = 3      # 출원인당 시도할 표기 수(합쳐서 중복 제거한다)
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


def _items(root, tag="item"):
    """응답의 행 목록 → dict 목록. 태그 이름을 그대로 키로 쓴다.
    ★ 국내는 <item>, 해외는 <searchResult> 로 온다(실측). 태그를 인자로 받는다."""
    out = []
    if root is None:
        return out
    for it in root.iter(tag):
        d = {}
        for ch in it:
            t = (ch.text or "").strip()
            if t:
                d[ch.tag] = t
        if d:
            out.append(d)
    return out


# ── 인증/파라미터 형태 진단 ──────────────────────────────────────────────
def probe(key, budget, raw_sink=None, tax_cache=None):
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
    # 해외특허 — 명세에서 확인한 경로·파라미터로 한 번만 확인한다.
    fc = (tax_cache.get("foreignApi") or {}) if tax_cache else {}
    svc = fc.get("service") or SVC_FOREIGN
    op = fc.get("operation") or "applicantSearch"
    ap = fc.get("applicantParam") or "applicant"
    cp = fc.get("collectionParam") or "collectionValues"
    path = "%s/%s" % (svc, op)
    root, err = _get(path, {ap: "Tempur", cp: (fc.get("collections") or ["US"])[0]},
                     key, kp, budget, raw_sink)
    result["tries"].append({"keyParam": kp, "path": path, "error": err})
    if err is None:
        result["foreignOp"] = op
    return result


# ── 검색 ─────────────────────────────────────────────────────────────────
def _dmy(iso):
    """YYYY-MM-DD → YYYYMMDD (KIPRIS 날짜 표기)."""
    return re.sub(r"[^0-9]", "", str(iso or ""))


def search_domestic(applicant, key, key_param, budget, period=None, rows=ROWS_PER_CALL,
                    max_pages=MAX_PAGES, raw_sink=None, ipc=None):
    """국내 특허·실용 — 출원인명 + 출원일 범위로 찾는다.

    ★ 날짜를 API 에 걸어야 한다 — 걸지 않으면 오래된 건부터 채워져, 3년 창을
      화면에서 잘라 봐야 남는 것이 없다. 실측으로 확인한 문법:
        applicationDate=YYYYMMDD~YYYYMMDD
      (시몬스침대 1999~2010 → 22건 / 2011~2026 → 0건 으로 정확히 걸러졌다)
    ★★ applicantNameSearchInfo 는 실측에서 resultCode 10 이다(존재하지 않음).
      호출만 낭비하므로 체인에서 뺐다. getAdvancedSearch → getWordSearch 순.
    ★★★ totalCount 를 보고 필요한 만큼만 페이지를 넘긴다(무료 호출 절약)."""
    dr = None
    if period and period.get("from") and period.get("to"):
        dr = "%s~%s" % (_dmy(period["from"]), _dmy(period["to"]))
    # ★ IPC 도 API 에서 거른다 — 실측으로 코웨이 4,382건이 99건으로 줄어, 페이지
    #   상한에 잘리지 않고 그 분야를 온전히 받을 수 있다.
    #   와일드카드('A47C*')는 0건이 되므로 접두 코드를 그대로 넘긴다.
    ipc_q = " ".join(ipc) if isinstance(ipc, (list, tuple)) else (ipc or "")

    def adv(page):
        q = {"applicant": applicant, "patent": "true", "utility": "true",
             "numOfRows": rows, "pageNo": page, "sortSpec": "AD", "descSort": "true"}
        if dr:
            q["applicationDate"] = dr
        if ipc_q:
            q["ipcNumber"] = ipc_q
        return ("%s/getAdvancedSearch" % SVC_DOMESTIC, q)

    def word(page):
        q = {"word": applicant, "patent": "true", "utility": "true",
             "numOfRows": rows, "pageNo": page}
        if dr:
            q["applicationDate"] = dr
        if ipc_q:
            q["ipcNumber"] = ipc_q
        return ("%s/getWordSearch" % SVC_DOMESTIC, q)

    last = None
    for build in (adv, word):
        path, params = build(1)
        root, err = _get(path, params, key, key_param, budget, raw_sink)
        if err:
            last = err
            if budget.stopped:
                break
            continue
        got = _items(root)
        total = 0
        try:
            total = int((root.findtext(".//totalCount") or "0").strip() or 0)
        except ValueError:
            total = 0
        # 남은 페이지는 totalCount 가 알려 준 만큼만 넘긴다
        pages = min(max_pages, (total + rows - 1) // rows if total else 1)
        for pg in range(2, pages + 1):
            if budget.stopped:
                break
            p2, q2 = build(pg)
            r2, e2 = _get(p2, q2, key, key_param, budget, raw_sink)
            if e2:
                last = e2
                break
            more = _items(r2)
            if not more:
                break
            got.extend(more)
        return got, path, (None if got else last)
    return [], None, last


def search_foreign(applicant, key, key_param, cfg, budget, raw_sink=None):
    """해외특허 — 출원인명 + 국가코드(collectionValues)로 찾는다.

    ★ 파라미터는 KIPRIS 샘플 폼과 같다(applicant + collectionValues). 그 조합으로
      KIPRIS 자체 테스트베드에서는 실제 데이터가 나온다.
    ★★ 국가코드는 한 번에 하나씩 부른다 — 'US,EP' 처럼 묶어 보내면 거부된다(실측).
    ★★★ 성공 시 resultCode 가 빈 값이고 행 태그가 searchResult 다(국내와 다르다)."""
    svc = cfg.get("service") or SVC_FOREIGN
    op = cfg.get("operation") or "applicantSearch"
    ap = cfg.get("applicantParam") or "applicant"
    cp = cfg.get("collectionParam") or "collectionValues"
    tag = cfg.get("rowTag") or "searchResult"
    path = "%s/%s" % (svc, op)
    out, last = [], None
    for cv in (cfg.get("collections") or ["US"]):
        if budget.stopped:
            break
        root, err = _get(path, {ap: applicant, cp: cv}, key, key_param, budget, raw_sink)
        if err:
            last = err
            continue
        out.extend(_items(root, tag))
    return out, path, (None if out else last)


# ── 항목 정규화 ──────────────────────────────────────────────────────────
DATE_KEYS = ("applicationDate", "appDate", "applicationDay", "openDate", "publicationDate")
NUM_KEYS = ("applicationNumber", "appNumber", "applicationNo")
TITLE_KEYS = ("inventionTitle", "inventionName", "title", "inventionTitleEng")
ABST_KEYS = ("astrtCont", "abstract", "abstractContent", "astrtContEng")
APPL_KEYS = ("applicantName", "applicant", "applicantNameEng")
KIND_KEYS = ("registerStatus", "applicationStatus", "documentKind", "patentUtility")
COUNTRY_KEYS = ("nationCode", "countryCode", "nation", "country")
IPC_KEYS = ("ipcNumber", "ipcCode", "ipc")


def accepts(applicant_name, co):
    """응답의 실제 출원인명이 '그 회사'인지 검증한다.
    ★ KIPRIS 출원인 검색은 부분일치라 무관한 기업이 섞여 온다(실측):
        '템퍼'   → 주식회사 템퍼스 · 비티알 뉴 머티리얼(배터리 소재)
        '씰리'   → 씰리아떼끄
        '퍼시스' → 코니퍼 시스템즈 · 넥스젠 웨이퍼 시스템즈
      검색 결과를 그대로 세면 남의 특허가 우리 그래프에 올라간다.
    ★★ 공백을 지우고 비교하지 않는다 — '코니퍼 시스템즈'에서 공백을 지우면
      '퍼시스'를 품게 되어 오히려 오탐이 생긴다. 원문 그대로 부분일치를 본다."""
    nm = str(applicant_name or "")
    if not nm:
        return False
    for bad in (co.get("reject") or []):
        if bad and bad in nm:
            return False
    acc = co.get("accept") or [co.get("label") or ""]
    return any(a and a in nm for a in acc)


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
        ("applicantRaw", _pick(raw, APPL_KEYS)),   # 실제 출원인명 — 매칭 검증용
        ("isOurs", bool(company.get("isOurs"))),
        ("scope", scope),                                  # 'kr' | 'abroad'
        ("country", (_pick(raw, COUNTRY_KEYS) or ("KR" if scope == "kr" else "")).upper()),
        ("title", title),
        ("abstract", abst[:400]),
        ("kind", _pick(raw, KIND_KEYS)),
        ("ipc", _pick(raw, IPC_KEYS)),
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
        ("applicantRaw", r["applicantRaw"]),
        ("isOurs", r["isOurs"]), ("scope", r["scope"]), ("country", r["country"]),
        ("kind", r["kind"] or "미표기"),
        ("ipc", r["ipc"]),
        ("catKey", r["_catKey"]), ("catLabel", r["_catLabel"]),
        ("newMaterial", r["_newMaterial"]),
        ("title", r["title"]), ("summary", (r["abstract"] or "")[:200]),
        ("words", r["_words"]),
    ])


# ── 수집 본체 ────────────────────────────────────────────────────────────
def collect(years=None, max_calls=CALL_BUDGET, raw=False, probe_only=False):
    tax = load_taxonomy()
    ipcf = tax.get("ipcFilter") or {}
    ipc = (ipcf.get("codes") or []) if ipcf.get("enabled") else []
    if years is None:
        years = int(tax.get("defaultYears") or 3)
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

    pr = probe(key, budget, raw_sink, tax_cache=tax)
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

    # 화면 기본 기간(period)과, 전년 동기 비교분까지 담는 수집 기간(fetch_period).
    # ★ API 에 날짜를 걸면 그 범위 밖은 아예 오지 않는다. 화면이 '전년 동기'를
    #   계산하려면 한 해 더 앞까지 받아 둬야 한다 — 안 받으면 증감이 늘 0 이 된다.
    frm = now.replace(year=now.year - years)
    period = {"from": frm.isoformat(), "to": now.isoformat()}
    ffrm = now.replace(year=now.year - years - 1)
    fetch_period = {"from": ffrm.isoformat(), "to": now.isoformat()}
    pfrm = frm.replace(year=frm.year - 1)
    pto = now.replace(year=now.year - 1)
    prev_period = {"from": pfrm.isoformat(), "to": pto.isoformat()}

    rows, errors, paths = [], [], set()
    dropped = {}          # 부분일치로 섞여 왔다가 걸러진 건수(회사별)
    for co in tax["companies"]:
        got = []
        used_variant = None
        # ★ 표기별 결과를 '합친다'. 첫 표기에서 멈추면 안 된다 — 실측에서 시몬스는
        #   '시몬스침대'(1999~2010)와 '주식회사 시몬스'(최근)가 서로 다른 표기로
        #   등록돼 있어, 먼저 맞은 하나에서 멈추면 최근 건이 통째로 빠졌다.
        #   accept 검증이 남의 특허를 걸러 주므로 합쳐도 안전하다.
        seen_no = set()
        matched = []
        for variant in co["variants"][:VARIANTS_PER_CO]:
            if budget.stopped:
                break
            items, path, err = search_domestic(variant, key, pr["keyParam"], budget,
                                               period=fetch_period, raw_sink=raw_sink,
                                               ipc=ipc)
            if err:
                errors.append({"company": co["label"], "variant": variant,
                               "scope": "kr", "error": err})
            if path:
                paths.add(path)
            # ★ 검색이 물어 온 것 중 '그 회사'만 남긴다
            kept = [it for it in items if accepts(_pick(it, APPL_KEYS), co)]
            dropped[co["label"]] = dropped.get(co["label"], 0) + (len(items) - len(kept))
            fresh = 0
            for it in kept:
                no = _pick(it, NUM_KEYS)
                if no and no in seen_no:
                    continue          # 표기가 달라도 같은 출원은 한 번만 센다
                if no:
                    seen_no.add(no)
                got.append(it)
                fresh += 1
            if fresh:
                matched.append(variant)
        used_variant = ", ".join(matched) if matched else None
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
                                                  tax.get("foreignApi") or {}, budget,
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
    # 부분일치로 섞여 온 뒤 걸러진 건수 — 0 이 아니면 accept/reject 를 손볼 신호다.
    out["filteredOut"] = {k: v for k, v in dropped.items() if v}
    out["truncated"] = budget.stopped
    out["period"] = period
    out["prevPeriod"] = prev_period
    out["fetchPeriod"] = fetch_period
    out["ipcFilter"] = {"enabled": bool(ipc), "codes": ipc,
                        "label": ipcf.get("label") or ""}
    out["years"] = years
    out["foreignAvailable"] = bool(pr.get("foreignOp"))
    out["foreignNote"] = (None if pr.get("foreignOp") else
                          "해외특허 데이터 수집 대기 중 — 호출 경로는 확인했고"
                          "(ForeignPatentAdvencedSearchService/applicantSearch),"
                          " KIPRIS 자체 테스트베드에서는 같은 파라미터로 실데이터가"
                          " 나오지만 현재 키로는 resultCode 10 이 떠 수집되지 않습니다."
                          " 아래 수치는 국내 출원만 집계한 것이며, 해외 출원 비율은"
                          " 0%로 표시됩니다.")
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
    ap.add_argument("--years", type=int, default=None,
                    help="조회 기간(년). 생략하면 설정의 defaultYears")
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
