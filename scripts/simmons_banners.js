/* 시몬스 공식몰(simmons.co.kr) 메인 상단 배너 — 대시보드 머리 배너 슬라이드용(매일).
 *
 * 일반 방문자처럼 홈페이지를 브라우저로 열어, 화면에 실제로 뜬 큰 배너 이미지와
 * 그 배너를 눌렀을 때 가는 주소만 읽는다(쇼핑몰 서버 API 를 직접 부르지 않는다).
 * ★ 0장이거나 실패하면 기존 파일을 그대로 둔다. 바뀐 게 없으면 쓰지 않는다.
 *
 *   node scripts/simmons_banners.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'public', 'data', 'simmons-banners.json');

(async () => {
  let slides = [];
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  try {
    const pg = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await pg.goto('https://simmons.co.kr/', { waitUntil: 'networkidle', timeout: 60000 });
    await pg.waitForTimeout(3000);
    /* 상단 슬라이드 — 가로 1000px 넘는 배너 이미지(슬라이드는 앞뒤 복제본이 있어 주소로 중복을 지운다) */
    /* 상단 슬라이드(article.hero 안)만 — 페이지 가운데 배너(main-top-banner)는 넣지 않는다 */
    const raw = await pg.$$eval('article.hero .swiper-slide img', (xs) => xs.filter((i) => i.naturalWidth > 1000 && i.closest('a'))
      .map((i) => ({ image: i.currentSrc || i.src, link: i.closest('a').href, title: (i.alt || '').trim() })));
    const seen = new Set();
    slides = raw.filter((s) => /^https:\/\//.test(s.image) && /^https:\/\/(www\.)?simmons\.co\.kr\//.test(s.link)
      && !seen.has(s.image) && seen.add(s.image));
  } catch (e) {
    console.log('X 배너 읽기 실패 — 기존 파일 유지:', String(e).slice(0, 200));
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  if (!slides.length) {
    console.log('X 배너 0장 — 기존 파일 유지');
    process.exit(1);
  }
  slides.forEach((s) => console.log('[banner]', s.title || '(제목 없음)', '→', s.link));
  let old = null;
  try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')).slides; } catch (e) { /* 처음 */ }
  if (JSON.stringify(old) === JSON.stringify(slides)) {
    console.log('[banner] 바뀐 것 없음');
    return;
  }
  const kst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  fs.writeFileSync(OUT, JSON.stringify({ source: '시몬스 공식몰 메인 배너 (simmons.co.kr)', checkedAt: kst, slides }, null, 1) + '\n');
  console.log('[banner] 저장', slides.length + '장');
})();
