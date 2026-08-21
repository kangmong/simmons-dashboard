#!/usr/bin/env node
/**
 * 시몬스·경쟁사 새 연도 실적 자동 감지 → 교차검증 → 자동 반영
 *
 * ★ 시몬스는 비상장사라 DART 등 공시 API 로 자동 조회가 안 된다. 그래서 실적
 *   발표 기사를 웹 검색으로 찾는다. 기사 한 건만 믿으면 오보 하나에 대시보드가
 *   오염되므로, **서로 다른 언론사 2곳 이상이 같은 수치를 말할 때만** 확정으로
 *   본다(교차검증). 이 조건을 못 넘기면 아무것도 하지 않고 다음 날 다시 돈다.
 *
 * ★ 교차검증은 모델 자기보고를 믿지 않고 코드가 직접 센다. 두 갈래 증거를 합친다.
 *     (a) web_search 인용문(cited_text)에 그 숫자가 실제로 들어 있는 경우 — 가장 강함
 *     (b) 모델이 댄 출처 URL 중, **검색 결과에 실제로 등장한 URL** 인 것만 인정
 *   (a) 만 쓰면 인용문이 150자로 잘려 숫자가 안 잡히는 일이 있어 놓치고,
 *   (b) 만 쓰면 모델이 URL 을 지어낼 수 있다. 그래서 (a) ∪ (b) 의 도메인 수를 센다.
 *
 * ★ 이상치 브레이크. 자동 merge 를 건너뛰고 review-needed PR 만 연다.
 *   임계값을 매출과 영업이익에 다르게 뒀다 — 이 회사 실적 이력이 그렇게 생겼다.
 *     매출     2022→2025 실측 +9.8% / +5.0% / -1.7%     → ±50% 면 충분히 넉넉하다
 *     영업이익 2022→2025 실측 +170.3% / +65.2% / -23.1% → ±50% 로 잡으면 정상
 *              변동에도 매번 브레이크가 걸려 자동 반영이 무의미해진다. ±200% 로 둔다.
 *   두 값 모두 아래 상수로 빼 뒀다.
 *
 * ★ 모델 ID 주의: 스펙의 "claude-sonnet-4-6" 은 존재하지 않는 ID다. 실재하는
 *   claude-sonnet-5 를 기본값으로 쓰고 EARNINGS_MODEL 로 덮어쓸 수 있게 했다.
 *
 * ★ web_search 도구 형식은 공식 문서에서 확인한 값이다(추측 아님):
 *     { "type": "web_search_20250305", "name": "web_search", "max_uses": N }
 *   인용은 citations[].type === 'web_search_result_location' 의 url/title/cited_text.
 *   검색 결과 URL 은 web_search_tool_result 블록의 web_search_result[].url 에 있다.
 *
 * 출력(GITHUB_OUTPUT):
 *   changed       파일을 고쳤는지
 *   auto_merge    자동 merge 해도 되는지(이상치·잠정치면 false)
 *   year / body_path / hold_reason
 *
 * 사용법:
 *   ANTHROPIC_API_KEY=... node scripts/check-earnings.js [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'public', 'data', 'simmons-market.json');
const PR_BODY_PATH = path.join(ROOT, 'tmp', 'earnings-pr-body.md');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.EARNINGS_MODEL || 'claude-sonnet-5';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DRY = process.argv.includes('--dry-run');

const MIN_OUTLETS = 2;          // 교차검증 — 서로 다른 언론사 최소 수
const REV_JUMP_PCT = 50;        // 매출 이상치 브레이크(±%)
const OP_JUMP_PCT = 200;        // 영업이익 이상치 브레이크(±%) — 위 주석의 실측 근거
const REV_MIN = 500, REV_MAX = 50000;     // 상식 범위(억원)
const OP_MIN = -5000, OP_MAX = 10000;

function log(...a) { console.log('[check-earnings]', ...a); }

function ghOutput(k, v) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

/** 조용히 종료 — 변경 없음 */
function done(reason) {
  log('변경 없음:', reason);
  ghOutput('changed', 'false');
  ghOutput('auto_merge', 'false');
  process.exit(0);
}

