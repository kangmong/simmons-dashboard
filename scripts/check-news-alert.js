#!/usr/bin/env node
/**
 * 새 연도 실적 기사 알림 — 무료. API 키도 결제도 필요 없다.
 *
 * ★ Anthropic API 기반 "자동 검색 + 자동 merge" 파이프라인을 걷어내고 이걸로 바꿨다.
 *   이 스크립트는 **데이터를 고치지 않는다.** 기사가 떴다는 사실만 GitHub Issue 로
 *   알리고, public/data/simmons-market.json 반영은 사람이 손으로 한다.
 *
 * ★ 쓰는 것: Node 내장 https 모듈 + Google 뉴스 RSS(키 불필요) + GitHub REST API.
 *   외부 라이브러리 설치가 없다(package.json 자체가 없는 프로젝트다).
 *
 * ★ 검색 연도는 하드코딩하지 않는다. simmonsPerformance 의 마지막 연도 + 1 을
 *   계산해서 쓴다. 2027년에도 코드를 고치지 않아도 된다.
 *
 * ★ 같은 기사로 매일 중복 알림이 가지 않게, 알림 보낸 링크를
 *   public/data/.seen-news-urls.json 에 쌓아 두고 대조한다.
 *
 * 사용법:
 *   node scripts/check-news-alert.js --dry-run   # Issue 생성·파일 쓰기 없이 미리보기
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/check-news-alert.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'public', 'data', 'simmons-market.json');
const SEEN_PATH = path.join(ROOT, 'public', 'data', '.seen-news-urls.json');
const BODY_PATH = path.join(ROOT, 'tmp', 'news-alert-body.md');

const DRY = process.argv.includes('--dry-run');
const UA = 'Mozilla/5.0 (compatible; simmons-dashboard-news-alert)';
const SEEN_MAX = 500;          // 무한정 쌓이지 않게 최근 것만 남긴다
const RSS_TIMEOUT = 20000;

/** 검색어 3개. {연도} 는 아래에서 채운다. */
const QUERY_TEMPLATES = [
  (y) => `시몬스 ${y}년 매출`,
  (y) => `에이스침대 ${y}년 매출`,
  (y) => `코웨이 ${y}년 매트리스 매출`,
];

function log(...a) { console.log('[news-alert]', ...a); }

function ghOutput(k, v) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

/** 조용히 종료 — 알릴 것 없음 */
function done(reason) {
  log('알림 없음:', reason);
  ghOutput('found', 'false');
  process.exit(0);
}

/** 내장 https 로 GET. 리다이렉트는 3번까지 따라간다. */
function httpsGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' },
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpsGet(next, redirects - 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error('HTTP ' + code));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(RSS_TIMEOUT, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** XML/HTML 엔티티 되돌리기 — RSS 제목에 &amp;, &#39; 등이 들어온다. */
function unescapeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')            // 반드시 마지막
    .trim();
}

/**
 * RSS XML → [{title, link}]. XML 파서를 설치하지 않고 정규식으로 충분하다.
 * <item> 하나씩 잘라 그 안의 첫 <title>/<link> 만 본다(채널 제목이 섞이지 않게).
 */
function parseRss(xml) {
  const out = [];
  const items = xml.match(/<item\b[\s\S]*?<\/item>/g) || [];
  items.forEach((it) => {
    const t = it.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = it.match(/<link[^>]*>([\s\S]*?)<\/link>/);
    if (!t || !l) return;
    const title = unescapeXml(t[1]);
    const link = unescapeXml(l[1]);
    if (title && link) out.push({ title, link });
  });
  return out;
}

/**
 * 무관한 기사 걸러내기 — 제목에 그 연도 숫자가 있고, '매출' 또는 '억원' 이 있어야 한다.
 * (예: 시몬스 "작년 매출 3천239억원" 은 2026 이 없어 걸러진다 — 지난해 기사이므로 맞다)
 */
function relevant(title, year) {
  return title.includes(String(year)) && (title.includes('매출') || title.includes('억원'));
}

function loadSeen() {
  try {
    const j = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
    if (Array.isArray(j)) return { urls: j };
    if (j && Array.isArray(j.urls)) return j;
  } catch (e) { /* 없으면 새로 만든다 */ }
  return { urls: [] };
}

