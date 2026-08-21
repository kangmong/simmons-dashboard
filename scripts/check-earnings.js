#!/usr/bin/env node
/**
 * 시몬스·경쟁사 새 연도 실적 자동 감지 (Anthropic API + web_search)
 *
 * ★ 시몬스는 비상장사라 DART 등 공시 API 로 자동 조회가 안 된다. 그래서 실적
 *   발표 기사를 웹 검색으로 찾는다. 오탐이 가능하므로 **자동 merge 하지 않는다** —
 *   이 스크립트는 JSON 을 고치고 PR 본문 초안만 만들고, merge 는 사람이 한다.
 *
 * ★ 못 찾으면 아무것도 하지 않고 조용히 종료한다(exit 0, changed=false).
 *   워크플로가 매일 돌기 때문에 기사가 뜨면 며칠 안에 잡힌다.
 *
 * ★ 모델 ID 주의: 스펙에 적힌 "claude-sonnet-4-6" 은 존재하지 않는 ID다.
 *   실재하는 최신 Sonnet 인 claude-sonnet-5 를 기본값으로 쓰고,
 *   EARNINGS_MODEL 환경변수로 덮어쓸 수 있게 했다.
 *
 * ★ web_search 도구 형식은 공식 문서에서 확인한 값이다(추측 아님):
 *     { "type": "web_search_20250305", "name": "web_search", "max_uses": N }
 *   응답에서 인용은 citations[].type === 'web_search_result_location' 로 오고
 *   url / title / cited_text 를 담고 있다. 이걸 그대로 PR 본문에 넣는다.
 *
 * 사용법:
 *   ANTHROPIC_API_KEY=... node scripts/check-earnings.js
 *   옵션: --dry-run  (파일을 쓰지 않고 판단 결과만 출력)
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

// 상식 범위를 벗어난 값은 오탐으로 보고 버린다(단위: 억원).
const REV_MIN = 500, REV_MAX = 50000;
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

/**
 * 검색 단계. pause_turn 이 오면 받은 assistant 메시지를 그대로 되돌려보내
 * 이어서 진행한다(문서 규정 동작). 최대 4회까지만 이어받는다.
 */
async function research(targetYear) {
  const prompt = [
    `${targetYear}년(회계연도) 연간 실적을 찾아라. 대상은 세 곳이다.`,
    '',
    `1. 시몬스(시몬스침대, 한국) — ${targetYear}년 매출액과 영업이익`,
    `2. 에이스침대 — ${targetYear}년 매출액`,
    `3. 코웨이 침대·매트리스(비렉스) — ${targetYear}년 매출액`,
    '',
    '규칙:',
    `- 단위는 반드시 "억원"으로 환산해서 보고할 것.`,
    `- ${targetYear}년 연간(12월 결산) 수치만 인정한다. 분기 실적이나 다른 연도는 제외.`,
    '- 추정치·전망치와 확정 실적을 반드시 구분해서 말할 것.',
    '- 찾지 못한 항목은 "찾지 못함"이라고 명시할 것. 절대 추측해서 채우지 말 것.',
    '- 각 수치마다 어느 기사에서 나왔는지 밝힐 것.',
    '',
    '검색어 예시: 시몬스 ' + targetYear + '년 매출 영업이익 / 에이스침대 '
      + targetYear + '년 매출 / 코웨이 비렉스 매트리스 ' + targetYear + '년 매출',
  ].join('\n');

  const messages = [{ role: 'user', content: prompt }];
  let out = null;
  for (let i = 0; i < 5; i += 1) {
    out = await callApi({
      model: MODEL,
      max_tokens: 6000,
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
    });
    if (out.stop_reason !== 'pause_turn') break;
    // 멈춘 assistant 메시지를 손대지 않고 그대로 되돌려 보낸다
    messages.push({ role: 'assistant', content: out.content });
    log('pause_turn — 이어서 진행');
  }
  const blocks = out.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const cites = [];
  blocks.forEach((b) => {
    (b.citations || []).forEach((c) => {
      if (c.type === 'web_search_result_location' && c.url) {
        cites.push({ url: c.url, title: c.title || '', quote: c.cited_text || '' });
      }
    });
  });
  const searches = (out.usage && out.usage.server_tool_use
    && out.usage.server_tool_use.web_search_requests) || 0;
  return { text, cites, searches };
}

