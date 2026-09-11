# -*- coding: utf-8 -*-
"""경쟁사 주가 수집 — public/data/stock-quotes.json.

화면(환율 섹션의 2단계 목록/상세)은 이 JSON 만 읽는다. 브라우저에서 Yahoo 를
직접 부르지 않는다.

소스: Yahoo Finance chart API (키 불필요)
  https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=..&interval=..

★ 비공식 엔드포인트다. 키는 없지만 문서화된 약관도 보장된 한도도 없고 언젠가
  막힐 수 있다. 그래서 하루 1회만 돌리고, 실패하면 기존 정상 데이터를 유지하며,
  화면이 조용히 비지 않게 status/reason 을 남긴다.
  (공공 API 는 대안이 못 된다 — 금융위 주식시세정보는 T+1 이라 '현재가'를
   못 주고 미국 상장 SGI 를 커버하지 않는다.)

★★ 심볼은 stocks_taxonomy.json 에서 읽는다. 코드에 박지 않는다.
  접미사를 틀리면 '조용히 틀린 숫자'가 나온다 — 에이스침대를 003800.KS 로
  조회하면 값은 나오는데 전일대비가 -19% 로 엉터리였다(장중 데이터 없는 유령
  심볼). 실제로는 코스닥이라 003800.KQ 다. --resolve 로 확인할 수 있다.

★★★ meta.chartPreviousClose 는 쓰지 않는다. '전일 종가'가 아니라 '조회 구간
  직전 종가'다(코웨이가 range 에 따라 97600/99400 로 달랐다). 등락률은
  meta.regularMarketChangePercent 와 일봉 시계열 계산을 교차검증해서 쓴다.

단독 실행:
    python stock_quotes.py                  # 수집 → public/data/stock-quotes.json
    python stock_quotes.py --probe          # 진단만(파일 안 건드림)
    python stock_quotes.py --resolve 003800 # 심볼 확인(코스피/코스닥 접미사)
    python stock_quotes.py --no-news        # 뉴스 수집 생략
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


def _get(url, params=None, timeout=25, tries=3, headers=None):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=headers or HDR, timeout=timeout)
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001
            last = e
            if i < tries - 1:
                time.sleep(1.5 * (2 ** i))
    raise last


# ── 심볼 확인 ─────────────────────────────────────────────────────────────
def resolve_symbol(cfg, q):
    """Yahoo 검색으로 심볼을 찾는다. 코스피/코스닥 접미사 확인용."""
    r = _get(cfg["yahoo"]["searchBase"], params={"q": q, "quotesCount": 8})
    out = []
    for x in r.json().get("quotes", []):
        if x.get("quoteType") != "EQUITY":
            continue
        out.append({"symbol": x.get("symbol"), "exchange": x.get("exchange"),
                    "name": x.get("longname") or x.get("shortname") or ""})
    return out


# ── 시세 ──────────────────────────────────────────────────────────────────
def _chart(cfg, symbol, rng, interval):
    r = _get(cfg["yahoo"]["chartBase"] + symbol,
             params={"range": rng, "interval": interval})
    j = r.json()
    ch = j.get("chart") or {}
    if ch.get("error"):
        raise ValueError(str((ch["error"] or {}).get("description") or ch["error"])[:140])
    res = ch.get("result")
    if not res:
        raise ValueError("결과가 비어 있습니다")
    return res[0]


def _rows(node, intraday):
    """차트 노드 → [{d|t, c, o, h, l, v}]. 값이 없는 구간은 버린다."""
    ts = node.get("timestamp") or []
    q = ((node.get("indicators") or {}).get("quote") or [{}])[0]
    close = q.get("close") or []
    out = []
    for i, t in enumerate(ts):
        c = close[i] if i < len(close) else None
        if c is None:
            continue
        dt = datetime.datetime.fromtimestamp(t)
        row = {"t" if intraday else "d":
               dt.strftime("%Y-%m-%dT%H:%M") if intraday else dt.strftime("%Y-%m-%d"),
               "c": round(c, 4)}
        for k, src in (("o", "open"), ("h", "high"), ("l", "low")):
            v = (q.get(src) or [None] * len(ts))[i] if i < len(q.get(src) or []) else None
            if v is not None:
                row[k] = round(v, 4)
        v = (q.get("volume") or [None] * len(ts))[i] if i < len(q.get("volume") or []) else None
        if v is not None:
            row["v"] = int(v)
        out.append(row)
    return out


def fetch_one(cfg, co, want_news=True, force_fail=False):
    """한 종목의 시세 + 구간별 시계열 + 뉴스. 실패는 이 종목 안에서 격리한다."""
    sym = co.get("symbol")
    base = {"key": co["key"], "name": co["name"], "symbol": sym,
            "market": co.get("market"), "note": co.get("note"),
            "listed": bool(co.get("listed")), "own": bool(co.get("own"))}
    if co.get("aka"):
        base["aka"] = co["aka"]
    if not co.get("listed") or not sym:
        base.update({"status": "unlisted"})
        return base
    if force_fail:                       # --fail-all : 화면 방어 테스트용
        base.update({"status": "error", "reason": "강제 실패(--fail-all 테스트)"})
        return base

    gap = cfg.get("requestGapSec", 0.8)
    series, errors = {}, []
    meta = None
    for rg in cfg["ranges"]:
        if rg.get("deriveFrom"):
            continue                     # 1개월·3개월은 1년 일봉에서 잘라 쓴다(요청 절약)
        try:
            node = _chart(cfg, sym, rg["range"], rg["interval"])
            if meta is None:
                meta = node.get("meta") or {}
            series[rg["key"]] = _rows(node, rg.get("intraday"))
        except Exception as e:  # noqa: BLE001
            errors.append({"range": rg["key"], "error": str(e)[:140]})
            print("   [%s] %s 구간 실패: %s" % (sym, rg["key"], str(e)[:90]))
        time.sleep(gap)

    daily = series.get("1y") or series.get("3mo") or series.get("1mo") or []
    if meta is None or not daily:
        base.update({"status": "error",
                     "reason": "시세를 받지 못했습니다"
                               + (" (%s)" % errors[0]["error"] if errors else ""),
                     "errors": errors[:4]})
        return base

    now = meta.get("regularMarketPrice")
    if now is None:
        now = daily[-1]["c"]
    # ── 등락률 교차검증 ──────────────────────────────────────────────────
    # (a) meta 값, (b) 일봉 시계열에서 직접 계산. chartPreviousClose 는 안 쓴다.
    closes = [r["c"] for r in daily]
    prev_series = None
    if len(closes) >= 2:
        # 마지막 일봉이 '오늘(장중)'이면 그 직전이 전일 종가다.
        last_d = daily[-1].get("d")
        today = datetime.date.today().isoformat()
        prev_series = closes[-2] if last_d == today else closes[-1]
        if last_d != today and len(closes) >= 2 and abs(closes[-1] - now) < 1e-9:
            prev_series = closes[-2]
    pct_series = (round((now - prev_series) / prev_series * 100.0, 4)
                  if prev_series else None)
    pct_meta = meta.get("regularMarketChangePercent")
    pct_meta = round(pct_meta, 4) if isinstance(pct_meta, (int, float)) else None

    tol = cfg.get("changeTolerancePct", 0.2)
    warn = None
    if pct_meta is not None and pct_series is not None:
        if abs(pct_meta - pct_series) > tol:
            warn = ("전일대비가 두 방식에서 다릅니다 (meta %+.2f%% vs 시계열 %+.2f%%)"
                    % (pct_meta, pct_series))
            print("   [%s] ★ %s" % (sym, warn))
    pct = pct_meta if pct_meta is not None else pct_series
    prev = None
    if pct not in (None, 0) and now is not None:
        prev = round(now / (1 + pct / 100.0), 4)
    elif prev_series:
        prev = prev_series
    change = round(now - prev, 4) if (prev is not None and now is not None) else None

    base.update({
        "status": "ok",
        "longName": meta.get("longName") or meta.get("shortName") or "",
        "currency": meta.get("currency"),
        "exchange": meta.get("exchangeName"),
        "now": round(now, 4),
        "prev": prev,
        "change": change,
        "changePct": pct,
        "changePctMeta": pct_meta,
        "changePctSeries": pct_series,
        "asOf": (datetime.datetime.fromtimestamp(meta["regularMarketTime"]).strftime("%Y-%m-%d %H:%M")
                 if meta.get("regularMarketTime") else (daily[-1].get("d") or None)),
        "dayHigh": meta.get("regularMarketDayHigh"),
        "dayLow": meta.get("regularMarketDayLow"),
        "volume": meta.get("regularMarketVolume"),
        "week52High": meta.get("fiftyTwoWeekHigh"),
        "week52Low": meta.get("fiftyTwoWeekLow"),
        "series": series,
        "spark": [r["c"] for r in (series.get("3mo") or daily)][-63:],
    })
    if warn:
        base["quoteWarning"] = warn
    if errors:
        base["errors"] = errors[:4]
    if want_news:
        base["news"] = _news(cfg, co)
    return base


# ── 뉴스 ──────────────────────────────────────────────────────────────────
def _news(cfg, co):
    """종목별 관련 뉴스(구글 뉴스 RSS, 무키). 실패하면 빈 배열."""
    try:
        from urllib.parse import quote
        q = quote(co["name"] + " 주가")
        url = cfg["newsFeedTemplate"].replace("{q}", q)
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
            out.append({"title": t.strip()[:160], "link": link,
                        "media": media.strip(), "published": (it.findtext("pubDate") or "").strip()})
            if len(out) >= cfg.get("newsPerCompany", 4):
                break
        time.sleep(cfg.get("requestGapSec", 0.8))
        return out
    except Exception as e:  # noqa: BLE001
        print("   [%s] 뉴스 실패: %s" % (co["name"], str(e)[:80]))
        return []


# ── 조립 ──────────────────────────────────────────────────────────────────
def collect(want_news=True, force_fail=False):
    cfg = load_cfg()
    now = datetime.datetime.now(KST)
    rows = []
    for co in cfg["companies"]:
        print("[stock] %s (%s)" % (co["name"], co.get("symbol") or "비상장"))
        rows.append(fetch_one(cfg, co, want_news=want_news, force_fail=force_fail))

    listed = [r for r in rows if r.get("listed")]
    ok = [r for r in listed if r.get("status") == "ok"]
    # ★ 상장 종목이 하나도 안 들어오면 '수집 실패'다. 일부만 실패면 ok 로 두고
    #   그 종목만 화면에서 사유를 보여 준다(전체를 버리지 않는다).
    status = "ok" if ok else "error"
    res = {
        "status": status,
        "generatedAt": now.isoformat(timespec="seconds"),
        "items": rows,
        "ranges": cfg["ranges"],
        "dailyTableRows": cfg.get("dailyTableRows", 30),
        "counts": {"total": len(rows), "listed": len(listed), "ok": len(ok),
                   "failed": len(listed) - len(ok),
                   "unlisted": len(rows) - len(listed)},
        "source": "Yahoo Finance",
        "sourceNote": "지연 시세 — 실시간이 아닙니다",
    }
    if status != "ok":
        res["reason"] = ("주가 조회 일시 불가 — 상장 종목 %d개 모두 시세를 받지 못했습니다"
                         % len(listed))
    return res


def _existing_ok(path):
    """기존 결과가 '쓸 만한 데이터'인지(status ok + 정상 종목 1개 이상)."""
    try:
        with io.open(path, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return None
    if d.get("status") == "ok" and any(
            i.get("status") == "ok" for i in (d.get("items") or [])):
        return d
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    ap.add_argument("--resolve", default=None, help="심볼 확인(종목코드/이름)")
    ap.add_argument("--no-news", action="store_true")
    ap.add_argument("--probe", action="store_true", help="진단만 — 결과 파일을 쓰지 않는다")
    ap.add_argument("--fail-all", action="store_true",
                    help="전부 실패시켜 화면 방어를 테스트한다")
    ap.add_argument("--force", action="store_true", help="실패해도 기존 파일을 덮어쓴다")
    a = ap.parse_args()

    if a.resolve:
        cfg = load_cfg()
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
        print("  ※ 코스피는 .KS, 코스닥은 .KQ 다. 접미사를 틀리면 값은 나오는데")
        print("    전일대비가 엉터리로 나온다(유령 심볼).")
        return 0

    out = a.out or os.path.join(HERE, *OUT_REL.split("/"))
    res = collect(want_news=not a.no_news, force_fail=a.fail_all)

    print()
    print("status : %s" % res["status"])
    c = res["counts"]
    print("종목   : 전체 %d · 정상 %d · 실패 %d · 비상장 %d"
          % (c["total"], c["ok"], c["failed"], c["unlisted"]))
    for i in res["items"]:
        if i.get("status") == "ok":
            print("  %-12s %-10s %12s %-4s %+8.2f (%+.2f%%)%s"
                  % (i["name"], i["symbol"], i["now"], i.get("currency") or "",
                     i.get("change") or 0, i.get("changePct") or 0,
                     "  ★검증경고" if i.get("quoteWarning") else ""))
        elif i.get("status") == "unlisted":
            print("  %-12s %-10s %12s" % (i["name"], "-", "비상장"))
        else:
            print("  %-12s %-10s %s" % (i["name"], i.get("symbol") or "-",
                                        i.get("reason") or "실패"))

    if a.probe and not a.out:
        print("probe  : 진단만 수행 — %s 는 건드리지 않았습니다" % OUT_REL)
        return 0 if res["status"] == "ok" else 1

    # ★ 수집 실패가 배포된 정상 데이터를 덮지 않는다(KIPRIS·환율과 같은 규칙).
    if res["status"] != "ok" and not a.force:
        keep = _existing_ok(out)
        if keep:
            print("reason : %s" % res.get("reason"))
            print("keep   : 기존 정상 데이터(%s)를 유지했습니다 — 덮어쓰지 않음"
                  % keep.get("generatedAt"))
            print("         덮어쓰려면 --force")
            return 1

    d = os.path.dirname(out)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with io.open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps(res, ensure_ascii=False, indent=1) + "\n")
    print("saved  : %s (%.1f KB)" % (out, os.path.getsize(out) / 1024.0))
    return 0 if res["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