function issueBody(year, groups) {
  const L = [];
  L.push(`**${year}년 매출 기사가 새로 발견됐습니다.** 아래 기사를 확인해 주세요.`);
  L.push('');
  groups.forEach((g) => {
    L.push(`### 🔍 \`${g.query}\``);
    L.push('');
    if (!g.items.length) {
      L.push('_새 기사 없음_');
    } else {
      g.items.forEach((it) => L.push(`- [${it.title}](${it.link})`));
    }
    L.push('');
  });
  L.push('---');
  L.push('');
  L.push('### 반영 방법 (수동)');
  L.push('');
  L.push('이 자동화는 **알림만** 보냅니다. 데이터는 사람이 직접 반영합니다.');
  L.push('');
  L.push('`public/data/simmons-market.json` 을 확인하고 수동으로 반영해주세요.');
  L.push('');
  L.push('```jsonc');
  L.push('// simmonsPerformance 배열 끝에 새 연도를 추가');
  L.push(`{ "year": ${year}, "revenue": 0, "operatingProfit": 0 }`);
  L.push('');
  L.push('// 3사 매출이 다 나왔으면 competitorRevenueLastYear 도 갱신');
  L.push('// lastUpdated 를 오늘 날짜로');
  L.push('// 확정 실적 발표 전이면 isProvisional: true (화면에 "잠정치" 배지가 뜬다)');
  L.push('```');
  L.push('');
  L.push('체크리스트:');
  L.push('');
  L.push('- [ ] 기사 원문에서 매출·영업이익 수치 확인 (단위: 억원)');
  L.push(`- [ ] ${year}년 **연간**(12월 결산) 수치인가 — 분기 실적이 아닌지`);
  L.push('- [ ] 잠정치인지 확정치인지 (`isProvisional`)');
  L.push('- [ ] 서로 다른 언론사 2곳 이상에서 같은 수치인지 (단일 오보 방지)');
  L.push('- [ ] `public/data/simmons-market.json` 수정 후 commit & push (Vercel 자동 재배포)');
  L.push('');
  L.push('반영이 끝나면 이 Issue 를 닫아 주세요.');
  L.push('');
  L.push('<sub>Google 뉴스 RSS 기반 자동 알림 · API 키 없이 동작합니다 · '
    + `실행 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</sub>`);
  return L.join('\n');
}

/** GitHub REST API 로 Issue 생성. 내장 https 만 쓴다. */
function createIssue(repo, token, title, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ title, body });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${repo}/issues`,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 201) {
          reject(new Error(`HTTP ${res.statusCode}: ${txt.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(txt)); } catch (e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const perf = (data.simmonsPerformance || []).slice().sort((a, b) => a.year - b.year);
  if (!perf.length) done('simmonsPerformance 가 비어 있음');
  const year = perf[perf.length - 1].year + 1;      // ★ 연도 하드코딩 안 함
  log(`보유 최신 연도 ${perf[perf.length - 1].year} → ${year}년 기사를 찾는다`);

  const seen = loadSeen();
  const seenSet = new Set(seen.urls);
  const groups = [];
  let total = 0;

  for (const tpl of QUERY_TEMPLATES) {
    const query = tpl(year);
    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query)
      + '&hl=ko&gl=KR&ceid=KR:ko';
    let items = [];
    try {
      items = parseRss(await httpsGet(url));
    } catch (e) {
      // 한 검색어가 실패해도 나머지는 계속한다. 내일 또 돈다.
      log(`"${query}" 조회 실패(건너뜀): ${e.message}`);
      groups.push({ query, items: [] });
      continue;
    }
    const hit = items.filter((it) => relevant(it.title, year) && !seenSet.has(it.link));
    // 같은 실행 안에서 검색어끼리 겹치는 것도 제거
    const fresh = [];
    hit.forEach((it) => {
      if (seenSet.has(it.link)) return;
      seenSet.add(it.link);
      fresh.push(it);
    });
    log(`"${query}" — 수집 ${items.length}건 · 조건 통과 신규 ${fresh.length}건`);
    groups.push({ query, items: fresh });
    total += fresh.length;
  }

  if (!total) done(`${year}년 관련 새 기사 없음`);

  const title = `[실적 알림] ${year}년 매출 기사 발견`;
  const body = issueBody(year, groups);
  const links = groups.reduce((a, g) => a.concat(g.items.map((i) => i.link)), []);

  if (DRY) {
    log(`--dry-run — Issue 를 만들지도, 파일을 쓰지도 않는다\n`);
    console.log('════════ 이런 Issue 를 만들 것 ════════');
    console.log('제목: ' + title);
    console.log('');
    console.log(body);
    console.log('');
    console.log(`════════ ${SEEN_PATH} 에 추가될 링크 ${links.length}건 ════════`);
    links.forEach((l) => console.log('  ' + l));
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    log('GITHUB_REPOSITORY / GITHUB_TOKEN 이 없어 Issue 를 만들지 못했습니다.');
    log('로컬에서 확인만 하려면 --dry-run 을 쓰세요. 파일은 건드리지 않았습니다.');
    ghOutput('found', 'false');
    process.exit(0);
  }
  const issue = await createIssue(repo, token, title, body);
  log(`Issue 생성: ${issue.html_url || '(URL 없음)'}`);

  // 알림을 실제로 보낸 뒤에만 seen 에 기록한다(실패 시 다음 날 다시 알리게)
  const merged = seen.urls.concat(links);
  fs.writeFileSync(SEEN_PATH, JSON.stringify({
    _comment: '알림을 이미 보낸 기사 링크. 같은 기사로 중복 알림이 가지 않게 대조용으로만 쓴다.',
    updatedAt: new Date().toISOString().slice(0, 10),
    urls: merged.slice(-SEEN_MAX),
  }, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.dirname(BODY_PATH), { recursive: true });
  fs.writeFileSync(BODY_PATH, body, 'utf8');
  log(`${SEEN_PATH} 갱신 (링크 ${merged.length}건 중 최근 ${Math.min(merged.length, SEEN_MAX)}건 보관)`);

  ghOutput('found', 'true');
  ghOutput('year', String(year));
  ghOutput('count', String(links.length));
  ghOutput('issue_url', issue.html_url || '');
}

main().catch((e) => {
  // 예상 못한 오류도 파이프라인을 깨뜨리지 않는다 — 내일 다시 돈다.
  log('예상치 못한 오류(무시하고 종료):', e && e.stack ? e.stack : e);
  ghOutput('found', 'false');
  process.exit(0);
});