/** 추출 단계. 도구 없이 JSON 만 받는다(server tool 과 client tool 을 섞지 않는다). */
async function extract(targetYear, researchText) {
  const schema = {
    year: targetYear,
    simmons: { revenue: 'number|null', operatingProfit: 'number|null' },
    aceBed: { revenue: 'number|null' },
    coway: { revenue: 'number|null' },
    isProvisional: 'boolean',
    confidence: 'high|medium|low',
    reasoning: 'string',
  };
  const out = await callApi({
    model: MODEL,
    max_tokens: 1500,
    system: '너는 데이터 추출기다. 설명 없이 JSON 객체 하나만 출력한다. '
      + '조사 내용에 없는 값은 반드시 null 로 둔다. 추측하지 않는다.',
    messages: [{
      role: 'user',
      content: [
        '아래 조사 결과에서 수치를 뽑아 JSON 으로만 답하라.',
        '형식(값의 타입만 표기한 것이다):',
        JSON.stringify(schema, null, 2),
        '',
        '- 단위는 억원. 조 단위로 적힌 값은 억원으로 환산하라(1조 = 10000억원).',
        `- ${targetYear}년 연간 확정 실적이 아니면 isProvisional 을 true 로 둬라.`,
        '- 근거가 기사 한 건뿐이거나 서로 다른 수치가 보이면 confidence 를 low 로 둬라.',
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

function prBody(targetYear, got, cites, data) {
  const L = [];
  L.push(`## ${targetYear}년 실적 자동 감지 결과`);
  L.push('');
  L.push('> ⚠️ **자동 merge 금지.** 시몬스는 비상장사라 공시 대신 기사를 근거로 합니다.');
  L.push('> 아래 출처를 직접 열어 수치를 확인한 뒤 merge 해 주세요.');
  L.push('');
  L.push('| 항목 | 감지된 값 (억원) |');
  L.push('|---|---|');
  L.push(`| 시몬스 매출 | ${got.simmons.revenue ?? '찾지 못함'} |`);
  L.push(`| 시몬스 영업이익 | ${got.simmons.operatingProfit ?? '찾지 못함'} |`);
  L.push(`| 에이스침대 매출 | ${got.aceBed?.revenue ?? '찾지 못함'} |`);
  L.push(`| 코웨이 매트리스 매출 | ${got.coway?.revenue ?? '찾지 못함'} |`);
  L.push('');
  L.push(`- 확정/잠정: **${got.isProvisional ? '잠정치 (isProvisional=true)' : '확정치'}**`);
  L.push(`- 모델 신뢰도: **${got.confidence}**`);
  L.push(`- 모델: \`${MODEL}\``);
  L.push('');
  if (got.reasoning) {
    L.push('### 모델 판단 근거');
    L.push('');
    L.push(got.reasoning);
    L.push('');
  }
  L.push('### 원문 출처와 인용');
  L.push('');
  if (!cites.length) {
    L.push('_인용을 받지 못했습니다. 수치를 신뢰하지 말고 직접 확인하세요._');
  } else {
    const seen = new Set();
    cites.forEach((c) => {
      const k = c.url + '|' + c.quote.slice(0, 40);
      if (seen.has(k)) return;
      seen.add(k);
      L.push(`- [${c.title || c.url}](${c.url})`);
      if (c.quote) L.push(`  > ${c.quote.replace(/\n/g, ' ')}`);
    });
  }
  L.push('');
  L.push('### 검수 체크리스트');
  L.push('');
  L.push('- [ ] 매출·영업이익이 기사 원문과 일치하는가');
  L.push(`- [ ] ${targetYear}년 **연간**(12월 결산) 수치인가 (분기 아님)`);
  L.push('- [ ] 단위가 억원인가');
  L.push('- [ ] 잠정/확정 구분이 맞는가 (`isProvisional`)');
  L.push('- [ ] 코웨이 매출 정의(렌탈 합산) 각주가 여전히 유효한가');
  L.push('');
  L.push('_시장 점유율(`marketShare2025`)은 조사기관 추정치라 이 스크립트가 건드리지 않습니다._');
  L.push('');
  L.push(`데이터 파일: \`public/data/simmons-market.json\` · lastUpdated → \`${data.lastUpdated}\``);
  return L.join('\n');
}

async function main() {
  if (!API_KEY) {
    log('ANTHROPIC_API_KEY 가 없습니다.');
    done('API 키 없음');
  }
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const perf = (data.simmonsPerformance || []).slice().sort((a, b) => a.year - b.year);
  if (!perf.length) done('simmonsPerformance 가 비어 있음');
  const targetYear = perf[perf.length - 1].year + 1;
  log(`보유 최신 연도 ${perf[perf.length - 1].year} → ${targetYear}년 실적을 찾는다`);

  let got, cites, searches;
  try {
    const r = await research(targetYear);
    cites = r.cites; searches = r.searches;
    log(`웹 검색 ${searches}회 · 인용 ${cites.length}건`);
    got = await extract(targetYear, r.text);
  } catch (e) {
    // API 실패는 조용히 넘긴다 — 내일 다시 돈다.
    log('조회 실패(다음 실행에서 재시도):', e.message);
    done('API 오류');
  }
  log('추출 결과:', JSON.stringify(got));

  if (Number(got.year) !== targetYear) done(`연도 불일치(${got.year})`);
  if (got.confidence === 'low') done('신뢰도 low — 사람이 볼 가치가 없다고 판단');
  const rev = got.simmons && got.simmons.revenue;
  const op = got.simmons && got.simmons.operatingProfit;
  if (!validNum(rev, REV_MIN, REV_MAX)) done('시몬스 매출을 찾지 못했거나 범위를 벗어남');
  if (!validNum(op, OP_MIN, OP_MAX)) done('시몬스 영업이익을 찾지 못했거나 범위를 벗어남');
  if (perf.some((p) => p.year === targetYear)) done('이미 들어 있는 연도');

  // ── 1) 시몬스 실적 추가
  const entry = { year: targetYear, revenue: Math.round(rev), operatingProfit: Math.round(op) };
  if (got.isProvisional) entry.provisional = true;
  data.simmonsPerformance = perf.concat([entry]);
  data.isProvisional = !!got.isProvisional;
  data.lastUpdated = new Date().toISOString().slice(0, 10);

  // ── 2) 경쟁사 비교는 세 곳이 다 모였을 때만 갈아탄다(반쪽 비교를 만들지 않는다)
  const ace = got.aceBed && got.aceBed.revenue;
  const cow = got.coway && got.coway.revenue;
  const prevSimmons = perf[perf.length - 1].revenue;
  if (validNum(ace, REV_MIN, REV_MAX) && validNum(cow, REV_MIN, REV_MAX)) {
    const old = data.competitorRevenueLastYear || {};
    const oldBy = {};
    (old.companies || []).forEach((c) => {
      if (String(c.name).indexOf('코웨이') === 0) oldBy.coway = c.revenue;
      else if (String(c.name).indexOf('시몬스') === 0) oldBy.simmons = c.revenue;
      else if (String(c.name).indexOf('에이스') === 0) oldBy.ace = c.revenue;
    });
    const pct = (now, before) => (validNum(before, REV_MIN, REV_MAX)
      ? Math.round(((now - before) / before) * 1000) / 10 : null);
    data.competitorRevenueLastYear = {
      year: targetYear,
      companies: [
        { name: (old.companies && old.companies[0] && old.companies[0].name)
          || '코웨이(비렉스, 매트리스+렌탈 합산)',
          revenue: Math.round(cow), yoyChangePct: pct(cow, oldBy.coway) },
        { name: '시몬스', revenue: Math.round(rev), yoyChangePct: pct(rev, prevSimmons) },
        { name: '에이스침대', revenue: Math.round(ace), yoyChangePct: pct(ace, oldBy.ace) },
      ],
      // 코웨이 매출 정의 관련 업계 이견은 계속 유효하므로 각주를 그대로 유지한다
      note: old.note,
    };
  } else {
    log('경쟁사 3사가 다 모이지 않아 매출 비교 차트는 그대로 둔다');
  }

  const body = prBody(targetYear, got, cites, data);
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
  ghOutput('year', String(targetYear));
  ghOutput('provisional', got.isProvisional ? 'true' : 'false');
  ghOutput('body_path', PR_BODY_PATH);
}

main().catch((e) => {
  // 예상 못한 오류도 파이프라인을 깨뜨리지 않는다 — 내일 다시 돈다.
  log('예상치 못한 오류(무시하고 종료):', e && e.stack ? e.stack : e);
  ghOutput('changed', 'false');
  process.exit(0);
});