async function callApi(body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 400)}`);
  }
  return res.json();
}

/** URL → 언론사 구분용 도메인(www. 제거). 실패하면 null. */
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return null;
  }
}

/**
 * 검색 단계. 세 곳을 각각 검색하게 지시하고, 수치마다 출처를 대게 한다.
 * pause_turn 이 오면 받은 assistant 메시지를 그대로 되돌려보내 이어받는다.
 */
async function research(targetYear) {
  const prompt = [
    `${targetYear}년(회계연도) 연간 실적을 찾아라. 아래 셋을 **각각 따로** 검색할 것.`,
    '',
    `  1) 시몬스 ${targetYear}년 매출 영업이익`,
    `  2) 에이스침대 ${targetYear}년 매출`,
    `  3) 코웨이 ${targetYear}년 침대 매트리스(비렉스) 매출`,
    '',
    '중요한 규칙:',
    '- 같은 수치를 보도한 기사를 **여러 언론사에서** 찾아라. 한 곳만 찾고 멈추지 말 것.',
    '  (뒤에서 서로 다른 언론사 2곳 이상을 요구한다)',
    '- 단위는 반드시 "억원"으로 환산해서 보고할 것 (1조 = 10000억원).',
    `- ${targetYear}년 **연간**(12월 결산) 수치만 인정한다. 분기 실적·다른 연도는 제외.`,
    '- "잠정", "전망", "추정" 이라고 적힌 수치는 확정 실적과 반드시 구분해서 말할 것.',
    '- 못 찾은 항목은 "찾지 못함" 이라고 명시할 것. 절대 추측해서 채우지 말 것.',
    '- 수치를 말할 때마다 **어느 언론사 어느 기사(URL)** 인지 함께 적을 것.',
  ].join('\n');

  const messages = [{ role: 'user', content: prompt }];
  const cites = [];
  const resultUrls = new Set();
  let texts = [];
  let searches = 0;

  for (let i = 0; i < 6; i += 1) {
    const out = await callApi({
      model: MODEL,
      max_tokens: 8000,
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 14 }],
    });
    const blocks = out.content || [];
    blocks.forEach((b) => {
      if (b.type === 'text') {
        texts.push(b.text);
        (b.citations || []).forEach((c) => {
          if (c.type === 'web_search_result_location' && c.url) {
            cites.push({ url: c.url, title: c.title || '', quote: c.cited_text || '' });
          }
        });
      } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        b.content.forEach((r) => { if (r && r.url) resultUrls.add(r.url); });
      }
    });
    searches += (out.usage && out.usage.server_tool_use
      && out.usage.server_tool_use.web_search_requests) || 0;
    if (out.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: out.content });  // 손대지 않고 되돌려보낸다
    log('pause_turn — 이어서 진행');
  }
  return {
    text: texts.join('\n'), cites, resultUrls, searches,
    searchedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
  };
}

/** 추출 단계. 도구 없이 JSON 만 받는다(서버 도구와 클라이언트 도구를 한 턴에 섞지 않는다). */
async function extract(targetYear, researchText) {
  const shape = {
    year: targetYear,
    simmons: {
      revenue: 'number|null', operatingProfit: 'number|null',
      sources: [{ outlet: 'string', url: 'string' }],
    },
    aceBed: { revenue: 'number|null', sources: [{ outlet: 'string', url: 'string' }] },
    coway: { revenue: 'number|null', sources: [{ outlet: 'string', url: 'string' }] },
    isPreliminary: 'boolean',
    confidence: 'high|medium|low',
    reasoning: 'string',
  };
  const out = await callApi({
    model: MODEL,
    max_tokens: 2500,
    system: '너는 데이터 추출기다. 설명 없이 JSON 객체 하나만 출력한다. '
      + '조사 내용에 없는 값은 반드시 null 로 둔다. 추측하지 않는다. '
      + 'URL 을 지어내지 않는다 — 조사 내용에 실제로 나온 URL 만 적는다.',
    messages: [{
      role: 'user',
      content: [
        '아래 조사 결과에서 수치를 뽑아 JSON 으로만 답하라.',
        '형식(값의 타입만 표기한 것이다):',
        JSON.stringify(shape, null, 2),
        '',
        '- 단위는 억원. 조 단위로 적힌 값은 억원으로 환산하라(1조 = 10000억원).',
        '- sources 에는 그 수치를 보도한 기사를 **언론사별로 하나씩** 모두 넣어라.',
        '  같은 언론사 기사 여러 건보다 서로 다른 언론사가 중요하다.',
        `- ${targetYear}년 연간 확정 실적이 아니면(잠정·전망·추정) isPreliminary=true.`,
        '- 서로 다른 수치가 보이거나 근거가 약하면 confidence 를 low 로 둬라.',
        '- 못 찾은 값은 null. 0 으로 채우지 마라.',
        '',
        '=== 조사 결과 ===',
        researchText,
      ].join('\n'),
    }],
  });
  const text = (out.content || []).filter((b) => b.type === 'text')
    .map((b) => b.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON 을 찾지 못했습니다: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

function validNum(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/**
 * 교차검증 — 이 숫자를 말하는 서로 다른 언론사가 몇 곳인지 코드가 직접 센다.
 *   (a) 인용문에 숫자가 실제로 박혀 있는 인용
 *   (b) 모델이 댄 출처 중 검색 결과에 실제로 있던 URL 만
 * 반환 {outlets:[도메인], evidence:[{url,title,quote,via}]}
 */
function crossCheck(value, sources, cites, resultUrls) {
  const outlets = new Map();     // 도메인 → 증거 1건
  if (validNum(value, -Infinity, Infinity)) {
    const plain = String(Math.round(value));
    const comma = Math.round(value).toLocaleString('en-US');
    cites.forEach((c) => {
      const q = (c.quote || '').replace(/\s/g, '');
      if (q.indexOf(plain) < 0 && q.indexOf(comma.replace(/,/g, '')) < 0
          && (c.quote || '').indexOf(comma) < 0) return;
      const d = domainOf(c.url);
      if (d && !outlets.has(d)) outlets.set(d, { ...c, via: '인용문에 수치 확인' });
    });
  }
  (sources || []).forEach((s) => {
    if (!s || !s.url) return;
    // 모델이 지어낸 URL 을 걸러낸다 — 검색 결과에 실제로 있던 것만 인정
    if (!resultUrls.has(s.url)) return;
    const d = domainOf(s.url);
    if (d && !outlets.has(d)) {
      outlets.set(d, { url: s.url, title: s.outlet || '', quote: '', via: '검색 결과 URL' });
    }
  });
  return { outlets: [...outlets.keys()], evidence: [...outlets.values()] };
}

/** 직전 연도 대비 급변 여부. 임계값 초과면 사유 문자열, 아니면 null. */
function jumpCheck(label, now, before, limitPct) {
  if (!validNum(before, -Infinity, Infinity) || before === 0) return null;
  const pct = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(pct) < limitPct) return null;
  return `${label}이 직전 연도 대비 ${pct > 0 ? '+' : ''}${pct.toFixed(1)}% `
    + `(임계 ±${limitPct}%) 로 급변`;
}

function prBody(ctx) {
  const { targetYear, got, data, xs, holds, searchedAt, searches, autoMerge } = ctx;
  const L = [];
  L.push(`## ${targetYear}년 국내 실적 자동 반영`);
  L.push('');
  if (autoMerge) {
    L.push('교차검증을 통과해 **자동 merge** 됩니다. 사람 승인 단계는 없습니다.');
  } else {
    L.push('> ⚠️ **자동 merge 를 보류했습니다.** 아래 사유를 확인하고 사람이 판단해 주세요.');
    L.push('');
    holds.forEach((h) => L.push(`> - ${h}`));
  }
  L.push('');
  L.push('### 반영된 수치 (단위: 억원)');
  L.push('');
  L.push('| 항목 | 값 | 교차검증 언론사 |');
  L.push('|---|---|---|');
  const rowFor = (label, v, x) => L.push(`| ${label} | ${v ?? '찾지 못함'} | `
    + `${x ? x.outlets.length + '곳 (' + x.outlets.join(', ') + ')' : '—'} |`);
  rowFor('시몬스 매출', got.simmons && got.simmons.revenue, xs.rev);
  rowFor('시몬스 영업이익', got.simmons && got.simmons.operatingProfit, xs.op);
  rowFor('에이스침대 매출', got.aceBed && got.aceBed.revenue, xs.ace);
  rowFor('코웨이 매트리스 매출', got.coway && got.coway.revenue, xs.cow);
  L.push('');
  L.push(`- 검색 실행 일시: **${searchedAt}** (웹 검색 ${searches}회)`);
  L.push(`- 모델: \`${MODEL}\``);
  L.push(`- 확정/잠정: **${got.isPreliminary ? '잠정치' : '확정치'}** `
    + `→ \`isProvisional: ${data.isProvisional}\``);
  L.push(`- 모델 신뢰도: **${got.confidence}**`);
  L.push(`- 교차검증 기준: 서로 다른 언론사 **${MIN_OUTLETS}곳 이상**이 같은 수치를 보도`);
  L.push(`- 이상치 브레이크: 매출 ±${REV_JUMP_PCT}% · 영업이익 ±${OP_JUMP_PCT}%`);
  L.push('');
  if (got.reasoning) {
    L.push('### 모델 판단 근거');
    L.push('');
    L.push(got.reasoning);
    L.push('');
  }
  L.push('### 원문 출처');
  L.push('');
  const seen = new Set();
  const all = [].concat(xs.rev ? xs.rev.evidence : [], xs.op ? xs.op.evidence : [],
    xs.ace ? xs.ace.evidence : [], xs.cow ? xs.cow.evidence : []);
  if (!all.length) {
    L.push('_출처를 확보하지 못했습니다._');
  } else {
    all.forEach((c) => {
      if (seen.has(c.url)) return;
      seen.add(c.url);
      L.push(`- [${c.title || c.url}](${c.url}) — _${c.via}_`);
      if (c.quote) L.push(`  > ${c.quote.replace(/\n/g, ' ')}`);
    });
  }
  L.push('');
  L.push('### 문제가 있으면 되돌리는 방법');
  L.push('');
  L.push('이 PR 은 squash merge 되므로 커밋 하나만 되돌리면 원상복구됩니다.');
  L.push('');
  L.push('```bash');
  L.push('git fetch origin main && git checkout main && git pull');
  L.push('# 이 PR 의 merge 커밋 SHA (Actions 로그에도 남습니다)');
  L.push('git log --oneline -5 -- public/data/simmons-market.json');
  L.push('git revert <SHA>            # 되돌리는 커밋을 새로 만든다(이력 보존)');
  L.push('git push origin main        # push 하면 Vercel 이 자동 재배포한다');
  L.push('```');
  L.push('');
  L.push('GitHub 화면에서 하려면 이 PR 상단의 **Revert** 버튼을 눌러도 됩니다.');
  L.push('');
  L.push('---');
  L.push('');
  L.push('_시장 점유율(`marketShare2025`)은 조사기관 추정치라 이 스크립트가 건드리지 않습니다._');
  L.push(`_데이터 파일: \`public/data/simmons-market.json\` · lastUpdated → \`${data.lastUpdated}\`_`);
  return L.join('\n');
}

