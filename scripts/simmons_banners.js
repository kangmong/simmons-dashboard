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
const OUT_NEW = path.join(__dirname, '..', 'public', 'data', 'simmons-new.json');
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

/* 바뀐 것만 쓴다. 0건이면 쓰지 않는다(기존 파일 유지). */
function save(file, key, list, source) {
  if (!list.length) { console.log('X', path.basename(file), '0건 — 기존 파일 유지'); return; }
  let old = null;
  try { old = JSON.parse(fs.readFileSync(file, 'utf8'))[key]; } catch (e) { /* 처음 */ }
  if (JSON.stringify(old) === JSON.stringify(list)) { console.log('[' + key + '] 바뀐 것 없음'); return; }
  fs.writeFileSync(file, JSON.stringify({ source, checkedAt: kst(), [key]: list }, null, 1) + '\n');
  console.log('[' + key + '] 저장', list.length + '건');
}

/* 공식몰 메인 'NEW' 신제품 — 제품명·정가·할인율·판매가·사진·상세 주소(화면에 보이는 그대로) */
async function readNew(pg) {
  return pg.evaluate(() => {
    const h = [...document.querySelectorAll('section.main-content h2')].find((e) => e.textContent.trim() === 'NEW');
    const sec = h && h.closest('section');
    if (!sec) return [];
    const seen = new Set();
    return [...sec.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate) .thumb-item')].map((t) => {
      const q = (s) => { const e = t.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; };
      const img = t.querySelector('.thumb-item__img img');
      const a = t.querySelector('a[href]');
      return { name: q('.product-thumb-title-product-name'), original: q('.product-original-price'),
        discount: q('.product-discount-price'), price: q('.product-thumb-price'),
        isNew: !!t.querySelector('.product-thumb__sticker img'),
        image: img ? (img.currentSrc || img.src) : '', link: a ? a.href : '' };
    }).filter((p) => p.name && /^https:\/\//.test(p.image) && /^https:\/\/(www\.)?simmons\.co\.kr\//.test(p.link)
      && !seen.has(p.link) && seen.add(p.link));
  });
}

(async () => {
  let slides = [];
  let news = [];
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
    news = await readNew(pg);
  } catch (e) {
    console.log('X 배너 읽기 실패 — 기존 파일 유지:', String(e).slice(0, 200));
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  slides.forEach((s) => console.log('[banner]', s.title || '(제목 없음)', '→', s.link));
  news.forEach((p) => console.log('[new]', p.name, p.price, '→', p.link));
  save(OUT, 'slides', slides, '시몬스 공식몰 메인 배너 (simmons.co.kr)');
  save(OUT_NEW, 'items', news, '시몬스 공식몰 메인 NEW (simmons.co.kr)');
  if (!slides.length && !news.length) process.exit(1);
})();
