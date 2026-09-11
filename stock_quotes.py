# -*- coding: utf-8 -*-
"""경쟁사 주가 + 환율 캔들 수집.

출력 2종:
  public/data/stock-quotes.json   목록용 — 현재가·등락·스파크라인 (작다)
  public/data/stocks/<key>.json   상세용 — 캔들 OHLCV 3종 + 종목정보 + 뉴스
                                  (브라우저는 상세를 열 때만 읽는다)

소스: Yahoo Finance (키 불필요)
  · 캔들   /v8/finance/chart/{symbol}?range=..&interval=..   (무인증)
  · 종목정보 /v10/finance/quoteSummary/{symbol}?modules=..     (쿠키→crumb 필요)

★ 비공식 엔드포인트다. 문서화된 약관도 보장된 한도도 없고 언젠가 막힐 수 있다.
  그래서 하루 1회만 돌리고, 실패하면 기존 정상 데이터를 유지하며, 화면이
  조용히 비지 않게 status/reason 을 남긴다.

★★ 종목정보(quoteSummary)는 crumb 이 필요해서 러너 환경에서 막힐 수 있다
  (FRED 가 Actions IP 에서 통째로 막힌 전례가 있다). 막히면 그 종목의
  profile 만 비우고 캔들·시세는 그대로 저장한다 — 화면에서는 '종목정보' 탭만
  빠지고 차트는 정상 동작한다.

★★★ 심볼은 stocks_taxonomy.json 에서 읽는다. 접미사를 틀리면 '조용히 틀린
  숫자'가 나온다(에이스침대 003800.KS → 전일대비 -19%). --resolve 로 확인.

★★★★ meta.chartPreviousClose 는 쓰지 않는다. '전일 종가'가 아니라 '조회 구간
  직전 종가'다. 등락률은 meta.regularMarketChangePercent 와 일봉 계산을
  교차검증해서 쓴다.

단독 실행:
    python stock_quotes.py                  # 전체 수집
    python stock_quotes.py --probe          # 진단만(파일 안 건드림)
    python stock_quotes.py --resolve 003800 # 심볼 확인
    python stock_quotes.py --no-news        # 뉴스 생략
    python stock_quotes.py --no-profile     # 종목정보 생략(crumb 안 씀)
    python stock_quotes.py --only coway     # 한 종목만
    python stock_quotes.py --fail-all       # 전부 실패시켜 화면 방어 테스트
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

import requests

for _s in ("stdout", "stderr"):
    _f = getattr(sys, _s, None)
    if hasattr(_f, "reconfigure"):
        try:
            _f.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_REL = "public/data/stock-quotes.json"
CFG_REL = "stocks_taxonomy.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
HDR = {"User-Agent": UA}
KST = datetime.timezone(datetime.timedelta(hours=9))


def load_cfg():
    with io.open(os.path.join(HERE, CFG_REL), encoding="utf-8") as f:
        return json.load(f)


def _get(url, params=None, timeout=25, tries=3, session=None, headers=None):
    last = None
    g = (session or requests).get
    for i in range(tries):
        try:
            r = g(url, params=params, headers=headers or HDR, timeout=timeout)
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001
            last = e
            if i < tries - 1:
                time.sleep(1.5 * (2 ** i))
    raise last


# ── crumb 세션 (종목정보 전용) ────────────────────────────────────────────
def make_crumb_session():
    """쿠키를 받고 crumb 을 얻는다. 실패하면 (None, 이유)."""
    s = requests.Session()
    s.headers.update(HDR)
    try:
        try:
            s.get("https://fc.yahoo.com", timeout=20)
        except Exception:  # noqa: BLE001 — 404 여도 쿠키는 심긴다
            pass
        if not s.cookies:
            s.get("https://finance.yahoo.com/", timeout=25)
        r = s.get("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=25)
        crumb = (r.text or "").strip()
        if r.status_code != 200 or not crumb or len(crumb) > 64 or "<" in crumb:
            return None, "crumb 획득 실패 (HTTP %s)" % r.status_code
        return (s, crumb), None
    except Exception as e:  # noqa: BLE001
        return None, "crumb 획득 실패: %s" % str(e)[:110]


# ── 심볼 확인 ─────────────────────────────────────────────────────────────
def resolve_symbol(cfg, q):
    r = _get(cfg["yahoo"]["searchBase"], params={"q": q, "quotesCount": 8})
    return [{"symbol": x.get("symbol"), "exchange": x.get("exchange"),
             "name": x.get("longname") or x.get("shortname") or ""}
            for x in r.json().get("quotes", []) if x.get("quoteType") == "EQUITY"]


# ── 캔들 ──────────────────────────────────────────────────────────────────
def _chart(cfg, symbol, rng, interval):
    r = _get(cfg["yahoo"]["chartBase"] + symbol,
             params={"range": rng, "interval": interval})
    ch = r.json().get("chart") or {}
    if ch.get("error"):
        raise ValueError(str((ch["error"] or {}).get("description") or ch["error"])[:140])
    res = ch.get("result")
    if not res:
        raise ValueError("결과가 비어 있습니다")
    return res[0]


def _candles(node, scale=1):
    """[[날짜, 시, 고, 저, 종, 거래량], ...]. 종가가 없는 봉은 버린다.
       ★ 배열로 저장한다 — 봉마다 키 이름이 반복되지 않아 파일이 절반 이하다."""
    ts = node.get("timestamp") or []
    q = ((node.get("indicators") or {}).get("quote") or [{}])[0]
    cl = q.get("close") or []
    op, hi, lo, vo = (q.get("open") or []), (q.get("high") or []), \
                     (q.get("low") or []), (q.get("volume") or [])

    def at(arr, i, mul=True):
        v = arr[i] if i < len(arr) else None
        if v is None:
            return None
        return round(v * scale, 4) if mul else int(v)

    out = []
    for i, t in enumerate(ts):
        c = at(cl, i)
        if c is None:
            continue
        d = datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%d")
        out.append([d, at(op, i), at(hi, i), at(lo, i), c, at(vo, i, mul=False)])
    return out


# ── 종목정보 ──────────────────────────────────────────────────────────────
def _raw(o):
    if isinstance(o, dict) and o and set(o.keys()) <= {"raw", "fmt", "longFmt"}:
        return o.get("raw")
    return o


def _dig(res, path):
    cur = res
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return _raw(cur)


def fetch_profile(cfg, sess, symbol):
    """quoteSummary → 화이트리스트 필드만. 값이 없는 필드는 아예 담지 않는다
       (화면에서 '자리'까지 빼려면 키가 없어야 한다)."""
    s, crumb = sess
    r = _get("https://query1.finance.yahoo.com/v10/finance/quoteSummary/" + symbol,
             params={"modules": cfg["profileModules"], "crumb": crumb},
             timeout=30, tries=2, session=s)
    res = ((r.json().get("quoteSummary") or {}).get("result") or [{}])[0]
    if not res:
        raise ValueError("quoteSummary 결과가 비어 있습니다")
    out = {}
    for group, fields in cfg["profileFields"].items():
        g = {}
        for name, path, kind in fields:
            v = _dig(res, path)
            if v is None or v == "":
                continue                      # ★ 없는 항목은 키를 만들지 않는다
            if kind == "int":
                try:
                    v = int(v)
                except (TypeError, ValueError):
                    continue
            elif kind == "num":
                try:
                    v = round(float(v), 6)
                except (TypeError, ValueError):
                    continue
            else:
                v = str(v).strip()
                if not v:
                    continue
            g[name] = v
        if g:
            out[group] = g
    # 대표이사만 따로 — 임원 전체를 늘어놓지 않는다
    offs = _dig(res, "assetProfile.companyOfficers")
    if isinstance(offs, list):
        heads = [o for o in offs
                 if isinstance(o, dict) and o.get("name")
                 and re.search(r"CEO|Chief Executive|대표", str(o.get("title") or ""), re.I)
                 # ★ President 만으로 잡으면 'Vice President'(부사장)까지 걸린다.
                 #   실제로 코웨이에서 마케팅 부사장이 대표이사로 나왔다.
                 and not re.search(r"Vice\s*President", str(o.get("title") or ""), re.I)]
        if heads:
            out.setdefault("identity", {})["ceo"] = ", ".join(
                "%s (%s)" % (h["name"].strip(), (h.get("title") or "").strip()) for h in heads[:2])
    return out


# ── 뉴스 ──────────────────────────────────────────────────────────────────
def _news(cfg, name):
    try:
        from urllib.parse import quote
        url = cfg["newsFeedTemplate"].replace("{q}", quote(name + " 주가"))
        r = _get(url, tries=2)
        root = ET.fromstring(r.text.encode("utf-8"))
        out = []
        for it in root.iter("item"):
            t = (it.findtext("title") or "").strip()
            link = (it.findtext("link") or "").strip()
            if not t or not link:
                continue
            media = (it.findtext("source") or "").strip()
            if " - " in t:
                t, media = t.rsplit(" - ", 1)
            out.append({"title": t.strip()[:160], "link": link, "media": media.strip(),
                        "published": (it.findtext("pubDate") or "").strip()})
            if len(out) >= cfg.get("newsPerCompany", 4):
                break
        return out
    except Exception as e:  # noqa: BLE001
        print("   뉴스 실패: %s" % str(e)[:80])
        return []


# ── 한 종목 ───────────────────────────────────────────────────────────────
def _quote_from(meta, daily, cfg, sym):
    """현재가·전일대비. 등락률을 두 방식으로 구해 교차검증한다."""
    now = meta.get("regularMarketPrice")
    if now is None:
        now = daily[-1][4]
    closes = [c[4] for c in daily]
    last_d = daily[-1][0]
    today = datetime.date.today().isoformat()
    prev_series = None
    if len(closes) >= 2:
        prev_series = closes[-2] if last_d == today else closes[-1]
        if last_d != today and abs(closes[-1] - now) < 1e-9:
            prev_series = closes[-2]
    pct_series = (round((now - prev_series) / prev_series * 100.0, 4)
                  if prev_series else None)
    pm = meta.get("regularMarketChangePercent")
    pct_meta = round(pm, 4) if isinstance(pm, (int, float)) else None
    warn = None
    tol = cfg.get("changeTolerancePct", 0.2)
    if pct_meta is not None and pct_series is not None and abs(pct_meta - pct_series) > tol:
        warn = ("전일대비가 두 방식에서 다릅니다 (meta %+.2f%% vs 시계열 %+.2f%%)"
                % (pct_meta, pct_series))
        print("   [%s] ★ %s" % (sym, warn))
    pct = pct_meta if pct_meta is not None else pct_series
    prev = None
    if pct not in (None, 0) and now is not None:
        prev = round(now / (1 + pct / 100.0), 4)
    elif prev_series:
        prev = prev_series
    return {
        "now": round(now, 4), "prev": prev,
        "change": round(now - prev, 4) if prev is not None else None,
        "changePct": pct, "changePctMeta": pct_meta, "changePctSeries": pct_series,
        "asOf": (datetime.datetime.fromtimestamp(meta["regularMarketTime"]).strftime("%Y-%m-%d %H:%M")
                 if meta.get("regularMarketTime") else last_d),
    }, warn


def fetch_one(cfg, co, sess=None, want_news=True, force_fail=False):
    """한 종목 → (목록행, 상세dict). 실패는 이 종목 안에서 격리한다."""
    sym = co.get("symbol")
    row = {"key": co["key"], "name": co["name"], "symbol": sym,
           "market": co.get("market"), "note": co.get("note"),
           "listed": bool(co.get("listed")), "own": bool(co.get("own"))}
    if co.get("aka"):
        row["aka"] = co["aka"]
    if not co.get("listed") or not sym:
        row["status"] = "unlisted"
        return row, None
    if force_fail:
        row.update({"status": "error", "reason": "강제 실패(--fail-all 테스트)"})
        return row, None

    gap = cfg.get("requestGapSec", 0.8)
    scale = co.get("scale", 1) or 1
    candles, meta, errors = {}, None, []
    for rg in cfg["candleRanges"]:
        try:
            node = _chart(cfg, sym, rg["range"], rg["interval"])
            if meta is None:
                meta = node.get("meta") or {}
            candles[rg["key"]] = _candles(node, scale)
        except Exception as e:  # noqa: BLE001
            errors.append({"range": rg["key"], "error": str(e)[:140]})
            print("   [%s] %s 실패: %s" % (sym, rg["key"], str(e)[:85]))
        time.sleep(gap)

    daily = candles.get("1d") or candles.get("1wk") or candles.get("1mo") or []
    if meta is None or not daily:
        row.update({"status": "error",
                    "reason": "시세를 받지 못했습니다"
                              + (" (%s)" % errors[0]["error"] if errors else ""),
                    "errors": errors[:4]})
        return row, None

    q, warn = _quote_from(meta, daily, cfg, sym)
    row.update({"status": "ok", "currency": meta.get("currency"),
                "exchange": meta.get("exchangeName"),
                "longName": meta.get("longName") or meta.get("shortName") or "",
                "week52High": meta.get("fiftyTwoWeekHigh"),
                "week52Low": meta.get("fiftyTwoWeekLow")})
    row.update(q)
    row["spark"] = [c[4] for c in daily][-63:]
    if warn:
        row["quoteWarning"] = warn

    detail = {"key": co["key"], "name": co["name"], "symbol": sym,
              "market": co.get("market"), "note": co.get("note"),
              "generatedAt": datetime.datetime.now(KST).isoformat(timespec="seconds"),
              "currency": meta.get("currency"), "exchange": meta.get("exchangeName"),
              "candles": candles, "candleFormat": cfg["candleFormat"],
              "maPeriods": cfg["maPeriods"], "ranges": cfg["candleRanges"],
              "quote": q, "source": "Yahoo Finance"}
    if co.get("aka"):
        detail["aka"] = co["aka"]
    if warn:
        detail["quoteWarning"] = warn
    if errors:
        detail["candleErrors"] = errors[:4]

    if sess:
        try:
            prof = fetch_profile(cfg, sess, sym)
            if prof:
                detail["profile"] = prof
                print("   [%s] 종목정보 %d개 그룹" % (sym, len(prof)))
        except Exception as e:  # noqa: BLE001
            # ★ 종목정보만 실패 — 캔들·시세는 그대로 둔다(화면은 탭만 빠진다)
            detail["profileError"] = str(e)[:160]
            print("   [%s] 종목정보 실패(캔들은 정상): %s" % (sym, str(e)[:90]))
        time.sleep(gap)
    if want_news:
        detail["news"] = _news(cfg, co["name"])
        time.sleep(gap)
    return row, detail


def fetch_currency(cfg, cu, force_fail=False):
    """환율 캔들. Frankfurter 는 종가만 줘서 캔들이 안 되므로 Yahoo FX 를 쓴다."""
    if force_fail:
        return {"key": cu["key"], "status": "error",
                "reason": "강제 실패(--fail-all 테스트)"}
    gap = cfg.get("requestGapSec", 0.8)
    scale = cu.get("scale", 1) or 1
    candles, meta, errors = {}, None, []
    for rg in cfg["candleRanges"]:
        try:
            node = _chart(cfg, cu["symbol"], rg["range"], rg["interval"])
            if meta is None:
                meta = node.get("meta") or {}
            candles[rg["key"]] = _candles(node, scale)
        except Exception as e:  # noqa: BLE001
            errors.append({"range": rg["key"], "error": str(e)[:140]})
            print("   [%s] %s 실패: %s" % (cu["symbol"], rg["key"], str(e)[:85]))
        time.sleep(gap)
    if not candles.get("1d"):
        return {"key": cu["key"], "status": "error",
                "reason": "환율 캔들을 받지 못했습니다", "errors": errors[:3]}
    return {
        "key": cu["key"], "status": "ok", "name": cu["name"], "unit": cu["unit"],
        "symbol": cu["symbol"], "scale": scale,
        "generatedAt": datetime.datetime.now(KST).isoformat(timespec="seconds"),
        "candles": candles, "candleFormat": cfg["candleFormat"],
        "maPeriods": cfg["maPeriods"], "ranges": cfg["candleRanges"],
        "source": "Yahoo Finance (지연 시세)",
        "sourceNote": ("캔들은 Yahoo 지연 시세입니다. 카드·일별 시세·AI 해석의 "
                       "ECB 기준환율과는 값이 조금 다를 수 있습니다."),
        "errors": errors[:3] or None,
    }


# ── 조립 ──────────────────────────────────────────────────────────────────
def collect(want_news=True, want_profile=True, force_fail=False, only=None):
    cfg = load_cfg()
    now = datetime.datetime.now(KST)
    sess, sess_err = (None, None)
    if want_profile and not force_fail:
        sess, sess_err = make_crumb_session()
        print("[stock] 종목정보 세션: %s" % ("준비됨" if sess else sess_err))

    rows, details = [], {}
    for co in cfg["companies"]:
        if only and co["key"] not in only:
            continue
        print("[stock] %s (%s)" % (co["name"], co.get("symbol") or "비상장"))
        row, det = fetch_one(cfg, co, sess=sess, want_news=want_news, force_fail=force_fail)
        rows.append(row)
        if det:
            details[co["key"]] = det

    curs = []
    for cu in cfg["currencies"]:
        if only and cu["key"] not in only:
            continue
        print("[stock] 환율 %s (%s)" % (cu["name"], cu["symbol"]))
        c = fetch_currency(cfg, cu, force_fail=force_fail)
        curs.append(c)
        if c.get("status") == "ok":
            details["cur-" + cu["key"]] = c

    listed = [r for r in rows if r.get("listed")]
    ok = [r for r in listed if r.get("status") == "ok"]
    status = "ok" if ok else "error"
    res = {
        "status": status,
        "generatedAt": now.isoformat(timespec="seconds"),
        "items": rows,
        "currencies": [{"key": c["key"], "status": c.get("status"),
                        "reason": c.get("reason")} for c in curs],
        "ranges": cfg["candleRanges"],
        "dailyTableRows": cfg.get("dailyTableRows", 30),
        "detailDir": cfg["detailDirRel"],
        "counts": {"total": len(rows), "listed": len(listed), "ok": len(ok),
                   "failed": len(listed) - len(ok),
                   "unlisted": len(rows) - len(listed)},
        "profileSession": "ok" if sess else (sess_err or "생략"),
        "source": "Yahoo Finance",
        "sourceNote": "지연 시세 — 실시간이 아닙니다",
    }
    if status != "ok":
        res["reason"] = ("주가 조회 일시 불가 — 상장 종목 %d개 모두 시세를 받지 못했습니다"
                         % len(listed))
    return res, details


def _existing_ok(path):
    try:
        with io.open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    if d.get("status") == "ok" and any(i.get("status") == "ok" for i in (d.get("items") or [])):
        return d
    return None


def _write(path, obj, compact_lists=True):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    txt = json.dumps(obj, ensure_ascii=False, indent=1)
    if compact_lists:
        # 캔들 배열 한 줄로 — 봉마다 6줄씩 늘어나는 것을 막는다
        txt = re.sub(r"\[\s+(\"20\d\d-\d\d-\d\d\",)\s+([^\[\]]*?)\s+\]",
                     lambda m: "[" + m.group(1) + " " + re.sub(r"\s+", " ", m.group(2)) + "]",
                     txt)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(txt + "\n")
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    ap.add_argument("--resolve", default=None, help="심볼 확인(종목코드/이름)")
    ap.add_argument("--no-news", action="store_true")
    ap.add_argument("--no-profile", action="store_true", help="종목정보 생략(crumb 안 씀)")
    ap.add_argument("--only", default=None, help="쉼표로 구분한 key 만 수집")
    ap.add_argument("--probe", action="store_true", help="진단만 — 결과 파일을 쓰지 않는다")
    ap.add_argument("--fail-all", action="store_true", help="전부 실패시켜 화면 방어 테스트")
    ap.add_argument("--force", action="store_true", help="실패해도 기존 파일을 덮어쓴다")
    a = ap.parse_args()
    cfg = load_cfg()

    if a.resolve:
        try:
            hits = resolve_symbol(cfg, a.resolve)
        except Exception as e:  # noqa: BLE001
            print("검색 실패: %s" % e)
            return 1
        if not hits:
            print("'%s' 에 해당하는 종목을 찾지 못했습니다" % a.resolve)
            return 1
        print("'%s' 검색 결과:" % a.resolve)
        for h in hits:
            print("  %-12s %-8s %s" % (h["symbol"], h["exchange"], h["name"]))
        print("  ※ 코스피 .KS / 코스닥 .KQ. 접미사를 틀리면 값은 나오는데")
        print("    전일대비가 엉터리로 나온다(유령 심볼).")
        return 0

    out = a.out or os.path.join(HERE, *OUT_REL.split("/"))
    only = set(x.strip() for x in a.only.split(",")) if a.only else None
    res, details = collect(want_news=not a.no_news, want_profile=not a.no_profile,
                           force_fail=a.fail_all, only=only)

    print()
    print("status : %s" % res["status"])
    c = res["counts"]
    print("종목   : 전체 %d · 정상 %d · 실패 %d · 비상장 %d"
          % (c["total"], c["ok"], c["failed"], c["unlisted"]))
    for i in res["items"]:
        if i.get("status") == "ok":
            det = details.get(i["key"]) or {}
            pf = "정보O" if det.get("profile") else "정보X"
            nb = sum(len(v) for v in (det.get("candles") or {}).values())
            print("  %-12s %-10s %12s %-4s %+8.2f (%+.2f%%)  캔들%4d  %s%s"
                  % (i["name"], i["symbol"], i["now"], i.get("currency") or "",
                     i.get("change") or 0, i.get("changePct") or 0, nb, pf,
                     "  ★검증경고" if i.get("quoteWarning") else ""))
        elif i.get("status") == "unlisted":
            print("  %-12s %-10s %12s" % (i["name"], "-", "비상장"))
        else:
            print("  %-12s %-10s %s" % (i["name"], i.get("symbol") or "-",
                                        i.get("reason") or "실패"))
    for cc in res["currencies"]:
        det = details.get("cur-" + cc["key"]) or {}
        nb = sum(len(v) for v in (det.get("candles") or {}).values())
        print("  환율 %-8s %s  캔들 %d봉" % (cc["key"], cc.get("status"), nb))
    print("종목정보 세션: %s" % res.get("profileSession"))

    if a.probe and not a.out:
        print("probe  : 진단만 수행 — %s 는 건드리지 않았습니다" % OUT_REL)
        return 0 if res["status"] == "ok" else 1

    # ★ 수집 실패가 배포된 정상 데이터를 덮지 않는다.
    if res["status"] != "ok" and not a.force:
        keep = _existing_ok(out)
        if keep:
            print("reason : %s" % res.get("reason"))
            print("keep   : 기존 정상 데이터(%s)를 유지했습니다 — 덮어쓰지 않음"
                  % keep.get("generatedAt"))
            print("         덮어쓰려면 --force")
            return 1

    # ★ --only 는 개발용이다. 일부 종목만 담긴 결과로 목록 파일을 덮으면
    #   배포 화면의 리스트가 그 종목만 남는다(실제로 9개가 1개로 줄었다).
    #   --only 일 때는 상세 파일만 쓰고 목록 파일은 건드리지 않는다.
    if only:
        print("only   : 목록 파일(%s)은 건드리지 않았습니다 — 상세만 씁니다" % OUT_REL)
    else:
        sz = _write(out, res, compact_lists=False)
        print("saved  : %s (%.1f KB)" % (out, sz / 1024.0))
    ddir = os.path.join(HERE, *cfg["detailDirRel"].split("/"))
    tot = 0
    for key, det in sorted(details.items()):
        p = os.path.join(ddir, key + ".json")
        tot += _write(p, det)
    if details:
        print("detail : %s/ 에 %d개 파일 (%.1f KB)"
              % (cfg["detailDirRel"], len(details), tot / 1024.0))
    return 0 if res["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