async function main() {
  if (!API_KEY) done('ANTHROPIC_API_KEY 가 없음');

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const perf = (data.simmonsPerformance || []).slice().sort((a, b) => a.year - b.year);
  if (!perf.length) done('simmonsPerformance 가 비어 있음');
  const prev = perf[perf.length - 1];
  const targetYear = prev.year + 1;
  log(`보유 최신 연도 ${prev.year} → ${targetYear}년 실적을 찾는다`);

  let r, got;
  try {
    r = await research(targetYear);
    log(`웹 검색 ${r.searches}회 · 인용 ${r.cites.length}건 · 결과 URL ${r.resultUrls.size}개`);
    got = await extract(targetYear, r.text);
  } catch (e) {
    log('조회 실패(다음 실행에서 재시도):', e.message);
    done('API 오류');
  }
  log('추출 결과:', JSON.stringify(got));

  if (Number(got.year) !== targetYear) done(`연도 불일치(${got.year})`);
  if (got.confidence === 'low') done('모델 신뢰도 low');
  if (perf.some((p) => p.year === targetYear)) done('이미 들어 있는 연도');

  const rev = got.simmons && got.simmons.revenue;
  const op = got.simmons && got.simmons.operatingProfit;
  if (!validNum(rev, REV_MIN, REV_MAX)) done('시몬스 매출을 찾지 못했거나 상식 범위 밖');
  if (!validNum(op, OP_MIN, OP_MAX)) done('시몬스 영업이익을 찾지 못했거나 상식 범위 밖');

  // ── 교차검증
  const src = (got.simmons && got.simmons.sources) || [];
  const xs = {
    rev: crossCheck(rev, src, r.cites, r.resultUrls),
    op: crossCheck(op, src, r.cites, r.resultUrls),
    ace: crossCheck(got.aceBed && got.aceBed.revenue,
      (got.aceBed && got.aceBed.sources) || [], r.cites, r.resultUrls),
    cow: crossCheck(got.coway && got.coway.revenue,
      (got.coway && got.coway.sources) || [], r.cites, r.resultUrls),
  };
  log(`교차검증 언론사 수 — 매출 ${xs.rev.outlets.length} / 영업이익 ${xs.op.outlets.length}`
    + ` :: ${xs.rev.outlets.join(', ') || '없음'}`);
  if (xs.rev.outlets.length < MIN_OUTLETS) {
    done(`매출 교차검증 실패(언론사 ${xs.rev.outlets.length}곳 < ${MIN_OUTLETS}곳) — 내일 재시도`);
  }

  // ── 이상치 브레이크 + 잠정치 → 자동 merge 보류 사유
  const holds = [];
  const j1 = jumpCheck('매출', rev, prev.revenue, REV_JUMP_PCT);
  const j2 = jumpCheck('영업이익', op, prev.operatingProfit, OP_JUMP_PCT);
  if (j1) holds.push(j1);
  if (j2) holds.push(j2);
  if (got.isPreliminary) {
    holds.push('기사가 잠정치로 보도 — 확정 실적으로 자동 반영하지 않는다');
  }
  if (xs.op.outlets.length < MIN_OUTLETS) {
    holds.push(`영업이익 교차검증이 언론사 ${xs.op.outlets.length}곳뿐`);
  }
  const autoMerge = holds.length === 0;

  // ── 1) 시몬스 실적 추가
  const entry = { year: targetYear, revenue: Math.round(rev), operatingProfit: Math.round(op) };
  if (got.isPreliminary) entry.provisional = true;
  data.simmonsPerformance = perf.concat([entry]);
  data.isProvisional = !!got.isPreliminary;      // 확정이면 false(스펙 6-2-3)
  data.lastUpdated = new Date().toISOString().slice(0, 10);

  // ── 2) 경쟁사 비교는 3사가 다 교차검증을 넘겼을 때만 갈아탄다(반쪽 비교 금지)
  const ace = got.aceBed && got.aceBed.revenue;
  const cow = got.coway && got.coway.revenue;
  const aceOk = validNum(ace, REV_MIN, REV_MAX) && xs.ace.outlets.length >= MIN_OUTLETS;
  const cowOk = validNum(cow, REV_MIN, REV_MAX) && xs.cow.outlets.length >= MIN_OUTLETS;
  if (aceOk && cowOk) {
    const old = data.competitorRevenueLastYear || {};
    const oldBy = {};
    (old.companies || []).forEach((c) => {
      const n = String(c.name);
      if (n.indexOf('코웨이') === 0) oldBy.coway = c.revenue;
      else if (n.indexOf('시몬스') === 0) oldBy.simmons = c.revenue;
      else if (n.indexOf('에이스') === 0) oldBy.ace = c.revenue;
    });
    const pct = (now, before) => (validNum(before, REV_MIN, REV_MAX)
      ? Math.round(((now - before) / before) * 1000) / 10 : null);
    data.competitorRevenueLastYear = {
      year: targetYear,
      companies: [
        {
          name: (old.companies && old.companies[0] && old.companies[0].name)
            || '코웨이(비렉스, 매트리스+렌탈 합산)',
          revenue: Math.round(cow), yoyChangePct: pct(cow, oldBy.coway),
        },
        { name: '시몬스', revenue: Math.round(rev), yoyChangePct: pct(rev, prev.revenue) },
        { name: '에이스침대', revenue: Math.round(ace), yoyChangePct: pct(ace, oldBy.ace) },
      ],
      note: old.note,     // 코웨이 매출 정의 이견은 계속 유효하므로 각주 승계
    };
  } else {
    log('경쟁사 3사가 교차검증을 다 넘기지 못해 매출 비교 차트는 그대로 둔다');
  }

  const body = prBody({
    targetYear, got, data, xs, holds,
    searchedAt: r.searchedAt, searches: r.searches, autoMerge,
  });

  log(autoMerge ? '→ 자동 merge 대상' : '→ 자동 merge 보류: ' + holds.join(' / '));

  if (DRY) {
    log('--dry-run — 파일을 쓰지 않는다\n');
    console.log(JSON.stringify(data, null, 2));
    console.log('\n──── PR 본문 ────\n' + body);
    return;
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.dirname(PR_BODY_PATH), { recursive: true });
  fs.writeFileSync(PR_BODY_PATH, body, 'utf8');
  log(`${DATA_PATH} 갱신 · PR 본문 → ${PR_BODY_PATH}`);
  ghOutput('changed', 'true');
  ghOutput('auto_merge', autoMerge ? 'true' : 'false');
  ghOutput('year', String(targetYear));
  ghOutput('provisional', got.isPreliminary ? 'true' : 'false');
  ghOutput('body_path', PR_BODY_PATH);
  ghOutput('hold_reason', holds.join(' / '));
  ghOutput('outlets', String(xs.rev.outlets.length));
}

main().catch((e) => {
  // 예상 못한 오류도 파이프라인을 깨뜨리지 않는다 — 내일 다시 돈다.
  log('예상치 못한 오류(무시하고 종료):', e && e.stack ? e.stack : e);
  ghOutput('changed', 'false');
  ghOutput('auto_merge', 'false');
  process.exit(0);
});
