# -*- coding: utf-8 -*-
"""글로벌 매트리스 시장 규모 — Global Market Insights 공개 요약 파싱.

로그인·결제 없이 보이는 본문 텍스트만 읽는다. 페이지는 순수 HTML 이라
자바스크립트를 실행하지 않아도 숫자가 들어 있다(2026-09 확인).

★ 실패해도 기존 캐시를 덮어쓰지 않는다.
  - 필수 항목(최근년도 규모·전망·CAGR)을 하나라도 못 뽑으면 기존 파일을 그대로
    두고 last_error 와 last_attempt 만 갱신한다.
  - 네트워크 오류도 같다. '값이 사라진 JSON' 을 만들지 않는 것이 이 파일의 규칙이다.

사용:
  python mattress_market.py            # 수집 → public/data/global-mattress-market.json
  python mattress_market.py --print    # 파싱 결과만 찍어 보고 파일은 안 건드림
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

URL = 'https://www.gminsights.com/industry-analysis/mattress-market'
OUT = os.path.join('public', 'data', 'global-mattress-market.json')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
KST = timezone(timedelta(hours=9))

# 조사기관마다 값이 다르다는 사실을 화면에 적기 위한 대조표(수기 입력, 출처 명시).
OTHER_ESTIMATES = [
    {'org': 'Global Market Insights', 'value': '$458억', 'year': 2025, 'self': True},
    {'org': 'MRFR', 'value': '$577억', 'year': 2025},
    {'org': 'Grand View Research', 'value': '$492억', 'year': 2025},
]


def fetch(url: str, timeout: int = 40) -> str:
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return raw.decode('utf-8', 'replace')


def to_text(html: str) -> str:
    t = re.sub(r'<script[\s\S]*?</script>|<style[\s\S]*?</style>', ' ', html)
    t = re.sub(r'<[^>]+>', ' ', t)
    t = t.replace('&nbsp;', ' ').replace('&#160;', ' ').replace('&amp;', '&')
    return re.sub(r'\s+', ' ', t)


def _f(x):
    return float(x)


def parse(text: str) -> dict:
    """공개 요약에서 뽑을 수 있는 것만 뽑는다. 못 뽑은 항목은 키를 만들지 않는다."""
    out: dict = {}

    m = re.search(r'valued at USD ([\d.]+) billion in (\d{4})', text)
    if m:
        out['base'] = {'usdBn': _f(m.group(1)), 'year': int(m.group(2))}

    m = re.search(r'increase from USD ([\d.]+) billion in (\d{4})'
                  r' to USD ([\d.]+) billion by (\d{4})', text)
    if m:
        out['next'] = {'usdBn': _f(m.group(1)), 'year': int(m.group(2))}
        out['target'] = {'usdBn': _f(m.group(3)), 'year': int(m.group(4))}

    m = re.search(r'CAGR \((\d{4})[–\-](\d{4})\) ([\d.]+)%', text)
    if m:
        out['cagr'] = {'pct': _f(m.group(3)), 'from': int(m.group(1)), 'to': int(m.group(2))}
    else:
        m = re.search(r'([\d.]+)% CAGR', text)
        if m:
            out['cagr'] = {'pct': _f(m.group(1))}

    m = re.search(r'([A-Z][\w\s.&\'-]{2,40}?) led with over ([\d.]+)% market share in (\d{4})',
                  text)
    if m:
        out['leader'] = {'name': m.group(1).strip(), 'sharePct': _f(m.group(2)),
                         'year': int(m.group(3))}

    m = re.search(r'Top 5 players in this market include ([^.]+?),'
                  r' which collectively held a market share of ([\d.]+)% in (\d{4})', text)
    if m:
        names = [x.strip() for x in re.split(r',\s*', m.group(1)) if x.strip()]
        out['topPlayers'] = {'names': names, 'sharePct': _f(m.group(2)),
                             'year': int(m.group(3))}

    m = re.search(r'Largest Market ([A-Z][\w\s]{2,24}?) Fastest Growing Region'
                  r' ([A-Z][\w\s]{2,24}?) Key Players', text)
    if m:
        out['regions'] = {'largest': m.group(1).strip(), 'fastest': m.group(2).strip()}
    m = re.search(r"North America's USD ([\d.]+) billion", text) \
        or re.search(r'North America[^.]{0,60}?USD ([\d.]+) billion in (\d{4})', text)
    if m:
        out.setdefault('regions', {})['largestUsdBn'] = _f(m.group(1))
    m = re.search(r'Asia Pacific is projected to grow at the fastest regional rate,'
                  r' ([\d.]+)%', text)
    if m:
        out.setdefault('regions', {})['fastestPct'] = _f(m.group(1))

    # 제품유형 — 무료로 보이는 문장에서 확인되는 것만
    prod = []
    m = re.search(r'Innerspring mattresses remained the largest product category,'
                  r' generating USD ([\d.]+) billion in (\d{4})', text)
    if m:
        prod.append({'name': 'Innerspring', 'ko': '이너스프링',
                     'usdBn': _f(m.group(1)), 'year': int(m.group(2)),
                     'note': '최대 제품군'})
    m = re.search(r'Hybrid mattresses are expected to expand at a ([\d.]+)% CAGR'
                  r' through (\d{4})', text)
    if m:
        prod.append({'name': 'Hybrid', 'ko': '하이브리드',
                     'cagrPct': _f(m.group(1)), 'to': int(m.group(2)),
                     'note': '가장 빠른 성장'})
    m = re.search(r'Online sales generated USD ([\d.]+) billion in (\d{4})'
                  r' and are forecast to grow at ([\d.]+)%', text)
    if m:
        prod.append({'name': 'Online', 'ko': '온라인 판매',
                     'usdBn': _f(m.group(1)), 'year': int(m.group(2)),
                     'cagrPct': _f(m.group(3)), 'note': '유통 채널'})
    if prod:
        out['products'] = prod
    return out


REQUIRED = ('base', 'next', 'target', 'cagr')


def build(parsed: dict, now: str) -> dict:
    return {
        'status': 'ok',
        'source': 'Global Market Insights (gminsights.com)',
        'sourceUrl': URL,
        'checkedAt': now,
        'updatedAt': now,
        'title': '글로벌 매트리스 시장 규모',
        'subtitle': '시장조사기관 GMInsights 의 공개 요약 기준',
        # 안내 배너는 만들지 않는다 — 같은 내용이 아래 estimates(조사기관 대조표)에
        # 이미 있어 화면에서 뺐다. 여기서 다시 쓰면 다음 수집 때 배너가 되살아난다.
        'estimates': OTHER_ESTIMATES,
        **parsed,
    }


def main() -> int:
    only_print = '--print' in sys.argv
    now = datetime.now(KST).strftime('%Y-%m-%d')

    prev = None
    if os.path.exists(OUT):
        try:
            prev = json.load(io.open(OUT, encoding='utf-8'))
        except Exception:
            prev = None

    def keep(reason: str) -> int:
        """실패 — 기존 값은 그대로 두고 오류 기록만 남긴다."""
        print('X 수집 실패: %s' % reason)
        if only_print:
            return 1
        if prev and prev.get('status') == 'ok':
            prev['last_error'] = reason
            prev['last_attempt'] = now
            io.open(OUT, 'w', encoding='utf-8', newline='\n').write(
                json.dumps(prev, ensure_ascii=False, indent=2) + '\n')
            print('  → 기존 캐시 유지(값 그대로), last_error 만 기록했습니다.')
        else:
            os.makedirs(os.path.dirname(OUT), exist_ok=True)
            io.open(OUT, 'w', encoding='utf-8', newline='\n').write(
                json.dumps({'status': 'error', 'reason': reason,
                            'last_attempt': now}, ensure_ascii=False, indent=2) + '\n')
            print('  → 기존 캐시가 없어 오류 상태만 남겼습니다.')
        return 1

    try:
        html = fetch(URL)
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return keep('페이지를 받지 못했습니다 (%s)' % e)

    parsed = parse(to_text(html))
    missing = [k for k in REQUIRED if k not in parsed]
    if missing:
        return keep('필수 항목을 못 찾았습니다 (%s) — 페이지 구조가 바뀐 것 같습니다'
                    % ', '.join(missing))

    data = build(parsed, now)
    b, n, t = data['base'], data['next'], data['target']
    print('OK %d년 $%.1fB → %d년 $%.1fB → %d년 $%.1fB · CAGR %.1f%%'
          % (b['year'], b['usdBn'], n['year'], n['usdBn'],
             t['year'], t['usdBn'], data['cagr']['pct']))
    if 'leader' in data:
        print('   선도: %s %.1f%% (%d)' % (data['leader']['name'],
                                         data['leader']['sharePct'], data['leader']['year']))
    if 'topPlayers' in data:
        print('   상위 %d곳 합산 %.1f%%: %s' % (len(data['topPlayers']['names']),
                                            data['topPlayers']['sharePct'],
                                            ', '.join(data['topPlayers']['names'])))
    if 'regions' in data:
        print('   지역: 최대 %s($%sB) · 최고성장 %s(%s%%)'
              % (data['regions'].get('largest'), data['regions'].get('largestUsdBn'),
                 data['regions'].get('fastest'), data['regions'].get('fastestPct')))
    for p in data.get('products', []):
        print('   제품: %s %s' % (p['ko'], p.get('usdBn') or p.get('cagrPct')))

    if only_print:
        print('\n(--print 이라 파일은 건드리지 않았습니다)')
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print('\n저장: %s' % OUT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
