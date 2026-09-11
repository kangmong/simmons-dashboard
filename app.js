/* ============================================================
   SIMMONS 해외 매트리스 업계 동향 대시보드
   ============================================================ */

/* ── CSV 파일 경로 (섹션에서 재사용) ── */
const CSV = {
  market: 'market_trends.csv',
  competitor: 'competitor_analysis.csv',
  news: 'industry_news.csv',
  material: 'material_cost.csv',
};

/* ── 데이터셋 정의: 파일명 매핑 + 라벨 (전 섹션 공용) ──
   match: 업로드 파일명에 이 문자열(중 하나)이 포함되면 해당 데이터셋으로 자동 매핑. */
const DATASETS = [
  { key: 'market', file: CSV.market, match: 'market_trends', label: '해외 시장 동향' },
  { key: 'competitor', file: CSV.competitor, match: 'competitor_analysis', label: '경쟁사 분석' },
  { key: 'news', file: CSV.news, match: 'industry_news', label: '업계 주요 뉴스' },
  // 원자재: material_cost 외에도 원자재성 파일명(FRED 코드 포함)을 폭넓게 수용
  { key: 'material', file: CSV.material, label: '원자재 원가 동향',
    match: ['material_cost', 'material', 'wti', 'crude', 'oil', 'urethane', 'foam', 'steel', 'rubber', 'latex'] },
];

/* ── 공유 스토어: { rows, origin, file } (다른 섹션이 읽어감) ── */
const STORE = {};

/* ============================================================
   공통 유틸
   ============================================================ */

/**
 * parseCsvText(text, opts) — CSV 텍스트를 PapaParse로 파싱한다.
 * @returns {object[]} 객체 배열
 */
function parseCsvText(text, opts = {}) {
  let body = String(text).replace(/^﻿/, '');
  if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1); // 실제 BOM(U+FEFF) 제거
  body = body.replace(/^\\xEF\\xBB\\xBF/, ''); // 리터럴 "\xEF\xBB\xBF" 텍스트로 저장된 BOM 제거
  const parsed = Papa.parse(body, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    ...(opts.papa || {}),
  });
  if (parsed.errors && parsed.errors.length) {
    console.warn('[parseCsvText] 파싱 경고:', parsed.errors);
  }
  return parsed.data;
}

/**
 * renderBadge(source) — source 값에 따라 상태 배지 HTML 문자열을 반환한다.
 * 규칙: "실데이터"=초록, "샘플"=회색, "준비중"=주황. (전 섹션 공용)
 */
function renderBadge(source) {
  const key = String(source == null ? '' : source).trim();
  const MAP = {
    '실데이터': { cls: 'badge--real', label: '실데이터' },
    '샘플': { cls: 'badge--sample', label: '샘플' },
    '준비중': { cls: 'badge--pending', label: '준비중' },
  };
  const meta = MAP[key] || { cls: 'badge--sample', label: key || '미상' };
  return `<span class="badge ${meta.cls}">${meta.label}</span>`;
}

/** 공용 빈 데이터 플레이스홀더 (준비중 배지 + 안내) */
function emptyState(msg) {
  return `<div class="empty-state">${renderBadge('준비중')}<span>${escapeHtml(msg || '데이터 준비중')}</span></div>`;
}

/** HTML 이스케이프 (미리보기 테이블 셀 안전 출력용) */
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 행 배열에서 source 값 분포를 집계한다. → [{ source, count }] (없으면 []) */
function sourceDistribution(rows) {
  if (!rows.length || !('source' in rows[0])) return null;
  const counts = new Map();
  rows.forEach((r) => {
    const s = String(r.source == null ? '' : r.source).trim() || '미상';
    counts.set(s, (counts.get(s) || 0) + 1);
  });
  return [...counts.entries()].map(([source, count]) => ({ source, count }));
}

/* ============================================================
   섹션 탭 전환
   ============================================================ */
const VIEWS = ['dashboard', 'simmons_news', 'material', 'competitor', 'domestic',
  'patent', 'fx', 'worldclock'];

/** 화면 전환: 'dashboard'(그리드) ↔ 개별 섹션(포커스). 차트는 재렌더 없이 CSS로 리플로우 */
function setView(view) {
  if (!VIEWS.includes(view)) view = 'dashboard';
  const content = document.getElementById('content');
  if (!content) return;
  const isDash = view === 'dashboard';
  content.dataset.view = view;

  const header = document.getElementById('dashHeader');
  const back = document.getElementById('focusBack');
  if (header) header.style.display = isDash ? 'flex' : 'none';
  if (back) back.style.display = isDash ? 'none' : 'inline-flex';

  document.querySelectorAll('.dash-card').forEach((card) => {
    const sec = card.dataset.section;
    const show = isDash || sec === view;
    card.classList.toggle('is-hidden', !show);
    card.classList.toggle('is-focused', !isDash && sec === view);
  });

  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.view === view));
  history.replaceState(null, '', `#${view}`);
  window.scrollTo(0, 0);
}

/** 네비게이션(사이드바 항목 + 카드 "더보기" + 뒤로가기) 라우팅 */
function initNav() {
  document.querySelectorAll('.nav-item').forEach((n) =>
    n.addEventListener('click', () => setView(n.dataset.view)));
  document.querySelectorAll('.more-link').forEach((m) =>
    m.addEventListener('click', () => setView(m.dataset.view)));
  const back = document.getElementById('focusBack');
  if (back) back.addEventListener('click', () => setView('dashboard'));

  // 딥링크: #market 등
  const initial = location.hash.replace('#', '');
  setView(VIEWS.includes(initial) ? initial : 'dashboard');
}

/* ============================================================
   1) 데이터 업로드 섹션
   ============================================================ */

/** 업로드된 파일명을 데이터셋에 매핑 (파일명 부분일치, 대소문자 무시) */
function matchDataset(filename) {
  const name = filename.toLowerCase();
  return DATASETS.find((ds) => {
    const pats = Array.isArray(ds.match) ? ds.match : [ds.match];
    return pats.some((p) => name.includes(String(p).toLowerCase()));
  }) || null;
}

/** CSV 열 이름으로 섹션 자동 인식 (파일명으로 못 정했을 때). 못 정하면 null */
function detectDatasetByColumns(keys) {
  const lc = (keys || []).map((k) => String(k).trim().toLowerCase());
  const has = (n) => lc.includes(String(n).toLowerCase());
  // UN Comtrade 무역데이터 → 해외 시장 동향(2)
  if (has('reporterISO') || has('reporterDesc') || has('primaryValue') || has('flowDesc')) return 'market';
  // 원자재 원가 동향(5): material 또는 (종가/observation_date)
  if (has('material') || has('종가') || has('observation_date')) return 'material';
  // 경쟁사 분석(3): company/revenue 류
  if (has('company') || lc.some((k) => k.startsWith('revenue') || k.includes('revenue') || k === '매출')) return 'competitor';
  // 커스텀 시장 스키마(region+iso+metric+value) → 시장
  if (has('iso') && has('metric') && has('value')) return 'market';
  // 뉴스(4): 제목+요약/헤드라인
  if ((has('title') || has('headline')) && (has('summary') || has('url'))) return 'news';
  return null;
}

/** 데이터셋 카드 하나를 렌더 */
function renderDatasetCard(ds) {
  const entry = STORE[ds.key];
  const originMeta = {
    upload: { cls: 'ds-origin--upload', label: '업로드됨' },
    default: { cls: 'ds-origin--default', label: '기본값(폴더)' },
    error: { cls: 'ds-origin--error', label: '로드 실패' },
    none: { cls: 'ds-origin--none', label: '미로드' },
  };
  const origin = entry ? entry.origin : 'none';
  const om = originMeta[origin] || originMeta.none;

  let inner;
  if (!entry || origin === 'error') {
    inner = `<div class="ds-empty">${entry && entry.message ? escapeHtml(entry.message) : '데이터 없음'}</div>`;
  } else {
    const rows = entry.rows;
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const preview = rows.slice(0, 10);

    // source 분포
    const dist = sourceDistribution(rows);
    let distHtml;
    if (dist === null) {
      distHtml = `<span class="ds-nodist">source 열 없음</span>`;
    } else {
      distHtml = dist
        .map((d) => `${renderBadge(d.source)}<span class="dist-count">×${d.count}</span>`)
        .join('');
    }

    // 미리보기 테이블
    const thead = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
    const tbody = preview
      .map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(r[c])}</td>`).join('')}</tr>`)
      .join('');

    inner = `
      <div class="ds-meta">
        <span class="ds-file">${escapeHtml(entry.file)}</span>
        <span class="ds-rows">${rows.length.toLocaleString()}행</span>
      </div>
      <div class="ds-dist">${distHtml}</div>
      <div class="ds-preview-wrap">
        <table class="ds-preview">
          <thead>${thead}</thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
      <div class="ds-note">앞 ${Math.min(10, rows.length)}행 미리보기 · 전체 ${cols.length}개 열</div>`;
  }

  return `
    <div class="ds-card">
      <div class="ds-card__head">
        <span class="ds-card__label">${ds.label}</span>
        <span class="ds-origin ${om.cls}">${om.label}</span>
      </div>
      ${inner}
    </div>`;
}

/** 전체 카드 그리드 렌더 (구 업로드 패널용 — 있으면 그림) + 사이드바 위젯 파일 목록 갱신 */
function renderUploadCards() {
  renderUploadedList();
  const grid = document.getElementById('dsGrid');
  if (!grid) return;
  grid.innerHTML = DATASETS.map(renderDatasetCard).join('');
}

/** 사이드바 업로드 위젯: 로드된 파일 목록(최근 5개) */
function renderUploadedList() {
  const el = document.getElementById('uploadList');
  if (!el) return;
  const items = DATASETS
    .filter((d) => STORE[d.key] && STORE[d.key].rows && STORE[d.key].rows.length)
    .map((d) => ({ label: d.label, file: STORE[d.key].file, rows: STORE[d.key].rows.length, origin: STORE[d.key].origin }));
  if (!items.length) { el.innerHTML = '<div class="uw-empty">아직 없음</div>'; return; }
  el.innerHTML = items.slice(0, 5).map((it) => `
    <div class="uw-file">
      <span class="uw-file__name" title="${escapeHtml(it.file)}">${escapeHtml(it.file)}</span>
      <span class="uw-file__meta">${it.rows.toLocaleString()}행 · ${escapeHtml(it.label)} · ${it.origin === 'upload' ? '업로드' : '기본'}</span>
    </div>`).join('');
}

/** 섹션 자동 배정 대기 목록 (파일명·내용으로 못 정한 파일) */
const _pendingUploads = [];

/** 파일 하나를 읽어 파싱 후 (파일명→열내용) 매핑. 못 정하면 unassigned 반환 */
function ingestFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      let rows;
      try { rows = parseCsvText(reader.result); }
      catch (err) { resolve({ ok: false, file: file.name, error: String(err.message || err) }); return; }

      // 1) 파일명 키워드 → 2) 열 이름 내용
      let ds = matchDataset(file.name);
      let how = 'filename';
      if (!ds) {
        const key = detectDatasetByColumns(rows.length ? Object.keys(rows[0]) : []);
        if (key) { ds = DATASETS.find((d) => d.key === key); how = 'columns'; }
      }
      if (ds) {
        STORE[ds.key] = { rows, origin: 'upload', file: file.name };
        resolve({ ok: true, file: file.name, key: ds.key, how });
      } else {
        // 3) 미결정 → 사용자가 드롭다운으로 직접 선택
        resolve({ ok: false, unassigned: true, file: file.name, rows });
      }
    };
    reader.onerror = () => resolve({ ok: false, file: file.name, error: '파일 읽기 실패' });
    reader.readAsText(file, 'utf-8');
  });
}

/** 업로드된 FileList 처리 */
async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => /\.csv$/i.test(f.name));
  const results = await Promise.all(files.map(ingestFile));

  results.forEach((r) => { if (r.unassigned) _pendingUploads.push({ file: r.file, rows: r.rows }); });

  renderUploadCards();
  refreshSections();
  renderPendingUploads();

  const banner = document.getElementById('uploadStatus');
  if (banner) {
    const okCount = results.filter((r) => r.ok).length;
    const unassigned = results.filter((r) => r.unassigned).map((r) => r.file);
    const errored = results.filter((r) => !r.ok && !r.unassigned).map((r) => r.file);
    let msg = `${okCount}개 파일 매핑 완료.`;
    if (unassigned.length) msg += ` 미인식 ${unassigned.length}개 — 아래에서 섹션을 선택하세요.`;
    if (errored.length) msg += ` 읽기 실패: ${errored.join(', ')}`;
    banner.textContent = msg;
    banner.classList.add('is-visible');
  }
  updateResetState();
}

/** 미결정 업로드에 대한 섹션 선택 드롭다운 렌더 */
function renderPendingUploads() {
  const el = document.getElementById('uploadPending');
  if (!el) return;
  if (!_pendingUploads.length) { el.innerHTML = ''; return; }
  const opts = DATASETS.map((d) => `<option value="${d.key}">${escapeHtml(d.label)}</option>`).join('');
  el.innerHTML = _pendingUploads
    .map((p, i) => `
      <div class="pending-row">
        <span class="pending-file">${escapeHtml(p.file)}</span>
        <span class="pending-msg">섹션 자동 인식 실패 — 직접 선택:</span>
        <select class="pending-select" data-i="${i}">${opts}</select>
        <button class="pending-apply" data-i="${i}" type="button">적용</button>
      </div>`)
    .join('');
}

/** 폴더의 CSV를 기본값으로 로드 (업로드 안 된 데이터셋만) */
/** 상시 업로드 위젯 초기화: 정적 DOM 요소를 배선 (드롭존/파일선택/초기화/드롭다운) */
function initUpload() {
  const dz = document.getElementById('dropzone');
  const input = document.getElementById('fileInput');
  const resetBtn = document.getElementById('resetBtn');
  const pendingEl = document.getElementById('uploadPending');
  const browse = document.getElementById('uwBrowse');
  if (!dz || !input) return;

  if (resetBtn) resetBtn.addEventListener('click', resetAllData);
  if (browse) browse.addEventListener('click', () => input.click());

  // 미결정 파일의 섹션 선택 "적용" (위임)
  if (pendingEl) {
    pendingEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.pending-apply');
      if (!btn) return;
      const i = +btn.dataset.i;
      const sel = pendingEl.querySelector(`.pending-select[data-i="${i}"]`);
      const p = _pendingUploads[i];
      if (!sel || !p) return;
      STORE[sel.value] = { rows: p.rows, origin: 'upload', file: p.file };
      _pendingUploads.splice(i, 1);
      renderUploadCards();
      refreshSections();
      renderPendingUploads();
      updateResetState();
    });
  }

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files.length) handleFiles(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-drag'); })
  );
  ['dragleave', 'dragend', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-drag'); })
  );
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  renderUploadCards(); // 초기: 미로드 카드 표시 (자동 적재 없음 — 업로드/[업데이트]로만 채움)
  updateResetState();
}

/** 초기화 버튼 활성/비활성: STORE에 데이터가 하나라도 있으면 활성 */
function updateResetState() {
  const btn = document.getElementById('resetBtn');
  if (!btn) return;
  const hasData = DATASETS.some((ds) => STORE[ds.key] && STORE[ds.key].rows && STORE[ds.key].rows.length);
  btn.disabled = !hasData;
}

/** 초기화: 브라우저 메모리(JS 상태)만 비운다. 서버/저장소·기본 CSV 재로딩 없음 */
function resetAllData() {
  if (!window.confirm('업로드한 데이터를 모두 삭제하고 초기 상태로 되돌립니다. 계속할까요?')) return;

  // 1) 메모리에 올려둔 모든 CSV 데이터(4개 슬롯) 제거
  Object.keys(STORE).forEach((k) => delete STORE[k]);

  // 2) 차트/hover 상태 캐시 비우기
  _compBars = null;
  _pieSlices = null;
  _material = null;

  // 3) 뉴스 필터 상태 초기화
  _newsState.category = '전체';
  _newsState.region = '전체';

  // 4) 파일 input 초기화 → 같은 파일 재업로드 가능
  const input = document.getElementById('fileInput');
  if (input) input.value = '';

  // 5) "N개 파일 매핑 완료" 메시지 + 미결정 대기 목록 제거
  const banner = document.getElementById('uploadStatus');
  if (banner) { banner.textContent = ''; banner.classList.remove('is-visible'); }
  _pendingUploads.length = 0;
  renderPendingUploads();

  // 6) 미리보기 카드 + 2~5번 섹션 차트/표 전부 비우기 (빈 STORE → emptyState/미로드)
  renderUploadCards();
  refreshSections();

  // 7) 버튼 비활성화 (더 이상 지울 데이터 없음). 기본 CSV는 다시 읽지 않음.
  updateResetState();
}

/* ============================================================
   2) 해외 시장 동향 섹션
   ============================================================ */

/** 숫자 파싱 (빈 문자열/미상 → null) */
function num(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 값을 "보기 좋은" 상한값으로 올림 (1/2/5 × 10^n) */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return f * mag;
}

/* iso3 → 대략적 [경도, 위도] 중심 좌표 (버블 위치용). 없는 코드는 지도에서 생략 */
const ISO_LONLAT = {
  USA: [-98, 39], CAN: [-106, 56], MEX: [-102, 23], BRA: [-52, -10], ARG: [-64, -34], CHL: [-71, -35], COL: [-74, 4], PER: [-76, -10],
  GBR: [-1.5, 52.5], DEU: [10, 51], FRA: [2.5, 46.5], ITA: [12.5, 42], ESP: [-3.7, 40], NLD: [5.5, 52], BEL: [4.5, 50.6],
  POL: [19, 52], SWE: [16, 62], NOR: [9, 61], DNK: [10, 56], CHE: [8, 47], AUT: [14, 47.5], PRT: [-8, 39.5], IRL: [-8, 53],
  FIN: [26, 64], CZE: [15.5, 49.8], ROU: [25, 46], GRC: [22, 39], HUN: [19.5, 47], TUR: [35, 39], UKR: [31, 49], RUS: [90, 62],
  CHN: [104, 35], JPN: [138, 37], KOR: [127.8, 36.5], IND: [79, 22], IDN: [113, -1], VNM: [106, 16], THA: [101, 15],
  MYS: [102, 4], PHL: [122, 12], SGP: [103.8, 1.35], TWN: [121, 23.7], HKG: [114.1, 22.3], PAK: [70, 30], BGD: [90, 24],
  AUS: [134, -25], NZL: [172, -41], SAU: [45, 24], ARE: [54, 24], ISR: [35, 31], EGY: [30, 27], ZAF: [24, -29], NGA: [8, 10],
};

/* metric/flow 코드 → 표시명 (없으면 원문) */
const METRIC_LABEL = {
  import_value: '수입액', export_value: '수출액', market_size: '시장 규모',
  production_value: '생산액', consumption: '소비액', trade_value: '교역액',
  Import: '수입액', Export: '수출액', 'Re-export': '재수출', 'Re-import': '재수입',
};
function metricLabel(m) {
  const k = String(m).trim();
  if (METRIC_LABEL[k]) return METRIC_LABEL[k];
  const low = { import: '수입액', export: '수출액', 're-export': '재수출', 're-import': '재수입' };
  if (low[k.toLowerCase()]) return low[k.toLowerCase()];
  return k.replace(/_/g, ' ');
}

/* 금액 포맷: unit에 billion/million/trillion 있으면 $NB 형태, 아니면 값+단위 */
function fmtMoney(v, unit) {
  if (v == null) return '—';
  const u = String(unit || '').toLowerCase();
  const r2 = (x) => Math.round(x * 100) / 100;
  const n = Number(v);
  if (u.includes('trillion')) return `$${r2(n).toLocaleString()}T`;
  if (u.includes('billion')) return `$${r2(n).toLocaleString()}B`;
  if (u.includes('million')) return `$${r2(n).toLocaleString()}M`;
  return `${r2(n).toLocaleString()} ${String(unit || '').replace(/_/g, ' ')}`.trim();
}

/**
 * getMarketData() — STORE.market을 자동 인식·정규화.
 * UN Comtrade 원본(reporterDesc/reporterISO/primaryValue/flowDesc)과
 * 커스텀 스키마(region/iso/metric/value/unit) 양쪽 지원.
 * 값 없거나 0인 행은 제외. 반환: { rows:[{region,iso,value,unit,metric,yoy,source,isWorld}], isComtrade }
 */
function getMarketData() {
  const entry = STORE.market;
  if (!entry || !entry.rows.length) return null;
  const rows = entry.rows;
  const keys = Object.keys(rows[0]);
  const findKey = (cands) => {
    for (const c of cands) { const hit = keys.find((k) => k.trim().toLowerCase() === c.toLowerCase()); if (hit) return hit; }
    return null;
  };
  const isComtrade = !!(findKey(['reporterISO']) || findKey(['primaryValue']) || findKey(['flowDesc']));

  let regionK, isoK, valueK, metricK, unitK, yoyK, sourceK;
  if (isComtrade) {
    regionK = findKey(['reporterDesc', 'reporter']);
    isoK = findKey(['reporterISO', 'reporter_iso']);
    valueK = findKey(['primaryValue', 'primary_value', 'TradeValue', 'tradeValue', 'value']);
    metricK = findKey(['flowDesc', 'flow']);
    unitK = null; // primaryValue(USD) → 10억 단위 환산
    yoyK = findKey(['yoy_growth_pct', 'yoy']);
    sourceK = findKey(['source']);
  } else {
    regionK = findKey(['region', 'country', 'reporterDesc']);
    isoK = findKey(['iso', 'reporterISO', 'country_iso']);
    valueK = findKey(['value', 'primaryValue']);
    metricK = findKey(['metric', 'flowDesc', 'flow']);
    unitK = findKey(['unit']);
    yoyK = findKey(['yoy_growth_pct', 'yoy']);
    sourceK = findKey(['source']);
  }
  if (!regionK || !valueK) return null;

  const norm = rows
    .map((r) => {
      let value = num(r[valueK]);
      let unit;
      if (isComtrade) {
        value = value == null ? null : value / 1e9; // USD → 10억 단위
        unit = 'USD_billion';
      } else {
        unit = unitK ? String(r[unitK]) : 'USD_billion';
      }
      const region = String(r[regionK] == null ? '' : r[regionK]).trim();
      return {
        region,
        iso: isoK ? String(r[isoK] || '').trim().toUpperCase() : '',
        value,
        unit,
        metric: metricK ? String(r[metricK]).trim() : '(전체)',
        yoy: yoyK ? num(r[yoyK]) : null,
        source: sourceK ? String(r[sourceK]).trim() : (isComtrade ? '실데이터' : null),
        isWorld: region.toLowerCase() === 'world',
      };
    })
    .filter((r) => r.region && r.value != null && r.value !== 0); // 값 없거나 0 제외

  return { rows: norm, isComtrade };
}

/* ── 시몬스 코리아 소식 (Google News RSS) ─────────────────────────────── */
let _simmonsNews = null; // { status, items:[{title,source,date,link,image}] }

/** 응답의 simmons_news 저장 후 섹션 갱신 */
function applySimmonsNewsUpdate(data) {
  const sn = data && data.sections && data.sections.simmons_news;
  if (!sn) return;
  _simmonsNews = sn;
  if (sn.status && sn.status !== 'ok') console.warn('[update] simmons_news:', sn.reason || sn.status);
  renderSimmonsNews();
}

/** 시몬스 코리아 소식 — 썸네일 카드 그리드 (제목 클릭 → 원문 새 탭) */
function renderSimmonsNews() {
  const el = document.getElementById('simmonsNewsGrid');
  if (!el) return;
  const items = (_simmonsNews && Array.isArray(_simmonsNews.items)) ? _simmonsNews.items : null;
  if (!items || !items.length) {
    const msg = (_simmonsNews && _simmonsNews.status && _simmonsNews.status !== 'ok')
      ? _simmonsNews.status : '데이터 없음';
    el.innerHTML = emptyState(msg);
    return;
  }
  el.innerHTML = items.map((it) => {
    const url = safeUrl(it.link);
    const img = safeUrl(it.image);
    // 썸네일: 이미지 있으면 표시(로드 실패 시 그라데이션+워드마크로 대체), 없으면 그라데이션
    const thumb = img
      ? `<div class="sk-card__thumb"><img src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('sk-card__thumb--ph');this.remove()"><span class="sk-card__wm">SIMMONS</span></div>`
      : `<div class="sk-card__thumb sk-card__thumb--ph"><span class="sk-card__wm">SIMMONS</span></div>`;
    const tag = url ? 'a' : 'div';
    const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="sk-card"${attrs}>
      ${thumb}
      <div class="sk-card__body">
        <h3 class="sk-card__title">${escapeHtml(it.title)}</h3>
        <div class="sk-card__meta">${escapeHtml(it.source || '')}${it.date ? '<span class="sk-dot"></span>' + escapeHtml(it.date) : ''}</div>
      </div>
    </${tag}>`;
  }).join('');
}



/* ── SIMMONS IG (Instagram @simmonskorea · Apify Instagram Scraper) ──────
   ★ 토큰은 화면 코드에 없다. 서버(api/instagram.py)만 APIFY_TOKEN 을 안다.
   ★ 평소에는 미리 수집해 커밋해 둔 public/data/instagram.json 을 읽는다(호출 0회).
     파일이 없을 때만 /api/instagram 으로 폴백한다 — 국내·국외 정적 JSON 과 같은 방식. */
const IG_DATA_URL = 'public/data/instagram.json';
let _igData = null;   // { status, username, items:[{id,caption,image,link,date}] }

/** 데이터 로드. 실패해도 다른 카드에 영향을 주지 않는다(국외 로더와 같은 모양). */
async function fetchInstagram() {
  try {
    const res = await fetch(IG_DATA_URL, { cache: 'no-store' });
    if (res.ok) {
      const d = await res.json();
      if (d && Array.isArray(d.items) && d.items.length) {
        _igData = Object.assign({ status: 'ok' }, d);
        renderInstagram();
        return;
      }
    } else if (res.status !== 404) {
      console.warn('[instagram] 정적 파일 HTTP', res.status, '→ /api/instagram 으로 폴백');
    }
    // 파일이 없거나 비었으면 서버리스 함수에 물어본다(로컬 개발·첫 배포 직후)
    const r2 = await fetch(API_BASE + '/api/instagram', { cache: 'no-store' });
    if (!r2.ok) throw new Error('HTTP ' + r2.status);
    _igData = await r2.json();
  } catch (e) {
    _igData = { status: 'error', items: [], reason: (e && e.message) || String(e) };
    console.warn('[instagram] 로드 실패:', e);
  }
  renderInstagram();
}

/** 상태값 → 화면에 띄울 안내 문구. 지어내지 않고 이유를 그대로 말한다. */
function igEmptyMsg(d) {
  if (!d) return '업데이트를 누르면 최신 게시물을 불러옵니다';
  if (d.status === 'no_key') return 'Instagram 연동 준비 중 (APIFY_TOKEN 필요)';
  if (d.status === 'error') return '게시물을 불러오지 못했습니다' + (d.reason ? ' — ' + d.reason : '');
  return '게시물이 없습니다';
}

/** SIMMONS IG — 이미지 + 캡션 요약 + '인스타그램에서 보기' 카드 그리드 */
function renderInstagram() {
  const el = document.getElementById('igGrid');
  if (!el) return;
  const items = (_igData && Array.isArray(_igData.items)) ? _igData.items : null;
  if (!items || !items.length) {
    el.innerHTML = emptyState(igEmptyMsg(_igData));
    return;
  }
  el.innerHTML = items.map((it) => {
    const url = safeUrl(it.link);
    const img = safeUrl(it.image);
    // 이미지가 없거나 로드에 실패하면 대체 블록(크림슨 그라데이션 + 안내 문구)을 보여준다.
    // 인스타그램 CDN 주소는 서명이 만료되면 404 가 나므로 실패는 정상 경로로 다룬다.
    const thumb = img
      ? `<div class="ig-card__thumb"><img src="${escapeHtml(img)}" alt="${escapeHtml(it.caption || 'Instagram 게시물')}"
           loading="lazy" referrerpolicy="no-referrer"
           onerror="this.parentNode.classList.add('ig-card__thumb--ph');this.remove()"><span class="ig-card__alt">이미지를 불러올 수 없습니다</span></div>`
      : `<div class="ig-card__thumb ig-card__thumb--ph"><span class="ig-card__alt">이미지 없음</span></div>`;
    const cap = String(it.caption || '').trim();
    return `<div class="ig-card">
      ${thumb}
      <div class="ig-card__body">
        <p class="ig-card__cap">${cap ? escapeHtml(cap) : '<span class="ig-card__nocap">캡션 없음</span>'}</p>
        <div class="ig-card__foot">
          ${it.date ? `<span class="ig-card__date">${escapeHtml(it.date)}</span>` : ''}
          ${url ? `<a class="ig-card__link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">인스타그램에서 보기 ›</a>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}


/* ============================================================
   3) 경쟁사 분석 섹션 — 국외(Global) / 국내(Korea) 두 그룹
   국외: SEC EDGAR 최근 분기(10-Q) 매출·순이익 + 전년 동기 대비(YoY).
   국내: 준비중(추후 DART).  ※ 경쟁사 섹션은 .viz-root 밖 → 전역(:root) 색 토큰 사용
   ============================================================ */
const COMP_COLORS = ['var(--blue)', 'var(--green)', 'var(--amber)', 'var(--violet)'];

// { global:[{name,ticker,quarter,revenue,revenue_yoy,net_income,net_income_yoy,logo_url}], korea:{status} }
let _competitors = null;

/** 큰 USD 금액 포맷: $X.XXB / $XXX.XM / $숫자 */
function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  const n = Number(v), a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

/** 원화 금액을 조/억/만 원 단위로 읽기 좋게(반올림). 음수는 '-' 유지. */
function fmtKrwShort(v) {
  if (v == null || !isFinite(v)) return null;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(1)}조 원`;
  if (a >= 1e8) return `${sign}${Math.round(a / 1e8).toLocaleString('ko-KR')}억 원`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString('ko-KR')}만 원`;
  return `${sign}${Math.round(a).toLocaleString('ko-KR')}원`;
}

/** 응답의 competitors 저장 후 섹션 갱신 */
function applyCompetitorsUpdate(data) {
  const cp = data && data.sections && data.sections.competitors;
  if (!cp) return;
  _competitorsAt = (data && data.updated_at) || null;  // 순수 추가: 수집 시각 표시용
  _competitors = cp.global ? cp : null;
  if (cp.status === 'error') console.warn('[update] competitors error:', cp.reason);
  renderCompetitor();
}

/** YoY 배지: 오르면 빨강 ▲ / 내리면 초록 ▼ (stk-chg 색상 재사용) */
function compYoy(yoy) {
  const cls = yoy == null ? 'flat' : (yoy > 0 ? 'up' : yoy < 0 ? 'down' : 'flat');
  const txt = yoy == null ? '—' : `${yoy > 0 ? '▲' : yoy < 0 ? '▼' : ''} ${Math.abs(yoy).toFixed(1)}%`;
  return `<span class="stk-chg ${cls}">${txt} <span class="gco-yoy">YoY</span></span>`;
}

/** 로고 onerror 체인: data-srcs(|구분)의 다음 후보로 교체, 다 떨어지면 제거→텍스트 노출 */
function cLogoNext(img) {
  const rest = (img.getAttribute('data-srcs') || '').split('|').filter(Boolean);
  if (rest.length) {
    img.setAttribute('data-srcs', rest.slice(1).join('|'));
    img.src = rest[0];
  } else {
    img.remove();
  }
}

/** 매출/순이익 행: USD(주) + 원화 환산(보조, 회색) + YoY 배지 */
function compMetricRow(label, usd, yoy, rate) {
  const krw = (rate != null) ? fmtKrwShort(usd == null ? null : usd * rate) : null;
  return `<div class="gco-row">
    <span class="gco-row__lbl">${escapeHtml(label)}</span>
    <span class="gco-row__main">
      <span class="gco-row__val">${fmtUsd(usd)}</span>
      ${krw ? `<span class="gco-row__krw">≈ ${escapeHtml(krw)}</span>` : ''}
    </span>
    ${compYoy(yoy)}
  </div>`;
}

/** 국외 회사 카드 (로고 + 회사명/티커 + 분기 + 매출/순이익 USD·KRW + YoY) */
function compGlobalCard(c, i, rate) {
  const color = COMP_COLORS[i % COMP_COLORS.length];
  // 로고 소스 다중 시도: logo_urls[0]→[1]→[2] 순서로 onerror 체인, 다 깨지면 티커 텍스트.
  const srcs = (Array.isArray(c.logo_urls) ? c.logo_urls : (c.logo_url ? [c.logo_url] : []))
    .map(safeUrl).filter(Boolean);
  // 로고 위에 티커 텍스트를 깔아, 이미지가 모두 실패하면 텍스트가 드러남
  const logoImg = srcs.length
    ? `<img class="gco-logo__img" src="${escapeHtml(srcs[0])}" alt="${escapeHtml(c.name)}" loading="lazy" referrerpolicy="no-referrer" data-srcs="${escapeHtml(srcs.slice(1).join('|'))}" onerror="cLogoNext(this)">`
    : '';
  const hasData = c.revenue != null || c.net_income != null;
  // 순수 추가: 비상장 기업은 실적이 없다 — 추정치를 만들지 않고 그대로 알린다.
  const emptyTxt = (c.public === false) ? '비상장 · 실적 미공시' : '데이터 준비중';
  const body = hasData
    ? compMetricRow('매출', c.revenue, c.revenue_yoy, rate)
      + compMetricRow('순이익', c.net_income, c.net_income_yoy, rate)
    : '<div class="gco-empty' + (c.public === false ? ' gco-empty--priv' : '') + '">'
      + emptyTxt + '</div>';
  return `<div class="gco-card" style="--c:${color}">
    <div class="gco-head">
      <div class="gco-logo"><span class="gco-logo__txt">${escapeHtml(c.ticker || c.name)}</span>${logoImg}</div>
      <div class="gco-id">
        <div class="gco-name">${escapeHtml(c.name)} <span class="gco-tk">(${escapeHtml(c.ticker)})</span></div>
        <div class="gco-qtr">${escapeHtml(c.quarter || '—')}${compQtrLag(c, _compLatest)}</div>
      </div>
    </div>
    <div class="gco-body">${body}</div>
  </div>`;
}

let _competitorsAt = null;   // 순수 추가: 마지막 수집 시각(카드 표기용)
let _compLatest = null;      // 순수 추가: 현재 렌더 중인 그룹의 최신 분기(지연 표기 기준)

/* ── 분기 표기 헬퍼 (순수 추가 · 표시 전용) ──────────────────────────────
   기업마다 공시 시점이 달라 표시 분기가 섞인다. 어느 시점을 보고 있는지
   한눈에 드러나게 하는 표기만 담당하며, 수집·계산에는 관여하지 않는다. */

/** "2026 Q2" → 20262 (비교용 정수). 형식이 다르면 null. */
function compQtrOrd(q) {
  const m = /^(\d{4})\s*Q([1-4])$/.exec(String(q || '').trim());
  return m ? Number(m[1]) * 10 + Number(m[2]) : null;
}

/** 정수 → "2026 Q2" */
function compQtrLabel(o) {
  return `${Math.floor(o / 10)} Q${o % 10}`;
}

/** 그룹의 분기 요약 → {label, latest, mixed}. 값이 없으면 null. */
function compQtrSummary(list) {
  const ords = (list || []).map((c) => compQtrOrd(c.quarter)).filter((v) => v != null);
  if (!ords.length) return null;
  const mn = Math.min.apply(null, ords), mx = Math.max.apply(null, ords);
  if (mn === mx) return { label: `${compQtrLabel(mx)} 기준`, latest: mx, mixed: false };
  // 같은 해면 "2026 Q1~Q2", 해를 넘으면 "2025 Q4~2026 Q1"
  const label = (Math.floor(mn / 10) === Math.floor(mx / 10))
    ? `${compQtrLabel(mn)}~Q${mx % 10} 기준`
    : `${compQtrLabel(mn)}~${compQtrLabel(mx)} 기준`;
  return { label, latest: mx, mixed: true };
}

/** 최신 분기가 아닌 기업에 붙일 작은 안내(경고 아님). 최신이면 ''. */
function compQtrLag(c, latest) {
  const o = compQtrOrd(c.quarter);
  if (o == null || latest == null || o >= latest) return '';
  const gap = (Math.floor(latest / 10) - Math.floor(o / 10)) * 4 + (latest % 10 - o % 10);
  return `<span class="gco-lag">${gap <= 1 ? '직전 분기' : `${gap}분기 전`}</span>`;
}

/** 순수 추가: 출처 캡션 뒤에 붙일 " · YYYY-MM-DD HH:MM 수집". 시각 없으면 ''. */
function compFetchedAt() {
  return _competitorsAt ? ` · ${escapeHtml(String(_competitorsAt).slice(0, 16))} 수집` : '';
}

/** 분기 매출 막대 (회사별 색). key=값 필드, fmt=포맷터, tkKey=티커/코드 필드 */
function compRevBars(companies, key, fmt, tkKey) {
  key = key || 'revenue'; fmt = fmt || fmtUsd; tkKey = tkKey || 'ticker';
  const withRev = companies.filter((c) => c[key] != null && c[key] > 0);
  if (!withRev.length) return '';
  const maxV = Math.max(...withRev.map((c) => c[key]));
  // 순수 추가: 막대마다 어느 분기 값인지 병기한다(서로 다른 분기를 나란히 비교하게 되므로).
  const sum = compQtrSummary(companies);
  const bars = companies.map((c, i) => {
    const color = COMP_COLORS[i % COMP_COLORS.length];
    const v = c[key], tk = c[tkKey] || '';
    const qtr = c.quarter
      ? `<span class="gbar__qtr">· ${escapeHtml(c.quarter)}</span>${compQtrLag(c, sum && sum.latest)}` : '';
    if (v == null) {
      return `<div class="gbar"><div class="gbar__head"><span>${escapeHtml(c.name)} ${qtr}</span><span class="gbar__val">—</span></div></div>`;
    }
    const pct = Math.max(2, (v / maxV) * 100);
    return `<div class="gbar">
      <div class="gbar__head"><span>${escapeHtml(c.name)} ${tk ? `<span class="gco-tk">(${escapeHtml(tk)})</span>` : ''} ${qtr}</span><span class="gbar__val">${escapeHtml(fmt(v))}</span></div>
      <div class="gbar__track"><div class="gbar__fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
    </div>`;
  }).join('');
  // 분기가 섞였을 때만 안내 한 줄(오류가 아니라 정상적인 공시 시차임을 알린다).
  const note = (sum && sum.mixed)
    ? '<div class="gbars__note">일부 기업은 최신 분기가 아직 공시되지 않아 직전 분기 기준입니다.</div>' : '';
  return `<h3 class="subhead">분기 매출 비교</h3>${note}<div class="gbars">${bars}</div>`;
}

/** 국내 회사 카드 (네이버 금융): 로고 + 회사명/코드 + 분기 + 매출/순이익(원화) + YoY */
function compKoreaCard(c, i) {
  const color = COMP_COLORS[i % COMP_COLORS.length];
  const srcs = (Array.isArray(c.logo_urls) ? c.logo_urls : []).map(safeUrl).filter(Boolean);
  const logoImg = srcs.length
    ? `<img class="gco-logo__img" src="${escapeHtml(srcs[0])}" alt="${escapeHtml(c.name)}" loading="lazy" referrerpolicy="no-referrer" data-srcs="${escapeHtml(srcs.slice(1).join('|'))}" onerror="cLogoNext(this)">`
    : '';
  const krwRow = (label, v, yoy) => `<div class="gco-row">
    <span class="gco-row__lbl">${label}</span>
    <span class="gco-row__main"><span class="gco-row__val">${escapeHtml(fmtKrwShort(v) || '—')}</span></span>
    ${compYoy(yoy)}
  </div>`;
  const hasData = c.revenue_krw != null || c.net_income_krw != null;
  const body = hasData
    ? krwRow('매출', c.revenue_krw, c.revenue_yoy) + krwRow('순이익', c.net_income_krw, c.net_income_yoy)
    : '<div class="gco-empty">데이터 없음</div>';
  return `<div class="gco-card" style="--c:${color}">
    <div class="gco-head">
      <div class="gco-logo"><span class="gco-logo__txt">${escapeHtml((c.name || '').slice(0, 2))}</span>${logoImg}</div>
      <div class="gco-id">
        <div class="gco-name">${escapeHtml(c.name)} <span class="gco-tk">(${escapeHtml(c.code || '')})</span></div>
        <div class="gco-qtr">${escapeHtml(c.quarter || '—')}${compQtrLag(c, _compLatest)}</div>
      </div>
    </div>
    <div class="gco-body">${body}</div>
  </div>`;
}

/* ── 국외(Global) 차트 공용 상태 ───────────────────────────────────────── */
let _gtCharts = {};         // 차트 툴팁 데이터·기하 (gtState/gtShowTip 공용)


/* 카드별 원본 페이지 — 각주의 기관·페이지 이름을 이 주소로 건다.
   ★ 미국 PPI 각주가 쓰는 gLinkify(text, links) 와 같은 형식이라 함수를 재사용한다.
     새 카드에 링크를 붙일 때도 여기 한 줄만 추가하면 된다. */
const SRC_LINKS = {
  sea: [{ text: 'Sea-Intelligence',
    url: 'https://www.sea-intelligence.com/press-room/400-global-schedule-reliability-drops-to-62-6-in-june-2026' }],
  oilCrude: [{ text: '일일국제원유가격', url: 'https://www.petronet.co.kr/v4/sub.jsp' }],
  oilProduct: [{ text: '일일국제제품가격', url: 'https://www.petronet.co.kr/v4/sub.jsp' }],
  koimaIndex: [{ text: '한국수입협회 국제원자재가격정보',
    url: 'https://www.koimaindex.com/koimaindex/koima/item/index/retrieveList.do' }],
  koimaPrice: [{ text: '한국수입협회 국제원자재가격정보',
    url: 'https://www.koimaindex.com/koimaindex/koima/price/detailView.do' }],
};

/** 카드 하단 출처 각주(.comp-caption) — 문구는 그대로 두고 이름만 링크로 만든다. */
function capSrc(text, links) {
  return '<div class="comp-caption">' + gLinkify(text, links) + '</div>';
}

/** 각주 문구 안의 특정 토막(시리즈 코드·품목 코드 등)만 원본 페이지 링크로 바꾼다.
    links: [{text, url}] — payload 가 준다. 어느 지표든 이 모양만 실어 보내면 된다.
    ★ 문자열을 순차 치환하지 않는다. 앞서 넣은 <a href="…PCU337910337910…"> 안의
      코드가 다음 치환에 다시 걸리는 사고를 구조적으로 막기 위해, 원문을 앞에서부터
      한 번만 훑으며 토막을 만나면 링크로, 아니면 한 글자씩 escape 해 쌓는다.
    ★ 정규식을 쓰지 않으므로 코드에 어떤 문자가 들어와도 이스케이프 사고가 없다. */
function gLinkify(text, links) {
  const src = String(text == null ? '' : text);
  const ls = (links || []).filter((l) => l && l.text && safeUrl(l.url))
    .slice().sort((a, b) => b.text.length - a.text.length);   // 긴 토막을 먼저 맞춘다
  if (!ls.length) return escapeHtml(src);
  let out = '', i = 0;
  while (i < src.length) {
    const hit = ls.filter((l) => src.startsWith(l.text, i))[0];
    if (hit) {
      out += '<a class="src-link" href="' + escapeHtml(safeUrl(hit.url))
        + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(hit.text) + '</a>';
      i += hit.text.length;
    } else {
      out += escapeHtml(src.charAt(i));
      i += 1;
    }
  }
  return out;
}

/* ══ 글로벌 매트리스 시장 규모 (Global Market Insights) ═══════════════════
   요약 4박스 → 시장규모 막대 / 지역별 우위 / 주요 기업 3분할 → 제품유형 인사이트
   ★ 대시보드는 수집해 둔 캐시(public/data/global-mattress-market.json)만 읽는다.
     페이지를 직접 부르지 않는다 — 갱신은 GitHub Actions(월 1회)가 한다.
   ★★ 정부 통계가 아니라 '조사기관 추정치'다. 기관마다 값이 다르다는 점은
     하단 '같은 해 다른 조사기관 추정치' 표(estimates)가 숫자로 보여 준다. */
const GMM_URL = 'public/data/global-mattress-market.json';
let _gmm = null;

async function fetchMattressMarket() {
  try {
    const res = await fetch(GMM_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _gmm = d;
  } catch (e) {
    _gmm = null;
    console.warn('[mattress-market] 로드 실패:', e);
  }
  renderCompetitor();
}

/** $45.8B → '458억 달러' (조사기관이 십억 달러 단위로 적는 값을 우리 단위로) */
function gmmEok(usdBn) {
  if (usdBn == null || !isFinite(usdBn)) return '—';
  return (Math.round(usdBn * 10) / 10 * 10).toFixed(0) + '억 달러';
}

/** 십억 달러 → '≈ 61.4조원'. 환율은 대시보드가 이미 쓰는 값을 그대로 재사용한다
 *  (krwRate('USD') — 원자재 위젯·환율 카드와 같은 출처). 환율을 못 읽으면 ''. */
function gmmKrw(usdBn) {
  const r = krwRate('USD');
  if (r == null || usdBn == null || !isFinite(usdBn)) return '';
  const w = usdBn * 1e9 * r;
  const t = (w >= 1e12) ? (w / 1e12).toFixed(1) + '조원'
    : Math.round(w / 1e8).toLocaleString('ko-KR') + '억원';
  return '≈ ' + t;
}

/** 원화를 작은 글씨로 덧붙이는 조각 */
function gmmKrwTag(usdBn, cls) {
  const t = gmmKrw(usdBn);
  return t ? '<span class="' + (cls || 'gmm-krw') + '">' + escapeHtml(t) + '</span>' : '';
}

/** 요약 4박스 — 최근년도 / 다음년도 / 목표연도 / CAGR */
function gmmSummary(d) {
  const box = (lbl, val, sub) => '<div class="sr-sum__box">'
    + '<div class="sr-sum__lbl">' + escapeHtml(lbl) + '</div>'
    + '<div class="sr-sum__val">' + val + '</div>'
    + (sub ? '<div class="sr-sum__sub">' + sub + '</div>' : '') + '</div>';
  const one = (o, lbl) => (o ? box(o.year + '년 ' + lbl,
    gmmEok(o.usdBn) + gmmKrwTag(o.usdBn, 'sr-sum__krw'),
    '$' + o.usdBn + 'B') : '');
  const c = d.cagr || {};
  return '<div class="sr-sum gmm-sum">'
    + one(d.base, '시장규모') + one(d.next, '시장규모') + one(d.target, '예상규모')
    + (c.pct != null ? box('연평균 성장률 (CAGR)', c.pct.toFixed(1) + '<span class="sr-sum__u">%</span>',
      (c.from && c.to) ? escapeHtml(c.from + '~' + c.to + '년') : '조사기관 전망') : '')
    + '</div>';
}

/** 시장규모 막대 — 세 시점(최근/다음/목표)을 비교한다 */
function gmmBars(d) {
  const pts = [d.base, d.next, d.target].filter((x) => x && x.usdBn > 0);
  if (pts.length < 2) return '';
  const max = Math.max.apply(null, pts.map((x) => x.usdBn));
  const rows = pts.map((x, i) => {
    const w = Math.max(3, (x.usdBn / max) * 100);
    const last = i === pts.length - 1;
    return '<div class="sm-hrow">'
      + '<div class="sm-hname">' + x.year + '년'
      + (last ? '<span class="gmm-tag">전망</span>' : (i === 0 ? '' : '<span class="gmm-tag">전망</span>'))
      + '</div>'
      + '<div class="sm-htrack"><div class="sm-hbar" style="width:' + w.toFixed(1)
      + '%;background:var(--blue);opacity:' + (0.5 + i * 0.25).toFixed(2) + '"></div></div>'
      + '<div class="sm-hval">' + gmmEok(x.usdBn)
      + '<span class="sm-hkrw">$' + x.usdBn + 'B · ' + escapeHtml(gmmKrw(x.usdBn)) + '</span></div>'
      + '</div>';
  }).join('');
  return '<div class="gmm-card"><div class="gmm-card__h">시장규모 동향</div>'
    + '<div class="sm-hbars sm-hbars--inv">' + rows + '</div>'
    + '<div class="gmm-card__f">' + escapeHtml(d.base ? (d.base.year + '년 실측 추정치, 이후는 전망') : '')
    + '</div></div>';
}

/** 지역별 우위 */
function gmmRegions(d) {
  const r = d.regions;
  if (!r) return '';
  const row = (k, v, sub) => '<div class="gmm-row"><span class="gmm-row__k">' + escapeHtml(k)
    + '</span><span class="gmm-row__v">' + escapeHtml(v)
    + (sub ? '<i>' + escapeHtml(sub) + '</i>' : '') + '</span></div>';
  return '<div class="gmm-card"><div class="gmm-card__h">지역별 우위</div>'
    + (r.largest ? row('최대 시장', r.largest,
      r.largestUsdBn != null
        ? gmmEok(r.largestUsdBn) + ' ' + gmmKrw(r.largestUsdBn)
          + (d.base ? ' (' + d.base.year + '년)' : '')
        : '') : '')
    + (r.fastest ? row('가장 빠른 성장', r.fastest,
      r.fastestPct != null ? '연 ' + r.fastestPct + '% 성장 전망' : '') : '')
    + '</div>';
}

/** 주요 기업 — 선도기업 점유율 + 상위 기업 합산 */
function gmmPlayers(d) {
  const L = d.leader, T = d.topPlayers;
  if (!L && !T) return '';
  const names = (T && Array.isArray(T.names)) ? T.names : [];
  /* 시몬스(Serta Simmons Bedding)가 목록에 있으면 눈에 띄게 둔다 */
  const chips = names.map((n) => '<span class="gmm-chip'
    + (/simmons/i.test(n) ? ' gmm-chip--mine' : '') + '">' + escapeHtml(n) + '</span>').join('');
  return '<div class="gmm-card"><div class="gmm-card__h">주요 기업</div>'
    + (L ? '<div class="gmm-lead"><span class="gmm-lead__n">' + escapeHtml(L.name) + '</span>'
      + '<span class="gmm-lead__v">' + L.sharePct + '%</span>'
      + '<span class="gmm-lead__s">' + (L.year ? L.year + '년 ' : '') + '점유율 1위</span></div>' : '')
    + (T ? '<div class="gmm-row"><span class="gmm-row__k">상위 ' + names.length + '개사 합산</span>'
      + '<span class="gmm-row__v">' + T.sharePct + '%'
      + (T.year ? '<i>' + T.year + '년 기준</i>' : '') + '</span></div>' : '')
    + (chips ? '<div class="gmm-chips">' + chips + '</div>' : '')
    + '</div>';
}

/** 제품유형·유통 인사이트 — 무료 요약에서 확인된 것만 문장으로 */
function gmmProducts(d) {
  const ps = Array.isArray(d.products) ? d.products : [];
  if (!ps.length) return '';
  const li = ps.map((p) => {
    const bits = [];
    if (p.usdBn != null) bits.push(gmmEok(p.usdBn) + (p.year ? ' (' + p.year + '년)' : ''));
    if (p.cagrPct != null) bits.push('연 ' + p.cagrPct + '% 성장'
      + (p.to ? ' (~' + p.to + '년)' : ''));
    return '<li><b>' + escapeHtml(p.ko || p.name) + '</b> '
      + escapeHtml(bits.join(' · ')) + (p.note ? ' <i>' + escapeHtml(p.note) + '</i>' : '') + '</li>';
  }).join('');
  return '<div class="gmm-prod"><div class="gmm-card__h">제품유형·유통 인사이트</div>'
    + '<ul class="gmm-prod__ul">' + li + '</ul>'
    + '<div class="gmm-card__f">공개 요약에서 확인되는 항목만 적었습니다. '
    + '제품유형 전체 구성비는 유료 보고서에만 있어 만들지 않았습니다.</div></div>';
}

/** 조사기관별 추정치 대조 — '기관마다 다르다'를 숫자로 보여 준다 */
function gmmEstimates(d) {
  const es = Array.isArray(d.estimates) ? d.estimates : [];
  if (!es.length) return '';
  return '<div class="gmm-est"><span class="gmm-est__h">같은 해 다른 조사기관 추정치</span>'
    + es.map((e) => {
      /* '$577억' 같은 표기에서 숫자만 뽑아 십억 달러로 되돌린 뒤 원화를 붙인다 */
      const m = String(e.value || '').match(/([\d,.]+)\s*억/);
      const bn = m ? Number(m[1].replace(/,/g, '')) / 10 : null;
      return '<span class="gmm-est__i' + (e.self ? ' is-self' : '') + '">'
        + escapeHtml(e.org) + ' <b>' + escapeHtml(e.value) + '</b>'
        + (bn ? ' <span class="gmm-krw">' + escapeHtml(gmmKrw(bn)) + '</span>' : '')
        + (e.year ? ' <i>' + e.year + '</i>' : '') + '</span>';
    }).join('')
    + '</div>';
}

/** 글로벌 매트리스 시장 규모 블록 전체 */
function gmmBlock() {
  const d = _gmm;
  if (!d) return emptyState('업데이트 버튼을 누르면 표시됩니다');
  if (d.status !== 'ok') {
    return emptyState('데이터를 불러오지 못했습니다'
      + (d.reason ? ' (' + d.reason + ')' : ''));
  }
  const stale = d.last_error
    ? '<div class="g-note gmm-stale">※ 최근 자동 수집이 실패해 이전 값을 그대로 보여 주고 있습니다'
      + (d.last_attempt ? ' (마지막 시도 ' + escapeHtml(d.last_attempt) + ')' : '')
      + '. 사유: ' + escapeHtml(d.last_error) + '</div>'
    : '';
  return gmmSummary(d)
    + '<div class="gmm-grid3">' + gmmBars(d) + gmmRegions(d) + gmmPlayers(d) + '</div>'
    + gmmProducts(d)
    + gmmEstimates(d)
    + krwNote('USD')
    + stale
    /* 적용 환율 줄 바로 아래 — 출처를 먼저, 최종 확인일을 뒤에 적는다.
       확인일은 수집 스크립트가 기록한 실제 날짜(checkedAt)다. */
    + '<div class="sm-foot">출처: ' + (safeUrl(d.sourceUrl)
      ? '<a class="src-link" href="' + escapeHtml(safeUrl(d.sourceUrl)) + '" target="_blank"'
        + ' rel="noopener noreferrer">' + escapeHtml(d.source || '') + ' ›</a>'
      : escapeHtml(d.source || ''))
    + ' · 최종 확인일: ' + escapeHtml(d.checkedAt || d.updatedAt || '—') + '</div>';
}

/* ══ 국내 섹션 — 시몬스/경쟁사 실적·점유율 (public/data/simmons-market.json) ══
   ★ 값을 하드코딩하지 않는다. 이 파일 하나만 갱신되면 차트가 자동으로 따라간다.
   ★ 시몬스는 비상장사라 공시 API 자동 조회가 안 된다 — 수기 입력값임을 ⓘ 로 밝힌다. */
const SM_DATA_URL = 'public/data/simmons-market.json';
const SM_COL_REV = 'var(--accent)';                 // 매출 — 빨강(차트 A·B)
const SM_COL_OP = 'var(--blue)';                    // 영업이익 — 파랑
const SM_SHARE_COL = {                              // 점유율 — 브랜드 구분색, 기타는 회색
  '코웨이': '#3B82F6',
  '시몬스': 'var(--accent)',
  '에이스침대': '#F59E0B',
  '기타업체': '#9CA3AF',
};
const SM_TIP = '시몬스는 비상장사로 DART 등 공시 API 자동 조회가 불가능합니다. '
  + '표시된 수치는 각 연도 실적 발표 기사(헤럴드경제·아주경제·인더스트리뉴스 등)를 '
  + '기준으로 수기 입력한 값이며, 감사보고서 확정치와 다를 수 있습니다.';
let _smData = null;      // {status:'ok'|'error', ...} — 로드 결과
const SM_W = 720;        // 차트 A viewBox 가로(다른 차트와 같은 기준)

/** 데이터 로드. 실패해도 다른 카드에 영향을 주지 않는다. */
async function fetchSimmonsMarket() {
  try {
    const res = await fetch(SM_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 (' + SM_DATA_URL + ')');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || !Array.isArray(d.simmonsPerformance)) throw new Error('형식이 올바르지 않습니다');
    _smData = Object.assign({ status: 'ok' }, d);
  } catch (e) {
    _smData = { status: 'error', reason: (e && e.message) || String(e) };
    console.warn('[simmons-market] 로드 실패:', e);
  }
  renderCompetitor();
}

/** 억원 정수 — 3,239 */
function smNum(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('ko-KR');
}

/** 증감률 배지. 양수 초록 ▲ / 음수 빨강 ▼ */
function smDelta(pct) {
  if (pct == null) return '';
  const up = pct > 0, flat = pct === 0;
  const cls = flat ? 'flat' : (up ? 'up' : 'down');
  const ar = flat ? '–' : (up ? '▲' : '▼');
  return '<span class="sm-delta ' + cls + '">' + ar + ' '
    + Math.abs(pct).toFixed(1) + '%</span>';
}

/** 차트 A — 시몬스 최근 실적 추이. 매출 막대 + 영업이익 라인(같은 억원 축). */
function smPerfChart(d) {
  const rows = (d.simmonsPerformance || []).slice().sort((a, b) => a.year - b.year);
  if (!rows.length) return '';
  const H = 208, padL = 46, padR = 14, padT = 26, padB = 30;
  const plotW = SM_W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max.apply(null, rows.map((r) =>
    Math.max(r.revenue || 0, r.operatingProfit || 0)));
  const top = maxV * 1.14 || 1;
  const y = (v) => padT + plotH - (v / top) * plotH;
  const slot = plotW / rows.length;
  const bw = Math.min(52, slot * 0.42);
  const cx = (i) => padL + slot * (i + 0.5);

  let grid = '';
  for (let t = 0; t <= VIZ_Y_TICKS; t += 1) {
    const v = (top / VIZ_Y_TICKS) * t, yy = y(v);
    grid += '<line class="sm-grid" x1="' + padL + '" x2="' + (SM_W - padR)
      + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '"/>'
      + '<text class="sm-ax" x="' + (padL - 6) + '" y="' + (yy + 3).toFixed(1)
      + '" text-anchor="end">' + smNum(Math.round(v)) + '</text>';
  }
  const bars = rows.map((r, i) => {
    const yy = y(r.revenue), h = Math.max(0, padT + plotH - yy);
    return '<rect class="sm-bar" x="' + (cx(i) - bw / 2).toFixed(1) + '" y="' + yy.toFixed(1)
      + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1)
      + '" rx="2" fill="' + SM_COL_REV + '"/>'
      + '<text class="sm-lab" x="' + cx(i).toFixed(1) + '" y="' + (yy - 5).toFixed(1)
      + '" text-anchor="middle" fill="' + SM_COL_REV + '">' + smNum(r.revenue) + '</text>';
  }).join('');
  const pts = rows.map((r, i) => cx(i).toFixed(1) + ',' + y(r.operatingProfit).toFixed(1));
  const line = '<polyline class="sm-line" points="' + pts.join(' ')
    + '" fill="none" stroke="' + SM_COL_OP + '"/>';
  const dots = rows.map((r, i) => '<circle class="sm-dot" cx="' + cx(i).toFixed(1)
    + '" cy="' + y(r.operatingProfit).toFixed(1) + '" r="3" fill="' + SM_COL_OP + '"/>'
    + '<text class="sm-lab" x="' + cx(i).toFixed(1) + '" y="'
    + (y(r.operatingProfit) - 7).toFixed(1) + '" text-anchor="middle" fill="' + SM_COL_OP
    + '">' + smNum(r.operatingProfit) + '</text>').join('');
  const xs = rows.map((r, i) => '<text class="sm-ax" x="' + cx(i).toFixed(1)
    + '" y="' + (H - 9) + '" text-anchor="middle">' + r.year + '</text>').join('');

  return '<svg class="sm-svg" viewBox="0 0 ' + SM_W + ' ' + H
    + '" role="img" aria-label="시몬스 최근 실적 추이">'
    + grid + bars + line + dots + xs + '</svg>'
    + '<div class="sm-legend">'
    + '<span><i style="background:' + SM_COL_REV + '"></i>매출</span>'
    + '<span><i class="sm-legend__l" style="background:' + SM_COL_OP + '"></i>영업이익</span>'
    + '</div>';
}

/** 차트 B — 지난해 매출 비교(가로 막대) + 증감률 + note 각주 */
function smRevCompare(d) {
  const c = d.competitorRevenueLastYear;
  if (!c || !Array.isArray(c.companies) || !c.companies.length) return '';
  const rows = c.companies.slice().sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  const max = Math.max.apply(null, rows.map((r) => r.revenue || 0)) || 1;
  const bars = rows.map((r) => {
    const w = Math.max(2, ((r.revenue || 0) / max) * 100);
    const mine = String(r.name).indexOf('시몬스') === 0;
    // ★ 회사마다 기준 회계연도가 다르다(2023~2025). 막대마다 밝혀 오해를 막는다.
    const yr = r.year ? '<span class="sm-hyr">(' + escapeHtml(String(r.year)) + '년)</span>' : '';
    const memo = r.memo ? '<div class="sm-hmemo">' + escapeHtml(r.memo) + '</div>' : '';
    return '<div class="sm-hrow' + (mine ? ' is-mine' : '') + '">'
      + '<div class="sm-hname" title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + yr + '</div>'
      + '<div class="sm-htrack"><div class="sm-hbar" style="width:' + w.toFixed(1) + '%"></div></div>'
      + '<div class="sm-hval">' + smNum(r.revenue) + ' ' + smDelta(r.yoyChangePct) + '</div>'
      + memo
      + '</div>';
  }).join('');
  const notes = Array.isArray(c.notes) ? c.notes : (c.note ? [c.note] : []);
  return '<div class="sm-hbars">' + bars + '</div>'
    + notes.map((t) => '<div class="sm-foot">※ ' + escapeHtml(t) + '</div>').join('');
}

/** 차트 C — 점유율 도넛. 중앙에 제목 + 출처. */
function smShareDonut(d) {
  const m = d.marketShare2025;
  if (!m || !Array.isArray(m.data) || !m.data.length) return '';
  const rows = m.data.filter((r) => r && r.share > 0);
  const tot = rows.reduce((s, r) => s + r.share, 0) || 1;
  const S = 200, cc = S / 2, R = 78, TH = 26;
  const rr = R - TH / 2;
  const circ = 2 * Math.PI * rr;
  let acc = 0;
  const segs = rows.map((r) => {
    const frac = r.share / tot;
    const seg = '<circle class="sm-seg" cx="' + cc + '" cy="' + cc + '" r="' + rr
      + '" fill="none" stroke="' + (SM_SHARE_COL[r.name] || '#9CA3AF')
      + '" stroke-width="' + TH + '" stroke-dasharray="'
      + (circ * frac).toFixed(2) + ' ' + (circ * (1 - frac)).toFixed(2) + '"'
      + ' stroke-dashoffset="' + (-circ * acc).toFixed(2) + '">'
      + '<title>' + escapeHtml(r.name) + ' ' + r.share + '%</title></circle>';
    acc += frac;
    return seg;
  }).join('');
  const yr = String(m.year || 2025);
  const center = '<text class="sm-dc1" x="' + cc + '" y="' + (cc - 4)
    + '" text-anchor="middle">' + escapeHtml(yr) + '년 시장 점유율</text>'
    + '<text class="sm-dc2" x="' + cc + '" y="' + (cc + 12)
    + '" text-anchor="middle">' + escapeHtml(m.source || '') + '</text>';
  // '기타업체'는 어떤 회사인지 알 수 없어 hover 로 예시를 보여 준다(각주로도 밝힌다)
  const oNote = m.othersNote || '';
  const oLabel = m.othersLabel || '기타업체';
  const legend = rows.map((r) => {
    const isOther = (r.name === oLabel) && oNote;
    return '<span' + (isOther ? ' class="sm-oth" tabindex="0" role="note"' : '') + '>'
      + '<i style="background:' + (SM_SHARE_COL[r.name] || '#9CA3AF') + '"></i>'
      + escapeHtml(r.name) + ' <b>' + r.share + '%</b>'
      + (isOther ? '<span class="sm-oth__bub">' + escapeHtml(oNote) + '</span>' : '')
      + '</span>';
  }).join('');
  const foot = oNote ? '<div class="sm-othfoot">' + escapeHtml(oNote) + '</div>' : '';
  return '<div class="sm-donutwrap">'
    + '<svg class="sm-donut" viewBox="0 0 ' + S + ' ' + S + '" role="img" aria-label="'
    + escapeHtml(yr) + '년 시장 점유율">'
    + '<g transform="rotate(-90 ' + cc + ' ' + cc + ')">' + segs + '</g>'
    + center + '</svg>'
    + '<div class="sm-legend sm-legend--wrap">' + legend + '</div>' + foot + '</div>';
}


/** 기업 로고 — 각사 공식 사이트에서 받은 이미지를 그대로 쓴다.
    ★ 이미지를 왜곡하지 않는다: 높이만 고정하고 너비는 auto + object-fit:contain.
    ★ 로고를 찾지 못한 회사는 아무것도 그리지 않는다(임의 아이콘으로 때우지 않는다).
    ★ 파일이 없거나 깨지면 onerror 로 조용히 지운다 — 깨진 이미지 아이콘을 남기지 않게. */
function smStLogo(c, cls) {
  if (!c.logo) return '';
  return '<img class="sm-st__logo' + (cls ? ' ' + cls : '') + '" src="' + escapeHtml(c.logo)
    + '" alt="' + escapeHtml(c.name) + ' 로고" loading="lazy"'
    + ' onerror="this.remove()">';
}

/** 막대에 쓸 투자액. 국내는 억원(investEok), 국외는 백만 달러(investVal)로 들어온다.
    ★ 통화가 다른 값을 한 그래프에 섞지 않는다 — 섹션마다 st.investUnit 이 통화를 고정한다. */
function stInvestVal(c) {
  if (typeof c.investEok === 'number') return c.investEok;
  if (typeof c.investVal === 'number') return c.investVal;
  return null;
}

/** 백만 달러 → '약 1조 7,294억원' 문구. 환율이 없으면 null(= 달러만 남는다).
    ★ 계산: 백만 달러 × 1,000,000 × 환율 ÷ 100,000,000 = 억원
      = 백만 달러 × 환율 ÷ 100   (1,250 × 1,383.49 ÷ 100 = 17,293.6억원)
    ★ 환율은 국제유가·해외 시장 그래프가 쓰는 공용 헬퍼(krwRate)를 그대로 쓴다 —
      매일 자동 갱신되는 값이고, 이 카드가 따로 받아 오지 않는다. */
function stKrwEok(musd, rate) {
  if (rate == null || musd == null || !isFinite(musd)) return null;
  const eok = Math.round((Number(musd) * rate) / 100);   // 억원(정수)
  const n = (x) => x.toLocaleString('ko-KR');
  if (eok >= 10000) {
    const jo = Math.floor(eok / 10000), rest = eok % 10000;
    return '약 ' + n(jo) + '조' + (rest ? ' ' + n(rest) + '억원' : '원');
  }
  return '약 ' + n(eok) + '억원';
}

/** (3-b) 투자 유치액 막대그래프 — 매출이 아니라 '공개된 누적 투자액'으로 견준다.
    ★ 금액이 확인되지 않은 회사는 막대를 만들지 않고 왜 빠졌는지만 적는다.
    ★ 단위는 섹션이 정한다. st.investUnit 이 없으면 국내 기본값(억원)을 그대로 쓴다. */
function smStInvest(st) {
  const all = st.companies || [];
  const has = (c) => { const v = stInvestVal(c); return typeof v === 'number' && v > 0; };
  const bars = all.filter(has).slice().sort((a, b) => stInvestVal(b) - stInvestVal(a));
  if (!bars.length) return '';
  const max = Math.max.apply(null, bars.map(stInvestVal)) || 1;
  const out = all.filter((c) => !has(c));
  const unitLabel = st.investUnit || '억원';          // 제목 옆 (단위: …)
  const suffix = st.investUnit ? '' : '억';            // 값 뒤에 붙는 글자(국내: 180억)
  /* ★ 값이 달러일 때만 원화를 병기한다. 국내는 이미 억원이라 환산할 것이 없고,
     이 조건이 false 면 아래 출력이 예전과 한 글자도 다르지 않다. */
  const isUsd = /달러/.test(unitLabel);
  const rate = isUsd ? krwRate('USD') : null;
  const rows = bars.map((c) => {
    const v = stInvestVal(c);
    const krw = stKrwEok(v, rate);
    const w = Math.max(2, (v / max) * 100);
    return '<div class="sm-hrow">'
      + '<div class="sm-hname" title="' + escapeHtml(c.name) + '">' + smStLogo(c, 'sm-st__logo--bar')
      + escapeHtml(c.name) + '</div>'
      + '<div class="sm-htrack"><div class="sm-hbar" style="width:' + w.toFixed(1)
      + '%;background:' + escapeHtml(c.color || 'var(--slate)') + ';opacity:1"></div></div>'
      + '<div class="sm-hval">' + v.toLocaleString('ko-KR') + suffix
      + (krw ? '<span class="sm-hkrw">' + escapeHtml(krw) + '</span>' : '') + '</div>'
      + (c.investBasis ? '<div class="sm-hmemo">' + escapeHtml(c.investBasis) + '</div>' : '')
      + '</div>';
  }).join('');
  const excl = out.length
    ? '<div class="sm-foot">※ 그래프에서 제외: '
      + out.map((c) => escapeHtml(c.name) + '(' + escapeHtml(c.investExcluded || '금액 미확인') + ')').join(', ')
      + '</div>' : '';
  return '<h3 class="subhead sm-st__ih">' + escapeHtml(st.investHeading || '투자 유치액 비교')
    + ' <span class="sm-h__u">(단위: ' + escapeHtml(unitLabel) + ')</span></h3>'
    + (st.investNote ? '<div class="sm-othfoot">※ ' + escapeHtml(st.investNote) + '</div>' : '')
    + '<div class="sm-hbars sm-hbars--inv">' + rows + '</div>'
    + (rate != null ? krwNote('USD') : '') + excl;
}

/* ══ 국내 수면시장 — 좌우 2분할 ════════════════════════════════════════════
   왼쪽: 슬립테크 기술 분야 지도(측정→분석→개선 3단계 순서도)
   오른쪽: 시장 규모 막대그래프 + 설명 박스 + 출처·근거표
   ★ 예전에는 가로 전체를 쓰는 타임라인 하나였다. 발표 시점이 세 개뿐이라
     넓은 폭이 남았고, 그 자리에 기술 분류를 넣어 공간을 쓴다.
   ★★ 컨테이너·카드·제목은 기존 .sm-grid2 / .sm-card / .sm-h 를 그대로 쓴다. */

/** 왼쪽 — 슬립테크 기술 지도.
 *  위: '슬립테크 기술' 헤더 → 3분기 박스(웨어러블/니어러블/에어러블)
 *  아래: 구분선 + '어느 분야에 어느 기업이 있나' 카테고리 카드 3개
 *  ★ 내용은 전부 JSON(techMap)에서 온다 — 기업명·기능·승인 문구를 코드에 적지 않는다.
 *  ★★ 카드 배지는 '그 분야에 정리한 기업 수'만 센다. CES 수상 건수처럼
 *    확인되지 않은 숫자는 만들지 않는다(JSON badgeNote 에 그 사실을 적어 둔다). */
function smTechMap(d) {
  const t = d && d.techMap;
  if (!t) return '';
  const brs = Array.isArray(t.branches) ? t.branches : [];
  const cards = Array.isArray(t.cards) ? t.cards : [];
  if (!brs.length && !cards.length) return '';

  // 국내/해외 태그 — kr 은 파랑, 그 외는 회색
  const tag = (name, note, origin) => '<span class="stm2-tag stm2-tag--'
    + (origin === 'kr' ? 'kr' : 'gl') + '">'
    + '<span class="stm2-tag__n">' + escapeHtml(name || '') + '</span>'
    + (note ? '<span class="stm2-tag__d">' + escapeHtml(note) + '</span>' : '')
    + '</span>';

  const boxes = brs.map((b) => '<div class="stm2-box stm2-box--' + escapeHtml(b.tone || 'blue') + '">'
    + '<div class="stm2-box__h">' + escapeHtml(b.name || '')
    + (b.en ? '<span class="stm2-box__en">' + escapeHtml(b.en) + '</span>' : '') + '</div>'
    + (b.desc ? '<div class="stm2-box__d">' + escapeHtml(b.desc) + '</div>' : '')
    + '<div class="stm2-tags">'
    + (b.items || []).map((x) => tag(x.tag, x.note, x.origin)).join('')
    + '</div></div>').join('');

  const fork = brs.length
    ? '<div class="stm2-root">'
      + '<div class="stm2-root__box">' + escapeHtml(t.rootLabel || '슬립테크 기술')
      + (t.rootHint ? '<span class="stm2-root__hint">' + escapeHtml(t.rootHint) + '</span>' : '')
      + '</div><div class="stm2-stem" aria-hidden="true"></div></div>'
      + '<div class="stm2-fork">' + boxes + '</div>'
    : '';

  const legend = (Array.isArray(t.legend) && t.legend.length)
    ? '<div class="stm2-legend">' + t.legend.map((l) =>
      '<span class="stm2-lg"><i class="stm2-lg__sw stm2-lg__sw--'
      + (l.origin === 'kr' ? 'kr' : 'gl') + '"></i>' + escapeHtml(l.label || '') + '</span>').join('')
      + '</div>'
    : '';

  const unit = escapeHtml(t.badgeUnit || '곳');
  const catCards = cards.map((c) => '<div class="stm2-cat">'
    + '<div class="stm2-cat__h">'
    + '<span class="stm2-cat__n">' + escapeHtml(c.name || '')
    + (c.hint ? '<span class="stm2-cat__hint">' + escapeHtml(c.hint) + '</span>' : '') + '</span>'
    + '<span class="stm2-cat__badge">' + (c.companies || []).length + unit + '</span>'
    + '</div>'
    + '<div class="stm2-tags stm2-tags--cat">'
    + (c.companies || []).map((x) => tag(x.name, '', x.origin)).join('')
    + '</div></div>').join('');

  const mapSec = cards.length
    ? '<div class="stm2-sep"></div>'
      + '<div class="stm2-maph">'
      + '<span class="stm2-maph__t">' + escapeHtml(t.mapTitle || '어느 분야에 어느 기업이 있나') + '</span>'
      + legend + '</div>'
      + '<div class="stm2-cats">' + catCards + '</div>'
    : '';

  return '<div class="sm-card sm-techmap">'
    + '<div class="sm-h">' + escapeHtml(t.title || '슬립테크 기술 분야 및 주요 기업') + '</div>'
    + fork
    + mapSec
    + (t.badgeNote ? '<div class="sm-foot">' + escapeHtml(t.badgeNote) + '</div>' : '')
    + (t.source ? '<div class="sm-foot">' + escapeHtml(t.source) + '</div>' : '')
    + (t.foot ? '<div class="sm-foot">' + escapeHtml(t.foot) + '</div>' : '')
    + '</div>';
}

/** 오른쪽 — 시장 규모 막대그래프. 값·배수·기간은 전부 points 에서 계산한다. */
function smMarketBars(d) {
  const m = d && d.sleepMarket;
  if (!m || !Array.isArray(m.points) || m.points.length < 2) return '';
  const pts = m.points.slice().sort((a, b) => a.year - b.year)
    .map((p) => ({ year: p.year, jo: p.eok / 10000, label: p.label }));
  const vals = pts.map((p) => p.jo);
  const hi = Math.max.apply(null, vals) * 1.18;

  // 막대 — 파란 계열. 최신 시점만 진하게 둔다(지금 어디인지 바로 보이게).
  const W = VIZ_W, H = 210, padL = 44, padR = 16, padT = 24, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = pts.length;
  const slot = plotW / n;
  const bw = Math.min(76, slot * 0.52);
  const X = (i) => padL + slot * i + (slot - bw) / 2;
  const Y = (v) => padT + (1 - v / (hi || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = hi * t, y = Y(val);
    return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW)
      + '" y2="' + y.toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/>'
      + '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1)
      + '" text-anchor="end" font-size="' + VIZ_FS_AXIS + '" fill="var(--muted)">'
      + val.toFixed(1) + '</text>';
  }).join('');

  const bars = pts.map((p, i) => {
    const x = X(i), y = Y(p.jo), h = (padT + plotH) - y;
    const last = i === n - 1;
    return '<g>'
      + '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1)
      + '" height="' + Math.max(0, h).toFixed(1) + '" rx="3" fill="'
      + (last ? 'var(--blue)' : 'var(--blue)') + '" opacity="' + (last ? '1' : (0.45 + i * 0.2).toFixed(2)) + '"/>'
      + '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 7).toFixed(1)
      + '" text-anchor="middle" font-size="11.5" font-weight="800" paint-order="stroke"'
      + ' stroke="var(--card)" stroke-width="3.5" fill="var(--ink)">'
      + escapeHtml(p.label) + '</text>'
      + '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (padT + plotH + 16).toFixed(1)
      + '" text-anchor="middle" font-size="' + VIZ_FS_AXIS + '" fill="var(--muted)">'
      + p.year + '년</text>'
      + '</g>';
  }).join('');

  // 설명 문구 — {..} 자리에 계산값을 넣는다(문장은 JSON, 숫자는 데이터)
  const a = pts[0], b = pts[1], c = pts[n - 1];
  const n1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const rep = {
    y0: a.year, v0: a.label, y1: b.year, v1: b.label, y2: c.year, v2: c.label,
    span1: b.year - a.year, span2: c.year - b.year,
    x1: Math.floor(b.jo / a.jo), x2: n1(c.jo / b.jo),
  };
  let note = String(m.note || '');
  Object.keys(rep).forEach((k) => { note = note.split('{' + k + '}').join(String(rep[k])); });

  const basis = (Array.isArray(m.basis) && m.basis.length)
    ? '<div class="smb-basis">'
      + '<div class="smb-basis__h">' + escapeHtml(m.basisTitle || '출처 및 근거자료') + '</div>'
      + '<table class="smb-tb"><thead><tr><th>연도</th><th>규모</th><th>근거</th></tr></thead><tbody>'
      + m.basis.map((r) => '<tr><th scope="row">' + escapeHtml(String(r.year)) + '년</th>'
        + '<td class="smb-tb__v">' + escapeHtml(r.size || '-') + '</td>'
        + '<td>' + (safeUrl(r.url)
          ? '<a href="' + escapeHtml(safeUrl(r.url)) + '" target="_blank" rel="noopener noreferrer">'
            + escapeHtml(r.by || '-') + ' ›</a>'
          : escapeHtml(r.by || '-')) + '</td></tr>').join('')
      + '</tbody></table>'
      + (m.basisNote ? '<div class="sm-foot">' + escapeHtml(m.basisNote) + '</div>' : '')
      + '</div>'
    : '';

  return '<div class="sm-card sm-mktbars">'
    + '<div class="sm-h">' + escapeHtml(m.cardTitle || '국내 수면시장 규모 추이')
    + ' <span class="sm-h__u">(단위: ' + escapeHtml(m.unit || '조원') + ')</span></div>'
    + '<svg class="sm-mktsvg" viewBox="0 0 ' + W + ' ' + H + '"'
    + ' preserveAspectRatio="xMidYMid meet" role="img" aria-label="'
    + escapeHtml(m.cardTitle || '국내 수면시장 규모 추이') + '">'
    + grid + bars
    + '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW)
    + '" y2="' + (padT + plotH) + '" stroke="var(--axis)" stroke-width="1"/></svg>'
    + (note ? '<div class="smb-note">' + escapeHtml(note) + '</div>' : '')
    + basis
    + (m.source ? '<div class="sm-foot">' + escapeHtml(m.source) + '</div>' : '')
    + '</div>';
}

/** (3) 슬립테크 주요 기업 카드 — 확인된 값만 적고, 없는 것은 그대로 '비공개/미확인'.
    ★ 국내·국외가 같은 함수를 쓴다. 넘기는 데이터 파일만 다르고 화면 구성은 똑같다. */
/* 제품 아이콘 — 실물 사진을 못 쓰는 자리에 넣는 '제품 형태' 일러스트.
   ★ 6개 기업 공식 홈페이지를 모두 확인했지만 사진은 쓸 수 없었다(코웨이는 이미지
     무단 사용 금지 명시, 에이슬립은 비즈니스 파트너 한정, 세라젬은 무단 복제 금지,
     나머지 3곳은 허락 문구 없음). 그래서 도형으로 제품 실루엣을 그린다.
   ★★ 원형 픽토그램이 아니라 제품 겉모양이 보이게 채운 실루엣 + 선으로 그린다.
   ★★★ 라이선스가 확인된 사진이 생기면 JSON 의 product.image 에 경로만 넣으면
     이 일러스트 대신 사진이 나온다(코드 수정 불필요). */
const ST_PROD_ICONS = {
  // 비접촉 센서 기기 — 본체 + 뻗어 나가는 신호
  sensor: '<rect x="4" y="30" width="22" height="12" rx="2.5" fill="currentColor" opacity=".16"/>'
    + '<rect x="4" y="30" width="22" height="12" rx="2.5"/>'
    + '<circle cx="15" cy="36" r="2.4" fill="currentColor" stroke="none"/>'
    + '<path d="M31 34.5c2.2-2.4 3.4-5.3 3.4-8.4S33.2 20 31 17.6"/>'
    + '<path d="M36.5 38c3.4-3.4 5.3-7.6 5.3-11.9S39.9 17.6 36.5 14.2"/>'
    + '<path d="M9 24.5v-3.8a6 6 0 0 1 12 0v3.8"/>',
  // 매트리스 — 두툼한 본체 실루엣 + 내부 공기셀
  mattress: '<rect x="3" y="18" width="42" height="17" rx="5" fill="currentColor" opacity=".16"/>'
    + '<rect x="3" y="18" width="42" height="17" rx="5"/>'
    + '<path d="M12 18v17M20.5 18v17M29 18v17M37.5 18v17"/>'
    + '<path d="M8 39.5h32"/><path d="M7 35v4.5M41 35v4.5"/>',
  // 베개 — 가운데가 부푼 실루엣 + 목 받침선
  pillow: '<path d="M6 20.5c0-4 4.3-6.5 18-6.5s18 2.5 18 6.5v7c0 4-4.3 6.5-18 6.5S6 31.5 6 27.5Z"'
    + ' fill="currentColor" opacity=".16"/>'
    + '<path d="M6 20.5c0-4 4.3-6.5 18-6.5s18 2.5 18 6.5v7c0 4-4.3 6.5-18 6.5S6 31.5 6 27.5Z"/>'
    + '<path d="M17 24c2.2-2 12.6-2 14 0"/>'
    + '<path d="M12 39c3.8-2.2 7.8-3.3 12-3.3s8.2 1.1 12 3.3"/>',
  // 헤드보드 — 침대 머리판 실루엣 + 내장 센서·제어 표시
  headboard: '<path d="M7 30V13a4 4 0 0 1 4-4h26a4 4 0 0 1 4 4v17" fill="currentColor" opacity=".16"/>'
    + '<path d="M7 30V13a4 4 0 0 1 4-4h26a4 4 0 0 1 4 4v17"/>'
    + '<rect x="3" y="30" width="42" height="8" rx="2.5"/>'
    + '<path d="M6 38v4M42 38v4"/>'
    + '<circle cx="18" cy="18" r="1.7" fill="currentColor" stroke="none"/>'
    + '<circle cx="24" cy="18" r="1.7" fill="currentColor" stroke="none"/>'
    + '<circle cx="30" cy="18" r="1.7" fill="currentColor" stroke="none"/>'
    + '<path d="M15 24.5h18"/>',
  // 판독 리포트 — 문서 실루엣 + 수면 파형
  report: '<path d="M11 6.5h16l9 9v24a2.5 2.5 0 0 1-2.5 2.5h-22A2.5 2.5 0 0 1 9 39.5V9a2.5 2.5 0 0 1 2.5-2.5Z"'
    + ' fill="currentColor" opacity=".16"/>'
    + '<path d="M11 6.5h16l9 9v24a2.5 2.5 0 0 1-2.5 2.5h-22A2.5 2.5 0 0 1 9 39.5V9a2.5 2.5 0 0 1 2.5-2.5Z"/>'
    + '<path d="M27 6.5v9h9"/>'
    + '<path d="M14 31.5l3.5-6 3.5 9 3.5-12 3.5 9 2-3h3.5"/>'
    + '<path d="M14 37h9"/>',
  // 앱 — 스마트폰 실루엣 + 처방 체크
  app: '<rect x="14" y="4" width="20" height="40" rx="3.5" fill="currentColor" opacity=".16"/>'
    + '<rect x="14" y="4" width="20" height="40" rx="3.5"/>'
    + '<path d="M20.5 8h7"/>'
    + '<path d="M19 25.5l3.6 3.6L30 21.5"/>'
    + '<path d="M19 34h10"/><path d="M19 38h6"/>',
};

/** 제품 아이콘 SVG. 없는 키면 첫 아이콘으로 떨어뜨리지 않고 빈 문자열을 준다. */
function stProdIcon(key) {
  const d = ST_PROD_ICONS[key];
  if (!d) return '';
  return '<svg class="stp-ico" viewBox="0 0 48 48" width="60" height="60" fill="none"'
    + ' stroke="currentColor" stroke-width="1.7" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
}

/** 대표 제품 카드 — 배지 / 이미지(또는 아이콘) / 제품명 / 한줄설명 / 출처 */
function stProdCard(c) {
  const p = c && c.product;
  if (!p || !p.name) return '';
  const isrc = assetSrc(p.image);
  /* ★ 사진이 없을 때 아이콘을 그려 넣지 않는다 — 그림 자리를 아이콘으로 채우면
     '이게 그 제품 사진'처럼 읽힌다. 비어 있다고 밝히고 공식 링크로 보낸다.
     (icon 이 데이터에 남아 있으면 예전처럼 아이콘을 쓴다 — 국내 카드 호환) */
  const img = isrc
    ? '<img class="stp-img" src="' + escapeHtml(isrc) + '" alt="'
      + escapeHtml(p.name) + ' 제품 이미지" loading="lazy" onerror="this.remove()">'
    : (p.icon
      ? '<span class="stp-iconwrap" aria-hidden="true">' + stProdIcon(p.icon) + '</span>'
      : '<span class="stp-nofig">제품 사진 없음</span>');
  /* 사진이 있으면 '어디서 받은 이미지인지' 출처를 적는다(기존 로고가 logoSource 를
     남긴 것과 같은 방식). 사진이 없으면 예전처럼 공식 홈페이지 안내를 둔다. */
  const off = safeUrl(p.officialUrl);
  const isu = safeUrl(p.imageSourceUrl);
  let hint;
  if (isrc) {
    hint = p.imageSource
      ? '<div class="stp-official">이미지 출처: ' + escapeHtml(p.imageSource)
        + (isu ? ' <a class="src-link" href="' + escapeHtml(isu) + '" target="_blank"'
          + ' rel="noopener noreferrer">원본 ›</a>' : '') + '</div>'
      : '';
  } else {
    hint = off
      ? '<div class="stp-official">실제 제품 이미지는 공식 홈페이지에서 확인하세요'
        + ' <a class="src-link" href="' + escapeHtml(off) + '" target="_blank"'
        + ' rel="noopener noreferrer">공식 홈페이지 ›</a></div>'
      : '';
  }
  return '<div class="stp">'
    + (p.badge ? '<span class="stp-badge stp-badge--'
      + (p.badge === '국내' ? 'kr' : 'gl') + '">' + escapeHtml(p.badge) + '</span>' : '')
    + '<div class="stp-fig">' + img + '</div>'
    + '<div class="stp-name">' + escapeHtml(p.name) + '</div>'
    + (p.desc ? '<div class="stp-desc">' + escapeHtml(p.desc) + '</div>' : '')
    + (p.source ? '<div class="stp-src">' + escapeHtml(p.source) + '</div>' : '')
    + hint
    + '</div>';
}

/** 핵심 작동방식 — 가로 화살표 순서도. 단계 수는 데이터가 가진 만큼만 그린다.
 *  ★ 3단계인 회사에 억지로 4단째를 만들지 않는다. */
function stMechFlow(c) {
  const m = c && c.mechanism;
  const steps = (m && Array.isArray(m.steps)) ? m.steps.filter(Boolean) : [];
  if (!steps.length) return '';
  const arrow = '<span class="stm3-ar" aria-hidden="true">'
    + '<svg viewBox="0 0 14 24" width="9" height="15" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M1 12h11"/><path d="m7.5 7 5 5-5 5"/></svg></span>';
  const cells = steps.map((s, i) => '<span class="stm3-step">'
    + '<span class="stm3-step__no">' + (i + 1) + '</span>'
    + '<span class="stm3-step__t">' + escapeHtml(s) + '</span></span>').join(arrow);
  return '<div class="stm3">'
    + '<div class="stm3__h">' + escapeHtml(m.title || '핵심 작동방식')
    + '<span class="stm3__n">' + steps.length + '단계</span>'
    /* 이 순서도가 어디서 온 요약인지 한마디로 밝힌다(예전의 긴 mechNote 대체) */
    + (m.note ? '<span class="stm3__note">' + escapeHtml(m.note) + '</span>' : '')
    + '</div>'
    + '<div class="stm3-flow">' + cells + '</div>'
    + '</div>';
}

/** 기업별 누적 수상 건수 — CES 수상 이력이 확인된 기업만 가로 스택 막대로 그린다.
 *  ★ 확인 안 된 기업은 데이터에 넣지 않는다(0건으로 그리지 않는다). 어떤 기업을
 *    왜 뺐는지는 그래프 아래 foot 문구가 밝힌다.
 *  ★★ 한 줄에 기업명+신뢰도 배지, 그 아래 스택 막대 — 이름과 배지를 붙여 두면
 *    '이 숫자를 어디까지 믿을 수 있는지'가 총 건수와 같은 눈높이에서 읽힌다.
 *  ★★★ 세그먼트 라벨은 연도가 확인된 곳만 연도를 적고, 확인되지 않은 곳은
 *    실제로 확인된 정보(기간·카테고리)를 적는다 — '미상' 같은 빈 말을 쓰지 않는다. */

/* 세그먼트 색 — 진한 파랑 계열 그라데이션. 오른쪽(최근)으로 갈수록 진해진다.
   ★ 두 끝점을 섞어 만든다. 색을 개수만큼 손으로 적어 두면 세그먼트가 하나
     늘어날 때 색이 모자라 조용히 반복된다. */
const CES_C0 = [90, 134, 216];    // 옅은 쪽(가장 이른 구간)
const CES_C1 = [22, 38, 74];      // 진한 쪽(가장 최근 구간) — var(--navy)
function cesSegColor(i, k) {
  /* 구간이 하나뿐이면 t=0 이라 가장 옅은 색이 되어 버린다. 비교 대상이 없으니
     옅을 이유도 없다 — 충분히 진한 쪽으로 고정한다. */
  const t = (k <= 1) ? 0.72 : (i / (k - 1));
  const ch = (a, b) => Math.round(a + (b - a) * t);
  return 'rgb(' + ch(CES_C0[0], CES_C1[0]) + ',' + ch(CES_C0[1], CES_C1[1])
    + ',' + ch(CES_C0[2], CES_C1[2]) + ')';
}

function stCesAwards(st) {
  const c = st && st.cesAwards;
  const items = (c && Array.isArray(c.items))
    ? c.items.filter((x) => typeof x.total === 'number' && x.total > 0) : [];
  if (!items.length) return '';
  const unit = c.unit || '건';
  const sorted = items.slice().sort((a, b) => b.total - a.total);
  const max = sorted[0].total || 1;          // 막대 길이는 최댓값 기준으로 정규화
  const cl = c.confLabels || {};

  const rows = sorted.map((x) => {
    const w = Math.max(2, (x.total / max) * 100);
    /* segs 가 없으면 총 건수 하나를 통째로 한 구간으로 둔다 — 데이터가 덜
       채워졌다고 막대가 사라지지는 않게. */
    const segs = (Array.isArray(x.segs) && x.segs.length)
      ? x.segs : [{ label: x.period || '', n: x.total }];
    const k = segs.length;
    const bar = segs.map((s, i) => {
      /* 건수가 확정되지 않은 구간(open) — '수상은 확인됐지만 몇 건인지 모른다'.
         ★ 여기에 임의의 숫자를 넣지 않는다. 넣는 순간 합계가 근거 없이 늘어난다.
           폭은 눈에 보일 만큼만 주고, 빗금으로 '세어지지 않은 칸'임을 밝힌다. */
      const open = !!s.open || typeof s.n !== 'number';
      const txt = open
        ? String(s.label || '')
        : (s.label ? s.label + ' · ' : '') + s.n + unit;
      return '<span class="ces-seg' + (open ? ' ces-seg--open' : '')
        + '" style="flex:' + (open ? '1.2' : s.n)
        + ';background:' + cesSegColor(i, k) + '" title="' + escapeHtml(txt) + '">'
        + '<i class="ces-seg__t">' + escapeHtml(txt) + '</i></span>';
    }).join('');
    const badge = x.conf
      ? '<span class="ces-conf ces-conf--' + escapeHtml(x.conf) + '">'
        + escapeHtml(cl[x.conf] || x.conf) + '</span>'
      : '';
    return '<div class="ces-item">'
      + '<div class="ces-item__h">'
      + '<span class="ces-item__nm" title="' + escapeHtml(x.name) + '">'
      + escapeHtml(x.name) + '</span>' + badge
      + '</div>'
      + '<div class="ces-item__b">'
      + '<div class="ces-track"><div class="ces-hbar" style="width:' + w.toFixed(1)
      + '%">' + bar + '</div></div>'
      + '<div class="ces-total">' + x.total.toLocaleString('ko-KR') + unit
      + escapeHtml(x.totalSuffix || '') + '</div>'
      + '</div>'
      + (x.detail ? '<div class="ces-detail">' + escapeHtml(x.detail) + '</div>' : '')
      + '</div>';
  }).join('');

  const head = escapeHtml(c.heading || '기업별 누적 수상 건수')
    + ' <span class="sm-h__u">(' + escapeHtml(c.subject || 'CES 혁신상')
    + ' · 단위: ' + escapeHtml(unit) + ')</span>';
  return '<h3 class="subhead sm-st__ih">' + head + '</h3>'
    + (c.note ? '<div class="sm-othfoot">※ ' + escapeHtml(c.note) + '</div>' : '')
    + '<div class="ces-list">' + rows + '</div>'
    + (c.foot ? '<div class="sm-foot ces-foot">' + escapeHtml(c.foot) + '</div>' : '')
    + (c.source ? '<div class="sm-foot">' + escapeHtml(c.source) + '</div>' : '');
}

function stCardsHtml(st) {
  if (!st || !Array.isArray(st.companies) || !st.companies.length) return '';
  const row = (k, v) => (v ? '<div class="sm-st__row"><span class="sm-st__k">'
    + escapeHtml(k) + '</span><span class="sm-st__v">' + escapeHtml(v) + '</span></div>' : '');
  const cards = st.companies.map((c) => {
    const src = (c.sources || []).map((x) => {
      const u = safeUrl(x.url);
      return '<li>' + (u
        ? '<a class="src-link" href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">'
          + escapeHtml(x.label) + '</a>'
        : escapeHtml(x.label)) + '</li>';
    }).join('');
    return '<div class="sm-st">'
      + '<div class="sm-st__hd">' + smStLogo(c)
      + '<span class="sm-st__h">' + escapeHtml(c.name) + '</span></div>'
      // 순수 추가: 카드 상단 대표 제품 카드 + 핵심 작동방식 순서도
      + stProdCard(c)
      + stMechFlow(c)
      + (c.desc ? '<p class="sm-st__desc">' + escapeHtml(c.desc) + '</p>' : '')
      + row('설립', c.founded) + row('주요 제품·서비스', c.products)
      + row('투자 유치', c.funding) + row('매출·재무', c.revenue) + row('그 밖에', c.extra)
      + (src ? '<div class="sm-st__src">출처<ul>' + src + '</ul>'
        + (c.logoSource ? '<div class="sm-st__srcnote">로고: '
          + escapeHtml(c.logoSource) + '</div>' : '')
        + '</div>' : '')
      + '</div>';
  }).join('');
  return '<div class="sm-card sm-card--full"><div class="sm-h">'
    + escapeHtml(st.title || '국내 슬립테크 시장 주요 기업') + '</div>'
    + '<div class="sm-st-grid">' + cards + '</div>'
    /* smStInvest 는 국외 섹션도 쓴다 — 국내는 investEok 데이터를 지워서
       국내에서만 빈 문자열이 되고, 국외 '누적 투자 유치액 비교'는 그대로 나온다. */
    + smStInvest(st)
    + stCesAwards(st)
    + (st.note ? '<div class="sm-foot">' + escapeHtml(st.note) + '</div>' : '')
    // 순수 추가: 제품 이미지를 아이콘으로 대체한 이유 · 작동방식 출처
    + (st.productNote ? '<div class="sm-foot">' + escapeHtml(st.productNote) + '</div>' : '')
    + (st.mechNote ? '<div class="sm-foot">' + escapeHtml(st.mechNote) + '</div>' : '')
    + (st.logoNote ? '<div class="sm-foot">' + escapeHtml(st.logoNote) + '</div>' : '')
    + '</div>';
}

/** 국내 섹션에서 부르는 이름은 그대로 둔다(호출부 변경 없음). */
function smSleepTech(d) { return stCardsHtml(d.sleepTech); }

/** 국내 섹션 본문 — 차트 A 풀와이드 / 차트 B·C 2열 */
function smKoreaHtml() {
  if (!_smData) {
    return '<div class="comp-todo"><span class="comp-todo__badge">준비중</span>'
      + ' 업데이트 버튼을 누르면 표시됩니다</div>';
  }
  if (_smData.status !== 'ok') {
    return '<div class="comp-todo"><span class="comp-todo__badge">데이터 없음</span> '
      + escapeHtml(_smData.reason || '로드 실패') + '</div>';
  }
  const d = _smData;
  const perf = (d.simmonsPerformance || []).slice().sort((a, b) => a.year - b.year);
  const lastYear = perf.length ? perf[perf.length - 1].year : null;
  const prov = d.isProvisional === true
    || (perf.length > 0 && perf[perf.length - 1].provisional === true);
  const badge = '<div class="sm-badge">'
    + (prov ? '<span class="sm-badge__prov">잠정치</span>' : '')
    + (lastYear ? escapeHtml(lastYear + '년 12월 결산 기준') + ' · ' : '')
    + '최종 업데이트 ' + escapeHtml(d.lastUpdated || '—')
    + '<span class="sm-info" tabindex="0" role="note" aria-label="' + escapeHtml(SM_TIP)
    + '" title="' + escapeHtml(SM_TIP) + '">ⓘ<span class="sm-info__bub">'
    + escapeHtml(SM_TIP) + '</span></span></div>';
  const unit = escapeHtml(d.unit || '억원');
  const cy = d.competitorRevenueLastYear && d.competitorRevenueLastYear.year;
  const sy = (d.marketShare2025 && d.marketShare2025.year) || 2025;

  return '<div class="sm-wrap">'
    + '<div class="sm-card sm-card--full">'
    + '<div class="sm-h">시몬스 최근 실적 추이 <span class="sm-h__u">(단위: ' + unit + ')</span>'
    + badge + '</div>' + smPerfChart(d) + '</div>'
    + '<div class="sm-grid2">'
    + '<div class="sm-card"><div class="sm-h">국내 침대·매트리스 업계 매출 비교'
    + ' <span class="sm-h__u">(단위: ' + unit + ' · 기준 연도는 회사마다 표기)</span></div>'
    + smRevCompare(d) + '</div>'
    + '<div class="sm-card"><div class="sm-h">' + escapeHtml(String(sy))
    + '년 침대 매트리스 시장 점유율</div>'
    + smShareDonut(d) + '</div>'
    + '</div>'
    /* 좌: 슬립테크 기술 분류도 · 우: 시장규모 막대그래프.
       ★ 좁은 화면에서는 .sm-grid2 가 1열로 접히고, DOM 순서대로 왼쪽(기술분류)이
         위, 오른쪽(그래프)이 아래로 쌓인다. */
    + '<div class="sm-grid2 sm-grid2--mkt">'
    + smTechMap(d)
    + smMarketBars(d)
    + '</div>'
    + smSleepTech(d)
    + '</div>';
}

/** 제목 옆 약어 배지 + hover/포커스 툴팁.
    ★ 약어를 그 자리에서 풀어 준다 — 'PPI' 만 보고 뜻을 몰라 멈추는 일이 없게.
      배지 텍스트에 이미 우리말 뜻이 들어가고, 툴팁은 원어와 정의를 덧붙인다.
    ★ 툴팁 문구는 DOM 안에 그대로 있어 스크린리더도 읽는다(title 중복 방지). */
function gcAbbr(label, tip) {
  return '<span class="gc-abbr" tabindex="0" role="note">' + escapeHtml(label)
    + '<span class="gc-abbr__bub">' + escapeHtml(tip) + '</span></span>';
}


/* ══ 국외 섹션 — 해외 수면·슬립테크 시장 + 주요 기업 ═══════════════════════
   (public/data/global-sleeptech.json · 국내 simmons-market.json 과 같은 방식)
   ★ 값을 코드에 적지 않는다. JSON 한 곳만 고치면 문장·배수·그래프가 모두 따라온다.
   ★★ 두 시장 시리즈를 한 선으로 잇지 않는다 — 조사기관도(GMI vs Graphical Research)
     지역 범위도(글로벌 vs 북미) 다르다. 축만 함께 쓰고 선·색·문장은 시리즈마다 따로
     만들며, 범례에 조사기관과 범위를 그대로 적는다.
   ★★ 실측과 전망을 눈으로 가른다 — 실측은 꽉 찬 점, 전망은 속 빈 점, 그 사이는 점선.
     점선은 '해마다 이렇게 지나간다'가 아니라 '조사기관이 낸 두 값을 이었다'는 뜻이다. */
const GS_DATA_URL = 'public/data/global-sleeptech.json';
let _gsData = null;      // {status:'ok'|'error', ...} — 로드 결과

/** 데이터 로드. 실패해도 다른 카드에 영향을 주지 않는다(국내 로더와 같은 모양). */
async function fetchGlobalSleepTech() {
  try {
    const res = await fetch(GS_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 (' + GS_DATA_URL + ')');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    /* ★ 예전에는 sleepMarket(2계열 라인차트)을 필수로 봤다. 그 블록을 걷어내면서
       파일에서 키가 사라져 로드가 통째로 실패했다 — 화면에서 해외 슬립테크
       블록이 전부 사라진 원인이었다. 지금 화면이 실제로 쓰는 키로 검사한다. */
    if (!d || !d.sleepTech || !(d.deviceMarket || d.sleepLoss)) {
      throw new Error('형식이 올바르지 않습니다');
    }
    _gsData = Object.assign({ status: 'ok' }, d);
  } catch (e) {
    _gsData = { status: 'error', reason: (e && e.message) || String(e) };
    console.warn('[global-sleeptech] 로드 실패:', e);
  }
  renderCompetitor();
}

/** 한글 음절의 받침 유무. 한글이 아니면 null(판단하지 않는다). */
function gsJong(ch) {
  const c = String(ch || '').charCodeAt(0);
  if (!(c >= 0xAC00 && c <= 0xD7A3)) return null;
  return ((c - 0xAC00) % 28) !== 0;
}

/** 받침에 맞는 조사를 고른다 — '시장은/952억 달러로'처럼 문장이 자연스럽게 붙도록.
    ★ 조사를 하드코딩하지 않는 이유: JSON 의 이름·단위가 바뀌어도 문장이 깨지지 않게. */
function gsJosa(word, withJong, without) {
  const s = String(word == null ? '' : word);
  return (s && gsJong(s.charAt(s.length - 1)) === true) ? withJong : without;
}
/** Y축 눈금을 '떨어지는 숫자'로 만들기 위한 상한. max 를 덮으면서, 눈금 간격이
 *  1·2·2.5·5·10 ×10ⁿ 중 하나가 되는 가장 작은 상한을 고른다.
 *  ★ max*1.18 을 그대로 쓰면 1,589 같은 상한이 나와 눈금이 533·1,067 로 읽힌다.
 *    축은 데이터가 바뀌어도 계속 깔끔해야 하므로 코드가 계산하게 둔다. */
function gsNiceTop(max, ticks) {
  const seg = Math.max(1, (ticks || 4) - 1);
  const raw = (max || 1) / seg;                       // 눈금 하나가 담을 최소 크기
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const mult = [1, 2, 2.5, 5, 10].find((k) => k * mag >= raw - 1e-9) || 10;
  return mult * mag * seg;
}

/** [왼쪽] 글로벌 슬립테크 기기 시장 규모 — 세로 막대 3개(실적 2 + 전망 1).
 *  ★ 전망 막대는 실적과 눈에 띄게 구분한다(가장 진한 색 + X축 아래 '전망' 꼬리표).
 *    같은 색 농도만 다르면 실적과 전망이 같은 무게로 읽힌다.
 *  ★★ 금액 라벨은 막대 위에 둔다 — 249 와 1,347 은 열 배 넘게 벌어져서, 짧은
 *    막대는 안쪽에 글자를 넣을 자리가 없다.
 *  ★★★ 세로 막대는 국내 시장규모 그래프(smMarketBars)와 같은 치수·폰트를 쓴다.
 *    같은 2단 칸에 들어가는 그래프끼리 크기가 달라 보이지 않게. */
function gsDeviceMarket(m) {
  const pts = (m && Array.isArray(m.points)) ? m.points.filter((p) => p.usdEok > 0) : [];
  if (pts.length < 2) return '';
  const sorted = pts.slice().sort((a, b) => a.year - b.year);
  const n = sorted.length;
  const max = Math.max.apply(null, sorted.map((p) => p.usdEok));
  const hi = gsNiceTop(max, VIZ_Y_TICKS);

  /* padT 는 막대 위 두 줄(금액 + 원화)이 들어갈 만큼, padB 는 X축 두 줄
     (연도 + '전망' 꼬리표)이 들어갈 만큼 잡는다. */
  const W = VIZ_W, H = 260, padL = 44, padR = 14, padT = 48, padB = 42;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const base = padT + plotH;
  const slot = plotW / n;
  const bw = Math.min(76, slot * 0.52);
  const X = (i) => padL + slot * i + (slot - bw) / 2;
  const Y = (v) => padT + (1 - v / (hi || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = hi * t, y = Y(val);
    return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW)
      + '" y2="' + y.toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/>'
      + '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1)
      + '" text-anchor="end" font-size="' + VIZ_FS_AXIS + '" fill="var(--muted)">'
      + Math.round(val).toLocaleString('ko-KR') + '</text>';
  }).join('');

  const bars = sorted.map((p, i) => {
    const x = X(i), y = Y(p.usdEok), h = Math.max(0, base - y);
    const cx = x + bw / 2;
    const fc = p.kind === 'forecast';
    const krw = gmmKrw(p.usdEok / 10);
    /* 전망만 꽉 찬 색, 실적은 이른 해부터 옅게 — 최신 실적이 전망 바로 앞에서
       가장 진하게 읽히도록 한다. */
    const op = fc ? '1' : (0.45 + i * 0.2).toFixed(2);
    return '<g>'
      + '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1)
      + '" height="' + h.toFixed(1) + '" rx="3" fill="var(--blue)" opacity="' + op + '"/>'
      /* 금액 — 막대 위. 글자 뒤에 카드색 테두리를 깔아 격자선 위에서도 읽히게 */
      + '<text x="' + cx.toFixed(1) + '" y="' + (y - 19).toFixed(1)
      + '" text-anchor="middle" font-size="11.5" font-weight="800" paint-order="stroke"'
      + ' stroke="var(--card)" stroke-width="3.5" fill="var(--ink)">'
      + escapeHtml(p.label || '') + '</text>'
      + (krw ? '<text x="' + cx.toFixed(1) + '" y="' + (y - 7).toFixed(1)
        + '" text-anchor="middle" font-size="9" font-weight="700" paint-order="stroke"'
        + ' stroke="var(--card)" stroke-width="3" fill="var(--muted)">'
        + escapeHtml(krw) + '</text>' : '')
      /* X축 — 연도, 전망은 그 아래 꼬리표를 하나 더 붙인다 */
      + '<text x="' + cx.toFixed(1) + '" y="' + (base + 16).toFixed(1)
      + '" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--text)">'
      + p.year + '년</text>'
      + (fc
        ? '<rect x="' + (cx - 15).toFixed(1) + '" y="' + (base + 22).toFixed(1)
          + '" width="30" height="13" rx="6.5" fill="var(--blue)" opacity=".14"/>'
          + '<text x="' + cx.toFixed(1) + '" y="' + (base + 31).toFixed(1)
          + '" text-anchor="middle" font-size="8.5" font-weight="800"'
          + ' fill="var(--blue-ink)">전망</text>'
        : '')
      + '</g>';
  }).join('');

  const aria = (m.title || '글로벌 슬립테크 기기 시장 규모') + ' — '
    + sorted.map((p) => p.year + '년 ' + (p.label || '')
      + (p.kind === 'forecast' ? ' 전망' : '')).join(', ');

  const basis = (Array.isArray(m.basis) && m.basis.length)
    ? '<div class="gsd-basis"><div class="gsd-basis__h">'
      + escapeHtml(m.basisTitle || '출처') + '</div>'
      + '<table class="smb-tb"><thead><tr><th>연도</th><th>규모</th><th>출처</th></tr></thead>'
      + '<tbody>' + m.basis.map((b) => '<tr><th scope="row">' + escapeHtml(String(b.year))
        + '년' + (b.note ? ' ' + escapeHtml(b.note) : '') + '</th>'
        + '<td class="smb-tb__v">' + escapeHtml(b.value || '') + '</td>'
        + '<td>' + escapeHtml(b.org || '') + '</td></tr>').join('')
      + '</tbody></table></div>'
    : '';
  return '<div class="sm-card gs-card">'
    + '<div class="sm-h">' + escapeHtml(m.title || '글로벌 슬립테크 기기 시장 규모')
    + ' <span class="sm-h__u">(단위: ' + escapeHtml(m.unit || '억 달러') + ')</span></div>'
    + (m.subtitle ? '<div class="gs-sub">' + escapeHtml(m.subtitle) + '</div>' : '')
    + '<svg class="sm-mktsvg gsd-svg" viewBox="0 0 ' + W + ' ' + H + '"'
    + ' preserveAspectRatio="xMidYMid meet" role="img" aria-label="'
    + escapeHtml(aria) + '">'
    /* Y축이 무엇을 세는지 축 위에 적는다(카드 제목의 단위와 같은 값) */
    + '<text x="4" y="' + (padT - 16) + '" font-size="' + VIZ_FS_AXIS
    + '" fill="var(--muted)">(' + escapeHtml(m.unit || '억 달러') + ')</text>'
    + grid + bars
    + '<line x1="' + padL + '" y1="' + base + '" x2="' + (padL + plotW)
    + '" y2="' + base + '" stroke="var(--axis)" stroke-width="1"/></svg>'
    + (m.summary ? '<div class="smb-note">' + escapeHtml(m.summary) + '</div>' : '')
    + basis
    + (m.foot ? '<div class="sm-foot">※ ' + escapeHtml(m.foot) + '</div>' : '')
    + '</div>';
}

/** [오른쪽] 수면 부족으로 인한 경제 손실 — 세계지도 위 버블.
 *  ★ 나라 위치는 이미 있는 ISO_LONLAT 을 쓴다(좌표를 여기서 새로 적지 않는다).
 *  ★★ 원 크기는 '면적'이 금액에 비례하도록 반지름을 √값으로 잡는다.
 *    반지름을 금액에 그대로 비례시키면 큰 나라가 실제보다 훨씬 커 보인다.
 *  ★★★ 지도·투영은 세계 시간 카드와 같은 것을 재사용한다
 *    (world-map.svg · 등장방형도법 x=(lon+180)/360, y=(90-lat)/180). */
function gsSleepLoss(s) {
  const items = (s && Array.isArray(s.items)) ? s.items.filter((x) => x.usdEok > 0) : [];
  if (!items.length) return '';
  const max = Math.max.apply(null, items.map((x) => x.usdEok));
  const R_MAX = 26, R_MIN = 7;
  const dots = items.map((x) => {
    const ll = ISO_LONLAT[x.iso];
    if (!ll) return '';                       // 좌표가 없으면 지도에 찍지 않는다
    const left = (ll[0] + 180) / 360 * 100;
    const top = (90 - ll[1]) / 180 * 100;
    const r = Math.max(R_MIN, R_MAX * Math.sqrt(x.usdEok / max));
    return '<div class="gsl-mk gsl-mk--' + escapeHtml(x.dir || 'r') + '"'
      + ' style="left:' + left.toFixed(2) + '%;top:' + top.toFixed(2) + '%">'
      + '<span class="gsl-dot" style="width:' + (r * 2).toFixed(1) + 'px;height:'
      + (r * 2).toFixed(1) + 'px;margin:-' + r.toFixed(1) + 'px 0 0 -'
      + r.toFixed(1) + 'px"></span>'
      + '<span class="gsl-lb"><b>' + escapeHtml(x.ko) + '</b>'
      + '<i>' + escapeHtml(x.label || '') + '</i>'
      + (x.gdpPct != null ? '<u>GDP ' + x.gdpPct + '%</u>' : '') + '</span>'
      + '</div>';
  }).join('');
  /* 지도에서 겹쳐 읽기 어려운 값은 아래 표가 그대로 받아 준다 */
  const rows = items.map((x) => '<tr><th scope="row">' + escapeHtml(x.ko) + '</th>'
    + '<td class="gsl-t__v">' + escapeHtml(x.label || '') + '</td>'
    + '<td class="gsl-t__p">' + (x.gdpPct != null ? x.gdpPct + '%' : '—') + '</td></tr>').join('');
  return '<div class="sm-card gs-card">'
    + '<div class="sm-h">' + escapeHtml(s.title || '수면 부족으로 인한 경제 손실')
    + ' <span class="sm-h__u">(단위: ' + escapeHtml(s.unit || '억 달러') + ')</span></div>'
    + (s.subtitle ? '<div class="gs-sub">' + escapeHtml(s.subtitle) + '</div>' : '')
    + '<div class="gsl-map"><img class="gsl-map__img" src="world-map.svg" alt=""'
    + ' aria-hidden="true"><div class="gsl-marks">' + dots + '</div></div>'
    + '<table class="gsl-t"><thead><tr><th>국가</th><th>손실 규모</th>'
    + '<th>GDP 대비</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + (s.legendNote ? '<div class="sm-foot">' + escapeHtml(s.legendNote) + '</div>' : '')
    + (s.source ? '<div class="sm-foot">' + escapeHtml(s.source) + '</div>' : '')
    + '</div>';
}

/** 국외 섹션에 덧붙는 두 블록(시장 규모 추이 + 주요 기업 카드).
    ★ 로드 전이거나 실패했으면 빈 문자열을 돌려, 기존 PPI 카드만 그대로 나오게 한다. */
function gsBlocksHtml() {
  if (!_gsData || _gsData.status !== 'ok') return '';
  /* 좌우 반반 — 좁은 화면(≤900px)에서는 .sm-grid2 가 1열로 접혀 세로로 쌓인다 */
  return '<div class="sm-wrap gs-wrap">'
    + '<div class="sm-grid2 gs-grid2">'
    + gsDeviceMarket(_gsData.deviceMarket || {})
    + gsSleepLoss(_gsData.sleepLoss || {})
    + '</div>'
    + stCardsHtml(_gsData.sleepTech)
    + '</div>';
}

/** 국외 섹션 — 글로벌 매트리스 시장 규모 블록 하나. 그 외에는 만들지 않는다.
    캐시(global-mattress-market.json)를 못 읽으면 null 을 돌려
    호출부가 기존 SEC 분기 실적 카드를 그대로 쓰게 한다. */
function gtGlobalHtml() {
  // 시장 규모 캐시가 없으면 예전처럼 null 을 돌려 SEC 분기 실적 카드로 되돌아간다.
  if (!_gmm) return null;
  return '<div class="gc-block"><div class="gc-h">글로벌 매트리스 시장 규모</div>'
    + gmmBlock() + '</div>'
    + gsBlocksHtml();   // 해외 슬립테크 시장 규모 + 주요 기업(없으면 빈 문자열)
}

/* 국외 섹션 소제목 — 블록이 늘어난 만큼만 문구를 늘린다.
   ★ 해외 슬립테크 데이터가 없으면(로드 실패·구버전) 예전 문구를 그대로 돌려준다. */
const GT_SUB_GMM = '글로벌 매트리스 시장 규모';
const GT_DESC_GMM = '세계 매트리스 시장의 규모·성장률·지역·주요 기업 · '
  + 'Global Market Insights 공개 요약을 월 1회 자동 수집(조사기관 추정치)';

function gtSubTitle() {
  return (_gsData && _gsData.status === 'ok')
    ? GT_SUB_GMM + ' · 해외 슬립테크 시장' : GT_SUB_GMM;
}

function gtSubDesc() {
  return (_gsData && _gsData.status === 'ok')
    ? GT_DESC_GMM + ' · 해외 슬립테크 시장 규모와 주요 기업은 수기 입력(출처는 각 카드에 표기)'
    : GT_DESC_GMM;
}

/* ── 원화 병기 공용 헬퍼 (순수 추가) ─────────────────────────────────────
   ★ 저장된 값은 원래 통화로 유지하고, 표시할 때만 환율을 곱한다.
   ★ 환율을 못 읽으면 null 을 돌려 호출부가 외화만 표시하게 한다. */

/** 축·툴팁용 원화 축약: 3.2조 / 7,974억 / 5,200만 / 1,200원 */
function fmtKrwAxis(v) {
  if (v == null || !isFinite(v)) return null;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  // 축약 규칙: 조는 소수 한 자리, 억·만은 정수(3.2조 / 7,974억 / 5,200만)
  const n1 = (x) => x.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  const n0 = (x) => Math.round(x).toLocaleString('ko-KR');
  if (a >= 1e12) return sign + n1(a / 1e12) + '조';
  if (a >= 1e8) return sign + n0(a / 1e8) + '억';
  if (a >= 1e4) return sign + n0(a / 1e4) + '만';
  return sign + n0(a) + '원';
}

/** 단위 문자열 → KRW 환산 배율. 원화·미지원 통화면 null.
    KOIMA 일일가격처럼 품목마다 단위가 다른 경우에 쓴다($/ton, ￠/lb, CNY/tonne …). */
function krwFactor(unit) {
  const u = String(unit || "").trim();
  const r = krwRate("USD");
  if (r == null) return null;
  if (u.charAt(0) === "$") return r;              // $/ton, $/tonne, $/mmbtu
  if (u.charAt(0) === "￠") return r / 100;      // ￠/lb — 미국 센트
  return null;                                    // CNY·원·천원 단위는 환산하지 않는다
}

/** 통화 → KRW 환율. 기존 환율 데이터만 참조하고 새로 수집하지 않는다. */
function krwRate(cur) {
  const c = String(cur || 'USD').toUpperCase();
  if (c === 'KRW') return 1;
  if (c === 'USD' && _matUsdKrw != null) return _matUsdKrw;
  try {
    const s = _fx && _fx.series;
    const arr = s && s[c];
    if (Array.isArray(arr)) {
      for (let i = arr.length - 1; i >= 0; i -= 1) if (arr[i] != null) return arr[i];
    }
  } catch (e) { /* 표기용이라 실패해도 무시 */ }
  return null;
}

/** 환율 기준일(해당 통화의 마지막 관측일). 없으면 null */
function krwAsOf(cur) {
  const c = String(cur || 'USD').toUpperCase();
  try {
    const s = _fx && _fx.series;
    if (!s || !Array.isArray(s.dates) || !Array.isArray(s[c])) return null;
    for (let i = s[c].length - 1; i >= 0; i -= 1) if (s[c][i] != null) return s.dates[i] || null;
  } catch (e) { /* 무시 */ }
  return null;
}

/** 차트 근처에 한 번만 붙이는 "적용 환율" 문구. 환율 없으면 '' */
function krwNote(cur) {
  const c = String(cur || 'USD').toUpperCase();
  const r = krwRate(c);
  if (r == null) return '';
  const d = krwAsOf(c);
  return '<div class="viz-fxnote">적용 환율 1 ' + escapeHtml(c) + ' = '
    + Math.round(r).toLocaleString('ko-KR') + '원'
    + (d ? ' <span class="viz-fxnote__d">(' + escapeHtml(d) + ' 기준)</span>' : '') + '</div>';
}

/** 원화 환산 짧은 표기 — 만원 한 자리(예: 13.8만원).
 *  fmtKrwShort 는 만원을 정수로 반올림해 13.8 이 14 로 뭉개진다.
 *  배럴·톤당 단가처럼 만원 자리에서 소수가 의미 있는 곳은 이 쪽을 쓴다. */
function krwMan(v) {
  if (v == null || !isFinite(v)) return null;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const n1 = (x) => x.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (a >= 1e8) return sign + n1(a / 1e8) + '억원';
  if (a >= 1e4) return sign + n1(a / 1e4) + '만원';
  return sign + Math.round(a).toLocaleString('ko-KR') + '원';
}

/** 달러 금액의 원화 환산 조각. 환율이 없으면 '' (지어내지 않는다). */
function krwOf(usd, unit) {
  const r = krwRate('USD');
  if (r == null || usd == null || !isFinite(usd)) return '';
  const t = krwMan(usd * r);
  return t ? ('≈ ' + t + (unit ? '/' + unit : '')) : '';
}

/** Y축 눈금 아래에 붙일 원화 둘째 줄. 환율 없으면 '' */
function vizKrwTick(x, y, val, rate) {
  if (rate == null || val == null || val === 0) return '';
  const t = fmtKrwAxis(val * rate);
  if (!t) return '';
  return '<text x="' + x + '" y="' + (y + 9.5).toFixed(1) + '" text-anchor="end" font-size="7"'
    + ' fill="var(--muted)" opacity=".78">' + escapeHtml(t) + '</text>';
}

/** wrap 의 차트 상태(툴팁 데이터·기하). 없으면 null */
function gtState(wrap) {
  const k = wrap && wrap.getAttribute('data-gt-chart');
  const st = k ? _gtCharts[k] : null;
  return (st && st.tip && st.tip.length && st.geom) ? st : null;
}

/** 포인터 x좌표 → 인덱스. 차트 밖이면 null */
function gtHitIndex(wrap, svg, clientX) {
  const st = gtState(wrap);
  if (!st) return null;
  const r = svg.getBoundingClientRect();
  if (!r.width) return null;
  const vb = ((clientX - r.left) / r.width) * VIZ_W;      // viewBox 좌표로 환산
  const g = st.geom;
  if (g.n < 2) return 0;
  const i = Math.round(((vb - g.padL) / g.plotW) * (g.n - 1));
  return Math.max(0, Math.min(g.n - 1, i));
}

/** 툴팁·activeDot 표시. i=null 이면 감춘다. 미국·이탈리아 차트가 같은 경로를 쓴다. */
function gtShowTip(wrap, i) {
  const tip = wrap.querySelector('.gt-tip');
  const hov = wrap.querySelector('.gt-hov');
  const st = gtState(wrap);
  if (!tip || !hov) return;
  if (!st || i == null || !st.tip[i]) {
    tip.hidden = true; hov.classList.remove('is-on');
    wrap.querySelectorAll('.gt-adot').forEach((c) => { c.setAttribute('cx', '-99'); });
    return;
  }
  const g = st.geom;
  const x = g.padL + (g.n === 1 ? g.plotW / 2 : (i / (g.n - 1)) * g.plotW);
  const line = hov.querySelector('.gt-hov__l');
  if (line) { line.setAttribute('x1', x.toFixed(1)); line.setAttribute('x2', x.toFixed(1)); }
  const rows = st.tip[i].rows;
  wrap.querySelectorAll('.gt-adot').forEach((c) => {
    const r = rows[Number(c.getAttribute('data-si'))];
    if (r) { c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', r.y.toFixed(1)); }
    else { c.setAttribute('cx', '-99'); }
  });
  hov.classList.add('is-on');
  const body = rows.filter(Boolean).map((r) => '<div class="gt-tip__r">'
    + '<i style="background:' + r.color + (r.seg ? ';border-radius:0' : '') + '"></i>'
    + '<span class="gt-tip__n">' + escapeHtml(r.name) + '</span>'
    + '<span class="gt-tip__v">' + r.val + '</span></div>').join('');
  tip.innerHTML = '<div class="gt-tip__q">' + escapeHtml(st.tip[i].q) + '</div>' + body;
  tip.hidden = false;
  const pct = Math.max(0, Math.min(100, (x / VIZ_W) * 100));
  tip.style.left = pct.toFixed(2) + '%';
  // 오른쪽 끝에서는 툴팁을 왼쪽으로 붙여 화면을 넘지 않게 한다
  tip.style.transform = (pct > 72) ? 'translateX(-100%)' : (pct < 28 ? 'none' : 'translateX(-50%)');
}

/** 차트 툴팁 배선(위임 1회 등록). 티어 필터가 없어져 클릭 핸들러는 두지 않는다. */
function wireGtControls() {
  const el = document.getElementById('compRoot');
  if (!el || el.dataset.gtWired === '1') return;
  el.dataset.gtWired = '1';

  // hover(데스크톱) + pointerdown(모바일 탭) 모두 같은 경로로 처리한다.
  const move = (ev) => {
    const svg = ev.target.closest && ev.target.closest('.gt-chart');
    if (!svg) return;
    const wrap = svg.closest('.gt-chartwrap');
    if (wrap) gtShowTip(wrap, gtHitIndex(wrap, svg, ev.clientX));
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerdown', move);
  el.addEventListener('pointerleave', () => {
    el.querySelectorAll('.gt-chartwrap').forEach((w) => gtShowTip(w, null));
  }, true);
  el.addEventListener('pointerout', (ev) => {
    const wrap = ev.target.closest && ev.target.closest('.gt-chartwrap');
    if (wrap && !wrap.contains(ev.relatedTarget)) gtShowTip(wrap, null);
  });
}

/** 경쟁사 분석 전체 렌더 (국내 + 국외) */
/* ══ 국내/국외 보기 전환 ═══════════════════════════════════════════════
   경쟁사 분기 실적의 두 배너가 탭이 되고, 아래 '신제품·브랜드 동향' 섹션의
   국내/국외 소그룹도 같은 상태를 따른다.
   ★ 다시 그릴 때마다 상태를 잃지 않게, 보기 상태는 DOM 이 아니라 이 변수가 갖는다.
   ★★ 숨김은 [hidden] 대신 .is-off 로 한다 — 숨길 대상이 CSS 에서 display 를
     지정받고 있으면 hidden 속성이 그 display 에 밀려 그대로 보인다. */
/* ★ 초기값은 null = 아직 아무 쪽도 고르지 않은 상태. 업데이트 직후 국내가
   저절로 열리면 '내가 고른 것'과 '기본값'을 구분할 수 없다 — 눌러서 고르게 한다. */
let _sideView = null;           // 분기 실적 섹션: null(미선택) · 'kr' · 'gl'
/* ★ 신제품·브랜드 섹션은 자기 상태를 따로 갖는다. 두 섹션을 한 변수로 묶었더니
   위에서 국외를 보면 아래도 강제로 국외가 되어, 아래 섹션에서 국내를 볼 수 없었다.
   두 섹션은 다루는 내용이 달라 서로를 끌고 다니지 않아야 한다. */
let _brandSide = 'kr';          // 신제품·브랜드 섹션: 'kr'(기본) · 'gl'

/** 현재 보기 상태를 화면에 반영한다. 경쟁사 섹션과 브랜드 섹션 양쪽을 함께 본다. */
function applySideView() {
  const on = _sideView;            // null 이면 어느 쪽도 고르지 않은 상태
  /* ★ 분기 실적 섹션만 본다. 셀렉터를 문서 전체로 넓히면 아래 신제품·브랜드
     섹션까지 함께 끌려가 두 섹션이 같은 쪽만 보게 된다. */
  const root = document.getElementById('compRoot');
  if (!root) return;
  root.querySelectorAll('.comp-tab').forEach((b, i) => {
    const sel = on != null && b.getAttribute('data-side') === on;
    b.setAttribute('aria-selected', sel ? 'true' : 'false');
    /* 미선택이면 첫 버튼만 탭 순서에 남긴다 — 키보드로 들어올 자리가 있어야 한다 */
    b.setAttribute('tabindex', (on == null ? (i === 0) : sel) ? '0' : '-1');
  });
  root.querySelectorAll('.comp-panel').forEach((el) => {
    el.classList.toggle('is-off', on == null || el.getAttribute('data-side') !== on);
  });
  // 미선택 안내는 아무 쪽도 안 골랐을 때만 보인다
  const ask = root.querySelector('.comp-ask');
  if (ask) ask.classList.toggle('is-off', on != null);
}

/** 신제품·브랜드 섹션의 국내/국외 적용. 분기 실적과 완전히 별개다. */
function applyBrandSide() {
  const on = _brandSide === 'gl' ? 'gl' : 'kr';
  const root = document.getElementById('domesticList');
  if (!root) return;
  root.querySelectorAll('.side-tab').forEach((b) => {
    const sel = b.getAttribute('data-side') === on;
    b.setAttribute('aria-selected', sel ? 'true' : 'false');
    b.setAttribute('tabindex', sel ? '0' : '-1');
  });
  root.querySelectorAll('.brand-side').forEach((el) => {
    el.classList.toggle('is-off', el.getAttribute('data-side') !== on);
  });
}

/** 탭 클릭·키보드 조작. innerHTML 을 다시 쓸 때마다 불러도 안전하다(위임 1개). */
function wireCompTabs() {
  const root = document.getElementById('compRoot');
  if (!root || root.dataset.tabsWired === '1') return;
  root.dataset.tabsWired = '1';
  root.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('.comp-tab');
    if (!b) return;
    const side = b.getAttribute('data-side');
    if (!side || side === _sideView) return;
    _sideView = side;
    applySideView();
  });
  // ← → 로도 옮길 수 있게(탭 위젯의 기본 조작)
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!(e.target && e.target.closest && e.target.closest('.comp-tab'))) return;
    e.preventDefault();
    _sideView = (_sideView === 'kr') ? 'gl' : (_sideView === 'gl' ? 'kr' : 'kr');
    applySideView();
    const next = root.querySelector('.comp-tab[data-side="' + _sideView + '"]');
    if (next && next.focus) next.focus();
  });
}

/** 신제품·브랜드 섹션의 국내/국외 버튼 배선. 상태는 분기 실적 탭과 공유한다. */
function wireBrandSide() {
  const root = document.getElementById('domesticList');
  if (!root || root.dataset.sideWired === '1') return;
  root.dataset.sideWired = '1';
  root.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('.side-tab');
    if (!b) return;
    const side = b.getAttribute('data-side');
    if (!side || side === _brandSide) return;
    _brandSide = side;
    applyBrandSide();
  });
  // ← → 로도 옮길 수 있게(탭 위젯의 기본 조작)
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!(e.target && e.target.closest && e.target.closest('.side-tab'))) return;
    e.preventDefault();
    _brandSide = _brandSide === 'kr' ? 'gl' : 'kr';
    applyBrandSide();
    const next = root.querySelector('.side-tab[data-side="' + _brandSide + '"]');
    if (next && next.focus) next.focus();
  });
}

/** 국내/국외 배너 오른쪽 요약 배지. 숫자는 로드된 데이터에서 센다.
 *  ★ 세어질 게 없으면 빈 문자열 → vizHero 가 배지를 아예 그리지 않는다. */
function compGroupBadge(side) {
  const parts = [];
  if (side === 'kr') {
    const n = (_smData && _smData.status === 'ok' && _smData.sleepTech
      && (_smData.sleepTech.companies || []).length) || 0;
    if (n) parts.push('기업 ' + n + '곳');
  } else {
    const st = (_gsData && _gsData.status === 'ok') ? _gsData.sleepTech : null;
    const n = (st && (st.companies || []).length) || 0;
    if (n) parts.push('기업 ' + n + '곳');
    if (st && st.cesAwards && (st.cesAwards.items || []).length) parts.push('CES 수상 확인');
  }
  return parts.join(' · ');
}

function renderCompetitor() {
  const el = document.getElementById('compRoot');
  if (!el) return;
  const g = _competitors && _competitors.global;
  const rate = _competitors && _competitors.usd_krw_rate;
  const rateNote = (rate != null)
    ? `<div class="comp-fxnote">적용 환율: 1 USD = ${Math.round(rate).toLocaleString('ko-KR')}원</div>`
    : '';
  const gSum = compQtrSummary(g || []);
  // 순수 추가: 티어 뷰(payload 에 tier_defs 가 오면). 구버전 payload 면 기존 화면 그대로.
  let globalHtml, gTier = false;
  if (g && g.length) {
    _compLatest = gSum && gSum.latest;
    const tierHtml = gtGlobalHtml();
    gTier = !!tierHtml;
    globalHtml = tierHtml
      || `<div class="gco-grid">${g.map((c, i) => compGlobalCard(c, i, rate)).join('')}</div>
       ${rateNote}
       ${compRevBars(g)}
       <div class="comp-caption">출처: SEC EDGAR${compFetchedAt()}</div>`;
  } else {
    globalHtml = emptyState('국외 경쟁사 데이터 준비중');
  }


  // 국내: 시몬스/경쟁사 실적·점유율 — public/data/simmons-market.json 단일 소스.
  // (네이버 금융 분기 수집기는 그대로 두되 이 자리에는 더 쓰지 않는다)
  const koreaHtml = smKoreaHtml();

  /* 국내/국외 구분은 배너(.viz-hero)로 세운다 — 스크롤 중에도 '여기서부터
     구분이 바뀐다'가 한눈에 보이도록, 원자재 섹션 배너와 같은 컴포넌트를 쓴다.
     ★ 요약 배지는 데이터에서 센다(기업 수를 코드에 적어 두면 카드가 늘 때 어긋난다). */
  const tab = (side, hero) => `<button class="comp-tab" type="button" role="tab"
      data-side="${side}" aria-controls="compPanel-${side}">${hero}</button>`;
  el.innerHTML = `
    <div class="comp-tabs" role="tablist" aria-label="국내/국외 보기 전환">
      ${tab('kr', vizHero('pin', '국내', '시몬스·경쟁사 실적과 시장 점유율 · 단위 억원 · 비상장사 수기 입력',
        compGroupBadge('kr'), 'Korea', '', 'viz-hero--tab'))}
      ${tab('gl', vizHero('globe', '국외', gTier ? gtSubDesc() : '매출·순이익 · 전년 동기 대비(YoY) 기준 · SEC EDGAR',
        compGroupBadge('gl'), 'Global', '', 'viz-hero--tab'))}
    </div>
    <div class="comp-panel comp-group" data-side="kr" id="compPanel-kr" role="tabpanel">
      ${koreaHtml}
    </div>
    <div class="comp-panel comp-group" data-side="gl" id="compPanel-gl" role="tabpanel">
      ${globalHtml}
    </div>
    <div class="comp-ask">위 <b>국내</b> 또는 <b>국외</b> 탭을 선택해 주세요.</div>`;
  wireGtControls();
  wireCompTabs();
  applySideView();
}

/* ============================================================
   4) 업계 주요 뉴스 섹션
   ============================================================ */

const _newsState = { category: '전체', region: '전체' };

/** 날짜 표시: 2025-06-15 → 2025.06.15 */
function fmtDate(d) {
  return String(d || '').replace(/-/g, '.');
}

/** url이 안전한 http(s) 링크인지 */
function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

/** 이미지 경로 — 절대 https 이거나, 저장소 안 public/... 상대경로만 허용한다.
 *  ★ safeUrl 은 http(s) 만 받으므로 public/products/... 같은 상대경로가 걸러진다.
 *    javascript: 같은 스킴이 끼어들지 못하게 허용 형태를 좁게 잡았다. */
function assetSrc(u) {
  const s = String(u || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  return /^public\/[\w./-]+$/.test(s) ? s : null;
}

/** 고유값 목록 (등장 순서 유지) */
function distinct(rows, key) {
  const seen = new Set();
  const out = [];
  rows.forEach((r) => {
    const v = String(r[key] || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  });
  return out;
}


/* ============================================================
   5) 원자재 원가 동향 섹션
   ============================================================ */

/* ── 차트 공통 치수 상수 ────────────────────────────────────────────────
   대시보드의 모든 선그래프(스폰지·정시성·국제유가·월간지수·일일가격·환율)가
   이 값을 공유한다. 차트 높이를 바꾸려면 VIZ_H 한 곳만 고치면 된다.
   ★ 값(데이터)·색상·시리즈 구성·툴팁에는 관여하지 않는 '치수 전용' 상수다. */
const VIZ_W = 720;            // viewBox 가로(고정) — 실제 크기는 CSS width:100% 로 결정
const VIZ_H = 158;            // viewBox 세로 ← 300 → 190 → 158 (직전의 83%). 여기만 고치면 전 차트 반영
const VIZ_PAD_T = 10;         // 위 여백(기존 16~18)
const VIZ_PAD_B = 24;         // 아래 여백(기존 30~34) — X축 라벨 자리
const VIZ_FS_AXIS = 8.5;      // 축 눈금 폰트(기존 9~10)
const VIZ_FS_LABEL = 8;       // 데이터 라벨 폰트(기존 10)
const VIZ_Y_TICKS = 4;        // Y 눈금 개수(기존 5)
const VIZ_TICK_GAP = 96;      // X 라벨 최소 간격(px) — 겹침 방지
const VIZ_LABEL_MAX_PTS = 12; // 점이 이 개수 이하일 때만 데이터 라벨 유지(그 외는 툴팁으로만)

/** Y 눈금 위치 비율 배열 (0~1). VIZ_Y_TICKS 개. */
function vizYFractions() {
  const n = Math.max(2, VIZ_Y_TICKS);
  return Array.from({ length: n }, (_, i) => i / (n - 1));
}

/** X 눈금 인덱스: 라벨 1개당 최소 gap(px) 을 확보해 겹치지 않는 개수만 고른다. */
function vizTickIdx(n, plotW, gap) {
  const g = gap || VIZ_TICK_GAP;
  // 눈금 수는 '라벨 최소 간격(g)'만으로 정한다. 예전엔 여기에 min(8, …) 상한이 있어
  // 자리가 남는데도 8개로 잘렸고, 12개월 고정 차트(정시성·스폰지 단일연도)에서
  // Feb/May/Aug/Nov 가 누락됐다. g 가 이미 겹침을 막으므로 별도 상한은 두지 않는다.
  // (recharts 의 interval={0} 에 해당 — 자리가 되면 전부, 모자라면 g 간격으로 생략)
  const maxTicks = Math.max(2, Math.floor(plotW / g));
  const t = Math.min(maxTicks, n);
  const out = [];
  for (let k = 0; k < t; k++) {
    const i = t <= 1 ? 0 : Math.round((k / (t - 1)) * (n - 1));
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

/* ── 스폰지 주원료 시황 (ICIS Asia, 고정 데이터) ── */
const ICIS_DATA = {
  periods: ["2021-01","2021-02","2021-03","2021-04","2021-05","2021-06","2021-07","2021-08","2021-09","2021-10","2021-11","2021-12","2022-01","2022-02","2022-03","2022-04","2022-05","2022-06","2022-07","2022-08","2022-09","2022-10","2022-11","2022-12","2023-01","2023-02","2023-03","2023-04","2023-05","2023-06","2023-07","2023-08","2023-09","2023-10","2023-11","2023-12","2024-01","2024-02","2024-03","2024-04","2024-05","2024-06","2024-07","2024-08","2024-09","2024-10","2024-11","2024-12","2025-01","2025-02","2025-03","2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03","2026-04","2026-05","2026-06","2026-07","2026-08"],
  PPG: [2600,2600,2650,2550,2800,2600,2300,2450,2450,2350,2550,2300,2300,1900,2000,2000,1850,1850,1825,1300,1350,1600,1750,1400,1180,1500,1600,1600,1550,1395,1450,1435,1435,1450,1350,1350,1400,1370,1350,1400,1400,1388,1350,1320,1296,1299,1295,1266,1261,1250,1250,1182,1150,1156,1160,1194,1188,1224,1186,1191,1221,1209,1776,2110,1666,1350,1392,1453],
  TDI: [1900,1950,2800,2700,2500,2080,1900,2050,2150,2300,2450,2450,2450,2600,2950,3000,2900,2550,2600,2500,2550,2750,3000,2500,2600,2800,2650,2400,2450,2200,2200,2200,2050,2100,2050,1950,1950,2100,2100,2025,1960,1900,1880,1872,1800,1800,1800,1800,1850,1938,1808,1682,1680,1650,1740,1975,1825,1800,1700,1810,1825,1888,2500,2890,2563,2238,2120,2317],
  MDI: [2300,2600,3300,2900,2450,2200,2400,2600,2600,3000,2700,2500,2500,2800,2800,2700,2650,2400,2200,2050,1950,1950,1850,1600,1750,1850,2000,1900,1800,1775,1850,1930,1950,1900,1750,1750,1800,2100,2100,2063,2100,2163,2200,2175,2113,2200,2200,2100,2175,2238,2150,2010,1988,1925,1832,1817,1763,1686,1650,1765,1765,1750,2300,2920,2688,2375,2165,2233],
  PO: [2100,2100,2400,2350,2275,1850,1790,2070,2070,2240,2250,2070,1700,1800,1500,1450,1375,1330,1220,1050,1120,1250,1050,1050,1050,1150,1380,1165,1200,1210,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,965,948,920,903,915,920,904,907,910,925,955,962,994,1000,1355,1710,1713,1398,1217,1288],
};
const ICIS_SERIES = [
  { key: 'PPG', color: '#3B82F6' },  // 파랑
  { key: 'TDI', color: '#12B981' },  // 초록
  { key: 'MDI', color: '#F59E0B' },  // 주황
  { key: 'PO',  color: '#8B5CF6' },  // 보라
];

// 원료 용어 설명 (그래프 색과 매칭)
const ICIS_TERMS = [
  { key: 'PPG', color: '#3B82F6', full: 'Polypropylene Glycol (폴리프로필렌글리콜, Polyether Polyol)',
    use: '폴리우레탄 폼의 주원료. 침대 매트리스·소파·자동차 시트 등에 사용' },
  { key: 'TDI', color: '#12B981', full: 'Toluene Diisocyanate (톨루엔 디이소시아네이트)',
    use: '연질(Soft) 폴리우레탄 폼 제조에 사용되는 핵심 원료' },
  { key: 'MDI', color: '#F59E0B', full: 'Methylene Diphenyl Diisocyanate (메틸렌 디페닐 디이소시아네이트)',
    use: '경질(Rigid) 폴리우레탄 폼 및 고기능 폼 제조에 사용되는 원료' },
  { key: 'PO', color: '#8B5CF6', full: 'Propylene Oxide (프로필렌 옥사이드)',
    use: 'PPG(폴리올)를 만드는 기초 원료(원료의 원료)' },
];


let _icisChart = null;
let _matReady = false;      // [업데이트] 누르기 전엔 빈 초기 상태
let _matYear = null;        // 선택된 연도('2021'~'2026' | 'all')
let _matUsdKrw = null;      // USD/KRW 환율(업데이트 시 확보)

// 해상 정시성(Sea-Intelligence) — 연도별 선 색상 + 상태
const SR_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 연도별 선 색 — 순환 팔레트.
// ★ 앞 6색은 기존 SR_YEAR_COLORS(2021~2026)의 값을 순서 그대로 옮긴 것이라
//   현재 화면의 연도별 색은 변하지 않는다. 2027부터 뒤쪽 색을 이어 쓴다.
const SR_YEAR_BASE = 2021;          // 팔레트 0번이 대응하는 연도
const SR_PALETTE = [
  '#94A3B8', // 2021 (기존)
  '#3B82F6', // 2022 (기존)
  '#12B981', // 2023 (기존)
  '#F59E0B', // 2024 (기존)
  '#8B5CF6', // 2025 (기존)
  '#C8102E', // 2026 (기존)
  '#0EA5E9', // 2027 ↓ 신규
  '#DB2777', // 2028
  '#65A30D', // 2029
  '#F97316', // 2030
];

/** 연도 → 선 색. 팔레트 10색을 순환하므로 2031년에야 2021과 색이 겹친다. */
function srYearColor(year) {
  const n = Number(year);
  if (!isFinite(n)) return 'var(--slate)';
  const len = SR_PALETTE.length;
  return SR_PALETTE[(((n - SR_YEAR_BASE) % len) + len) % len];
}
let _srData = null;   // {months, years:{...}} | {error:'reason'} | null
let _srYear = null;   // '2021'~'2026' | 'all'
let _srChart = null;

let _icisForecast = null; // 순수 추가: 다음 달 주원료 예측(백엔드 계산). null이면 예측 섹션 숨김
let _srForecast = null;   // 순수 추가: 다음 달 해상 정시성 예측(백엔드 계산). null이면 섹션 숨김

/** 응답의 usd_krw + 해상 정시성 + 국제유가 저장 + 원자재 섹션을 "업데이트됨" 상태로 전환 */
function applyMaterialUpdate(data) {
  _matReady = true;
  const uk = data && data.sections && data.sections.usd_krw;
  _matUsdKrw = (uk && uk.status === 'ok') ? uk.rate : null;

  const sr = data && data.sections && data.sections.schedule_reliability;
  if (sr && sr.status === 'ok' && sr.years && Object.keys(sr.years).length) {
    _srData = { months: (sr.months && sr.months.length) ? sr.months : SR_MONTHS, years: sr.years };
    // ICIS와 동일: 업데이트 직후엔 그래프를 띄우지 않고 연도 선택을 기다린다(_srYear=null → "연도를 선택하세요")
  } else {
    _srData = { error: (sr && sr.reason) || '데이터 없음' };
  }

  // 국제유가(원유) — 기준 4개(년·월·주·일)를 한 번에 받아 두고 화면에서 자른다
  const oc = data && data.sections && data.sections.oil_crude;
  if (oc && oc.status === 'ok' && oc.terms && Object.keys(oc.terms).length) {
    _ocData = oc;
    if (!_ocForm) _ocForm = ocFormFor(ocTerm('m') ? 'm' : Object.keys(oc.terms)[0]);
  } else {
    _ocData = { error: (oc && oc.reason) || '데이터 없음' };
  }
  // 국제유가(석유제품) — 원유와 같은 구조의 별도 섹션
  const op = data && data.sections && data.sections.oil_product;
  if (op && op.status === 'ok' && op.terms && Object.keys(op.terms).length) {
    _opData = op;
    if (!_opForm) _opForm = opFormFor(opTerm('d') ? 'd' : Object.keys(op.terms)[0]);
  } else {
    _opData = { error: (op && op.reason) || '데이터 없음' };
  }
  // 순수 추가: 다음 달 예측 저장(있을 때만; 없으면 예측 섹션 숨김)
  const fc = data && data.sections && data.sections.icis_forecast;
  _icisForecast = (fc && fc.status === 'ok') ? fc : null;
  const srf = data && data.sections && data.sections.sr_forecast;
  _srForecast = (srf && srf.status === 'ok') ? srf : null;  // 순수 추가: 정시성 예측
  renderMaterial();
}

/** 선택 연도에 맞춰 periods/series 슬라이스 (데이터 있는 원료만) */
function icisViewData(year) {
  const P = ICIS_DATA.periods;
  const idx = year === 'all'
    ? P.map((_, i) => i)
    : P.map((p, i) => (p.slice(0, 4) === year ? i : -1)).filter((i) => i >= 0);
  const periods = idx.map((i) => P[i]);
  const series = ICIS_SERIES
    .map((s) => ({ key: s.key, color: s.color, values: idx.map((i) => ICIS_DATA[s.key][i]) }))
    .filter((s) => s.values.some((v) => v != null));  // 값 없는 원료(예: 2024 PO)는 생략
  return { periods, series };
}

/* ══ 시황 인사이트 — 요약 배지 · 변곡점 마커 · 요인 해설 ═══════════════════
   '리포트 분석' 버튼(눌러야 보이는 팝오버)을 대신해, 차트와 늘 함께 보이는
   세 가지를 붙인다.
     ① 전월비 · 전년비 · 국면 배지   ② 차트 위 변곡점 마커   ③ 요인 해설 2단
   ★ 배지는 전부 실데이터에서 계산한다. 비교할 과거 시점이 없으면 '—' 로 둔다
     — 없는 숫자를 만들지 않는다.
   ★ 해설 문구와 변곡점은 public/data/insights.json 한 곳에서만 온다.
     코드에 문장을 적지 않으므로, 조사 내용이 바뀌면 JSON 만 고치면 된다. */
const MS_DATA_URL = 'public/data/insights.json';
let _msData = null;   // { updated, <위젯키>: {structural_factor, short_term_factor, events[]} }

/** 해설 데이터 로드. 실패해도 배지·차트는 그대로 나온다(해설만 빠진다). */
async function fetchInsights() {
  try {
    const res = await fetch(MS_DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _msData = d;
  } catch (e) {
    _msData = null;
    console.warn('[insights] 로드 실패:', e);
  }
  renderMaterial();
}

/** 위젯 키로 해설 묶음을 꺼낸다. 없으면 null. */
function msFor(key) {
  const d = _msData && _msData[key];
  return (d && typeof d === 'object') ? d : null;
}

/* ── 시계열 계산 ─────────────────────────────────────────────────────────
   pts 는 [{k:'YYYY-MM' | 'YYYY-MM-DD' | 'YYYY', v:number}] 오름차순.
   월 단위로 맞춰 놓고 계산한다 — 위젯마다 일·주·월·연이 섞여 있어서다. */

/** 'YYYY-MM-DD' → 'YYYY-MM'. 연도만 있으면 'YYYY-12' 로 본다(그 해의 마지막). */
function msYm(k) {
  const s = String(k || '');
  if (/^\d{4}$/.test(s)) return s + '-12';
  return s.slice(0, 7);
}

/** 'YYYY-MM' 을 개월 수로 (비교·차감용) */
function msMonthNo(ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return (!isFinite(y) || !isFinite(m)) ? null : y * 12 + (m - 1);
}

/** 월별 시계열로 접는다(같은 달은 마지막 값). [{ym, v}] */
function msMonthly(pts) {
  const map = new Map();
  pts.forEach((p) => map.set(msYm(p.k), p.v));
  return Array.from(map.keys()).sort().map((ym) => ({ ym: ym, v: map.get(ym) }));
}

/** n개월 전 대비 변화율(%). 그 시점 부근에 데이터가 없으면 null. */
function msChangeAt(m, months) {
  if (m.length < 2) return null;
  const last = m[m.length - 1];
  const lastNo = msMonthNo(last.ym);
  if (lastNo == null) return null;
  const wantNo = lastNo - months;
  // 원하는 시점 이하에서 가장 가까운 점
  let prev = null;
  for (let i = m.length - 2; i >= 0; i -= 1) {
    const no = msMonthNo(m[i].ym);
    if (no != null && no <= wantNo) { prev = m[i]; break; }
  }
  if (!prev) return null;
  // 너무 오래된 값과 비교하지 않는다(구멍 난 구간을 '전월비'라 부르지 않게)
  const gap = wantNo - msMonthNo(prev.ym);
  if (gap > (months >= 12 ? 2 : 1)) return null;
  if (!prev.v) return null;
  return { pct: ((last.v - prev.v) / Math.abs(prev.v)) * 100, from: prev, to: last };
}

/** 국면 판정 — 최근 월별 등락만 보고 규칙으로 정한다(해석을 지어내지 않는다). */
function msPhase(m) {
  if (m.length < 4) return null;
  const tail = m.slice(-7);
  const ch = [];
  for (let i = 1; i < tail.length; i += 1) {
    if (!tail[i - 1].v) return null;
    ch.push(((tail[i].v - tail[i - 1].v) / Math.abs(tail[i - 1].v)) * 100);
  }
  if (!ch.length) return null;
  const last = ch[ch.length - 1];
  const FLAT = 0.5;          // 이 정도 변화는 '움직이지 않은 것'으로 본다

  // 1) 같은 방향으로 이어진 개월 수
  let run = 0;
  if (Math.abs(last) >= FLAT) {
    const up = last > 0;
    for (let i = ch.length - 1; i >= 0; i -= 1) {
      if (Math.abs(ch[i]) < FLAT || (ch[i] > 0) !== up) break;
      run += 1;
    }
    if (run >= 2) {
      return { kind: up ? 'up' : 'down', icon: up ? '▲' : '▼',
        text: (up ? '상승' : '하락') + ' ' + run + '개월째' };
    }
  }

  // 2) 큰 등락 직후 잦아든 국면
  const recent = ch.slice(-4);
  const big = recent.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  if (Math.abs(big) >= 8 && Math.abs(last) < 3) {
    return big < 0
      ? { kind: 'down', icon: '▽', text: '급락 진정중' }
      : { kind: 'up', icon: '△', text: '급등 진정중' };
  }

  // 3) 좁은 폭에 머무는 구간
  const win = m.slice(-6).map((x) => x.v).filter((v) => v != null && isFinite(v));
  if (win.length >= 4) {
    const mx = Math.max(...win), mn = Math.min(...win);
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    if (avg && ((mx - mn) / Math.abs(avg)) * 100 <= 6) {
      return { kind: 'flat', icon: '▬', text: '박스권' };
    }
  }

  // 4) 한 달만 방향이 바뀐 경우
  if (run === 1) {
    return last > 0
      ? { kind: 'up', icon: '▲', text: '반등' }
      : { kind: 'down', icon: '▼', text: '조정' };
  }
  return { kind: 'flat', icon: '▬', text: '혼조' };
}

/* ── 변곡점 마커 ─────────────────────────────────────────────────────────
   차트마다 X(i) 가 인덱스에 선형이라, 날짜를 '소수 인덱스'로 바꿔 그대로 넘긴다. */

/** 축 눈금 하나를 숫자로. 일(日)까지 있는 축이면 일 단위로 재서 위치를 정확히 잡는다. */
function msAxisNo(k, daily) {
  const s = String(k || '');
  if (daily && /^\d{4}-\d{2}-\d{2}/.test(s)) return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  const mn = msMonthNo(msYm(s));
  return mn == null ? null : mn * 30.4375;   // 월 축도 같은 '일' 자로 환산해 섞이지 않게
}

/** 이벤트 날짜가 x축 어디쯤인지 — 축 밖이면 null(억지로 끌어다 붙이지 않는다) */
function msFracIndex(keys, date) {
  if (!keys || keys.length < 2) return null;
  const daily = keys.every((k) => /^\d{4}-\d{2}-\d{2}/.test(String(k || '')));
  const t = msAxisNo(date, daily);
  if (t == null) return null;
  const ns = keys.map((k) => msAxisNo(k, daily));
  if (t < ns[0] || t > ns[ns.length - 1]) return null;
  for (let i = 1; i < ns.length; i += 1) {
    if (t <= ns[i]) {
      const span = ns[i] - ns[i - 1];
      return span > 0 ? (i - 1) + (t - ns[i - 1]) / span : i;
    }
  }
  return keys.length - 1;
}

/** 차트 안에 넣을 변곡점 마커 SVG. 이벤트가 없거나 축 밖이면 ''. */
function msEventsSvg(key, keys, X, padT, plotH, W) {
  const info = msFor(key);
  return vizEventsSvg((info && Array.isArray(info.events)) ? info.events : [],
    keys, X, padT, plotH, W);
}

/** 변곡점 마커 — 이벤트 배열을 직접 받는다.
 *  ★ 부문마다 이벤트 목록이 달라지는 KOIMA 가 이 형태로 쓴다.
 *  ★ e.ref === true 면 '참고용'이라 옅은 빈 원으로 그려 눈으로도 구분되게 한다.
 *    (ref 가 없는 기존 위젯의 출력은 예전과 한 글자도 다르지 않다) */
function vizEventsSvg(evs, keys, X, padT, plotH, W) {
  if (!evs.length || !keys || keys.length < 2) return '';
  const FS = 7.5, GAP = 5, ROWS = [13, 22];   // 라벨을 얹을 줄(마커 점 기준 아래로)

  // ① 그릴 수 있는 것만 골라 x 순서로 세운다
  const items = evs.map((e) => {
    const fi = msFracIndex(keys, e.date);
    if (fi == null) return null;
    const x = X(fi);
    if (!isFinite(x)) return null;
    const label = String(e.label || '');
    const tw = vizTextW(label, FS);
    const anchor = (x < 60) ? 'start' : ((x > W - 60) ? 'end' : 'middle');
    const x0 = anchor === 'start' ? x : (anchor === 'end' ? x - tw : x - tw / 2);
    return { e: e, x: x, label: label, anchor: anchor, x0: x0, x1: x0 + tw };
  }).filter(Boolean).sort((a, b) => a.x0 - b.x0);
  if (!items.length) return '';

  // ② 줄 배정 — 앞 라벨과 겹치면 다음 줄로 내린다. 두 줄로도 안 되면 라벨만 뺀다
  //    (마커 선·점은 남겨 위치는 계속 보이게 한다).
  //    ★ 예전에는 모두 한 줄에 찍어 가까운 두 이벤트의 이름이 붙어 보였다.
  const rowEnd = ROWS.map(() => -Infinity);
  items.forEach((it) => {
    it.row = -1;
    for (let r = 0; r < ROWS.length; r += 1) {
      if (it.x0 >= rowEnd[r] + GAP) { it.row = r; rowEnd[r] = it.x1; break; }
    }
  });

  const out = items.map((it) => {
    const y0 = padT, y1 = padT + plotH;
    const label = (it.row >= 0)
      ? '<text pointer-events="none" x="' + it.x.toFixed(1) + '" y="' + (y0 + ROWS[it.row]).toFixed(1) + '"'
        + ' text-anchor="' + it.anchor + '" font-size="' + FS + '" font-weight="700"'
        + ' paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5"'
        + ' fill="var(--ink)">' + escapeHtml(it.label) + '</text>'
      : '';
    return '<g class="ms-ev" tabindex="0"'
      + ' data-label="' + escapeHtml(it.label) + '"'
      + ' data-detail="' + escapeHtml(it.e.detail || '') + '"'
      + ' data-date="' + escapeHtml(it.e.date || '') + '">'
      + '<line pointer-events="none" x1="' + it.x.toFixed(1) + '" y1="' + y0 + '" x2="' + it.x.toFixed(1) + '" y2="' + y1.toFixed(1) + '"'
      + ' stroke="var(--amber)" stroke-width="1" stroke-dasharray="2 2" opacity="' + (it.e.ref ? '.3' : '.6') + '"/>'
      + (it.e.ref
        ? '<circle pointer-events="none" cx="' + it.x.toFixed(1) + '" cy="' + (y0 + 2).toFixed(1) + '" r="2.4" fill="var(--surface-1)" stroke="var(--amber)" stroke-width="1.2"/>'
        : '<circle pointer-events="none" cx="' + it.x.toFixed(1) + '" cy="' + (y0 + 2).toFixed(1) + '" r="2.6" fill="var(--amber)"/>')
      + label
      + '<rect class="ms-ev__hit" x="' + (it.x - 7).toFixed(1) + '" y="' + y0 + '" width="14" height="' + plotH.toFixed(1) + '" fill="transparent"/>'
      + '</g>';
  }).join('');
  return out ? '<g class="ms-evs">' + out + '</g>' : '';
}

/* ── 변곡점 툴팁 — 화면에 하나만 두고 돌려 쓴다 ──────────────────────────
   각 차트가 이미 쓰고 있는 .viz-tooltip 과 섞이지 않도록 별도 요소를 쓴다. */
let _msTipEl = null;

function msTip() {
  if (_msTipEl && _msTipEl.isConnected) return _msTipEl;
  const el = document.createElement('div');
  el.className = 'ms-evtip';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  _msTipEl = el;
  return el;
}

function msTipShow(g) {
  const el = msTip();
  const label = g.getAttribute('data-label') || '';
  const detail = g.getAttribute('data-detail') || '';
  const date = g.getAttribute('data-date') || '';
  el.innerHTML = '<div class="ms-evtip__h">' + escapeHtml(label) + '</div>'
    + (date ? '<div class="ms-evtip__d">' + escapeHtml(date) + '</div>' : '')
    + (detail ? '<div class="ms-evtip__b">' + escapeHtml(detail) + '</div>' : '');
  el.classList.add('is-on');
  const r = g.getBoundingClientRect();
  // 화면 밖으로 나가지 않게 좌우를 물린다
  const w = el.offsetWidth || 220;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  const top = r.top - el.offsetHeight - 8;
  el.style.left = left + 'px';
  el.style.top = (top < 8 ? r.bottom + 8 : top) + 'px';
}

function msTipHide() {
  if (_msTipEl) _msTipEl.classList.remove('is-on');
}

/** 마커 후킹 — 마우스오버·포커스·탭(모바일) 모두 같은 툴팁을 쓴다.
 *  재렌더로 SVG 가 새로 그려져도 되도록 위임(delegation)으로 한 번만 건다. */
let _msWired = false;

function msWireEvents(root) {
  if (!root || _msWired) return;
  _msWired = true;
  const find = (e) => (e.target && e.target.closest ? e.target.closest('.ms-ev') : null);
  root.addEventListener('mouseover', (e) => { const g = find(e); if (g) msTipShow(g); });
  root.addEventListener('mouseout', (e) => { if (find(e)) msTipHide(); });
  root.addEventListener('focusin', (e) => { const g = find(e); if (g) msTipShow(g); });
  root.addEventListener('focusout', (e) => { if (find(e)) msTipHide(); });
  root.addEventListener('click', (e) => {
    const g = find(e);
    if (g) msTipShow(g); else msTipHide();
  });
  window.addEventListener('scroll', msTipHide, { passive: true });
}

/* ── 요인 해설 2단 ───────────────────────────────────────────────────── */

/** 구조적 요인 / 단기 요인 + 갱신 캡션. 해설이 없으면 ''(빈 칸을 만들지 않는다). */
function msFactorsHtml(key) {
  const d = msFor(key);
  if (!d) return '';
  const st = String(d.structural_factor || '').trim();
  const sh = String(d.short_term_factor || '').trim();
  if (!st && !sh) return '';
  const upd = (_msData && _msData.updated) ? String(_msData.updated) : null;
  const col = (h, t) => (t ? '<div class="ms-factor"><div class="ms-factor__h">' + escapeHtml(h)
    + '</div><p class="ms-factor__b">' + escapeHtml(t) + '</p></div>' : '');
  return '<div class="ms-factors">'
    + '<div class="ms-factors__cols">' + col('구조적 요인', st) + col('단기 요인', sh) + '</div>'
    + '<div class="ms-factors__cap">시황 해설은 주기적으로 갱신됩니다'
    + (upd ? ' (최종 갱신: ' + escapeHtml(upd) + ')' : '') + '</div>'
    + '</div>';
}

/* ── 위젯별 '대표 계열' — 배지는 이 계열 하나로 계산한다 ──────────────────
   ★ 여러 계열을 평균 내지 않는다. 없는 합성지수를 만드는 셈이 되기 때문이다.
     대신 어느 계열로 쟀는지 배지 옆에 그대로 적는다. */

/** 국제유가(원유·제품) — 월별 전 구간에서 고른 유종/제품 하나. */
function msPtsPetro(data, key) {
  const rows = (data && data.terms && data.terms.m && data.terms.m.rows) || [];
  return rows.map((r) => ({ k: r.period, v: r[key] })).filter((x) => x.v != null);
}

/** 해상 정시성 — 전 연도를 이어 붙인 월별 정시율. */
function msPtsSr() {
  const ys = Object.keys((_srData && _srData.years) || {}).sort();
  return srFlatten(ys).map((p) => ({ k: p.ym, v: p.v }));
}

/* ══ ICIS 6단 시황 패널 ═══════════════════════════════════════════════════
   ① 가격 추이 + 추세 연장   ② 원자재별 변동요인   ③ 히스토리 타임라인
   ④ 단기·중기 전망          ⑥ 시사점·의사결정 포인트
   (⑤ 원가 시뮬레이션은 제품별 BOM 비중이 없어 이번에는 만들지 않는다)

   ★★ 추세 연장은 '예측 모델'이 아니다. 최근 3개월 이동평균의 기울기를 그대로
     3개월 늘려 그은 직선일 뿐이며, 화면에도 그렇게 적는다. 수요·공급이나 지정학
     변수를 넣지 않았으므로 실제 시장 전망으로 읽히면 안 된다.
   ★ 해설 문구·타임라인·시사점은 public/data/icis-insights.json 한 곳에서만 온다. */
const II_DATA_URL = 'public/data/icis-insights.json';
let _iiData = null;

const II_EXT_MONTHS = 3;   // 몇 개월을 늘려 그을지
const II_MA_WIN = 3;       // 이동평균 창(개월)
const II_SLOPE_WIN = 6;    // 기울기를 잴 이동평균 구간(개월)

/** 해설 데이터 로드. 실패해도 차트·배지는 그대로 나온다. */
async function fetchIcisInsights() {
  try {
    const res = await fetch(II_DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _iiData = d;
  } catch (e) {
    _iiData = null;
    console.warn('[icis-insights] 로드 실패:', e);
  }
  renderMaterial();
}

/** 'YYYY-MM' 에 n개월 더하기 */
function iiAddMonth(ym, n) {
  const y = Number(String(ym).slice(0, 4)), m = Number(String(ym).slice(5, 7));
  const t = y * 12 + (m - 1) + n;
  return String(Math.floor(t / 12)) + '-' + String((t % 12) + 1).padStart(2, '0');
}

/** 최근 II_SLOPE_WIN 개 이동평균에 최소제곱 직선을 맞춘다.
 *  { slope: 월당 변화량, sd: 그 직선에서 벗어난 정도 } · 관측치가 모자라면 null
 *  ★ sd 는 '원시 등락폭'이 아니라 '추세선이 얼마나 잘 맞았나(잔차)'다.
 *    원시 등락폭을 쓰면 2026년 급등장의 변동성이 그대로 반영돼 띠가 실측값의
 *    40% 가까이 벌어지고, 그만큼 y축이 늘어나 정작 실측 곡선이 눌려 보였다. */
function iiFit(vals) {
  const v = (vals || []).filter((x) => x != null && isFinite(x));
  if (v.length < II_MA_WIN + II_SLOPE_WIN - 1) return null;
  const ma = [];
  for (let i = II_MA_WIN - 1; i < v.length; i += 1) {
    let s = 0;
    for (let k = 0; k < II_MA_WIN; k += 1) s += v[i - k];
    ma.push(s / II_MA_WIN);
  }
  const w = ma.slice(-II_SLOPE_WIN);
  if (w.length < II_SLOPE_WIN) return null;
  const n = w.length, xm = (n - 1) / 2;
  const ym = w.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  w.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) * (i - xm); });
  if (!den) return null;
  const slope = num / den;
  const b = ym - slope * xm;
  let q = 0;
  w.forEach((y, i) => { const r = y - (slope * i + b); q += r * r; });
  return { slope: slope, sd: Math.sqrt(q / n) };
}

/** 추세 연장. { periods:[3개], byKey:{PPG:{values,band,base,slope}} } · 못 내면 null
 *  ★ 화면에 보이는 구간이 데이터의 마지막까지 닿아 있을 때만 낸다 — 2023년만 보는
 *    화면에 2027년을 그려 넣지 않기 위해서다. */
function iiExtend(viewPeriods) {
  const P = ICIS_DATA.periods;
  if (!P.length || !viewPeriods.length) return null;
  if (viewPeriods[viewPeriods.length - 1] !== P[P.length - 1]) return null;
  const periods = [];
  for (let k = 1; k <= II_EXT_MONTHS; k += 1) periods.push(iiAddMonth(P[P.length - 1], k));
  const byKey = {};
  ICIS_SERIES.forEach((s) => {
    const vals = ICIS_DATA[s.key] || [];
    const fit = iiFit(vals);
    const live = vals.filter((x) => x != null && isFinite(x));
    if (!fit || !live.length) return;
    const base = live[live.length - 1], slope = fit.slope;
    const sd = fit.sd || 0;
    const values = [], band = [];
    for (let k = 1; k <= II_EXT_MONTHS; k += 1) {
      const v = Math.max(0, base + slope * k);
      values.push(v);
      const w = sd * Math.sqrt(k);        // 걸음이 쌓일수록 넓어지는 띠
      band.push({ lo: Math.max(0, v - w), hi: v + w });
    }
    byKey[s.key] = { values: values, band: band, base: base, slope: slope };
  });
  return Object.keys(byKey).length ? { periods: periods, byKey: byKey } : null;
}

/** 추세 연장 기준 3개월 변화율(%) — 없으면 null */
function iiExtPct(ext, key) {
  const e = ext && ext.byKey[key];
  if (!e || !e.base) return null;
  return ((e.values[e.values.length - 1] - e.base) / Math.abs(e.base)) * 100;
}

/** 등락률 → 말로. 폭에 따라 표현만 달리한다(원인은 말하지 않는다). */
function iiWord(p) {
  if (p == null) return '판단 보류';
  const a = Math.abs(p);
  if (a < 2) return '보합권';
  if (a < 6) return p > 0 ? '완만한 상승' : '완만한 하락';
  return p > 0 ? '뚜렷한 상승' : '뚜렷한 하락';
}

/** 등락률 배지 색 — 오르면 빨강 · 내리면 파랑 (다른 카드와 같은 규칙) */
function iiCls(p) {
  if (p == null) return 'na';
  return p > 0.05 ? 'up' : (p < -0.05 ? 'down' : 'flat');
}

function iiPct(p) {
  if (p == null) return '—';
  return (p > 0.05 ? '▲ +' : (p < -0.05 ? '▼ ' : '')) + p.toFixed(1) + '%';
}

/** 원료의 최근값·전월비·전년비. 값이 없으면 null 로 둔다(지어내지 않는다). */
function iiStat(key) {
  const P = ICIS_DATA.periods, V = ICIS_DATA[key] || [];
  const idx = [];
  V.forEach((v, i) => { if (v != null && isFinite(v)) idx.push(i); });
  if (!idx.length) return null;
  const i = idx[idx.length - 1];
  const at = (back) => {
    const j = i - back;
    return (j >= 0 && V[j] != null && isFinite(V[j])) ? V[j] : null;
  };
  const chg = (prev) => (prev ? ((V[i] - prev) / Math.abs(prev)) * 100 : null);
  return { period: P[i], value: V[i], mom: chg(at(1)), yoy: chg(at(12)) };
}

/* ── ② 원자재별 변동요인 카드 4개 ──────────────────────────────────────── */
function iiMaterialCards() {
  const info = (_iiData && _iiData.materials) || {};
  const cards = ICIS_SERIES.map((s) => {
    const st = iiStat(s.key);
    if (!st) return '';
    const m = info[s.key] || {};
    const krw = (_matUsdKrw != null) ? fmtKrwShort(st.value * _matUsdKrw) + '/톤' : null;
    return `<div class="ii-mat" style="--ii-c:${s.color}">
      <div class="ii-mat__top">
        <span class="ii-mat__icon" aria-hidden="true">${escapeHtml(m.icon || '•')}</span>
        <span class="ii-mat__key">${escapeHtml(s.key)}</span>
        ${m.role ? `<span class="ii-mat__role">${escapeHtml(m.role)}</span>` : ''}
      </div>
      <div class="ii-mat__val">${Math.round(st.value).toLocaleString('en-US')}<span class="ii-mat__unit">USD/톤</span></div>
      ${krw ? `<div class="ii-mat__krw">≈ ${escapeHtml(krw)}</div>` : ''}
      <div class="ii-mat__chg">
        <span class="ii-mat__lbl">전월비</span>
        <span class="ms-badge__val ${iiCls(st.mom)}">${iiPct(st.mom)}</span>
        <span class="ii-mat__asof">${escapeHtml(st.period)}</span>
      </div>
      ${m.reason ? `<p class="ii-mat__why">${escapeHtml(m.reason)}</p>` : ''}
    </div>`;
  }).join('');
  if (!cards) return '';
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">② 원자재별 변동요인</h3>
    <div class="ii-mats">${cards}</div>
  </div>`;
}

/* ── ③ 히스토리 이벤트 타임라인 ────────────────────────────────────────── */
function iiTimeline() {
  const list = (_iiData && Array.isArray(_iiData.timeline)) ? _iiData.timeline : [];
  if (!list.length) return '';
  const items = list.map((e) => `<li class="ii-tl__item">
      <span class="ii-tl__dot" aria-hidden="true"></span>
      <span class="ii-tl__date">${escapeHtml(e.date || '')}</span>
      <span class="ii-tl__body">
        <span class="ii-tl__event">${escapeHtml(e.event || '')}</span>
        ${e.impact ? `<span class="ii-tl__impact">${escapeHtml(e.impact)}</span>` : ''}
      </span>
    </li>`).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">③ 히스토리 이벤트</h3>
    <ol class="ii-tl">${items}</ol>
  </div>`;
}

/* ── ④ 단기·중기 전망 ──────────────────────────────────────────────────
   ★ 문장을 지어내지 않는다. 단기는 ①의 추세 연장 값을, 중기는 실측 12개월
     변화와 5년 범위 안 위치를 그대로 말로 옮긴 것이다. */
function iiSpark(key, color, ext) {
  const V = ICIS_DATA[key] || [];
  const hist = V.slice(-12).filter((v) => v != null && isFinite(v));
  const e = ext && ext.byKey[key];
  const proj = e ? e.values : [];
  const all = hist.concat(proj);
  if (all.length < 3) return '';
  const W = 132, H = 34, pad = 2;
  const mn = Math.min(...all), mx = Math.max(...all);
  const X = (i) => pad + (i / (all.length - 1)) * (W - pad * 2);
  const Y = (v) => pad + (1 - (v - mn) / ((mx - mn) || 1)) * (H - pad * 2);
  const line = (arr, from) => arr.map((v, i) =>
    `${i ? 'L' : 'M'}${X(from + i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  const solid = line(hist, 0);
  const dash = proj.length ? line([hist[hist.length - 1]].concat(proj), hist.length - 1) : '';
  return `<svg class="ii-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="${escapeHtml(key)} 최근 12개월과 추세 연장">
    <path d="${solid}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
    ${dash ? `<path d="${dash}" fill="none" stroke="${color}" stroke-width="1.6"
      stroke-dasharray="3 3" opacity=".75"/>` : ''}
    ${proj.length ? `<circle cx="${X(all.length - 1).toFixed(1)}" cy="${Y(all[all.length - 1]).toFixed(1)}"
      r="2" fill="var(--surface-1)" stroke="${color}" stroke-width="1.4"/>` : ''}
  </svg>`;
}

/** 중기 = 실측 12개월 변화 + 최근 5년 범위 안에서의 위치 */
function iiMidText(key) {
  const st = iiStat(key);
  if (!st) return null;
  const V = (ICIS_DATA[key] || []).slice(-60).filter((v) => v != null && isFinite(v));
  let pos = null;
  if (V.length >= 12) {
    const mn = Math.min(...V), mx = Math.max(...V);
    if (mx > mn) pos = Math.round(((st.value - mn) / (mx - mn)) * 100);
  }
  const parts = [];
  parts.push(st.yoy == null ? '전년 자료 없음'
    : '최근 12개월 ' + (st.yoy > 0 ? '+' : '') + st.yoy.toFixed(1) + '%');
  if (pos != null) parts.push('최근 5년 범위의 ' + pos + '% 지점');
  return parts.join(' · ');
}

function iiOutlook(ext) {
  const rows = ICIS_SERIES.map((s) => {
    const st = iiStat(s.key);
    if (!st) return '';
    const p = iiExtPct(ext, s.key);
    const mid = iiMidText(s.key);
    return `<div class="ii-ol" style="--ii-c:${s.color}">
      <div class="ii-ol__head">
        <span class="ii-ol__key">${escapeHtml(s.key)}</span>
        ${iiSpark(s.key, s.color, ext)}
      </div>
      <div class="ii-ol__line"><span class="ii-ol__lbl">단기</span>
        <span class="ii-ol__txt">${p == null ? '추세를 잴 관측치가 모자랍니다'
          : `3개월 추세 연장 <b class="ms-badge__val ${iiCls(p)}">${iiPct(p)}</b> — ${escapeHtml(iiWord(p))}`}</span></div>
      <div class="ii-ol__line"><span class="ii-ol__lbl">중기</span>
        <span class="ii-ol__txt">${mid ? escapeHtml(mid) : '판단할 관측치가 모자랍니다'}</span></div>
    </div>`;
  }).join('');
  if (!rows) return '';
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">④ 단기 · 중기 전망</h3>
    <div class="ii-ols">${rows}</div>
    <div class="ii-cap">단기는 ①의 추세 연장값, 중기는 실측 12개월 변화와 최근 5년 범위 안 위치를
      그대로 옮긴 것입니다. 시장 전망이 아닙니다.</div>
  </div>`;
}

/* ── ⑥ 시사점 및 의사결정 포인트 (3열) ────────────────────────────────── */
/* ── ⑥ 카드 본문 강조 ────────────────────────────────────────────────────
   세 가지를 굵게 칠한다.
     · 원자재명(PPG·TDI·MDI·PO·폴리올 …) — 목록이 정해져 있어 자동으로 잡는다
     · 수치·비율(%, USD/톤, 만 원/톤) — 나중에 실제 수치가 들어와도 자동으로 걸린다
     · 판단 키워드 — 문장마다 다르므로 JSON 에서 **별표**로 지정한다
   ★ escapeHtml 을 먼저 걸고, 그 뒤에는 '태그 밖의 글자'만 손댄다 —
     방금 넣은 <b> 태그 안을 다시 치환해 태그가 깨지는 일이 없게. */
const II_MATS = 'PPG|TDI|MDI|PO';
const II_WORDS = ['폴리올', '이소시아네이트', '폴리우레탄 폼', '컴포트 레이어'];

function iiEmph(text) {
  const esc = escapeHtml(String(text || ''));
  // **판단 키워드** 를 기준으로 자른다. 홀수 조각이 지정된 키워드다.
  // ★ 지정 키워드 '안'은 다시 훑지 않는다 — 이미 통째로 강조돼 있어서,
  //   그 안의 숫자를 또 감싸면 <b> 가 겹친다(예: **56~59%**).
  return esc.split(/\*\*([^*]+)\*\*/).map((seg, i) => {
    if (i % 2) return '<b class="ii-k">' + seg + '</b>';
    return seg.split(/(<[^>]+>)/).map((t) => {
      if (t.charAt(0) === '<') return t;
      let s = t.replace(/([+-]?\d[\d,]*(?:\.\d+)?\s*(?:%p|%|USD\/톤|만\s*원\/톤))/g,
        '<b class="ii-k">$1</b>');
      // 영문 원자재 약어 — 앞뒤가 영문이면 잡지 않는다(단어 경계)
      s = s.replace(new RegExp('(^|[^A-Za-z])(' + II_MATS + ')(?![A-Za-z])', 'g'),
        '$1<b class="ii-k">$2</b>');
      II_WORDS.forEach((w) => { s = s.split(w).join('<b class="ii-k">' + w + '</b>'); });
      return s;
    }).join('');
  }).join('');
}

/* 카드 톤 — 주의(주황) · 검토(파랑) · 실행(녹색). 아이콘도 같은 색을 쓴다. */
const II_TONES = {
  // 단기 대응 — 빨강(브랜드 accent). 시계 아이콘으로 '시간이 촉박함'을 나타낸다.
  risk: { cls: 'risk', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7.2V12l3.4 2.1"/>' },
  warn: { cls: 'warn', icon: '<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4"/><path d="M12 17.4v.2"/>' },
  info: { cls: 'info', icon: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>' },
  act: { cls: 'act', icon: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.3 2.6 2.6 5-5.2"/>' },
};

function iiImpIcon(tone) {
  const t = II_TONES[tone];
  if (!t) return '';
  return '<svg class="ii-imp__ico" viewBox="0 0 24 24" width="15" height="15" fill="none"'
    + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    + ' aria-hidden="true">' + t.icon + '</svg>';
}

function iiImplications() {
  const im = (_iiData && _iiData.implications) || null;
  if (!im) return '';
  const col = (h, t, tone) => (t ? `<div class="ii-imp ii-imp--${tone}">
      <div class="ii-imp__h">${iiImpIcon(tone)}${escapeHtml(h)}</div>
      <p class="ii-imp__b">${iiEmph(t)}</p></div>` : '');
  const cols = col('주요 시사점', im.key_takeaway, 'warn')
    + col('검토 필요 사항', im.review_needed, 'info')
    + col('의사결정 활용 예시', im.decision_example, 'act');
  if (!cols) return '';
  const upd = (_iiData && _iiData.updated) ? String(_iiData.updated) : null;
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">⑥ 시사점 및 의사결정 포인트</h3>
    <div class="ii-imps">${cols}</div>
    ${im.note ? `<div class="ii-cap">${escapeHtml(im.note)}</div>` : ''}
    <div class="ii-cap">시황 해설은 주기적으로 갱신됩니다${upd ? ' (최종 갱신: ' + escapeHtml(upd) + ')' : ''}</div>
  </div>`;
}

/* ── 위젯 헤더 공용 요약 4박스 ────────────────────────────────────────────
   해상 정시성 위젯의 .sr-sum / sriBox() 를 그대로 재사용한다 —
   새 컴포넌트를 만들면 같은 자리에 두 가지 모양이 다시 생긴다. */

/** [{label, val, sub, cls}] → 요약 박스 줄. 빈 배열이면 ''(빈 껍데기를 남기지 않는다) */
function matSum(boxes) {
  const cells = (boxes || []).filter(Boolean)
    .map((b) => sriBox(b.label, b.val, b.cls || '', b.sub || '')).join('');
  return cells ? '<div class="sr-sum">' + cells + '</div>' : '';
}

/** 시계열 한 줄에서 최근값·전월비·전년비·12개월 평균을 뽑는다. 없으면 null */
function matStat(pts) {
  const p = (pts || []).filter((x) => x && x.v != null && isFinite(x.v));
  if (p.length < 2) return null;
  const m = msMonthly(p);
  const last = m[m.length - 1];
  const mom = msChangeAt(m, 1), yoy = msChangeAt(m, 12);
  const win = m.slice(-12).map((x) => x.v).filter((v) => v != null && isFinite(v));
  return {
    ym: last.ym, v: last.v,
    mom: mom ? mom.pct : null, yoy: yoy ? yoy.pct : null,
    avg: win.length ? win.reduce((a, b) => a + b, 0) / win.length : null,
  };
}

/** 등락률 한 조각 — 부호를 반드시 남긴다(음수가 '▼ 10.01%' 처럼 보이지 않게) */
function matPct(pct, digits) {
  if (pct == null || !isFinite(pct)) return '—';
  const icon = pct > 0.05 ? '▲ ' : (pct < -0.05 ? '▼ ' : '');
  return icon + (pct > 0 ? '+' : '') + pct.toFixed(digits == null ? 1 : digits) + '%';
}

/** 등락률 배지 — 박스의 값 칸이나 보조줄에 그대로 넣는다 */
function matBadge(pct, digits) {
  return '<span class="ms-badge__val ' + iiCls(pct) + '">' + matPct(pct, digits) + '</span>';
}

/** 등락률을 박스 보조줄에 넣을 모양으로 (해상 정시성 박스와 같은 표기) */
function matChg(label, pct) {
  return (label ? escapeHtml(label) + ' ' : '') + '<b class="ms-badge__val ' + iiCls(pct) + '">'
    + matPct(pct) + '</b>';
}

/** 값 + 작은 단위 표기 */
function matVal(v, unit, digits) {
  if (v == null || !isFinite(v)) return '—';
  const n = Number(v).toLocaleString('en-US', {
    minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0 });
  return escapeHtml(n) + (unit ? '<span class="sr-sum__u">' + escapeHtml(unit) + '</span>' : '');
}

/** 품목 여러 개를 한 박스씩 — ICIS·국제유가처럼 계열이 여럿인 위젯용 */
function matSeriesBoxes(items, unit, digits, krwUnit) {
  return matSum((items || []).map((it) => {
    const s = matStat(it.pts);
    if (!s) return null;
    // krwUnit 을 주면 값 아래에 원화 환산을 한 줄 더 붙인다(달러 표기 위젯용)
    const krw = krwUnit ? krwOf(s.v, krwUnit) : '';
    return {
      label: it.label,
      val: matVal(s.v, unit, digits)
        + (krw ? '<span class="sr-sum__krw">' + escapeHtml(krw) + '</span>' : ''),
      sub: escapeHtml(s.ym) + ' · ' + matChg('전월비', s.mom),
    };
  }));
}

/** 섹션 5 전체 렌더: 업데이트 전 안내 → 업데이트 후 연도 툴바 → 연도 선택 시 그래프 */
function renderMaterial() {
  const root = document.getElementById('materialRoot');
  if (!root) return;
  if (!_matReady) {
    root.innerHTML = emptyState('업데이트 버튼을 누르면 표시됩니다');
    return;
  }
  // 연도 칩은 데이터(ICIS_DATA.periods)에서 뽑는다 — 하드코딩 배열이 아니라서
  // 나중에 2027 데이터가 추가되면 2027 칩이 자동으로 생긴다.
  const icisYears = Array.from(new Set(ICIS_DATA.periods.map((p) => p.slice(0, 4)))).sort();
  const years = icisYears.concat(['all']);
  // 데이터가 비면 칩을 그리지 않는다(빈 툴바가 남아 레이아웃이 뜨는 것 방지).
  const toolbar = icisYears.length
    ? `<div class="icis-years">${years.map((y) =>
      `<button class="icis-year${y === _matYear ? ' is-active' : ''}" data-year="${y}">${y === 'all' ? '전체' : y}</button>`).join('')}</div>`
    : '';

  /* 요약 4박스 — 원료마다 한 칸. 값 자체는 연도와 무관하게 전 구간에서 계산한다
     (전년비를 재려면 12개월이 필요하다). 해상 정시성 위젯과 같은 .sr-sum 을 쓴다.
     ★ 다만 '보여주는' 것은 연도 버튼을 누른 뒤다 — 섹션 공통 규칙(1차 필터를
       직접 고르기 전에는 요약박스까지 아무것도 내지 않는다). */
  const icisSum = matSeriesBoxes(ICIS_SERIES.map((s) => ({
    label: s.key,
    pts: ICIS_DATA.periods.map((p, i) => ({ k: p, v: ICIS_DATA[s.key][i] }))
      .filter((x) => x.v != null),
  })), 'USD/톤');

  let body;
  if (!_matYear) {
    body = '<div class="icis-prompt">연도를 선택하세요</div>';
  } else {
    const { periods, series } = icisViewData(_matYear);
    // 추세 연장은 화면이 데이터 끝까지 닿아 있을 때만 만든다(iiExtend 안에서 판단).
    const ext = iiExtend(periods);
    body = vizUnitCap('USD/톤', 'USD') + buildIcisChart(periods, series, ext)
      + (ext ? '<div class="ii-cap ii-cap--chart">점선 구간은 최근 추세를 단순 연장한 통계적'
        + ' 추정치이며, 실제 시장 예측이 아닙니다. (최근 ' + II_MA_WIN + '개월 이동평균의 기울기를 '
        + II_EXT_MONTHS + '개월 연장 · 음영은 그 추세선에서 벗어난 정도로 잡은 참고 범위)</div>' : '')
      + icisLatest()
      + msFactorsHtml('icis_asia_pu')
      + iiMaterialCards() + iiTimeline() + iiOutlook(ext) + iiImplications()
      + icisTermsTable()
      + renderIcisForecastHtml();  // 순수 추가: 용어표 아래 '다음 달 전망'
  }

  // 순수 추가: KOIMA 요약 한 줄을 맨 앞에 덧붙인다(데이터 없으면 '' → 기존 출력과 동일).
  // 배너의 '업데이트 기준'은 지수의 실제 최신 데이터 월(ICIS_DATA 마지막 period)
  const icisDay = ICIS_DATA.periods[ICIS_DATA.periods.length - 1] || '';
  root.innerHTML = renderKoimaSummaryHtml() + `<div class="viz-root viz-figure icis-figure">
    ${vizHero('flask', '스폰지 주원료 시황 (ICIS Asia)',
      'PPG·TDI·MDI·PO 월별 (USD/톤) → 원료의 월별 시장가격 추이를 보여주는 자료', icisDay)}
    ${_matYear ? icisSum : ''}
    ${toolbar}
    ${body}
    <div class="viz-tooltip" id="icisTooltip"></div>
    <div class="comp-caption">출처: ICIS Asia</div>
  </div>
  ${renderScheduleReliabilityHtml()}
  ${renderXsiHtml()}
  ${renderOilPricesHtml()}
  ${renderOilProductHtml()}
  ${renderKoimaHtml()}
  ${renderKoimaPriceHtml()}`;

  const yearsEl = root.querySelector('.icis-years');
  if (yearsEl) yearsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.icis-year');
    if (!b) return;
    _matYear = b.dataset.year;
    renderMaterial();
  });
  if (_matYear) wireIcisChart();

  const srYearsEl = root.querySelector('.sr-years');
  if (srYearsEl) srYearsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.sr-year');
    if (!b) return;
    _srYear = b.dataset.year;
    renderMaterial();
  });
  if (_srData && !_srData.error) wireSrChart();

  wireOilEraHover(root);     // 순수 추가: 국제유가 구간 카드 ↔ 차트 음영 연동
  wireCrudeControls(root);   // 국제유가(원유): 기준·기간·제품 + [조회]
  wireProductControls(root); // 국제유가(석유제품): 같은 조회 UI

  wireXsi(root);            // 순수 추가: 컨테이너 운임지수(항로 탭·기간 칩·툴팁)
  msWireEvents(root);       // 순수 추가: 변곡점 마커 툴팁(hover·포커스·탭)
  wireKoimaControls(root);  // 순수 추가: KOIMA 부문별 지수 카드
  wireKpControls(root);     // 순수 추가: KOIMA 일일 국제원자재가격 카드
}

/** 4개 원료 월별 선그래프 SVG (null 구간 선 끊김) */
function buildIcisChart(periods, series, ext) {
  const n0 = periods.length;
  if (!n0 || !series.length) return '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
  // ★ 추세 연장 구간을 축 뒤에 이어 붙인다. ext 가 없으면 예전과 똑같이 그려진다.
  const exP = (ext && ext.periods) || [];
  const allPeriods = periods.concat(exP);
  const n = allPeriods.length;
  const singleYear = allPeriods.every((p) => p.slice(0, 4) === allPeriods[0].slice(0, 4));
  // 실측 뒤에 추정치를 이어 붙인 시리즈(툴팁도 이걸 본다)
  const fullSeries = series.map((s) => {
    const e = ext && ext.byKey[s.key];
    return Object.assign({}, s, {
      values: s.values.concat(e ? e.values : exP.map(() => null)),
      band: e ? e.band : null,
    });
  });

  const all = fullSeries.flatMap((s) => s.values).filter((v) => v != null)
    .concat(fullSeries.flatMap((s) => (s.band || []).flatMap((b) => [b.lo, b.hi])));
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.08 || 100; ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 46, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val).toLocaleString('en-US')}</text>${vizKrwTick(padL - 6, y, val, _matUsdKrw)}`;
  }).join('');

  // 단일 연도는 'MM월'(짧음)이라 간격을 좁게, 전체 보기는 'YYYY-MM'이라 넓게
  const xticks = vizTickIdx(n, plotW, singleYear ? 44 : VIZ_TICK_GAP).map((i) => {
    const p = allPeriods[i];
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(singleYear ? p.slice(5) + '월' : p)}</text>`;
  }).join('');

  // 실선은 실측 구간(0 ~ n0-1)만 긋는다
  const lines = series.map((s) => {
    let path = '', pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  // ── ① 추세 연장: 옅은 음영 띠 + 점선. 마지막 실측점에서 이어 그린다. ──
  let extShapes = '';
  if (ext && exP.length) {
    extShapes = fullSeries.map((s) => {
      const e = ext.byKey[s.key];
      if (!e) return '';
      const last = s.values[n0 - 1];
      if (last == null) return '';
      const up = [], dn = [];
      up.push(`${X(n0 - 1).toFixed(1)} ${Y(last).toFixed(1)}`);
      dn.push(`${X(n0 - 1).toFixed(1)} ${Y(last).toFixed(1)}`);
      e.band.forEach((b, k) => {
        up.push(`${X(n0 + k).toFixed(1)} ${Y(b.hi).toFixed(1)}`);
        dn.push(`${X(n0 + k).toFixed(1)} ${Y(b.lo).toFixed(1)}`);
      });
      const poly = up.concat(dn.reverse()).join(' L');
      let d = `M${X(n0 - 1).toFixed(1)} ${Y(last).toFixed(1)} `;
      e.values.forEach((v, k) => { d += `L${X(n0 + k).toFixed(1)} ${Y(v).toFixed(1)} `; });
      return `<path d="M${poly} Z" fill="${s.color}" opacity=".10"/>`
        + `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="1.8"
            stroke-dasharray="4 3" stroke-linejoin="round" opacity=".85"/>`;
    }).join('');
    // 실측과 추정을 가르는 세로선
    const bx = X(n0 - 1).toFixed(1);
    extShapes += `<line x1="${bx}" y1="${padT}" x2="${bx}" y2="${(padT + plotH).toFixed(1)}"
        stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3" opacity=".5"/>`
      + `<text x="${(X(n0 - 1) + 4).toFixed(1)}" y="${(padT + 8).toFixed(1)}" font-size="7.5"
          font-weight="700" fill="var(--muted)" paint-order="stroke" stroke="var(--surface-1)"
          stroke-width="2.5">추세 연장</text>`;
  }

  // 각 데이터 점 표시(실측만 — 추정치에는 점을 찍지 않는다)
  const dots = series.map((s) => s.values.map((v, i) => v == null ? '' :
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1"/>`).join('')).join('');
  // 값 라벨 방침: 차트가 낮아진 뒤 실측하니 4개 시리즈(PPG·TDI·MDI·PO)를 겹쳐 그리는
  // 이 차트는 12개월 보기에서도 라벨이 서로 겹쳤다(2022년 6쌍, 2023년 4쌍).
  // → 시리즈가 1개일 때만 라벨을 남기고, 그 외에는 툴팁으로만 값을 보여준다.
  const labels = (singleYear && n <= VIZ_LABEL_MAX_PTS && series.length === 1) ? series.map((s, si) => s.values.map((v, i) => {
    if (v == null) return '';
    const x = X(i), y = Y(v);
    let ly = (si % 2 === 0) ? y - 6 : y + 11;
    if (ly < padT + 7) ly = y + 11;
    if (ly > padT + plotH) ly = y - 6;
    return `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_LABEL}" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${s.color}">${Math.round(v).toLocaleString('en-US')}</text>`;
  }).join('')).join('') : '';

  // 범례 항목만 만들고 감싸는 것은 return 에서 한 번만 한다(예전엔 여기서 감쌌다)
  const legend = series.map((s) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${s.color}"></span>${s.key}</span>`).join('')
    + (ext && exP.length ? `<span class="viz-legend__item ii-legend-ext"><span class="ii-legend-dash"></span>추세 연장(추정)</span>` : '');
  // 툴팁은 늘어난 축 전체를 본다. extFrom 뒤는 추정치라고 밝힌다.
  _icisChart = { periods: allPeriods, series: fullSeries, extFrom: n0, geom: { X, Y, n, W, padL } };

  return `<div class="viz-legend">${legend}</div>
    <svg class="viz-svg icis-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="스폰지 주원료 시황">
      ${grid}${xticks}${extShapes}${lines}${dots}${labels}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="icis-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="icis-dots"></g>
      <rect class="icis-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
      ${msEventsSvg('icis_asia_pu', periods, X, padT, plotH, W)}
    </svg>`;
}

/** 최신값 병기 (USD/톤 → ≈ 원/톤) + 적용 환율 */
/** 순수 추가: 적용 환율의 기준일(YYYY-MM-DD). _fx.series 의 마지막 유효 USD 값 날짜.
 *  usd_krw 섹션에는 날짜가 없어(rate 만 옴) 같은 값을 주는 _fx 에서 날짜만 빌려온다.
 *  ★ 환율 값·원화 환산 계산에는 관여하지 않는다(표기용). 없으면 null. */
function fxAsOfDate() {
  try {
    const s = (typeof fxSeries === 'function') ? fxSeries() : (_fx && _fx.series);
    if (!s || !Array.isArray(s.dates) || !Array.isArray(s.USD)) return null;
    for (let i = s.USD.length - 1; i >= 0; i--) {
      if (s.USD[i] != null) return s.dates[i] || null;
    }
  } catch (e) { /* 표기용이라 실패해도 무시 */ }
  return null;
}

function icisLatest() {
  const rate = _matUsdKrw;
  // ★ 선택된 연도 칩과 무관하게 '전체 데이터'의 최신값을 쓴다.
  //   예전에는 연도로 잘린 series 를 받아 2021 칩에서 2021-12 값이 나왔고,
  //   라벨('최신값')과 동작이 어긋났다. 아래 예측 섹션의 '최신 데이터' 표기와도
  //   이제 같은 기준(전체 마지막 월)을 가리킨다.
  const full = icisViewData('all');
  const periods = full.periods;
  // 값과 함께 '몇 번째 월의 값인지'(idx)도 잡아 둔다 — 기준 연월 표기용.
  const items = full.series.map((s) => {
    for (let i = s.values.length - 1; i >= 0; i--) {
      if (s.values[i] != null) return { key: s.key, color: s.color, v: s.values[i], idx: i };
    }
    return null;
  }).filter(Boolean);
  if (!items.length) return '';
  // 원료별로 마지막 값의 월이 다를 수 있어(PO 결측 구간) 가장 늦은 월을 기준으로 표기한다.
  const asOf = periods[Math.max.apply(null, items.map((it) => it.idx))] || null;
  const rows = items.map((it) => {
    const krw = (rate != null) ? ` <span class="icis-krw">≈ 약 ${escapeHtml(fmtKrwShort(it.v * rate))}/톤</span>` : '';
    return `<span class="icis-latest__item"><span class="icis-dot" style="background:${it.color}"></span><b>${it.key}</b> ${it.v.toLocaleString('en-US')} USD/톤${krw}</span>`;
  }).join('');
  // 두 기준을 한 줄에 나란히 두면 어느 게 무엇의 기준인지 안 드러난다.
  // → 헤드에는 '데이터 기준월'만, 환율 기준은 아랫줄에 작게 분리한다.
  const fxDate = fxAsOfDate();
  const fxNote = (rate != null)
    ? `<div class="icis-fxnote">원화 환산은 1 USD = ${Math.round(rate).toLocaleString('ko-KR')}원${fxDate ? ` (${escapeHtml(fxDate)})` : ''} 적용</div>` : '';
  const asOfNote = asOf ? `<span class="icis-asof">· ${escapeHtml(asOf)}</span>` : '';
  return `<div class="icis-latest">
    <div class="icis-latest__head">최신값 ${asOfNote}</div>
    <div class="icis-latest__row">${rows}</div>
    ${fxNote}
  </div>`;
}

/** 원료 용어 설명표 (색 점 매칭) */
function icisTermsTable() {
  const rows = ICIS_TERMS.map((t) =>
    `<tr><td class="icis-term__var"><span class="icis-dot" style="background:${t.color}"></span>${t.key}</td>
      <td>${escapeHtml(t.full)}</td><td>${escapeHtml(t.use)}</td></tr>`).join('');
  return `<div class="icis-terms">
    <h3 class="subhead">원료 용어 설명</h3>
    <div class="icis-term-wrap"><table class="icis-termtable">
      <thead><tr><th>변수</th><th>의미</th><th>용도</th></tr></thead><tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

/** 순수 추가: 용어표 아래 '다음 달 전망'. 예측 데이터 없으면 '' 반환(섹션 숨김).
 *  숫자는 백엔드가 계산(_icisForecast), 문장(comment/summary/caution)만 AI. 기존 환율값(_matUsdKrw) 참조. */
function renderIcisForecastHtml() {
  const fc = _icisForecast;
  if (!fc || !Array.isArray(fc.materials) || !fc.materials.some((m) => m && m.status === 'ok')) return '';
  const rate = _matUsdKrw;  // 기존 환율 값만 참조(기존 코드 미변경)
  const rcls = (r) => (r === '상방' ? 'up' : (r === '하방' ? 'down' : 'flat'));
  const num = (v) => Number(v).toLocaleString('en-US');
  const moLabel = (ym) => (ym ? `${parseInt(String(ym).slice(5, 7), 10)}월` : '');
  const cards = fc.materials.map((m) => {
    const color = m.color || 'var(--slate)';
    const head = `<div class="icis-fc__head"><span class="icis-dot" style="background:${color}"></span><b>${escapeHtml(m.code)}</b>`;
    if (m.status !== 'ok') {
      return `<div class="icis-fc__card">${head}</div>
        <div class="icis-fc__na">데이터 부족</div>
        <div class="icis-fc__reason">${escapeHtml(m.reason || '')}</div></div>`;
    }
    const krw = (rate != null) ? ` <span class="icis-krw">≈ ${escapeHtml(fmtKrwShort(m.predict * rate))}/톤</span>` : '';
    const d = m.delta, dp = m.delta_pct;
    const dcls = d > 0 ? 'up' : (d < 0 ? 'down' : 'flat');
    const arrow = d > 0 ? '▲' : (d < 0 ? '▼' : '–');
    const prevLbl = m.prev_month ? `${escapeHtml(m.prev_month)} 실측 ${num(m.prev)}` : `직전월 ${num(m.prev)}`;
    const path = (Array.isArray(m.path) && m.path.length > 1)
      ? `<div class="icis-fc__path">${m.path.map((p) => `${moLabel(p.ym)} ${num(p.value)}`).join(' → ')} (추정)</div>`
      : '';
    return `<div class="icis-fc__card">
      ${head}<span class="icis-fc__risk ${rcls(m.risk)}">${escapeHtml(m.risk)}</span></div>
      <div class="icis-fc__val">${num(m.predict)} <span class="icis-fc__unit">USD/톤</span>${krw}</div>
      <div class="icis-fc__delta ${dcls}">${arrow} ${num(Math.abs(d))} (${Math.abs(dp).toFixed(1)}%) <span class="icis-fc__prev">${prevLbl} 대비</span></div>
      ${path}
      <div class="icis-fc__ci">신뢰구간 ${num(m.ci_low)} ~ ${num(m.ci_high)}</div>
      ${m.comment ? `<div class="icis-fc__cmt">${escapeHtml(m.comment)}</div>` : ''}
    </div>`;
  }).join('');
  const gen = fc.generated_at ? `<span class="icis-fc__gen">예측 생성 ${escapeHtml(fc.generated_at)}</span>` : '';
  const sub = fc.last_data_month
    ? `<div class="icis-fc__sub">최신 데이터 ${escapeHtml(fc.last_data_month)} 기준 · ${Number(fc.months_ahead || 1)}개월 후 추정</div>`
    : '';
  const sum = fc.summary ? `<div class="icis-fc__summary">${escapeHtml(fc.summary)}</div>` : '';
  const cau = fc.caution ? `<div class="icis-fc__caution">⚠ ${escapeHtml(fc.caution)}</div>` : '';
  return `<div class="icis-fc">
    <h3 class="subhead icis-fc__title">다음 달 전망 <span class="icis-fc__month">(${escapeHtml(fc.target_month || '')} 예측)</span>${gen}</h3>
    ${sub}
    <div class="icis-fc__grid">${cards}</div>
    ${sum}${cau}
    <div class="icis-fc__disc">통계적 추세 기반 참고용 추정치이며 실제 시황과 다를 수 있습니다. 구매 의사결정의 유일한 근거로 사용하지 마세요.</div>
  </div>`;
}

/** 크로스헤어 + 툴팁 (월 · 원료별 USD/톤 및 원화 환산) */
function wireIcisChart() {
  const fig = document.querySelector('#materialRoot .icis-figure');
  const tip = document.getElementById('icisTooltip');
  if (!fig || !tip || !_icisChart) return;
  const svg = fig.querySelector('.icis-svg');
  const overlay = svg.querySelector('.icis-overlay');
  const cross = svg.querySelector('.icis-cross');
  const dots = svg.querySelector('.icis-dots');
  const c = _icisChart, g = c.geom, rate = _matUsdKrw;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      const krw = (rate != null) ? ` (≈ ${fmtKrwShort(v * rate)}/톤)` : '';
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${s.key}</span><span class="viz-tt-val">${v.toLocaleString('en-US')} USD/톤${krw}</span></div>`;
    });
    dots.innerHTML = dh;
    // 추세 연장 구간에 올라가면 추정치라고 밝힌다
    const isExt = (c.extFrom != null && i >= c.extFrom);
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.periods[i])}`
      + (isExt ? '<span class="ii-tt-ext">추세 연장 추정치</span>' : '') + `</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 조회 조건 조작 + [조회] + 표/차트 전환 + 내보내기 배선.
    ★ 조건을 만져도 결과는 그대로다 — [조회]를 눌러야 _ocQuery 가 바뀐다(실제 사이트와 동일).
    ★ 기준(term)을 바꾸면 고를 수 있는 연도와 기본 기간이 달라지므로 '조건 영역만'
      다시 그린다. 결과 영역은 건드리지 않는다(아직 조회한 것이 아니므로). */
function wireCrudeControls(root) {
  const fig = root.querySelector('.oil-figure');
  if (!fig || !_ocData || _ocData.error) return;
  const form = fig.querySelector('.oc-formwrap');

  if (form) {
    form.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !_ocForm) return;
      if (t.name === 'ocTerm') {
        _ocForm = ocFormFor(t.value, new Set(_ocForm.on));
        form.innerHTML = ocControlsHtml();
        return;
      }
      const k = t.getAttribute && t.getAttribute('data-oc');
      if (k) {
        _ocForm[k] = t.value;
      } else {
        const p = t.getAttribute && t.getAttribute('data-oc-prod');
        if (!p) return;
        if (t.checked) _ocForm.on.add(p); else _ocForm.on.delete(p);
      }
    });
    form.addEventListener('click', (e) => {
      const go = e.target.closest && e.target.closest('.oc-go');
      if (!go || !_ocForm) return;
      _ocQuery = { term: _ocForm.term, y0: _ocForm.y0, m0: _ocForm.m0,
        y1: _ocForm.y1, m1: _ocForm.m1, on: new Set(_ocForm.on) };
      renderMaterial();
    });
  }

  fig.addEventListener('click', (e) => {
    const v = e.target.closest && e.target.closest('[data-oc-view]');
    if (v) { _ocView = v.getAttribute('data-oc-view'); renderMaterial(); return; }
    const x = e.target.closest && e.target.closest('[data-oc-exp]');
    if (!x || !_ocQuery) return;
    const win = ocWindow(_ocQuery);
    const kind = x.getAttribute('data-oc-exp');
    if (kind === 'csv') ocExportCsv(_ocQuery, win);
    else if (kind === 'xls') ocExportXls(_ocQuery, win);
    else ocPrint(_ocQuery, win);
  });

  if (_ocQuery && _ocView === 'chart') wireOilChart();
}

/* ── 국제유가 (PETRONET 일일국제제품가격) ─────────────────────────────────
   원유 카드(oc*)와 같은 UI 패턴이다: 기준선택 → 기간 → 제품 → [조회].

   ★ 원유 카드의 함수를 재사용하지 않고 op* 로 따로 뒀다. oc* 는 _ocData/_ocQuery
     전역을 직접 읽어서, 공통화하려면 원유 카드를 고쳐야 한다. 두 카드가 서로를
     깨뜨리지 않게 이 저장소의 관례대로 '중복을 허용'한다.
     화면 스타일(.oc-*)은 그대로 함께 쓴다 — 모양은 같아야 하므로.
   ★ 제품은 기간을 '일' 단위까지 고른다(기준이 일일 때 연-월-일 드롭다운 세 쌍).
   ★ 요약행 계산 규칙은 원유에서 PETRONET 값과 대조해 확정한 것과 같다. */
const OP_COLORS = {
  gasoline95: '#C8102E', gasoline92: '#F97316', kerosene: '#F59E0B',
  diesel05: '#84CC16', diesel005: '#12B981', diesel0001: '#06B6D4',
  hsfo180: '#3B82F6', hsfo380: '#8B5CF6', naphtha: '#64748B',
};
const OP_DEFAULT_SPAN = { y: null, m: 12, w: 3, d: 1 };   // 기본 조회 폭(개월)
// 체크박스 라벨 옆 짧은 설명 — 라벨의 숫자가 '무슨 뜻인지'를 적는다(숫자를 되풀이하지 않는다).
// ★ 뜻풀이 근거는 PETRONET 조회 페이지 각주다: RON=옥탄가 · cst=동점도(센티스톡) 단위 ·
//   경유 0.5% 는 2012년 12월 1일 게시 중단(그 자리를 경유 0.001%(10ppm)이 대신한다).
// ★ 원유 카드와 같이, 조회 조건의 체크박스에만 쓴다. 표 머리·범례·CSV 는
//   payload 의 series.label 을 그대로 써야 하므로 건드리지 않는다.
const OP_ORIGIN = {
  gasoline95: '옥탄가(RON) 95 · 고옥탄 등급',
  gasoline92: '옥탄가(RON) 92 · 표준 등급',
  kerosene: '난방유 · 항공유 계열',
  diesel05: '황 함량 5,000ppm · 2012년 게시 중단',
  diesel005: '황 함량 500ppm',
  diesel0001: '황 함량 10ppm · 초저황',
  hsfo180: '선박 연료유 · cst는 점도 단위',
  hsfo380: '선박 연료유 · 180cst보다 점도 높음',
  naphtha: '석유화학 기초원료',
};

let _opData = null;     // sections.oil_product
let _opForm = null;     // 사용자가 만지는 중인 조건
let _opQuery = null;    // [조회]로 확정된 조건
let _opView = 'table';  // 'table' | 'chart'
let _opChart = null;    // 차트 크로스헤어·툴팁 상태(원유와 분리)

function opTerm(t) {
  const d = _opData;
  return (d && !d.error && d.terms && d.terms[t]) || null;
}

/** 기간 비교 키 — 일 기준만 '일'까지 본다 */
function opKey(period, term) {
  const p = String(period);
  if (term === 'y') return p.slice(0, 4);
  if (term === 'd') return p.slice(0, 10);
  return p.slice(0, 7);
}

function opLabel(period, term) {
  const p = String(period);
  if (term === 'y') return p + '년';
  if (term === 'm') return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월';
  if (term === 'w') return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월 ' + p.split('W')[1] + '주';
  return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월 ' + p.slice(8, 10) + '일';
}

function opYears(term) {
  const t = opTerm(term);
  if (!t) return [];
  return Array.from(new Set(t.rows.map((r) => String(r.period).slice(0, 4)))).sort();
}

/** 기본 기간 — 마지막 데이터에서 OP_DEFAULT_SPAN 만큼 거슬러 연다 */
function opDefaultSpan(term) {
  const t = opTerm(term);
  if (!t || !t.rows.length) return null;
  const last = t.rows[t.rows.length - 1].period, first = t.rows[0].period;
  const p2 = (n) => String(n).padStart(2, '0');
  if (term === 'y') {
    return { y0: first.slice(0, 4), m0: '01', d0: '01', y1: last.slice(0, 4), m1: '12', d1: '31' };
  }
  const y1 = Number(last.slice(0, 4)), m1 = Number(last.slice(5, 7));
  const span = OP_DEFAULT_SPAN[term] || 12;
  let y0 = y1, m0 = m1 - span + 1;
  while (m0 <= 0) { y0 -= 1; m0 += 12; }
  const fy = Number(first.slice(0, 4)), fm = Number(first.slice(5, 7));
  if (y0 < fy || (y0 === fy && m0 < fm)) { y0 = fy; m0 = fm; }
  return { y0: String(y0), m0: p2(m0), d0: '01',
    y1: String(y1), m1: p2(m1), d1: (term === 'd' ? last.slice(8, 10) : '31') };
}

function opFormFor(term, keepOn) {
  const sp = opDefaultSpan(term) || { y0: '', m0: '01', d0: '01', y1: '', m1: '12', d1: '31' };
  return { term: term, y0: sp.y0, m0: sp.m0, d0: sp.d0, y1: sp.y1, m1: sp.m1, d1: sp.d1,
    on: keepOn || new Set((_opData && _opData.default_on) || []) };
}

function opWindow(q) {
  const t = opTerm(q.term);
  if (!t) return [];
  let a, b;
  if (q.term === 'y') { a = q.y0; b = q.y1; }
  else if (q.term === 'd') { a = q.y0 + '-' + q.m0 + '-' + q.d0; b = q.y1 + '-' + q.m1 + '-' + q.d1; }
  else { a = q.y0 + '-' + q.m0; b = q.y1 + '-' + q.m1; }
  const lo = a <= b ? a : b, hi = a <= b ? b : a;
  return t.rows.filter((r) => {
    const k = opKey(r.period, q.term);
    return k >= lo && k <= hi;
  });
}

function opOnSeries(q) {
  const d = _opData;
  if (!d || d.error) return [];
  return (d.series || []).filter((s) => q.on.has(s.key))
    .map((s) => ({ key: s.key, label: s.label, color: OP_COLORS[s.key] || 'var(--slate)' }));
}

/* 요약행 — 규칙은 원유 카드와 같다(PETRONET 값과 대조해 확정).
   비교 대상은 '받아둔 전 구간'에서 찾는다 — 조회 창 밖의 과거가 필요하다. */
function opShift(iso, dy, dm, dd) {
  const Y = Number(iso.slice(0, 4)), M = Number(iso.slice(5, 7)), D = Number(iso.slice(8, 10));
  let yy = Y + (dy || 0), mm = M + (dm || 0);
  yy += Math.floor((mm - 1) / 12);
  mm = ((mm - 1) % 12 + 12) % 12 + 1;
  const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const t = new Date(Date.UTC(yy, mm - 1, Math.min(D, dim)));
  t.setUTCDate(t.getUTCDate() + (dd || 0));
  return t.toISOString().slice(0, 10);
}

function opAtOrBefore(rows, target) {
  let hit = null;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].period <= target) hit = rows[i]; else break;
  }
  return hit;
}

function opSummaryRows(q, win) {
  const t = opTerm(q.term);
  if (!t || !win.length) return [];
  const all = t.rows, last = win[win.length - 1];
  const i = all.indexOf(last);
  const keys = opOnSeries(q).map((s) => s.key);
  const back = (n) => ((i - n >= 0) ? all[i - n] : null);
  const find = (p) => all.filter((r) => r.period === p)[0] || null;
  const out = [];
  const push = (label, prev) => {
    const vals = {};
    keys.forEach((k) => {
      vals[k] = (!prev || last[k] == null || prev[k] == null)
        ? null : Math.round((last[k] - prev[k]) * 100) / 100;
    });
    out.push({ label: label, vals: vals, kind: 'delta' });
  };
  const p = String(last.period);
  if (q.term === 'd') {
    push('전일비', back(1));
    push('전주비', opAtOrBefore(all, opShift(p, 0, 0, -7)));
    push('전월동일비', opAtOrBefore(all, opShift(p, 0, -1, 0)));
    push('전년동일비', opAtOrBefore(all, opShift(p, -1, 0, 0)));
  } else if (q.term === 'm') {
    push('전월비', back(1));
    push('전년동월비', find((Number(p.slice(0, 4)) - 1) + '-' + p.slice(5, 7)));
  } else if (q.term === 'w') {
    push('전주비', back(1));
    push('전월동주비', back(4));
    push('전년동주비', find((Number(p.slice(0, 4)) - 1) + '-' + p.slice(5, 7) + '-W' + p.split('W')[1]));
  } else {
    push('전년비', back(1));
  }
  const avg = {};
  keys.forEach((k) => {
    const v = win.map((r) => r[k]).filter((x) => x != null);
    avg[k] = v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
  });
  out.push({ label: '평균', vals: avg, kind: 'avg' });
  return out;
}

function opNum(v) { return (v == null) ? '-' : Number(v).toFixed(2); }

/** 배럴당 USD → 원화 보조 표기. 환율이 없으면 null(→ 달러만 보인다).
    ★ 톤당 원료가와 자릿수가 달라 fmtKrwShort 를 쓰지 않는다.
      1만 원 이상은 '14.7만'(만 단위 소수 1자리), 그 미만은 '9,853'(원 단위 전체).
    ★ 환율·기준일은 이미 있는 krwRate/krwAsOf 를 그대로 쓴다(usd_krw 섹션 = ECB 기반
      Frankfurter, 키 불필요·매일 자동 수집). 여기서 새로 수집하지 않는다. */
function opKrw(usd) {
  const rate = krwRate('USD');
  if (rate == null || usd == null || !isFinite(Number(usd))) return null;
  const w = Number(usd) * rate, sign = w < 0 ? '-' : '', a = Math.abs(w);
  return (a >= 1e4) ? (sign + (a / 1e4).toFixed(1) + '만 원')
    : (sign + Math.round(a).toLocaleString('ko-KR') + '원');
}

/** 표 셀 안쪽 — 달러 값 아래 작은 글씨로 원화. 환율이 없으면 달러만 남는다. */
function opCell(v) {
  const k = opKrw(v);
  return '<span class="op-usd">' + opNum(v) + '</span>'
    + (k ? '<span class="op-krw">≈ ' + escapeHtml(k) + '</span>' : '');
}

/** 기준선택 · 기간(연-월-일) · 제품 · [조회] */
function opControlsHtml() {
  const f = _opForm;
  if (!f) return '';
  const sel = (name, val, opts) => '<select class="oc-sel" data-op="' + name + '">'
    + opts.map((o) => '<option value="' + escapeHtml(o[0]) + '"'
      + (String(o[0]) === String(val) ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>').join('')
    + '</select>';
  const yOpts = opYears(f.term).map((y) => [y, y + '년']);
  const two = (n) => String(n).padStart(2, '0');
  const mOpts = Array.from({ length: 12 }, (_, i) => [two(i + 1), two(i + 1) + '월']);
  const dOpts = Array.from({ length: 31 }, (_, i) => [two(i + 1), two(i + 1) + '일']);
  const showM = f.term !== 'y', showD = f.term === 'd';

  const terms = OC_TERMS.map((t) => '<label class="oc-radio">'
    + '<input type="radio" name="opTerm" value="' + t[0] + '"'
    + (f.term === t[0] ? ' checked' : '') + '>' + escapeHtml(t[1]) + '</label>').join('');
  const prods = ((_opData && _opData.series) || []).map((s) => '<label class="oc-check oc-check--origin">'
    + '<input type="checkbox" data-op-prod="' + escapeHtml(s.key) + '"'
    + (f.on.has(s.key) ? ' checked' : '') + '>'
    + '<span class="oc-swatch" style="background:' + (OP_COLORS[s.key] || 'var(--slate)') + '"></span>'
    + '<span class="oc-name">' + escapeHtml(s.label) + '</span>'
    + (OP_ORIGIN[s.key] ? '<span class="oc-note">(' + escapeHtml(OP_ORIGIN[s.key]) + ')</span>' : '')
    + '</label>').join('');

  return '<div class="oc-form">'
    + '<div class="oc-row"><span class="oc-lab">기준선택</span><div class="oc-ctl">' + terms + '</div></div>'
    + '<div class="oc-row"><span class="oc-lab">기간</span><div class="oc-ctl">'
    + sel('y0', f.y0, yOpts) + (showM ? sel('m0', f.m0, mOpts) : '') + (showD ? sel('d0', f.d0, dOpts) : '')
    + '<span class="oc-tilde">~</span>'
    + sel('y1', f.y1, yOpts) + (showM ? sel('m1', f.m1, mOpts) : '') + (showD ? sel('d1', f.d1, dOpts) : '')
    + '</div></div>'
    + '<div class="oc-row"><span class="oc-lab">제품</span><div class="oc-ctl oc-ctl--wrap">' + prods + '</div></div>'
    + '<div class="oc-row oc-row--go"><span class="oc-lab"></span>'
    + '<div class="oc-ctl"><button type="button" class="oc-go op-go">조회</button></div></div>'
    + '</div>';
}

function opSpanText(q, win) {
  if (!win.length) return '';
  return opLabel(win[0].period, q.term) + ' ~ ' + opLabel(win[win.length - 1].period, q.term);
}

function opTableHtml(q, win) {
  const ser = opOnSeries(q);
  if (!ser.length) return '<div class="chart-empty">제품을 하나 이상 선택하고 [조회]를 누르세요.</div>';
  if (!win.length) return '<div class="chart-empty">선택한 기간에 데이터가 없습니다.</div>';
  const ext = {};
  ser.forEach((s) => {
    const v = win.map((r) => r[s.key]).filter((x) => x != null);
    ext[s.key] = v.length ? { lo: Math.min.apply(null, v), hi: Math.max.apply(null, v) } : null;
  });
  const head = '<tr><th class="oc-th-p">' + escapeHtml(opTerm(q.term).label) + '</th>'
    + ser.map((s) => '<th><span class="oc-swatch" style="background:' + s.color + '"></span>'
      + escapeHtml(s.label) + '</th>').join('') + '</tr>';
  const body = win.map((r) => '<tr><td class="oc-td-p">' + escapeHtml(opLabel(r.period, q.term)) + '</td>'
    + ser.map((s) => {
      const v = r[s.key], e = ext[s.key];
      let cls = '';
      if (v != null && e && e.lo !== e.hi) cls = (v === e.lo) ? ' oc-min' : (v === e.hi ? ' oc-max' : '');
      return '<td class="oc-num' + cls + '">' + opCell(v) + '</td>';
    }).join('') + '</tr>').join('');
  const sums = opSummaryRows(q, win).map((s) => '<tr class="oc-sum oc-sum--' + s.kind + '">'
    + '<td class="oc-td-p">' + escapeHtml(s.label) + '</td>'
    + ser.map((x) => {
      const v = s.vals[x.key];
      const sign = (s.kind === 'delta' && v != null && v > 0) ? '+' : '';
      const cls = (s.kind !== 'delta' || v == null) ? '' : (v > 0 ? ' oc-up' : (v < 0 ? ' oc-down' : ''));
      if (v == null) return '<td class="oc-num' + cls + '">-</td>';
      // ★ 원화도 달러와 같은 sign 을 쓴다 — 평균 행에 '+' 가 붙지 않게.
      const kw = opKrw(v);
      return '<td class="oc-num' + cls + '"><span class="op-usd">' + sign + opNum(v) + '</span>'
        + (kw ? '<span class="op-krw">≈ ' + sign + escapeHtml(kw) + '</span>' : '')
        + '</td>';
    }).join('') + '</tr>').join('');
  return '<div class="oc-tablewrap"><table class="oc-table">'
    + '<thead>' + head + '</thead><tbody>' + body + sums + '</tbody></table></div>';
}

function opMatrix(q, win) {
  const ser = opOnSeries(q);
  const rows = [[opTerm(q.term).label].concat(ser.map((s) => s.label))];
  win.forEach((r) => rows.push([opLabel(r.period, q.term)].concat(ser.map((s) => opNum(r[s.key])))));
  opSummaryRows(q, win).forEach((s) => rows.push([s.label].concat(ser.map((x) => {
    const v = s.vals[x.key];
    return v == null ? '-' : ((s.kind === 'delta' && v > 0 ? '+' : '') + opNum(v));
  }))));
  return rows;
}

function opFileName(q, ext) {
  const a = q.y0 + (q.term === 'y' ? '' : q.m0) + (q.term === 'd' ? q.d0 : '');
  const b = q.y1 + (q.term === 'y' ? '' : q.m1) + (q.term === 'd' ? q.d1 : '');
  return '국제제품가_' + opTerm(q.term).label + '_' + a + '-' + b + '.' + ext;
}

function opExportCsv(q, win) {
  const csv = opMatrix(q, win)
    .map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  ocSave(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), opFileName(q, 'csv'));
}

function opExportXls(q, win) {
  const rows = opMatrix(q, win);
  const tbl = '<table border="1">' + rows.map((r, i) => '<tr>'
    + r.map((c) => (i ? '<td>' : '<th>') + escapeHtml(c) + (i ? '</td>' : '</th>')).join('')
    + '</tr>').join('') + '</table>';
  const html = '<html><head><meta charset="utf-8"></head><body>'
    + '<h3>국제유가 (PETRONET 일일국제제품가격) · ' + escapeHtml(opSpanText(q, win))
    + ' · 단위 ' + escapeHtml((_opData && _opData.unit) || '$/배럴') + '</h3>'
    + tbl + '</body></html>';
  ocSave(new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' }),
    opFileName(q, 'xls'));
}

function opPrint(q, win) {
  const rows = opMatrix(q, win);
  const tbl = '<table>' + rows.map((r, i) => '<tr>'
    + r.map((c) => (i ? '<td>' : '<th>') + escapeHtml(c) + (i ? '</td>' : '</th>')).join('')
    + '</tr>').join('') + '</table>';
  const w = window.open('', '_blank');
  if (!w) { window.alert('팝업이 차단되어 인쇄 창을 열지 못했습니다.'); return; }
  w.document.write('<html><head><meta charset="utf-8"><title>국제제품가 (PETRONET)</title>'
    + '<style>body{font-family:sans-serif;padding:20px}h3{margin:0 0 4px}'
    + 'p{margin:0 0 12px;color:#555;font-size:12px}table{border-collapse:collapse;font-size:12px}'
    + 'th,td{border:1px solid #999;padding:4px 8px;text-align:right}'
    + 'th:first-child,td:first-child{text-align:left}</style></head><body>'
    + '<h3>국제유가 (PETRONET 일일국제제품가격)</h3><p>' + escapeHtml(opSpanText(q, win))
    + ' · 단위 ' + escapeHtml((_opData && _opData.unit) || '$/배럴')
    + ' · 출처 한국석유공사 PETRONET</p>' + tbl + '</body></html>');
  w.document.close(); w.focus(); w.print();
}

/** 제품 선그래프 — 원유 차트와 같은 모양이지만 상태(_opChart)를 따로 둔다 */
function buildProductChart(rows, onSeries, term, hOpt) {
  const n = rows.length;
  if (!n) { _opChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const series = (onSeries || []).map((s) => ({
    key: s.key, label: s.label, color: s.color || 'var(--slate)',
    values: rows.map((r) => (r[s.key] == null ? null : r[s.key])),
  }));
  const periods = rows.map((r) => opLabel(r.period, term));
  if (!series.length) { _opChart = null; return '<div class="chart-empty">제품을 하나 이상 선택하세요.</div>'; }
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { _opChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
  const yp = (ymax - ymin) * 0.1 || 5; ymin = Math.max(0, ymin - yp); ymax += yp;

  // ★ 뷰박스 높이만 이 차트에서 늘린다. 공용 VIZ_H(158)를 바꾸면 대시보드의
  //   차트 전부가 같이 커진다 — 여기만 hOpt 로 받는다.
  //   SVG 는 width:100% + preserveAspectRatio 라 실제 높이가 '폭 × H/W' 로 정해진다.
  //   그래서 표(8개 제품, 약 290px)와 키를 맞추려면 이 비율을 키우는 수밖에 없다.
  const W = VIZ_W, H = (hOpt && isFinite(hOpt)) ? hOpt : VIZ_H;
  const padL = 42, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">$${Math.round(val)}</text>${vizKrwTick(padL - 6, y, val, krwRate('USD'))}`;
  }).join('');
  const xticks = vizTickIdx(n, plotW).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(periods[i])}</text>`;
  }).join('');
  const lines = series.map((s) => {
    let d = '', started = false;
    s.values.forEach((v, i) => {
      if (v == null) return;
      d += `${started ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; started = true;
    });
    return d ? `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  _opChart = { periods, series, geom: { X, Y, n, W, padL } };
  const legend = '<div class="viz-legend">' + series.map((s) =>
    '<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:'
    + s.color + '"></span>' + escapeHtml(s.label) + '</span>').join('') + '</div>';
  return legend + `<svg class="viz-svg oilp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="국제제품가 추이">
      ${grid}${xticks}${lines}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="oilp-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="oilp-dots"></g>
      <rect class="oilp-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
      ${msEventsSvg('oil_price', rows.map((r) => r.period), X, padT, plotH, W)}
    </svg>`;
}

/** 제품 차트 크로스헤어 + 툴팁(원유 차트와 분리된 DOM·상태) */
function wireProductChart() {
  const fig = document.querySelector('#materialRoot .oilp-figure');
  const tip = document.getElementById('oilpTooltip');
  if (!fig || !tip || !_opChart) return;
  const svg = fig.querySelector('.oilp-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.oilp-overlay');
  const cross = svg.querySelector('.oilp-cross');
  const dots = svg.querySelector('.oilp-dots');
  const c = _opChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      const kw = opKrw(v);
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${escapeHtml(s.label)}</span><span class="viz-tt-val">$${v.toFixed(2)}${kw ? ` <span class="op-krw op-krw--tt">≈ ${escapeHtml(kw)}</span>` : ''}</span></div>`;
    });
    if (!rows) { clear(); return; }
    dots.innerHTML = dh;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.periods[i])}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 균등 간격으로 최대 max 개만 고른다(양 끝은 항상 포함).
    ★ 원유·석유제품 차트가 X축 눈금을 솎아낼 때 쓴다. */
function orTickIdx(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (let k = 0; k < max; k += 1) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return out.filter((v, i, a) => a.indexOf(v) === i);
}

/** 리포트 전용 그래프. 라벨은 대표 계열의 최고·최저·최근 3곳에만 단다.
    ★ 카드 본문의 buildOilChart / buildProductChart 는 건드리지 않는다. */
function renderOilProductHtml() {
  const unit = (_opData && !_opData.error && _opData.unit) || '$/배럴';
  // 배너의 '데이터 기준'은 대표 제품의 마지막 관측월(수집 시각이 아니다)
  const opPts = msPtsPetro(_opData, OILP_BASE_KEY);
  const opDay = opPts.length ? opPts[opPts.length - 1].k : '';
  const head = vizHero('fuel', '국제유가·석유제품 (PETRONET)',
    (_oilpIns && _oilpIns.hero && _oilpIns.hero.subtitle) || '', opDay, null, '데이터 기준')
    + `<div class="viz-head"><div>
      <div class="viz-sub">일일국제제품가격 · 휘발유·등유·경유·중유·나프타 (${escapeHtml(unit)})</div>
    </div></div>`
    // ★ 대표제품 4카드 + 인사이트 카드는 [조회] 뒤에만 낸다(섹션 공통 규칙)
    + (_opQuery ? oilpLead() : '');
  const cap = capSrc('출처: 한국석유공사 PETRONET · 일일국제제품가격', SRC_LINKS.oilProduct);
  if (!_opData) {
    return `<div class="viz-root viz-figure oilp-figure">${head}`
      + '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>' + `${cap}</div>`;
  }
  if (_opData.error) {
    return `<div class="viz-root viz-figure oilp-figure">${head}`
      + '<div class="chart-empty">데이터를 불러오지 못했습니다 (PETRONET 접근 차단 가능)</div>'
      + `${cap}</div>`;
  }
  const controls = '<div class="oc-formwrap op-formwrap">' + opControlsHtml() + '</div>';
  let body;
  if (!_opQuery) {
    body = '<div class="icis-prompt">기준·기간·제품을 고르고 [조회]를 누르세요</div>';
  } else {
    const q = _opQuery, win = opWindow(q);
    const tools = '<div class="oc-result__head">'
      + '<div class="oc-span">' + escapeHtml(opSpanText(q, win))
      + ' <span class="oc-unit">(단위: ' + escapeHtml(unit) + ')</span></div>'
      + '<div class="oc-tools">'
      + '<button type="button" class="oc-tool' + (_opView === 'table' ? ' is-on' : '') + '" data-op-view="table">표보기</button>'
      + '<button type="button" class="oc-tool' + (_opView === 'chart' ? ' is-on' : '') + '" data-op-view="chart">차트보기</button>'
      + '<button type="button" class="oc-tool" data-op-exp="csv">csv 저장</button>'
      + '<button type="button" class="oc-tool" data-op-exp="xls">엑셀저장</button>'
      + '<button type="button" class="oc-tool" data-op-exp="print">인쇄하기</button>'
      + '</div></div>';
    const result = (_opView === 'chart')
      ? vizUnitCap(unit, 'USD') + buildProductChart(win, opOnSeries(q), q.term, OILP_CHART_H)
        + '<div class="viz-tooltip" id="oilpTooltip"></div>'
      : opTableHtml(q, win);
    // ① 차트(좌) + 제품별 현황 표(우). 표보기일 때는 표가 이미 넓으니 나란히 두지 않는다.
    const opRow = (_opView === 'chart')
      ? `<div class="oilp-row"><div class="oilp-row__main">${result}</div>${oilpTable(q)}</div>`
      : result;
    // 시나리오·요약은 유가(원유) 위젯과 같은 계산을 쓴다
    const opFc = oilForecast(opPts);
    const opBaseLabel = ((_opData.series || []).find((x) => x.key === OILP_BASE_KEY) || {}).label || '휘발유(95RON)';
    body = tools + opRow + msFactorsHtml('oil_price')
      + oilpFactors() + oilpScenarios(opFc, opBaseLabel) + oilpActions()
      + oilpInsightBox(opFc);
  }
  const note = (_opData.note ? '<div class="g-note">' + escapeHtml(_opData.note) + '</div>' : '');
  // 적용 환율·기준일 — 이미 있는 krwNote()(usd_krw 섹션 기반)를 그대로 쓴다
  const fxnote = _opQuery ? krwNote('USD') : '';
  return `<div class="viz-root viz-figure oilp-figure">${head}${controls}${body}${fxnote}${note}${cap}</div>`;
}

/* ══ 석유제품 인사이트 대시보드 ═══════════════════════════════════════════
   상단 대표제품 4카드 + 인사이트 → ① 차트(좌) + 제품별 현황 표(우)
   → ② 변동요인 4카드 → ③ 시나리오 표 → ④ 시사점 3카드 → 하단 요약
   ★ 조회 조건(기준·기간·제품)은 건드리지 않는다.
   ★★ 시나리오 수치는 통계 모델이 아니다 — 유가(원유) 위젯과 같은 계산
     (최근 12개월 추세 + 최근 6개월 변동성)이고 화면에 '추정치'라고 적는다. */
const OILP_DATA_URL = 'public/data/oilp-insights.json';
let _oilpIns = null;

const OILP_BASE_KEY = 'gasoline95';   // 시나리오 기준 제품(대표 제품)
// 차트 뷰박스 높이 — 옆에 붙는 '제품별 현황' 표(8개 제품 + 머리글 + 각주, 약 290px)와
// 키가 비슷해지도록 잡았다. 폭 840px 기준 840×250/720 ≈ 292px.
// 공용 VIZ_H(158)로는 840×158/720 ≈ 184px 밖에 안 돼 표 아래가 크게 비었다.
const OILP_CHART_H = 250;

async function fetchOilpInsights() {
  try {
    const res = await fetch(OILP_DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _oilpIns = d;
  } catch (e) {
    _oilpIns = null;
    console.warn('[oilp-insights] 로드 실패:', e);
  }
  renderMaterial();
}

/** 제품 하나의 최근값·전월비·기준월. 관측이 모자라면 null */
function oilpStat(key) {
  const pts = msPtsPetro(_opData, key);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  return {
    ym: last.k, v: last.v,
    mom: prev.v ? ((last.v - prev.v) / prev.v) * 100 : null,
  };
}

/** 대표제품 카드 4장 + 인사이트 카드 1장 */
function oilpLead() {
  if (!_opData || _opData.error) return '';
  const ins = _oilpIns || {};
  const keys = Array.isArray(ins.leadKeys) && ins.leadKeys.length
    ? ins.leadKeys : ['gasoline95', 'gasoline92', 'kerosene', 'naphtha'];
  const icons = ins.icons || {};
  const cards = keys.map((k) => {
    const s = (_opData.series || []).find((x) => x.key === k);
    const st = s ? oilpStat(k) : null;
    if (!st) return '';
    const krw = krwOf(st.v, '배럴');
    return `<div class="oilp-c">
      <div class="oilp-c__top">
        <span class="oilp-c__ico" aria-hidden="true">${escapeHtml(icons[k] || '•')}</span>
        <span class="oilp-c__name">${escapeHtml(s.label)}</span>
      </div>
      <div class="oilp-c__val">${oilUsd(st.v, 2)}<span class="oilp-c__u">/배럴</span></div>
      ${krw ? `<div class="oilp-c__krw">${escapeHtml(krw)}</div>` : ''}
      <div class="oilp-c__chg">${matBadge(st.mom)}<span class="oilp-c__as">${escapeHtml(st.ym)} 기준</span></div>
    </div>`;
  }).join('');
  if (!cards) return '';
  const bullets = ((ins.bullets) || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  const insCard = bullets
    ? `<div class="oilp-c oilp-c--ins">
        <div class="oilp-c__top"><span class="oilp-c__ico" aria-hidden="true">💡</span>
          <span class="oilp-c__name">주요 인사이트 요약</span></div>
        <ul class="oilp-c__ul">${bullets}</ul>
      </div>` : '';
  return `<div class="oilp-cards">${cards}${insCard}</div>`;
}

/** ① 우측 '제품별 현황' 표 — 8개 제품 전부. 조회한 제품은 진하게 */
function oilpTable(q) {
  if (!_opData || _opData.error) return '';
  const on = (q && q.on) ? q.on : null;
  const rows = (_opData.series || []).map((s) => {
    const st = oilpStat(s.key);
    const sel = on ? on.has(s.key) : false;
    if (!st) {
      return `<tr class="${sel ? 'is-on' : ''}"><th scope="row">${escapeHtml(s.label)}</th>
        <td class="oilp-t__v">—</td><td>—</td><td class="oilp-t__as">관측 없음</td></tr>`;
    }
    const krw = krwOf(st.v, '배럴');
    return `<tr class="${sel ? 'is-on' : ''}">
      <th scope="row">${escapeHtml(s.label)}</th>
      <td class="oilp-t__v">${oilUsd(st.v, 2)}${krw
        ? `<span class="oilp-t__krw">${escapeHtml(krw)}</span>` : ''}</td>
      <td>${matBadge(st.mom)}</td>
      <td class="oilp-t__as">${escapeHtml(st.ym)}</td>
    </tr>`;
  }).join('');
  return `<div class="oilp-side">
    <div class="oilp-side__h">제품별 현황 <i>월별 자료 기준</i></div>
    <div class="oilp-t-wrap"><table class="oilp-t">
      <thead><tr><th>제품</th><th>현재가</th><th>전월대비</th><th>기준</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="ii-cap">조회에 포함한 제품은 진하게 표시됩니다. 기준월이 다른 제품은
      그 제품의 마지막 관측월 값입니다(같은 달로 맞추지 않습니다).</div>
  </div>`;
}

/** ② 변동요인 4카드 */
function oilpFactors() {
  const list = (_oilpIns && Array.isArray(_oilpIns.factors)) ? _oilpIns.factors : [];
  if (!list.length) return '';
  const cards = list.map((f) => `<div class="sr-fac sr-fac--${escapeHtml(f.level || 'mid')}">
      <div class="sr-fac__top">
        <span class="sr-fac__ico" aria-hidden="true">${escapeHtml(f.icon || '•')}</span>
        <span class="sr-fac__title">${escapeHtml(f.title || '')}</span>
      </div>
      <div class="xsii-fac__tags">
        ${f.dirLabel ? `<span class="xsii-dir xsii-dir--${escapeHtml(f.dir || 'both')}">${escapeHtml(f.dirLabel)}</span>` : ''}
      </div>
      <p class="sr-fac__desc">${escapeHtml(f.desc || '')}</p>
    </div>`).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">② 주요 변동요인 분석</h3>
    <div class="sr-facs oil-facs">${cards}</div>
  </div>`;
}

/** ③ 시나리오 표 — 유가(원유) 위젯과 같은 계산·같은 표 */
function oilpScenarios(fc, baseLabel) {
  const list = (_oilpIns && Array.isArray(_oilpIns.scenarios)) ? _oilpIns.scenarios : [];
  if (!list.length) return '';
  if (!fc) {
    return `<div class="ii-panel">
      <h3 class="subhead ii-h">③ 향후 3개월 전망 <span class="xsi-fc__tag">추정치</span></h3>
      <div class="ii-cap">추세·변동성을 잴 만큼의 월별 관측치가 없어 시나리오를 내지 않았습니다.</div>
    </div>`;
  }
  const rng = { up: fc.up, base: fc.mid, down: fc.dn };
  const rows = list.map((s) => {
    const r = rng[s.key] || [];
    return `<tr class="xsi-sc--${escapeHtml(s.tone)}">
      <th scope="row"><span class="xsi-sc__dot"></span>${escapeHtml(s.name)}
        <span class="xsi-sc__prob">확률 추정 ${Number(s.prob)}%</span></th>
      <td class="xsi-sc__val">${oilUsd(r[0], 0)}~${oilUsd(r[1], 0)}<span class="xsi-sc__u">${escapeHtml(baseLabel)} 기준</span></td>
      <td class="xsi-sc__basis">${escapeHtml(s.basis || '')}</td>
      <td>${escapeHtml(s.assumption || '')}</td>
    </tr>`;
  }).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">③ 향후 3개월 전망 <span class="xsi-fc__tag">추정치</span></h3>
    <div class="xsi-sc-wrap"><table class="xsi-sc">
      <thead><tr><th>시나리오</th><th>3개월 후 가격범위</th><th>산출 기준</th><th>주요 가정</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="ii-cap">※ 상기 확률·범위는 과거 변동성 기반 통계적 추정이며 실제 시장 전망이 아닙니다.
      최근 ${OIL_VOL_WIN}개월 월별 등락의 표준편차(3개월 지평 ±${fc.sd3.toFixed(1)}%)와
      최근 12개월(${escapeHtml(fc.from)}~${escapeHtml(fc.to)}) 추세로 계산했고,
      확률(%)은 계산값이 아니라 시나리오 구분을 위한 가정치입니다.</div>
  </div>`;
}

/** ④ 시사점 3카드 */
function oilpActions() {
  const list = (_oilpIns && Array.isArray(_oilpIns.actions)) ? _oilpIns.actions : [];
  if (!list.length) return '';
  const cols = list.map((a) => `<div class="ii-imp ii-imp--${escapeHtml(a.tone || 'info')}">
      <div class="ii-imp__h">${iiImpIcon(a.tone || 'info')}${escapeHtml(a.title || '')}</div>
      <ul class="xsi-act">${(a.items || []).map((t) => `<li>${iiEmph(t)}</li>`).join('')}</ul>
    </div>`).join('');
  const upd = (_oilpIns && _oilpIns.updated) ? String(_oilpIns.updated) : null;
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">④ 시사점 및 대응 방안</h3>
    <div class="ii-imps">${cols}</div>
    <div class="ii-cap">시황 해설은 주기적으로 갱신됩니다${upd ? ' (최종 갱신: ' + escapeHtml(upd) + ')' : ''}</div>
  </div>`;
}

/** 하단 핵심 요약 (전체 폭 남색) */
function oilpInsightBox(fc) {
  const ins = (_oilpIns && _oilpIns.insight) || null;
  if (!ins) return '';
  const lead = ins[fc ? fc.dir : 'flat'] || ins.flat;
  if (!lead) return '';
  const trend = fc
    ? `<span class="xsi-ins__trend">최근 12개월 추세 연장 기준 ${(fc.chgPct > 0 ? '+' : '')
      + fc.chgPct.toFixed(1)}% <i>추정</i></span>` : '';
  return `<div class="xsi-ins">
    <div class="xsi-ins__h">핵심 요약${trend}</div>
    <p class="xsi-ins__lead">${escapeHtml(lead)}</p>
    ${ins.action ? `<p class="xsi-ins__act">→ ${escapeHtml(ins.action)}</p>` : ''}
  </div>`;
}

/** 제품 카드 조회 조건 배선 — 원유 카드와 같은 동작, 선택자만 다르다 */
function wireProductControls(root) {
  const fig = root.querySelector('.oilp-figure');
  if (!fig || !_opData || _opData.error) return;
  const form = fig.querySelector('.op-formwrap');
  if (form) {
    form.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !_opForm) return;
      if (t.name === 'opTerm') {
        _opForm = opFormFor(t.value, new Set(_opForm.on));
        form.innerHTML = opControlsHtml();
        return;
      }
      const k = t.getAttribute && t.getAttribute('data-op');
      if (k) {
        _opForm[k] = t.value;
      } else {
        const p = t.getAttribute && t.getAttribute('data-op-prod');
        if (!p) return;
        if (t.checked) _opForm.on.add(p); else _opForm.on.delete(p);
      }
    });
    form.addEventListener('click', (e) => {
      const go = e.target.closest && e.target.closest('.op-go');
      if (!go || !_opForm) return;
      _opQuery = { term: _opForm.term, y0: _opForm.y0, m0: _opForm.m0, d0: _opForm.d0,
        y1: _opForm.y1, m1: _opForm.m1, d1: _opForm.d1, on: new Set(_opForm.on) };
      renderMaterial();
    });
  }
  fig.addEventListener('click', (e) => {
    const v = e.target.closest && e.target.closest('[data-op-view]');
    if (v) { _opView = v.getAttribute('data-op-view'); renderMaterial(); return; }
    const x = e.target.closest && e.target.closest('[data-op-exp]');
    if (!x || !_opQuery) return;
    const win = opWindow(_opQuery);
    const kind = x.getAttribute('data-op-exp');
    if (kind === 'csv') opExportCsv(_opQuery, win);
    else if (kind === 'xls') opExportXls(_opQuery, win);
    else opPrint(_opQuery, win);
  });
  if (_opQuery && _opView === 'chart') wireProductChart();
}

/* ── 해상 정시성 (Sea-Intelligence Global Schedule Reliability) ── */

/** 선택 연도에 맞춰 표시할 연도(선) 목록 구성 */
/* ── 해상 정시성 ──────────────────────────────────────────────────────────
   ★★ 없는 것을 지어내지 않는다. Sea-Intelligence 가 주는 것은 '월별 전세계 정시성
     한 줄'뿐이다 — payload 실측 결과 years={연도: 월 12개 값} 이 전부이고
     지역·항로·선사 구분이 아예 없다. 그래서 이 카드에는 요약 배지만 붙이고,
     구조적·단기 요인 해설은 넣지 않는다(조사된 문구가 없으면 비워 둔다). */

/** 연도 목록의 관측치를 시간순으로 편다. [{ym:'2026-06', v:62.6}] (결측은 뺀다) */
function srFlatten(years) {
  const out = [];
  (years || []).forEach((y) => {
    const arr = (_srData.years || {})[y] || [];
    arr.forEach((v, i) => {
      if (v != null) out.push({ ym: y + '-' + String(i + 1).padStart(2, '0'), v: Number(v) });
    });
  });
  return out.sort((a, b) => (a.ym < b.ym ? -1 : 1));
}

function srViewData(year) {
  const yrs = Object.keys(_srData.years).sort();
  const months = _srData.months;
  const pick = (year === 'all') ? yrs : yrs.filter((y) => y === year);
  const series = pick.map((y) => ({
    key: y,
    color: srYearColor(y),
    values: (_srData.years[y] || []).slice(0, months.length),
  })).filter((s) => s.values.some((v) => v != null));
  return { months, series };
}

/* ══ 해상 정시성 5단 시황 패널 ═══════════════════════════════════════════
   ① 추이 + 향후 전망   ② 핵심요약 4박스   ③ 최근 변동요인
   ④ 히스토리 이벤트    ⑥ 향후 전망·시사점
   (⑤ 항로별 비교는 원자료에 항로 구분이 없어 만들지 않는다)

   ★ 이 차트의 X축은 1~12월이고 연도마다 선이 하나씩 얹힌다. 그래서 '추세 연장'은
     축을 늘리는 게 아니라, 마지막 관측월(예: 2026-07) 다음 칸부터 그 해의 선을
     이어 그리는 방식이다.
   ★★ 추세 연장은 예측 모델이 아니다. 최근 이동평균의 기울기를 그대로 늘린 직선이며
     화면에도 그렇게 적는다.
   ★ 해설 문구는 public/data/sr-insights.json 한 곳에서만 온다. */
const SRI_DATA_URL = 'public/data/sr-insights.json';
let _sriData = null;

const SRI_EXT_MONTHS = 3;    // 몇 개월을 이어 그을지
const SRI_AVG_YEARS = ['2021', '2022', '2023', '2024'];   // 비교 기준 4개년

/** 해설 데이터 로드. 실패해도 차트는 그대로 나온다. */
async function fetchSrInsights() {
  try {
    const res = await fetch(SRI_DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _sriData = d;
  } catch (e) {
    _sriData = null;
    console.warn('[sr-insights] 로드 실패:', e);
  }
  renderMaterial();
}

/** 비교 기준 연도 목록(JSON 이 정하고, 없으면 기본값) */
function sriAvgYears() {
  const y = _sriData && _sriData.avgYears;
  return (Array.isArray(y) && y.length) ? y.map(String) : SRI_AVG_YEARS;
}

/** 기준 4개년의 '월별 평균' 12칸. 관측이 없는 달은 null.
 *  ★ X축이 1~12월이라 한 줄짜리 가로선보다 월별 평균이 계절성을 보여 준다. */
function sriAvgProfile() {
  if (!_srData || !_srData.years) return null;
  const ys = sriAvgYears().filter((y) => _srData.years[y]);
  if (!ys.length) return null;
  const n = (_srData.months || []).length || 12;
  const out = [];
  for (let m = 0; m < n; m += 1) {
    const vals = ys.map((y) => (_srData.years[y] || [])[m])
      .filter((v) => v != null && isFinite(v));
    out.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  }
  return out.some((v) => v != null) ? out : null;
}

/** 기준 4개년 전체 평균(한 숫자). 없으면 null */
function sriAvgAll() {
  if (!_srData || !_srData.years) return null;
  const vals = sriAvgYears().flatMap((y) => (_srData.years[y] || []))
    .filter((v) => v != null && isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** 마지막 관측 지점 {year, mi(0-based 월), v} · 없으면 null */
function sriLast() {
  const pts = msPtsSr();
  if (!pts.length) return null;
  const k = pts[pts.length - 1].k;
  return { year: k.slice(0, 4), mi: Number(k.slice(5, 7)) - 1, v: pts[pts.length - 1].v, ym: k };
}

/** 마지막 관측월에서 n개월 전 값(같은 시계열 위에서). 없으면 null */
function sriBack(n) {
  const pts = msPtsSr();
  if (pts.length <= n) return null;
  const last = pts[pts.length - 1];
  const want = msYmOfNo(msMonthNo(last.k) - n);
  const hit = pts.find((p) => p.k === want);
  return hit ? hit.v : null;
}

/** 'YYYY-MM' 로 되돌리기 (msMonthNo 의 짝) */
function msYmOfNo(no) {
  if (no == null) return null;
  return String(Math.floor(no / 12)) + '-' + String((no % 12) + 1).padStart(2, '0');
}

/** 추세 연장 — 마지막 관측월 다음 칸부터 그 해의 선을 이어 그린다.
 *  { year, from, values:[{mi,v}], band:[{mi,lo,hi}], slope } · 못 내면 null
 *  ★ 이어 그릴 칸이 12월을 넘으면 그 부분은 그리지 않는다(축이 1~12월이라서). */
function sriExtend() {
  const last = sriLast();
  if (!last) return null;
  const fit = iiFit(msPtsSr().map((p) => p.v));   // ICIS 와 같은 계산(이동평균 기울기 + 잔차)
  if (!fit) return null;
  const nMon = (_srData.months || []).length || 12;
  const values = [], band = [];
  for (let k = 1; k <= SRI_EXT_MONTHS; k += 1) {
    const mi = last.mi + k;
    if (mi >= nMon) break;                        // 해를 넘기는 칸은 이 축에 없다
    const v = Math.max(0, Math.min(100, last.v + fit.slope * k));
    const w = (fit.sd || 0) * Math.sqrt(k);
    values.push({ mi: mi, v: v });
    band.push({ mi: mi, lo: Math.max(0, v - w), hi: Math.min(100, v + w) });
  }
  if (!values.length) return null;
  return { year: last.year, from: last, values: values, band: band, slope: fit.slope };
}

/** 전망 범위(음영 띠 전체)를 'NN~NN%' 로. 없으면 null */
function sriRangeText(ext) {
  if (!ext || !ext.band.length) return null;
  const lo = Math.min(...ext.band.map((b) => b.lo));
  const hi = Math.max(...ext.band.map((b) => b.hi));
  return Math.round(lo) + '~' + Math.round(hi) + '%';
}

/* ── ② 핵심요약 4박스 ──────────────────────────────────────────────────
   지금까지 쓰던 전월비·전년비·국면 배지를 이 박스들로 옮긴다(정보는 그대로 둔다).
   ★ 정시성은 '비율' 지표라 등락을 %가 아니라 %p 로 적는다. */
function sriPp(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0.05 ? '▲ +' : (v < -0.05 ? '▼ ' : '')) + v.toFixed(1) + '%p';
}

function sriBox(label, val, cls, sub) {
  return '<div class="sr-sum__box">'
    + '<div class="sr-sum__lbl">' + escapeHtml(label) + '</div>'
    + '<div class="sr-sum__val ' + (cls || '') + '">' + val + '</div>'
    + (sub ? '<div class="sr-sum__sub">' + sub + '</div>' : '')
    + '</div>';
}

function sriSummary(ext) {
  const last = sriLast();
  if (!last) return '';
  const mom = sriBack(1) == null ? null : last.v - sriBack(1);
  const yoy = sriBack(12) == null ? null : last.v - sriBack(12);
  const avg = sriAvgAll();
  const ph = msPhase(msMonthly(msPtsSr()));
  const range = sriRangeText(ext);
  const yrs = sriAvgYears();
  const span = yrs.length ? yrs[0] + '~' + yrs[yrs.length - 1] : '';

  return '<div class="sr-sum">'
    + sriBox('최근 정시성', last.v.toFixed(1) + '<span class="sr-sum__u">%</span>', '',
      escapeHtml(last.ym) + ' 기준 · 전월비 <b class="ms-badge__val '
        + iiCls(mom) + '">' + sriPp(mom) + '</b>')
    + sriBox('연간 추세 (전년 동월비)', '<span class="ms-badge__val ' + iiCls(yoy) + '">'
      + sriPp(yoy) + '</span>', '',
      ph ? '국면 ' + escapeHtml(ph.icon + ' ' + ph.text) : '국면 판정 보류')
    + sriBox('과거 4개년 평균', avg == null ? '—' : avg.toFixed(1) + '<span class="sr-sum__u">%</span>', '',
      escapeHtml(span) + ' 실측 평균')
    + sriBox('향후 3개월 전망 범위', range ? escapeHtml(range) : '—', 'sr-sum__val--est',
      '추세 연장 기준 · 예측 아님')
    + '</div>';
}

/* ── ③ 최근 변동요인 ───────────────────────────────────────────────────
   방향(부정적/균형적/중립적)은 JSON 의 tone 이 정한다. 코드가 판단하지 않는다. */
function sriFactors() {
  const list = (_sriData && Array.isArray(_sriData.factors)) ? _sriData.factors : [];
  if (!list.length) return '';
  const cards = list.map((f) => `<div class="sr-fac sr-fac--${escapeHtml(f.tone || 'neu')}">
      <div class="sr-fac__top">
        <span class="sr-fac__ico" aria-hidden="true">${escapeHtml(f.icon || '•')}</span>
        <span class="sr-fac__title">${escapeHtml(f.title || '')}</span>
        ${f.toneLabel ? `<span class="sr-fac__tag">${escapeHtml(f.toneLabel)}</span>` : ''}
      </div>
      <p class="sr-fac__desc">${escapeHtml(f.desc || '')}</p>
    </div>`).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">③ 최근 변동요인</h3>
    <div class="sr-facs">${cards}</div>
  </div>`;
}

/* ── ④ 히스토리 이벤트 (ICIS 와 같은 타임라인 문법을 그대로 쓴다) ─────── */
function sriTimeline() {
  const list = (_sriData && Array.isArray(_sriData.timeline)) ? _sriData.timeline : [];
  if (!list.length) return '';
  const items = list.map((e) => `<li class="ii-tl__item">
      <span class="ii-tl__dot" aria-hidden="true"></span>
      <span class="ii-tl__date">${escapeHtml(e.date || '')}</span>
      <span class="ii-tl__body">
        <span class="ii-tl__event">${escapeHtml(e.event || '')}</span>
        ${e.impact ? `<span class="ii-tl__impact">${escapeHtml(e.impact)}</span>` : ''}
      </span>
    </li>`).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">④ 히스토리 이벤트와 정시성 변화</h3>
    <ol class="ii-tl">${items}</ol>
  </div>`;
}

/* ── ⑥ 향후 전망 및 시사점 (ICIS ⑥ 과 같은 주황·파랑·녹색 체계) ─────────
   ★ 문장 속 {range}·{latest}·{mom}·{yoy}·{avg4} 는 실데이터로 바꿔 넣는다.
     숫자를 JSON 에 적어 두면 다음 달 수집 때 화면과 어긋나기 때문이다. */
function sriFill(text, ext) {
  const last = sriLast();
  const mom = (last && sriBack(1) != null) ? last.v - sriBack(1) : null;
  const yoy = (last && sriBack(12) != null) ? last.v - sriBack(12) : null;
  const avg = sriAvgAll();
  const map = {
    range: sriRangeText(ext) || '—',
    latest: last ? last.v.toFixed(1) + '%' : '—',
    mom: mom == null ? '—' : (mom > 0 ? '+' : '') + mom.toFixed(1) + '%p',
    yoy: yoy == null ? '—' : (yoy > 0 ? '+' : '') + yoy.toFixed(1) + '%p',
    avg4: avg == null ? '—' : avg.toFixed(1) + '%',
  };
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) =>
    (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m));
}

function sriImplications(ext) {
  const im = (_sriData && _sriData.implications) || null;
  if (!im) return '';
  const col = (h, t, tone) => (t ? `<div class="ii-imp ii-imp--${tone}">
      <div class="ii-imp__h">${iiImpIcon(tone)}${escapeHtml(h)}</div>
      <p class="ii-imp__b">${iiEmph(sriFill(t, ext))}</p></div>` : '');
  const cols = col('전망', im.outlook, 'warn')
    + col('시사점', im.takeaway, 'info')
    + col('의사결정 활용 방안', im.decision, 'act');
  if (!cols) return '';
  const upd = (_sriData && _sriData.updated) ? String(_sriData.updated) : null;
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">⑥ 향후 전망 및 시사점</h3>
    <div class="ii-imps">${cols}</div>
    ${im.note ? `<div class="ii-cap">${escapeHtml(im.note)}</div>` : ''}
    <div class="ii-cap">시황 해설은 주기적으로 갱신됩니다${upd ? ' (최종 갱신: ' + escapeHtml(upd) + ')' : ''}</div>
  </div>`;
}

/** 해상 정시성 블록 HTML (ICIS와 동일 스타일: 연도 버튼 → 선그래프) */
function renderScheduleReliabilityHtml() {
  if (!_srData) return '';
  // ② 핵심요약 4박스 — 예전 전월비·전년비·국면 배지를 이 박스들로 옮겼다.
  const srExt = _srData.error ? null : sriExtend();
  // ★ 연도 버튼을 누른 뒤에만 내보낸다(섹션 공통 규칙)
  const srBoxes = (_srData.error || !_srYear) ? '' : sriSummary(srExt);
  // 배너의 '업데이트 기준'은 관측치의 마지막 달
  const srLast = _srData.error ? null : sriLast();
  const head = vizHero('compass', '해상 정시성 (Global Schedule Reliability)',
    '월별 정시 도착 비율(%) · 연도별', srLast ? srLast.ym : '') + srBoxes;
  if (_srData.error) {
    return `<div class="viz-root viz-figure sr-figure">${head}
      <div class="chart-empty">데이터를 불러오지 못했습니다(사이트 접근 차단 가능)</div>
      ${capSrc('출처: Sea-Intelligence', SRC_LINKS.sea)}
    </div>`;
  }
  const years = Object.keys(_srData.years).sort().concat(['all']);
  const toolbar = `<div class="icis-years sr-years">${years.map((y) =>
    `<button class="icis-year sr-year${y === _srYear ? ' is-active' : ''}" data-year="${y}">${y === 'all' ? '전체' : y}</button>`).join('')}</div>`;

  // 스폰지 카드(renderMaterial의 _matYear 분기)와 동일 조건: 연도를 고르기 전에는
  // 차트와 함께 지표 설명·예측도 내보내지 않는다.
  let body, extras = '';
  if (!_srYear) {
    body = '<div class="icis-prompt">연도를 선택하세요</div>';
  } else {
    const { months, series } = srViewData(_srYear);
    const avg = sriAvgProfile();
    body = buildSrChart(months, series, avg, srExt)
      + '<div class="ii-cap ii-cap--chart">추세 연장선은 참고용 추정치이며 실제 예측이 아닙니다.'
      + (srExt ? ' (최근 이동평균의 기울기를 ' + SRI_EXT_MONTHS + '개월 연장 · 음영은 그 추세선에서'
        + ' 벗어난 정도로 잡은 참고 범위)' : '') + '</div>';
    extras = sriFactors() + sriTimeline() + sriImplications(srExt)
      + renderSrTermsHtml() + renderSrForecastHtml();
  }
  return `<div class="viz-root viz-figure sr-figure">${head}
    ${toolbar}
    ${body}
    <div class="viz-tooltip" id="srTooltip"></div>
    ${capSrc('출처: Sea-Intelligence', SRC_LINKS.sea)}
    ${extras}
  </div>`;
}

/* ══ 글로벌 컨테이너 운임지수 — Xeneta Shipping Index by Compass (XSI-C) ══
   항로 8개를 탭으로 고르고, 그 항로의 공표 통계 9개 + 전 구간 라인차트를 보여준다.
   수집: xsi_freight.py → public/data/xsi-freight-index.json (하루 1회)

   ★★ 기간 버튼(1Y/3Y/5Y/전체)은 '차트만' 자른다. 통계는 다시 계산하지 않는다.
     원본 사이트(compassft.js)도 같은 방식이라 그대로 맞췄고, 화면에도 '전체 기간
     기준 공표값'이라고 적는다 — 기간을 바꿨는데 통계가 그대로인 이유를 감추지 않는다.
   ★ 그래프 데이터를 못 받은 항로는 통계 카드만 나온다(위젯이 죽지 않는다). */
const XSI_DATA_URL = 'public/data/xsi-freight-index.json';
let _xsiData = null;
let _xsiRoute = null;      // 고른 항로 key
let _xsiRange = null;      // 차트 기간: null(미선택) | '1' | '3' | '5' | 'all'
                           // ★ null 이면 차트를 내지 않는다 — KOIMA 부문→기간과 같은 2단
let _xsiChart = null;      // 툴팁이 쓸 좌표·값

const XSI_RANGES = [
  { key: '1', label: '1년' }, { key: '3', label: '3년' },
  { key: '5', label: '5년' }, { key: 'all', label: '전체' },
];

/** 헤더 배너 — 진한 남색. 아래 카드들과 구분되는 '대시보드 머리' 역할. */
function xsiHero() {
  const sub = (_xsiiData && _xsiiData.hero && _xsiiData.hero.subtitle) || '';
  // '업데이트 기준'은 수집 시각이 아니라 지수의 최신 데이터 날짜를 쓴다.
  const day = (_xsiData && _xsiData.routes || []).reduce((a, r) => {
    const d = r.stats && r.stats.date;
    return (d && (!a || d > a)) ? d : a;
  }, null);
  return vizHero('ship', '글로벌 컨테이너 운임지수', sub, day,
    '(Xeneta Shipping Index by Compass)');
}

/* ── 위젯 제목 배너 (진한 남색) ────────────────────────────────────────────
   운임지수·ICIS·해상 정시성이 같은 컴포넌트를 쓴다. 아이콘 path 만 다르다.
   dateLabel 은 각 위젯의 '실제 최신 데이터 날짜'를 넣는다(수집 시각이 아니다). */
const VIZ_HERO_ICONS = {
  ship: '<path d="M3 17c1.2 1 2.3 1.4 3.5 1.4S9 18 10.2 17c1.2 1 2.3 1.4 3.5 1.4S16.3 18 17.5 17c1.2 1 2.3 1.4 3.5 1.4"/>'
    + '<path d="M4.5 14 6 9.2l6-1.9 6 1.9L19.5 14"/><path d="M12 7.3V4.6M9.6 4.6h4.8"/>',
  // 화학 원료 — 삼각 플라스크
  flask: '<path d="M9.5 3h5"/><path d="M10.5 3v5.2L5.2 17.4A2 2 0 0 0 6.9 20.5h10.2a2 2 0 0 0 1.7-3.1L13.5 8.2V3"/>'
    + '<path d="M7.6 14.5h8.8"/>',
  // 항해 — 나침반
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5z"/>',
  // 석유제품 — 주유기
  fuel: '<path d="M4.5 20.5V5.4A1.9 1.9 0 0 1 6.4 3.5h4.7a1.9 1.9 0 0 1 1.9 1.9v15.1"/>'
    + '<path d="M3 20.5h11.5"/><path d="M6.6 7.2h4.3v3.4H6.6z"/>'
    + '<path d="M12.9 8.6h3.4a1.8 1.8 0 0 1 1.8 1.8v5.1a1.6 1.6 0 0 0 3.2 0V9.1l-2.1-2.6"/>',
  // 원료통 — 드럼통(원자재 실물)
  drum: '<path d="M5 6.2c0-1.2 3.1-2.2 7-2.2s7 1 7 2.2v11.6c0 1.2-3.1 2.2-7 2.2s-7-1-7-2.2Z"/>'
    + '<path d="M5 6.2c0 1.2 3.1 2.2 7 2.2s7-1 7-2.2"/>'
    + '<path d="M5 10.4c0 1.2 3.1 2.2 7 2.2s7-1 7-2.2"/>'
    + '<path d="M5 14.6c0 1.2 3.1 2.2 7 2.2s7-1 7-2.2"/>',
  // 원자재·광물 — 광석 더미(야적장) + 곡괭이
  mine: '<path d="M2.5 20.5h19"/><path d="m5.5 20.5 4.2-6.6 4.2 6.6"/>'
    + '<path d="m12.6 20.5 3.3-5 3.3 5"/><path d="M8.2 15.4h3"/>'
    + '<path d="M14.4 8.6 19 4"/><path d="M12.6 3.5c1.9-.6 3.9-.1 5.3 1.3s1.9 3.4 1.3 5.3"/>',
  // 국내 구분 — 지도 핀
  pin: '<path d="M12 21.5s7-5.6 7-11.1A7 7 0 0 0 5 10.4c0 5.5 7 11.1 7 11.1Z"/>'
    + '<circle cx="12" cy="10.2" r="2.6"/>',
  // 국외 구분 — 지구(경위선)
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6"/>'
    + '<path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z"/>',
  // 원유 — 유정 탑(데릭) + 기름방울
  oil: '<path d="M4 20h16"/><path d="m7 20 3.2-11M13.4 20 10.2 9"/><path d="M7.6 14.2h5.2"/>'
    + '<path d="M10.2 9V4.8h5.6"/><path d="M18 12.4c1 1.2 1.6 2.1 1.6 2.9a1.6 1.6 0 1 1-3.2 0c0-.8.6-1.7 1.6-2.9Z"/>',
};

function vizHero(icon, title, sub, dateLabel, note, badgePrefix, cls) {
  const d = VIZ_HERO_ICONS[icon] || VIZ_HERO_ICONS.ship;
  /* ★ cls 로 변형을 받는다 — 기본 .viz-hero 는 .viz-figure 의 padding(11px)을
     음수 마진으로 상쇄하는 전제라, padding 이 없는 자리(예: 경쟁사 섹션)에
     그대로 쓰면 좌우가 밖으로 삐져나온다. 그런 자리는 --plain 을 준다. */
  return `<div class="viz-hero${cls ? ' ' + cls : ''}">
    <span class="viz-hero__ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>
    </span>
    <div class="viz-hero__body">
      <div class="viz-hero__title">${escapeHtml(title)}${note
        ? ` <i>${escapeHtml(note)}</i>` : ''}</div>
      ${sub ? `<p class="viz-hero__sub">${escapeHtml(sub)}</p>` : ''}
    </div>
    ${dateLabel ? `<span class="viz-hero__badge">${escapeHtml(
      /* ★ '' 를 넘기면 접두어 없이 배지 본문만 쓴다. 예전엔 `||` 라서 빈 문자열이
         기본값('업데이트 기준')으로 되살아났다 — 날짜가 아닌 요약 배지에는 맞지 않는다. */
      badgePrefix == null ? '업데이트 기준 ' + dateLabel : (badgePrefix ? badgePrefix + ' ' + dateLabel : dateLabel)
    )}</span>` : ''}
  </div>`;
}

/** 통화 축 캡션 — 단위 + 적용 환율. 차트 위에 둔다(축 눈금과 자리를 다투지 않게). */
function vizUnitCap(unit, cur) {
  // cur === false → 통화가 없는 지표(지수 등). 원화 환산 문구를 붙이지 않는다.
  if (cur === false) return '<div class="viz-unit">단위: ' + escapeHtml(unit) + '</div>';
  const r = krwRate(cur || 'USD');
  const d = krwAsOf(cur || 'USD');
  return '<div class="viz-unit">단위: ' + escapeHtml(unit)
    + (r != null ? ' <span class="viz-unit__fx">· 원화 환산 적용 환율 1 '
      + escapeHtml(String(cur || 'USD').toUpperCase()) + ' = '
      + Math.round(r).toLocaleString('ko-KR') + '원'
      + (d ? ' (' + escapeHtml(d) + ' 기준)' : '') + '</span>' : '')
    + '</div>';
}

/** 지수 단위 — 수집 데이터의 Currency 를 그대로 쓴다(코드에 적지 않는다). */
function xsiUnit() {
  const cur = _xsiData && _xsiData.currency;
  return cur ? cur + ' / 40ft 컨테이너' : '지수';
}

/** 최근값이 무엇인지 — Compass 정의 문장을 우리말로 옮긴 것. */
function xsiValueTip() {
  const cur = (_xsiData && _xsiData.currency) || 'USD';
  return '해당 항로에서 40피트(40\u2019) 컨테이너 1개를 32일 미만 단기로 실을 때의 '
    + 'FAK(Freight All Kind, 품목을 가리지 않는 일괄 운임) 수준입니다. 단위는 ' + cur
    + ' 이며, Compass 가 매 영업일 산출해 유럽 중부시간 18시에 공표합니다.';
}

/** 통계 카드에 쓸 항목 — 라벨·설명은 원본 표기를 따른다. */
const XSI_STATS = [
  { key: 'annReturn', label: '연간 수익률', tip: 'Annualised Return', icon: '📈',
    // ★ 산술로 확인했다 — 8개 항로 모두 '산출 이래 누적 수익률의 연환산'과 일치한다.
    def: '산출을 시작한 날 이후의 누적 등락률을 1년 단위로 환산한 값입니다.' },
  // 변동성은 '얼마나 흔들렸나'를 재는 크기 지표라 부호가 없다.
  // 수익률과 같은 ▲빨강/▼파랑을 붙이면 '올랐다'는 뜻으로 잘못 읽힌다.
  { key: 'annVol', icon: '〰️', label: '연간 변동성', tip: 'Annualised Volatility', plain: true,
    // ★ 창(1년·3년·전체)을 바꿔 맞춰 봤으나 8개 항로에서 일관되게 재현되지 않았다.
    //   그래서 '무엇을 재는 값인지'만 적고 산출식은 단정하지 않는다.
    def: '운임이 얼마나 크게 출렁였는지를 1년 단위로 환산한 값입니다. 숫자가 클수록 '
      + '등락이 심했다는 뜻이며, 오르거나 내린 방향과는 관계가 없습니다. '
      + '산출 구간과 방식은 Compass 공표 기준을 그대로 따릅니다.' },
  { key: 'd1', icon: '🕐', label: '1일', tip: '1 Day Return', def: '직전 영업일 대비 등락률입니다.' },
  { key: 'mtd', icon: '📅', label: '월초 이후', tip: 'MTD Return', def: '이번 달 첫 영업일 대비 등락률입니다.' },
  { key: 'qtd', icon: '🗓️', label: '분기초 이후', tip: 'QTD Return', def: '이번 분기 첫 영업일 대비 등락률입니다.' },
  { key: 'ytd', icon: '📊', label: '연초 이후', tip: 'YTD Return', def: '올해 첫 영업일 대비 등락률입니다.' },
  { key: 'inception', icon: '🏁', label: '산출 이래', tip: 'Since Inception',
    def: '산출을 시작한 날 이후의 누적 등락률입니다(연 단위로 환산하지 않은 값).' },
];

/** 데이터 로드. 실패해도 다른 카드에 영향을 주지 않는다. */
async function fetchXsi() {
  try {
    const res = await fetch(XSI_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 (' + XSI_DATA_URL + ')');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || !Array.isArray(d.routes) || !d.routes.length) throw new Error('형식이 올바르지 않습니다');
    _xsiData = d;
    // ★ 항로를 대신 골라 주지 않는다. 사용자가 직접 눌러야 수치가 나온다.
    //   (예전에는 여기서 d.routes[0] 을 집어넣어 화면이 열리자마자 값이 떠 있었다)
    //   다만 이전에 고른 항로가 이번 데이터에 없으면 선택을 비운다.
    if (_xsiRoute && !d.routes.some((r) => r.key === _xsiRoute)) _xsiRoute = null;
  } catch (e) {
    _xsiData = { status: 'error', routes: [], reason: (e && e.message) || String(e) };
    console.warn('[xsi] 로드 실패:', e);
  }
  renderMaterial();
}

/** 지금 고른 항로 객체. 없으면 null */
function xsiRoute() {
  if (!_xsiRoute) return null;      // 안 골랐으면 안 고른 것이다(첫 항로로 넘어가지 않는다)
  const rs = (_xsiData && _xsiData.routes) || [];
  return rs.find((r) => r.key === _xsiRoute) || null;
}

/** 기간에 맞춰 시계열을 자른다. 원본 사이트와 같은 규칙(오늘로부터 N년). */
function xsiSlice(series, range) {
  if (!series || !series.dates || !series.dates.length) return null;
  if (range === 'all') return series;
  const yrs = Number(range);
  if (!isFinite(yrs) || yrs <= 0) return series;
  const last = series.dates[series.dates.length - 1];
  const cut = String(Number(last.slice(0, 4)) - yrs) + last.slice(4);
  let i = 0;
  while (i < series.dates.length && series.dates[i] < cut) i += 1;
  if (i >= series.dates.length - 1) return series;   // 너무 짧으면 전 구간을 그대로
  return { dates: series.dates.slice(i), values: series.values.slice(i) };
}

/** 수익률 표기 — 오르면 빨강 ▲ / 내리면 파랑 ▼ (다른 카드와 같은 규칙) */
function xsiPct(v, plain) {
  if (v == null || !isFinite(v)) return '<span class="ms-badge__val na">—</span>';
  if (plain) return '<span class="ms-badge__val flat">' + v.toFixed(2) + '%</span>';
  const cls = v > 0.005 ? 'up' : (v < -0.005 ? 'down' : 'flat');
  const icon = v > 0.005 ? '▲ +' : (v < -0.005 ? '▼ ' : '');
  return '<span class="ms-badge__val ' + cls + '">' + icon + v.toFixed(2) + '%</span>';
}

/** 지수값 라인차트. 다른 차트와 같은 VIZ_* 규격을 쓴다. */
function buildXsiChart(slice, color) {
  const n = slice ? slice.dates.length : 0;
  if (!n) { _xsiChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const vals = slice.values;
  let ymin = Math.min(...vals), ymax = Math.max(...vals);
  const yp = (ymax - ymin) * 0.1 || 10; ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 46, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val).toLocaleString('en-US')}</text>${vizKrwTick(padL - 6, y, val, krwRate('USD'))}`;
  }).join('');

  const xticks = vizTickIdx(n, plotW, VIZ_TICK_GAP).map((i) => {
    const d = slice.dates[i];
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(d.slice(0, 7))}</text>`;
  }).join('');


  // 점이 2천 개를 넘을 수 있어 선만 긋는다(점을 찍으면 뭉개진다 — 값은 툴팁으로).
  let path = '';
  vals.forEach((v, i) => { path += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; });
  const area = `${path}L${X(n - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L${X(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  _xsiChart = { dates: slice.dates, values: vals, color: color, geom: { X, Y, n, W, padL } };

  // 구간 음영은 격자 바로 뒤에 깐다 — 데이터 선이 그 위에 얹히도록.
  const bands = xsiiBandsSvg(slice, X, padT, plotH);

  return `<svg class="viz-svg xsi-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="컨테이너 운임지수 추이">
      ${grid}${bands}${xticks}
      <path d="${area}" fill="${color}" opacity=".08"/>
      <path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="xsi-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="xsi-dots"></g>
      <rect class="xsi-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/* ══ 운임지수 4단 패널 ═══════════════════════════════════════════════════
   ① 구간 설명(장기 흐름)  ② 주요 변동요인  ③ 향후 전망  ④ 시사점·대응 전략
   문구는 public/data/xsi-insights.json 한 곳에서만 온다.

   ★★ ① 구간 설명은 '극동→북유럽' 항로를 보고 조사한 서술이다. 다른 항로를
     고르면 그 항로의 실제 곡선과 어긋날 수 있으므로, 차트 위 음영을 빼고
     '어느 항로 기준인지'를 눈에 띄게 적는다 — 숨기지 않고 밝힌다. */
const XSII_DATA_URL = 'public/data/xsi-insights.json';
let _xsiiData = null;

/** 구간 성격 → 색. 급등=빨강 · 하락=파랑 (다른 카드의 등락 표기와 같은 규칙) */
const XSII_TONE = {
  calm: 'var(--slate)', surge: 'var(--accent)',
  drop: 'var(--blue)', recover: 'var(--green)',
};

/* 국제유가 구간 색 — 다섯 구간이 서로 다른 색을 갖도록 별도로 둔다.
   ★ 카드(.xsii-era)와 차트 음영이 반드시 같은 값을 써야 둘이 이어져 보인다.
     그래서 색을 두 곳에 적지 않고 이 표 하나만 본다. */
const OIL_TONE = {
  low: 'var(--violet)', turn: 'var(--green)', surge: 'var(--accent)',
  adjust: 'var(--blue)', rebound: 'var(--teal)',
};

/** SVG 글자 폭 어림값(px). 겹침을 피하려고 '그릴지 말지' 판단할 때만 쓴다.
 *  ★ 정확한 측정은 렌더 전에는 알 수 없으므로 넉넉하게 잡는다 —
 *    좁으면 라벨을 빼는 쪽이 겹쳐 보이는 것보다 낫다. */
function vizTextW(txt, fs) {
  let w = 0;
  for (const c of String(txt || '')) w += (/[가-힣ㄱ-ㅎ]/.test(c) ? 1.0 : 0.56) * fs;
  return w;
}

/** 구간 색 — 유가 표에 없으면 운임지수 표로 떨어진다 */
function oilToneOf(e) {
  return (e && (OIL_TONE[e.tone] || XSII_TONE[e.tone])) || 'var(--slate)';
}

/** 행 하나를 '날짜'로 — 구간(from~to)과 비교하기 위한 키.
 *  연도 기준(term='y')은 구간이 월 단위라 대응이 안 되므로 null 을 돌려
 *  음영을 아예 그리지 않는다(억지로 칠하지 않는다). */
function oilRowDay(period, term) {
  const p = String(period || '');
  if (term === 'y') return null;
  if (term === 'd') return p.slice(0, 10);
  return p.slice(0, 7) + '-15';   // 월·주 기준은 그 달의 가운데로 본다
}

/** 구간별로 차트에서 차지하는 인덱스 범위 [a,b]. 없으면 제외 */
function oilBandRanges(rows, term) {
  const eras = (_oilIns && Array.isArray(_oilIns.eras)) ? _oilIns.eras : [];
  if (!eras.length || !rows.length) return [];
  const days = rows.map((r) => oilRowDay(r.period, term));
  if (days.some((d) => d == null)) return [];     // 연도 기준이면 그리지 않는다
  return eras.map((e, idx) => {
    let a = -1, b = -1;
    days.forEach((d, i) => {
      if (d >= e.from && d <= e.to) { if (a < 0) a = i; b = i; }
    });
    return (a < 0) ? null : { idx: idx, a: a, b: b, era: e, color: oilToneOf(e) };
  }).filter(Boolean);
}

/** 전망 방향 → 아이콘·색 */
const XSII_DIR = {
  up: { icon: '▲', cls: 'up' },
  flat: { icon: '▬', cls: 'flat' },
  unsure: { icon: '?', cls: 'na' },
};

/** 해설 데이터 로드. 실패해도 차트·통계는 그대로 나온다. */
async function fetchXsiInsights() {
  try {
    const res = await fetch(XSII_DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _xsiiData = d;
  } catch (e) {
    _xsiiData = null;
    console.warn('[xsi-insights] 로드 실패:', e);
  }
  renderMaterial();
}

/** 지금 고른 항로가 구간 설명의 기준 항로인가 */
function xsiiOnBase() {
  const d = _xsiiData;
  return !!(d && d.baseRoute && _xsiRoute === d.baseRoute);
}

/** 날짜를 차트의 소수 인덱스로. 축 밖이면 null */
function xsiiIdx(dates, day) {
  if (!dates || dates.length < 2 || !day) return null;
  if (day <= dates[0]) return 0;
  if (day >= dates[dates.length - 1]) return dates.length - 1;
  let lo = 0, hi = dates.length - 1;
  while (lo < hi) {                       // 날짜가 오름차순이라 이분 탐색이면 충분하다
    const mid = (lo + hi) >> 1;
    if (dates[mid] < day) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** ① 차트 안 구간 음영 + 라벨. 기준 항로일 때만 그린다. */
function xsiiBandsSvg(slice, X, padT, plotH) {
  // ★ 항로를 가리지 않고 그린다. 구간은 '언제였나'를 가리키는 시간 눈금이므로
  //   어느 항로에서 봐도 같은 자리다. 다만 구간에 붙은 '설명'은 극동→북유럽을
  //   보고 쓴 것이라, 그 사실은 아래 안내 문구로 계속 알린다.
  const eras = (_xsiiData && Array.isArray(_xsiiData.eras)) ? _xsiiData.eras : [];
  if (!eras.length || !slice) return '';
  const first = slice.dates[0], last = slice.dates[slice.dates.length - 1];
  return eras.map((e) => {
    if (e.to < first || e.from > last) return '';     // 화면 밖 구간은 그리지 않는다
    const a = xsiiIdx(slice.dates, e.from < first ? first : e.from);
    const b = xsiiIdx(slice.dates, e.to > last ? last : e.to);
    if (a == null || b == null || b <= a) return '';
    const x0 = X(a), x1 = X(b), w = x1 - x0;
    if (w < 6) return '';                             // 너무 좁으면 라벨이 겹친다
    const c = XSII_TONE[e.tone] || 'var(--slate)';
    return `<g class="xsii-band">
      <rect x="${x0.toFixed(1)}" y="${padT}" width="${w.toFixed(1)}" height="${plotH.toFixed(1)}"
        fill="${c}" opacity=".06"/>
      <line x1="${x1.toFixed(1)}" y1="${padT}" x2="${x1.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}"
        stroke="${c}" stroke-width="1" stroke-dasharray="2 3" opacity=".45"/>
      ${w > 44 ? `<text x="${(x0 + w / 2).toFixed(1)}" y="${(padT + 8).toFixed(1)}" text-anchor="middle"
        font-size="7.5" font-weight="700" fill="${c}" paint-order="stroke"
        stroke="var(--surface-1)" stroke-width="2.5">${escapeHtml(e.span)}</text>` : ''}
    </g>`;
  }).join('');
}

/** ① 구간 설명 말풍선 4개 (차트 아래). 화면 밖 구간은 흐리게 둔다. */
function xsiiEras(slice) {
  const eras = (_xsiiData && Array.isArray(_xsiiData.eras)) ? _xsiiData.eras : [];
  if (!eras.length) return '';
  const first = slice ? slice.dates[0] : null;
  const last = slice ? slice.dates[slice.dates.length - 1] : null;
  const onBase = xsiiOnBase();
  const cards = eras.map((e) => {
    // 화면에 걸치는 구간만 진하게 — 항로와는 무관하고 '고른 기간'으로만 판단한다
    const shown = first && !(e.to < first || e.from > last);
    return `<div class="xsii-era${shown ? '' : ' is-off'}" style="--xe:${XSII_TONE[e.tone] || 'var(--slate)'}">
      <div class="xsii-era__span">${escapeHtml(e.span)}</div>
      <div class="xsii-era__title">${escapeHtml(e.title || '')}</div>
      <p class="xsii-era__detail">${escapeHtml(e.detail || '')}</p>
    </div>`;
  }).join('');
  // ★ 기준 항로가 아닐 때는 오해가 없도록 먼저 밝힌다.
  const base = (_xsiiData && _xsiiData.baseRouteName) || '극동→북유럽';
  // 구간 자체는 모든 항로에 그리되, 설명이 어느 항로를 보고 쓴 것인지는 계속 밝힌다.
  const warn = onBase
    ? `<div class="ii-cap">구간 설명은 ${escapeHtml(base)} 항로를 기준으로 조사한 참고용 서술입니다.</div>`
    : `<div class="xsii-note">이 구간 설명은 <b>${escapeHtml(base)}</b> 항로 기준 참고용이며,
        지금 보고 있는 항로의 실제 흐름과 다를 수 있습니다.</div>`;
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">① 운임지수 추이 — 구간별 흐름</h3>
    ${warn}
    <div class="xsii-eras">${cards}</div>
  </div>`;
}

/** ② 주요 변동요인 4장 — 해상 정시성의 .sr-fac 문법을 그대로 쓴다 */
function xsiiFactors() {
  const list = (_xsiiData && Array.isArray(_xsiiData.factors)) ? _xsiiData.factors : [];
  if (!list.length) return '';
  const cards = list.map((f) => `<div class="sr-fac sr-fac--${escapeHtml(f.level || 'mid')}">
      <div class="sr-fac__top">
        <span class="sr-fac__ico" aria-hidden="true">${escapeHtml(f.icon || '•')}</span>
        <span class="sr-fac__title">${escapeHtml(f.title || '')}</span>
      </div>
      <div class="xsii-fac__tags">
        ${f.dirLabel ? `<span class="xsii-dir xsii-dir--${escapeHtml(f.dir || 'both')}">${escapeHtml(f.dirLabel)}</span>` : ''}
        ${f.impact ? `<span class="sr-fac__tag">영향도 ${escapeHtml(f.impact)}</span>` : ''}
      </div>
      <p class="sr-fac__desc">${escapeHtml(f.desc || '')}</p>
    </div>`).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">② 주요 변동요인</h3>
    <div class="sr-facs xsii-facs">${cards}</div>
  </div>`;
}

/** ③ 향후 전망 — 단기·중기·장기 */
function xsiiOutlook() {
  const list = (_xsiiData && Array.isArray(_xsiiData.outlook)) ? _xsiiData.outlook : [];
  if (!list.length) return '';
  const rows = list.map((o) => {
    const t = XSII_DIR[o.tone] || XSII_DIR.flat;
    return `<div class="xsii-ol xsii-ol--${escapeHtml(o.tone || 'flat')}">
      <div class="xsii-ol__term">${escapeHtml(o.term || '')}</div>
      <div class="xsii-ol__dir"><span class="ms-badge__val ${t.cls}">${escapeHtml(t.icon)} ${escapeHtml(o.dir || '')}</span></div>
      <p class="xsii-ol__detail">${escapeHtml(o.detail || '')}</p>
    </div>`;
  }).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">향후 전망 (정성)</h3>
    <div class="xsii-ols">${rows}</div>
    <div class="ii-cap">참고용 정성적 전망입니다. 데이터로 계산한 수치 예측이 아니며 확정된 예측도 아닙니다.</div>
  </div>`;
}

/* ══ 3개월 전망 엔진 ══════════════════════════════════════════════════════
   ★★ 통계 모델이 아니다. 최근 12개월 값에 직선 하나를 맞춰 3개월 늘리고,
     같은 기간 일간 등락의 표준편차로 위아래 폭을 잡은 것이 전부다.
     화면 어디에도 '예측'이라 적지 않고 '추정치·참고용'이라고만 적는다.
   ★ 확률(30/50/20)은 계산한 값이 아니라 시나리오 구분을 위한 가정치다 —
     표 아래에 그렇게 밝힌다. */
const XSI_FC_DAYS = 63;      // 3개월 ≈ 거래일 63일
const XSI_FC_MONTHS = 12;    // 추세·변동성을 재는 창

/** 최근 XSI_FC_MONTHS 개월 구간만 잘라낸다. 관측이 모자라면 null */
function xsiRecent(series) {
  if (!series || !series.dates || series.dates.length < 60) return null;
  const dts = series.dates, last = dts[dts.length - 1];
  const cut = String(Number(last.slice(0, 4)) - 1) + last.slice(4);
  let i = 0;
  while (i < dts.length && dts[i] < cut) i += 1;
  const v = series.values.slice(i);
  return (v.length >= 60) ? { dates: dts.slice(i), values: v } : null;
}

/** 3개월 전망. { base, med, up, dn, sd3, slope, chgPct, dir } · 못 내면 null */
function xsiForecast(series) {
  const w = xsiRecent(series);
  if (!w) return null;
  const v = w.values, n = v.length;
  // ① 추세 — 최근 12개월에 최소제곱 직선
  const xm = (n - 1) / 2, ym = v.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  v.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) * (i - xm); });
  if (!den) return null;
  const slope = num / den;
  const base = v[n - 1];
  const med = Math.max(0, base + slope * XSI_FC_DAYS);
  // ② 변동폭 — 같은 기간 일간 등락(로그)의 표준편차를 3개월 지평으로 늘린다
  const r = [];
  for (let i = 1; i < n; i += 1) if (v[i - 1] > 0 && v[i] > 0) r.push(Math.log(v[i] / v[i - 1]));
  if (r.length < 30) return null;
  const rm = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - rm) * (b - rm), 0) / (r.length - 1));
  const sd3 = sd * Math.sqrt(XSI_FC_DAYS);
  const chgPct = base ? ((med - base) / base) * 100 : 0;
  return {
    base: base, med: med,
    up: base * Math.exp(sd3), dn: base * Math.exp(-sd3),
    sd3: sd3 * 100, slope: slope, chgPct: chgPct,
    dir: (chgPct > 3 ? 'up' : (chgPct < -3 ? 'down' : 'flat')),
    from: w.dates[0], to: w.dates[w.dates.length - 1],
  };
}

/** 지수값 표기(정수 + 천단위) */
function xsiNum(v) {
  return (v == null || !isFinite(v)) ? '—' : Math.round(v).toLocaleString('en-US');
}

/** 3개월 뒤가 몇 월인지 — 'YYYY-MM' */
function xsiPlus3(day) {
  const y = Number(String(day).slice(0, 4)), m = Number(String(day).slice(5, 7));
  const t = y * 12 + (m - 1) + 3;
  return String(Math.floor(t / 12)) + '-' + String((t % 12) + 1).padStart(2, '0');
}

/* ── ① 우측 '향후 3개월 전망' 미니 차트 ────────────────────────────────── */
function xsiFcMini(fc) {
  if (!fc) return '';
  const W = 240, H = 92, padL = 8, padR = 44, padT = 12, padB = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const lo = Math.min(fc.dn, fc.base, fc.med), hi = Math.max(fc.up, fc.base, fc.med);
  const pad = (hi - lo) * 0.15 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const Y = (v) => padT + (1 - (v - y0) / ((y1 - y0) || 1)) * plotH;
  const xA = padL + 6, xB = padL + plotW;
  return `<svg class="xsi-fc__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
      role="img" aria-label="향후 3개월 추정 범위">
    <path d="M${xA} ${Y(fc.base).toFixed(1)} L${xB} ${Y(fc.up).toFixed(1)}
      L${xB} ${Y(fc.dn).toFixed(1)} Z" fill="var(--blue)" opacity=".13"/>
    <line x1="${xA}" y1="${Y(fc.base).toFixed(1)}" x2="${xB}" y2="${Y(fc.med).toFixed(1)}"
      stroke="var(--blue)" stroke-width="1.8" stroke-dasharray="4 3"/>
    <circle cx="${xA}" cy="${Y(fc.base).toFixed(1)}" r="3" fill="var(--ink)"/>
    <text x="${xA - 2}" y="${(Y(fc.base) - 6).toFixed(1)}" font-size="8.5" font-weight="700"
      fill="var(--ink)">현재</text>
    <text x="${xB + 4}" y="${(Y(fc.up) + 3).toFixed(1)}" font-size="8.5" font-weight="700"
      fill="var(--accent)">${escapeHtml(xsiNum(fc.up))}</text>
    <text x="${xB + 4}" y="${(Y(fc.med) + 3).toFixed(1)}" font-size="8.5" font-weight="800"
      fill="var(--blue)">${escapeHtml(xsiNum(fc.med))}</text>
    <text x="${xB + 4}" y="${(Y(fc.dn) + 3).toFixed(1)}" font-size="8.5" font-weight="700"
      fill="var(--blue)">${escapeHtml(xsiNum(fc.dn))}</text>
  </svg>`;
}

/** ① 우측 전망 박스 */
function xsiFcBox(fc, st) {
  if (!fc) {
    return `<div class="xsi-fc">
      <div class="xsi-fc__h">향후 3개월 전망 <span class="xsi-fc__tag">추정치</span></div>
      <div class="ii-cap">추세를 잴 만큼의 최근 관측치가 없어 전망을 내지 않았습니다.</div>
    </div>`;
  }
  const upTo = xsiPlus3(st.date || fc.to);
  return `<div class="xsi-fc">
    <div class="xsi-fc__h">향후 3개월 전망 <span class="xsi-fc__tag">추정치</span></div>
    <div class="xsi-fc__sub">${escapeHtml(st.date || '')} → ${escapeHtml(upTo)} · 최근 12개월 기준</div>
    ${xsiFcMini(fc)}
    <div class="xsi-fc__rows">
      <div class="xsi-fc__row"><span>상단</span><b class="ms-badge__val up">${escapeHtml(xsiNum(fc.up))}</b></div>
      <div class="xsi-fc__row"><span>중앙값<i>추세 연장</i></span><b>${escapeHtml(xsiNum(fc.med))}</b></div>
      <div class="xsi-fc__row"><span>하단</span><b class="ms-badge__val down">${escapeHtml(xsiNum(fc.dn))}</b></div>
    </div>
    <div class="ii-cap">※ 상기 전망치는 과거 데이터 기반의 통계적 추정이며 실제 시장 예측이 아닙니다</div>
  </div>`;
}

/* ── ③ 시나리오별 전망 표 ──────────────────────────────────────────────── */
function xsiScenarios(fc, st) {
  const list = (_xsiiData && Array.isArray(_xsiiData.scenarios)) ? _xsiiData.scenarios : [];
  if (!list.length) return '';
  if (!fc) {
    return `<div class="ii-panel">
      <h3 class="subhead ii-h">③ 향후 시나리오별 전망 <span class="xsi-fc__tag">추정치</span></h3>
      <div class="ii-cap">추세를 잴 만큼의 최근 관측치가 없어 시나리오를 내지 않았습니다.</div>
    </div>`;
  }
  const val = { up: fc.up, base: fc.med, down: fc.dn };
  const unit = xsiUnit();
  const rows = list.map((s) => {
    const v = val[s.key];
    const chg = fc.base ? ((v - fc.base) / fc.base) * 100 : null;
    return `<tr class="xsi-sc--${escapeHtml(s.tone)}">
      <th scope="row"><span class="xsi-sc__dot"></span>${escapeHtml(s.name)}
        <span class="xsi-sc__prob">약 ${Number(s.prob)}%</span></th>
      <td class="xsi-sc__val">${escapeHtml(xsiNum(v))}<span class="xsi-sc__u">${escapeHtml(unit)}</span></td>
      <td class="xsi-sc__chg">${xsiPct(chg)}</td>
      <td class="xsi-sc__basis">${escapeHtml(s.basis || '')}</td>
      <td><ul class="xsi-sc__as">${(s.assumptions || []).map((a) =>
        `<li>${escapeHtml(a)}</li>`).join('')}</ul></td>
    </tr>`;
  }).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">③ 향후 시나리오별 전망 <span class="xsi-fc__tag">추정치</span></h3>
    <div class="xsi-sc-wrap"><table class="xsi-sc">
      <thead><tr><th>시나리오</th><th>3개월 후 수준</th><th>최근값 대비</th><th>산출 기준</th><th>주요 가정</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="ii-cap">※ 확률(%)과 시나리오 구분은 통계 모델로 계산한 값이 아니라 참고용 가정치입니다.
      수준 값은 최근 ${XSI_FC_MONTHS}개월(${escapeHtml(fc.from)}~${escapeHtml(fc.to)})의 추세와
      일간 등락 표준편차(3개월 지평 ±${fc.sd3.toFixed(1)}%)로 계산한 통계적 추정이며 실제 시장 예측이 아닙니다.</div>
  </div>`;
}

/* ── ④ 시사점 및 의사결정 활용 방안 (시간대별) ─────────────────────────── */
function xsiActions() {
  const list = (_xsiiData && Array.isArray(_xsiiData.actions)) ? _xsiiData.actions : [];
  if (!list.length) return '';
  const cols = list.map((a) => `<div class="ii-imp ii-imp--${escapeHtml(a.tone || 'info')}">
      <div class="ii-imp__h">${iiImpIcon(a.tone || 'info')}${escapeHtml(a.title || '')}</div>
      <ul class="xsi-act">${(a.items || []).map((t) => `<li>${iiEmph(t)}</li>`).join('')}</ul>
    </div>`).join('');
  const upd = (_xsiiData && _xsiiData.updated) ? String(_xsiiData.updated) : null;
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">④ 시사점 및 의사결정 활용 방안</h3>
    <div class="ii-imps">${cols}</div>
    <div class="ii-cap">시황 해설은 주기적으로 갱신됩니다${upd ? ' (최종 갱신: ' + escapeHtml(upd) + ')' : ''}</div>
  </div>`;
}

/* ── 하단 핵심 인사이트 ────────────────────────────────────────────────
   ★ 항로마다 최근 흐름이 다르므로, 3개월 추세 방향(상승·보합·하락)에 맞는
     문장을 고른다. 문장 자체는 JSON 에 있고 코드가 지어내지 않는다. */
function xsiInsightBox(fc) {
  const ins = (_xsiiData && _xsiiData.insight) || null;
  if (!ins) return '';
  const key = fc ? fc.dir : 'flat';
  const lead = ins[key] || ins.flat;
  if (!lead) return '';
  const trend = fc
    ? `<span class="xsi-ins__trend">최근 12개월 추세 연장 기준 ${(fc.chgPct > 0 ? '+' : '')
      + fc.chgPct.toFixed(1)}% <i>추정</i></span>` : '';
  return `<div class="xsi-ins">
    <div class="xsi-ins__h">핵심 인사이트${trend}</div>
    <p class="xsi-ins__lead">${escapeHtml(lead)}</p>
    ${ins.action ? `<p class="xsi-ins__act">→ ${escapeHtml(ins.action)}</p>` : ''}
  </div>`;
}

/* ── 지표 설명 ────────────────────────────────────────────────────────────
   해상 정시성 위젯의 .sr-terms / .sr-termtable 을 그대로 쓴다 —
   두 위젯이 같은 표로 읽히도록 새 클래스를 만들지 않는다.
   ★ 문장은 public/data/xsi-insights.json 의 terms 에만 있고, 코드는 그 안의
     {route}·{last}·{krw} 같은 자리표시를 실데이터로 바꿔 넣는 일만 한다. */

/** 현재값이 산출 이래 범위에서 몇 % 지점인지. 관측이 모자라면 null */
function xsiPercentile(series, v) {
  const vals = (series && series.values) || [];
  if (vals.length < 20 || v == null) return null;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  if (!(mx > mn)) return null;
  return Math.round(((v - mn) / (mx - mn)) * 100);
}

/** 백분위 → 수준 키 */
function xsiLevelKey(pct) {
  if (pct == null) return null;
  return pct < 34 ? 'low' : (pct < 67 ? 'mid' : 'high');
}

/** 자리표시 치환 — 없는 키는 그대로 남겨 눈에 띄게 한다. */
function xsiFill(text, map) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) =>
    (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m));
}

/** 추세 해석 줄 — 세 국면을 모두 보여 주고 지금 국면만 진하게 강조한다. */
function xsiTrendRow(t, dir, st, fc) {
  const items = [
    { key: 'up', dot: '🔴', label: '상승세' },
    { key: 'down', dot: '🟢', label: '하락세' },
    { key: 'flat', dot: '🔵', label: '횡보' },
  ];
  const cells = items.map((it) => {
    const on = (it.key === dir);
    return '<span class="xsi-tr' + (on ? ' is-on' : '') + '">'
      + it.dot + ' ' + escapeHtml(it.label) + ' → '
      + escapeHtml((t.trend && t.trend[it.key]) || '') + '</span>';
  }).join('');
  // 무엇을 근거로 지금 국면을 골랐는지 밝힌다(숫자를 지어내지 않는다)
  const basis = [];
  if (fc) basis.push('최근 12개월 추세 ' + (fc.chgPct > 0 ? '+' : '') + fc.chgPct.toFixed(1) + '%');
  if (st && st.d1 != null) basis.push('1일 ' + (st.d1 > 0 ? '+' : '') + st.d1.toFixed(2) + '%');
  if (st && st.annReturn != null) basis.push('연간 수익률 ' + (st.annReturn > 0 ? '+' : '') + st.annReturn.toFixed(2) + '%');
  return '<div class="xsi-trs">' + cells + '</div>'
    + (basis.length ? '<div class="xsi-tr__basis">판단 근거: ' + escapeHtml(basis.join(' · ')) + '</div>' : '');
}

/** 지표 설명 표. 항로를 고르지 않았거나 문구가 없으면 ''(빈 표를 만들지 않는다) */
function xsiTermsHtml(r, fc) {
  const t = (_xsiiData && _xsiiData.terms) || null;
  if (!t || !r) return '';
  const st = r.stats || {};
  const rate = krwRate('USD');
  const pct = xsiPercentile(r.series, st.last);
  const lvl = xsiLevelKey(pct);
  const dir = fc ? fc.dir : 'flat';
  const map = {
    route: r.name || '',
    last: st.last == null ? '—' : Math.round(st.last).toLocaleString('en-US'),
    lastPlain: st.last == null ? '—' : Math.round(st.last).toLocaleString('en-US'),
    krw: (st.last != null && rate != null) ? ('약 ' + (fmtKrwShort(st.last * rate) || '')) : '원화 환산 불가',
  };
  // '현재 판단' — 과거 대비 수준 + 최근 방향성. 두 조각 모두 JSON 문구를 쓴다.
  const judge = [
    '현재 운임은',
    (lvl && t.level) ? t.level[lvl] : '과거 대비 수준을 판단할 관측치가 모자라',
    (t.move && t.move[dir]) || '',
  ].filter(Boolean).join(' ');
  const pctNote = (pct != null)
    ? '<div class="xsi-tr__basis">산출 이래 최저~최고 범위에서 ' + pct + '% 지점 (기간 '
      + escapeHtml(r.series.dates[0]) + '~' + escapeHtml(r.series.dates[r.series.dates.length - 1]) + ')</div>'
    : '';

  const rows = [
    ['운임이란?', escapeHtml(xsiFill(t.what, map))],
    ['수치 읽는 법', escapeHtml(xsiFill(t.read, map))],
    ['추세 해석', xsiTrendRow(t, dir, st, fc)],
    ['왜 중요한가?', escapeHtml(t.why || '')],
    ['주요 변동 요인', escapeHtml(t.drivers || '')],
    ['현재 판단', escapeHtml(judge) + pctNote],
  ].map(([k, v]) => '<tr><td class="sr-term__item">' + escapeHtml(k) + '</td><td>' + v + '</td></tr>').join('');

  return `<div class="sr-terms">
    <h3 class="subhead">지표 설명</h3>
    <div class="sr-term-wrap"><table class="sr-termtable">
      <thead><tr><th>항목</th><th>설명</th></tr></thead><tbody>${rows}</tbody>
    </table></div>
    <div class="sr-terms__ref">항로를 바꾸면 '수치 읽는 법'·'추세 해석'·'현재 판단'의 값과 표현이
      그 항로의 실제 데이터에 맞춰 다시 계산됩니다.</div>
  </div>`;
}

/** 위젯 전체 HTML. 데이터가 없으면 안내만 내고 레이아웃을 흔들지 않는다. */
function renderXsiHtml() {
  const head = xsiHero() + `<div class="viz-head"><div>
      <div class="viz-sub">주요 8개 항로 컨테이너 스팟 운임지수 · 일별</div>
      <div class="viz-sub2">항로를 고르면 그 구간의 공표 통계와 지수 추이를 보여줍니다${_xsiData
        && _xsiData.unitNote ? ' · ' + escapeHtml(_xsiData.unitNote) : ''}</div>
    </div></div>`;
  const cap = capSrc('출처: Compass Financial Technologies (Xeneta Shipping Index)',
    [{ text: 'XSI-C 지수 목록', url: (_xsiData && _xsiData.sourceUrl) || 'https://www.compassft.com/indices/' }]);

  if (!_xsiData) {
    return `<div class="viz-root viz-figure xsi-figure">${head}`
      + '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>' + `${cap}</div>`;
  }
  if (_xsiData.status === 'error' || !(_xsiData.routes || []).length) {
    return `<div class="viz-root viz-figure xsi-figure">${head}`
      + `<div class="chart-empty">데이터를 불러오지 못했습니다${_xsiData.reason ? ' (' + escapeHtml(_xsiData.reason) + ')' : ''}</div>`
      + `${cap}</div>`;
  }

  const r = xsiRoute();
  const tabs = `<div class="icis-years xsi-routes">${_xsiData.routes.map((x) =>
    `<button class="icis-year xsi-route${x.key === _xsiRoute ? ' is-active' : ''}" data-route="${escapeHtml(x.key)}">${escapeHtml(x.short || x.name)}</button>`).join('')}</div>`;
  if (!r) {
    // 항로를 고르기 전 — 버튼만 두고 값은 하나도 내지 않는다(ICIS 연도 칩과 같은 규칙)
    _xsiChart = null;
    return `<div class="viz-root viz-figure xsi-figure">${head}
      ${tabs}
      <div class="icis-prompt">항로를 선택하세요</div>
      ${cap}
    </div>`;
  }

  const st = r.stats || {};
  const color = 'var(--blue)';
  const cards = XSI_STATS.map((f) => `<div class="xsi-stat">
      <span class="xsi-stat__ico" aria-hidden="true">${escapeHtml(f.icon || '•')}</span>
      <div class="xsi-stat__body">
        <div class="xsi-stat__lbl"><span class="xsi-stat__ko">${escapeHtml(f.label)}${f.def
          ? gcAbbr('ⓘ', f.tip + ' — ' + f.def) : ''}</span><span class="xsi-stat__en">${escapeHtml(f.tip)}</span></div>
        <div class="xsi-stat__val">${xsiPct(st[f.key], f.plain)}</div>
      </div>
    </div>`).join('');

  const lead = `<div class="xsi-lead">
    <div class="xsi-lead__box">
      <div class="xsi-lead__lbl">최근값${gcAbbr('ⓘ', xsiValueTip())}</div>
      <div class="xsi-lead__val">${st.last == null ? '—' : Math.round(st.last).toLocaleString('en-US')}<span class="xsi-lead__unit">${escapeHtml(xsiUnit())}</span></div>
      ${(st.last != null && krwRate('USD') != null)
        ? `<div class="xsi-lead__krw">≈ ${escapeHtml(fmtKrwShort(st.last * krwRate('USD')) || '')}</div>` : ''}
      <div class="xsi-lead__sub">${escapeHtml(st.date || '')} 기준 · ${escapeHtml(r.code || '')}${r.inception ? ' · 산출 개시 ' + escapeHtml(r.inception) : ''}</div>
    </div>
    <div class="xsi-lead__name">${escapeHtml(r.name || '')}
      <a class="src-link" href="${escapeHtml(safeUrl(r.url) || '#')}" target="_blank" rel="noopener noreferrer">원본 페이지 ›</a></div>
  </div>`;

  const hasSeries = r.series && r.series.dates && r.series.dates.length;
  const chips = hasSeries ? `<div class="icis-years xsi-ranges">${XSI_RANGES.map((x) =>
    `<button class="icis-year xsi-range${x.key === _xsiRange ? ' is-active' : ''}" data-xrange="${x.key}">${x.label}</button>`).join('')}</div>` : '';
  const slice = (hasSeries && _xsiRange) ? xsiSlice(r.series, _xsiRange) : null;
  // ★ 단위는 차트 위 캡션으로 뺀다. SVG 안 Y축 옆에 두면 맨 위 눈금 숫자와
  //   같은 줄을 써서 겹쳤고(8개 항로 전부), 오른쪽 정렬 탓에 뷰박스 왼쪽 밖으로도 나갔다.
  /* 차트 — 기간 칩을 직접 누른 뒤에만 그린다(섹션 공통 규칙).
     항로만 고른 상태에서는 안내 문구만 두고, 통계·전망·②③④는 그대로 낸다
     (그 값들은 기간과 무관한 항로 단위 수치다). */
  let chart;
  if (!hasSeries) {
    chart = '<div class="ii-cap">이 항로는 그래프 데이터를 받지 못해 통계만 표시합니다.</div>';
  } else if (!slice) {
    _xsiChart = null;
    chart = '<div class="icis-prompt">기간을 선택하세요</div>';
  } else {
    chart = vizUnitCap(xsiUnit(), (_xsiData && _xsiData.currency) || 'USD')
      + buildXsiChart(slice, color) + '<div class="viz-tooltip" id="xsiTooltip"></div>'
      + `<div class="ii-cap">그래프 구간 ${escapeHtml(slice.dates[0])} ~ ${escapeHtml(slice.dates[slice.dates.length - 1])} · ${slice.dates.length.toLocaleString('ko-KR')}일</div>`;
  }

  const note = _xsiData.statsNote
    ? `<div class="ii-cap">${escapeHtml(_xsiData.statsNote)}${_xsiData.updatedAt ? ' · 수집 ' + escapeHtml(_xsiData.updatedAt) : ''}</div>` : '';

  // 3개월 전망 — ① 우측 박스와 ③ 시나리오 표가 같은 계산을 나눠 쓴다
  const fc = hasSeries ? xsiForecast(r.series) : null;

  // ① 차트(좌) + 향후 3개월 전망(우)
  /* ★ 기간 칩을 직접 누른 뒤에만 아래 전부를 낸다(섹션 공통 규칙).
       항로만 고른 상태에서 보이는 것은 배너 · 요약박스(최근값 + 통계 8박스) ·
       기간 칩과 '기간을 선택하세요' 안내까지다.
     ★★ 3개월 전망 박스 · ②변동요인 · 정성 전망 · ③시나리오 · ④시사점 ·
       핵심 인사이트 · 지표 설명은 전부 기간 선택 뒤로 보낸다. 이 값들은
       항로 단위로도 계산되지만, 기간을 고르지 않았는데 해설이 먼저 떠 있는
       것을 없애는 것이 이 규칙의 목적이다. */
  const chartRow = slice
    // ★ 들여쓰기를 예전 그대로 둔다 — 기간을 고른 뒤의 출력이 수정 전과
    //   한 글자도 달라지지 않게 해서 무변경을 증명할 수 있게 한다.
    ? `<div class="xsi-row">
    <div class="xsi-row__main">${chips}${chart}</div>
    ${xsiFcBox(fc, st)}
  </div>`
    // 기간 미선택 — 칩만 두고 오른쪽 전망 박스는 만들지 않는다(빈 칸이 남지 않게)
    : `${chips}${chart}`;

  const panels = slice
    ? xsiiEras(slice) + xsiiFactors() + xsiiOutlook() + xsiScenarios(fc, st) + xsiActions()
    : '';

  return `<div class="viz-root viz-figure xsi-figure">${head}
    ${tabs}
    ${lead}
    <div class="xsi-stats">${cards}</div>
    ${chartRow}
    ${note}
    ${panels}
    ${slice ? xsiInsightBox(fc) : ''}
    ${cap}
    ${slice ? xsiTermsHtml(r, fc) : ''}
  </div>`;
}

/** 항로 탭 · 기간 칩 · 차트 툴팁 배선 */
function wireXsi(root) {
  const fig = root.querySelector('.xsi-figure');
  if (!fig) return;
  fig.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('[data-route]');
    if (t) {
      // 항로를 바꾸면 기간 선택도 초기화한다 — 새 항로에서 기간을 다시 골라야
      // 차트가 나온다(KOIMA 부문 전환과 같은 규칙).
      _xsiRoute = t.getAttribute('data-route');
      _xsiRange = null; _xsiChart = null;
      renderMaterial();
      return;
    }
    const g = e.target.closest && e.target.closest('[data-xrange]');
    if (g) { _xsiRange = g.getAttribute('data-xrange'); renderMaterial(); }
  });

  const tip = document.getElementById('xsiTooltip');
  const svg = fig.querySelector('.xsi-svg');
  if (!tip || !svg || !_xsiChart) return;
  const overlay = svg.querySelector('.xsi-overlay');
  const cross = svg.querySelector('.xsi-cross');
  const dots = svg.querySelector('.xsi-dots');
  const c = _xsiChart, gm = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  const move = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const sx = (clientX - rect.left) * (gm.W / rect.width);
    let i = gm.n === 1 ? 0 : Math.round(((sx - gm.padL) / ((gm.X(gm.n - 1) - gm.padL) || 1)) * (gm.n - 1));
    i = Math.max(0, Math.min(gm.n - 1, i));
    const cx = gm.X(i), v = c.values[i];
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    dots.innerHTML = `<circle cx="${cx.toFixed(1)}" cy="${gm.Y(v).toFixed(1)}" r="3.5" fill="${c.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
    const rate = krwRate('USD');
    const krw = (rate != null) ? ` <span class="op-krw op-krw--tt">≈ ${escapeHtml(fmtKrwShort(v * rate) || '')}</span>` : '';
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.dates[i])}</div>`
      + `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${c.color}"></span><span>운임</span><span class="viz-tt-val">${v.toLocaleString('en-US')} USD${krw}</span></div>`;
    const fr = fig.getBoundingClientRect();
    let left = clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  };
  overlay.addEventListener('mousemove', (evt) => move(evt.clientX, evt.clientY));
  overlay.addEventListener('mouseleave', clear);
  // 모바일: 탭·드래그에도 값이 뜨게 한다(다른 차트와 같은 방식)
  overlay.addEventListener('touchstart', (evt) => {
    const t = evt.touches[0]; if (t) move(t.clientX, t.clientY);
  }, { passive: true });
  overlay.addEventListener('touchmove', (evt) => {
    const t = evt.touches[0]; if (t) move(t.clientX, t.clientY);
  }, { passive: true });
  overlay.addEventListener('touchend', clear, { passive: true });
}

/* 순수 추가: 정시성 '지표 설명' 정적 텍스트 (데이터 수집·API 없음).
   ★ 스폰지 카드의 ICIS_TERMS/icisTermsTable과 표기 패턴만 맞추고 공통화하지 않음. */
const SR_TERMS = [
  { item: '정시성이란',
    desc: '선사가 사전에 공표한 도착 예정일에 실제로 도착한 선박의 비율. '
        + 'Sea-Intelligence가 전 세계 34개 주요 항로, 60여 개 선사를 대상으로 매월 집계해 발표한다.' },
  { item: '수치 읽는 법',
    desc: '60%는 열 척 중 여섯 척만 예정일에 도착했다는 뜻이다. '
        + '나머지 네 척은 지연되었으며, 통상 수일에서 2주 이상 늦어진다.' },
  { item: '왜 중요한가',
    desc: '정시성이 낮아지면 원자재 입고가 늦어져 생산 계획에 차질이 생기고, 안전재고를 늘려야 해 재고 비용이 증가한다. '
        + '또한 지연이 길어질수록 운임과 체선료 부담도 함께 커진다.' },
  { item: '주요 변동 요인',
    desc: '항만 혼잡, 기상 악화, 선사 파업, 지정학적 항로 차단(수에즈·파나마 등), 물동량 급증에 따른 병목.' },
];

// '수준별 해석' 행에만 색 점 사용 (원활=초록 / 보통=파랑 / 지연=주황 / 심각=빨강)
const SR_LEVELS = [
  { range: '70% 이상', name: '원활', note: '팬데믹 이전 평시 수준', color: '#12B981' },
  { range: '55~70%',   name: '보통', note: '최근 몇 년간의 일반적 범위', color: '#3B82F6' },
  { range: '40~55%',   name: '지연', note: '공급망 차질이 체감되는 구간', color: '#F59E0B' },
  { range: '40% 미만', name: '심각', note: '2021~2022년 물류 대란 수준', color: '#C8102E' },
];

/** 순수 추가: 출처 아래 '지표 설명' 표(2열: 항목/설명). 정적 텍스트라 항상 표시. */
function renderSrTermsHtml() {
  const levels = SR_LEVELS.map((l) =>
    `<div class="sr-lv"><span class="icis-dot" style="background:${l.color}"></span>
      <b class="sr-lv__range">${escapeHtml(l.range)}</b>
      <span class="sr-lv__name">${escapeHtml(l.name)}</span>
      <span class="sr-lv__note">— ${escapeHtml(l.note)}</span></div>`).join('');
  const rows = SR_TERMS.map((t) =>
    `<tr><td class="sr-term__item">${escapeHtml(t.item)}</td><td>${escapeHtml(t.desc)}</td></tr>`);
  // '수준별 해석'은 '수치 읽는 법' 바로 다음(2번째)에 배치
  rows.splice(2, 0, `<tr><td class="sr-term__item">수준별 해석</td><td><div class="sr-lvs">${levels}</div></td></tr>`);
  return `<div class="sr-terms">
    <h3 class="subhead">지표 설명</h3>
    <div class="sr-term-wrap"><table class="sr-termtable">
      <thead><tr><th>항목</th><th>설명</th></tr></thead><tbody>${rows.join('')}</tbody>
    </table></div>
    <div class="sr-terms__ref">함께 보면 좋은 지표: 글로벌 컨테이너 운임지수(FBX) — 운임이 급등하는 국면에서는 정시성도 함께 악화되는 경향이 있다.</div>
  </div>`;
}

/** 순수 추가: 출처 아래 '다음 달 전망'(정시성). 예측 없으면 '' 반환(섹션 숨김).
 *  숫자는 백엔드 계산(_srForecast), 문장(summary/seasonal/yoy/caution)만 AI. */
function renderSrForecastHtml() {
  const fc = _srForecast;
  if (!fc) return '';
  const gen = fc.generated_at ? `<span class="sr-fc__gen">예측 생성 ${escapeHtml(fc.generated_at)}</span>` : '';
  const title = `<h3 class="subhead sr-fc__title">다음 달 전망 <span class="sr-fc__month">(${escapeHtml(fc.target_month || '')} 예측)</span>${gen}</h3>`;
  const dist = (fc.last_data_month && fc.months_ahead != null)
    ? `<div class="sr-fc__dist">최신 데이터 ${escapeHtml(fc.last_data_month)} 기준 · ${fc.months_ahead}개월 후 추정</div>` : '';
  const monthsTxt = (fc.months_ahead != null) ? (fc.months_ahead + '개월') : '수개월';
  const disc = `<div class="sr-fc__disc">최신 데이터로부터 ${monthsTxt} 후를 추정한 값으로, 과거 계절 패턴에 주로 의존합니다. 예측 거리가 멀수록 오차가 커지며, 기상·파업·항만 혼잡·지정학적 요인 등 외부 변수는 반영되지 않았습니다.</div>`;
  if (fc.forecast_status === 'insufficient') {
    return `<div class="sr-fc">${title}${dist}
      <div class="sr-fc__na">데이터 부족 <span class="sr-fc__reason">(${escapeHtml(fc.reason || '')})</span></div>
      ${disc}</div>`;
  }
  const rcls = fc.risk === '상방' ? 'up' : (fc.risk === '하방' ? 'down' : 'flat');
  const dcls = (v) => (v == null ? 'flat' : (v > 0 ? 'up' : (v < 0 ? 'down' : 'flat')));
  const pp = (v) => (v == null ? '— ' : `${v > 0 ? '▲' : (v < 0 ? '▼' : '–')} ${Math.abs(v).toFixed(1)}%p`);
  const deltaLabel = escapeHtml(fc.delta_label || '직전 실측 대비');
  const path = (Array.isArray(fc.path) && fc.path.length)
    ? `<div class="sr-fc__path">${fc.path.map((p) => `${escapeHtml(p.label)} ${Number(p.v).toFixed(1)}`).join(' → ')} <span class="sr-fc__path-tag">(추정)</span></div>` : '';
  const ai = [
    fc.summary ? `<div class="sr-fc__ai">${escapeHtml(fc.summary)}</div>` : '',
    fc.seasonal_txt ? `<div class="sr-fc__ai"><b>계절 패턴</b> ${escapeHtml(fc.seasonal_txt)}</div>` : '',
    fc.yoy_txt ? `<div class="sr-fc__ai"><b>전년 대비</b> ${escapeHtml(fc.yoy_txt)}</div>` : '',
  ].join('');
  return `<div class="sr-fc">${title}${dist}
    <div class="sr-fc__row">
      <div class="sr-fc__big">${Number(fc.predict).toFixed(1)}<span class="sr-fc__pct">%</span>
        <span class="sr-fc__risk ${rcls}">${escapeHtml(fc.risk)}</span></div>
      <div class="sr-fc__cmps">
        <span class="sr-fc__cmp ${dcls(fc.delta_pp)}">${deltaLabel} ${pp(fc.delta_pp)}</span>
        <span class="sr-fc__cmp ${dcls(fc.yoy_pp)}">전년 동월 대비 ${pp(fc.yoy_pp)}</span>
        <span class="sr-fc__ci">신뢰구간 ${Number(fc.ci_low).toFixed(1)}% ~ ${Number(fc.ci_high).toFixed(1)}%</span>
      </div>
    </div>
    ${path}
    ${ai}
    ${fc.caution ? `<div class="sr-fc__caution">⚠ ${escapeHtml(fc.caution)}</div>` : ''}
    ${disc}
  </div>`;
}

/** 연도별 정시성(%) 선그래프 SVG (null 구간 선 끊김, 단일 연도 시 값 라벨) */
function buildSrChart(months, series, avg, ext) {
  const n = months.length;
  if (!n || !series.length) return '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
  const single = series.length === 1;
  // 추세 연장은 그 해의 선이 화면에 있을 때만 그린다(2023년만 보는 화면에 2026년을 얹지 않는다)
  const extOn = (ext && series.some((s) => s.key === ext.year)) ? ext : null;
  const extColor = extOn ? (series.find((s) => s.key === extOn.year) || {}).color : null;

  const all = series.flatMap((s) => s.values).filter((v) => v != null)
    .concat((avg || []).filter((v) => v != null))
    .concat(extOn ? extOn.band.flatMap((b) => [b.lo, b.hi]) : []);
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.12 || 5; ymin = Math.max(0, ymin - yp); ymax = Math.min(100, ymax + yp);

  const W = VIZ_W, H = VIZ_H, padL = 40, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val)}%</text>`;
  }).join('');

  // 월 이름(Jan…)은 짧아 12개를 모두 넣어도 겹치지 않는다(간격 40px 기준)
  const xticks = vizTickIdx(n, plotW, 40).map((i) =>
    `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(months[i])}</text>`).join('');

  const lines = series.map((s) => {
    let path = '', pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  // ── ① 기준 4개년 월평균 점선 ──
  let avgLine = '';
  if (avg && avg.some((v) => v != null)) {
    let p = '', pen = false;
    avg.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      p += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true;
    });
    if (p) {
      avgLine = `<path d="${p.trim()}" fill="none" stroke="var(--slate)" stroke-width="1.6"
        stroke-dasharray="5 3" stroke-linejoin="round" opacity=".85"/>`;
    }
  }

  // ── ① 추세 연장: 마지막 관측월 다음 칸부터 그 해의 선을 이어 그린다 ──
  let extShapes = '';
  if (extOn) {
    const c = extColor || 'var(--slate)';
    const x0 = X(extOn.from.mi), y0 = Y(extOn.from.v);
    const up = [`${x0.toFixed(1)} ${y0.toFixed(1)}`], dn = [`${x0.toFixed(1)} ${y0.toFixed(1)}`];
    extOn.band.forEach((b) => {
      up.push(`${X(b.mi).toFixed(1)} ${Y(b.hi).toFixed(1)}`);
      dn.push(`${X(b.mi).toFixed(1)} ${Y(b.lo).toFixed(1)}`);
    });
    let d = `M${x0.toFixed(1)} ${y0.toFixed(1)} `;
    extOn.values.forEach((p) => { d += `L${X(p.mi).toFixed(1)} ${Y(p.v).toFixed(1)} `; });
    extShapes = `<path d="M${up.concat(dn.reverse()).join(' L')} Z" fill="${c}" opacity=".10"/>`
      + `<path d="${d.trim()}" fill="none" stroke="${c}" stroke-width="1.8"
          stroke-dasharray="4 3" stroke-linejoin="round" opacity=".85"/>`
      + `<line x1="${x0.toFixed(1)}" y1="${padT}" x2="${x0.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}"
          stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3" opacity=".5"/>`
      + `<text x="${(x0 + 4).toFixed(1)}" y="${(padT + 8).toFixed(1)}" font-size="7.5" font-weight="700"
          fill="var(--muted)" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5">추세 연장</text>`;
  }

  const dots = series.map((s) => s.values.map((v, i) => v == null ? '' :
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1"/>`).join('')).join('');

  // 값 라벨: 점이 VIZ_LABEL_MAX_PTS 이하인 단일 연도 보기(12개월)에서만 표시.
  // 여러 연도를 겹쳐 보는 경우는 라벨 없이 툴팁으로만 값을 보여준다.
  const labels = (single && n <= VIZ_LABEL_MAX_PTS) ? series[0].values.map((v, i) => {
    if (v == null) return '';
    const x = X(i), y = Y(v) - 6;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_LABEL}" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${series[0].color}">${v.toFixed(1)}%</text>`;
  }).join('') : '';

  const yrs = sriAvgYears();
  const legend = `<div class="viz-legend">${series.map((s) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${s.color}"></span>${s.key}</span>`).join('')}`
    + (avgLine ? `<span class="viz-legend__item sr-legend-avg"><span class="sr-legend-dash"></span>${escapeHtml(yrs[0] + '~' + yrs[yrs.length - 1])} 월평균</span>` : '')
    + (extShapes ? `<span class="viz-legend__item sr-legend-ext"><span class="ii-legend-dash"></span>추세 연장(추정)</span>` : '')
    + `</div>`;
  _srChart = { months, series, geom: { X, Y, n, W, padL } };

  return `${legend}
    <svg class="viz-svg sr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="해상 정시성">
      ${grid}${xticks}${avgLine}${extShapes}${lines}${dots}${labels}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="sr-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="sr-dots"></g>
      <rect class="sr-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 크로스헤어 + 툴팁 (월 · 연도별 정시성 %) */
function wireSrChart() {
  const fig = document.querySelector('#materialRoot .sr-figure');
  const tip = document.getElementById('srTooltip');
  if (!fig || !tip || !_srChart) return;
  const svg = fig.querySelector('.sr-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.sr-overlay');
  const cross = svg.querySelector('.sr-cross');
  const dots = svg.querySelector('.sr-dots');
  const c = _srChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${s.key}</span><span class="viz-tt-val">${v.toFixed(1)}%</span></div>`;
    });
    if (!rows) { clear(); return; }
    dots.innerHTML = dh;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.months[i])}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/* ── 국제유가 (PETRONET 일일국제원유가격) ─────────────────────────────────
   실제 조회 페이지와 같은 순서로 조작한다: 기준선택 → 기간 → 제품 → [조회].

   ★ [조회]를 누르기 전에는 결과가 바뀌지 않는다. 조건은 _ocForm 에 쌓이고,
     [조회]가 그것을 _ocQuery 로 확정할 때만 표·그래프를 다시 그린다(실제 사이트와 동일).
   ★ 서버를 다시 부르지 않는다. 기준별 전 구간을 미리 받아 두고(oil_crude.py)
     여기서 자른다 — PETRONET 은 브라우저에서 직접 부를 수 없다(CORS).
   ★ 요약행(전일비·전주비·전월동일비·전년동일비)은 '보이는 구간'이 아니라
     '받아둔 전 구간'에서 찾아 계산한다. 전년동일비는 1년 전 값을 봐야 해서다.
     계산 규칙은 PETRONET 이 스스로 계산해 준 값과 대조해 확정했다(oil_crude.py 주석). */
const OC_COLORS = { dubai: '#C8102E', brent: '#3B82F6', wti: '#F59E0B', oman: '#12B981' };
const OC_TERMS = [['y', '년'], ['m', '월'], ['w', '주'], ['d', '일']];
// 체크박스 라벨 옆에 붙일 짧은 설명 — 어느 지역 기준 유종인지 그 자리에서 읽히게.
// ★ 조회 조건의 체크박스에만 쓴다. 표 머리·범례·CSV 는 payload 의 series.label
//   (Dubai / Brent(ICE) …)을 그대로 써야 하므로 그쪽은 건드리지 않는다.
const OC_ORIGIN = {
  dubai: '두바이유 · 중동 기준',
  brent: '브렌트유 · 유럽/국제유가 기준',
  wti: '서부텍사스유 · 미국 기준',
  oman: '오만유 · 중동 기준',
};
// 기준별 기본 조회 폭(개월). 표가 한눈에 들어오는 크기로 연다.
const OC_DEFAULT_SPAN = { y: null, m: 12, w: 3, d: 1 };

let _ocData = null;     // sections.oil_crude — {series, terms:{y,m,w,d}, unit, ...}
let _ocForm = null;     // 사용자가 만지는 중인 조건 {term, y0,m0,y1,m1, on:Set}
let _ocQuery = null;    // [조회]로 확정된 조건 — 결과는 이것만 본다
let _ocView = 'table';  // 'table' | 'chart'
let _oilChart = null;   // 차트 크로스헤어·툴팁 상태

/** 기준(term) 블록. 없으면 null */
function ocTerm(t) {
  const d = _ocData;
  return (d && !d.error && d.terms && d.terms[t]) || null;
}

/** period → 'YYYY'(년) 또는 'YYYY-MM'(그 외). 기간 필터의 비교 키다. */
function ocYm(period, term) {
  return term === 'y' ? String(period).slice(0, 4) : String(period).slice(0, 7);
}

/** period → 표에 찍을 라벨 */
function ocLabel(period, term) {
  const p = String(period);
  if (term === 'y') return p + '년';
  if (term === 'm') return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월';
  if (term === 'w') return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월 ' + p.split('W')[1] + '주';
  return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월 ' + p.slice(8, 10) + '일';
}

/** 기준의 rows 에 등장하는 연도 목록(오름차순) */
function ocYears(term) {
  const t = ocTerm(term);
  if (!t) return [];
  const s = new Set(t.rows.map((r) => String(r.period).slice(0, 4)));
  return Array.from(s).sort();
}

/** 그 기준의 기본 기간 — 마지막 데이터에서 OC_DEFAULT_SPAN 만큼 거슬러 연다. */
function ocDefaultSpan(term) {
  const t = ocTerm(term);
  if (!t || !t.rows.length) return null;
  const last = t.rows[t.rows.length - 1].period, first = t.rows[0].period;
  if (term === 'y') return { y0: first.slice(0, 4), m0: '01', y1: last.slice(0, 4), m1: '12' };
  const y1 = Number(last.slice(0, 4)), m1 = Number(last.slice(5, 7));
  const span = OC_DEFAULT_SPAN[term] || 12;
  let y0 = y1, m0 = m1 - span + 1;
  while (m0 <= 0) { y0 -= 1; m0 += 12; }
  const fy = Number(first.slice(0, 4)), fm = Number(first.slice(5, 7));
  if (y0 < fy || (y0 === fy && m0 < fm)) { y0 = fy; m0 = fm; }
  const p2 = (n) => String(n).padStart(2, '0');
  return { y0: String(y0), m0: p2(m0), y1: String(y1), m1: p2(m1) };
}

/** 최초/기준변경 시의 조회 조건 */
function ocFormFor(term, keepOn) {
  const sp = ocDefaultSpan(term) || { y0: '', m0: '01', y1: '', m1: '12' };
  const on = keepOn || new Set((_ocData && _ocData.default_on) || []);
  return { term: term, y0: sp.y0, m0: sp.m0, y1: sp.y1, m1: sp.m1, on: on };
}

/** 조건에 맞는 행만 자른다(기간). 유종은 표·차트에서 고른다. */
function ocWindow(q) {
  const t = ocTerm(q.term);
  if (!t) return [];
  const a = q.term === 'y' ? q.y0 : q.y0 + '-' + q.m0;
  const b = q.term === 'y' ? q.y1 : q.y1 + '-' + q.m1;
  const lo = a <= b ? a : b, hi = a <= b ? b : a;   // 거꾸로 골라도 동작하게
  return t.rows.filter((r) => {
    const k = ocYm(r.period, q.term);
    return k >= lo && k <= hi;
  });
}

/** 켜진 유종 목록 [{key,label,color}] (payload 순서 유지) */
function ocOnSeries(q) {
  const d = _ocData;
  if (!d || d.error) return [];
  return (d.series || []).filter((s) => q.on.has(s.key))
    .map((s) => ({ key: s.key, label: s.label, color: OC_COLORS[s.key] || 'var(--slate)' }));
}

/* ── 요약행 계산 ───────────────────────────────────────────────────────────
   ★ 비교 대상은 '받아둔 전 구간(all)'에서 찾는다 — 조회 창 밖의 과거를 봐야 한다.
   ★ 규칙은 PETRONET 이 계산해 준 값과 대조해 확정했다(14개 중 13개 정확히 일치.
     남은 1개는 일별 초장기 구간의 '평균'인데, 월별 표로 교차검증한 결과
     PETRONET 쪽이 틀렸다 — oil_crude.py 주석 참고).
       일 : 전일비=직전 행 · 전주비=7일 전 · 전월동일비=1개월 전 · 전년동일비=1년 전
            (휴장일이면 그 이전 영업일로 내려 잡는다)
       월 : 전월비=직전 행 · 전년동월비=1년 전 같은 달
       주 : 전주비=직전 행 · 전월동주비=4주 전 · 전년동주비=1년 전 같은 월·같은 주차
       년 : 전년비=직전 행
       평균: 조회 구간 전체 평균 */

/** 'YYYY-MM-DD' 를 y년 m개월 d일 만큼 옮긴다(월말 보정 포함) */
function ocShift(iso, dy, dm, dd) {
  const Y = Number(iso.slice(0, 4)), M = Number(iso.slice(5, 7)), D = Number(iso.slice(8, 10));
  let yy = Y + (dy || 0), mm = M + (dm || 0);
  yy += Math.floor((mm - 1) / 12);
  mm = ((mm - 1) % 12 + 12) % 12 + 1;
  const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const t = new Date(Date.UTC(yy, mm - 1, Math.min(D, dim)));
  t.setUTCDate(t.getUTCDate() + (dd || 0));
  return t.toISOString().slice(0, 10);
}

/** period <= target 인 마지막 행(휴장일이면 그 이전 영업일). 없으면 null */
function ocAtOrBefore(rows, target) {
  let hit = null;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].period <= target) hit = rows[i]; else break;
  }
  return hit;
}

/** 표 아래에 붙일 요약행 [{label, vals:{key:값}, kind}] */
function ocSummaryRows(q, win) {
  const t = ocTerm(q.term);
  if (!t || !win.length) return [];
  const all = t.rows, last = win[win.length - 1];
  const i = all.indexOf(last);
  const keys = ocOnSeries(q).map((s) => s.key);
  const back = (n) => ((i - n >= 0) ? all[i - n] : null);
  const find = (p) => all.filter((r) => r.period === p)[0] || null;
  const out = [];
  const push = (label, prev) => {
    const vals = {};
    keys.forEach((k) => {
      vals[k] = (!prev || last[k] == null || prev[k] == null)
        ? null : Math.round((last[k] - prev[k]) * 100) / 100;
    });
    out.push({ label: label, vals: vals, kind: 'delta' });
  };
  const p = String(last.period);
  if (q.term === 'd') {
    push('전일비', back(1));
    push('전주비', ocAtOrBefore(all, ocShift(p, 0, 0, -7)));
    push('전월동일비', ocAtOrBefore(all, ocShift(p, 0, -1, 0)));
    push('전년동일비', ocAtOrBefore(all, ocShift(p, -1, 0, 0)));
  } else if (q.term === 'm') {
    push('전월비', back(1));
    push('전년동월비', find((Number(p.slice(0, 4)) - 1) + '-' + p.slice(5, 7)));
  } else if (q.term === 'w') {
    push('전주비', back(1));
    push('전월동주비', back(4));
    push('전년동주비', find((Number(p.slice(0, 4)) - 1) + '-' + p.slice(5, 7) + '-W' + p.split('W')[1]));
  } else {
    push('전년비', back(1));
  }
  const avg = {};
  keys.forEach((k) => {
    const v = win.map((r) => r[k]).filter((x) => x != null);
    avg[k] = v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
  });
  out.push({ label: '평균', vals: avg, kind: 'avg' });
  return out;
}

/* ── 조회 조건 UI ─────────────────────────────────────────────────────── */

function ocNum(v) {
  return (v == null) ? '-' : Number(v).toFixed(2);
}

/** 기준선택 · 기간 · 제품 · [조회] */
function ocControlsHtml() {
  const f = _ocForm;
  if (!f) return '';
  const years = ocYears(f.term);
  const sel = (name, val, opts) => '<select class="oc-sel" data-oc="' + name + '">'
    + opts.map((o) => '<option value="' + escapeHtml(o[0]) + '"'
      + (String(o[0]) === String(val) ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>').join('')
    + '</select>';
  const yOpts = years.map((y) => [y, y + '년']);
  const mOpts = Array.from({ length: 12 }, (_, i) => {
    const v = String(i + 1).padStart(2, '0');
    return [v, v + '월'];
  });
  const showM = f.term !== 'y';   // 년 기준은 월을 고르지 않는다

  const terms = OC_TERMS.map((t) => '<label class="oc-radio">'
    + '<input type="radio" name="ocTerm" value="' + t[0] + '"'
    + (f.term === t[0] ? ' checked' : '') + '>' + escapeHtml(t[1]) + '</label>').join('');

  const prods = ((_ocData && _ocData.series) || []).map((s) => '<label class="oc-check oc-check--origin">'
    + '<input type="checkbox" data-oc-prod="' + escapeHtml(s.key) + '"'
    + (f.on.has(s.key) ? ' checked' : '') + '>'
    + '<span class="oc-swatch" style="background:' + (OC_COLORS[s.key] || 'var(--slate)') + '"></span>'
    + '<span class="oc-name">' + escapeHtml(s.label) + '</span>'
    + (OC_ORIGIN[s.key] ? '<span class="oc-note">(' + escapeHtml(OC_ORIGIN[s.key]) + ')</span>' : '')
    + '</label>').join('');

  return '<div class="oc-form">'
    + '<div class="oc-row"><span class="oc-lab">기준선택</span>'
    + '<div class="oc-ctl">' + terms + '</div></div>'
    + '<div class="oc-row"><span class="oc-lab">기간</span><div class="oc-ctl">'
    + sel('y0', f.y0, yOpts) + (showM ? sel('m0', f.m0, mOpts) : '')
    + '<span class="oc-tilde">~</span>'
    + sel('y1', f.y1, yOpts) + (showM ? sel('m1', f.m1, mOpts) : '')
    + '</div></div>'
    + '<div class="oc-row"><span class="oc-lab">제품</span>'
    + '<div class="oc-ctl">' + prods + '</div></div>'
    + '<div class="oc-row oc-row--go"><span class="oc-lab"></span>'
    + '<div class="oc-ctl"><button type="button" class="oc-go">조회</button></div></div>'
    + '</div>';
}

/* ── 결과: 표 ─────────────────────────────────────────────────────────── */

/** 조회 구간 표시 — '2026년 08월 17일 ~ 2026년 08월 24일' */
function ocSpanText(q, win) {
  if (!win.length) return '';
  return ocLabel(win[0].period, q.term) + ' ~ ' + ocLabel(win[win.length - 1].period, q.term);
}

function ocTableHtml(q, win) {
  const ser = ocOnSeries(q);
  if (!ser.length) return '<div class="chart-empty">제품을 하나 이상 선택하고 [조회]를 누르세요.</div>';
  if (!win.length) return '<div class="chart-empty">선택한 기간에 데이터가 없습니다.</div>';
  // 열별 최소·최대(데이터 행만) — 요약행은 하이라이트 대상이 아니다
  const ext = {};
  ser.forEach((s) => {
    const v = win.map((r) => r[s.key]).filter((x) => x != null);
    ext[s.key] = v.length ? { lo: Math.min.apply(null, v), hi: Math.max.apply(null, v) } : null;
  });
  const head = '<tr><th class="oc-th-p">' + escapeHtml(ocTerm(q.term).label) + '</th>'
    + ser.map((s) => '<th><span class="oc-swatch" style="background:' + s.color + '"></span>'
      + escapeHtml(s.label) + '</th>').join('') + '</tr>';
  const body = win.map((r) => '<tr><td class="oc-td-p">' + escapeHtml(ocLabel(r.period, q.term)) + '</td>'
    + ser.map((s) => {
      const v = r[s.key], e = ext[s.key];
      let cls = '';
      if (v != null && e) {
        if (v === e.lo && e.lo !== e.hi) cls = ' oc-min';
        else if (v === e.hi && e.lo !== e.hi) cls = ' oc-max';
      }
      return '<td class="oc-num' + cls + '">' + ocNum(v) + '</td>';
    }).join('') + '</tr>').join('');
  const sums = ocSummaryRows(q, win).map((s) => '<tr class="oc-sum oc-sum--' + s.kind + '">'
    + '<td class="oc-td-p">' + escapeHtml(s.label) + '</td>'
    + ser.map((x) => {
      const v = s.vals[x.key];
      const sign = (s.kind === 'delta' && v != null && v > 0) ? '+' : '';
      const cls = (s.kind !== 'delta' || v == null) ? '' : (v > 0 ? ' oc-up' : (v < 0 ? ' oc-down' : ''));
      return '<td class="oc-num' + cls + '">' + (v == null ? '-' : sign + ocNum(v)) + '</td>';
    }).join('') + '</tr>').join('');
  return '<div class="oc-tablewrap"><table class="oc-table">'
    + '<thead>' + head + '</thead><tbody>' + body + sums + '</tbody></table></div>';
}

/* ── 결과: 내보내기 ───────────────────────────────────────────────────── */

/** 표를 [[셀,...],...] 로 — csv·엑셀·인쇄가 같은 원본을 쓴다 */
function ocMatrix(q, win) {
  const ser = ocOnSeries(q);
  const rows = [[ocTerm(q.term).label].concat(ser.map((s) => s.label))];
  win.forEach((r) => rows.push([ocLabel(r.period, q.term)].concat(ser.map((s) => ocNum(r[s.key])))));
  ocSummaryRows(q, win).forEach((s) => rows.push([s.label].concat(ser.map((x) => {
    const v = s.vals[x.key];
    return v == null ? '-' : ((s.kind === 'delta' && v > 0 ? '+' : '') + ocNum(v));
  }))));
  return rows;
}

/** Blob 을 파일로 내려받기 */
function ocSave(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ocFileName(q, ext) {
  return '국제유가_' + ocTerm(q.term).label + '_' + String(q.y0) + (q.term === 'y' ? '' : q.m0)
    + '-' + String(q.y1) + (q.term === 'y' ? '' : q.m1) + '.' + ext;
}

function ocExportCsv(q, win) {
  const csv = ocMatrix(q, win)
    .map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  // BOM 을 붙여야 엑셀에서 한글이 깨지지 않는다
  ocSave(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), ocFileName(q, 'csv'));
}

function ocExportXls(q, win) {
  const rows = ocMatrix(q, win);
  const tbl = '<table border="1">' + rows.map((r, i) => '<tr>'
    + r.map((c) => (i ? '<td>' : '<th>') + escapeHtml(c) + (i ? '</td>' : '</th>')).join('')
    + '</tr>').join('') + '</table>';
  const html = '<html><head><meta charset="utf-8"></head><body>'
    + '<h3>국제유가 (PETRONET 일일국제원유가격) · ' + escapeHtml(ocSpanText(q, win))
    + ' · 단위 ' + escapeHtml((_ocData && _ocData.unit) || '$/배럴') + '</h3>'
    + tbl + '</body></html>';
  ocSave(new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' }),
    ocFileName(q, 'xls'));
}

function ocPrint(q, win) {
  const rows = ocMatrix(q, win);
  const tbl = '<table>' + rows.map((r, i) => '<tr>'
    + r.map((c) => (i ? '<td>' : '<th>') + escapeHtml(c) + (i ? '</td>' : '</th>')).join('')
    + '</tr>').join('') + '</table>';
  const w = window.open('', '_blank');
  if (!w) { window.alert('팝업이 차단되어 인쇄 창을 열지 못했습니다.'); return; }
  w.document.write('<html><head><meta charset="utf-8"><title>국제유가 (PETRONET)</title>'
    + '<style>body{font-family:sans-serif;padding:20px}h3{margin:0 0 4px}'
    + 'p{margin:0 0 12px;color:#555;font-size:12px}'
    + 'table{border-collapse:collapse;font-size:12px}'
    + 'th,td{border:1px solid #999;padding:4px 8px;text-align:right}'
    + 'th:first-child,td:first-child{text-align:left}</style></head><body>'
    + '<h3>국제유가 (PETRONET 일일국제원유가격)</h3>'
    + '<p>' + escapeHtml(ocSpanText(q, win)) + ' · 단위 '
    + escapeHtml((_ocData && _ocData.unit) || '$/배럴') + ' · 출처 한국석유공사 PETRONET</p>'
    + tbl + '</body></html>');
  w.document.close();
  w.focus();
  w.print();
}

/* ══ 국제유가 인사이트 대시보드 ═══════════════════════════════════════════
   상단 요약 3분할 → ① 구간 설명 → ② 변동요인 4카드 → ③ 시나리오 표
   → ④ 시사점 3카드 → 하단 인사이트
   ★ 조회 조건(기준·기간·제품)은 건드리지 않는다. 다만 ①의 구간 강조와
     하단 인사이트는 '지금 조회된 창'에 맞춰 다시 계산된다.
   ★★ 시나리오 수치는 통계 모델이 아니다. 최근 변동성으로 잡은 범위이며
     화면에 '추정치'라고 적는다. */
const OIL_DATA_URL = 'public/data/oil-insights.json';
let _oilIns = null;

const OIL_FC_MONTHS = 3;     // 전망 지평(개월)
const OIL_VOL_WIN = 6;       // 변동성을 재는 창(개월)
const OIL_BASE_KEY = 'dubai';  // 기간별 상승률·시나리오의 기준 유종

async function fetchOilInsights() {
  try {
    const res = await fetch(OIL_DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _oilIns = d;
  } catch (e) {
    _oilIns = null;
    console.warn('[oil-insights] 로드 실패:', e);
  }
  renderMaterial();
}

/** 월별 [{k:'YYYY-MM', v}] — 유종 하나. 없으면 [] */
function oilMonthly(key) {
  const rows = (_ocData && _ocData.terms && _ocData.terms.m && _ocData.terms.m.rows) || [];
  return rows.map((r) => ({ k: r.period, v: r[key] })).filter((x) => x.v != null && isFinite(x.v));
}

/** n개월 전 대비 변화율(%). 관측이 모자라면 null */
function oilBack(pts, n) {
  if (pts.length <= n) return null;
  const last = pts[pts.length - 1].v, prev = pts[pts.length - 1 - n].v;
  return prev ? ((last - prev) / prev) * 100 : null;
}

/** 연초(1월) 대비 변화율(%). 없으면 null */
function oilYtd(pts) {
  if (!pts.length) return null;
  const y = pts[pts.length - 1].k.slice(0, 4);
  const jan = pts.find((p) => p.k === y + '-01');
  if (!jan || !jan.v) return null;
  return ((pts[pts.length - 1].v - jan.v) / jan.v) * 100;
}

/** 3개월 전망 — 최근 12개월 추세 + 최근 OIL_VOL_WIN 개월 변동성. 못 내면 null */
function oilForecast(pts) {
  if (pts.length < 8) return null;
  const xs = pts.slice(-12).map((p) => p.v), n = xs.length;
  const xm = (n - 1) / 2, ym = xs.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  xs.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) * (i - xm); });
  if (!den) return null;
  const slope = num / den, base = xs[n - 1];
  const w = pts.slice(-(OIL_VOL_WIN + 1)).map((p) => p.v);
  const r = [];
  for (let i = 1; i < w.length; i += 1) if (w[i - 1] > 0 && w[i] > 0) r.push(Math.log(w[i] / w[i - 1]));
  if (r.length < 3) return null;
  const rm = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - rm) * (b - rm), 0) / (r.length - 1));
  const sd3 = sd * Math.sqrt(OIL_FC_MONTHS);
  const med = Math.max(0, base + slope * OIL_FC_MONTHS);
  const chg = base ? ((med - base) / base) * 100 : 0;
  return {
    base: base, med: med, sd3: sd3 * 100,
    up: [base * Math.exp(sd3 * 0.5), base * Math.exp(sd3)],
    mid: [Math.min(base, med) * Math.exp(-sd3 * 0.35), Math.max(base, med) * Math.exp(sd3 * 0.35)],
    dn: [base * Math.exp(-sd3), base * Math.exp(-sd3 * 0.5)],
    chgPct: chg, dir: (chg > 3 ? 'up' : (chg < -3 ? 'down' : 'flat')),
    from: pts[Math.max(0, pts.length - 12)].k, to: pts[pts.length - 1].k,
  };
}

function oilUsd(v, digits) {
  return (v == null || !isFinite(v)) ? '—'
    : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: digits == null ? 1 : digits,
      maximumFractionDigits: digits == null ? 1 : digits });
}

/* ── 상단 요약 3분할 ────────────────────────────────────────────────────── */
function oilSummary3() {
  if (!_ocData || _ocData.error) return '';
  // 표기 순서는 Brent → Dubai → WTI 로 고정한다(자료의 배열 순서와 무관하게)
  const OIL_SUM_ORDER = ['brent', 'dubai', 'wti'];
  const series = OIL_SUM_ORDER.map((k) => (_ocData.series || []).find((x) => x.key === k)).filter(Boolean);
  const basePts = oilMonthly(OIL_BASE_KEY);
  if (!series.length || !basePts.length) return '';
  const asOf = basePts[basePts.length - 1].k;

  // ① 최근가 — 유종별 최근 월값 + 전월비
  const prices = series.map((s) => {
    const p = oilMonthly(s.key);
    if (!p.length) return '';
    const mom = oilBack(p, 1);
    const v = p[p.length - 1].v;
    const krw = krwOf(v, '배럴');
    return `<div class="oil-s__row"><span class="oil-s__k">${escapeHtml(s.label)}</span>
      <span class="oil-s__v">${oilUsd(v, 2)}${krw
        ? `<span class="oil-s__krw">${escapeHtml(krw)}</span>` : ''}</span>
      <span class="oil-s__d">${matBadge(mom)}</span></div>`;
  }).join('');

  // ② 기간별 상승률 — 기준 유종 하나로
  const baseLabel = ((_ocData.series || []).find((s) => s.key === OIL_BASE_KEY) || {}).label || 'Dubai';
  const rets = [['3개월', oilBack(basePts, 3)], ['6개월', oilBack(basePts, 6)], ['연초 대비', oilYtd(basePts)]]
    .map(([k, v]) => `<div class="oil-s__row"><span class="oil-s__k">${escapeHtml(k)}</span>
      <span class="oil-s__d">${matBadge(v)}</span></div>`).join('');

  // ③ 인사이트 — 첫 줄은 실데이터에서 만들고, 나머지는 JSON 문구를 쓴다
  const auto = oilAutoBullet(basePts);
  const more = ((_oilIns && _oilIns.bullets) || []).map((b) =>
    `<li>${escapeHtml(b)}</li>`).join('');
  const bullets = (auto ? `<li>${escapeHtml(auto)}</li>` : '') + more;

  return `<div class="oil-s3">
    <div class="oil-s"><div class="oil-s__h">최근가 <i>${escapeHtml(asOf)} 기준</i></div>${prices}</div>
    <div class="oil-s"><div class="oil-s__h">기간별 상승률 <i>${escapeHtml(baseLabel)} 기준</i></div>${rets}</div>
    <div class="oil-s"><div class="oil-s__h">주요 인사이트</div>
      <ul class="oil-s__ul">${bullets}</ul></div>
  </div>`;
}

/** 최근 흐름 한 줄 — 최고점·저점·현재 방향을 실제 월에서 뽑아 문장으로 만든다.
 *  ★ 원인은 말하지 않는다. 언제 오르고 언제 내렸는지만 적는다. */
function oilAutoBullet(pts) {
  const w = pts.slice(-14);
  if (w.length < 6) return null;
  let hi = 0, lo = 0;
  w.forEach((p, i) => { if (p.v > w[hi].v) hi = i; });
  for (let i = hi; i < w.length; i += 1) if (w[i].v < w[lo].v || lo < hi) { if (w[i].v <= w[lo < hi ? i : lo].v || lo < hi) lo = i; }
  // hi 이후 최저점을 다시 정확히 찾는다
  lo = hi;
  for (let i = hi; i < w.length; i += 1) if (w[i].v < w[lo].v) lo = i;
  const mo = (k) => String(Number(k.slice(5, 7))) + '월';
  const last = w[w.length - 1], dir = last.v > w[lo].v * 1.02 ? '재상승' : (last.v < w[lo].v * 0.98 ? '추가 하락' : '보합');
  const parts = [mo(w[hi].k) + ' 고점 ' + oilUsd(w[hi].v, 0)];
  if (lo > hi) parts.push(mo(w[lo].k) + '까지 조정 ' + oilUsd(w[lo].v, 0));
  if (lo < w.length - 1) parts.push(mo(last.k) + ' ' + dir + ' ' + oilUsd(last.v, 0));
  return parts.join(' → ') + ' 흐름';
}

/* ── ① 구간 설명 (조회 창에 맞춰 강조/흐림) ────────────────────────────── */
function oilEras(bands) {
  const eras = (_oilIns && Array.isArray(_oilIns.eras)) ? _oilIns.eras : [];
  if (!eras.length) return '';
  // 차트에 음영이 그려진 구간이 곧 '지금 보이는 구간'이다 — 같은 계산을 다시 하지 않는다.
  const drawn = new Set((bands || []).map((b) => b.idx));
  const cards = eras.map((e, i) => {
    // 음영을 그릴 수 있으면 그 결과를 그대로 따르고(둘이 어긋나지 않게),
    // 그릴 수 없으면(연도 기준) 어느 구간이 걸리는지 가릴 근거가 없으므로 흐리게 하지 않는다.
    const shown = drawn.size ? drawn.has(i) : true;
    return `<div class="xsii-era${shown ? '' : ' is-off'}" data-era="${i}"
        style="--xe:${oilToneOf(e)}">
      <div class="xsii-era__span">${escapeHtml(e.span)}</div>
      <div class="xsii-era__title">${escapeHtml(e.title || '')}</div>
      <p class="xsii-era__detail">${escapeHtml(e.detail || '')}</p>
    </div>`;
  }).join('');
  const note = (bands && bands.length)
    ? '차트의 같은 색 음영이 이 구간입니다. 카드에 마우스를 올리면 차트에서 그 구간이 진해집니다.'
    : '연도 기준으로 보면 구간(월 단위)을 차트에 표시할 수 없어 음영을 그리지 않습니다.';
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">① 주요 원유 가격 추이 및 핵심 이벤트</h3>
    <div class="ii-cap">${escapeHtml(note)} 구간 구분과 설명은 참고용입니다.</div>
    <div class="xsii-eras oil-eras">${cards}</div>
  </div>`;
}

/* ── ② 변동요인 4카드 ──────────────────────────────────────────────────── */
function oilFactors() {
  const list = (_oilIns && Array.isArray(_oilIns.factors)) ? _oilIns.factors : [];
  if (!list.length) return '';
  const cards = list.map((f) => `<div class="sr-fac sr-fac--${escapeHtml(f.level || 'mid')}">
      <div class="sr-fac__top">
        <span class="sr-fac__ico" aria-hidden="true">${escapeHtml(f.icon || '•')}</span>
        <span class="sr-fac__title">${escapeHtml(f.title || '')}</span>
      </div>
      <div class="xsii-fac__tags">
        ${f.dirLabel ? `<span class="xsii-dir xsii-dir--${escapeHtml(f.dir || 'both')}">${escapeHtml(f.dirLabel)}</span>` : ''}
      </div>
      <p class="sr-fac__desc">${escapeHtml(f.desc || '')}</p>
    </div>`).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">② 최근 가격 변동요인 분석</h3>
    <div class="sr-facs oil-facs">${cards}</div>
  </div>`;
}

/* ── ③ 시나리오 표 ─────────────────────────────────────────────────────── */
function oilScenarios(fc, baseLabel) {
  const list = (_oilIns && Array.isArray(_oilIns.scenarios)) ? _oilIns.scenarios : [];
  if (!list.length) return '';
  if (!fc) {
    return `<div class="ii-panel">
      <h3 class="subhead ii-h">③ 향후 3개월 전망 <span class="xsi-fc__tag">추정치</span></h3>
      <div class="ii-cap">추세·변동성을 잴 만큼의 월별 관측치가 없어 시나리오를 내지 않았습니다.</div>
    </div>`;
  }
  const rng = { up: fc.up, base: fc.mid, down: fc.dn };
  const rows = list.map((s) => {
    const r = rng[s.key] || [];
    return `<tr class="xsi-sc--${escapeHtml(s.tone)}">
      <th scope="row"><span class="xsi-sc__dot"></span>${escapeHtml(s.name)}
        <span class="xsi-sc__prob">확률 추정 ${Number(s.prob)}%</span></th>
      <td class="xsi-sc__val">${oilUsd(r[0], 0)}~${oilUsd(r[1], 0)}<span class="xsi-sc__u">${escapeHtml(baseLabel)} 기준</span></td>
      <td class="xsi-sc__basis">${escapeHtml(s.basis || '')}</td>
      <td>${escapeHtml(s.assumption || '')}</td>
    </tr>`;
  }).join('');
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">③ 향후 3개월 전망 <span class="xsi-fc__tag">추정치</span></h3>
    <div class="xsi-sc-wrap"><table class="xsi-sc">
      <thead><tr><th>시나리오</th><th>3개월 후 가격범위</th><th>산출 기준</th><th>주요 가정</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="ii-cap">※ 상기 확률·범위는 과거 변동성 기반 통계적 추정이며 실제 시장 전망이 아닙니다.
      최근 ${OIL_VOL_WIN}개월 월별 등락의 표준편차(3개월 지평 ±${fc.sd3.toFixed(1)}%)와
      최근 12개월(${escapeHtml(fc.from)}~${escapeHtml(fc.to)}) 추세로 계산했고,
      확률(%)은 계산값이 아니라 시나리오 구분을 위한 가정치입니다.</div>
  </div>`;
}

/* ── ④ 시사점 3카드 ────────────────────────────────────────────────────── */
function oilActions() {
  const list = (_oilIns && Array.isArray(_oilIns.actions)) ? _oilIns.actions : [];
  if (!list.length) return '';
  const cols = list.map((a) => `<div class="ii-imp ii-imp--${escapeHtml(a.tone || 'info')}">
      <div class="ii-imp__h">${iiImpIcon(a.tone || 'info')}${escapeHtml(a.title || '')}</div>
      <ul class="xsi-act">${(a.items || []).map((t) => `<li>${iiEmph(t)}</li>`).join('')}</ul>
    </div>`).join('');
  const upd = (_oilIns && _oilIns.updated) ? String(_oilIns.updated) : null;
  return `<div class="ii-panel">
    <h3 class="subhead ii-h">④ 시사점 및 대응 방안</h3>
    <div class="ii-imps">${cols}</div>
    <div class="ii-cap">시황 해설은 주기적으로 갱신됩니다${upd ? ' (최종 갱신: ' + escapeHtml(upd) + ')' : ''}</div>
  </div>`;
}

/* ── 하단 핵심 인사이트 ────────────────────────────────────────────────── */
function oilInsightBox(fc) {
  const ins = (_oilIns && _oilIns.insight) || null;
  if (!ins) return '';
  const lead = ins[fc ? fc.dir : 'flat'] || ins.flat;
  if (!lead) return '';
  const trend = fc
    ? `<span class="xsi-ins__trend">최근 12개월 추세 연장 기준 ${(fc.chgPct > 0 ? '+' : '')
      + fc.chgPct.toFixed(1)}% <i>추정</i></span>` : '';
  return `<div class="xsi-ins">
    <div class="xsi-ins__h">핵심 인사이트${trend}</div>
    <p class="xsi-ins__lead">${escapeHtml(lead)}</p>
    ${ins.action ? `<p class="xsi-ins__act">→ ${escapeHtml(ins.action)}</p>` : ''}
  </div>`;
}

/* ── 카드 전체 ───────────────────────────────────────────────────────── */

function renderOilPricesHtml() {
  const unit = (_ocData && !_ocData.error && _ocData.unit) || '$/배럴';
  // 배너의 '업데이트 기준'은 월별 자료의 마지막 달(수집 시각이 아니다)
  const ocPts = oilMonthly(OIL_BASE_KEY);
  const ocDay = ocPts.length ? ocPts[ocPts.length - 1].k : '';
  const head = vizHero('oil', '국제유가 동향 (PETRONET)',
    (_oilIns && _oilIns.hero && _oilIns.hero.subtitle) || '', ocDay)
    + `<div class="viz-head"><div>
      <div class="viz-sub">일일국제원유가격 · Dubai/Brent(ICE)/WTI(NYMEX)/Oman (${escapeHtml(unit)})</div>
      <div class="viz-sub2">지역별 대표 원유(유종)의 가격을 비교하는 그래프</div>
    </div></div>`
    // ★ 최근가·기간별 상승률·인사이트 3박스는 [조회] 뒤에만 낸다(섹션 공통 규칙)
    + (_ocQuery ? oilSummary3() : '');
  const cap = capSrc('출처: 한국석유공사 PETRONET · 일일국제원유가격', SRC_LINKS.oilCrude);
  // 요약 4박스 — 유종마다 한 칸(월별 전 구간 기준). 헤더 바로 아래에 둔다.
  // ★ [조회]를 누르기 전에는 내지 않는다(섹션 공통 규칙).
  const ocSum = (_ocData && !_ocData.error && _ocQuery)
    ? matSeriesBoxes((_ocData.series || []).slice(0, 4).map((s) => ({
      label: s.label, pts: msPtsPetro(_ocData, s.key) })), '$/배럴', 2, '배럴') : '';

  if (!_ocData) {
    return `<div class="viz-root viz-figure oil-figure">${head}`
      + '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>' + `${cap}</div>`;
  }
  if (_ocData.error) {
    return `<div class="viz-root viz-figure oil-figure">${head}`
      + '<div class="chart-empty">데이터를 불러오지 못했습니다 (PETRONET 접근 차단 가능)</div>'
      + `${cap}</div>`;
  }

  const controls = '<div class="oc-formwrap">' + ocControlsHtml() + '</div>';
  let body;
  if (!_ocQuery) {
    body = '<div class="icis-prompt">기준·기간·제품을 고르고 [조회]를 누르세요</div>';
  } else {
    const q = _ocQuery, win = ocWindow(q);
    // 차트 음영과 카드가 같은 계산을 나눠 쓴다 — 둘이 어긋나지 않게 한 번만 구한다
    const ocBands = oilBandRanges(win, q.term);
    const tools = '<div class="oc-result__head">'
      + '<div class="oc-span">' + escapeHtml(ocSpanText(q, win))
      + ' <span class="oc-unit">(단위: ' + escapeHtml(unit) + ')</span></div>'
      + '<div class="oc-tools">'
      + '<button type="button" class="oc-tool' + (_ocView === 'table' ? ' is-on' : '') + '" data-oc-view="table">표보기</button>'
      + '<button type="button" class="oc-tool' + (_ocView === 'chart' ? ' is-on' : '') + '" data-oc-view="chart">차트보기</button>'
      + '<button type="button" class="oc-tool" data-oc-exp="csv">csv 저장</button>'
      + '<button type="button" class="oc-tool" data-oc-exp="xls">엑셀저장</button>'
      + '<button type="button" class="oc-tool" data-oc-exp="print">인쇄하기</button>'
      + '</div></div>';
    const result = (_ocView === 'chart')
      ? vizUnitCap(unit, 'USD') + buildOilChart(win, ocOnSeries(q), q.term, ocBands) + '<div class="viz-tooltip" id="oilTooltip"></div>'
      : ocTableHtml(q, win);
    // 인사이트 패널 — 조회한 창(win)과 기준 유종으로 계산한다
    const ocFc = oilForecast(ocPts);
    const ocBaseLabel = ((_ocData.series || []).find((x) => x.key === OIL_BASE_KEY) || {}).label || 'Dubai';
    body = tools + result + msFactorsHtml('oil_price')
      + oilEras(ocBands) + oilFactors()
      + oilScenarios(ocFc, ocBaseLabel) + oilActions()
      + oilInsightBox(ocFc);
  }
  const note = (_ocData.note ? '<div class="g-note">' + escapeHtml(_ocData.note) + '</div>' : '');
  return `<div class="viz-root viz-figure oil-figure">${head}${ocSum}${controls}${body}${note}${cap}</div>`;
}


/** 선택한 유종만 선그래프 (connectNulls: 결측은 건너뛰고 이어 그림, dot 없음).
    ★ 계열을 인자로 받는다 — 전역 상태를 읽지 않으므로 어느 기준(년·월·주·일)이든 그대로 쓴다. */
function buildOilChart(rows, onSeries, term, bands) {
  const n = rows.length;
  if (!n) { _oilChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const series = (onSeries || []).map((s) => ({
    key: s.key, label: s.label, color: s.color || 'var(--slate)',
    values: rows.map((r) => (r[s.key] == null ? null : r[s.key])),
  }));
  const periods = rows.map((r) => ocLabel(r.period, term));
  if (!series.length) { _oilChart = null; return '<div class="chart-empty">제품을 하나 이상 선택하세요.</div>'; }

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { _oilChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.1 || 5; ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 42, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">$${Math.round(val)}</text>${vizKrwTick(padL - 6, y, val, _matUsdKrw)}`;
  }).join('');

  // ── 구간 배경 음영 + 경계 점선 ──
  // 칸의 '가운데'가 아니라 이웃 칸과의 중간까지 칠해야 카드가 말하는 기간과 맞는다.
  const edgeL = (i) => (i <= 0 ? padL : (X(i - 1) + X(i)) / 2);
  const edgeR = (i) => (i >= n - 1 ? padL + plotW : (X(i) + X(i + 1)) / 2);
  // ★ 구간명은 '그래프 영역 위 가장자리'(y≈7.5)에 얹는다. 예전엔 padT+8 이라
  //   이벤트 마커 글자(padT+13)와 세로로 겹쳤다 — 실측 7쌍.
  //   이제 구간명 상자 y[2.1~7.5], 이벤트 상자 y[17.6~23.0] 으로 10px 떨어진다.
  // ★ 구간이 글자보다 좁으면 라벨을 아예 빼서 옆 구간 이름과 겹치지 않게 한다.
  const LB_FS = 7.5;
  const bandLabel = (b, x0, w) => {
    const t = String(b.era.title || '');
    if (!t) return '';
    const tw = vizTextW(t, LB_FS);
    if (w < tw + 8) return '';
    let cx = x0 + w / 2;
    cx = Math.max(tw / 2 + 2, Math.min(cx, W - tw / 2 - 2));   // 뷰박스 밖으로 나가지 않게
    return `<text x="${cx.toFixed(1)}" y="${(padT - 2.5).toFixed(1)}" text-anchor="middle"
      font-size="${LB_FS}" font-weight="700" fill="${b.color}" paint-order="stroke"
      stroke="var(--surface-1)" stroke-width="2.5">${escapeHtml(t)}</text>`;
  };
  const bandSvg = (bands || []).map((b) => {
    const x0 = edgeL(b.a), x1 = edgeR(b.b), w = x1 - x0;
    if (!(w > 0)) return '';
    const last = (b.b >= n - 1);
    return `<g class="oil-band" data-era="${b.idx}">
      <rect x="${x0.toFixed(1)}" y="${padT}" width="${w.toFixed(1)}" height="${plotH.toFixed(1)}"
        fill="${b.color}" opacity=".12"/>
      ${last ? '' : `<line x1="${x1.toFixed(1)}" y1="${padT}" x2="${x1.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}"
        stroke="${b.color}" stroke-width="1" stroke-dasharray="3 3" opacity=".55"/>`}
      ${bandLabel(b, x0, w)}
    </g>`;
  }).join('');

  const xticks = vizTickIdx(n, plotW).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(periods[i])}</text>`;
  }).join('');

  // connectNulls: 결측(null)은 건너뛰되 선은 끊지 않고 다음 값과 이어 그림
  const lines = series.map((s) => {
    let d = '', started = false;
    s.values.forEach((v, i) => {
      if (v == null) return;
      const x = X(i), y = Y(v);
      d += `${started ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; started = true;
    });
    return d ? `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  _oilChart = { periods, series, bands: bands || [], geom: { X, Y, n, W, padL } };

  return `<svg class="viz-svg oil-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="국제유가 월별">
      ${grid}${bandSvg}${xticks}${lines}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="oil-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="oil-dots"></g>
      <rect class="oil-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
      ${msEventsSvg('oil_price', rows.map((r) => r.period), X, padT, plotH, W)}
    </svg>`;
}

/** 크로스헤어 + 툴팁 (연-월 · 유종 · $값) */
/** 구간 하이라이트 — 차트 음영과 카드가 같은 data-era 를 공유한다.
 *  ★ 차트 쪽은 오버레이(.oil-overlay)가 위를 덮고 있어 음영이 직접 hover 를 받지
 *    못한다. 그래서 툴팁이 이미 계산하는 '지금 가리키는 인덱스'로 구간을 찾아 쓴다
 *    — 추가 히트 영역을 만들지 않아 툴팁 동작을 방해하지 않는다. */
function oilHiEra(fig, idx) {
  if (!fig || fig._oilHi === idx) return;
  fig._oilHi = idx;
  fig.querySelectorAll('[data-era]').forEach((el) => {
    el.classList.toggle('is-hi', idx != null && String(idx) === el.getAttribute('data-era'));
  });
}

/** 카드에 마우스를 올리면 차트의 그 구간이 진해진다(반대 방향은 툴팁이 담당) */
function wireOilEraHover(root) {
  const fig = root.querySelector('.oil-figure');
  if (!fig || fig._oilEraWired) return;
  fig._oilEraWired = true;   // root 는 재렌더에도 살아남으므로 한 번만 건다
  fig.addEventListener('mouseover', (e) => {
    const card = e.target.closest && e.target.closest('.xsii-era[data-era]');
    if (card) oilHiEra(fig, card.getAttribute('data-era'));
  });
  fig.addEventListener('mouseleave', () => oilHiEra(fig, null));
}

function wireOilChart() {
  const fig = document.querySelector('#materialRoot .oil-figure');
  const tip = document.getElementById('oilTooltip');
  if (!fig || !tip || !_oilChart) return;
  const svg = fig.querySelector('.oil-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.oil-overlay');
  const cross = svg.querySelector('.oil-cross');
  const dots = svg.querySelector('.oil-dots');
  const c = _oilChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${escapeHtml(s.label)}</span><span class="viz-tt-val">$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>`;
    });
    if (!rows) { clear(); return; }
    dots.innerHTML = dh;
    // 지금 가리키는 지점이 속한 구간을 카드·음영 양쪽에서 진하게
    const band = (c.bands || []).find((b) => i >= b.a && i <= b.b);
    oilHiEra(fig, band ? String(band.idx) : null);
    const bandName = band
      ? `<span class="oil-tt-era" style="color:${band.color}">${escapeHtml(band.era.title || '')}</span>` : '';
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.periods[i])}${bandName}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/* ── 월간 부문별 지수 (KOIMA) — 순수 추가 카드 ─────────────────────────────
   백엔드 koima_index.py 가 8개 부문 전 구간(1995-12~)을 한 번에 실어 보내므로
   탭·연월·기간 조작은 전부 로컬 필터링이다(재요청 없음 → '검색' 버튼도 없음).
   ★ 스폰지/정시성/유가 카드와 공통화하지 않고 별도 작성(중복 허용). */

// 탭 순서: 매트리스 원가와 직결되는 유화원료(폼 원료)·철강재(스프링)를 앞에 두고,
// 나머지는 KOIMA 원본 탭 순서(농산품→광산품→유무기원료→섬유원료→비철금속→희소금속).
const KOIMA_TAB_ORDER = ['petchem', 'steel', 'agri', 'mining', 'inorg', 'textile', 'nonferrous', 'rare'];
// 1단계(데이터 없음)에서도 탭 이름은 보여주고 비활성만 시킨다. 데이터가 오면 응답의 label을 쓴다.
const KOIMA_TAB_LABELS = {
  petchem: '유화원료', steel: '철강재', agri: '농산품', mining: '광산품',
  inorg: '유무기원료', textile: '섬유원료', nonferrous: '비철금속', rare: '희소금속',
};
const KOIMA_COLORS = {
  petchem: '#C8102E', steel: '#3B82F6', agri: '#12B981', mining: '#F59E0B',
  inorg: '#8B5CF6', textile: '#0EA5E9', nonferrous: '#64748B', rare: '#DB2777',
};
const KOIMA_RANGES = [
  { key: '1y', label: '1년', months: 12 }, { key: '3y', label: '3년', months: 36 },
  { key: '5y', label: '5년', months: 60 }, { key: 'all', label: '전체', months: null },
];
// 위젯은 부문을 기본 선택하지 않는다(직접 눌러야 나온다). 이 상수는
// 메인 그리드의 한 줄 요약(renderKoimaSummaryHtml)에서 무슨 부문을 보여줄지에만 쓴다.
const KOIMA_DEFAULT_CAT = 'petchem';   // 한 줄 요약에 띄우는 부문: 유화원료

let _koimaData = null;   // {source,baseline,latestPeriod,categories:[...]} | {error} | null
let _koimaCat = null;    // 선택 부문 key
let _koimaEnd = null;    // 구간 끝점 'YYYY-MM'
let _koimaRange = null;  // 선택 기간(null=미선택 → "기간을 선택하세요")
let _koimaChart = null;

/** 응답의 koima_index 저장. 다른 카드 상태는 건드리지 않는다.
 *  ★ renderMaterial()은 _matReady 게이트가 있으므로 applyMaterialUpdate 다음에 호출해야 한다. */
function applyKoimaUpdate(data) {
  const k = data && data.sections && data.sections.koima_index;
  if (k && k.status === 'ok' && Array.isArray(k.categories) && k.categories.length) {
    _koimaData = {
      source: k.source, baseline: k.baseline,
      latestPeriod: k.latestPeriod, categories: k.categories,
    };
    /* ★ 부문을 기본 선택하지 않는다 — 운임지수 위젯의 항로와 같은 규칙이다.
         예전에는 여기서 유화원료를 자동으로 골라, 버튼을 누르지도 않았는데
         전체 대시보드가 떠 있었다. 끝점·기간도 부문을 고르는 시점에 잡는다. */
    _koimaCat = null; _koimaEnd = null; _koimaRange = null; _koimaChart = null;
    console.log('[koima] 부문 %d개 · 최신월 %s · 부문 미선택 상태로 대기',
      k.categories.length, k.latestPeriod);
  } else {
    _koimaData = { error: (k && k.reason) || '데이터 없음' };
  }
  renderMaterial();
}

/** key로 부문 찾기 */
function koimaCatOf(key) {
  if (!_koimaData || _koimaData.error) return null;
  return _koimaData.categories.find((c) => c.key === key) || null;
}

/** 탭 표시 순서대로 정렬된 부문 목록 (KOIMA_TAB_ORDER에 없는 부문은 뒤에 붙임) */
function koimaCatsOrdered() {
  if (!_koimaData || _koimaData.error) return [];
  const cats = _koimaData.categories;
  const known = KOIMA_TAB_ORDER.map((k) => cats.find((c) => c.key === k)).filter(Boolean);
  const rest = cats.filter((c) => !KOIMA_TAB_ORDER.includes(c.key));
  return known.concat(rest);
}

/** 'YYYY-MM' → 정수 월 인덱스(정렬·차이 계산용) */
function koimaMonthIdx(p) {
  const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7));
  return y * 12 + (m - 1);
}

/** 선택 부문의 연도 목록(오름차순) */
function koimaYears(cat) {
  const set = new Set((cat.rows || []).map((r) => r.period.slice(0, 4)));
  return Array.from(set).sort();
}

/** 선택 부문 + 연도의 월 목록(오름차순, 2자리) */
function koimaMonths(cat, year) {
  return (cat.rows || []).filter((r) => r.period.slice(0, 4) === year)
    .map((r) => r.period.slice(5, 7)).sort();
}

/** 끝점이 선택 부문에 없으면 가장 가까운(≤) 기간으로, 없으면 첫 기간으로 보정.
 *  희소금속(2010-01~)처럼 구간이 짧은 부문으로 탭을 옮길 때 필요하다. */
function koimaClampEnd(cat, end) {
  const rows = cat.rows || [];
  if (!rows.length) return null;
  if (!end) return rows[rows.length - 1].period;
  if (rows.some((r) => r.period === end)) return end;
  const le = rows.filter((r) => r.period <= end);
  return le.length ? le[le.length - 1].period : rows[0].period;
}

/** 끝점 + 기간칩 → 표시할 rows. 기간은 끝점에서 N개월 소급(끝점 포함). */
function koimaSliceRows() {
  const cat = koimaCatOf(_koimaCat);
  if (!cat || !_koimaRange) return [];
  const end = koimaClampEnd(cat, _koimaEnd);
  if (!end) return [];
  const rng = KOIMA_RANGES.find((r) => r.key === _koimaRange);
  const months = rng ? rng.months : null;
  const endIdx = koimaMonthIdx(end);
  return (cat.rows || []).filter((r) => {
    const i = koimaMonthIdx(r.period);
    if (i > endIdx) return false;                       // 끝점 이후는 제외
    return months == null ? true : i > endIdx - months; // N개월 소급(끝점 포함 = N개)
  });
}

/** 증감 표기: "0.04 (▲0.14%)" — ▲빨강 / ▼파랑 */
function koimaDelta(val, pct) {
  if (val == null && pct == null) return '<span class="koima-chg flat">–</span>';
  const v = val == null ? (pct || 0) : val;
  const cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
  const arrow = v > 0 ? '▲' : (v < 0 ? '▼' : '–');
  const av = val == null ? '-' : Math.abs(val).toFixed(2);
  const ap = pct == null ? '-' : Math.abs(pct).toFixed(2);
  return `<span class="koima-chg ${cls}">${av} (${arrow}${ap}%)</span>`;
}

/* ══ KOIMA 부문별 지수 인사이트 대시보드 ═══════════════════════════════════
   배너 → 요약 4박스 → ① 추이+기간별 변동률 → ② 변동요인 5카드
   → ③ 최근 12개월 표 → ④ 향후 전망(그래프) → 시사점 3카드 → 하단 요약
   ★ 기존 조작부(부문 8버튼 · 기준 년월 · 기간칩)는 건드리지 않는다.
   ★★ 화면의 숫자는 전부 그 부문의 실제 rows 에서 계산한다.
     JSON(koima-insights.json)에는 해설 문장만 있고 수치는 없다 —
     그래야 부문을 바꿔도 문구와 그래프가 어긋나지 않는다. */
const KOIMA_INS_URL = 'public/data/koima-insights.json';
let _koimaIns = null;

// ① 차트 뷰박스 높이 — 옆에 붙는 '기간별 변동률' 패널(5행, 약 290px)과 키를 맞춘다.
// 공용 VIZ_H(158)로는 너무 납작해 오른쪽 패널 아래가 크게 빈다.
const KOIMA_CHART_H = 250;
const KOIMA_FC_H = 168;        // ④ 전망 미니차트 높이
const KOIMA_FC_MONTHS = 6;     // 전망 지평(개월) — 3개월·6개월 두 지점을 읽는다
const KOIMA_TREND_WIN = 12;    // 추세를 재는 창(개월)
const KOIMA_VOL_WIN = 12;      // 변동성을 재는 창(개월)
const KOIMA_EV_WIN = 6;        // 이벤트 영향도를 재는 창(개월)

async function fetchKoimaInsights() {
  try {
    const res = await fetch(KOIMA_INS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _koimaIns = d;
  } catch (e) {
    _koimaIns = null;
    console.warn('[koima-insights] 로드 실패:', e);
  }
  renderMaterial();
}

/** 지금 고른 부문의 해설 묶음. 없으면 null */
function koimaInsOf(key) {
  const cs = _koimaIns && _koimaIns.cats;
  return (cs && cs[key]) || null;
}

/** 'YYYY-MM' + n개월 */
function koimaAddMonth(p, n) {
  const t = koimaMonthIdx(p) + n;
  return String(Math.floor(t / 12)) + '-' + String((t % 12) + 1).padStart(2, '0');
}

/** 부문 전체 통계 — 요약·변동률·전망·요약문이 모두 이 값을 쓴다.
 *  ★ '기준 년월'까지만 잘라서 계산한다. 기준월을 과거로 옮기면 요약도 그 시점 기준이 된다. */
function koimaStatFull(cat) {
  const all = ((cat && cat.rows) || []).filter((r) => r.index != null && isFinite(r.index));
  if (all.length < 2) return null;
  const end = koimaClampEnd(cat, _koimaEnd);
  const upto = end ? all.filter((r) => r.period <= end) : all;
  const rs = upto.length >= 2 ? upto : all;
  const last = rs[rs.length - 1];
  const at = (back) => {
    const t = koimaMonthIdx(last.period) - back;
    return rs.find((r) => koimaMonthIdx(r.period) === t) || null;
  };
  const chg = (back) => {
    const r = at(back);
    return (r && r.index) ? ((last.index - r.index) / r.index) * 100 : null;
  };
  const w = rs.slice(-12).map((r) => r.index);
  const mx = rs.reduce((a, b) => (b.index > a.index ? b : a), rs[0]);
  const mn = rs.reduce((a, b) => (b.index < a.index ? b : a), rs[0]);
  return {
    ym: last.period, v: last.index, mom: last.momPct, yoy: last.yoyPct,
    momAt: at(1), yoyAt: at(12),
    avg12: w.reduce((a, b) => a + b, 0) / w.length,
    avgFrom: rs[Math.max(0, rs.length - 12)].period, avgTo: last.period, avgN: w.length,
    c3: chg(3), c6: chg(6), c12: chg(12),
    at3: at(3), at6: at(6), at12: at(12),
    max: { v: mx.index, ym: mx.period }, min: { v: mn.index, ym: mn.period },
    n: rs.length, from: rs[0].period, to: last.period, rows: rs,
  };
}

/** ④ 전망 — 최근 12개월 추세 + 최근 12개월 변동성. 통계적 추정이고 예측모델이 아니다. */
function koimaForecast(rows) {
  const v = (rows || []).map((r) => r.index).filter((x) => x != null && isFinite(x));
  if (v.length < 8) return null;
  const xs = v.slice(-KOIMA_TREND_WIN), n = xs.length;
  const xm = (n - 1) / 2, ym = xs.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  xs.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) * (i - xm); });
  if (!den) return null;
  const slope = num / den, base = v[v.length - 1];
  const w = v.slice(-(KOIMA_VOL_WIN + 1)), r = [];
  for (let i = 1; i < w.length; i += 1) if (w[i - 1] > 0 && w[i] > 0) r.push(Math.log(w[i] / w[i - 1]));
  if (r.length < 3) return null;
  const rm = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - rm) * (b - rm), 0) / (r.length - 1));
  const baseYm = rows[rows.length - 1].period;
  const path = [];
  for (let m = 1; m <= KOIMA_FC_MONTHS; m += 1) {
    const med = Math.max(0, base + slope * m), band = sd * Math.sqrt(m);
    path.push({
      m: m, ym: koimaAddMonth(baseYm, m), med: med,
      lo: med * Math.exp(-band), hi: med * Math.exp(band),
    });
  }
  const pc = (p) => (base ? ((p.med - base) / base) * 100 : 0);
  const p3 = path[2], p6 = path[KOIMA_FC_MONTHS - 1];
  return {
    base: base, baseYm: baseYm, path: path, m3: p3, m6: p6,
    sd: sd * 100, sd3: sd * Math.sqrt(3) * 100, sd6: sd * Math.sqrt(6) * 100,
    chg3: pc(p3), chg6: pc(p6),
    dir: (pc(p6) > 3 ? 'up' : (pc(p6) < -3 ? 'down' : 'flat')),
    from: rows[Math.max(0, rows.length - KOIMA_TREND_WIN)].period, to: baseYm,
  };
}

/** 부문 공통 이벤트 목록을 '이 부문 데이터'로 검증해 마커용으로 만든다.
 *  ★ 수집 범위를 벗어난 이벤트는 아예 빼고(희소금속의 1998·2008),
 *    이벤트 후 KOIMA_EV_WIN 개월 최대변동이 기준치 미만이면 ref(참고용)로 표시한다.
 *    → "부문별로 실제 흐름과 맞지 않는 이벤트"를 눈속임 없이 가려낸다. */
function koimaEventItems(cat) {
  const evs = (_koimaIns && Array.isArray(_koimaIns.events)) ? _koimaIns.events : [];
  const rows = ((cat && cat.rows) || []).filter((r) => r.index != null && isFinite(r.index));
  if (!evs.length || rows.length < 2) return [];
  const refPct = (_koimaIns && isFinite(_koimaIns.eventRefPct)) ? _koimaIns.eventRefPct : 12;
  const by = {};
  rows.forEach((r) => { by[r.period] = r.index; });
  const out = [];
  evs.forEach((e) => {
    const b = by[e.date];
    if (b == null || !b) return;                       // 수집 범위 밖 → 표시하지 않는다
    const t0 = koimaMonthIdx(e.date);
    let ext = b;
    rows.forEach((r) => {
      const dm = koimaMonthIdx(r.period) - t0;
      if (dm >= 0 && dm <= KOIMA_EV_WIN && Math.abs(r.index - b) > Math.abs(ext - b)) ext = r.index;
    });
    const imp = ((ext - b) / b) * 100;
    const ref = Math.abs(imp) < refPct;
    out.push({
      date: e.date, ref: ref,
      label: String(e.label || '') + (ref ? ' *' : ''),
      detail: String(e.detail || '') + ' 이 부문에서는 이후 ' + KOIMA_EV_WIN + '개월간 최대 '
        + (imp > 0 ? '+' : '') + imp.toFixed(1) + '% 움직였습니다.'
        + (ref ? ' 변동이 뚜렷하지 않아 참고용으로만 표시합니다.' : ''),
    });
  });
  return out;
}

/** 요약 4박스 — 앞 3칸은 수치, 4칸은 부문 실데이터로 자동 요약한 3줄 */
function koimaSum4(cat, st, fc) {
  if (!cat || !st) return '';
  const n2 = (v) => (v == null || !isFinite(v) ? '—' : v.toFixed(2));
  const boxes = matSum([
    {
      label: cat.label + ' 지수', val: matVal(st.v, '', 2),
      sub: escapeHtml(st.ym) + ' 기준 · 전월비 ' + matBadge(st.mom, 2),
    },
    {
      label: '전년 동월 대비', val: matBadge(st.yoy, 2),
      sub: st.yoyAt ? escapeHtml(st.yoyAt.period) + ' ' + n2(st.yoyAt.index) + ' 대비' : '자료 제공값',
    },
    {
      label: '최근 12개월 평균', val: matVal(st.avg12, '', 1),
      sub: escapeHtml(st.avgFrom) + '~' + escapeHtml(st.avgTo) + ' ' + st.avgN + '개월 실측',
    },
  ]);
  const bullets = koimaAutoBullets(cat, st, fc)
    .map((t) => '<li>' + iiEmph(t) + '</li>').join('');
  const ins = bullets
    ? '<div class="sr-sum__box koima-insbox"><div class="sr-sum__lbl">주요 인사이트 요약</div>'
      + '<ul class="koima-insbox__ul">' + bullets + '</ul></div>'
    : '';
  // matSum 이 만든 .sr-sum 그리드의 '맨 끝'에 4번째 칸으로 끼워 넣는다(칸 폭·테두리 재사용).
  // ★ 문자열 치환으로 찾으면 1번 박스 끝의 '</div></div>' 에 먼저 걸려 순서가 뒤바뀐다 —
  //   마지막 </div>(= .sr-sum 을 닫는 것) 앞에 위치로 넣는다.
  if (!ins) return boxes;
  const k = boxes.lastIndexOf('</div>');
  return k < 0 ? boxes + ins : boxes.slice(0, k) + ins + boxes.slice(k);
}

/** 요약 3줄 — 전부 그 부문 실측값에서 만든다(부문마다 문장이 달라진다) */
function koimaAutoBullets(cat, st, fc) {
  if (!cat || !st) return [];
  const n2 = (v) => (v == null || !isFinite(v) ? '—' : v.toFixed(2));
  const pc = (v, d) => (v == null || !isFinite(v) ? '—'
    : (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d) + '%');
  const dirWord = (v) => (v == null || !isFinite(v) ? '보합'
    : (v > 3 ? '상승' : (v < -3 ? '하락' : '보합')));
  const out = [];
  out.push(cat.label + ' 지수는 ' + st.ym + ' 기준 **' + n2(st.v) + '**로 전월대비 '
    + pc(st.mom, 2) + ', 전년동월대비 ' + pc(st.yoy, 2) + '입니다.');
  const vsAvg = st.avg12 ? ((st.v - st.avg12) / st.avg12) * 100 : null;
  out.push('최근 6개월 ' + pc(st.c6) + ' · 12개월 ' + pc(st.c12) + '로 '
    + dirWord(st.c6) + ' 흐름이며, 최근 12개월 평균(' + n2(st.avg12) + ') 대비 '
    + pc(vsAvg) + ' 수준입니다.');
  const fromMax = st.max.v ? ((st.v - st.max.v) / st.max.v) * 100 : null;
  const fromMin = st.min.v ? ((st.v - st.min.v) / st.min.v) * 100 : null;
  out.push('수집 구간(' + st.from + '~' + st.to + ') 최고 ' + n2(st.max.v) + '(' + st.max.ym
    + ') 대비 ' + pc(fromMax) + ', 최저 ' + n2(st.min.v) + '(' + st.min.ym + ') 대비 '
    + pc(fromMin) + ' 위치입니다.');
  if (fc) {
    out.push('추세를 그대로 연장하면 3개월 후 ' + pc(fc.chg3) + ' 부근이나, 이는 통계적 추정입니다.');
  }
  return out.slice(0, 3);
}

/** ① 우측 '기간별 변동률' 패널 */
function koimaChangePanel(cat, st) {
  if (!cat || !st) return '';
  const n2 = (v) => (v == null || !isFinite(v) ? '—' : v.toFixed(2));
  const row = (lbl, pct, ref) => '<tr><th scope="row">' + escapeHtml(lbl) + '</th>'
    + '<td class="koima-chgt__v">' + matBadge(pct, 2) + '</td>'
    + '<td class="koima-chgt__b">' + (ref ? escapeHtml(ref.period) + ' ' + n2(ref.index) : '—') + '</td></tr>';
  return '<div class="koima-side">'
    + '<div class="koima-side__h">기간별 변동률 <i>' + escapeHtml(st.ym) + ' 기준</i></div>'
    + '<div class="koima-chgt-wrap"><table class="koima-chgt">'
    + '<thead><tr><th>구간</th><th>변동률</th><th>비교 시점</th></tr></thead><tbody>'
    + row('전월 대비', st.mom, st.momAt)
    + row('전년 동월 대비', st.yoy, st.yoyAt)
    + row('최근 3개월', st.c3, st.at3)
    + row('최근 6개월', st.c6, st.at6)
    + row('최근 12개월', st.c12, st.at12)
    + '</tbody></table></div>'
    + '<div class="ii-cap">전월·전년 대비는 자료 제공값, 3·6·12개월은 기준월과 해당 시점 '
    + '지수로 직접 계산한 값입니다. 비교 시점에 자료가 없으면 &mdash;로 둡니다.</div>'
    + '</div>';
}

/** ② 주요 변동요인 5카드 — 부문마다 다른 목록을 JSON 에서 가져온다 */
function koimaFactors(cat) {
  const ins = koimaInsOf(cat && cat.key);
  const list = (ins && Array.isArray(ins.factors)) ? ins.factors : [];
  if (!list.length) return '';
  const tone = { up: 'hi', down: 'bal', both: 'neu' };
  const cards = list.map((f) => '<div class="sr-fac sr-fac--' + escapeHtml(tone[f.dir] || 'neu') + '">'
    + '<div class="sr-fac__top">'
    + '<span class="sr-fac__ico" aria-hidden="true">' + escapeHtml(f.icon || '•') + '</span>'
    + '<span class="sr-fac__title">' + escapeHtml(f.title || '') + '</span>'
    + '</div>'
    + '<div class="xsii-fac__tags">'
    + (f.dirLabel ? '<span class="xsii-dir xsii-dir--' + escapeHtml(f.dir || 'both') + '">'
      + escapeHtml(f.dirLabel) + '</span>' : '')
    + '</div>'
    + '<p class="sr-fac__desc">' + escapeHtml(f.desc || '') + '</p>'
    + '</div>').join('');
  return '<div class="ii-panel"><h3 class="subhead ii-h">② 주요 변동요인 분석 '
    + '<span class="koima-h__cat">' + escapeHtml(cat.label) + '</span></h3>'
    + '<div class="sr-facs koima-facs">' + cards + '</div>'
    + '<div class="ii-cap">판정 배지는 해당 요인이 지수를 끌어올리는 쪽(상승요인)인지 '
    + '끌어내리는 쪽(하락요인)인지에 대한 정성 판단이며, 계산값이 아닙니다.</div></div>';
}

/** ④ 향후 전망 미니차트 — 실측 12개월 + 추정 6개월(중앙선 점선 + 음영대) */
function koimaFcChart(cat, st, fc) {
  if (!cat || !st || !fc) return '';
  const color = KOIMA_COLORS[cat.key] || 'var(--accent)';
  const hist = st.rows.slice(-12);
  const pts = hist.map((r) => ({ ym: r.period, v: r.index }));
  const n = pts.length + fc.path.length;
  const W = VIZ_W, H = KOIMA_FC_H;
  const padL = 44, padR = 54, padT = VIZ_PAD_T + 4, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const lo = Math.min(...pts.map((p) => p.v), ...fc.path.map((p) => p.lo));
  const hi = Math.max(...pts.map((p) => p.v), ...fc.path.map((p) => p.hi));
  const pad = (hi - lo) * 0.1 || Math.max(1, hi * 0.05);
  const ymin = lo - pad, ymax = hi + pad;
  const X = (i) => padL + (i / (n - 1)) * plotW;
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW)
      + '" y2="' + y.toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/>'
      + '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="'
      + VIZ_FS_AXIS + '" fill="var(--muted)">' + val.toFixed(val >= 100 ? 0 : 1) + '</text>';
  }).join('');

  let dh = '';
  pts.forEach((p, i) => { dh += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1) + ' '; });
  const iBase = pts.length - 1;
  let df = 'M' + X(iBase).toFixed(1) + ' ' + Y(fc.base).toFixed(1) + ' ';
  fc.path.forEach((p, j) => { df += 'L' + X(iBase + 1 + j).toFixed(1) + ' ' + Y(p.med).toFixed(1) + ' '; });
  let up = 'M' + X(iBase).toFixed(1) + ' ' + Y(fc.base).toFixed(1) + ' ';
  fc.path.forEach((p, j) => { up += 'L' + X(iBase + 1 + j).toFixed(1) + ' ' + Y(p.hi).toFixed(1) + ' '; });
  for (let j = fc.path.length - 1; j >= 0; j -= 1) {
    up += 'L' + X(iBase + 1 + j).toFixed(1) + ' ' + Y(fc.path[j].lo).toFixed(1) + ' ';
  }
  up += 'Z';

  // x축 라벨 — 실측 첫 달, 기준월, 3개월 후, 6개월 후만 찍어 겹칠 일이 없게 한다
  const marks = [[0, pts[0].ym, 'start'], [iBase, fc.baseYm, 'middle'],
    [iBase + 3, fc.m3.ym, 'middle'], [n - 1, fc.m6.ym, 'end']];
  const xlab = marks.map(([i, t, a]) => '<text x="' + X(i).toFixed(1) + '" y="'
    + (padT + plotH + 15).toFixed(1) + '" text-anchor="' + a + '" font-size="' + VIZ_FS_AXIS
    + '" fill="var(--muted)">' + escapeHtml(t) + '</text>').join('');

  const n1 = (v) => v.toFixed(1);
  const tag = (i, p, lbl) => '<g><circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.med).toFixed(1)
    + '" r="2.6" fill="' + color + '" stroke="var(--surface-1)" stroke-width="1.4"/>'
    + '<text x="' + (X(i) + 5).toFixed(1) + '" y="' + (Y(p.med) - 4).toFixed(1)
    + '" text-anchor="start" font-size="7.5" font-weight="700" paint-order="stroke"'
    + ' stroke="var(--surface-1)" stroke-width="2.5" fill="var(--ink)">' + escapeHtml(lbl)
    + ' ' + n1(p.med) + '</text></g>';

  return '<svg class="viz-svg koima-fc-svg" viewBox="0 0 ' + W + ' ' + H + '"'
    + ' preserveAspectRatio="xMidYMid meet" role="img" aria-label="'
    + escapeHtml(cat.label) + ' 향후 ' + KOIMA_FC_MONTHS + '개월 지수 추정 범위">'
    + grid
    + '<text x="2" y="7.5" font-size="7.5" fill="var(--muted)">지수 (2010.12=100 기준)</text>'
    + '<path d="' + up + '" fill="' + color + '" opacity=".14"/>'
    + '<path d="' + dh.trim() + '" fill="none" stroke="' + color + '" stroke-width="1.9"'
    + ' stroke-linejoin="round" stroke-linecap="round"/>'
    + '<path d="' + df.trim() + '" fill="none" stroke="' + color + '" stroke-width="1.7"'
    + ' stroke-dasharray="4 3" stroke-linecap="round"/>'
    + '<line x1="' + X(iBase).toFixed(1) + '" y1="' + padT + '" x2="' + X(iBase).toFixed(1)
    + '" y2="' + (padT + plotH).toFixed(1) + '" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3"/>'
    + '<text x="' + (X(iBase) - 3).toFixed(1) + '" y="' + (padT + 8).toFixed(1)
    + '" text-anchor="end" font-size="7.5" font-weight="700" fill="var(--muted)">실측</text>'
    + '<text x="' + (X(iBase) + 3).toFixed(1) + '" y="' + (padT + 8).toFixed(1)
    + '" text-anchor="start" font-size="7.5" font-weight="700" fill="var(--muted)">추정</text>'
    + tag(iBase + 3, fc.m3, '3개월')
    + tag(n - 1, fc.m6, '6개월')
    + xlab
    + '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW)
    + '" y2="' + (padT + plotH) + '" stroke="var(--axis)" stroke-width="1"/>'
    + '</svg>';
}

/** ④ 향후 전망 패널 */
function koimaOutlook(cat, st, fc) {
  if (!cat || !st) return '';
  if (!fc) {
    return '<div class="ii-panel"><h3 class="subhead ii-h">④ 향후 전망 '
      + '<span class="xsi-fc__tag">추정치</span></h3>'
      + '<div class="ii-cap">추세와 변동성을 잴 만큼의 월별 관측치가 없어 전망을 내지 않았습니다.</div></div>';
  }
  const n1 = (v) => v.toFixed(1);
  const pc = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  const cell = (lbl, p, ch, sd) => '<div class="koima-fc__box">'
    + '<div class="koima-fc__lbl">' + escapeHtml(lbl) + ' <i>' + escapeHtml(p.ym) + '</i></div>'
    + '<div class="koima-fc__val">' + n1(p.med) + '<span class="koima-fc__pc '
    + iiCls(ch) + '">' + pc(ch) + '</span></div>'
    + '<div class="koima-fc__rng">추정 범위 ' + n1(p.lo) + ' ~ ' + n1(p.hi)
    + ' <span class="koima-fc__sd">±' + sd.toFixed(1) + '%</span></div></div>';
  return '<div class="ii-panel"><h3 class="subhead ii-h">④ 향후 전망 '
    + '<span class="xsi-fc__tag">추정치</span></h3>'
    + '<div class="koima-fc">'
    + '<div class="koima-fc__boxes">'
    + '<div class="koima-fc__box koima-fc__box--now">'
    + '<div class="koima-fc__lbl">현재 지수 <i>' + escapeHtml(fc.baseYm) + '</i></div>'
    + '<div class="koima-fc__val">' + n1(fc.base) + '</div>'
    + '<div class="koima-fc__rng">실측값</div></div>'
    + cell('3개월 후', fc.m3, fc.chg3, fc.sd3)
    + cell('6개월 후', fc.m6, fc.chg6, fc.sd6)
    + '</div>'
    + koimaFcChart(cat, st, fc)
    + '</div>'
    + '<div class="ii-cap">※ 참고용 추정치이며 실제 예측이 아닙니다. 최근 '
    + KOIMA_TREND_WIN + '개월(' + escapeHtml(fc.from) + '~' + escapeHtml(fc.to)
    + ') 지수의 １차 추세를 그대로 연장한 중앙선에, 최근 ' + KOIMA_VOL_WIN
    + '개월 월별 등락의 표준편차(월 ±' + fc.sd.toFixed(1) + '%)를 기간의 제곱근으로 넓힌 '
    + '범위를 음영으로 얹은 것입니다. 시장 전망이나 공급사 제시가와는 무관합니다.</div></div>';
}

/** 시사점 및 대응 방안 3카드 — 단기(빨강)·중장기(파랑)·추가고려(녹색) */
function koimaActions(cat) {
  const ins = koimaInsOf(cat && cat.key);
  const list = (ins && Array.isArray(ins.actions)) ? ins.actions : [];
  if (!list.length) return '';
  const cols = list.map((a) => '<div class="ii-imp ii-imp--' + escapeHtml(a.tone || 'info') + '">'
    + '<div class="ii-imp__h">' + iiImpIcon(a.tone || 'info') + escapeHtml(a.title || '') + '</div>'
    + '<ul class="xsi-act">' + (a.items || []).map((t) => '<li>' + iiEmph(t) + '</li>').join('')
    + '</ul></div>').join('');
  const upd = (_koimaIns && _koimaIns.updated) ? String(_koimaIns.updated) : null;
  return '<div class="ii-panel"><h3 class="subhead ii-h">시사점 및 대응 방안 '
    + '<span class="koima-h__cat">' + escapeHtml(cat.label) + '</span></h3>'
    + '<div class="ii-imps">' + cols + '</div>'
    + '<div class="ii-cap">시황 해설은 주기적으로 갱신됩니다'
    + (upd ? ' (최종 갱신: ' + escapeHtml(upd) + ')' : '') + '</div></div>';
}

/** 하단 핵심 인사이트 박스 (전체 폭 남색) — 부문 실데이터 방향에 맞는 문구를 고른다 */
function koimaInsightBox(cat, st, fc) {
  const ins = koimaInsOf(cat && cat.key);
  const box = (ins && ins.insight) || null;
  if (!box || !st) return '';
  const dir = fc ? fc.dir : ((st.c6 != null && st.c6 > 3) ? 'up'
    : ((st.c6 != null && st.c6 < -3) ? 'down' : 'flat'));
  const lead = box[dir] || box.flat;
  if (!lead) return '';
  const trend = fc
    ? '<span class="xsi-ins__trend">최근 ' + KOIMA_TREND_WIN + '개월 추세 연장 기준 3개월 후 '
      + (fc.chg3 > 0 ? '+' : '') + fc.chg3.toFixed(1) + '% <i>추정</i></span>'
    : '';
  return '<div class="xsi-ins">'
    + '<div class="xsi-ins__h">핵심 인사이트' + trend + '</div>'
    + '<p class="xsi-ins__lead">' + escapeHtml(lead) + '</p>'
    + (box.action ? '<p class="xsi-ins__act">→ ' + escapeHtml(box.action) + '</p>' : '')
    + '</div>';
}

/** KOIMA 카드 HTML — 유가 카드와 동일한 3단계 빈 상태 */
function renderKoimaHtml() {
  const cap = capSrc('출처: 한국수입협회 국제원자재가격정보', SRC_LINKS.koimaIndex);
  const ok = _koimaData && !_koimaData.error && _koimaData.categories.length;
  const cat = ok ? koimaCatOf(_koimaCat) : null;
  const dis = ok ? '' : ' disabled';

  /* 남색 배너 — 다른 위젯(ICIS·해상정시성·유가·운임지수)과 같은 vizHero 를 그대로 쓴다.
     우측 배지는 '데이터 기준 {지금 고른 부문의 최신 년월}' 이다.
     ★ 제목은 부문과 무관하게 항상 고정이다. vizHero 의 note 인자(제목 뒤 <i>)에
       부문명을 넣었더니 "원자재 원가 부문별 지수 (KOIMA) 유화원료"처럼 붙어 나왔다 —
       부문명은 요약박스·범례·패널 제목 같은 콘텐츠 안에서만 보여 준다. */
  const kHero = (_koimaIns && _koimaIns.hero) || {};
  const kSt0 = (ok && cat) ? koimaStatFull(cat) : null;
  const head = vizHero('mine', kHero.title || '원자재 원가 부문별 지수 (KOIMA)',
    kHero.subtitle || '주요 원자재의 장기 추이와 변동 요인을 분석하여, 향후 방향성을 예측하고 '
      + '구매 의사결정에 활용할 수 있는 인사이트를 제공합니다.',
    kSt0 ? kSt0.ym : (_koimaData && _koimaData.latestPeriod) || '',
    null, kHero.badgePrefix || '데이터 기준');

  // 1) 부문 탭 8개 — 데이터 없으면 비활성
  const tabList = ok ? koimaCatsOrdered()
    : KOIMA_TAB_ORDER.map((k) => ({ key: k, label: KOIMA_TAB_LABELS[k] || k }));
  const tabs = `<div class="icis-years koima-tabs">${tabList.map((c) =>
    `<button class="icis-year koima-tab${c.key === _koimaCat ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-cat="${escapeHtml(c.key)}"${dis}>${escapeHtml(c.label || KOIMA_TAB_LABELS[c.key] || c.key)}</button>`).join('')}</div>`;

  // 2) 연도 + 월 드롭다운 — 로드된 데이터의 실제 범위로 동적 생성(하드코딩 없음)
  let selects;
  if (ok && cat) {
    const end = koimaClampEnd(cat, _koimaEnd) || '';
    const ey = end.slice(0, 4), em = end.slice(5, 7);
    const yOpts = koimaYears(cat).map((y) =>
      `<option value="${y}"${y === ey ? ' selected' : ''}>${y}년</option>`).join('');
    const mOpts = koimaMonths(cat, ey).map((m) =>
      `<option value="${m}"${m === em ? ' selected' : ''}>${Number(m)}월</option>`).join('');
    selects = `<label class="koima-sel"><span>기준</span>
        <select class="koima-year">${yOpts}</select>
        <select class="koima-month">${mOpts}</select></label>
      <span class="koima-avail">수집 범위 ${escapeHtml(cat.rows.length ? cat.rows[0].period : '-')} ~ ${escapeHtml(cat.rows.length ? cat.rows[cat.rows.length - 1].period : '-')}</span>`;
  } else {
    selects = `<label class="koima-sel"><span>기준</span>
      <select class="koima-year" disabled></select>
      <select class="koima-month" disabled></select></label>`;
  }
  const controls = `<div class="koima-controls">${selects}</div>`;

  // 3) 기간 칩
  const chips = `<div class="icis-years koima-ranges">${KOIMA_RANGES.map((r) =>
    `<button class="icis-year koima-range${r.key === _koimaRange ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-range="${r.key}"${dis}>${r.label}</button>`).join('')}</div>`;

  /* ★ 부문을 고르기 전 — 버튼만 두고 값은 하나도 내지 않는다.
       (운임지수의 '항로를 선택하세요'와 같은 .icis-prompt 플레이스홀더)
       기준 년월·기간 칩은 고른 부문의 수집 범위로 만들어지므로 함께 감춘다. */
  if (ok && !cat) {
    _koimaChart = null;
    return `<div class="viz-root viz-figure koima-figure">${head}
      ${tabs}
      <div class="icis-prompt">부문을 선택하세요</div>
      ${cap}
    </div>`;
  }

  /* ★ 8개 부문 모두 같은 틀로 나온다. 수치는 부문의 실제 rows 에서 계산하고,
       해설만 koima-insights.json 의 해당 부문 항목에서 가져온다. */
  const st = kSt0;
  const fc = st ? koimaForecast(st.rows) : null;
  const unitLbl = (_koimaIns && _koimaIns.unitLabel) || '지수 (2010.12=100 기준)';
  const unitCap = (_koimaIns && _koimaIns.unitCaption)
    || '이 지수는 2010년 12월을 100으로 기준 삼아, 해당 부문 원자재 가격이 기준시점 대비 '
      + '얼마나 올랐거나 내렸는지를 보여주는 지수입니다.';

  let body;
  if (!_koimaData) {                                   // 1) 데이터 없음
    body = '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>';
  } else if (_koimaData.error) {
    body = `<div class="chart-empty">데이터를 불러오지 못했습니다 (${escapeHtml(_koimaData.error)})</div>`;
  } else {
    /* ① 추이 — 기간 버튼을 직접 누르기 전에는 그래프도, 우측 '기간별 변동률'
         표도 내지 않는다. 부문 버튼만으로는 ①이 열리지 않는다.
       ★ 두 요소를 한 덩어리로 묶어 두는 이유: 변동률 표만 남으면 '기간을
         선택하세요' 안내와 수치가 같은 줄에 함께 떠 선택 전인지 후인지
         헷갈린다. ①은 기간을 고른 뒤에만 채운다. */
    const rows = _koimaRange ? koimaSliceRows() : [];
    let trendBody;
    if (!_koimaRange) {
      _koimaChart = null;
      trendBody = '<div class="icis-prompt">기간을 선택하세요</div>';
    } else {
      const evItems = koimaEventItems(cat);
      const refN = evItems.filter((e) => e.ref).length;
      const chartCell = vizUnitCap(unitLbl, false)
        + buildKoimaChart(rows, cat, KOIMA_CHART_H, evItems)
        + '<div class="viz-tooltip" id="koimaTooltip"></div>'
        + '<div class="ii-cap ii-cap--chart">' + escapeHtml(unitCap)
          + ' 표시 구간은 위 기간 버튼과 기준 년월을 따릅니다.'
          + (evItems.length ? ' 주요 사건 마커는 이 부문 데이터로 검증한 것이며'
            + (refN ? ', * 표시 ' + refN + '건은 이 부문에서 변동이 뚜렷하지 않아 참고용입니다'
              : '') + '.' : '')
        + '</div>';
      trendBody = '<div class="koima-row"><div class="koima-row__main">' + chartCell + '</div>'
        + koimaChangePanel(cat, st) + '</div>';
    }
    // 제목 뒤에는 '지금 그려진 구간'을 적는다 — 수집 전 구간과 헷갈리지 않게,
    // 기간 버튼을 안 골랐을 때만 수집 범위를 보여준다.
    const allRows = ((cat && cat.rows) || []).filter((r) => r.index != null);
    const span = (_koimaRange && rows.length)
      ? '표시 ' + rows[0].period + '~' + rows[rows.length - 1].period
        + ' (' + rows.length + '개월)'
      : (allRows.length ? '수집 ' + allRows[0].period + '~'
        + allRows[allRows.length - 1].period : '');
    const trend = '<div class="ii-panel koima-panel--first">'
      + '<h3 class="subhead ii-h">① 지수 추이'
      + (cat ? ' <span class="koima-h__cat">' + escapeHtml(cat.label)
        + (span ? ' · ' + escapeHtml(span) : '') + '</span>' : '') + '</h3>'
      + trendBody + '</div>';
    /* ★ ②③④·시사점·핵심인사이트도 기간을 고른 뒤에만 낸다.
         부문 버튼만으로 열리는 것은 배너·상단 요약박스·조작부(기준 년월·기간 칩)와
         ① 자리의 안내 문구까지다 — 섹션 공통 규칙과 같다. */
    body = trend + (_koimaRange
      ? koimaFactors(cat)
        + koimaRecentPanel(cat, st)
        + koimaOutlook(cat, st, fc)
        + koimaActions(cat)
        + koimaInsightBox(cat, st, fc)
      : '');
  }
  const koimaSum = (ok && cat && st) ? koimaSum4(cat, st, fc) : '';
  return `<div class="viz-root viz-figure koima-figure">${head}${koimaSum}${tabs}${controls}${chips}${body}${cap}</div>`;
}

/** ③ 최근 12개월 지수 현황 — 기존 2열 표를 그대로 쓰고 패널로만 감싼다.
 *  ★ 기간칩과 무관하게 '기준 년월에서 12개월'을 보여준다(표 제목에 구간을 적는다). */
function koimaRecentPanel(cat, st) {
  if (!cat || !st) return '';
  const rows = st.rows.slice(-12);
  if (!rows.length) return '';
  return '<div class="ii-panel"><h3 class="subhead ii-h">③ 최근 12개월 지수 현황</h3>'
    + '<div class="koima-recent">' + koimaRecentTable(rows, cat) + '</div></div>';
}

/** 단일 시리즈 월별 선그래프 (dot 없음, Y축 auto — 0에서 시작하지 않음) */
function buildKoimaChart(rows, cat, hOpt, evItems) {
  const n = rows.length;
  if (!n || !cat) { _koimaChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const color = KOIMA_COLORS[cat.key] || 'var(--accent)';
  const periods = rows.map((r) => r.period);
  const values = rows.map((r) => (r.index == null ? null : r.index));
  const all = values.filter((v) => v != null);
  if (!all.length) { _koimaChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }

  // domain ['auto','auto'] 대응: 0으로 내리지 않고 데이터 범위 ±8% 여백만 둔다
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.08 || Math.max(1, ymax * 0.05);
  ymin -= yp; ymax += yp;

  // ★ 뷰박스 높이만 이 차트에서 늘린다(공용 VIZ_H 를 바꾸면 대시보드 차트가 전부 커진다).
  //   padT 는 Y축 단위 라벨 한 줄을 얹을 만큼만 더 띄운다 — 눈금값과 겹치지 않게.
  const W = VIZ_W, H = (hOpt && isFinite(hOpt)) ? hOpt : VIZ_H;
  const padL = 42, padR = 16, padT = VIZ_PAD_T + 9, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${val.toFixed(val >= 100 ? 0 : 1)}</text>`;
  }).join('');

  const xticks = vizTickIdx(n, plotW).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(periods[i])}</text>`;
  }).join('');

  let d = '', started = false;
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${started ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; started = true;
  });
  const line = d ? `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>` : '';

  _koimaChart = { periods, values, label: cat.label, color, geom: { X, Y, n, W, padL } };
  console.log('[koima] 차트 · %s · %s~%s · %d개 점', cat.label, periods[0], periods[n - 1], n);

  return `<div class="viz-legend koima-legend"><span class="viz-legend__item">
      <span class="viz-legend__swatch" style="background:${color}"></span>${escapeHtml(cat.label)} 지수</span></div>
    <svg class="viz-svg koima-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(cat.label)} 월간 지수">
      <text x="2" y="7.5" font-size="7.5" fill="var(--muted)">${escapeHtml((_koimaIns && _koimaIns.unitLabel) || '지수 (2010.12=100 기준)')}</text>
      ${grid}${xticks}${line}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="koima-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="koima-dots"></g>
      <rect class="koima-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
      ${vizEventsSvg(evItems || [], rows.map((r) => r.period), X, padT, plotH, W)}
    </svg>`;
}

/** 차트 아래 최근 12개월 표 — 원본처럼 2열(6행씩) 배치, 최신월이 왼쪽 위 */
function koimaRecentTable(rows, cat) {
  if (!rows.length || !cat) return '';
  const recent = rows.slice(-12).reverse();        // 최신 → 과거
  const half = Math.ceil(recent.length / 2);
  const left = recent.slice(0, half), right = recent.slice(half);
  const cells = (r) => (r
    ? `<td class="koima-t__p">${escapeHtml(r.period)}</td>
       <td class="koima-t__v">${r.index == null ? '-' : r.index.toFixed(2)}</td>
       <td>${koimaDelta(r.momValue, r.momPct)}</td>
       <td>${koimaDelta(r.yoyValue, r.yoyPct)}</td>`
    : '<td colspan="4" class="koima-t__blank"></td>');
  const body = left.map((r, i) => `<tr>${cells(r)}${cells(right[i])}</tr>`).join('');
  const hg = '<th>기간</th><th>부문별 지수</th><th>전월비(%)</th><th>전년비(%)</th>';
  return `<h3 class="subhead koima-t__head">${escapeHtml(cat.label)} 최근 ${recent.length}개월</h3>
    <div class="koima-t__wrap"><table class="koima-t">
      <thead><tr>${hg}${hg}</tr></thead><tbody>${body}</tbody>
    </table></div>`;
}

/** 크로스헤어 + 툴팁 (연-월 · 부문 · 지수) */
function wireKoimaChart() {
  const fig = document.querySelector('#materialRoot .koima-figure');
  const tip = document.getElementById('koimaTooltip');
  if (!fig || !tip || !_koimaChart) return;
  const svg = fig.querySelector('.koima-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.koima-overlay');
  const cross = svg.querySelector('.koima-cross');
  const dots = svg.querySelector('.koima-dots');
  const c = _koimaChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const v = c.values[i];
    if (v == null) { clear(); return; }
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    dots.innerHTML = `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3" fill="${c.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.periods[i])}</div>
      <div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${c.color}"></span><span>${escapeHtml(c.label)}</span><span class="viz-tt-val">${v.toFixed(2)}</span></div>`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 탭·드롭다운·칩 이벤트 (검색 버튼 없음 — 바꾸면 즉시 다시 그린다) */
function wireKoimaControls(root) {
  const fig = root.querySelector('.koima-figure');
  if (!fig) return;
  const tabsEl = fig.querySelector('.koima-tabs');
  if (tabsEl) tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.koima-tab');
    if (!b || b.disabled) return;
    // 부문을 바꾸면 이전 부문 값은 전부 버리고 새 부문으로 다시 계산한다
    _koimaCat = b.dataset.cat;
    _koimaChart = null;
    const cat = koimaCatOf(_koimaCat);
    // 끝점 보정 — 희소금속(2010-01~)처럼 구간이 짧은 부문으로 옮길 때 필요하다.
    // 아직 끝점이 없으면(첫 선택) 그 부문의 마지막 관측월로 잡힌다.
    if (cat) _koimaEnd = koimaClampEnd(cat, _koimaEnd);
    // ★ 기간도 함께 비운다 — 부문을 바꾸면 새 부문에서 기간을 다시 골라야
    //   그래프가 나온다. (부문 버튼만으로 ①이 열리지 않게 하는 규칙)
    _koimaRange = null;
    renderMaterial();
  });
  const chipsEl = fig.querySelector('.koima-ranges');
  if (chipsEl) chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.koima-range');
    if (!b || b.disabled) return;
    _koimaRange = b.dataset.range;
    renderMaterial();
  });
  const yEl = fig.querySelector('.koima-year');
  const mEl = fig.querySelector('.koima-month');
  if (yEl) yEl.addEventListener('change', () => {
    const cat = koimaCatOf(_koimaCat);
    if (!cat) return;
    const ms = koimaMonths(cat, yEl.value);
    // 연도를 바꾸면 그 연도에 있는 월로 맞춘다(현재 월이 없으면 마지막 월)
    const want = mEl && ms.includes(mEl.value) ? mEl.value : ms[ms.length - 1];
    if (want) _koimaEnd = `${yEl.value}-${want}`;
    renderMaterial();
  });
  if (mEl) mEl.addEventListener('change', () => {
    if (yEl) _koimaEnd = `${yEl.value}-${mEl.value}`;
    renderMaterial();
  });
  if (_koimaRange && _koimaData && !_koimaData.error) wireKoimaChart();
}

/** 대시보드 메인 요약용 한 줄: 유화원료 최신 지수 + 전월비.
 *  ★ 메인 그리드에서는 .panel-body가 150px로 잘리므로 materialRoot 맨 위에 둔다.
 *    포커스(원자재 섹션) 화면에서는 CSS로 숨겨 기존 카드 배치를 바꾸지 않는다. */
function renderKoimaSummaryHtml() {
  const cat = koimaCatOf(KOIMA_DEFAULT_CAT);
  if (!cat || !cat.rows || !cat.rows.length) return '';
  const r = cat.rows[cat.rows.length - 1];
  const color = KOIMA_COLORS[cat.key] || 'var(--accent)';
  return `<div class="koima-oneline">
    <span class="koima-oneline__dot" style="background:${color}"></span>
    <span class="koima-oneline__lbl">KOIMA ${escapeHtml(cat.label)}</span>
    <b class="koima-oneline__val">${r.index == null ? '-' : r.index.toFixed(2)}</b>
    <span class="koima-oneline__meta">${escapeHtml(r.period)} · 전월비 ${koimaDelta(r.momValue, r.momPct)}</span>
  </div>`;
}


/* ── 일일 국제원자재가격 (KOIMA) — 순수 추가 카드 ───────────────────────────
   ★ 월간 부문별 지수 카드와 데이터 모양이 다르다(일별 · 품목 2단 구조 ·
     전일/전주/전월 3종 증감 · 전주평균/전월평균). 코드를 복사하지 않고 새로 작성했다.
   ★ 데이터는 미리 수집해 둔 정적 JSON(public/data/koima-price.json)을 읽는다.
     60개 품목 수집에 약 167초가 걸려 요청 시점에 수집하면 업데이트 버튼이 그만큼 멈추고
     Vercel 함수 한도(최대 60초)도 넘긴다. 파일로 두면 어디서나 즉시 로드된다.
     데이터 갱신은 `python koima_price.py` 를 돌려 이 파일을 다시 만드는 방식.
   저장 구조: categories[{no,key,label,items:[{no,name,unit,market,spotFutures,
              weekAvg,monthAvg,rows:[{date,price,domValue,domPct,wowValue,wowPct,
              momValue,momPct}]}]}]  */

// 정적 데이터 파일(상대경로). Flask(static_folder='.')·정적 서버·Vercel 모두 동일 경로로 서빙된다.
const KP_DATA_URL = 'public/data/koima-price.json';
// 부문 색(품목 단일 시리즈에 부문 색을 쓴다)
const KP_COLORS = {
  petchem: '#C8102E', textile: '#0EA5E9', steel: '#3B82F6',
  nonferrous: '#64748B', rare: '#DB2777',
};
// 1단계(데이터 없음)에서도 탭 이름을 보여주기 위한 폴백 라벨 + 표시 순서
const KP_TABS = [
  { key: 'petchem', label: '유화원료' }, { key: 'textile', label: '섬유원료' },
  { key: 'steel', label: '철강재' }, { key: 'nonferrous', label: '비철금속' },
  { key: 'rare', label: '희소금속' },
];
const KP_RANGES = [
  { key: '1m', label: '1개월', days: 30 }, { key: '6m', label: '6개월', days: 182 },
  { key: '1y', label: '1년', days: 365 }, { key: 'all', label: '전체', days: null },
];

let _kpData = null;    // {baseDate,categories:[...]} | {error} | null
let _kpCat = null;     // 선택 부문 key
let _kpItem = null;    // 선택 품목 no (숫자)
let _kpRange = null;   // 선택 기간(null=미선택 → "품목과 기간을 선택하세요")
let _kpChart = null;
let _kpBusy = false;   // 수집 진행 중(업데이트 버튼이 켠다)

/** 부문 찾기 */
function kpCatOf(key) {
  if (!_kpData || _kpData.error) return null;
  return _kpData.categories.find((c) => c.key === key) || null;
}

/** 표시 순서대로 정렬된 부문 목록 */
function kpCatsOrdered() {
  if (!_kpData || _kpData.error) return [];
  const cs = _kpData.categories;
  const known = KP_TABS.map((t) => cs.find((c) => c.key === t.key)).filter(Boolean);
  return known.concat(cs.filter((c) => !KP_TABS.some((t) => t.key === c.key)));
}

/** 선택 부문의 품목 찾기 */
function kpItemOf(cat, no) {
  if (!cat || !cat.items.length) return null;
  return cat.items.find((i) => String(i.no) === String(no)) || null;
}

/** 부문의 첫 품목 no (부문 변경 시 리셋용) */
function kpFirstItemNo(cat) {
  return (cat && cat.items.length) ? cat.items[0].no : null;
}

/** 기간 칩 → 표시할 rows. 마지막 날짜에서 N일 소급. */
function kpSliceRows(item) {
  if (!item || !item.rows.length || !_kpRange) return [];
  const rng = KP_RANGES.find((r) => r.key === _kpRange);
  if (!rng || rng.days == null) return item.rows;
  const end = new Date(item.rows[item.rows.length - 1].date + 'T00:00:00');
  const from = new Date(end.getTime() - rng.days * 86400000);
  const fromStr = from.toISOString().slice(0, 10);
  return item.rows.filter((r) => r.date >= fromStr);
}

/** 숫자 표기(가격) — 소수 2자리 + 천단위 구분 */
function kpPrice(v) {
  return v == null ? '-' : Number(v).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 응답 저장. 다른 카드 상태는 건드리지 않는다. */
function applyKoimaPriceUpdate(data) {
  if (data && data.status === 'ok' && Array.isArray(data.categories) && data.categories.length) {
    _kpData = { baseDate: data.baseDate, days: data.days, categories: data.categories,
      failures: data.failures || [] };
    /* ★ 부문·품목을 기본 선택하지 않는다 — 섹션 공통 규칙(1차 필터를 직접
         누르기 전에는 요약박스까지 아무것도 내지 않는다). 예전에는 여기서
         유화원료를 자동으로 골라 버튼을 누르지 않아도 숫자가 떠 있었다. */
    _kpCat = null; _kpItem = null; _kpRange = null; _kpChart = null;
    const counts = data.categories.map((c) => `${c.label} ${c.items.length}개`).join(' · ');
    console.log('[koima-price] 기준일 %s · 부문별 품목 수: %s', data.baseDate, counts);
    if (_kpData.failures.length) {
      console.warn('[koima-price] 실패 %d건:', _kpData.failures.length, _kpData.failures);
    }
  } else {
    _kpData = { error: (data && data.reason) || '데이터 없음' };
  }
  renderMaterial();
}

/** 업데이트 버튼이 호출: 미리 수집해 둔 정적 JSON을 읽는다(즉시 완료).
 *  파일이 없으면(404) 수집 스크립트를 돌리라는 안내를 카드에 표시한다. */
async function fetchKoimaPrice() {
  _kpBusy = true;
  renderMaterial();
  try {
    const res = await fetch(KP_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 — python koima_price.py 를 실행해 생성하세요');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _kpBusy = false;
    applyKoimaPriceUpdate(data);
  } catch (e) {
    _kpBusy = false;
    _kpData = { error: (e && e.message) || String(e) };
    console.warn('[koima-price] 로드 실패:', e, '(경로:', KP_DATA_URL, ')');
    renderMaterial();
  }
}

/* ── KOIMA (월간 부문별 지수 · 일일 국제원자재가격) ─────────────────────────
   ★ 이 두 카드는 부문·품목·기간을 바꿀 때마다 renderMaterial() 이 다시 도므로
     요약 배지가 늘 현재 선택을 따라간다(유가 카드처럼 [조회] 단계가 없다).
   ★ 전월비·전년비는 KOIMA 가 직접 계산해 준 momPct/yoyPct 를 그대로 쓴다 —
     일별 자료를 월말끼리 비교하는 것보다 정확하다(msBadgesHtml 의 given 인자). */

/* ── 1) 월간 부문별 지수 ─────────────────────────────────────────────── */

/* ── 2) 일일 국제원자재가격 ──────────────────────────────────────────── */

/** 카드 HTML — 3단계 빈 상태 */
/* ══ 일일 국제원자재가격 인사이트 대시보드 ═════════════════════════════════
   배너 → 요약 5박스 → ① 추이+이벤트 → ② 변동요인 5카드 → ③ 최근 12개월 표
   → ④ 시나리오 3단 → ⑤ 시사점 3카드 → 하단 핵심요약
   ★ 조작부(부문 5버튼 · 품목 드롭다운 · 기간 4버튼)는 건드리지 않는다.
   ★★ 기간 버튼을 누르기 전에는 위 전부를 내지 않는다(섹션 공통 규칙).
   ★★★ 화면의 숫자는 전부 그 품목의 실제 rows 에서 계산한다. 60개 품목의
     개별 사건까지 확인할 수는 없으므로 ① 마커는 '구간의 방향과 실제 변동폭'만
     데이터에서 뽑고, 원인은 일반화된 문구로 둔다(단정하지 않는다). */
const KP_INS_URL = 'public/data/kp-insights.json';
let _kpIns = null;

const KP_CHART_H = 250;      // ① 차트 뷰박스 높이 — 옆 지역가격 패널과 키를 맞춘다
const KP_FC_MONTHS = 3;      // ④ 전망 지평(개월)
const KP_TREND_WIN = 12;     // 추세를 재는 창(개월)
const KP_VOL_WIN = 12;       // 변동성을 재는 창(개월)
const KP_EV_MAX = 4;         // ① 마커 최대 개수
const KP_EV_MIN_PCT = 4;     // 이 정도는 움직인 구간만 마커로 낸다(%)

async function fetchKpInsights() {
  try {
    const res = await fetch(KP_INS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _kpIns = d;
  } catch (e) {
    _kpIns = null;
    console.warn('[kp-insights] 로드 실패:', e);
  }
  renderMaterial();
}

/** 품목 해설 — 품목 개별 해설이 있으면 그것, 없으면 부문 기본값 */
function kpiInsOf(cat, item) {
  if (!_kpIns) return null;
  const byItem = _kpIns.items && item ? _kpIns.items[String(item.no)] : null;
  if (byItem) return byItem;
  return (_kpIns.cats && cat) ? (_kpIns.cats[cat.key] || null) : null;
}

/** 일별 rows → 기간 평균 묶음. gran='m'(월) | 'w'(주) */
function kpiAgg(rows, gran) {
  const g = [];
  const idx = {};
  (rows || []).forEach((r) => {
    if (r.price == null || !isFinite(r.price)) return;
    let k;
    if (gran === 'w') {
      // 주 단위 — 관측일을 7일씩 묶는다(요일 계산 없이 안정적으로)
      const t = Math.floor(new Date(r.date + 'T00:00:00').getTime() / 86400000);
      k = String(Math.floor(t / 7));
    } else {
      k = r.date.slice(0, 7);
    }
    if (idx[k] == null) { idx[k] = g.length; g.push({ k: k, date: r.date, sum: 0, n: 0 }); }
    const b = g[idx[k]];
    b.sum += r.price; b.n += 1; b.date = r.date;
  });
  return g.map((b) => ({ k: b.k, date: b.date, v: b.sum / b.n }));
}

/** 품목 통계 — 요약박스·시나리오·요약문이 모두 이 값을 쓴다 */
function kpiStat(item) {
  const rows = ((item && item.rows) || []).filter((r) => r.price != null && isFinite(r.price));
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const m = kpiAgg(rows, 'm');
  const back = (n) => (m.length > n ? m[m.length - 1 - n] : null);
  const pc = (a, b) => ((a != null && b != null && b) ? ((a - b) / b) * 100 : null);
  const cur = m.length ? m[m.length - 1].v : null;
  const w12 = m.slice(-12).map((x) => x.v);
  const mx = rows.reduce((a, b) => (b.price > a.price ? b : a), rows[0]);
  const mn = rows.reduce((a, b) => (b.price < a.price ? b : a), rows[0]);
  return {
    date: last.date, price: last.price,
    dom: last.domPct, wow: last.wowPct, mom: last.momPct,
    monthly: m, curMonth: cur,
    avg12: w12.length ? w12.reduce((a, b) => a + b, 0) / w12.length : null,
    avgFrom: m.length ? m[Math.max(0, m.length - 12)].k : '', avgTo: m.length ? m[m.length - 1].k : '',
    avgN: w12.length,
    c3: pc(cur, (back(3) || {}).v), c6: pc(cur, (back(6) || {}).v),
    c12: pc(cur, (back(12) || {}).v),
    at3: back(3), at6: back(6), at12: back(12),
    max: { v: mx.price, date: mx.date }, min: { v: mn.price, date: mn.date },
    n: rows.length, from: rows[0].date, to: last.date,
  };
}

/** ④ 전망 — 월별 평균의 추세 + 변동성. 통계적 추정이고 예측모델이 아니다. */
function kpiForecast(monthly) {
  const v = (monthly || []).map((x) => x.v).filter((x) => x != null && isFinite(x));
  if (v.length < 8) return null;
  const xs = v.slice(-KP_TREND_WIN), n = xs.length;
  const xm = (n - 1) / 2, ym = xs.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  xs.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) * (i - xm); });
  if (!den) return null;
  const slope = num / den, base = v[v.length - 1];
  const w = v.slice(-(KP_VOL_WIN + 1)), r = [];
  for (let i = 1; i < w.length; i += 1) if (w[i - 1] > 0 && w[i] > 0) r.push(Math.log(w[i] / w[i - 1]));
  if (r.length < 3) return null;
  const rm = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - rm) * (b - rm), 0) / (r.length - 1));
  const sdH = sd * Math.sqrt(KP_FC_MONTHS);
  const med = Math.max(0, base + slope * KP_FC_MONTHS);
  const chg = base ? ((med - base) / base) * 100 : 0;
  return {
    base: base, med: med, sd: sd * 100, sdH: sdH * 100,
    up: [base * Math.exp(sdH * 0.5), base * Math.exp(sdH)],
    mid: [Math.min(base, med) * Math.exp(-sdH * 0.35), Math.max(base, med) * Math.exp(sdH * 0.35)],
    dn: [base * Math.exp(-sdH), base * Math.exp(-sdH * 0.5)],
    chgPct: chg, dir: (chg > 3 ? 'up' : (chg < -3 ? 'down' : 'flat')),
    from: monthly[Math.max(0, monthly.length - KP_TREND_WIN)].k,
    to: monthly[monthly.length - 1].k,
  };
}

/** ① 이벤트 마커 — 표시 구간에서 '연속 상승/하락 구간'을 찾아 변동폭 큰 것만.
 *  ★ 개별 사건을 단정하지 않는다. 방향과 실제 변동폭은 데이터에서 계산하고
 *    원인은 일반화된 문구(JSON eventText)로 둔다. */
function kpiEvents(rows) {
  const txt = (_kpIns && _kpIns.eventText) || null;
  if (!txt || !rows || rows.length < 8) return [];
  // 표시 구간이 짧으면 주 단위로 잡아야 구간이 생긴다
  const span = rows.length;
  const agg = kpiAgg(rows, span <= 80 ? 'w' : 'm');
  if (agg.length < 4) return [];
  const segs = [];
  let i = 0;
  while (i < agg.length - 1) {
    const up = agg[i + 1].v >= agg[i].v;
    let j = i + 1;
    while (j < agg.length - 1 && ((agg[j + 1].v >= agg[j].v) === up)) j += 1;
    const a = agg[i].v, b = agg[j].v;
    if (a > 0) {
      const pct = ((b - a) / a) * 100;
      if (Math.abs(pct) >= KP_EV_MIN_PCT) {
        segs.push({ mid: agg[Math.floor((i + j) / 2)].date, pct: pct, up: pct > 0 });
      }
    }
    i = j;
  }
  segs.sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));
  return segs.slice(0, KP_EV_MAX).map((s) => {
    const t = s.up ? txt.up : txt.down;
    return {
      date: s.mid,
      label: (t.label || '') + ' ' + (s.pct > 0 ? '+' : '') + s.pct.toFixed(1) + '%',
      detail: (t.detail || '') + ' (이 구간 실측 변동 ' + (s.pct > 0 ? '+' : '')
        + s.pct.toFixed(1) + '%)',
    };
  });
}

/** 원본 자료가 한 값으로만 채워진 품목 안내.
 *  ★ 예: 몰리브덴(3M Official)은 KOIMA 원본이 780일 전부 1.00 이다. 위젯이
 *    고장난 것처럼 보이지 않도록 자료 쪽 한계임을 화면에 적는다. */
function kpiFlatNote(item) {
  const ps = ((item && item.rows) || []).map((r) => r.price)
    .filter((v) => v != null && isFinite(v));
  if (ps.length < 5) return '';
  let mn = ps[0], mx = ps[0];
  ps.forEach((v) => { if (v < mn) mn = v; if (v > mx) mx = v; });
  if (mx - mn > 0.0001) return '';
  return '<div class="ii-cap ii-cap--chart">이 품목은 원본 자료(KOIMA)가 수집 구간 '
    + ps.length + '일 전부 같은 값(' + kpPrice(mn) + ')으로 제공되어 추이·변동률·시나리오가 '
    + '모두 같은 값으로 나옵니다. 위젯 계산 문제가 아니라 자료 쪽 한계입니다.</div>';
}

/** 요약박스 4번째 칸 — 같은 기반 품목명의 지역 변형이 있으면 지역별 현재가,
 *  없으면 거래시장 정보로 대체한다(없는 지역가를 만들어내지 않는다). */
function kpiRegional(cat, item) {
  if (!cat || !item) return '';
  const base = String(item.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const sibs = (cat.items || []).filter((x) => {
    const b = String(x.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    return b === base && (x.rows || []).length;
  });
  if (sibs.length > 1) {
    const rows = sibs.map((x) => {
      const r = x.rows[x.rows.length - 1];
      const m = String(x.name || '').match(/\(([^)]*)\)\s*$/);
      const reg = m ? m[1] : x.name;
      const on = String(x.no) === String(item.no);
      return '<tr' + (on ? ' class="is-on"' : '') + '><th scope="row">' + escapeHtml(reg) + '</th>'
        + '<td class="kpi-rt__v">' + kpPrice(r.price) + '</td>'
        + '<td>' + matBadge(r.momPct, 2) + '</td></tr>';
    }).join('');
    return '<div class="sr-sum__box kpi-regbox">'
      + '<div class="sr-sum__lbl">주요 지역가격 <i>' + escapeHtml(base) + '</i></div>'
      + '<table class="kpi-rt"><tbody>' + rows + '</tbody></table>'
      + '<div class="kpi-regbox__cap">전월대비 · 조회 품목은 진하게<br>'
      + escapeHtml(item.market || '-') + ' · ' + escapeHtml(item.spotFutures || '-')
      + '</div></div>';
  }
  // 지역 변형이 없는 품목 — 거래시장/현물선물/평균으로 채운다
  const cell = (k, v) => '<tr><th scope="row">' + escapeHtml(k) + '</th>'
    + '<td class="kpi-rt__v" colspan="2">' + v + '</td></tr>';
  return '<div class="sr-sum__box kpi-regbox">'
    + '<div class="sr-sum__lbl">거래 시장 정보</div>'
    + '<table class="kpi-rt"><tbody>'
    + cell('거래시장', escapeHtml(item.market || '-'))
    + cell('현물/선물', escapeHtml(item.spotFutures || '-'))
    + cell('전주평균', kpPrice(item.weekAvg))
    + cell('전월평균', kpPrice(item.monthAvg))
    + '</tbody></table>'
    + '<div class="kpi-regbox__cap">이 품목은 지역별 자료가 없어 시장 정보로 대체</div></div>';
}

/** 핵심 인사이트 4줄 — 전부 그 품목 실측값에서 만든다 */
function kpiBullets(item, st, fc) {
  if (!item || !st) return [];
  const u = item.unit || '';
  const pc = (v, d) => (v == null || !isFinite(v) ? '—'
    : (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d) + '%');
  const dirWord = (v) => (v == null || !isFinite(v) ? '보합'
    : (v > 3 ? '상승' : (v < -3 ? '하락' : '보합')));
  const out = [];
  out.push(item.name + ' 현재가는 **' + kpPrice(st.price) + ' ' + u + '**('
    + st.date + ' 기준)로 전일대비 ' + pc(st.dom, 2) + ', 전월대비 ' + pc(st.mom, 2) + '입니다.');
  const vsAvg = st.avg12 ? ((st.curMonth - st.avg12) / st.avg12) * 100 : null;
  out.push('최근 3개월 ' + pc(st.c3) + ' · 12개월 ' + pc(st.c12) + '로 ' + dirWord(st.c3)
    + ' 흐름이며, 최근 12개월 평균(' + kpPrice(st.avg12) + ') 대비 ' + pc(vsAvg) + ' 수준입니다.');
  const fromMax = st.max.v ? ((st.price - st.max.v) / st.max.v) * 100 : null;
  const fromMin = st.min.v ? ((st.price - st.min.v) / st.min.v) * 100 : null;
  out.push('수집 구간 최고 ' + kpPrice(st.max.v) + '(' + st.max.date + ') 대비 ' + pc(fromMax)
    + ', 최저 ' + kpPrice(st.min.v) + '(' + st.min.date + ') 대비 ' + pc(fromMin) + ' 위치입니다.');
  out.push(fc
    ? '월별 변동성은 ±' + fc.sd.toFixed(1) + '%/월 수준이며, 추세를 연장하면 '
      + KP_FC_MONTHS + '개월 후 ' + pc(fc.chgPct) + ' 부근이나 이는 통계적 추정입니다.'
    : '추세와 변동성을 잴 만큼의 월별 관측치가 모이지 않아 전망은 내지 않았습니다.');
  return out;
}

/** 요약 5박스 */
function kpiSum5(cat, item, st, fc) {
  if (!cat || !item || !st) return '';
  const u = item.unit || '';
  const boxes = matSum([
    {
      label: '현재가격', val: kpPrice(st.price) + '<span class="sr-sum__u">' + escapeHtml(u) + '</span>',
      sub: escapeHtml(st.date) + ' 기준 · 전일대비 ' + matBadge(st.dom, 2),
    },
    {
      label: '전월대비', val: matBadge(st.mom, 2),
      sub: '자료 제공값 · 전주대비 ' + matBadge(st.wow, 2),
    },
    {
      label: '최근 12개월 평균', val: kpPrice(st.avg12),
      sub: escapeHtml(st.avgFrom) + '~' + escapeHtml(st.avgTo) + ' ' + st.avgN + '개월 실측',
    },
  ]);
  const reg = kpiRegional(cat, item);
  const bl = kpiBullets(item, st, fc).map((t) => '<li>' + iiEmph(t) + '</li>').join('');
  const ins = bl
    ? '<div class="sr-sum__box koima-insbox"><div class="sr-sum__lbl">핵심 인사이트</div>'
      + '<ul class="koima-insbox__ul">' + bl + '</ul></div>'
    : '';
  // matSum 이 만든 .sr-sum 그리드 끝에 4·5번째 칸을 위치로 끼워 넣는다
  const k = boxes.lastIndexOf('</div>');
  const grid = k < 0 ? boxes + reg + ins : boxes.slice(0, k) + reg + ins + boxes.slice(k);
  return grid.replace('class="sr-sum"', 'class="sr-sum kpi-sum5"');
}

/** ② 주요 변동요인 5카드 */
function kpiFactors(cat, item) {
  const ins = kpiInsOf(cat, item);
  const list = (ins && Array.isArray(ins.factors)) ? ins.factors : [];
  if (!list.length) return '';
  const tone = { up: 'hi', down: 'bal', both: 'neu' };
  const cards = list.map((f) => '<div class="sr-fac sr-fac--' + escapeHtml(tone[f.dir] || 'neu') + '">'
    + '<div class="sr-fac__top">'
    + '<span class="sr-fac__ico" aria-hidden="true">' + escapeHtml(f.icon || '•') + '</span>'
    + '<span class="sr-fac__title">' + escapeHtml(f.title || '') + '</span></div>'
    + '<div class="xsii-fac__tags">'
    + (f.dirLabel ? '<span class="xsii-dir xsii-dir--' + escapeHtml(f.dir || 'both') + '">'
      + escapeHtml(f.dirLabel) + '</span>' : '')
    + '</div>'
    + '<p class="sr-fac__desc">' + escapeHtml(f.desc || '') + '</p></div>').join('');
  const own = !!(_kpIns && _kpIns.items && _kpIns.items[String(item.no)]);
  return '<div class="ii-panel"><h3 class="subhead ii-h">② 주요 변동요인 분석 '
    + '<span class="koima-h__cat">' + escapeHtml(item.name) + '</span></h3>'
    + '<div class="sr-facs koima-facs">' + cards + '</div>'
    + '<div class="ii-cap">판정 배지는 해당 요인이 가격을 끌어올리는 쪽(상승요인)인지 '
    + '끌어내리는 쪽(하락요인)인지에 대한 정성 판단이며, 계산값이 아닙니다. '
    + (own ? '이 품목에 맞춘 해설입니다.'
      : escapeHtml(cat.label) + ' 부문 공통 해설입니다.') + '</div></div>';
}

/** ③ 최근 12개월 가격 현황 — 평균가격·전월대비·전년동월대비·주요이슈 */
function kpiMonthTable(item, st) {
  if (!item || !st || !st.monthly.length) return '';
  const m = st.monthly;
  const at = (k) => m.find((x) => x.k === k) || null;
  const back = (k, n) => {
    const y = Number(k.slice(0, 4)), mo = Number(k.slice(5, 7));
    const t = y * 12 + (mo - 1) - n;
    return at(String(Math.floor(t / 12)) + '-' + String((t % 12) + 1).padStart(2, '0'));
  };
  const win = m.slice(-12);
  const vals = win.map((x) => x.v);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const pc = (a, b) => ((a != null && b != null && b) ? ((a - b) / b) * 100 : null);
  const rows = win.slice().reverse().map((x) => {
    const mom = pc(x.v, (back(x.k, 1) || {}).v);
    const yoy = pc(x.v, (back(x.k, 12) || {}).v);
    /* '주요이슈' — 개별 사건을 단정할 수 없으므로 그 달의 실측 위치·변동폭으로 적는다 */
    let issue = '보합권';
    if (x.v === hi) issue = '12개월 최고';
    else if (x.v === lo) issue = '12개월 최저';
    else if (mom != null && Math.abs(mom) >= 5) issue = (mom > 0 ? '급등' : '급락')
      + ' 전월비 ' + (mom > 0 ? '+' : '') + mom.toFixed(1) + '%';
    else if (mom != null && Math.abs(mom) >= 2) issue = (mom > 0 ? '상승' : '하락') + ' 전환';
    return '<tr><th scope="row">' + escapeHtml(x.k) + '</th>'
      + '<td class="kpi-mt__v">' + kpPrice(x.v) + '</td>'
      + '<td>' + matBadge(mom, 2) + '</td>'
      + '<td>' + matBadge(yoy, 2) + '</td>'
      + '<td class="kpi-mt__i">' + escapeHtml(issue) + '</td></tr>';
  }).join('');
  return '<div class="ii-panel"><h3 class="subhead ii-h">③ 최근 12개월 가격 현황 '
    + '<span class="koima-h__cat">' + escapeHtml(item.unit || '') + '</span></h3>'
    + '<div class="kpi-mt-wrap"><table class="kpi-mt">'
    + '<thead><tr><th>기간</th><th>평균가격</th><th>전월대비</th><th>전년동월대비</th>'
    + '<th>주요이슈</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="ii-cap">평균가격은 그 달 관측일의 단순평균입니다. 전월·전년동월대비는 '
    + '월평균끼리 비교한 값이며, 비교할 달의 자료가 없으면 &mdash;로 둡니다. '
    + '주요이슈는 그 달의 실측 위치·변동폭에서 자동으로 붙인 표기이며 개별 사건이 아닙니다.</div></div>';
}

/** ④ 향후 시나리오별 전망 */
function kpiScenarios(item, fc) {
  const list = (_kpIns && Array.isArray(_kpIns.scenarios)) ? _kpIns.scenarios : [];
  if (!list.length) return '';
  if (!fc) {
    return '<div class="ii-panel"><h3 class="subhead ii-h">④ 향후 ' + KP_FC_MONTHS
      + '개월 시나리오별 전망 <span class="xsi-fc__tag">추정치</span></h3>'
      + '<div class="ii-cap">추세와 변동성을 잴 만큼의 월별 관측치가 없어 시나리오를 내지 않았습니다.</div></div>';
  }
  const rng = { up: fc.up, base: fc.mid, down: fc.dn };
  const u = item.unit || '';
  const rows = list.map((s) => {
    const r = rng[s.key] || [];
    return '<tr class="xsi-sc--' + escapeHtml(s.tone) + '">'
      + '<th scope="row"><span class="xsi-sc__dot"></span>' + escapeHtml(s.name)
      + '<span class="xsi-sc__prob">확률 추정 ' + Number(s.prob) + '%</span></th>'
      + '<td class="xsi-sc__val">' + kpPrice(r[0]) + '~' + kpPrice(r[1])
      + '<span class="xsi-sc__u">' + escapeHtml(u) + '</span></td>'
      + '<td class="xsi-sc__basis">' + escapeHtml(s.basis || '') + '</td>'
      + '<td>' + escapeHtml(s.assumption || '') + '</td></tr>';
  }).join('');
  return '<div class="ii-panel"><h3 class="subhead ii-h">④ 향후 ' + KP_FC_MONTHS
    + '개월 시나리오별 전망 <span class="xsi-fc__tag">추정치</span></h3>'
    + '<div class="xsi-sc-wrap"><table class="xsi-sc">'
    + '<thead><tr><th>시나리오</th><th>' + KP_FC_MONTHS + '개월 후 가격범위</th>'
    + '<th>산출 기준</th><th>주요 가정</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="ii-cap">※ 상기 확률·범위는 과거 변동성 기반 통계적 추정이며 실제 시장 전망이 아닙니다. '
    + '최근 ' + KP_VOL_WIN + '개월 월평균 등락의 표준편차(' + KP_FC_MONTHS + '개월 지평 ±'
    + fc.sdH.toFixed(1) + '%)와 최근 ' + KP_TREND_WIN + '개월(' + escapeHtml(fc.from) + '~'
    + escapeHtml(fc.to) + ') 추세로 계산했고, 확률(%)은 계산값이 아니라 시나리오 구분을 위한 '
    + '가정치입니다.</div></div>';
}

/** ⑤ 시사점 및 대응 방안 3카드 */
function kpiActions(cat, item) {
  const ins = kpiInsOf(cat, item);
  const list = (ins && Array.isArray(ins.actions)) ? ins.actions : [];
  if (!list.length) return '';
  const cols = list.map((a) => '<div class="ii-imp ii-imp--' + escapeHtml(a.tone || 'info') + '">'
    + '<div class="ii-imp__h">' + iiImpIcon(a.tone || 'info') + escapeHtml(a.title || '') + '</div>'
    + '<ul class="xsi-act">' + (a.items || []).map((t) => '<li>' + iiEmph(t) + '</li>').join('')
    + '</ul></div>').join('');
  const upd = (_kpIns && _kpIns.updated) ? String(_kpIns.updated) : null;
  return '<div class="ii-panel"><h3 class="subhead ii-h">⑤ 시사점 및 대응 방안</h3>'
    + '<div class="ii-imps">' + cols + '</div>'
    + '<div class="ii-cap">시황 해설은 주기적으로 갱신됩니다'
    + (upd ? ' (최종 갱신: ' + escapeHtml(upd) + ')' : '') + '</div></div>';
}

/** 하단 핵심 요약 (전체 폭 남색) */
function kpiInsightBox(cat, item, st, fc) {
  const ins = kpiInsOf(cat, item);
  const box = (ins && ins.insight) || null;
  if (!box || !st) return '';
  const dir = fc ? fc.dir : ((st.c3 != null && st.c3 > 3) ? 'up'
    : ((st.c3 != null && st.c3 < -3) ? 'down' : 'flat'));
  const lead = box[dir] || box.flat;
  if (!lead) return '';
  const trend = fc
    ? '<span class="xsi-ins__trend">최근 ' + KP_TREND_WIN + '개월 추세 연장 기준 '
      + KP_FC_MONTHS + '개월 후 ' + (fc.chgPct > 0 ? '+' : '') + fc.chgPct.toFixed(1)
      + '% <i>추정</i></span>' : '';
  return '<div class="xsi-ins">'
    + '<div class="xsi-ins__h">핵심 요약' + trend + '</div>'
    + '<p class="xsi-ins__lead">' + escapeHtml(item.name) + ' — ' + escapeHtml(lead) + '</p>'
    + (box.action ? '<p class="xsi-ins__act">→ ' + escapeHtml(box.action) + '</p>' : '')
    + '</div>';
}

function renderKoimaPriceHtml() {
  const cap = capSrc('출처: 한국수입협회 국제원자재가격정보', SRC_LINKS.koimaPrice);
  const ok = _kpData && !_kpData.error && _kpData.categories.length;
  const cat = ok ? kpCatOf(_kpCat) : null;
  const item = ok ? kpItemOf(cat, _kpItem) : null;
  const dis = ok ? '' : ' disabled';
  /* 남색 배너 — 다른 위젯과 같은 vizHero 를 그대로 쓴다.
     ★ 제목은 부문·품목과 무관하게 항상 고정이고, 품목명은 '부제'에만 들어간다
       (KOIMA 지수 위젯에서 제목 뒤에 부문명이 붙어 지적받은 것과 다른 자리다). */
  const kpHero = (_kpIns && _kpIns.hero) || {};
  const kpSt = (ok && item) ? kpiStat(item) : null;
  const kpSubT = kpHero.subtitle
    || '주요 글로벌 {item} 가격의 최근 흐름과 변동 요인을 분석하여, 향후 방향성과 '
      + '구매 의사결정에 필요한 인사이트를 제공합니다.';
  const head = vizHero('drum', kpHero.title || '일일 국제원자재가격 (KOIMA)',
    kpSubT.split('{item}').join(item ? item.name : '원자재'),
    kpSt ? kpSt.date : (_kpData && _kpData.baseDate) || '',
    null, kpHero.badgePrefix || '데이터 기준');

  // 1) 부문 탭 5개
  const tabSrc = ok ? kpCatsOrdered() : KP_TABS;
  const tabs = `<div class="icis-years kp-tabs">${tabSrc.map((c) =>
    `<button class="icis-year kp-tab${c.key === _kpCat ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-cat="${escapeHtml(c.key)}"${dis}>${escapeHtml(c.label)}</button>`).join('')}</div>`;

  // 2) 품목 드롭다운 — 선택된 부문의 품목만
  const opts = (ok && cat) ? cat.items.map((i) =>
    `<option value="${escapeHtml(String(i.no))}"${String(i.no) === String(_kpItem) ? ' selected' : ''}>${escapeHtml(i.name)}</option>`).join('') : '';
  const controls = `<div class="kp-controls">
    <label class="kp-sel"><span>품목</span>
      <select class="kp-item"${dis}>${opts}</select></label>
    ${(ok && cat) ? `<span class="kp-meta">${escapeHtml(cat.label)} ${cat.items.length}개 품목${_kpData.baseDate ? ` · 기준일 ${escapeHtml(_kpData.baseDate)}` : ''}</span>` : ''}
  </div>`;

  // 3) 기간 칩
  const chips = `<div class="icis-years kp-ranges">${KP_RANGES.map((r) =>
    `<button class="icis-year kp-range${r.key === _kpRange ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-range="${r.key}"${dis}>${r.label}</button>`).join('')}</div>`;

  /* ★ 부문을 고르기 전 — 탭만 두고 값은 하나도 내지 않는다.
       품목 드롭다운·기간 칩은 고른 부문의 품목 목록으로 만들어지므로 함께 감춘다.
       (KOIMA 부문별 지수 위젯과 같은 .icis-prompt 플레이스홀더) */
  if (ok && !cat && !_kpBusy) {
    _kpChart = null;
    return `<div class="viz-root viz-figure kp-figure">${head}
      ${tabs}
      <div class="icis-prompt">부문을 선택하세요</div>
      ${cap}
    </div>`;
  }

  let body;
  if (_kpBusy) {                                    // 로드 중
    body = '<div class="icis-prompt kp-busy">국제원자재가격을 불러오는 중입니다…</div>';
  } else if (!_kpData) {                            // 1) 데이터 없음
    body = '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>';
  } else if (_kpData.error) {
    body = `<div class="chart-empty">데이터를 불러오지 못했습니다 (${escapeHtml(_kpData.error)})</div>`;
  } else if (!_kpRange || !item) {                  // 2) 데이터 있음 · 미선택
    body = '<div class="icis-prompt">기간을 선택하세요</div>';
  } else {                                          // 3) 선택됨
    /* ① 추이 + 이벤트 → ② 변동요인 → ③ 최근 12개월 → ④ 시나리오
       → ⑤ 시사점 → 하단 핵심요약. 전부 기간 버튼을 누른 뒤에만 나온다.
       ★ 수치는 품목의 실제 rows 에서 계산하고, 해설만 kp-insights.json 에서 온다. */
    const rows = kpSliceRows(item);
    const st = kpSt;
    const fc = st ? kpiForecast(st.monthly) : null;
    const evs = kpiEvents(rows);
    const unitLine = (krwFactor(item.unit) != null) ? vizUnitCap(item.unit || '', 'USD')
      : '<div class="viz-unit">단위: ' + escapeHtml(item.unit || '-') + '</div>';
    body = '<div class="ii-panel koima-panel--first">'
      + '<h3 class="subhead ii-h">① 가격 추이 및 주요 이벤트'
      + (rows.length ? ' <span class="koima-h__cat">' + escapeHtml(item.name)
        + ' · 표시 ' + escapeHtml(rows[0].date) + '~'
        + escapeHtml(rows[rows.length - 1].date) + ' (' + rows.length + '일)</span>' : '')
      + '</h3>'
      + unitLine
      + buildKpChart(rows, item, cat, KP_CHART_H, evs)
      + '<div class="viz-tooltip" id="kpTooltip"></div>'
      + kpiFlatNote(item)
      + '<div class="ii-cap ii-cap--chart">마커는 표시 구간에서 변동폭이 큰 '
        + '연속 상승·하락 구간을 데이터에서 찾아 표시한 것입니다. 방향과 변동폭은 실측값이지만 '
        + '개별 사건은 확인하지 않았으므로, 원인은 일반화된 문구로 두었습니다.'
        + (evs.length ? '' : ' (이 구간에서는 기준치를 넘는 구간이 없어 마커가 없습니다.)')
      + '</div>'
      + '</div>'
      + kpiFactors(cat, item)
      + kpiMonthTable(item, st)
      + kpiScenarios(item, fc)
      + kpiActions(cat, item)
      + kpiInsightBox(cat, item, st, fc);
  }
  const warn = (ok && _kpData.failures && _kpData.failures.length)
    ? `<div class="kp-warn">일부 품목 수집 실패 ${_kpData.failures.length}건 (해당 품목은 목록에서 제외)</div>` : '';
  // 요약 5박스 — 현재가격·전월대비·12개월평균·지역가격·핵심인사이트.
  // ★ 기간 버튼을 누르기 전에는 내지 않는다(섹션 공통 규칙).
  const kpSum5 = (ok && _kpRange && item && kpSt) ? kpiSum5(cat, item, kpSt,
    kpiForecast(kpSt.monthly)) : '';
  return `<div class="viz-root viz-figure kp-figure">${head}${kpSum5}${tabs}${controls}${chips}${body}${warn}${cap}</div>`;
}

/** 단일 품목 일별 선그래프 (dot 없음, Y축 auto) */
function buildKpChart(rows, item, cat, hOpt, evItems) {
  const n = rows.length;
  if (!n || !item) { _kpChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const color = KP_COLORS[cat && cat.key] || 'var(--accent)';
  const dates = rows.map((r) => r.date);
  const values = rows.map((r) => (r.price == null ? null : r.price));
  const all = values.filter((v) => v != null);
  if (!all.length) { _kpChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }

  // domain ['auto','auto'] — 0으로 내리지 않는다
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.08 || Math.max(0.5, ymax * 0.05);
  ymin -= yp; ymax += yp;

  // ★ 뷰박스 높이만 이 차트에서 늘린다(공용 VIZ_H 를 바꾸면 대시보드 차트가 전부 커진다)
  const W = VIZ_W, H = (hOpt && isFinite(hOpt)) ? hOpt : VIZ_H;
  const padL = 48, padR = 16, padT = VIZ_PAD_T + 9, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const dec = (ymax - ymin) < 20 ? 2 : 0;   // 값 폭이 좁으면 소수 표시
  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${val.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}</text>${vizKrwTick(padL - 6, y, val, krwFactor(item.unit))}`;
  }).join('');

  // 날짜 라벨은 'YYYY-MM-DD'(10자)로 가장 길어 간격을 더 넓게 잡는다
  const xticks = vizTickIdx(n, plotW, 108).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(dates[i])}</text>`;
  }).join('');

  let d = '', started = false;
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${started ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; started = true;
  });
  const line = d ? `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` : '';

  _kpChart = { dates, values, label: item.name, unit: item.unit, color, geom: { X, Y, n, W, padL } };
  console.log('[koima-price] 차트 · %s · %s~%s · %d개 점', item.name, dates[0], dates[n - 1], n);

  return `<div class="viz-legend kp-legend"><span class="viz-legend__item">
      <span class="viz-legend__swatch" style="background:${color}"></span>${escapeHtml(item.name)}${item.unit ? ` (${escapeHtml(item.unit)})` : ''}</span></div>
    <svg class="viz-svg kp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(item.name)} 일별 가격">
      ${grid}${xticks}${line}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="kp-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="kp-dots"></g>
      <rect class="kp-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
      ${vizEventsSvg(evItems || [], rows.map((r) => r.date), X, padT, plotH, W)}
    </svg>`;
}

/** 크로스헤어 + 툴팁 (날짜 · 품목 · 가격) */
function wireKpChart() {
  const fig = document.querySelector('#materialRoot .kp-figure');
  const tip = document.getElementById('kpTooltip');
  if (!fig || !tip || !_kpChart) return;
  const svg = fig.querySelector('.kp-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.kp-overlay');
  const cross = svg.querySelector('.kp-cross');
  const dots = svg.querySelector('.kp-dots');
  const c = _kpChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const v = c.values[i];
    if (v == null) { clear(); return; }
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    dots.innerHTML = `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3" fill="${c.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.dates[i])}</div>
      <div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${c.color}"></span><span>${escapeHtml(c.label)}</span><span class="viz-tt-val">${kpPrice(v)}${c.unit ? ' ' + escapeHtml(c.unit) : ''}</span></div>`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 탭·품목·기간 이벤트 (검색 버튼 없음 — 바꾸면 즉시 다시 그린다) */
function wireKpControls(root) {
  const fig = root.querySelector('.kp-figure');
  if (!fig) return;
  const tabsEl = fig.querySelector('.kp-tabs');
  if (tabsEl) tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.kp-tab');
    if (!b || b.disabled) return;
    // 부문을 바꾸면 품목은 첫 품목으로, 기간은 미선택으로 되돌린다 —
    // 새 부문에서 기간을 다시 골라야 그래프가 나온다(섹션 공통 규칙).
    _kpCat = b.dataset.cat;
    _kpItem = kpFirstItemNo(kpCatOf(_kpCat));
    _kpRange = null; _kpChart = null;
    renderMaterial();
  });
  const selEl = fig.querySelector('.kp-item');
  if (selEl) selEl.addEventListener('change', () => {
    _kpItem = selEl.value;
    renderMaterial();
  });
  const chipsEl = fig.querySelector('.kp-ranges');
  if (chipsEl) chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.kp-range');
    if (!b || b.disabled) return;
    _kpRange = b.dataset.range;
    renderMaterial();
  });
  if (_kpRange && _kpData && !_kpData.error && !_kpBusy) wireKpChart();
}


/* ── 국내외 브랜드 신제품 (Google News RSS) ── */
let _domestic = null;         // 국내 items
let _domesticFeatured = null; // 국내 대표 상품
let _globalBrands = null;     // 국외 items
let _globalFeatured = null;   // 국외 대표 상품

// 브랜드별 포인트 색 (배지 강조)
const DOM_BRAND_COLORS = {
  '에이스침대': 'var(--blue)', '씰리': 'var(--violet)', '한샘': 'var(--green)', '이케아': 'var(--amber)',
  'Sleep Number': 'var(--blue)', 'Tempur-Pedic': 'var(--green)', 'Purple': 'var(--violet)', 'Serta': 'var(--amber)',
};

/** 응답의 domestic 저장 */
function applyDomesticUpdate(data) {
  const dm = data && data.sections && data.sections.domestic;
  if (!dm) return;
  if (dm.status === 'error') { _domestic = null; _domesticFeatured = null; console.warn('[update] domestic error:', dm.reason); }
  else { _domestic = dm.items || []; _domesticFeatured = (dm.featured && dm.featured.length) ? dm.featured : _domestic.slice(0, 3); }
  renderBrands();
}

/** 응답의 global_brands 저장 */
function applyGlobalBrandsUpdate(data) {
  const gb = data && data.sections && data.sections.global_brands;
  if (!gb) return;
  if (gb.status === 'error') { _globalBrands = null; _globalFeatured = null; console.warn('[update] global_brands error:', gb.reason); }
  else { _globalBrands = gb.items || []; _globalFeatured = (gb.featured && gb.featured.length) ? gb.featured : _globalBrands.slice(0, 3); }
  renderBrands();
}

/** 대표 출시 상품 카드 3개 HTML (사진 > Clearbit 로고 > 파비콘 > 브랜드명) */
function brandFeatureCards(featList, colors) {
  return featList.map((it) => {
    const url = safeUrl(it.link);
    const img = safeUrl(it.image);
    const logo = safeUrl(it.logo_url);
    const logo2 = safeUrl(it.logo_fallback);
    const color = colors[it.brand] || 'var(--accent)';
    const brand = String(it.brand || '');
    const name = String(it.product_name || it.title || '').trim();
    const meta = [it.source, it.date].filter(Boolean).join(' · ');
    const mkLogo = (u) => u
      ? `<img class="prod-card__logo" src="${escapeHtml(u)}" alt="${escapeHtml(brand)} 로고" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const imgTag = img
      ? `<img class="prod-card__img" src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const tag = url ? 'a' : 'div';
    const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="prod-card"${attrs}>
      <div class="prod-card__photo" style="--dom-c:${color}">
        <span class="prod-card__ph">${escapeHtml(brand)}</span>
        ${mkLogo(logo2)}${mkLogo(logo)}${imgTag}
      </div>
      <div class="prod-card__body">
        <div class="prod-card__brand" style="color:${color}">${escapeHtml(brand)}</div>
        <div class="prod-card__name">${escapeHtml(name)}</div>
        ${meta ? `<div class="prod-card__meta">${escapeHtml(meta)}</div>` : ''}
      </div>
    </${tag}>`;
  }).join('');
}

/** 기사 목록 HTML ([브랜드] 제목 + 출처·날짜) */
function brandListItems(items, colors) {
  return items.map((it) => {
    const url = safeUrl(it.link);
    const img = safeUrl(it.image);
    const color = colors[it.brand] || 'var(--accent)';
    const brand = String(it.brand || '');
    const meta = [it.source, it.date].filter(Boolean).join(' · ');
    let title = String(it.title || '');
    if (it.source && title.endsWith(' - ' + it.source)) title = title.slice(0, -(it.source.length + 3));
    if (brand) {
      const bre = new RegExp('^\\s*' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[,·:\\-]?\\s*');
      const stripped = title.replace(bre, '').trim();
      if (stripped) title = stripped;
    }
    const logo = safeUrl(it.logo_url);
    const logo2 = safeUrl(it.logo_fallback);
    const initial = brand ? brand.charAt(0) : '·';
    if (brand && !logo && !logo2) console.warn('[brands] 로고 URL 없음(첫글자 폴백):', brand);
    // 썸네일 스택(뒤→앞): 첫글자 → 파비콘 → Clearbit 로고 → 기사 사진
    const mkLogo = (u) => u
      ? `<img class="dom-thumb__logo" src="${escapeHtml(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const imgTag = img
      ? `<img class="dom-thumb__img" src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const tag = url ? 'a' : 'div';
    const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="dom-item${url ? '' : ' dom-item--nolink'}"${attrs}>
      <div class="dom-thumb" style="--dom-c:${color}">
        <span class="dom-thumb__ini">${escapeHtml(initial)}</span>
        ${mkLogo(logo2)}${mkLogo(logo)}${imgTag}
      </div>
      <div class="dom-item__body">
        <h3 class="dom-item__title"><span class="dom-brand" style="color:${color}">[${escapeHtml(brand)}]</span> ${escapeHtml(title)}</h3>
        <div class="dom-item__meta">${escapeHtml(meta)}</div>
      </div>
    </${tag}>`;
  }).join('');
}

/* ── 국내 신제품 카테고리 분류 (규칙 기반 · AI 미사용 · 무료) ──────────────
   ★ 수집기(api/update.py)는 손대지 않는다. 이미 받아 둔 기사 제목·상품명에서
     키워드를 찾아 화면에서 분류만 한다. 외부 호출이 없으므로 비용도 없다.
   ★★ 억지로 끼워 맞추지 않는다. 어느 키워드에도 걸리지 않으면 '기타(미분류)'로
     남긴다 — 매트리스 본품 기사는 프레임도 베딩도 아니므로 여기로 간다.
     (하이엔드/프리미엄 때처럼 없는 분류를 지어내지 않는다) */

// 대분류 → 소분류. 화면 버튼도 이 표에서 만들어진다(문구를 코드 여기저기 적지 않는다).
const DOM_CATS = [
  { key: 'mattress', label: '매트리스', subs: [
    { key: 'frame', label: '프레임' },
    { key: 'bedding', label: '베딩' },
    { key: 'body', label: '매트리스 본체' },
  ] },
  { key: 'sleeptech', label: '슬립테크', subs: [
    { key: 'wearable', label: '웨어러블' },
    { key: 'stetc', label: '기타' },
  ] },
];
const DOM_OTHER = { key: 'other', label: '기타', note: '(미분류)' };

/* 슬립테크 기업. 이 브랜드 기사는 대분류를 '슬립테크'로 고정한다.
   ★★ 왜 필요한가: 이 회사들의 기사는 제품 이름이 아니라 '유통 계약·MOU·임상
     등록·플랫폼 공개'를 다룬다. 제품 종류 낱말이 없어 키워드로는 잡히지 않지만,
     슬립테크 기사인 것은 분명하다. 그래서 소분류가 애매하면 '슬립테크 > 기타'로
     받고, 대분류만은 놓치지 않는다.
   ★ 매트리스 브랜드는 넣지 않는다 — 코웨이 비렉스·Sleep Number 는 슬립테크
     카드에도 실려 있지만 본업이 매트리스라 기사도 매트리스 쪽이다. */
const DOM_SLEEPTECH_BRANDS = [
  '에이슬립', '허니냅스', '웰트', '텐마인즈', '삼분의일',            // 국내
  'Eight Sleep', 'Oura', 'ResMed', 'Whoop', 'Withings',            // 국외
];

/* 소분류별 키워드. 제목·상품명에서 찾는다. 국내(한국어)·국외(영어) 공용이다.
   ★ 붙여쓰기/띄어쓰기를 모두 적어 둔다 — 기사 제목의 표기가 제각각이라
     한쪽만 적으면 놓친다('베드프레임' vs '베드 프레임').
   ★★ 영문 키워드는 낱말 경계로 찾는다(domHasKw). 부분 일치로 두면
     'ring' 이 'spring'·'during' 에, 'band' 가 'brand' 에 걸린다.
   ★★ 정의 순서가 곧 동점일 때의 우선순위다. body(매트리스 본체)를
     맨 뒤에 둔 이유: '침대 프레임'·'mattress cover'처럼 body 키워드
     ('침대'·'mattress')를 품은 말이 많아서, 같은 수로 걸리면 더 좁은
     분류(프레임·베딩)가 이겨야 한다. */
const DOM_RULES = {
  frame: ['프레임', '베드프레임', '베드 프레임', '헤드보드', '헤드 보드',
    '침대틀', '침대 틀', '침대 프레임', '저상형', '평상형',
    '수납침대', '수납 침대', '벙커침대', '벙커 침대', '철제침대', '철제 침대',
    '붙박이', '원목침대', '원목 침대', '슬랫',
    '모션베드', '모션 베드', '전동베드', '전동 베드',
    '리클라이닝베드', '리클라이닝 베드', '리클라이너',
    // 영문
    'frame', 'frames', 'bed frame', 'bedframe', 'headboard', 'footboard',
    'slats', 'platform bed', 'bunk bed', 'adjustable base', 'adjustable bases',
    'adjustable bed', 'recliner', 'bed base'],
  bedding: ['이불', '차렵', '차렵이불', '누비이불', '패딩이불', '패딩 이불',
    '극세사이불', '극세사 이불', '구스이불', '구스 이불', '거위털', '구스다운',
    '침구', '침구류', '베개', '베갯잇', '필로우', '경추베개', '경추 베개',
    '라텍스베개', '라텍스 베개', '메모리폼베개', '메모리폼 베개',
    '토퍼', '패드', '매트리스커버', '매트리스 커버', '침대커버', '침대 커버',
    '침대시트', '침대 시트', '린넨', '리넨',
    // ★ '마이크'(웨어러블)와 겹치는 '마이크로파이버'를 여기에도 둔다 —
    //   극세사 침구 기사가 웨어러블로 새지 않게 베딩 쪽 점수를 올려 준다.
    '마이크로파이버', '마이크로화이버',
    // 영문
    'bedding', 'pillow', 'pillows', 'pillowcase', 'duvet', 'comforter',
    'sheet', 'sheets', 'blanket', 'quilt', 'linen', 'linens',
    'mattress cover', 'mattress protector', 'topper', 'mattress topper'],
  // 웨어러블 / 디지털 수면측정 — 착용형에 한정하지 않는다. 비접촉·앱·진단까지.
  wearable: ['스마트링', '스마트 링', '슬립링', '슬립 링',
    '스마트워치', '스마트 워치', '워치',
    '스마트밴드', '스마트 밴드', '밴드', '웨어러블',
    '수면추적', '수면 추적', '수면추적기', '수면 추적기',
    '수면모니터링', '수면 모니터링', '트래커', '반지형',
    '링 디바이스', '링디바이스',
    // 비접촉·소리 기반 측정(에이슬립 '숨소리만으로 수면 측정' 유형)
    '비접촉', '마이크', '호흡음', '호흡분석', '호흡 분석', '숨소리',
    '수면측정', '수면 측정', '수면분석', '수면 분석',
    // AI·데이터·진단
    'ai 수면', '수면 ai', '수면단계', '수면 단계', '코골이',
    '수면무호흡', '수면 무호흡', '무호흡',
    '수면데이터', '수면 데이터', '수면다원검사',
    '수면진단', '수면 진단', '원격진단', '원격 진단',
    // 앱·디지털 기기(처방 앱 유형)
    '앱기반', '앱 기반', '처방앱', '처방 앱',
    '디지털치료기기', '디지털 치료기기', '디지털의료기기', '디지털 의료기기',
    // 영문
    'wearable', 'wearables', 'smart ring', 'ring', 'rings',
    'smartwatch', 'smart watch', 'watch', 'band', 'strap',
    'tracker', 'trackers', 'tracking', 'sleep tracking', 'sleep score',
    'sensor', 'sensors', 'contactless', 'snoring', 'apnea', 'sleep apnea',
    'cpap', 'polysomnography', 'psg', 'sleep stage', 'sleep stages',
    'sleep data', 'monitoring', 'diagnosis', 'digital therapeutic',
    'digital therapeutics', 'dtx'],
  // ★ 맨 뒤 — 위 어느 분류에도 더 좁게 걸리지 않은 '매트리스 자체' 기사를 받는다.
  body: ['매트리스', '침대', '하이브리드', '스프링', '포켓스프링', '포켓 스프링',
    '본넬스프링', '본넬 스프링', '메모리폼', '라텍스', '폼매트리스', '폼 매트리스',
    '미디엄하드', '미디엄 하드', '미디엄펌', '경도', '양면매트리스', '양면 매트리스',
    // 영문
    'mattress', 'mattresses', 'bed', 'beds', 'hybrid', 'innerspring',
    'pocket spring', 'coil', 'coils', 'memory foam', 'foam', 'latex',
    'firmness', 'medium-firm', 'smart bed', 'smart mattress'],
};

/* 슬립테크 대분류 안에서 키워드로 고를 소분류.
   ★ 향수·약은 요청에 따라 없앴다(실데이터 0건이라 옮길 기사도 없었다).
     남은 것은 웨어러블 하나뿐이고, 여기 안 걸리면 '슬립테크 > 기타'가 받는다. */
const DOM_ST_SUBS = ['wearable'];

/* 제품이 아니라 행사·판촉을 다루는 기사인지 가늠하는 낱말(미분류 사유 설명용).
   ★ 이걸로 분류하지 않는다. 왜 안 걸렸는지 설명할 때만 쓴다. */
const DOM_EVENT_WORDS = ['캠페인', '기념', '주년', '행사', '프로모션', '이벤트',
  '특가', '할인', '세일', '팝업', '전시', '후원', '협약', '수상',
  'sale', 'campaign', 'anniversary', 'coupon', 'coupons', 'deal', 'deals',
  'discount', 'partner', 'partnership', 'award', 'awards'];

/** 소분류 key → {대분류, 소분류} 라벨 (breadcrumb·콘솔용) */
function domSubMeta(sub) {
  for (let i = 0; i < DOM_CATS.length; i += 1) {
    const hit = DOM_CATS[i].subs.filter((s) => s.key === sub)[0];
    if (hit) return { cat: DOM_CATS[i], sub: hit };
  }
  return null;
}

/** 키워드 한 개가 본문에 있는지.
    ★★ 영문·숫자가 든 키워드는 낱말 경계로 본다 — 부분 일치로 두면
      'ring' 이 'spring'·'during' 에, 'band' 가 'brand' 에, 'bed' 가
      'bedding' 에 걸려 분류가 무너진다.
    ★ 한글 키워드는 조사가 붙으므로 부분 일치로 둔다('침구를', '이불은'). */
function domHasKw(text, w) {
  const k = String(w).toLowerCase();
  if (!k) return false;
  if (/[a-z0-9]/.test(k)) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(text);
  }
  return text.indexOf(k) >= 0;
}

/** 키워드를 찾을 본문. 브랜드명과 끝의 '- 언론사'는 빼고 본다.
    ★★ 브랜드명을 빼는 게 핵심이다. 국내 브랜드에 '씰리침대·에이스침대'처럼
      '침대'가 박혀 있고, 국외에도 'Sleep Number'·'Eight Sleep' 처럼 'sleep',
      'Serta Simmons Bedding' 처럼 'bedding' 이 박혀 있다. 그대로 두면
      어떤 기사든 브랜드명 때문에 걸린다(브랜드는 제품 종류를 알려 주지 않는다). */
function domSearchText(it) {
  let t = String(it.title || '');
  const src = String(it.source || '');
  if (src && t.endsWith(' - ' + src)) t = t.slice(0, -(src.length + 3));
  t = [t, it.product_name].filter(Boolean).join(' ');
  const brand = String(it.brand || '').trim();
  if (brand) {
    // 대소문자를 가리지 않고 지운다('EIGHT SLEEP'·'eight sleep' 표기 차이)
    const esc = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(esc, 'gi'), ' ');
  }
  return t;
}

/** 이 기사가 슬립테크 기업 것인지. 브랜드 칸과 제목 어디에 있어도 잡는다.
    (제휴 기사는 브랜드가 상대 회사로 잡히기도 한다 —
     "에이슬립·텐마인즈 협력…"의 브랜드 칸은 텐마인즈였다) */
function domSleeptechBrand(it) {
  const hay = (String(it.brand || '') + ' ' + String(it.title || '')
    + ' ' + String(it.product_name || '')).toLowerCase();
  return DOM_SLEEPTECH_BRANDS.filter((b) => hay.indexOf(b.toLowerCase()) >= 0)[0] || null;
}

/** 주어진 소분류 후보들 중 걸린 키워드가 가장 많은 것. 없으면 null.
    같은 수면 DOM_RULES 에 먼저 정의된 소분류가 이긴다. */
function domPickSub(text, subs) {
  let best = null;
  subs.forEach((sub) => {
    const hits = (DOM_RULES[sub] || []).filter((w) => domHasKw(text, w));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { sub: sub, hits: hits };
  });
  return best;
}

/** 항목 하나를 분류한다.
    ★ 슬립테크 기업 기사면 대분류를 슬립테크로 고정하고, 소분류는
      웨어러블·향수·약 중에서 고른다. 애매하면 '슬립테크 > 기타'.
    ★ 그 밖의 기사는 6개 소분류 전체에서 키워드가 가장 많이 걸린 것으로. */
function domClassifyItem(it) {
  const raw = domSearchText(it);
  const text = raw.toLowerCase();
  const stBrand = domSleeptechBrand(it);
  if (!text.trim() && !stBrand) {
    return { sub: null, hits: [], text: raw, why: '제목이 비어 있습니다' };
  }

  if (stBrand) {
    const best = domPickSub(text, DOM_ST_SUBS);
    if (best) return { sub: best.sub, hits: best.hits, text: raw, why: null, stBrand: stBrand };
    // 슬립테크인 것은 분명하나 세부는 애매 → 기타로 받는다(미분류로 흘리지 않는다)
    return { sub: 'stetc', hits: [], text: raw, stBrand: stBrand,
      why: null, note: '슬립테크 기업(' + stBrand + ') 기사 — 세부 분류 낱말이 없어 기타' };
  }

  const best = domPickSub(text, Object.keys(DOM_RULES));
  if (best) return { sub: best.sub, hits: best.hits, text: raw, why: null };

  /* 못 걸렸을 때 — 지어내지 않는다. 본문에 실제로 있는 낱말만 근거로 적는다.
     ★ '행사 기사라서 못 걸렸다'고 단정하지 않는다. 확실한 것은 '제품 종류를
       가리키는 낱말이 없다'는 사실 하나뿐이고, 나머지는 참고로만 덧붙인다. */
  let why = '제품 종류를 가리키는 낱말이 없습니다(브랜드·언론사 이름 제외 후 검사)';
  const pn = String(it.product_name || '').trim();
  if (pn && raw.indexOf(pn) >= 0) why += ' — 제품 라인 이름(‘' + pn + '’)만 적혀 있습니다';
  const ev = DOM_EVENT_WORDS.filter((w) => domHasKw(text, w));
  if (ev.length) why += ' · 함께 쓰인 낱말: ' + ev.join('·');
  return { sub: null, hits: [], text: raw, why: why };
}

/* 선택 상태 — 국내·국외가 서로 독립이다(한쪽을 눌러도 다른 쪽은 그대로).
   rk('region key') 는 'kor' | 'glo'. 버튼마다 data-rk 로 실어 보낸다. */
const DOM_STATE = { kor: { cat: null, sub: null }, glo: { cat: null, sub: null } };
let _domClassSig = {};   // 같은 목록을 다시 분류했을 때 콘솔이 도배되지 않게(구역별)
let _domWired = false;

function domSt(rk) { return DOM_STATE[rk] || DOM_STATE.kor; }

/** 목록 전체를 소분류별로 나눈다. 결과는 콘솔에도 한 번 찍는다. */
function domClassify(items, rk, label) {
  const list = items || [];
  const bySub = { other: [] };
  // ★ DOM_RULES 가 아니라 DOM_CATS 기준으로 칸을 만든다 —
  //   '슬립테크 > 기타'처럼 키워드 규칙이 없는 소분류도 칸이 있어야 한다.
  DOM_CATS.forEach((c) => c.subs.forEach((sb) => { bySub[sb.key] = []; }));
  const detail = [];
  list.forEach((it) => {
    const r = domClassifyItem(it);
    bySub[r.sub || 'other'].push(it);
    detail.push({ sub: r.sub, hits: r.hits, title: String(it.title || ''),
      text: r.text, why: r.why, note: r.note });
  });

  // 콘솔 출력 — 카테고리별 항목 수 + 미분류 수 + 미분류로 남은 제목·사유
  const sig = list.map((x) => x.link || x.title).join('|');
  if (_domClassSig[rk] !== sig) {
    _domClassSig[rk] = sig;
    console.log('[' + (label || rk) + ' 신제품 분류] 총 ' + list.length
      + '건 (규칙 기반 · AI 미사용)');
    DOM_CATS.forEach((c) => {
      const n = c.subs.reduce((a, s) => a + bySub[s.key].length, 0);
      console.log('  ' + c.label + ' ' + n + '건 — '
        + c.subs.map((s) => s.label + ' ' + bySub[s.key].length).join(' · '));
    });
    console.log('  ' + DOM_OTHER.label + DOM_OTHER.note + ' ' + bySub.other.length + '건');
    if (bySub.other.length) {
      console.log('  ↳ 미분류로 남긴 항목 — 억지로 끼워 맞추지 않고 사유를 남긴다:');
      detail.filter((d) => !d.sub).forEach((d) => {
        console.log('     · ' + d.title);
        console.log('       검사한 문구(브랜드·언론사 제외): "' + String(d.text || '').trim() + '"');
        console.log('       사유: ' + d.why);
      });
    }
    detail.filter((d) => d.sub).forEach((d) => {
      const m = domSubMeta(d.sub);
      console.log('  ✔ [' + (m ? m.cat.label + ' > ' + m.sub.label : d.sub) + '] '
        + d.title + (d.hits && d.hits.length ? '  ← 키워드: ' + d.hits.join(', ')
          : '  ← ' + (d.note || '')));
    });
  }
  return bySub;
}

/** 대분류/소분류 버튼 한 줄. 건수를 함께 보여 주고, 0건이어도 눌러 볼 수 있다.
    ★ 0건도 누를 수 있게 둔 이유: '없다'는 것도 확인하고 싶은 정보라서.
      대신 숫자로 미리 알려 주고, 눌렀을 때 안내 문구를 보여 준다. */
function domBtns(opts, rk) {
  return '<div class="icis-years dom-cats">' + opts.map((o) => {
    return '<button type="button" class="icis-year dom-cat'
      + (o.count === 0 ? ' is-empty' : '') + '"'
      + ' data-rk="' + escapeHtml(rk) + '"'
      + ' data-' + escapeHtml(o.kind) + '="' + escapeHtml(o.key) + '">'
      + escapeHtml(o.label)
      + (o.note ? '<span class="dom-cat__note">' + escapeHtml(o.note) + '</span>' : '')
      + '<span class="dom-cat__n">' + o.count + '</span></button>';
  }).join('') + '</div>';
}

/** breadcrumb + 뒤로 가기.
    ★★ 구역 이름(국내/국외)은 넣지 않는다 — 바로 위 .comp-group__head 가
      이미 '국내'/'국외'를 보여 주고 있어, 여기에 또 넣으면 같은 글자가
      두 번 찍힌다(그 겹침이 이번에 고친 버그다).
    ★ 아직 아무것도 고르지 않았으면 이 줄 자체를 만들지 않는다. */
function domCrumb(rk) {
  const st = domSt(rk);
  if (!st.cat && !st.sub) return '';
  const path = [];
  const cat = DOM_CATS.filter((c) => c.key === st.cat)[0];
  if (cat) path.push(cat.label);
  else if (st.cat === DOM_OTHER.key) path.push(DOM_OTHER.label + DOM_OTHER.note);
  const m = st.sub ? domSubMeta(st.sub) : null;
  if (m) path.push(m.sub.label);
  const crumbs = path.map((t, i) => (i === path.length - 1
    ? '<b>' + escapeHtml(t) + '</b>' : escapeHtml(t))).join('<i class="dom-crumb__sep">›</i>');
  return '<div class="dom-nav"><div class="dom-crumb">' + crumbs + '</div>'
    + '<button type="button" class="dom-back" data-rk="' + escapeHtml(rk) + '">‹ 이전</button></div>';
}

/** 카테고리 선택 단계 HTML. 결과를 보여줄 차례면 null 을 돌려
    호출부가 '기존 렌더'로 넘어가게 한다(기존 이미지+기사 코드는 그대로 쓴다). */
function domCatStage(items, rk, label) {
  const st = domSt(rk);
  const bySub = domClassify(items, rk, label);
  const nOf = (c) => (c.key === DOM_OTHER.key
    ? bySub.other.length : c.subs.reduce((a, s) => a + bySub[s.key].length, 0));
  const tops = DOM_CATS.concat([Object.assign({ subs: [] }, DOM_OTHER)]);

  // 1단계 — 대분류
  if (!st.cat) {
    return domBtns(tops.map((c) => ({
      kind: 'cat', key: c.key, label: c.label, note: c.note, count: nOf(c),
    })), rk)
      + '<div class="dom-hint">분류를 골라 주세요. 숫자는 지금 받아 둔 기사 건수입니다.</div>';
  }

  // '기타'는 소분류가 없다 — 바로 결과로 간다.
  if (st.cat === DOM_OTHER.key) return null;

  const cat = DOM_CATS.filter((c) => c.key === st.cat)[0];
  if (!cat) { st.cat = null; return domCatStage(items, rk, label); }

  // 2단계 — 소분류
  if (!st.sub) {
    return domCrumb(rk)
      + domBtns(cat.subs.map((s) => ({
        kind: 'sub', key: s.key, label: s.label, count: bySub[s.key].length,
      })), rk)
      + '<div class="dom-hint">' + escapeHtml(cat.label) + ' 안에서 세부 분류를 골라 주세요.</div>';
  }
  return null;   // 3단계 — 결과는 기존 렌더가 그린다
}

/** 결과 단계에서 쓸 필터된 목록 */
function domFiltered(items, rk, label) {
  const st = domSt(rk);
  const bySub = domClassify(items, rk, label);
  if (st.cat === DOM_OTHER.key) return bySub.other;
  return bySub[st.sub] || [];
}

/** 버튼 클릭 — #domesticList 에 한 번만 붙인다(다시 그려도 중복되지 않게).
    국내·국외 버튼이 한 컨테이너에 함께 있으므로 data-rk 로 구역을 가른다. */
function wireBrandCats() {
  if (_domWired) return;
  const el = document.getElementById('domesticList');
  if (!el) return;
  _domWired = true;
  el.addEventListener('click', (e) => {
    const back = e.target.closest && e.target.closest('.dom-back');
    if (back) {
      const st = domSt(back.dataset.rk);
      if (st.sub) st.sub = null; else st.cat = null;   // 한 단계씩만 되돌린다
      renderBrands();
      return;
    }
    const b = e.target.closest && e.target.closest('.dom-cat');
    if (!b) return;
    const st = domSt(b.dataset.rk);
    if (b.dataset.cat) { st.cat = b.dataset.cat; st.sub = null; }
    else if (b.dataset.sub) { st.sub = b.dataset.sub; }
    renderBrands();
  });
}

/** 한 소그룹(국내/국외) 렌더: 소제목 + 대표 상품 3개 + 기사 목록
    ★ catUi=true 일 때만 앞에 카테고리 선택 단계가 붙는다(국내 전용).
      국외는 이 인자를 넘기지 않으므로 예전 동작 그대로다.
    ★ 이미지+기사를 그리는 부분(brandFeatureCards·brandListItems)은 손대지 않았다.
      목록만 걸러서 같은 함수에 그대로 넘긴다. */
function brandGroupHtml(title, tag, items, featured, colors, emptyMsg, catUi) {
  const head = `<div class="comp-group__head">${escapeHtml(title)}${tag ? ` <span class="comp-group__tag">${escapeHtml(tag)}</span>` : ''}</div>`;
  if (!items || !items.length) return `<div class="brand-group">${head}${emptyState(emptyMsg)}</div>`;

  let list = items, feat = featured, nav = '';
  if (catUi) {
    // catUi 는 구역 키('kor'|'glo'). 국내·국외가 서로 다른 선택 상태를 갖는다.
    const stage = domCatStage(items, catUi, title);
    // 아직 고르는 중이면 여기서 끝낸다(이미지·기사는 그리지 않는다).
    if (stage !== null) return `<div class="brand-group">${head}${stage}</div>`;
    nav = domCrumb(catUi);
    list = domFiltered(items, catUi, title);
    // 대표 상품도 같은 분류로 거른다 — 남는 게 없으면 아래에서 목록 앞 3건을 쓴다.
    const keys = list.map((x) => x.link || x.title);
    feat = (featured || []).filter((x) => keys.indexOf(x.link || x.title) >= 0);
    if (!list.length) {
      return `<div class="brand-group">${head}${nav}${emptyState('이 분류에 해당하는 기사가 아직 없습니다')}</div>`;
    }
  }

  const featList = (feat && feat.length) ? feat : list.slice(0, 3);
  // ★ ${nav} 를 head 에 바로 붙인다 — 국외는 nav 가 빈 문자열이라, 줄을 나누면
  //   빈 줄이 하나 끼어 예전 출력과 달라진다(내용은 같아도 그대로 두지 않는다).
  return `<div class="brand-group">
    ${head}${nav}
    <div class="dom-feature"><div class="dom-feature__head">대표 출시 상품</div>
      <div class="dom-feature__grid">${brandFeatureCards(featList, colors)}</div></div>
    <div class="dom-divider"></div>
    ${brandListItems(list, colors)}
  </div>`;
}

/** 국내외 브랜드 신제품 렌더: 국내 + 국외(Global) 두 소그룹 */
function renderBrands() {
  const el = document.getElementById('domesticList');
  if (!el) return;
  const hasKor = _domestic && _domestic.length;
  const hasGlo = _globalBrands && _globalBrands.length;
  if (!hasKor && !hasGlo) { el.innerHTML = emptyState('브랜드 신제품 데이터 준비중'); return; }
  // 국내·국외 모두 카테고리 선택 단계를 앞에 둔다. 마지막 인자가 구역 키다 —
  // 서로 다른 키를 쓰므로 한쪽에서 고른 분류가 다른 쪽에 영향을 주지 않는다.
  const kor = brandGroupHtml('국내', '', _domestic, _domesticFeatured, DOM_BRAND_COLORS, '국내 브랜드 신제품 준비중', 'kor');
  const glo = brandGroupHtml('국외', 'Global', _globalBrands, _globalFeatured, DOM_BRAND_COLORS, '국외 브랜드 신제품 준비중', 'glo');
  const foot = '<div class="dom-note">뉴스 기사 기반으로, 상품명·사진이 정확하지 않을 수 있습니다.</div>'
    + '<div class="comp-caption">출처: Google News</div>';
  /* ★ 이 섹션은 자기 전환 버튼과 자기 상태(_brandSide)를 갖는다.
     분기 실적 섹션과 묶지 않는다 — 위에서 국외를 보는 중에도 여기서는 국내를
     볼 수 있어야 한다(두 섹션이 다루는 내용이 다르다). */
  const sideTab = (side, label, tag) => '<button class="side-tab" type="button" role="tab"'
    + ' data-side="' + side + '">' + escapeHtml(label)
    + (tag ? '<span class="side-tab__t">' + escapeHtml(tag) + '</span>' : '') + '</button>';
  el.innerHTML = '<div class="dom-side" role="tablist" aria-label="신제품·브랜드 국내/국외 전환">'
    + sideTab('kr', '국내', '')
    + sideTab('gl', '국외', 'Global')
    + '</div>'
    + '<div class="brand-side" data-side="kr">' + kor + '</div>'
    + '<div class="brand-side" data-side="gl">' + glo + '</div>'
    + foot;
  wireBrandCats();
  wireBrandSide();
  applyBrandSide();
}

/* ── 환율 (우리은행 스타일: USD·EUR·JPY 원화 시세표 + 기간별 추이) ── */
let _fx = null;        // { rows:[{cur,now,change,prev}], series:{dates,USD,EUR,JPY}, source }
let _fxCur = null;     // 선택 통화 배열(예 ['USD'] · ['USD','EUR']). null=미선택
let _fxMonths = null;  // 추이 기간(3/6/9/12개월). null=미선택
let _fxChart = null;   // 추이 차트 hover 캐시

const FX_META = {
  USD: { label: 'USD', name: '미국 달러', sub: '미국 달러', color: '#C8102E' }, // 빨강
  EUR: { label: 'EUR', name: '유로',      sub: '유로',      color: '#F59E0B' }, // 주황
  JPY: { label: 'JPY', name: '엔화',      sub: '100엔',     color: '#3B82F6' }, // 파랑
};
const FX_CURS = ['USD', 'EUR', 'JPY'];

/** 응답의 fx 저장 후 환율 섹션 갱신 */
function applyFxUpdate(data) {
  const fx = data && data.sections && data.sections.fx;
  if (!fx) return;
  _fx = (fx.status === 'error') ? null : fx;
  if (fx.status === 'error') console.warn('[update] fx error:', fx.reason);
  renderFx();
}

/** 지금 고른 통화 배열(항상 FX_CURS 순서). 아무것도 안 골랐으면 []. */
function fxSel() {
  if (!_fxCur) return [];
  const arr = Array.isArray(_fxCur) ? _fxCur : [_fxCur];   // 예전 문자열 값 방어
  return FX_CURS.filter((c) => arr.indexOf(c) >= 0);
}

/** 원화 시세 포맷: 천단위 콤마 + 소수 2자리 */
function fxNum(v) {
  return (v == null) ? '—' : Number(v).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ── 환율 현황 카드 + AI 해석 (fx-analysis.json) ───────────────────────────
   fx_analysis.py 가 하루 1회 만들어 커밋한 정적 JSON 만 읽는다.
   ★ 브라우저는 Gemini 를 부르지 않는다 — API 키가 브라우저로 내려가는 경로를
     아예 만들지 않는다. 여기서 하는 일은 '커밋된 파일 읽기'뿐이다.
   ★★ 이 파일이 없어도 섹션이 비지 않는다. 카드는 _fxa 가 있으면 그걸 쓰고,
     없으면 기존 _fx(시세)에서 직접 만든다 — 예전에 로더가 없어진 키 하나를
     요구해서 블록 전체가 조용히 비어 버린 적이 있다. 같은 실수를 막는다. */
const FXA_DATA_URL = 'public/data/fx-analysis.json';
let _fxa = null;

async function fetchFxAnalysis() {
  try {
    const res = await fetch(FXA_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 (' + FXA_DATA_URL + ')');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    _fxa = d;
  } catch (e) {
    _fxa = null;
    console.warn('[fx-analysis] 로드 실패:', e);
  }
  renderFx();
}

/** 화면에 그릴 통화 카드 목록. fx-analysis.json 우선, 없으면 기존 시세에서 만든다. */
function fxaCardList() {
  if (_fxa && Array.isArray(_fxa.cards) && _fxa.cards.length) return _fxa.cards;
  if (!_fx || !Array.isArray(_fx.rows)) return [];
  const series = (_fx.series || {});
  return FX_CURS.map((cur) => {
    const r = _fx.rows.find((x) => x.cur === cur);
    if (!r || r.now == null) return null;
    const m = FX_META[cur];
    const vals = (series[cur] || []).filter((v) => v != null && isFinite(v));
    const pct = (r.prev) ? ((r.now - r.prev) / r.prev * 100) : null;
    return {
      cur: cur, name: m.name, unit: m.sub, color: m.color, status: 'ok',
      now: r.now, prev: r.prev, change: r.change,
      changePct: (pct == null) ? null : Number(pct.toFixed(2)),
      asOf: fxAsOfDate() || null,
      spark: vals.slice(-63),
      /* 배지는 계산 결과만 쓴다. 시세만 있을 때는 등락 배지 하나면 충분하다 —
         3개월 최고/최저 판정은 수집기가 같은 기준으로 이미 하고 있다. */
      badges: (pct == null) ? [] : [{
        text: (Math.abs(pct) >= 0.6) ? (pct > 0 ? '급등' : '급락')
          : (Math.abs(pct) >= 0.3) ? (pct > 0 ? '상승' : '하락') : '보합',
        tone: (Math.abs(pct) < 0.3) ? 'flat' : (pct > 0 ? 'up' : 'down'),
        why: '전일대비 ' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%',
      }],
    };
  }).filter(Boolean);
}

/** 미니 추이(스파크라인). 값이 2개 미만이면 그리지 않는다. */
function fxaSparkSvg(card) {
  const vals = (card.spark || []).filter((v) => v != null && isFinite(v));
  if (vals.length < 2) return '';
  const W = 132, H = 40, P = 4;
  const min = Math.min(...vals), max = Math.max(...vals);
  const rng = (max - min) || 1;
  const xf = (i) => P + i * (W - P * 2) / (vals.length - 1);
  const yf = (v) => P + (H - P * 2) * (1 - (v - min) / rng);
  const pts = vals.map((v, i) => xf(i).toFixed(1) + ',' + yf(v).toFixed(1)).join(' ');
  const last = vals[vals.length - 1];
  const rising = last >= vals[0];
  const col = card.color || 'var(--slate)';
  const gid = 'fxaSpark' + card.cur;
  return '<svg class="fxa-spark" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '"'
    + ' role="img" aria-label="' + escapeHtml(card.name + ' 최근 추이 ' + (rising ? '상승' : '하락')) + '">'
    + '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="' + col + '" stop-opacity=".22"/>'
    + '<stop offset="100%" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>'
    + '<polygon fill="url(#' + gid + ')" points="' + P + ',' + (H - P) + ' ' + pts
    + ' ' + (W - P).toFixed(1) + ',' + (H - P) + '"/>'
    + '<polyline fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round"'
    + ' stroke-linecap="round" points="' + pts + '"/>'
    + '<circle cx="' + xf(vals.length - 1).toFixed(1) + '" cy="' + yf(last).toFixed(1) + '"'
    + ' r="2.4" fill="' + col + '"/></svg>';
}

/** 통화 카드 3장 */
function fxaCardsHtml() {
  const cards = fxaCardList();
  if (!cards.length) return '';
  const html = cards.map((c) => {
    const pct = c.changePct, chg = c.change;
    const tone = (pct == null || Math.abs(pct) < 0.005) ? 'fx-flat' : (pct > 0 ? 'up' : 'down');
    const arrow = (pct == null || Math.abs(pct) < 0.005) ? '' : (pct > 0 ? '▲' : '▼');
    const badges = (c.badges || []).map((b) => '<span class="fxa-badge is-' + (b.tone || 'flat') + '"'
      + (b.why ? ' title="' + escapeHtml(b.why) + '"' : '') + '>' + escapeHtml(b.text) + '</span>').join('');
    const st = c.stats;
    const range = st ? '<div class="fxa-c__rng">3개월 ' + fxNum(st.low3m) + ' ~ ' + fxNum(st.high3m) + '</div>' : '';
    return '<div class="fxa-c">'
      + '<div class="fxa-c__top">'
      + '<span class="fxa-c__cur"><i style="background:' + c.color + '"></i><b>' + escapeHtml(c.cur) + '</b>'
      + '<span class="fxa-c__nm">' + escapeHtml(c.name) + '</span></span>'
      + '<span class="fxa-c__bd">' + badges + '</span></div>'
      + '<div class="fxa-c__now">' + fxNum(c.now) + '<span class="fxa-c__u">원 / ' + escapeHtml(c.unit || '') + '</span></div>'
      + '<div class="fxa-c__chg ' + tone + '">' + arrow + ' ' + fxNum(chg == null ? null : Math.abs(chg))
      + (pct == null ? '' : ' <span class="fxa-c__pct">(' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%)</span>')
      + ' <span class="fxa-c__lbl">전일대비</span></div>'
      + fxaSparkSvg(c) + range
      + '</div>';
  }).join('');
  return '<div class="fxa-cards">' + html + '</div>';
}

/** 요인 묶음 하나(상승 제한 / 하락 지지) */
function fxaFactorsHtml(title, sub, items, tone) {
  const list = (items || []).map((f) => {
    /* 근거 링크. title 에 출처 제목을 넣어 누르기 전에 어디로 가는지 알 수 있게 한다.
       링크가 없는 요인은 '출처 미확인'으로 표시한다 — 검증에서 떨어진 링크를
       조용히 없애면 근거가 있는 것처럼 보인다. */
    const link = f.sourceUrl
      ? ' <a class="fxa-src" href="' + escapeHtml(f.sourceUrl) + '" target="_blank" rel="noopener noreferrer"'
        + (f.sourceLabel ? ' title="' + escapeHtml(f.sourceLabel) + '"' : '') + '>근거 ↗</a>'
      : ' <span class="fxa-nosrc" title="출처 링크를 검증하지 못해 표시하지 않았습니다">출처 미확인</span>';
    return '<li><b>' + escapeHtml(f.point) + '</b><span>' + escapeHtml(f.evidence) + link + '</span></li>';
  }).join('');
  return '<div class="fxa-fac is-' + tone + '">'
    + '<div class="fxa-fac__h">' + escapeHtml(title) + '</div>'
    + '<div class="fxa-fac__s">' + escapeHtml(sub) + '</div>'
    + (list ? '<ul class="fxa-fac__l">' + list + '</ul>'
      : '<div class="fxa-fac__e">제시된 요인이 없습니다</div>')
    + '</div>';
}

/** 중단 해석 블록. 해석이 없으면 '왜 없는지'를 말한다(조용히 비우지 않는다). */
function fxaAnalysisHtml() {
  const a = _fxa && _fxa.analysis;
  if (!a || a.status !== 'ok') {
    const why = (a && a.reason) ? a.reason
      : (_fxa ? '해석 데이터가 아직 없습니다' : '해석 데이터를 불러오지 못했습니다');
    return '<div class="fxa-wrap"><div class="fxa-head">'
      + '<div class="fxa-title">환율 해석</div>'
      + '<div class="fxa-sub">공개 데이터 기반 정리</div></div>'
      + emptyState(why) + '</div>';
  }
  const dirTone = (a.outlook.direction === '상승') ? 'up'
    : (a.outlook.direction === '하락') ? 'down' : 'flat';
  const gen = _fxa.generatedAt ? String(_fxa.generatedAt).replace('T', ' ').slice(0, 16) : null;
  const stale = a.stale
    ? '<span class="fxa-stale" title="' + escapeHtml(a.staleReason || '최신 생성 실패')
      + '">이전 분석 유지</span>' : '';
  return '<div class="fxa-wrap">'
    + '<div class="fxa-head"><div>'
    + '<div class="fxa-title">환율 해석</div>'
    + '<div class="fxa-sub">AI가 공개 데이터를 바탕으로 정리한 참고 자료입니다'
    + (gen ? ' · ' + escapeHtml(gen) + ' 기준' : '') + '</div></div>' + stale + '</div>'
    + (a.current ? '<div class="fxa-cur"><div class="fxa-cur__h">현황</div>'
      + '<p>' + escapeHtml(a.current) + '</p></div>' : '')
    + '<div class="fxa-two">'
    + fxaFactorsHtml('환율 상승 제한 요인', '원/달러 상단을 누르는 재료 (원화 강세 쪽)',
      a.upsideLimiters, 'down')
    + fxaFactorsHtml('환율 하락 지지 요인', '원/달러 하단을 받치는 재료 (원화 약세 쪽)',
      a.downsideSupports, 'up')
    + '</div>'
    + '<div class="fxa-out is-' + dirTone + '">'
    + '<div class="fxa-out__h">전망 <span class="fxa-out__d">' + escapeHtml(a.outlook.direction) + '</span>'
    + '<span class="fxa-out__c">확신 ' + escapeHtml(a.outlook.confidence) + '</span></div>'
    + '<p>' + escapeHtml(a.outlook.rationale) + '</p></div>'
    + '</div>';
}

/** 하단 각주 — 신뢰성 안내는 전부 여기 작은 글씨로 모은다(본문 안내 박스 금지). */
function fxaFootnote() {
  const a = _fxa && _fxa.analysis;
  const parts = [];
  const br = (_fxa && _fxa.badgeRule) || { spikePct: 0.6, movePct: 0.3, window: 63 };
  parts.push('배지 기준: 전일대비 ±' + br.spikePct + '% 이상 급등·급락, ±' + br.movePct
    + '% 이상 상승·하락, 그 안은 보합. 최고·최저는 최근 ' + br.window + '영업일 기준.');
  if (a && a.status === 'ok') {
    parts.push('‘환율 해석’의 현황·요인·전망 문장은 Google Gemini'
      + (a.model ? '(' + a.model + ')' : '') + '가 위 시세·거시지표·뉴스 헤드라인만을 '
      + '근거로 생성한 것입니다. 숫자는 모두 수집된 원자료에서 계산했고, 근거 링크는 '
      + '수집된 출처와 대조해 확인되지 않은 링크는 제거했습니다.');
    parts.push('AI가 생성한 해석이므로 사실과 다를 수 있습니다. '
      + '투자 판단의 근거로 사용하지 마십시오.');
    if (a.stale) {
      parts.push('최신 분석 생성이 실패해 이전 분석을 그대로 두었습니다'
        + (a.staleReason ? ' (' + a.staleReason + ')' : '') + '.');
    }
  }
  const macroSrc = (_fxa && _fxa.macro && _fxa.macro.items) || [];
  if (macroSrc.length) {
    const uniq = [];
    macroSrc.forEach((m) => { if (uniq.indexOf(m.source) < 0) uniq.push(m.source); });
    parts.push('거시지표 출처: ' + uniq.join(' · ') + '.');
  }
  parts.push('시세 출처: ' + escapeHtml((_fxa && _fxa.rateSource) || 'Frankfurter (ECB 기반)')
    + '. 매매기준율이 아니라 참고용 기준환율입니다.');
  return '<div class="fxa-foot">' + parts.map((p) => '<p>' + p + '</p>').join('') + '</div>';
}

/** 거시지표 한 줄 요약 — 해석의 근거가 된 숫자를 눈으로 확인할 수 있게. */
function fxaMacroHtml() {
  const items = (_fxa && _fxa.macro && _fxa.macro.items) || [];
  if (!items.length) return '';
  const chips = items.map((m) => {
    const v = (typeof m.value === 'number')
      ? m.value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : m.value;
    /* 전년동월비는 단위에 맞는 것만 쓴다 — 금리·실업률처럼 이미 %인 값에
       변화율(%)을 붙이면 오해를 부른다(수집기가 %p 로 따로 계산해 둔다). */
    const extra = (m.yoyPct != null)
      ? ' <u title="전년 동월 대비">' + (m.yoyPct > 0 ? '+' : '') + m.yoyPct.toFixed(2) + '%</u>'
      : (m.yoyPp != null)
        ? ' <u title="전년 동월 대비 (퍼센트포인트)">' + (m.yoyPp > 0 ? '+' : '') + m.yoyPp.toFixed(2) + '%p</u>'
        : '';
    return '<a class="fxa-m" href="' + escapeHtml(m.url) + '" target="_blank" rel="noopener noreferrer"'
      + ' title="' + escapeHtml(m.label + ' · 기준 ' + m.asOf + ' · ' + m.source) + '">'
      + '<span class="fxa-m__l">' + escapeHtml(m.label) + '</span>'
      + '<b>' + escapeHtml(String(v)) + escapeHtml(m.unit || '') + '</b>' + extra + '</a>';
  }).join('');
  return '<div class="fxa-macro">' + chips + '</div>';
}

/** 환율 섹션 렌더: 통화 카드 + 해석 + 기간 버튼 + 추이 그래프 */
function renderFx() {
  const el = document.getElementById('body-fx');
  if (!el) return;
  const note = '<div class="fx-note">원/달러·원/유로·원/엔 시세. 수입 원자재·설비 결제 시 원가 부담을 가늠할 수 있습니다.</div>';
  /* ★ 카드는 _fxa(커밋된 JSON) 또는 _fx(실시간) 중 있는 쪽으로 만든다.
     둘 다 없을 때만 비운다 — 한 소스가 없다고 섹션 전체가 조용히 비면 안 된다. */
  const cardsHtml = fxaCardsHtml();
  if (!cardsHtml && !fxSeries()) {
    el.innerHTML = emptyState('환율 데이터 준비중') + note;
    return;
  }

  // 1) 상단: 주요 통화 현황 카드 (현재가 · 전일대비 · 스파크라인 · 배지)
  const table = cardsHtml;

  // 2) 통화 칩(1줄) + 기간 칩(2줄) — 두 값을 조합해 단일 통화 추이를 그림
  // 통화 칩 — 여러 개를 함께 고를 수 있다(누를 때마다 켜짐/꺼짐).
  // '전체'는 셋을 한 번에 켜고, 이미 셋 다 켜져 있으면 모두 끈다.
  const sel = fxSel();
  const curChips = `<div class="icis-years fx-curs">${[...FX_CURS, 'all'].map((cur) => {
    const label = (cur === 'all') ? '전체' : `${FX_META[cur].name}(${FX_META[cur].label})`;
    const on = (cur === 'all') ? (sel.length === FX_CURS.length) : (sel.indexOf(cur) >= 0);
    return `<button class="icis-year fx-cur${on ? ' is-active' : ''}" data-cur="${cur}"
        aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(label)}</button>`;
  }).join('')}<span class="fx-curhint">여러 개를 함께 고를 수 있습니다</span></div>`;
  const months = [3, 6, 9, 12];
  // 리포트 버튼 — 통화·기간이 모두 골라졌을 때만 낸다(원유·제품·KOIMA 카드와 같은 자리·클래스)
  const rptBtn = (sel.length && _fxMonths)
    ? `<button type="button" class="oc-tool or-btn fx-report${_fxReport ? ' is-on' : ''}"
        data-fx-report="1" aria-expanded="${_fxReport ? 'true' : 'false'}">📊 리포트 분석</button>`
    : '';
  const monChips = `<div class="icis-years fx-months">${months.map((mm) =>
    `<button class="icis-year fx-month${mm === _fxMonths ? ' is-active' : ''}" data-months="${mm}">${mm}개월</button>`).join('')}${rptBtn}</div>`;

  let chartBody, sub;
  if (!sel.length || !_fxMonths) {   // 통화·기간 중 하나라도 미선택 → 안내
    _fxChart = null;
    sub = '통화와 기간을 선택하세요';
    chartBody = '<div class="icis-prompt">통화와 기간을 선택하세요</div>';
  } else {
    // 고른 통화만 그린다. 하나면 범례 없이, 둘 이상이면 범례를 붙인다.
    sub = sel.map((c) => `${FX_META[c].name}(${FX_META[c].label})`).join(' · ')
      + (sel.indexOf('JPY') >= 0 ? ' · 100엔 기준' : '');
    chartBody = buildFxChart(fxSlice(_fxMonths), sel)
      + (sel.indexOf('JPY') >= 0 ? '<div class="fx-jpy-note">* JPY는 100엔 단위</div>' : '');
  }

  /* 화면 흐름: [1] 통화 현황 카드 → [2] 해석(현황·상단제한·하단지지·전망)
     → [3] 기존 추이 차트(통화·기간 선택 그대로) → 하단 각주 */
  el.innerHTML = `
    ${table}
    ${note}
    ${fxaMacroHtml()}
    ${fxaAnalysisHtml()}
    <div class="viz-root viz-figure fx-figure">
      <div class="viz-head"><div>
        <div class="viz-title">원화 환율 추이</div>
        <div class="viz-sub">${escapeHtml(sub)}</div>
      </div></div>
      ${curChips}
      ${monChips}
      ${chartBody}${_fxReport ? fxrReportHtml() : ''}
      <div class="viz-tooltip" id="fxTooltip"></div>
      <div class="comp-caption">${fxAsOfDate() ? `기준일 ${escapeHtml(fxAsOfDate())} · ` : ''}출처: Frankfurter (ECB 기반)</div>
    </div>
    ${fxaFootnote()}`;

  const curEl = el.querySelector('.fx-curs');
  if (curEl) curEl.addEventListener('click', (e) => {
    const b = e.target.closest('.fx-cur');
    if (!b) return;
    const cur = b.dataset.cur;   // 기간은 유지한 채 통화만 켜고 끈다
    const now = fxSel();
    if (cur === 'all') {
      _fxCur = (now.length === FX_CURS.length) ? null : FX_CURS.slice();
    } else {
      const next = (now.indexOf(cur) >= 0) ? now.filter((x) => x !== cur) : now.concat([cur]);
      // FX_CURS 순서를 유지한다(고른 차례와 무관하게 항상 USD·EUR·JPY 순)
      _fxCur = FX_CURS.filter((x) => next.indexOf(x) >= 0);
      if (!_fxCur.length) _fxCur = null;
    }
    _fxReport = _fxCur ? _fxReport : false;   // 통화를 다 끄면 리포트도 접는다
    renderFx();
  });
  const mEl = el.querySelector('.fx-months');
  if (mEl) mEl.addEventListener('click', (e) => {
    const b = e.target.closest('.fx-month');
    if (!b) return;
    _fxMonths = parseInt(b.dataset.months, 10);  // 통화는 유지
    renderFx();
  });
  const rEl = el.querySelector('.fx-report');
  if (rEl) rEl.addEventListener('click', () => { _fxReport = !_fxReport; renderFx(); });
  if (sel.length && _fxMonths) wireFxInteraction();
}

/* ── 환율 · 리포트 분석 ───────────────────────────────────────────────────
   ★ AI/LLM 을 쓰지 않는다. 문장은 템플릿이고 숫자는 전부 받아둔 시세에서 계산한다.
     외부 호출이 없으므로 비용도 없다.
   ★★ 원인은 지어내지 않는다. '연준 금리', '무역수지' 같은 해설은 이 데이터에
     없다. 서술하는 것은 오직 숫자 자체의 변화뿐이다 — 전일 대비 · 기간 등락 ·
     최고/최저 · 평균 · 통화 간 변동폭 비교.
   ★ 고정값이 없다. 지금 고른 통화(_fxCur)와 기간(_fxMonths)에서 매번 계산한다. */
let _fxReport = false;      // 리포트 펼침 상태

const FXR_DEF = '환율이란 자국 통화와 외국 통화 간의 교환 비율을 뜻하며, '
  + '원/달러 환율이 오르면 원화 가치가 하락(달러 대비 원화 약세)했다는 의미입니다.';

/* |변동률|을 말로 옮기는 유일한 근거표. 사람 감각으로 '소폭'을 쓰지 않는다.
   경계값을 코드에 적어 두어 나중에 왜 그렇게 썼는지 확인할 수 있게 한다. */
const FXR_BANDS = [
  { lim: 0.3, word: '소폭 ' },
  { lim: 1.0, word: '' },
  { lim: Infinity, word: '큰 폭으로 ' },
];
function fxrMag(pct) {
  const a = Math.abs(pct == null ? 0 : pct);
  return FXR_BANDS.filter((b) => a < b.lim)[0].word;
}

function fxrWon(v) { return (v == null) ? '—' : fxNum(v) + '원'; }
function fxrSigned(v) {
  if (v == null) return '—';
  return (v > 0 ? '+' : v < 0 ? '-' : '') + fxNum(Math.abs(v)) + '원';
}
function fxrPct(v) { return (v == null) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
function fxrDay(cur) {
  return ((_fx && _fx.rows) || []).filter((x) => x.cur === cur)[0] || null;
}
/** 전일 대비 변동률(%) — prev 가 없으면 null */
function fxrDayPct(r) {
  if (!r || r.change == null || !r.prev) return null;
  return Math.round((r.change / r.prev) * 10000) / 100;
}

/** 조회 창 안의 통화별 지표. 값이 하나도 없으면 n=0 으로 남긴다. */
function fxrStats(cur, sl) {
  const m = FX_META[cur];
  const pts = [];
  (sl.dates || []).forEach((d, i) => {
    const v = sl[cur] ? sl[cur][i] : null;
    if (v != null) pts.push({ d: d, v: v });
  });
  const base = { cur: cur, label: m.label, name: m.name, color: m.color, n: pts.length };
  if (!pts.length) return base;
  const vals = pts.map((x) => x.v);
  const mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
  const first = pts[0], last = pts[pts.length - 1];
  return Object.assign(base, {
    pts: pts, first: first, last: last,
    hi: pts.filter((x) => x.v === mx)[0],
    lo: pts.filter((x) => x.v === mn)[0],
    avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
    chg: Math.round((last.v - first.v) * 100) / 100,
    pct: first.v ? Math.round(((last.v - first.v) / first.v) * 10000) / 100 : null,
  });
}

/** 리포트가 쓸 값 묶음. 통화·기간이 안 골라졌거나 값이 없으면 null */
function fxrCtx() {
  if (!_fx || !fxSel().length || !_fxMonths) return null;
  const sl = fxSlice(_fxMonths);
  if (!sl.dates || !sl.dates.length) return null;
  /* ★★ 지금 화면에서 고른 통화만 다룬다.
     예전에는 FX_CURS(3통화)를 통째로 계산해, USD 하나만 골라도 리포트에
     EUR·JPY 비교가 섞여 나왔다. 고른 것과 읽는 것이 어긋나던 원인이다. */
  const drawCurs = fxSel();
  const st = drawCurs.map((c) => fxrStats(c, sl));
  const live = st.filter((x) => x.n);
  if (!live.length) return null;
  const headCur = drawCurs[0];          // 단일이면 그 통화, '전체'면 첫 번째(USD)
  return {
    sl: sl, st: st, live: live, headCur: headCur, drawCurs: drawCurs,
    months: _fxMonths, isAll: drawCurs.length === FX_CURS.length,
    multi: drawCurs.length > 1,         // 통화가 둘 이상일 때만 '비교'를 말한다
    span: sl.dates[0] + ' ~ ' + sl.dates[sl.dates.length - 1],
    days: sl.dates.length,
    head: st.filter((x) => x.cur === headCur)[0],
  };
}

/** 통화별 지표 표 — '고른 통화'만 담는다(고른 게 하나면 한 줄). */
function fxrTable(c) {
  const row = (x) => {
    // 표에 들어오는 것 자체가 고른 통화뿐이라 굵게/보통을 나눌 이유가 없다.
    const nameCell = '<td class="oc-td-p"><span class="oc-swatch" style="background:'
      + x.color + '"></span><b>' + escapeHtml(x.label) + ' '
      + escapeHtml(x.name) + '</b></td>';
    if (!x.n) return '<tr>' + nameCell + '<td class="oc-num" colspan="6">이 기간 값 없음</td></tr>';
    const d = fxrDay(x.cur), dp = fxrDayPct(d);
    const dCls = (d && d.change != null) ? (d.change > 0 ? ' oc-up' : (d.change < 0 ? ' oc-down' : '')) : '';
    const pCls = x.pct == null ? '' : (x.pct > 0 ? ' oc-up' : (x.pct < 0 ? ' oc-down' : ''));
    return '<tr>' + nameCell
      + '<td class="oc-num">' + fxrWon(x.last.v) + '</td>'
      + '<td class="oc-num' + pCls + '">' + fxrSigned(x.chg)
      + '<span class="or-when">' + escapeHtml(fxrPct(x.pct)) + '</span></td>'
      + '<td class="oc-num"><span class="or-hi">' + fxrWon(x.hi.v) + '</span>'
      + '<span class="or-when">' + escapeHtml(x.hi.d) + '</span></td>'
      + '<td class="oc-num"><span class="or-lo">' + fxrWon(x.lo.v) + '</span>'
      + '<span class="or-when">' + escapeHtml(x.lo.d) + '</span></td>'
      + '<td class="oc-num">' + fxrWon(x.avg) + '</td>'
      + '<td class="oc-num' + dCls + '">' + (d ? fxrSigned(d.change) : '—')
      + '<span class="or-when">' + escapeHtml(fxrPct(dp)) + '</span></td></tr>';
  };
  return '<div class="oc-tablewrap"><table class="oc-table or-tbl"><thead><tr>'
    + '<th class="oc-th-p">통화</th><th>최근값</th><th>기간 등락</th>'
    + '<th>최고</th><th>최저</th><th>평균</th><th>참고 · 전일 대비</th>'
    + '</tr></thead><tbody>' + c.st.map(row).join('') + '</tbody></table></div>';
}

/** 변동폭 순위 — 기간 등락률 절댓값 기준. 값 없는 통화는 순위에서 뺀다. */
function fxrRankHtml(c) {
  const rank = c.live.filter((x) => x.pct != null)
    .slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  if (!rank.length) return '';
  return '<div class="srr-stats">' + rank.map((x, i) => {
    const cls = x.pct > 0 ? ' srr-up' : (x.pct < 0 ? ' srr-down' : ' srr-flat');
    return '<div class="srr-stat"><span class="gs-k">' + (i + 1) + '위 '
      + escapeHtml(x.label) + '</span>'
      + '<span class="gs-v' + cls + '">' + escapeHtml(fxrPct(x.pct)) + '</span>'
      + '<span class="srr-sub">' + escapeHtml(fxrSigned(x.chg)) + '</span></div>';
  }).join('') + '</div>';
}

/** 보조 설명 문장. 근거 없는 문장은 아예 넣지 않는다. */
function fxrSubs(c) {
  const h = c.head, out = [];
  const unit = (h.cur === 'JPY') ? ' (100엔 기준)' : '';
  if (h.n) {
    out.push('조회 기간(' + c.months + '개월 · ' + c.span + ') 안에서 '
      + h.label + unit + '는 최고 ' + fxrWon(h.hi.v) + '(' + h.hi.d + '), '
      + '최저 ' + fxrWon(h.lo.v) + '(' + h.lo.d + ')입니다.');
    out.push('같은 기간 평균은 ' + fxrWon(h.avg) + '이고, 값이 있는 날은 '
      + h.n + '일입니다.');
    const diff = Math.round((h.last.v - h.avg) * 100) / 100;
    out.push('최근값은 기간 평균보다 ' + fxrSigned(diff) + ' '
      + (diff > 0 ? '높은' : (diff < 0 ? '낮은' : '같은')) + ' 수준입니다.');
  }
  /* ★ 통화 비교는 '둘 이상 골랐을 때'만 말한다.
     하나만 골랐는데 다른 통화를 끌어오면, 고른 조건과 읽는 내용이 어긋난다. */
  if (c.multi) {
    const rank = c.live.filter((x) => x.pct != null)
      .slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    if (rank.length >= 2) {
      const top = rank[0], bot = rank[rank.length - 1];
      out.push('고른 ' + c.drawCurs.length + '개 통화 가운데 이번 기간 원화 대비 '
        + '변동폭이 가장 큰 통화는 ' + top.label + '(' + fxrPct(top.pct) + '), '
        + '가장 작은 통화는 ' + bot.label + '(' + fxrPct(bot.pct) + ')입니다.');
    }
  }
  /* ★ 전일 대비는 시간 기준이 달라 헷갈리기 쉽다. 문장 앞에 '참고'를 붙여
     기간 기준 문장들과 확실히 갈라 놓는다. */
  const d = fxrDay(h.cur), dp = fxrDayPct(d);
  if (d && d.change != null) {
    const w = d.change > 0 ? '상승' : (d.change < 0 ? '하락' : '보합');
    out.push('참고 · 전일 대비(하루 기준)로는 ' + h.label + '가 '
      + fxrSigned(d.change) + '(' + fxrPct(dp) + ') ' + w + '했습니다. '
      + '위 문장들은 모두 조회 기간(' + c.months + '개월) 기준입니다.');
  }
  return out;
}

/** 총 내용 정리 — 맨 앞이 한줄평이다. 모두 계산값으로만 만든다. */
function fxrSummary(c) {
  const out = [];
  /* ① 한줄평 — '조회 기간' 기준으로 말한다.
     ★★ 예전에는 전일 대비(하루)로 한줄평을 쓰고 바로 다음 문장은 3개월을 말해
       시간 기준이 섞였다. 헤드라인·한줄평·보조 문장을 모두 조회 기간으로 맞춘다.
     ★★ 그리고 고른 통화만 센다 — 예전에는 FX_CURS(3통화)를 통째로 셌다. */
  const per = c.live.filter((x) => x.pct != null);
  if (per.length) {
    const up = per.filter((x) => x.chg > 0).length;
    const dn = per.filter((x) => x.chg < 0).length;
    const fl = per.length - up - dn;
    const mv = per.slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0];
    const mag = fxrMag(mv.pct);          // 가장 큰 변동폭의 등급
    /* ★ '소폭'을 어디에 붙이느냐가 뜻을 바꾼다.
       고른 통화가 모두 같은 방향이면 '가장 큰 변동폭이 소폭' = '모두 소폭'
       이므로 방향 동사에 붙여도 참이다. 방향이 섞였을 때는 그렇게 말할 수 없으니
       가장 많이 움직인 통화 쪽에만 붙인다. */
    const base = '조회 기간(' + c.months + '개월) 동안 ';
    let dir, magOnMover = true;
    if (!c.multi) {                       // 통화 하나 — 비교하지 않고 그 통화만 말한다
      const w = mv.chg > 0 ? '상승' : (mv.chg < 0 ? '하락' : '보합');
      out.push(mv.label + '는 ' + base + fxrSigned(mv.chg) + '('
        + fxrPct(mv.pct) + ') ' + mag + w + '했습니다.');
    } else {
      if (dn === per.length) { dir = '고른 ' + per.length + '개 통화 모두 ' + base + mag + '하락했으며'; magOnMover = false; }
      else if (up === per.length) { dir = '고른 ' + per.length + '개 통화 모두 ' + base + mag + '상승했으며'; magOnMover = false; }
      else if (fl === per.length) { dir = '고른 ' + per.length + '개 통화 모두 ' + base + '거의 움직이지 않았으며'; magOnMover = false; }
      else {
        const parts = [];
        if (up) parts.push(up + '개 통화가 상승');
        if (dn) parts.push(dn + '개가 하락');
        if (fl) parts.push(fl + '개가 보합');
        dir = base + parts.join('하고 ') + '했으며';
      }
      const tail = '변동폭이 가장 큰 통화는 ' + mv.label
        + '(' + fxrSigned(mv.chg) + ', ' + fxrPct(mv.pct) + ')';
      out.push('최근 환율은 ' + dir + ', ' + tail
        + (magOnMover ? '로 ' + mag + '움직였습니다.' : '입니다.'));
    }
  }
  // ② 기간 관점 — 헤드라인 통화의 경로
  const h = c.head;
  if (h.n && h.pct != null) {
    const w = h.chg > 0 ? '올랐고' : (h.chg < 0 ? '내렸고' : '보합이었고');
    const lastWon = fxrWon(h.last.v);   // '…원' 은 받침이 있어 '으로'가 맞다
    out.push(h.label + '는 조회한 ' + c.months + '개월 동안 '
      + fxrWon(h.first.v) + '에서 ' + lastWon + gsJosa(lastWon, '으로', '로') + ' '
      + fxrSigned(h.chg) + '(' + fxrPct(h.pct) + ') ' + w
      + ' 최고 ' + fxrWon(h.hi.v) + '과 최저 ' + fxrWon(h.lo.v) + ' 사이에서 움직였습니다.');
  }
  // ③ 원인은 쓰지 않는다 — 이 데이터로 알 수 없다는 사실만 남긴다.
  out.push('환율이 왜 그렇게 움직였는지는 이 시세 데이터만으로 알 수 없어 적지 않았습니다. '
    + '위 문장은 모두 조회 기간(' + c.months + '개월) 기준이며, 수치는 같은 원본 시세에서 '
    + '계산한 값입니다.');
  return out;
}

/** 추이 그래프 — 핵심 지점만 라벨. 단일 통화는 최고·최저·최근값,
    '전체'는 선이 셋이라 각 통화의 최근값만 찍는다(최고·최저는 위 표에 있다). */
function fxrChart(c) {
  const dates = c.sl.dates, n = dates.length;
  const draw = c.st.filter((x) => x.n && c.drawCurs.indexOf(x.cur) >= 0);
  if (n < 2 || !draw.length) return '<div class="chart-empty">추이를 그릴 값이 부족합니다.</div>';
  const all = [];
  draw.forEach((x) => x.pts.forEach((p) => all.push(p.v)));
  let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
  const pad = (ymax - ymin) * 0.22 || 5;
  ymin -= pad; ymax += pad;

  const W = VIZ_W, H = 200, padL = 58, padR = 30, padT = 26, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / ((ymax - ymin) || 1)) * plotH;
  const idxOf = {};
  dates.forEach((d, i) => { idxOf[d] = i; });

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${fxNum(val)}</text>`;
  }).join('');

  const xlab = orTickIdx(n, 6).map((i) => {
    const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 18).toFixed(1)}" text-anchor="${anchor}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(dates[i].slice(2).replace(/-/g, '.'))}</text>`;
  }).join('');

  const lines = draw.map((x) => {
    const pts = x.pts.map((p) => X(idxOf[p.d]).toFixed(1) + ',' + Y(p.v).toFixed(1)).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${x.color}" stroke-width="1.8" stroke-linejoin="round"/>`;
  }).join('');

  // 라벨 — 값 위/아래로 나눠 겹침을 피한다(최고는 위, 최저는 아래).
  const mark = (p, color, txt, up) => {
    const x = X(idxOf[p.d]), y = Y(p.v);
    const anchor = x > padL + plotW - 60 ? 'end' : (x < padL + 60 ? 'start' : 'middle');
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${color}" stroke="var(--card)" stroke-width="1.6"/>`
      + `<text x="${x.toFixed(1)}" y="${(y + (up ? -9 : 15)).toFixed(1)}" text-anchor="${anchor}" font-size="10" font-weight="800"`
      + ` paint-order="stroke" stroke="var(--card)" stroke-width="3" fill="var(--ink)">${escapeHtml(txt)}</text>`;
  };
  let marks = '';
  if (c.drawCurs.length === 1) {
    const x = draw[0];
    marks += mark(x.hi, x.color, '최고 ' + fxNum(x.hi.v), true);
    marks += mark(x.lo, x.color, '최저 ' + fxNum(x.lo.v), false);
    marks += mark(x.last, x.color, '최근 ' + fxNum(x.last.v), true);
  } else {
    draw.forEach((x) => { marks += mark(x.last, x.color, x.label + ' ' + fxNum(x.last.v), true); });
  }

  const legend = (c.drawCurs.length > 1)
    ? '<div class="srr-legend">' + draw.map((x) => '<span class="srr-lg">'
      + '<i style="background:' + x.color + '"></i>' + escapeHtml(x.label) + '</span>').join('')
      + '</div>' : '';

  return `<svg class="srr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ' aria-label="환율 추이">' + grid + xlab + lines + marks
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/></svg>`
    + legend;
}

/** 리포트 본문. 버튼을 누르기 전에는 호출되지 않는다. */
function fxrReportHtml() {
  const c = fxrCtx();
  if (!c) return '<div class="srr"><div class="chart-empty">리포트를 만들 시세가 없습니다.</div></div>';
  const h = c.head;
  const d = fxrDay(h.cur), dp = fxrDayPct(d);
  /* ★★ 헤드라인은 '조회 기간' 변화다(전일 대비 아님).
     한 리포트 안에서 시간 기준이 섞이지 않도록, 전일 대비는 아래 줄에
     '참고'라고 못 박아 따로 뺀다. */
  const dir = (h.chg == null) ? 'flat' : (h.chg > 0 ? 'up' : (h.chg < 0 ? 'down' : 'flat'));
  const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '—');
  /* 조회 조건에 쓸 통화 이름 — 고른 것을 모두 적는다.
     셋 다면 '전체', 하나면 이름까지, 둘이면 코드로 나열한다. */
  const curLabel = c.isAll
    ? '전체(' + c.drawCurs.join('·') + ')'
    : (c.multi ? c.drawCurs.map((x) => FX_META[x].label).join(' · ')
      : h.name + '(' + h.label + ')');
  const dDir = (!d || d.change == null) ? 'flat' : (d.change > 0 ? 'up' : (d.change < 0 ? 'down' : 'flat'));
  const dArrow = dDir === 'up' ? '▲' : (dDir === 'down' ? '▼' : '—');

  const hero = '<div class="srr-hero">'
    + '<div class="srr-hero__when">' + escapeHtml(h.name + '(' + h.label + ')')
    + (h.cur === 'JPY' ? ' · 100엔 기준' : '')
    + (c.multi ? ' · 고른 ' + c.drawCurs.length + '개 통화 중 기준 통화' : '')
    + (fxAsOfDate() ? ' · 기준일 ' + escapeHtml(fxAsOfDate()) : '') + '</div>'
    + '<div class="srr-hero__row">'
    + '<span class="srr-hero__v">' + escapeHtml(fxNum(h.last.v)) + '</span>'
    + '<span class="srr-hero__unit">원</span>'
    + '<span class="srr-hero__d srr-' + dir + '">' + arrow + ' '
    + escapeHtml(h.chg == null ? '—' : fxNum(Math.abs(h.chg)) + '원')
    + (h.pct != null ? ' (' + escapeHtml(fxrPct(h.pct)) + ')' : '')
    + '<span class="srr-hero__vs">조회 기간(' + c.months + '개월) 대비</span></span>'
    + '</div>'
    + '<div class="fxr-daily">참고 · 전일 대비 <b class="srr-' + dDir + '">' + dArrow + ' '
    + escapeHtml(d && d.change != null ? fxNum(Math.abs(d.change)) + '원' : '—')
    + (dp != null ? ' (' + escapeHtml(fxrPct(dp)) + ')' : '') + '</b>'
    + ' <span class="fxr-daily__s">— 하루 기준이라 위 수치와 기간이 다릅니다</span></div>'
    + '</div>';

  const subs = fxrSubs(c).map((t) => '<p class="srr-p">' + escapeHtml(t) + '</p>').join('');

  return '<div class="srr">'
    + '<div class="srr-head">리포트 분석 <span class="srr-scope">'
    + escapeHtml(curLabel + ' · ' + c.months + '개월 · ' + c.days + '일 관측') + '</span></div>'
    + '<p class="srr-cond"><b>현재 조회 조건</b> · 통화 ' + escapeHtml(curLabel)
    + ' · 기간 최근 ' + c.months + '개월(' + escapeHtml(c.span) + ')'
    + ' · 서술 기준 조회 기간</p>'
    + '<p class="srr-def">' + escapeHtml(FXR_DEF) + '</p>'
    + hero + subs
    + '<h4 class="srr-h">' + (c.multi
      ? '통화별 지표 (' + escapeHtml(c.drawCurs.join(' · ')) + ' 비교)'
      : escapeHtml(h.label) + ' 지표') + '</h4>'
    + fxrTable(c)
    // 순위는 견줄 대상이 둘 이상일 때만 낸다
    + (c.multi ? '<h4 class="srr-h">기간 변동폭 순위 (원화 대비)</h4>' + fxrRankHtml(c) : '')
    + '<h4 class="srr-h">추이</h4><div class="srr-chart">' + fxrChart(c) + '</div>'
    + '<div class="srr-sum"><div class="srr-sum__h">총 내용 정리</div>'
    + fxrSummary(c).map((t) => '<p class="srr-sum__p">' + escapeHtml(t) + '</p>').join('')
    + '</div></div>';
}

/** series를 최근 N개월로 슬라이스 */
/** 추이 시계열. 실시간 수집(_fx)이 먼저고, 없으면 커밋된 fx-analysis.json 을 쓴다.
 *  ★ 한쪽이 없다고 차트가 비지 않게 한다 — 두 소스 모두 같은 모양(dates + 통화별 배열)이다. */
function fxSeries() {
  const a = _fx && _fx.series;
  if (a && Array.isArray(a.dates) && a.dates.length) return a;
  const b = _fxa && _fxa.series;
  if (b && Array.isArray(b.dates) && b.dates.length) return b;
  return null;
}

function fxSlice(months) {
  const empty = { dates: [], USD: [], EUR: [], JPY: [] };
  const s = fxSeries();
  if (!s || !Array.isArray(s.dates) || !s.dates.length) return empty;
  const dates = s.dates;
  const last = new Date(dates[dates.length - 1] + 'T00:00:00');
  const cutoff = new Date(last); cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const idx = dates.map((d, i) => (d >= cutoffStr ? i : -1)).filter((i) => i >= 0);
  const pick = (arr) => (Array.isArray(arr) ? idx.map((i) => arr[i]) : idx.map(() => null));
  return { dates: idx.map((i) => dates[i]), USD: pick(s.USD), EUR: pick(s.EUR), JPY: pick(s.JPY) };
}

/** 원화 추이 선그래프 — cur='all'이면 세 통화 동시(범례 O), 아니면 단일(라벨).
 *  Y축은 표시 통화들의 min/max에 여유를 준 auto 범위(0부터 시작 안 함). */
function buildFxChart(slice, cur) {
  const dates = slice.dates, n = dates.length;
  if (!n) { _fxChart = null; return '<div class="chart-empty">추이 데이터가 없습니다.</div>'; }
  // cur 은 통화 배열(예 ['USD','EUR']). 'all'/단일 문자열도 그대로 받는다.
  const curList = Array.isArray(cur) ? cur : (cur === 'all' ? FX_CURS : [cur]);
  const isAll = curList.length > 1;      // 둘 이상이면 범례를 붙인다
  const series = curList.map((c) => ({ key: c, color: FX_META[c].color, values: slice[c] || [] }))
    .filter((sr) => sr.values.some((v) => v != null));
  if (!series.length) { _fxChart = null; return '<div class="chart-empty">추이 데이터가 없습니다.</div>'; }

  // Y축: 통화별 자릿수가 달라 고정 금지 → 데이터 min/max 기준 + 여유(변동이 평평해지지 않게)
  const all = series.flatMap((sr) => sr.values).filter((v) => v != null);
  let ymin = Math.min(...all), ymax = Math.max(...all);
  if (ymin === ymax) { const d = Math.abs(ymin) * 0.05 || 1; ymin -= d; ymax += d; }
  const yp = (ymax - ymin) * 0.14 || 10; ymin -= yp; ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 46, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val).toLocaleString('ko-KR')}</text>`;
  }).join('');

  const xticks = vizTickIdx(n, plotW).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(dates[i].slice(0, 7))}</text>`;
  }).join('');

  const lines = series.map((sr) => {
    let path = '', pen = false;
    sr.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  // 헤더: 전체=범례(3개), 단일=통화 라벨
  let header, aria;
  if (isAll) {
    header = `<div class="viz-legend">${series.map((sr) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${sr.color}"></span>${escapeHtml(FX_META[sr.key].name)}(${sr.key})</span>`).join('')}</div>`;
    aria = '원화 환율 추이 (USD·EUR·JPY)';
  } else {
    const m = FX_META[cur] || { color: 'var(--slate)', name: cur, label: cur };
    header = `<div class="fx-series-label"><span class="viz-legend__swatch" style="background:${m.color}"></span>${escapeHtml(m.name)}(${escapeHtml(m.label)})<span class="fx-series-unit"> · 원${cur === 'JPY' ? ' (100엔)' : ''}</span></div>`;
    aria = `${m.name} 원화 추이`;
  }
  _fxChart = { dates, series, geom: { X, Y, n, W, padL }, cur };

  return `${header}
    <svg class="viz-svg fx-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(aria)}">
      ${grid}${xticks}${lines}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="fx-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="fx-dots"></g>
      <rect class="fx-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 추이 차트 크로스헤어 + 툴팁 (날짜 · 통화 · 값) */
function wireFxInteraction() {
  const fig = document.querySelector('#body-fx .fx-figure');
  const tip = document.getElementById('fxTooltip');
  if (!fig || !tip || !_fxChart) return;
  const svg = fig.querySelector('.fx-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.fx-overlay');
  const cross = svg.querySelector('.fx-cross');
  const dots = svg.querySelector('.fx-dots');
  const c = _fxChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      const unit = s.key === 'JPY' ? ' 원 (100엔)' : ' 원';
      const nm = FX_META[s.key] ? `${FX_META[s.key].name}(${s.key})` : s.key;
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${escapeHtml(nm)}</span><span class="viz-tt-val">${fxNum(v)}${unit}</span></div>`;
    });
    if (!rows) { clear(); return; }
    dots.innerHTML = dh;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.dates[i])}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/* ── 세계 시간 (World Clock) — 외부 API 없이 Intl.DateTimeFormat로 계산 ── */
// 등장방형도법: lat/lon → x=(lon+180)/360, y=(90-lat)/180 (남위도 그대로 정확: 예 -33.87→68.8%)
// dir=도시명 라벨 방향(근접 도시 겹침 분산). 상세(시각·날씨·시차)는 hover/탭 툴팁 + 하단 표.
const WORLD_CITIES = [
  { ko: '서울', tz: 'Asia/Seoul', lat: 37.57, lon: 126.98, dir: 'n' },
  { ko: '도쿄', tz: 'Asia/Tokyo', lat: 35.68, lon: 139.69, dir: 'ne' },
  { ko: '상하이', tz: 'Asia/Shanghai', lat: 31.23, lon: 121.47, dir: 'sw' },
  { ko: '싱가포르', tz: 'Asia/Singapore', lat: 1.35, lon: 103.82, dir: 's' },
  { ko: '두바이', tz: 'Asia/Dubai', lat: 25.20, lon: 55.27, dir: 's' },
  { ko: '런던', tz: 'Europe/London', lat: 51.51, lon: -0.13, dir: 'w' },
  { ko: '파리', tz: 'Europe/Paris', lat: 48.86, lon: 2.35, dir: 'sw' },
  { ko: '프랑크푸르트', tz: 'Europe/Berlin', lat: 50.11, lon: 8.68, dir: 'n' },
  { ko: '밀라노', tz: 'Europe/Rome', lat: 45.46, lon: 9.19, dir: 'se' },
  { ko: '모스크바', tz: 'Europe/Moscow', lat: 55.76, lon: 37.62, dir: 'n' },
  { ko: '카이로', tz: 'Africa/Cairo', lat: 30.04, lon: 31.24, dir: 'se' },
  { ko: '요하네스버그', tz: 'Africa/Johannesburg', lat: -26.20, lon: 28.05, dir: 's' },
  { ko: '뉴욕', tz: 'America/New_York', lat: 40.71, lon: -74.01, dir: 'e' },
  { ko: '시카고', tz: 'America/Chicago', lat: 41.88, lon: -87.63, dir: 'w' },
  { ko: '로스앤젤레스', tz: 'America/Los_Angeles', lat: 34.05, lon: -118.24, dir: 's' },
  // 브라질리아 타임존은 America/Sao_Paulo(=Brasilia 아님), 부에노스아이레스는 슬래시 2개
  { ko: '브라질리아', tz: 'America/Sao_Paulo', lat: -15.79, lon: -47.88, dir: 'ne' },
  { ko: '부에노스아이레스', tz: 'America/Argentina/Buenos_Aires', lat: -34.61, lon: -58.38, dir: 'sw' },
  { ko: '시드니', tz: 'Australia/Sydney', lat: -33.87, lon: 151.21, dir: 'se' },
];
let _wcTimer = null;
let _wcShown = false;    // 마커 표시 여부(업데이트 후 true, 초기화 시 false)
let _wcWeather = null;   // 도시별 {temp,code} 배열 | null(요청 실패 → 기온 —)
let _wcOpen = null;      // 툴팁 열린 도시 index(핀 고정) | null

/** tz 현재 시각 구성요소 {year,month,day,minute,h(0~23)} — 24시간제 */
function wcParts(tz, date) {
  const out = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).forEach((p) => { if (p.type !== 'literal') out[p.type] = p.value; });
  let hh = parseInt(out.hour, 10); if (hh === 24) hh = 0;  // 자정 '24' 방어
  out.h = hh;
  return out;
}

/** tz UTC 오프셋(분) — 서머타임 자동 반영(하드코딩 없음) */
function wcOffsetMin(parts, date) {
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, parts.h, +parts.minute, 0);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** 서울 기준 시차 배지(예 '+0h', '-1h', '-16h') */
function wcOffsetLabel(diffMin) {
  const h = diffMin / 60, a = Math.abs(h);
  return `${h < 0 ? '-' : '+'}${Number.isInteger(a) ? a : a.toFixed(1)}h`;
}

/** WMO weather_code → 아이콘 */
function wmoIcon(code) {
  if (code == null) return '·';
  if (code === 0) return '☀';
  if ([1, 2, 3].includes(code)) return '⛅';
  if ([45, 48].includes(code)) return '🌫';
  if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67)) return '🌧';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '❄';
  if (code >= 80 && code <= 82) return '🌦';
  if ([95, 96, 99].includes(code)) return '⛈';
  return '🌡';
}

/** 도시 i의 현재 상태 {timeStr,dateStr,h,diffMin} 계산 */
function wcState(i, now, seoulOff) {
  const p = wcParts(WORLD_CITIES[i].tz, now);
  return {
    timeStr: `${String(p.h).padStart(2, '0')}:${p.minute}`,
    dateStr: `${p.month}/${p.day}`,
    h: p.h,
    diffMin: wcOffsetMin(p, now) - seoulOff,
  };
}

/** 지도 + 마커(점+도시명) + 하단 표 렌더. 초기(미표시)엔 회색 지도 + 안내 */
function renderWorldClock() {
  const root = document.getElementById('worldclockRoot');
  if (!root) return;
  _wcOpen = null;
  if (!_wcShown) {
    root.innerHTML = `<div class="wc-map">
        <img class="wc-map__img" src="world-map.svg" alt="" aria-hidden="true">
        <div class="wc-empty">업데이트 버튼을 눌러 불러오세요</div>
      </div>
      <div class="comp-caption">출처: Open-Meteo</div>`;
    return;
  }
  const dots = WORLD_CITIES.map((c, i) => {
    const x = (c.lon + 180) / 360 * 100;
    const y = (90 - c.lat) / 180 * 100;
    // 서울만 상세 화면이 있어 표시를 조금 더 준다.
    // ★ 두 값은 서울이 아니면 빈 문자열이라, 나머지 마커의 HTML 은 예전과 한 글자도 다르지 않다.
    const krCls = (c.ko === '서울') ? ' wc-mk--kr' : '';
    const krHint = (c.ko === '서울') ? ' title="눌러서 국내 주요 도시 날씨 보기"' : '';
    return `<button class="wc-mk wc-${c.dir}${krCls}" data-i="${i}" type="button"
        style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%" aria-label="${escapeHtml(c.ko)}"${krHint}>
        <span class="wc-dot"></span><span class="wc-name">${escapeHtml(c.ko)}</span>
      </button>`;
  }).join('');
  root.innerHTML = `<div class="wc-map">
      <img class="wc-map__img" src="world-map.svg" alt="" aria-hidden="true">
      <div class="wc-markers">${dots}</div>
      <div class="wc-tip" id="wcTip" hidden></div>
    </div>
    <div class="comp-caption">출처: Open-Meteo</div>`;
  wcWire();
  wcTick();
}

/** 매 틱(30초): 마커 주야 구분 + 열린 툴팁 갱신 */
function wcTick() {
  const root = document.getElementById('worldclockRoot');
  if (!root || !_wcShown || _krOn) return;   // 한국 상세 화면이 열려 있으면 건드리지 않는다
  const now = new Date();
  const seoulOff = wcOffsetMin(wcParts('Asia/Seoul', now), now);
  root.querySelectorAll('.wc-mk').forEach((mk) => {
    const st = wcState(+mk.dataset.i, now, seoulOff);
    const night = (st.h >= 19 || st.h < 6);
    mk.classList.toggle('is-night', night);
    mk.classList.toggle('is-day', !night);
  });
  if (_wcOpen != null) wcShowTip(_wcOpen, true);  // 열린 툴팁 내용 갱신
}

/** 툴팁 내용 + 지도 안쪽으로 위치 지정 */
function wcShowTip(i, keepOpen) {
  const root = document.getElementById('worldclockRoot');
  const tip = root && root.querySelector('#wcTip');
  const mk = root && root.querySelector(`.wc-mk[data-i="${i}"]`);
  if (!tip || !mk) return;
  const c = WORLD_CITIES[i];
  const now = new Date();
  const seoulOff = wcOffsetMin(wcParts('Asia/Seoul', now), now);
  const st = wcState(i, now, seoulOff);
  const w = _wcWeather && _wcWeather[i];
  const wx = w ? `${wmoIcon(w.code)} ${w.temp != null ? Math.round(w.temp) + '°' : '—'}` : '—';
  const x = (c.lon + 180) / 360 * 100, y = (90 - c.lat) / 180 * 100;
  tip.innerHTML = `<div class="wc-tip__city">${escapeHtml(c.ko)}</div>
    <div class="wc-tip__time">${st.timeStr}<span class="wc-tip__date"> · ${st.dateStr}</span></div>
    <div class="wc-tip__row"><span>서울 대비</span><b>${wcOffsetLabel(st.diffMin)}</b></div>
    <div class="wc-tip__row"><span>날씨</span><b>${wx}</b></div>`;
  // 지도 안쪽으로 열기: 오른쪽 도시는 왼쪽으로, 아래 도시는 위로
  tip.style.left = tip.style.right = tip.style.top = tip.style.bottom = 'auto';
  if (x <= 50) tip.style.left = `calc(${x}% + 12px)`; else tip.style.right = `calc(${(100 - x).toFixed(2)}% + 12px)`;
  if (y <= 55) tip.style.top = `calc(${y}% - 6px)`; else tip.style.bottom = `calc(${(100 - y).toFixed(2)}% - 6px)`;
  tip.hidden = false;
  if (!keepOpen) mk.classList.add('is-hi');
}

/** 툴팁 숨김 */
function wcHideTip() {
  const root = document.getElementById('worldclockRoot');
  const tip = root && root.querySelector('#wcTip');
  if (tip) tip.hidden = true;
  if (root) root.querySelectorAll('.wc-mk.is-hi').forEach((m) => m.classList.remove('is-hi'));
}

/** 마커 hover/탭 + 표 행 hover 연동 배선 */
function wcWire() {
  const root = document.getElementById('worldclockRoot');
  if (!root) return;
  const markers = root.querySelector('.wc-markers');
  markers.addEventListener('mouseover', (e) => {
    const mk = e.target.closest('.wc-mk'); if (!mk || _wcOpen != null) return;
    wcShowTip(+mk.dataset.i, false);
  });
  markers.addEventListener('mouseout', (e) => {
    const mk = e.target.closest('.wc-mk'); if (!mk || _wcOpen != null) return;
    wcHideTip();
  });
  // 탭/클릭: 핀 고정 토글(모바일 대응)
  // ★ 서울만 예외 — 한국 상세 화면으로 들어간다. 다른 도시는 예전 그대로 툴팁 토글.
  markers.addEventListener('click', (e) => {
    const mk = e.target.closest('.wc-mk'); if (!mk) return;
    const i = +mk.dataset.i;
    if (WORLD_CITIES[i] && WORLD_CITIES[i].ko === '서울') {
      e.stopPropagation();
      krOpen();
      return;
    }
    if (_wcOpen === i) { _wcOpen = null; wcHideTip(); }
    else { _wcOpen = i; wcShowTip(i, true); }
    e.stopPropagation();
  });
  // 바깥 탭/클릭 → 닫기
  document.addEventListener('click', wcOutside);
}

/** 지도 바깥 클릭 시 핀 툴팁 닫기 */
function wcOutside(e) {
  const root = document.getElementById('worldclockRoot');
  if (!root || _wcOpen == null) return;
  if (e.target.closest('.wc-mk') || e.target.closest('#wcTip')) return;
  _wcOpen = null; wcHideTip();
}

/* ── 한국 상세 화면 (세계 시간 카드 안) ─────────────────────────────────────
   ★ 기존 세계지도(WORLD_CITIES·renderWorldClock)는 건드리지 않는다.
     서울 마커를 눌렀을 때만 이 화면으로 바꿔 끼우고, [세계 시간으로 돌아가기]
     를 누르면 원래 렌더 함수를 그대로 다시 부른다.
   ★ 날씨: Open-Meteo (키 불필요·무료). 응답 값을 그대로 쓰고 임의 보정하지 않는다.
   ★ 뉴스: 서버의 /api/weather-news → 구글 뉴스 RSS. 제목·링크·언론사·날짜만.
     없으면 '없음'을 정직하게 띄운다(지어내지 않는다).
   ★ 지도: public/maps/korea.svg — 아래 KR_PROJ 와 '같은 식'으로 만들었다.
     그래서 lat/lon 을 그대로 넣으면 핀이 정확히 그 자리에 찍힌다. */

// korea.svg 를 만들 때 쓴 투영 상수(등장방형 · 표준위도 36°). 바꾸면 지도도 다시 만들어야 한다.
const KR_PROJ = { lon0: 124.50, lat1: 38.70, k: Math.cos(36 * Math.PI / 180), s: 120, w: 631.0, h: 684.0 };

/* 주요 도시 — 위도/경도는 각 시청 기준 공개 좌표.
   ★ 15개 전부 지도 폴리곤 안에 들어가는지 좌표로 검증했다(점-내부 판정). */
const KR_CITIES = [
  { ko: '서울', lat: 37.5665, lon: 126.9780 },
  { ko: '인천', lat: 37.4563, lon: 126.7052 },
  { ko: '수원', lat: 37.2636, lon: 127.0286 },
  { ko: '이천', lat: 37.2792, lon: 127.4425 },
  { ko: '강릉', lat: 37.7519, lon: 128.8761 },
  { ko: '세종', lat: 36.4800, lon: 127.2890 },
  { ko: '대전', lat: 36.3504, lon: 127.3845 },
  { ko: '포항', lat: 36.0190, lon: 129.3435 },
  { ko: '대구', lat: 35.8714, lon: 128.6014 },
  { ko: '울산', lat: 35.5384, lon: 129.3114 },
  { ko: '부산', lat: 35.1796, lon: 129.0756 },
  { ko: '광주', lat: 35.1595, lon: 126.8526 },
  { ko: '거제', lat: 34.8806, lon: 128.6211 },
  { ko: '통영', lat: 34.8544, lon: 128.4331 },
  { ko: '목포', lat: 34.8118, lon: 126.3922 },
  { ko: '제주', lat: 33.4996, lon: 126.5312 },
];

const KR_WX_TTL = 30 * 60 * 1000;   // 날씨 캐시 30분(요청 '1시간 이내' 요건보다 짧게)
const KR_FORECAST_NOTE = '예보는 기상 모델 예측값으로, 실제와 다를 수 있습니다. '
  + '먼 날짜일수록 정확도가 낮습니다.';
const KR_MAP_SRC = '지도: southkorea-maps (POPONG, CC BY 4.0) · 원자료 통계청 2013';

let _krOn = false;      // 한국 상세 화면이 열렸는지
let _krCity = 0;        // 고른 도시 index (기본 서울)
let _krWx = {};         // { 도시명: {ts, cur, days} }
let _krNews = {};       // { 도시명: {ts, status, items} }
let _krBusy = {};       // { 도시명: true } — 요청 중
let _krWired = false;   // root 는 재렌더에도 살아 있어 리스너가 쌓인다 → 한 번만 붙인다

/** lat/lon → korea.svg 안의 백분율 좌표(지도 생성식과 동일) */
function krXY(lat, lon) {
  const p = KR_PROJ;
  return {
    x: ((lon - p.lon0) * p.k * p.s) / p.w * 100,
    y: ((p.lat1 - lat) * p.s) / p.h * 100,
  };
}

/** WMO 코드 → 한국어 날씨 이름 (아이콘은 기존 wmoIcon 재사용) */
function krWmoText(code) {
  if (code == null) return '—';
  if (code === 0) return '맑음';
  if (code === 1) return '대체로 맑음';
  if (code === 2) return '구름 조금';
  if (code === 3) return '흐림';
  if (code === 45 || code === 48) return '안개';
  if (code >= 51 && code <= 57) return '이슬비';
  if (code >= 61 && code <= 67) return '비';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '눈';
  if (code >= 80 && code <= 82) return '소나기';
  if (code === 95) return '천둥번개';
  if (code === 96 || code === 99) return '천둥번개·우박';
  return '—';
}

function krNum(v, digits) {
  if (v == null || !isFinite(v)) return '—';
  const d = digits == null ? 0 : digits;
  return Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 시간 배열에서 특정 날짜의 오전(06~11시)·오후(12~17시) 평균을 낸다.
    ★ Open-Meteo 는 일별로 최고/최저만 주므로, 오전·오후를 나누려면 시간별을 모아야 한다.
      값을 만들어 내는 게 아니라 응답에 있는 시간값을 평균만 낸다. */
function krAmPm(hourly, day, key) {
  const t = hourly && hourly.time, arr = hourly && hourly[key];
  if (!Array.isArray(t) || !Array.isArray(arr)) return { am: null, pm: null };
  let as = 0, an = 0, ps = 0, pn = 0;
  for (let i = 0; i < t.length; i += 1) {
    const s = String(t[i]);
    if (s.slice(0, 10) !== day) continue;
    const h = parseInt(s.slice(11, 13), 10);
    const v = arr[i];
    if (v == null) continue;
    if (h >= 6 && h <= 11) { as += v; an += 1; }
    else if (h >= 12 && h <= 17) { ps += v; pn += 1; }
  }
  return { am: an ? as / an : null, pm: pn ? ps / pn : null };
}

/** Open-Meteo 로 현재 날씨 + 3일 예보. 실패하면 error 를 담아 돌려준다. */
async function krFetchWeather(city) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${city.lat}&longitude=${city.lon}`
    + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation'
    + '&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation_probability'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=Asia%2FSeoul&forecast_days=3';
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 9000) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const days = (d.daily && d.daily.time ? d.daily.time : []).map((day, i) => ({
      day: day,
      code: d.daily.weather_code ? d.daily.weather_code[i] : null,
      tmax: d.daily.temperature_2m_max ? d.daily.temperature_2m_max[i] : null,
      tmin: d.daily.temperature_2m_min ? d.daily.temperature_2m_min[i] : null,
      pop: d.daily.precipitation_probability_max ? d.daily.precipitation_probability_max[i] : null,
      t: krAmPm(d.hourly, day, 'temperature_2m'),
      rh: krAmPm(d.hourly, day, 'relative_humidity_2m'),
      ws: krAmPm(d.hourly, day, 'wind_speed_10m'),
      pp: krAmPm(d.hourly, day, 'precipitation_probability'),
    }));
    return { ts: Date.now(), cur: d.current || null, units: d.current_units || null, days: days };
  } catch (e) {
    console.warn('[korea] weather fail:', city.ko, e);
    return { ts: Date.now(), error: (e && e.message) || String(e), cur: null, days: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 서버 경유로 지역 날씨 이슈 뉴스. 실패해도 화면은 뜬다. */
async function krFetchNews(city) {
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
  try {
    const res = await fetch('/api/weather-news?region=' + encodeURIComponent(city.ko),
      { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return { ts: Date.now(), status: d.status || 'ok', items: d.items || [], reason: d.reason };
  } catch (e) {
    console.warn('[korea] news fail:', city.ko, e);
    return { ts: Date.now(), status: 'error', items: [], reason: (e && e.message) || String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 고른 도시의 날씨·뉴스를 필요할 때만 새로 받는다(캐시 TTL 지났을 때만). */
async function krLoad(i, force) {
  const city = KR_CITIES[i];
  if (!city || _krBusy[city.ko]) return;
  const stale = (c) => !c || (Date.now() - c.ts) > KR_WX_TTL;
  if (!force && !stale(_krWx[city.ko]) && !stale(_krNews[city.ko])) return;
  _krBusy[city.ko] = true;
  renderKorea();
  const [wx, news] = await Promise.all([
    (force || stale(_krWx[city.ko])) ? krFetchWeather(city) : Promise.resolve(_krWx[city.ko]),
    (force || stale(_krNews[city.ko])) ? krFetchNews(city) : Promise.resolve(_krNews[city.ko]),
  ]);
  _krWx[city.ko] = wx;
  _krNews[city.ko] = news;
  _krBusy[city.ko] = false;
  if (_krOn) renderKorea();
}

/** 오늘/내일/모레 라벨 */
function krDayLabel(day, i) {
  const names = ['오늘', '내일', '모레'];
  const md = day ? day.slice(5).replace('-', '/') : '';
  return (names[i] || md) + (md ? ' (' + md + ')' : '');
}

/** 현재 날씨 4칸 */
function krNowHtml(city, wx) {
  if (!wx || wx.error || !wx.cur) {
    return '<div class="kr-now kr-now--empty">' + escapeHtml(
      wx && wx.error ? '날씨를 불러오지 못했습니다 (' + wx.error + ')' : '날씨를 불러오는 중…') + '</div>';
  }
  const c = wx.cur;
  const cell = (k, v, u) => '<div class="kr-cell"><span class="kr-cell__k">' + escapeHtml(k)
    + '</span><span class="kr-cell__v">' + escapeHtml(v)
    + (u ? '<i>' + escapeHtml(u) + '</i>' : '') + '</span></div>';
  return '<div class="kr-nowwrap">'
    + '<div class="kr-nowhead"><span class="kr-nowicon">' + wmoIcon(c.weather_code) + '</span>'
    + '<span class="kr-nowtemp">' + krNum(c.temperature_2m, 1) + '<i>℃</i></span>'
    + '<span class="kr-nowtext">' + escapeHtml(krWmoText(c.weather_code)) + '</span></div>'
    + '<div class="kr-cells">'
    + cell('바람', krNum(c.wind_speed_10m, 1), 'km/h')
    + cell('습도', krNum(c.relative_humidity_2m), '%')
    + cell('1시간 강수량', krNum(c.precipitation, 1), 'mm')
    + cell('기온', krNum(c.temperature_2m, 1), '℃')
    + '</div></div>';
}

/** 3일 예보 표 — 오전/오후로 나눠 기온·습도·평균풍속·강수확률 */
function krForecastHtml(wx) {
  if (!wx || wx.error || !wx.days || !wx.days.length) {
    return '<div class="kr-fc__empty">예보를 불러오지 못했습니다.</div>';
  }
  const half = (d, k, key, digits, unit) => '<td class="kr-fc__v">'
    + escapeHtml(krNum(d[key][k], digits)) + (unit ? '<i>' + escapeHtml(unit) + '</i>' : '') + '</td>';
  const rows = wx.days.map((d, i) => ['am', 'pm'].map((k) =>
    '<tr>'
    + (k === 'am' ? '<td class="kr-fc__d" rowspan="2"><b>' + escapeHtml(krDayLabel(d.day, i))
      + '</b><span class="kr-fc__ic">' + wmoIcon(d.code) + ' '
      + escapeHtml(krWmoText(d.code)) + '</span>'
      + '<span class="kr-fc__mm">' + escapeHtml(krNum(d.tmin, 0)) + '° / '
      + escapeHtml(krNum(d.tmax, 0)) + '°</span></td>' : '')
    + '<td class="kr-fc__h">' + (k === 'am' ? '오전' : '오후') + '</td>'
    + half(d, k, 't', 1, '℃') + half(d, k, 'rh', 0, '%')
    + half(d, k, 'ws', 1, 'km/h') + half(d, k, 'pp', 0, '%')
    + '</tr>').join('')).join('');
  return '<div class="kr-fc__wrap"><table class="kr-fc">'
    + '<thead><tr><th>날짜</th><th></th><th>기온</th><th>습도</th><th>평균풍속</th><th>강수확률</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>'
    + '<div class="kr-note">※ ' + escapeHtml(KR_FORECAST_NOTE) + '</div>';
}

/** 지역 날씨 이슈 뉴스 — 제목·링크·언론사·날짜만 */
function krNewsHtml(city, nw) {
  if (!nw) return '<div class="kr-nw__empty">뉴스를 불러오는 중…</div>';
  if (nw.status !== 'ok') {
    return '<div class="kr-nw__empty">뉴스를 불러오지 못했습니다'
      + (nw.reason ? ' (' + escapeHtml(nw.reason) + ')' : '') + '</div>';
  }
  if (!nw.items.length) {
    return '<div class="kr-nw__empty">최근 관련 뉴스가 없습니다.</div>';
  }
  return '<ul class="kr-nw">' + nw.items.map((it) => {
    const u = safeUrl(it.link);
    const meta = [it.source, it.date].filter(Boolean).join(' · ');
    return '<li class="kr-nw__i">'
      + (u ? '<a class="kr-nw__t" href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">'
        + escapeHtml(it.title) + '</a>' : '<span class="kr-nw__t">' + escapeHtml(it.title) + '</span>')
      + (meta ? '<span class="kr-nw__m">' + escapeHtml(meta) + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
}

/* ── 한국 도시 상세 · 과거 추이 그래프 4종 ────────────────────────────────
   ★ 값은 Open-Meteo Historical Weather API(archive) 응답을 그대로 쓴다.
     임의 보정하지 않는다. 단위 변환만 한다(일조시간 초 → 시간).
   ★★ 특보는 기상청 기상특보 조회서비스(공공데이터포털)에서 받는다. 인증키가
     없으면 서버가 status='no_key' 를 주고, 그래프에는 특보 관련 표시를 아무것도
     하지 않는다(안내 배지·각주 없음). 4개 그래프는 그대로 다 그려진다.
     ★ 받아 오는 구조는 그대로 살려 뒀다 — 키가 생기면 bands 가 채워지고
       음영·특보 보조축·종류 안내가 자동으로 나타난다(kwCard 의 아래 분기들). */

const KW_RANGES = [{ key: 30, label: '1개월' }, { key: 60, label: '2개월' }];
const KW_TTL = 60 * 60 * 1000;      // 과거값은 자주 바뀌지 않는다 — 1시간 캐시

let _kwRange = 30;
let _kwHist = {};      // { '도시|일수': {ts, days:[…]} }
let _kwAlert = {};     // { '도시|일수': {ts, status, bands:[…]} }
let _kwBusy = {};
let _kwGeom = {};       // 그래프별 좌표·값 (툴팁이 쓴다)
let _kwTipSeq = 0;      // 그래프마다 붙이는 일련번호

/* 특보 종류별 음영 색. 어느 그래프가 어떤 특보를 받는지는 서버의 KIND_GROUP 과 같다. */
const KW_ALERT_COLORS = {
  폭염: '#EF4444', 한파: '#3B82F6', 태풍: '#7C3AED', 강풍: '#8B5CF6',
  풍랑: '#6366F1', 건조: '#F59E0B', 호우: '#0EA5E9', 대설: '#64748B',
};

/** 캐시 키 */
function kwKey(city) { return city.ko + '|' + _kwRange; }

/** Open-Meteo archive → 일별 배열. 실패하면 error 를 담아 돌려준다. */
async function kwFetchHist(city, days) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const daily = ['temperature_2m_max', 'temperature_2m_mean', 'temperature_2m_min',
    'wind_speed_10m_mean', 'wind_speed_10m_max',
    'relative_humidity_2m_mean', 'relative_humidity_2m_min',
    'precipitation_sum', 'sunshine_duration'].join(',');
  const url = 'https://archive-api.open-meteo.com/v1/archive'
    + `?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${iso(start)}&end_date=${iso(end)}`
    + `&daily=${daily}&timezone=Asia%2FSeoul`;
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const t = (d.daily && d.daily.time) || [];
    const g = (k, i) => (d.daily && d.daily[k] ? d.daily[k][i] : null);
    const rows = t.map((day, i) => ({
      day: day,
      tmax: g('temperature_2m_max', i), tmean: g('temperature_2m_mean', i),
      tmin: g('temperature_2m_min', i),
      wmean: g('wind_speed_10m_mean', i), wmax: g('wind_speed_10m_max', i),
      hmean: g('relative_humidity_2m_mean', i), hmin: g('relative_humidity_2m_min', i),
      rain: g('precipitation_sum', i),
      // 응답은 초 단위다. 보기 위해 시간으로만 바꾼다(값을 손대는 게 아니다).
      sun: g('sunshine_duration', i) == null ? null
        : Math.round((g('sunshine_duration', i) / 3600) * 100) / 100,
    }));
    return { ts: Date.now(), days: rows, units: d.daily_units || null };
  } catch (e) {
    console.warn('[korea] history fail:', city.ko, e);
    return { ts: Date.now(), error: (e && e.message) || String(e), days: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 서버 경유 기상특보. 키가 없으면 status='no_key' 가 온다(정상 흐름). */
async function kwFetchAlert(city, days) {
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
  try {
    const res = await fetch('/api/kma-alert?region=' + encodeURIComponent(city.ko)
      + '&days=' + days, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return { ts: Date.now(), status: d.status || 'error', bands: d.bands || [],
      reason: d.reason, stnExact: d.stn_exact, stnId: d.stnId };
  } catch (e) {
    console.warn('[korea] alert fail:', city.ko, e);
    return { ts: Date.now(), status: 'error', bands: [], reason: (e && e.message) || String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 그래프용 데이터 확보 (TTL 지났을 때만 새로 받는다) */
async function kwLoad(city, force) {
  const k = kwKey(city);
  if (!city || _kwBusy[k]) return;
  const stale = (c) => !c || (Date.now() - c.ts) > KW_TTL;
  if (!force && !stale(_kwHist[k]) && !stale(_kwAlert[k])) return;
  _kwBusy[k] = true;
  if (_krOn) renderKorea();
  const [h, a] = await Promise.all([
    (force || stale(_kwHist[k])) ? kwFetchHist(city, _kwRange) : Promise.resolve(_kwHist[k]),
    (force || stale(_kwAlert[k])) ? kwFetchAlert(city, _kwRange) : Promise.resolve(_kwAlert[k]),
  ]);
  _kwHist[k] = h;
  _kwAlert[k] = a;
  _kwBusy[k] = false;
  if (_krOn) renderKorea();
}

/** 이 그래프가 받을 특보만 골라 낸다(group 이 같은 것) */
function kwBandsFor(alert, group) {
  if (!alert || alert.status !== 'ok') return [];
  return (alert.bands || []).filter((b) => b.group === group);
}

/** 그래프 하나. cfg = {days, series, unit, group, alert, right, bars} */
function kwChart(cfg) {
  const rows = cfg.days || [];
  const n = rows.length;
  if (n < 2) return '<div class="kw-empty">추이를 그릴 값이 부족합니다.</div>';

  const vals = [];
  cfg.series.forEach((s) => rows.forEach((r) => { if (r[s.key] != null) vals.push(r[s.key]); }));
  if (!vals.length) return '<div class="kw-empty">값이 없습니다.</div>';
  let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (cfg.zeroBase) lo = Math.min(0, lo);
  const pad = (hi - lo) * 0.18 || 1;
  lo -= pad; hi += pad;

  const hasRight = !!cfg.right;
  const W = 360, H = 178, padL = 34, padR = hasRight ? 30 : 10, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - lo) / ((hi - lo) || 1)) * plotH;

  // 오른쪽 축 스케일 (일조시간 또는 특보 0/1)
  let RY = null, rLo = 0, rHi = 1;
  if (hasRight) {
    if (cfg.right.key) {
      const rv = rows.map((r) => r[cfg.right.key]).filter((v) => v != null);
      rLo = 0; rHi = rv.length ? Math.max.apply(null, rv) * 1.15 || 1 : 1;
    }
    RY = (v) => padT + (1 - (v - rLo) / ((rHi - rLo) || 1)) * plotH;
  }

  const grid = vizYFractions().map((t) => {
    const val = lo + (hi - lo) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 4}" y="${(y + 2.6).toFixed(1)}" text-anchor="end" font-size="7.5" fill="var(--muted)">${krNum(val, (hi - lo) < 6 ? 1 : 0)}</text>`;
  }).join('');

  const rAxis = hasRight ? vizYFractions().map((t) => {
    const val = rLo + (rHi - rLo) * t;
    const y = RY(val);
    const txt = cfg.right.key ? krNum(val, rHi < 6 ? 1 : 0) : (val >= 0.5 ? '있음' : '없음');
    return `<text x="${padL + plotW + 4}" y="${(y + 2.6).toFixed(1)}" text-anchor="start" font-size="7.5" fill="${escapeHtml(cfg.right.color || 'var(--muted)')}">${escapeHtml(txt)}</text>`;
  }).join('') : '';

  // 특보 음영 — 날짜가 이 창 안에 있을 때만
  const idxOf = {};
  rows.forEach((r, i) => { idxOf[r.day] = i; });
  const bw = plotW / Math.max(1, n - 1);
  const bands = (cfg.bands || []).map((b) => {
    const i = idxOf[b.from];
    if (i == null) return '';
    const c = KW_ALERT_COLORS[b.kind] || 'var(--slate)';
    const x = X(i) - bw / 2;
    return `<rect x="${Math.max(padL, x).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}"`
      + ` fill="${c}" opacity="${b.level === '경보' ? '.22' : '.12'}"/>`;
  }).join('');

  // 막대(강수) → 선보다 먼저 그린다
  const barsHtml = (cfg.bars || []).map((s) => rows.map((r, i) => {
    const v = r[s.key];
    if (v == null || v <= 0) return '';
    const y = Y(v), y0 = Y(Math.max(lo, 0));
    const w = Math.max(1.2, bw * 0.62);
    return `<rect x="${(X(i) - w / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}"`
      + ` height="${Math.max(0.6, y0 - y).toFixed(1)}" fill="${s.color}" opacity=".85"/>`;
  }).join('')).join('');

  const lines = cfg.series.filter((s) => !s.bar).map((s) => {
    const pts = rows.map((r, i) => (r[s.key] == null ? null : X(i).toFixed(1) + ',' + Y(r[s.key]).toFixed(1)))
      .filter(Boolean).join(' ');
    if (!pts) return '';
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.4}"`
      + (s.dash ? ` stroke-dasharray="${s.dash}"` : '') + ' stroke-linejoin="round"/>';
  }).join('');

  // 오른쪽 축 계열(일조시간)
  const rLine = (hasRight && cfg.right.key) ? (() => {
    const pts = rows.map((r, i) => (r[cfg.right.key] == null ? null
      : X(i).toFixed(1) + ',' + RY(r[cfg.right.key]).toFixed(1))).filter(Boolean).join(' ');
    return pts ? `<polyline points="${pts}" fill="none" stroke="${cfg.right.color}" stroke-width="1.2" stroke-dasharray="3 2"/>` : '';
  })() : '';

  // 특보 유무 계단선(오른쪽 축이 특보일 때)
  const aStep = (hasRight && !cfg.right.key) ? (() => {
    const on = {};
    (cfg.bands || []).forEach((b) => { on[b.from] = true; });
    const pts = rows.map((r, i) => X(i).toFixed(1) + ',' + RY(on[r.day] ? 1 : 0).toFixed(1)).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${cfg.right.color}" stroke-width="1.1" opacity=".8"/>`;
  })() : '';

  const xlab = orTickIdx(n, 4).map((i) => {
    const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 14).toFixed(1)}" text-anchor="${anchor}" font-size="7.5" fill="var(--muted)">${escapeHtml(rows[i].day.slice(5).replace('-', '/'))}</text>`;
  }).join('');

  /* ── 툴팁 재료 ────────────────────────────────────────────────────────
     날짜별로 '무엇을 몇으로 보여줄지'를 지금 미리 만들어 둔다. 마우스가 움직일
     때마다 다시 계산하지 않게 하고, 값의 출처를 이 자리 하나로 모으기 위해서다.
     ★ 겹쳐 그린 선은 같은 날짜의 값을 한 번에 모아 보여 준다(기온 최고·평균·최저).
     ★ 오른쪽 축 계열(일조시간)도 같은 줄에 함께 넣는다. */
  const tipSeries = cfg.series.concat(
    (hasRight && cfg.right.key) ? [Object.assign({}, cfg.right, { isRight: true })] : []);
  const tipRows = rows.map((r, i) => ({
    day: r.day,
    x: X(i),
    vals: tipSeries.map((s) => ({
      label: s.label, color: s.color,
      txt: (r[s.key] == null) ? '—'
        : krNum(r[s.key], s.digits == null ? 1 : s.digits) + (s.unit ? ' ' + s.unit : ''),
      y: (r[s.key] == null) ? null : (s.isRight ? RY(r[s.key]) : Y(r[s.key])),
    })),
  }));
  const id = 'kw' + (_kwTipSeq += 1);
  _kwGeom[id] = { W: W, padL: padL, plotW: plotW, padT: padT, plotH: plotH,
    n: n, rows: tipRows };

  return `<svg class="kw-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ' data-kw-id="' + id + '"'
    + ' aria-label="' + escapeHtml(cfg.title || '추이') + '">'
    + bands + grid + rAxis + xlab + barsHtml + rLine + aStep + lines
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>`
    // 아래 셋은 덧그리기 전용 — 위 그림에는 손대지 않는다
    + `<line class="kw-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>`
    + '<g class="kw-hi"></g>'
    + `<rect class="kw-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>`
    + '</svg>';
}

/** 그래프 한 칸(제목 + 범례 + 그래프 + 특보 안내) */
function kwCard(cfg, alert) {
  const bands = kwBandsFor(alert, cfg.group);
  /* ★ 특보 보조축(오른쪽 '있음/없음')은 특보 데이터가 실제로 있을 때만 그린다.
     키가 없어 데이터가 없는데 축과 계단선을 그리면, 바닥에 붙은 평평한 선이
     마치 관측값인 것처럼 보인다 — 없는 걸 있는 것처럼 보이게 하지 않는다.
     (일조시간처럼 key 가 있는 보조축은 실제 값이므로 그대로 둔다) */
  if (cfg.right && !cfg.right.key && (!alert || alert.status !== 'ok')) {
    cfg = Object.assign({}, cfg);
    delete cfg.right;
  }
  const lg = cfg.series.concat(cfg.right && cfg.right.key
    ? [{ label: cfg.right.label + ' (우축)', color: cfg.right.color, dash: '3 2' }] : [])
    .map((s) => '<span class="kw-lg"><i style="background:' + escapeHtml(s.color) + '"></i>'
      + escapeHtml(s.label) + '</span>').join('');
  // 특보 안내 — 키가 없으면 그 사실을, 있으면 이 기간에 몇 건인지
  /* ★ 인증키가 없거나(no_key) 아직 받아 오는 중이면 아무 표시도 하지 않는다.
     (특보를 받아 오는 구조 자체는 그대로다 — 키가 생기면 아래 분기들이 살아난다) */
  let aNote = '';
  if (!alert || alert.status === 'no_key') {
    aNote = '';
  } else if (alert.status !== 'ok') {
    aNote = '<span class="kw-alertnote">특보 정보를 불러오지 못했습니다</span>';
  } else if (!bands.length) {
    aNote = '<span class="kw-alertnote">이 기간 해당 특보 없음</span>';
  } else {
    const kinds = bands.filter((b, i, a) => a.findIndex((x) => x.kind === b.kind) === i);
    aNote = '<span class="kw-alertnote">' + kinds.map((b) =>
      '<i class="kw-abox" style="background:' + (KW_ALERT_COLORS[b.kind] || 'var(--slate)') + '"></i>'
      + escapeHtml(b.kind)).join(' ') + ' ' + bands.length + '건' + '</span>';
  }
  return '<div class="kw-card"><div class="kw-h">' + escapeHtml(cfg.title)
    + ' <span class="kw-h__u">(' + escapeHtml(cfg.unit) + ')</span></div>'
    + '<div class="kw-lgs">' + lg + aNote + '</div>'
    // .kw-figure 는 툴팁을 이 그래프 안쪽에 띄우기 위한 기준 상자다
    + '<div class="kw-figure">' + kwChart(Object.assign({}, cfg, { bands: bands }))
    + '<div class="viz-tooltip kw-tip"></div></div>'
    + '</div>';
}

/** 과거 추이 4종 전체 */
function kwSectionHtml(city) {
  const k = kwKey(city);
  const h = _kwHist[k], a = _kwAlert[k];
  const chips = '<div class="icis-years kw-ranges">' + KW_RANGES.map((r) =>
    '<button type="button" class="icis-year kw-range' + (r.key === _kwRange ? ' is-active' : '')
    + '" data-kw-range="' + r.key + '">' + escapeHtml(r.label) + '</button>').join('') + '</div>';

  let body;
  if (_kwBusy[k] && !h) body = '<div class="kw-empty">추이를 불러오는 중…</div>';
  else if (!h) body = '<div class="kw-empty">추이를 불러오는 중…</div>';
  else if (h.error) body = '<div class="kw-empty">추이를 불러오지 못했습니다 (' + escapeHtml(h.error) + ')</div>';
  else {
    const D = h.days;
    body = '<div class="kw-grid">'
      + kwCard({
        title: '기온', unit: '℃', group: 'temp', days: D,
        series: [
          { key: 'tmax', label: '최고', color: '#EF4444', unit: '℃', digits: 1 },
          { key: 'tmean', label: '평균', color: '#111827', w: 1.7, unit: '℃', digits: 1 },
          { key: 'tmin', label: '최저', color: '#3B82F6', unit: '℃', digits: 1 },
        ],
        right: { label: '특보', color: '#9CA3AF' },   // key 없음 → 특보 0/1 보조축
      }, a)
      + kwCard({
        title: '풍속', unit: 'km/h', group: 'wind', days: D, zeroBase: true,
        series: [{ key: 'wmean', label: '평균풍속', color: '#7C3AED', w: 1.7, unit: 'km/h', digits: 1 }],
        right: { label: '특보', color: '#9CA3AF' },
      }, a)
      + kwCard({
        title: '습도', unit: '%', group: 'humid', days: D,
        series: [
          { key: 'hmean', label: '평균습도', color: '#0EA5E9', w: 1.7, unit: '%', digits: 0 },
          { key: 'hmin', label: '최저습도', color: '#F59E0B', unit: '%', digits: 0 },
        ],
        right: { label: '특보', color: '#9CA3AF' },
      }, a)
      + kwCard({
        title: '강수 · 일조', unit: 'mm · 시간', group: 'rain', days: D, zeroBase: true,
        series: [{ key: 'rain', label: '강수량', color: '#0284C7', bar: true, unit: 'mm', digits: 1 }],
        bars: [{ key: 'rain', color: '#0284C7' }],
        right: { key: 'sun', label: '일조시간', color: '#F59E0B', unit: '시간', digits: 1 },
      }, a)
      + '</div>';
  }

  const span = (h && h.days && h.days.length)
    ? h.days[0].day + ' ~ ' + h.days[h.days.length - 1].day : '';
  // 키가 없을 때(no_key)는 각주도 남기지 않는다. 그 밖의 상태 안내는 그대로 둔다.
  let aFoot = '';
  if (a && a.status === 'ok' && a.stnExact === false) {
    aFoot = '※ 이 도시의 특보구역 코드가 아직 등록되지 않아 전국(지점 '
      + (a.stnId || '108') + ') 기준으로 조회했습니다.';
  } else if (a && a.status === 'error') {
    aFoot = '※ 특보 조회 실패' + (a.reason ? ' (' + a.reason + ')' : '') + '.';
  }

  return '<div class="kw-wrap"><h4 class="kr-h">과거 추이 '
    + '<span class="kr-h__s">' + escapeHtml(span ? '최근 ' + _kwRange + '일 · ' + span : '') + '</span>'
    + '</h4>' + chips + body
    + '<div class="kr-note">과거값 출처: Open-Meteo Historical Weather API (응답 값 그대로 · '
    + '일조시간만 초→시간 변환) · 특보: 기상청 기상특보 조회서비스(공공데이터포털)</div>'
    + (aFoot ? '<div class="kr-note">' + escapeHtml(aFoot) + '</div>' : '')
    + '</div>';
}

/* ── 그래프 툴팁 ──────────────────────────────────────────────────────────
   ★ 차트 라이브러리가 없다(SVG 를 직접 그린다). 그래서 KOIMA 일일가격·환율
     카드가 쓰는 방식을 그대로 가져왔다 — 투명 overlay 위에서 x 좌표를 날짜
     번호로 바꾸고, 그 날짜의 값을 한 상자에 모아 보여 준다.
   ★ 마우스(hover)와 손가락(탭) 모두 같은 함수를 탄다. */
function kwTipAt(fig, clientX) {
  const svg = fig.querySelector('.kw-svg');
  const tip = fig.querySelector('.kw-tip');
  const g = svg && _kwGeom[svg.dataset.kwId];
  if (!svg || !tip || !g) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return;
  // 화면 픽셀 → viewBox 좌표 → 가장 가까운 날짜 번호
  const sx = (clientX - rect.left) * (g.W / rect.width);
  let i = (g.n === 1) ? 0
    : Math.round(((sx - g.padL) / (g.plotW || 1)) * (g.n - 1));
  i = Math.max(0, Math.min(g.n - 1, i));
  const row = g.rows[i];
  if (!row) return;

  const cross = svg.querySelector('.kw-cross');
  const hi = svg.querySelector('.kw-hi');
  if (cross) {
    cross.setAttribute('x1', row.x.toFixed(1));
    cross.setAttribute('x2', row.x.toFixed(1));
    cross.style.opacity = '1';
  }
  if (hi) {
    hi.innerHTML = row.vals.filter((v) => v.y != null).map((v) =>
      '<circle cx="' + row.x.toFixed(1) + '" cy="' + v.y.toFixed(1)
      + '" r="3" fill="' + v.color + '" stroke="var(--card)" stroke-width="1.5"/>').join('');
  }
  tip.innerHTML = '<div class="viz-tooltip__date">' + escapeHtml(row.day) + '</div>'
    + row.vals.map((v) => '<div class="viz-tt-row">'
      + '<span class="viz-tt-swatch" style="background:' + v.color + '"></span>'
      + '<span>' + escapeHtml(v.label) + '</span>'
      + '<span class="viz-tt-val">' + escapeHtml(v.txt) + '</span></div>').join('');

  // 그래프 안쪽에 띄운다 — 오른쪽 끝에서는 왼쪽으로 붙인다
  const fr = fig.getBoundingClientRect();
  let left = (row.x / g.W) * rect.width + (rect.left - fr.left) + 12;
  if (left + tip.offsetWidth > fr.width) left = left - tip.offsetWidth - 24;
  tip.style.left = Math.max(2, left).toFixed(0) + 'px';
  tip.style.top = '6px';
  tip.classList.add('is-visible');
}

/** 툴팁 감추기 */
function kwTipHide(fig) {
  const tip = fig.querySelector('.kw-tip');
  const svg = fig.querySelector('.kw-svg');
  if (tip) tip.classList.remove('is-visible');
  if (svg) {
    const cross = svg.querySelector('.kw-cross');
    const hi = svg.querySelector('.kw-hi');
    if (cross) cross.style.opacity = '0';
    if (hi) hi.innerHTML = '';
  }
}

/** 한국 상세 화면 전체 */
function renderKorea() {
  const root = document.getElementById('worldclockRoot');
  if (!root) return;
  const city = KR_CITIES[_krCity] || KR_CITIES[0];
  const wx = _krWx[city.ko], nw = _krNews[city.ko];
  const busy = !!_krBusy[city.ko];
  const now = new Date();
  const p = wcParts('Asia/Seoul', now);
  const stamp = `${p.year}-${p.month}-${p.day} ${String(p.h).padStart(2, '0')}:${p.minute}`;

  const pins = KR_CITIES.map((c, i) => {
    const q = krXY(c.lat, c.lon);
    return `<button type="button" class="kr-pin${i === _krCity ? ' is-on' : ''}" data-kr-city="${i}"
        style="left:${q.x.toFixed(2)}%;top:${q.y.toFixed(2)}%" aria-label="${escapeHtml(c.ko)}"
        aria-pressed="${i === _krCity ? 'true' : 'false'}">
        <span class="kr-pin__d"></span><span class="kr-pin__n">${escapeHtml(c.ko)}</span></button>`;
  }).join('');

  // 상세 패널 왼쪽의 '작은 지도' — 같은 지도를 쓰고 고른 도시에만 핀을 찍는다
  const mini = krXY(city.lat, city.lon);
  const miniMap = `<div class="kr-mini">
      <img class="kr-mini__img" src="public/maps/korea.svg" alt="" aria-hidden="true">
      <span class="kr-mini__pin" style="left:${mini.x.toFixed(2)}%;top:${mini.y.toFixed(2)}%"></span>
    </div>`;

  root.innerHTML = `
    <div class="kr-bar">
      <button type="button" class="kr-back" data-kr-back="1">‹ 세계 시간으로 돌아가기</button>
      <span class="kr-bar__t">대한민국 주요 도시 날씨</span>
      <button type="button" class="oc-tool kr-refresh" data-kr-refresh="1"${busy ? ' disabled' : ''}>${busy ? '불러오는 중…' : '↻ 새로 고침'}</button>
    </div>
    <div class="kr-wrap">
      <div class="kr-mapbox">
        <img class="kr-map__img" src="public/maps/korea.svg" alt="대한민국 지도" >
        <div class="kr-pins">${pins}</div>
      </div>
      <div class="kr-panel">
        <div class="kr-phead">
          <span class="kr-phead__c">${escapeHtml(city.ko)}</span>
          <span class="kr-phead__t">${escapeHtml(stamp)} 발표 기준</span>
        </div>
        <div class="kr-pbody">
          ${miniMap}
          <div class="kr-pinfo">${krNowHtml(city, wx)}</div>
        </div>
        <h4 class="kr-h">오늘 · 내일 · 모레 예보</h4>
        ${krForecastHtml(wx)}
        ${kwSectionHtml(city)}
        <h4 class="kr-h">주요 날씨 이슈 <span class="kr-h__s">(${escapeHtml(city.ko)} 관련 최근 기사)</span></h4>
        ${krNewsHtml(city, nw)}
      </div>
    </div>
    <div class="comp-caption">날씨: Open-Meteo · 뉴스: Google 뉴스 검색 · ${escapeHtml(KR_MAP_SRC)}</div>`;
  krWire();
}

/** 한국 화면 배선 — 도시 핀 / 돌아가기 / 새로 고침 */
function krWire() {
  if (_krWired) return;
  const root = document.getElementById('worldclockRoot');
  if (!root) return;
  _krWired = true;
  /* 그래프 툴팁 — root 에 한 번만 건다(다시 그려도 overlay 가 새로 생기므로
     각 그래프에 직접 걸면 리스너가 쌓인다).
     ★ 손가락도 같은 함수를 탄다. touchmove 에서 preventDefault 를 하지 않아
       페이지 스크롤은 그대로 된다. */
  const figOf = (e) => e.target.closest && e.target.closest('.kw-figure');
  root.addEventListener('mousemove', (e) => {
    const fig = figOf(e); if (fig) kwTipAt(fig, e.clientX);
  });
  root.addEventListener('mouseleave', (e) => {
    const fig = figOf(e); if (fig) kwTipHide(fig);
  }, true);
  root.addEventListener('mouseout', (e) => {
    const fig = figOf(e);
    if (fig && !fig.contains(e.relatedTarget)) kwTipHide(fig);
  });
  root.addEventListener('touchstart', (e) => {
    const fig = figOf(e);
    if (fig && e.touches && e.touches[0]) kwTipAt(fig, e.touches[0].clientX);
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    const fig = figOf(e);
    if (fig && e.touches && e.touches[0]) kwTipAt(fig, e.touches[0].clientX);
  }, { passive: true });
  root.addEventListener('click', (e) => {
    const fig = figOf(e); if (fig) kwTipAt(fig, e.clientX);   // 클릭으로도 뜬다
    const back = e.target.closest && e.target.closest('[data-kr-back]');
    if (back) { krClose(); return; }
    const rf = e.target.closest && e.target.closest('[data-kr-refresh]');
    if (rf) { krLoad(_krCity, true); kwLoad(KR_CITIES[_krCity], true); return; }
    const rg = e.target.closest && e.target.closest('[data-kw-range]');
    if (rg) {                                  // 기간 버튼 — 추이만 다시 받는다
      _kwRange = +rg.dataset.kwRange;
      renderKorea();
      kwLoad(KR_CITIES[_krCity], false);
      return;
    }
    const pin = e.target.closest && e.target.closest('[data-kr-city]');
    if (!pin) return;
    _krCity = +pin.dataset.krCity;
    renderKorea();
    krLoad(_krCity, false);   // 도시를 고를 때마다 최신인지 확인하고 필요하면 새로 받는다
    kwLoad(KR_CITIES[_krCity], false);
  });
}

/** 서울 마커에서 진입 */
function krOpen() {
  _krOn = true;
  _krCity = 0;
  wcHideTip();
  _wcOpen = null;
  renderKorea();
  krLoad(_krCity, false);
  kwLoad(KR_CITIES[_krCity], false);
}

/** 세계 시간으로 복귀 — 기존 렌더 함수를 그대로 부른다(세계지도 로직 미변경) */
function krClose() {
  _krOn = false;
  renderWorldClock();
}

/** [업데이트]에 연결: Open-Meteo로 18개 도시 날씨 1회 요청 → 마커 표시.
 *  실패해도 마커·시계는 뜨고 기온만 '—'. */
async function updateWorldWeather() {
  // 먼저 마커부터 표시(시계 동작 보장). 날씨는 도착하면 채우고, 실패/지연이면 '—' 유지
  _wcShown = true;
  _wcWeather = null;
  if (!_krOn) renderWorldClock();   // 한국 상세 화면을 보고 있으면 그대로 둔다
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;  // 지연 방어(무한 대기 방지)
  try {
    const lat = WORLD_CITIES.map((c) => c.lat).join(',');
    const lon = WORLD_CITIES.map((c) => c.lon).join(',');
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`;  // 15개 1회 요청
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [data];  // 다중 좌표 → 배열(도시 순서와 매칭)
    _wcWeather = WORLD_CITIES.map((c, i) => {
      const cur = arr[i] && arr[i].current;
      return cur ? { temp: cur.temperature_2m, code: cur.weather_code } : null;
    });
  } catch (e) {  // 날씨 실패해도 시계는 동작(기온 '—')
    console.warn('[worldclock] weather fail:', e);
    _wcWeather = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!_krOn) renderWorldClock();  // 날씨 반영해 재렌더(실패 시 '—'). 한국 화면 중이면 유지
}

/** [초기화]: 마커 제거하고 회색 지도 + 안내 상태로 */
function resetWorldClock() {
  _krOn = false;        // 한국 상세 화면도 닫는다
  _wcShown = false;
  _wcWeather = null;
  _wcOpen = null;
  document.removeEventListener('click', wcOutside);
  renderWorldClock();
}

/** 세계 시간 초기화: 지도 렌더 + 30초 인터벌(중복 방지 위해 기존 타이머 정리 후 재설정) */
function initWorldClock() {
  renderWorldClock();
  if (_wcTimer) clearInterval(_wcTimer);  // useEffect 정리(cleanup) 대응 — 중복 인터벌 방지
  _wcTimer = setInterval(wcTick, 30000);  // 30초마다 시각 갱신(분 단위만 표시)
}

/** 데이터 변경 시 데이터 의존 섹션 재렌더 */
function refreshSections() {
  renderSimmonsNews();
  renderInstagram();      // 순수 추가: SIMMONS IG (소식 카드 바로 아래)
  renderCompetitor();
  renderBrands();
  renderPatent();         // ★ 빠져 있었다 — 초기화해도 특허 카드가 그대로 남았다
  renderMaterial();
  renderFx();
  updateDashHeader();
}

/** 대시보드 헤더의 "마지막 업데이트" 표시.
 *  자동 날짜를 넣지 않는다 — [업데이트] 전에는 항상 미갱신("—") 상태로 둔다. */
function updateDashHeader() {
  /* no-op: 업데이트 시각은 [업데이트] 버튼 핸들러에서만 설정한다 */
}

/* ============================================================
   초기화
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initUpload();
  initReport();
  initUpdate();
  // 로드 시 항상 "초기 상태(데이터 없음)"로 시작한다.
  // 저장된 값/기본 CSV를 자동으로 불러오지 않는다 — 데이터는 오직 [업데이트]로만 채운다.
  refreshSections(); // 빈 STORE → 모든 섹션 "준비중" 빈 상태
  initWorldClock();  // 세계 시간: 업데이트와 무관하게 로드 즉시 실시간 표시
});

/** 보고서 다운로드: 브라우저 인쇄(→ PDF로 저장) */
function initReport() {
  const btn = document.getElementById('reportBtn');
  if (btn) btn.addEventListener('click', () => window.print());
}

/* ============================================================
   실시간 업데이트 — 백엔드 /api/update
   서버(python dashboard_server.py) 실행 중일 때만 동작.
   ============================================================ */



/** API 기본 경로 — 상대경로('/api/update')로 호출한다.
 *  같은 출처에서 서빙되므로(로컬: dashboard_server.py, 배포: Vercel) 절대주소가 필요 없다. */
const API_BASE = '';

/** [초기화] 버튼: 서버 호출 없이 화면 상태만 처음(준비중)으로 되돌린다 */
function resetDashboard() {
  if (!window.confirm('초기화할까요?')) return;
  // 업데이트/기본값으로 채워졌던 모든 섹션 데이터 제거 → 각 섹션 "준비중" 빈 상태
  Object.keys(STORE).forEach((k) => delete STORE[k]);
  _simmonsNews = null;  // 시몬스 코리아 소식 비우기
  _igData = null;       // SIMMONS IG 비우기
  _matReady = false; _matYear = null; _matUsdKrw = null; // 원자재: 업데이트 전 초기 상태
  _msData = null;       // 시황 해설(배지·변곡점·요인) 비우기
  _iiData = null;       // ICIS 6단 패널(변동요인·타임라인·시사점) 비우기
  _sriData = null;      // 해상 정시성 5단 패널 비우기
  _xsiData = null; _xsiRoute = null; _xsiRange = null; _xsiChart = null;  // 운임지수 비우기
  _xsiiData = null;     // 운임지수 4단 해설 비우기
  _oilIns = null;       // 국제유가 인사이트 비우기
  _oilpIns = null;      // 석유제품 인사이트 비우기
  _icisForecast = null; // 순수 추가: 예측 초기화(섹션 숨김)
  _srData = null; _srYear = null; _srChart = null; // 해상 정시성 비우기
  _srForecast = null; // 순수 추가: 정시성 예측 초기화(섹션 숨김)
  _ocData = null; _ocForm = null; _ocQuery = null; _ocView = 'table'; _oilChart = null; // 국제유가(원유) 비우기
  _opData = null; _opForm = null; _opQuery = null; _opView = 'table'; _opChart = null; // 국제유가(제품) 비우기
  // 순수 추가: KOIMA 부문별 지수 → 1단계(데이터 없음)로 복귀
  _koimaData = null; _koimaCat = null; _koimaEnd = null; _koimaRange = null; _koimaChart = null;
  // 순수 추가: KOIMA 일일 국제원자재가격 → 1단계로 복귀
  _kpData = null; _kpCat = null; _kpItem = null; _kpRange = null; _kpChart = null; _kpBusy = false;
  _domestic = null; _domesticFeatured = null;       // 국내 브랜드 비우기
  _globalBrands = null; _globalFeatured = null;     // 국외 브랜드 비우기
  _competitors = null;      // 경쟁사(국외 SEC) 데이터 비우기
  /* ★ 여기까지만 비우면 화면에 데이터가 남는다 — 국내 실적·해외 슬립테크·
     글로벌 매트리스·특허는 정적 JSON 에서 온 별도 상태라 STORE 를 지워도
     그대로 남아 있었다. 초기화는 '화면이 비는 것'까지가 초기화다. */
  _smData = null;           // 국내 시몬스·경쟁사 실적·점유율 비우기
  _gsData = null;           // 해외 슬립테크 시장·기업 비우기
  _gmm = null;              // 글로벌 매트리스 시장 규모 비우기
  _ptData = null;           // KIPRIS 특허 비우기
  _sideView = null;         // 분기 실적 탭 미선택으로
  _brandSide = 'kr';        // 신제품·브랜드는 기본(국내)으로
  _fx = null;           // 환율 비우기
  _fxa = null;          // 환율 현황 카드·AI 해석 비우기(카드가 남아 있으면 초기화가 아니다)
  _fxChart = null;      // 환율 추이 차트 캐시 비우기
  _fxCur = null;        // 선택 통화(배열) 미선택으로 리셋
  _fxMonths = null;     // 환율 추이 기간 미선택 상태로 리셋
  _fxReport = false;    // 환율 리포트 접기
  // "마지막 업데이트" 텍스트 되돌리기
  const lbl = document.getElementById('lastUpdated');
  if (lbl) lbl.textContent = '아직 업데이트하지 않았습니다';
  const dashUpd = document.getElementById('dashUpdated');
  if (dashUpd) dashUpd.textContent = '—';
  resetWorldClock();  // 세계 시간: 마커 제거 → 회색 지도 + 안내
  // 원자재·시장·경쟁사·뉴스 재렌더(빈 STORE → emptyState/데이터 부족)
  refreshSections();
}

/* ── 데이터 로드: 사전 수집 JSON 우선, 실패 시 실시간 수집으로 폴백 ──────────
   GitHub Actions 가 매일 새벽 public/data/dashboard.json 을 만들어 커밋한다.
   그 파일을 읽으면 즉시 완료된다(콜드 수집은 약 30초).
   파일이 없거나 못 읽으면 종전처럼 /api/update 가 직접 수집한다(로컬 개발 등). */
const DASH_DATA_URL = 'public/data/dashboard.json';

/** {data, source:'static'|'live'} 반환. 둘 다 실패하면 throw. */
async function fetchDashboardData() {
  try {
    const r = await fetch(DASH_DATA_URL, { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      if (d && d.sections && Object.keys(d.sections).length) {
        console.log('[update] 사전 수집 데이터 사용:', d.updated_at);
        return { data: d, source: 'static' };
      }
      console.warn('[update] 사전 수집 파일이 비어 있음 → 실시간 수집으로 폴백');
    } else if (r.status !== 404) {
      console.warn('[update] 사전 수집 파일 HTTP', r.status, '→ 실시간 수집으로 폴백');
    }
  } catch (e) {
    console.warn('[update] 사전 수집 파일 읽기 실패 → 실시간 수집으로 폴백:', e);
  }
  const res = await fetch(API_BASE + '/api/update', { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { data: await res.json(), source: 'live' };
}

/** 순수 추가: /api/update 응답에서 '건너뜀(캐시)'·'실패' 섹션을 요약한 문구.
 *  사용자가 "안 돈 것"과 "이미 최신이라 건너뛴 것"을 구분할 수 있게 한다. */
function updateStatusNote(data) {
  const secs = (data && data.sections) || {};
  const skipped = [], failed = [];
  Object.keys(secs).forEach((k) => {
    const v = secs[k];
    if (!v || typeof v !== 'object') return;
    if (v.cached) skipped.push(SECTION_LABELS[k] || k);
    else if (v.status && v.status !== 'ok') failed.push(SECTION_LABELS[k] || k);
  });
  if (skipped.length) console.log('[update] 건너뜀(캐시 재사용):', skipped.join(', '));
  if (failed.length) console.warn('[update] 수집 실패:', failed.join(', '));
  let s = '';
  if (skipped.length) s += ` · 건너뜀 ${skipped.length}건(${skipped.join(', ')})`;
  if (failed.length) s += ` · 실패 ${failed.length}건(${failed.join(', ')})`;
  return s;
}

/** 섹션 키 → 사람이 읽는 이름(위 문구 전용) */
const SECTION_LABELS = {
  simmons_news: '시몬스 소식', usd_krw: '환율(USD)', schedule_reliability: '해상 정시성',
  oil_crude: '국제유가(원유)', oil_product: '국제유가(제품)', domestic: '국내 브랜드', global_brands: '국외 브랜드',
  competitors: '경쟁사 실적', fx: '환율', icis_forecast: '주원료 예측',
  sr_forecast: '정시성 예측', koima_index: 'KOIMA 월간지수',
  us_ppi: '미국 매트리스 PPI',
};

/** [업데이트] 버튼: /api/update 호출 → 마지막 업데이트 시각 + 원자재 섹션 갱신 */
function initUpdate() {
  const btn = document.getElementById('updateBtn');
  const lbl = document.getElementById('lastUpdated');
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) clearBtn.addEventListener('click', resetDashboard);
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '불러오는 중…';
    /* ★ 업데이트 직후에는 탭만 보이고 콘텐츠는 비운다 — 어느 쪽을 볼지는
       사용자가 고른다(자동 선택하지 않는다). */
    _sideView = null;
    updateWorldWeather();  // 세계 시간: Open-Meteo 날씨(서버 /api/update와 독립) → 마커 표시
    // 순수 추가: KOIMA 일일가격 — 미리 수집해 둔 정적 JSON 로드(즉시 완료).
    // await 하지 않는다 — 다른 카드가 이 로드를 기다리지 않게 한다.
    fetchKoimaPrice();
    // 순수 추가: 국내 실적·점유율 정적 JSON. await 하지 않는다 —
    // 다른 카드가 이 로드를 기다리지 않게 하고, 끝나면 스스로 다시 그린다.
    fetchSimmonsMarket();
    // 순수 추가: 국외 해외 슬립테크 시장·기업 정적 JSON (위와 같은 이유로 await 안 한다)
    fetchGlobalSleepTech();
    // 순수 추가: 글로벌 매트리스 시장 규모 — 월 1회 수집해 둔 캐시를 읽는다.
    fetchMattressMarket();
    // 순수 추가: KIPRIS 특허 — 하루 1회 수집해 둔 정적 JSON (위와 같은 이유로 await 안 한다)
    fetchPatents();
    // 순수 추가: 환율 현황 카드 + AI 해석 — 하루 1회 수집해 둔 정적 JSON.
    // await 하지 않는다(다른 카드가 기다리지 않게). 실패하면 카드는 실시간
    // 시세로 그려지고 해석 자리만 이유를 띄운다 — 섹션이 비지는 않는다.
    fetchFxAnalysis();
    // 순수 추가: SIMMONS IG — 커밋된 instagram.json 을 읽는다(Apify 호출 없음).
    // await 하지 않는다 — 다른 카드가 이 로드를 기다리지 않게 한다.
    fetchInstagram();
    // 순수 추가: 시황 해설(구조적·단기 요인 + 변곡점). 위와 같은 이유로 await 안 한다.
    fetchInsights();
    // 순수 추가: ICIS 6단 패널(변동요인·타임라인·시사점). 위와 같은 이유로 await 안 한다.
    fetchIcisInsights();
    // 순수 추가: 해상 정시성 5단 패널. 위와 같은 이유로 await 안 한다.
    fetchSrInsights();
    // 순수 추가: 컨테이너 운임지수(XSI-C). 미리 수집해 둔 정적 JSON 이라 즉시 끝난다.
    // ★ 갱신 뒤에도 항로는 다시 고르게 한다 — 새로 받은 값이 '고르지도 않았는데'
    //   떠 있는 일이 없도록 선택을 비우고 시작한다.
    _xsiRoute = null; _xsiRange = null; _xsiChart = null;
    fetchXsi();
    // ★ KOIMA 부문별 지수도 같은 규칙 — 갱신 뒤에도 부문을 다시 고르게 한다.
    //   (applyKoimaUpdate 에서도 비우지만, 응답이 늦거나 실패해도 이전 선택이
    //    남아 데이터가 떠 있지 않도록 누른 시점에 먼저 비운다)
    _koimaCat = null; _koimaEnd = null; _koimaRange = null; _koimaChart = null;
    // 순수 추가: 운임지수 4단 해설(구간·요인·전망·전략). 위와 같은 이유로 await 안 한다.
    fetchXsiInsights();
    // 순수 추가: 국제유가 인사이트(구간·요인·시나리오·시사점). 위와 같은 이유로 await 안 한다.
    fetchOilInsights();
    // 순수 추가: 석유제품 인사이트. 위와 같은 이유로 await 안 한다.
    fetchOilpInsights();
    // 순수 추가: KOIMA 부문별 지수 해설(부문별 변동요인·시사점). 위와 같은 이유로 await 안 한다.
    fetchKoimaInsights();
    // 순수 추가: 일일 국제원자재가격 해설(품목별 변동요인·시사점). 위와 같은 이유로 await 안 한다.
    fetchKpInsights();
    try {
      const { data, source } = await fetchDashboardData();
      // 순수 추가: 데이터 출처(사전 수집/실시간) + 캐시로 '건너뛴'·'실패한' 수집기를
      // 기존 라벨 뒤에 덧붙인다. (레이아웃은 그대로 — 문구만 늘린다)
      if (lbl && data.updated_at) lbl.textContent = '마지막 업데이트: ' + data.updated_at
        + (source === 'static' ? ' (사전 수집)' : '') + updateStatusNote(data);
      const dashUpd = document.getElementById('dashUpdated');
      if (dashUpd && data.updated_at) dashUpd.textContent = data.updated_at;
      applyFxUpdate(data);
      applyMaterialUpdate(data);
      applyKoimaUpdate(data);  // 순수 추가: KOIMA 부문별 지수(반드시 applyMaterialUpdate 뒤)
      applySimmonsNewsUpdate(data);
      applyDomesticUpdate(data);
      applyGlobalBrandsUpdate(data);
      applyCompetitorsUpdate(data);
    } catch (e) {
      if (lbl) lbl.textContent = '업데이트 실패 — 서버 실행을 확인하세요 (' + (e.message || e) + ')';
      console.warn('[update] 실패:', e);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
}


/* ══ 특허 · 신소재 동향 (KIPRIS) ═════════════════════════════════════════
   public/data/kipris-patents.json — kipris_patent.py 가 하루 1회 수집한다.
   ★ 화면에서 KIPRIS API 를 직접 부르지 않는다(무료 티어 월 1,000회).
   ★★ 집계는 여기 한 곳에서만 한다. 기간 필터가 화면에 있으므로 수집기에
     같은 집계를 두면 두 곳이 어긋난다 — 수집기는 '행'만 준다.
   ★★★ 실패를 조용히 넘기지 않는다. 수집기가 남긴 resultCode/resultMsg 를
     화면에 그대로 띄워 '왜 비었는지'를 말한다. */
const PT_DATA_URL = 'public/data/kipris-patents.json';
let _ptData = null;          // {status:'ok'|'error', rows:[…], …}
let _ptFrom = '';           // 기간 필터(YYYY-MM-DD). 빈 값이면 기본 기간
let _ptTo = '';
/* ── 교차 필터 ────────────────────────────────────────────────────────────
   ★ 차트는 '고르는 곳', 아래 목록은 '결과를 보는 곳'으로 나눈다.
     차트까지 필터를 반영하면 등록을 고른 순간 도넛이 등록 100% 가 되어
     다른 유형을 다시 고를 수 없다 — 차트는 기간 안 전체를 계속 보여 준다.
   ★★ 네 축을 동시에 걸 수 있다(예: 2023년 + 등록). 서로 다른 성질이라
     한 번에 하나만 허용할 이유가 없다. */
let _ptCo = '';           // 출원인
let _ptKind = '';         // 출원 유형(등록·공개…)
let _ptYear = '';         // 연도
let _ptCat = '';          // 기술 분야(catLabel)
let _ptPage = 1;          // 목록 페이지(1부터)
const PT_PAGE_SIZE = 20;  // 한 페이지에 보여 줄 건수

/** 지금 걸린 필터 목록 — 안내줄과 해제 버튼이 이것을 읽는다. */
function ptActiveFilters() {
  const out = [];
  if (_ptYear) out.push({ k: 'year', v: _ptYear, label: _ptYear + '년' });
  if (_ptKind) out.push({ k: 'kind', v: _ptKind, label: _ptKind });
  if (_ptCat) out.push({ k: 'cat', v: _ptCat, label: _ptCat });
  if (_ptCo) out.push({ k: 'co', v: _ptCo, label: _ptCo });
  return out;
}

/** 걸린 필터를 모두 통과한 행만 남긴다. */
function ptApplyFilters(rows) {
  return rows.filter((r) => {
    if (_ptYear && String(r.date || '').slice(0, 4) !== _ptYear) return false;
    if (_ptKind && (r.kind || '미표기') !== _ptKind) return false;
    if (_ptCat && (r.catLabel || '기타/미분류') !== _ptCat) return false;
    if (_ptCo && (r.company || '미표기') !== _ptCo) return false;
    return true;
  });
}

/** 필터 하나를 켜고 끈다(같은 값을 다시 누르면 해제). */
function ptToggleFilter(kind, value) {
  const v = String(value || '');
  if (kind === 'year') _ptYear = (_ptYear === v) ? '' : v;
  else if (kind === 'kind') _ptKind = (_ptKind === v) ? '' : v;
  else if (kind === 'cat') _ptCat = (_ptCat === v) ? '' : v;
  else if (kind === 'co') _ptCo = (_ptCo === v) ? '' : v;
  _ptPage = 1;              // 조건이 바뀌면 첫 페이지부터
  renderPatent();
}

function ptClearFilters() {
  _ptCo = ''; _ptKind = ''; _ptYear = ''; _ptCat = '';
  _ptPage = 1;
  renderPatent();
}

/** 2자리 국가코드 → ISO_LONLAT 이 쓰는 3자리 코드.
 *  ★ EP(유럽특허청)·WO(WIPO)는 나라가 아니라 지도에 찍지 않는다 — 아래 목록으로 뺀다. */
const PT_ISO2 = {
  KR: 'KOR', US: 'USA', JP: 'JPN', CN: 'CHN', DE: 'DEU', GB: 'GBR', FR: 'FRA',
  CA: 'CAN', AU: 'AUS', IN: 'IND', TW: 'TWN', RU: 'RUS', BR: 'BRA', IT: 'ITA',
  ES: 'ESP', NL: 'NLD', SE: 'SWE', CH: 'CHE', AT: 'AUT', BE: 'BEL', DK: 'DNK',
  FI: 'FIN', NO: 'NOR', PL: 'POL', MX: 'MEX', ID: 'IDN', VN: 'VNM', TH: 'THA',
  SG: 'SGP', MY: 'MYS', PH: 'PHL', TR: 'TUR', IL: 'ISR', ZA: 'ZAF', NZ: 'NZL',
};
const PT_NONCOUNTRY = { EP: '유럽특허청(EPO)', WO: 'WIPO 국제출원', EA: '유라시아특허청' };

async function fetchPatents() {
  try {
    const res = await fetch(PT_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 (' + PT_DATA_URL + ') — python kipris_patent.py 를 먼저 실행하세요');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || typeof d !== 'object') throw new Error('형식이 올바르지 않습니다');
    /* ★ status:'error' 도 정상 응답이다 — 수집기가 남긴 이유를 화면이 보여줘야 하니
       여기서 예외로 바꾸지 않고 그대로 넘긴다. */
    _ptData = d;
  } catch (e) {
    _ptData = { status: 'error', reason: (e && e.message) || String(e), _loadFailed: true };
    console.warn('[kipris] 로드 실패:', e);
  }
  renderPatent();
}

/* ── 집계 헬퍼 ─────────────────────────────────────────────────────────── */

/** 수집 기간 안에서 필터가 고른 구간. 필터가 비면 수집 기간 그대로. */
/** 데이터가 실제로 존재하는 범위. 수집 설정(period)이 아니라 행에서 센다.
 *  ★ period 는 '오늘로부터 20년'이라는 계산값이어서, 데이터가 없는 구간까지
 *    기본값으로 잡혔다(2006-09-09 같은 임의의 날짜). 있는 것만 보여 준다. */
function ptDataSpan() {
  const rows = (_ptData && Array.isArray(_ptData.rows)) ? _ptData.rows : [];
  const ds = rows.map((r) => r.date).filter(Boolean).sort();
  return ds.length ? { from: ds[0], to: ds[ds.length - 1] } : { from: '', to: '' };
}

/** 오늘 날짜(YYYY-MM-DD). 현지 시각 기준으로 만든다.
 *  ★ toISOString() 은 UTC 라 한국에서 오전에 열면 어제가 나온다. */
function ptToday() {
  const d = new Date();
  const p2 = (v) => (v < 10 ? '0' + v : String(v));
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/** 처음 열었을 때의 조회 기간 — 2020-01-01 ~ 오늘.
 *  ★ 전체 데이터(2007년~)를 기본으로 두면 20년 치가 한 화면에 눌려 최근 흐름이
 *    안 보인다. 최근 몇 해를 기본으로 하고, 더 과거는 달력에서 시작일을
 *    직접 당겨 고른다(min 이 데이터 최초 출원일이다).
 *  ★★ 오늘 날짜는 실행 시점에 만든다(하드코딩하지 않는다).
 *  ★★★ 데이터가 2020년 이후에만 있으면 시작일을 데이터 시작으로 당긴다 —
 *    데이터가 없는 구간을 기본값으로 들고 있을 이유가 없다. */
const PT_DEFAULT_FROM = '2020-01-01';
function ptDefaultRange() {
  const sp = ptDataSpan();
  const today = ptToday();
  const from = (sp.from && sp.from > PT_DEFAULT_FROM) ? sp.from : PT_DEFAULT_FROM;
  return { from: from, to: today };
}

function ptRange() {
  const def = ptDefaultRange();
  return { from: _ptFrom || def.from, to: _ptTo || def.to };
}

/** 구간과 '같은 길이의 직전 1년' 구간(전년 동기 비교용). */
function ptPrevRange(r) {
  const shift = (s) => {
    if (!s) return '';
    const y = Number(s.slice(0, 4));
    return isFinite(y) ? (y - 1) + s.slice(4) : '';
  };
  return { from: shift(r.from), to: shift(r.to) };
}

function ptRows(range) {
  const rows = (_ptData && Array.isArray(_ptData.rows)) ? _ptData.rows : [];
  if (!range || !range.from || !range.to) return rows;
  return rows.filter((r) => r.date >= range.from && r.date <= range.to);
}

function ptCount(rows, fn) { return rows.filter(fn).length; }

/** 증감 배지 — 전년 동기 대비. 기준이 0이면 비율을 만들지 않는다. */
function ptDelta(now, before, isPct) {
  if (before == null) return '';
  if (!isPct && !before) {
    return '<span class="pt-kpi__d pt-kpi__d--flat">전년 동기 0건</span>';
  }
  const v = isPct ? (now - before) : ((now - before) / before * 100);
  const up = v > 0, flat = Math.abs(v) < 0.05;
  const cls = flat ? 'flat' : (up ? 'up' : 'down');
  const arrow = flat ? '–' : (up ? '▲' : '▼');
  const num = Math.abs(v).toFixed(1) + (isPct ? '%p' : '%');
  return '<span class="pt-kpi__d pt-kpi__d--' + cls + '">' + arrow + ' ' + num
    + '<i>전년 동기</i></span>';
}

/* ── 1) KPI 5장 ────────────────────────────────────────────────────────── */
function ptKpiCards(cur, prev) {
  /* ★ '해외 출원 비율'을 뺐다 — 해외특허 API 권한이 없어 늘 0% 여서, 측정한
     값처럼 보이면서 아무것도 말해 주지 않았다.
     대신 '최근 3년 출원'을 둔다. 고른 기간의 끝에서 3년을 세고 그 앞 3년과
     비교하므로, 기간 필터를 움직이면 함께 따라오고 추세를 바로 읽을 수 있다. */
  const yEnd = (rowsIn) => {
    const ds = rowsIn.map((r) => r.date).filter(Boolean).sort();
    return ds.length ? Number(ds[ds.length - 1].slice(0, 4)) : null;
  };
  const last3 = (rowsIn, endY) => (endY == null ? 0
    : ptCount(rowsIn, (r) => Number((r.date || '0').slice(0, 4)) > endY - 3));
  const prior3 = (rowsIn, endY) => (endY == null ? 0
    : ptCount(rowsIn, (r) => {
      const y = Number((r.date || '0').slice(0, 4));
      return y > endY - 6 && y <= endY - 3;
    }));
  const eY = yEnd(cur);
  const defs = [
    ['전체 특허 출원', cur.length, prev.length, '건', false],
    ['시몬스 출원', ptCount(cur, (r) => r.isOurs), ptCount(prev, (r) => r.isOurs), '건', false],
    ['경쟁사 출원(합계)', ptCount(cur, (r) => !r.isOurs), ptCount(prev, (r) => !r.isOurs), '건', false],
    ['신소재 관련', ptCount(cur, (r) => r.newMaterial), ptCount(prev, (r) => r.newMaterial), '건', false],
    ['최근 3년 출원', last3(cur, eY), prior3(cur, eY), '건', false],
  ];
  return '<div class="pt-kpis">' + defs.map(([label, now, before, unit, isPct]) => {
    const shown = isPct ? now.toFixed(1) : now.toLocaleString('ko-KR');
    return '<div class="pt-kpi">'
      + '<div class="pt-kpi__l">' + escapeHtml(label) + '</div>'
      + '<div class="pt-kpi__v">' + shown + '<span>' + unit + '</span></div>'
      + ptDelta(now, before, isPct)
      + '</div>';
  }).join('') + '</div>';
}

/* ── 2) 연도별 추이 — 회사별 누적 막대 ──────────────────────────────────
   ★ 월 단위로 20년을 그리면 240칸이 되어 선이 톱니처럼 튀고 추세가 안 보인다.
     연 단위로 묶는다.
   ★★ '경쟁사'를 회색 한 덩어리로 묶지 않는다 — 그러면 그 회색이 누구 것인지
     알 수 없다. 회사별로 색을 나눠 쌓아, 막대 높이는 그 해 전체가 되고 안에서
     구성까지 읽히게 한다.
   ★★★ 색은 '회사'에 붙인다(그 해 순위가 아니다). 기간을 좁혀 어떤 회사가
     빠져도 남은 회사의 색이 바뀌지 않는다.
   ★★★★ 팔레트는 검증기(dataviz validate_palette)를 통과한 조합이다 —
     명도대·채도 하한·색약 분리(ΔE 8.9)·정상시야 분리(ΔE 23.8) 전부 PASS.
     대비 WARN 은 범례의 회사명과 툴팁 수치로 해소한다(색만으로 식별하지 않는다).
   ★★★★★ 높이를 넉넉히 준다 — 1~2건짜리 세그먼트에도 숫자가 들어가야
     마우스 없이 값이 읽힌다. 그래도 안 들어가는 칸은 막대 오른쪽에 붙인다. */
const PT_CO_COLORS = {
  simmons: '#C8102E',       // 자사 — 브랜드 크림슨
  tempur: '#3B82F6',
  ace: '#F59E0B',
  sealy: '#12B981',
  fursys: '#8B5CF6',
  coway: '#06B6D4',
  tempursealy: '#EC4899',
};
const PT_CO_FALLBACK = ['#3B82F6', '#F59E0B', '#12B981', '#8B5CF6', '#06B6D4', '#EC4899'];
// 세그먼트 안에 숫자를 넣을 최소 높이(viewBox 단위). 이보다 낮으면 막대 밖에 적는다.
const PT_SEG_MIN_H = 9;

/** 배경색 위에 얹을 글자색 — 밝은 채움에는 어두운 글자, 진한 채움에는 흰 글자.
 *  ★ 색마다 손으로 정하지 않는다. 팔레트를 바꾸면 그 표가 조용히 틀어진다.
 *    상대휘도를 재서 고른다(WCAG 계산식). */
function ptInkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  // 흰 글자와 검은 글자의 대비를 견줘 더 잘 보이는 쪽을 쓴다
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#fff' : '#0B1220';
}

/** 막대에 쌓을 회사 목록 — 설정 순서를 그대로 쓴다(색이 순위에 흔들리지 않게).
 *  자사를 맨 아래에 두어 해마다 같은 자리에서 비교된다. */
function ptStackOrder(rows) {
  const cfg = (_ptData && _ptData.companies) || [];
  const out = [];
  const seen = {};
  cfg.filter((c) => c.isOurs).concat(cfg.filter((c) => !c.isOurs)).forEach((c, i) => {
    seen[c.label] = 1;
    out.push({
      key: c.key, label: c.label, isOurs: !!c.isOurs,
      color: PT_CO_COLORS[c.key] || PT_CO_FALLBACK[i % PT_CO_FALLBACK.length],
    });
  });
  // 설정에 없는 이름이 데이터에 있으면 뒤에 붙인다(조용히 빠뜨리지 않는다)
  rows.forEach((r) => {
    const k = r.company || '미표기';
    if (!seen[k]) {
      seen[k] = 1;
      out.push({ key: 'x' + out.length, label: k, isOurs: false,
        color: PT_CO_FALLBACK[out.length % PT_CO_FALLBACK.length] });
    }
  });
  return out;
}

function ptYearly(rows) {
  const cos = ptStackOrder(rows);
  const by = {};
  rows.forEach((r) => {
    const y = (r.date || '').slice(0, 4);
    if (!y) return;
    if (!by[y]) by[y] = { y: y, total: 0, per: {} };
    by[y].total += 1;
    const k = r.company || '미표기';
    by[y].per[k] = (by[y].per[k] || 0) + 1;
  });
  const years = Object.keys(by).sort();
  /* ★ 한 해만 남아도 그린다 — 그 해의 회사 구성은 여전히 볼 것이 있다.
     '2년 이상 필요'로 카드를 비우면 기간을 좁힌 순간 화면이 사라진다. */
  if (!years.length) {
    return '<div class="sm-card"><div class="sm-h">특허 출원 동향 (연도별)</div>'
      + emptyState('이 기간에 해당하는 출원이 없습니다') + '</div>';
  }
  /* 빈 해도 축에 남긴다 — 건너뛰면 '그 해에 출원이 없었다'는 사실이 사라진다 */
  const y0 = Number(years[0]), y1 = Number(years[years.length - 1]);
  const pts = [];
  for (let y = y0; y <= y1; y += 1) {
    pts.push(by[String(y)] || { y: String(y), total: 0, per: {} });
  }
  /* ★ 가로는 연도 수에 맞춰 늘린다 — 20년을 720 폭에 넣으면 라벨을 격년으로
     솎아 낼 수밖에 없다. 한 해에 최소 44px 를 주고, 라벨은 45도 눕혀 전부 적는다.
     ★★ 세로는 예전(268)의 1.5배 — 1~2건 세그먼트에도 숫자가 들어가게. */
  const n = pts.length;
  const W = Math.max(VIZ_W, 96 + n * 44);
  const H = 400, padL = 44, padR = 26, padT = 34, padB = 62;
  const plotW = W - padL - padR, plotH = H - padT - padB, base = padT + plotH;
  const hi = gsNiceTop(Math.max.apply(null, pts.map((p) => p.total)) || 1, VIZ_Y_TICKS);
  const slot = plotW / n, bw = Math.min(34, slot * 0.6);
  const X = (i2) => padL + slot * i2 + slot / 2;
  const Y = (v) => padT + (1 - v / (hi || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = hi * t, y = Y(val);
    return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW)
      + '" y2="' + y.toFixed(1) + '" stroke="var(--grid)" stroke-width="1"/>'
      + '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end"'
      + ' font-size="' + VIZ_FS_AXIS + '" fill="var(--muted)">'
      + Math.round(val).toLocaleString('ko-KR') + '</text>';
  }).join('');
  // Y축이 무엇을 세는지 축 머리에 적는다
  const yUnit = '<text x="' + (padL - 6) + '" y="' + (padT - 12) + '" text-anchor="end"'
    + ' font-size="' + VIZ_FS_AXIS + '" fill="var(--muted)">(건)</text>';

  const bars = pts.map((p, i2) => {
    const x = X(i2) - bw / 2;
    // 툴팁 — 그 해에 실제로 낸 회사만, 많은 순으로. 0건은 적지 않는다(줄만 길어진다).
    const parts = cos.filter((c) => p.per[c.label])
      .map((c) => ({ label: c.label, n: p.per[c.label] }))
      .sort((a, b) => b.n - a.n)
      .map((c) => c.label + ' ' + c.n);
    const tip = p.y + '년 · 총 ' + p.total + '건'
      + (parts.length ? ' — ' + parts.join(' / ') : ' (출원 없음)');
    if (!p.total) {
      const t0 = tip;
      return '<rect class="pt-pick' + (_ptYear === p.y ? ' is-on' : '') + '" x="'
        + x.toFixed(1) + '" y="' + (base - 3).toFixed(1) + '" width="'
        + bw.toFixed(1) + '" height="3" fill="var(--line)" data-tip="'
        + escapeHtml(t0) + '" tabindex="0" role="button" data-ptyear="'
        + escapeHtml(p.y) + '"><title>' + escapeHtml(t0) + '</title></rect>';
    }
    /* 아래에서 위로 쌓는다. 세그먼트 사이 2px 는 카드 배경을 드러내 경계가 된다
       (마크 규격: 채움 사이 2px 여백).
       ★ 세그먼트마다 연도+회사를 달아 둔다 — 누르면 그 조건으로 목록이 걸러진다. */
    let acc = 0;
    const segs = [];
    const outside = [];     // 안에 못 들어간 숫자 — 막대 오른쪽에 붙인다
    cos.forEach((c) => {
      const v = p.per[c.label] || 0;
      if (!v) return;
      const yTop = Y(acc + v), yBot = Y(acc);
      const h = Math.max(1, yBot - yTop - 2);
      const segTip = p.y + '년 · ' + c.label + ' ' + v + '건 — 눌러서 목록 보기';
      const on = _ptYear === p.y && _ptCo === c.label;
      segs.push('<rect class="pt-pick' + (on ? ' is-on' : '') + '" x="' + x.toFixed(1)
        + '" y="' + yTop.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="'
        + h.toFixed(1) + '" rx="1.5" fill="' + c.color + '" tabindex="0" role="button"'
        + ' data-ptyear="' + escapeHtml(p.y) + '" data-ptco="' + escapeHtml(c.label)
        + '" data-tip="' + escapeHtml(segTip) + '">'
        + '<title>' + escapeHtml(segTip) + '</title></rect>');
      if (h >= PT_SEG_MIN_H) {
        segs.push('<text x="' + (x + bw / 2).toFixed(1) + '" y="'
          + (yTop + h / 2 + 3.2).toFixed(1) + '" text-anchor="middle" font-size="9"'
          + ' font-weight="800" fill="' + ptInkOn(c.color) + '" pointer-events="none">'
          + v + '</text>');
      } else {
        outside.push({ y: yTop + h / 2, v: v, color: c.color });
      }
      acc += v;
    });
    /* 막대 밖 숫자 — 서로 겹치지 않게 위에서 아래로 최소 간격을 벌린다 */
    outside.sort((a, b) => a.y - b.y);
    let lastY = -99;
    outside.forEach((o) => {
      const yy = Math.max(o.y, lastY + 8.5);
      lastY = yy;
      segs.push('<text x="' + (x + bw + 3).toFixed(1) + '" y="' + (yy + 3).toFixed(1)
        + '" text-anchor="start" font-size="8" font-weight="800" fill="' + o.color
        + '" pointer-events="none">' + o.v + '</text>');
    });
    return '<g class="pt-bar">' + segs.join('') + '</g>';
  }).join('');

  /* ★ X축 — 모든 해를 적는다. 겹치지 않게 45도 눕힌다(솎아 내면 막대는 있는데
     라벨이 없는 해가 생겨, 어느 막대가 몇 년인지 셈해야 한다). */
  const xlab = pts.map((p, i2) => '<text x="' + X(i2).toFixed(1) + '" y="' + (base + 12)
    + '" text-anchor="end" font-size="9" fill="var(--muted)"'
    + ' transform="rotate(-45 ' + X(i2).toFixed(1) + ' ' + (base + 12) + ')">'
    + escapeHtml(p.y) + '</text>').join('');

  // 범례 — 모든 회사를 적는다. 이 기간에 0건인 회사는 흐리게 두고 0건임을 밝힌다.
  const tot = {};
  rows.forEach((r) => { const k = r.company || '미표기'; tot[k] = (tot[k] || 0) + 1; });
  const legend = cos.map((c) => {
    const n2 = tot[c.label] || 0;
    return '<span class="pt-lg__i' + (n2 ? '' : ' is-zero') + '" tabindex="0" data-tip="'
      + escapeHtml(c.label + (c.isOurs ? '(자사)' : '') + ' · 이 기간 ' + n2 + '건') + '">'
      + '<i style="background:' + c.color + '"></i>'
      + escapeHtml(c.label) + (c.isOurs ? '(자사)' : '')
      + (n2 ? '' : ' <u>0건</u>') + '</span>';
  }).join('');

  return '<div class="sm-card"><div class="sm-h">특허 출원 동향 (연도별)'
    + ' <span class="sm-h__u">(단위: 건 · 막대 높이 = 그 해 전체)</span></div>'
    + '<div class="pt-lg pt-lg--co">' + legend + '</div>'
    + '<div class="pt-chartwrap"><svg class="pt-ysvg" viewBox="0 0 ' + W + ' ' + H + '"'
    + ' preserveAspectRatio="xMinYMid meet" role="img"'
    + ' aria-label="연도별 회사별 특허 출원 추이">'
    + grid + yUnit + bars
    + '<line x1="' + padL + '" y1="' + base + '" x2="' + (padL + plotW) + '" y2="' + base
    + '" stroke="var(--axis)" stroke-width="1"/>' + xlab + '</svg></div>'
    + '<div class="sm-foot">막대를 누르면 그 해·그 기업의 특허 목록만 아래에 표시됩니다.</div>'
    + '</div>';
}

/* ── 3) 출원 유형별 — 도넛 ─────────────────────────────────────────────── */
/** 도넛 조각 하나를 '진짜 도형'으로 그린다 — 채워진 부채꼴(고리 조각).
 *  ★ 예전에는 <circle> 에 stroke-dasharray 로 조각을 만들었다. 눈에는 조각으로
 *    보이지만 도형 자체는 '원 전체'다. 브라우저가 점선 stroke 를 히트테스트할 때
 *    칠해진 구간만 잡아 주지 않으면, DOM 에서 가장 나중에 그려진 조각이 고리
 *    전체의 클릭을 가로챈다 — 어느 조각을 눌러도 같은 곳이 눌리거나 아무 일도
 *    일어나지 않는다. 조각마다 닫힌 path 를 만들면 클릭 영역이 보이는 그대로다.
 *  ★★ fill 로 칠하고 stroke 는 쓰지 않는다(히트 영역이 면이 된다). */
function ptArcPath(cx, cy, rOut, rIn, a0, a1) {
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const big = (a1 - a0) > Math.PI ? 1 : 0;
  const o0 = pt(rOut, a0), o1 = pt(rOut, a1);
  const i1 = pt(rIn, a1), i0 = pt(rIn, a0);
  const f = (v) => v.toFixed(2);
  return 'M' + f(o0[0]) + ' ' + f(o0[1])
    + ' A' + rOut + ' ' + rOut + ' 0 ' + big + ' 1 ' + f(o1[0]) + ' ' + f(o1[1])
    + ' L' + f(i1[0]) + ' ' + f(i1[1])
    + ' A' + rIn + ' ' + rIn + ' 0 ' + big + ' 0 ' + f(i0[0]) + ' ' + f(i0[1]) + ' Z';
}

function ptTypes(rows) {
  const c = {};
  rows.forEach((r) => { const k = r.kind || '미표기'; c[k] = (c[k] || 0) + 1; });
  const items = Object.keys(c).map((k) => ({ label: k, n: c[k] }))
    .sort((a, b) => b.n - a.n).slice(0, 6);
  const total = items.reduce((s, x) => s + x.n, 0);
  if (!total) {
    return '<div class="sm-card"><div class="sm-h">출원 유형별 현황</div>'
      + emptyState('유형 정보가 없습니다') + '</div>';
  }
  const COLORS = ['var(--blue)', 'var(--green)', 'var(--amber)', 'var(--violet)',
    'var(--slate)', 'var(--navy-2)'];
  const CX = 70, CY = 70, R_OUT = 64, R_IN = 44;
  const GAP = 0.014;                 // 조각 사이 틈(라디안) — 경계가 보이게
  let a = -Math.PI / 2;              // 12시부터 시계방향
  const segs = items.map((x, i) => {
    const frac = x.n / total;
    const span = frac * Math.PI * 2;
    const a0 = a + (span > GAP * 2 ? GAP : 0);
    const a1 = a + span - (span > GAP * 2 ? GAP : 0);
    a += span;
    const on = _ptKind === x.label;
    const tip = x.label + ' · ' + x.n + '건 (' + (frac * 100).toFixed(1) + '%)'
      + ' — 눌러서 목록 보기';
    /* 고른 조각은 살짝 두껍게(안쪽으로 더 파고들게) 해서 눈에 띈다 */
    const d = ptArcPath(CX, CY, on ? R_OUT + 3 : R_OUT, on ? R_IN - 3 : R_IN, a0, a1);
    return '<path class="pt-slice' + (on ? ' is-on' : '') + '" d="' + d + '"'
      + ' fill="' + COLORS[i % COLORS.length] + '" stroke="none"'
      + ' tabindex="0" role="button" data-ptkind="' + escapeHtml(x.label) + '"'
      + ' data-tip="' + escapeHtml(tip) + '">'
      + '<title>' + escapeHtml(tip) + '</title></path>';
  }).join('');
  const legend = items.map((x, i) => '<div class="pt-dn__r pt-pick'
    + (_ptKind === x.label ? ' is-on' : '') + '" tabindex="0" role="button"'
    + ' data-ptkind="' + escapeHtml(x.label) + '" data-tip="'
    + escapeHtml(x.label + ' · ' + x.n + '건 (' + (x.n / total * 100).toFixed(1)
      + '%) — 눌러서 목록 보기') + '">'
    + '<i style="background:' + COLORS[i % COLORS.length] + '"></i>'
    + '<span class="pt-dn__l">' + escapeHtml(x.label) + '</span>'
    + '<b>' + x.n.toLocaleString('ko-KR') + '건</b>'
    + '<u>' + (x.n / total * 100).toFixed(1) + '%</u></div>').join('');
  return '<div class="sm-card"><div class="sm-h">출원 유형별 현황'
    + ' <span class="sm-h__u">(KIPRIS 구분값 기준)</span></div>'
    + '<div class="pt-dn">'
    /* 가운데는 비운다 — 합계는 오른쪽 범례가 이미 다 말한다 */
    + '<svg class="pt-dnsvg" viewBox="0 0 140 140" width="146" height="146" role="img"'
    + ' aria-label="출원 유형별 비중">' + segs + '</svg>'
    + '<div class="pt-dn__lg">' + legend + '</div></div>'
    + '<div class="sm-foot">조각이나 항목을 누르면 아래 목록이 그 유형으로 걸러집니다.</div>'
    + '</div>';
}

/* ── 4) 주요 기술 분야 TOP5 ────────────────────────────────────────────── */
function ptTech(rows) {
  const c = {};
  rows.forEach((r) => {
    const k = r.catLabel || '기타/미분류';
    c[k] = (c[k] || 0) + 1;
  });
  const items = Object.keys(c).map((k) => ({ label: k, n: c[k] }))
    .sort((a, b) => b.n - a.n).slice(0, 5);
  const max = items.length ? items[0].n : 1;
  const total = rows.length || 1;
  if (!items.length) {
    return '<div class="sm-card"><div class="sm-h">주요 기술 분야 TOP5</div>'
      + emptyState('분류할 특허가 없습니다') + '</div>';
  }
  return '<div class="sm-card"><div class="sm-h">주요 기술 분야 TOP5 (특허)</div>'
    + '<table class="pt-tb"><thead><tr><th>순위</th><th>기술 분야</th>'
    + '<th class="pt-tb__n">건수</th><th class="pt-tb__n">비중</th><th>분포</th></tr></thead>'
    + '<tbody>' + items.map((x, i) => '<tr class="pt-pick'
      + (_ptCat === x.label ? ' is-on' : '') + '" tabindex="0" role="button"'
      + ' data-ptcat="' + escapeHtml(x.label) + '" data-tip="'
      + escapeHtml(x.label + ' · ' + x.n + '건 (' + (x.n / total * 100).toFixed(1)
        + '%) — 눌러서 목록 보기')
      + '"><th scope="row">' + (i + 1) + '</th>'
      + '<td>' + escapeHtml(x.label) + '</td>'
      + '<td class="pt-tb__n"><b>' + x.n.toLocaleString('ko-KR') + '</b></td>'
      + '<td class="pt-tb__n">' + (x.n / total * 100).toFixed(1) + '%</td>'
      + '<td><span class="pt-tb__bar" style="width:' + (x.n / max * 100).toFixed(1)
      + '%"></span></td></tr>').join('')
    + '</tbody></table>'
    + '<div class="sm-foot">행을 누르면 아래 목록이 그 분야로 걸러집니다.</div></div>';
}

/* ── 5) 주요 출원인 비교 ───────────────────────────────────────────────── */
function ptApplicants(rows) {
  const c = {};
  /* ★ 설정에 있는 기업은 0건이어도 자리를 남긴다 — '특허를 내지 않았다'는 것도
     경쟁사 정보다. 결과에서 빠지면 조회가 안 된 것과 구분할 수 없다. */
  ((_ptData && _ptData.companies) || []).forEach((co) => {
    c[co.label] = { label: co.label, n: 0, ours: !!co.isOurs };
  });
  rows.forEach((r) => {
    const k = r.company || '미표기';
    if (!c[k]) c[k] = { label: k, n: 0, ours: !!r.isOurs };
    c[k].n += 1;
  });
  const items = Object.keys(c).map((k) => c[k]).sort((a, b) => b.n - a.n);
  if (!items.length) {
    return '<div class="sm-card"><div class="sm-h">주요 출원인 비교</div>'
      + emptyState('출원인 정보가 없습니다') + '</div>';
  }
  const max = items[0].n || 1;
  const totalN = items.reduce((a, b) => a + b.n, 0) || 1;
  return '<div class="sm-card"><div class="sm-h">주요 출원인(기업) 비교'
    + ' <span class="sm-h__u">(단위: 건)</span></div>'
    /* ★ 색이 무슨 뜻인지 범례로 먼저 밝힌다 — 강조색만 두면 왜 빨간지 알 수 없다 */
    + '<div class="pt-lg"><span class="pt-lg__i"><i style="background:var(--accent)"></i>'
    + '시몬스(자사)</span><span class="pt-lg__i">'
    + '<i style="background:var(--slate);opacity:.5"></i>경쟁사</span></div>'
    + '<div class="sm-hbars sm-hbars--inv">' + items.map((x) => '<div class="sm-hrow'
      + (x.ours ? ' is-mine' : '') + (x.n ? ' pt-pick' : '')
      + (_ptCo === x.label ? ' is-on' : '') + '" tabindex="0"'
      + (x.n ? ' role="button" data-ptco="' + escapeHtml(x.label) + '"' : '')
      + ' data-tip="'
      + escapeHtml(x.label + (x.ours ? '(자사)' : '') + ' · ' + x.n + '건 ('
        + (x.n / totalN * 100).toFixed(1) + '%)'
        + (x.n ? ' — 눌러서 목록 보기' : '')) + '">'
      + '<div class="sm-hname">' + escapeHtml(x.label)
      + (x.ours ? '<span class="pt-own">자사</span>' : '') + '</div>'
      + '<div class="sm-htrack">' + (x.n
        ? '<div class="sm-hbar" style="width:' + Math.max(2, x.n / max * 100).toFixed(1) + '%"></div>'
        : '') + '</div>'
      + '<div class="sm-hval' + (x.n ? '' : ' pt-zero') + '">'
      + x.n.toLocaleString('ko-KR') + '건</div>'
      + '</div>').join('') + '</div>'
    + '<div class="sm-foot">0건은 해당 기간에 이 분야(IPC A47C) 출원이 확인되지 않은'
    + ' 기업입니다 — 조회가 안 된 것이 아닙니다.'
    + ' 막대를 누르면 아래 목록이 그 기업으로 걸러집니다.</div></div>';
}

/* ── 6) 국가별 출원 — 세계지도 ───────────────────────────────────────────
   ★ 지금은 화면에서 부르지 않는다(renderPatent 에서 주석 처리). 해외특허 API
     권한이 열려 country 가 KR 이외로 채워지면 그 줄만 되살리면 된다.
     지우지 않고 두는 이유 — 좌표 매핑(PT_ISO2)과 지역 특허청 처리(PT_NONCOUNTRY)를
     다시 만들 필요가 없게. */
function ptCountries(rows) {
  const c = {};
  rows.forEach((r) => { const k = (r.country || '').toUpperCase() || '미표기'; c[k] = (c[k] || 0) + 1; });
  const keys = Object.keys(c);
  if (!keys.length) {
    return '<div class="sm-card"><div class="sm-h">국가별 출원 현황</div>'
      + emptyState('국가 정보가 없습니다') + '</div>';
  }
  const max = Math.max.apply(null, keys.map((k) => c[k])) || 1;
  const R_MAX = 22, R_MIN = 6;
  const dots = keys.map((k) => {
    const iso3 = PT_ISO2[k];
    const ll = iso3 && ISO_LONLAT[iso3];
    if (!ll) return '';                     // 좌표 없거나 나라가 아니면 지도에 찍지 않는다
    const left = (ll[0] + 180) / 360 * 100;
    const top = (90 - ll[1]) / 180 * 100;
    const r = Math.max(R_MIN, R_MAX * Math.sqrt(c[k] / max));
    return '<div class="gsl-mk gsl-mk--r" tabindex="0" data-tip="'
      + escapeHtml(k + (PT_NONCOUNTRY[k] ? ' · ' + PT_NONCOUNTRY[k] : '') + ' · ' + c[k] + '건')
      + '" style="left:' + left.toFixed(2) + '%;top:' + top.toFixed(2) + '%">'
      + '<span class="gsl-dot" style="width:' + (r * 2).toFixed(1) + 'px;height:'
      + (r * 2).toFixed(1) + 'px;margin:-' + r.toFixed(1) + 'px 0 0 -' + r.toFixed(1) + 'px"></span>'
      + '<span class="gsl-lb"><b>' + escapeHtml(k) + '</b><i>' + c[k] + '건</i></span></div>';
  }).join('');
  /* 지도에 찍을 수 없는 코드(지역 특허청·국제출원·미표기)는 표로 따로 밝힌다.
     ★ EP·WO 를 억지로 한 나라 위에 올리면 그 나라 실적처럼 읽힌다. */
  const off = keys.filter((k) => !(PT_ISO2[k] && ISO_LONLAT[PT_ISO2[k]]))
    .sort((a, b) => c[b] - c[a]);
  const rowsHtml = keys.slice().sort((a, b) => c[b] - c[a]).map((k) => '<tr tabindex="0"'
    + ' data-tip="' + escapeHtml(k + ' · ' + c[k] + '건') + '">'
    + '<th scope="row">' + escapeHtml(PT_NONCOUNTRY[k] ? k + ' · ' + PT_NONCOUNTRY[k] : k) + '</th>'
    + '<td class="pt-tb__n"><b>' + c[k].toLocaleString('ko-KR') + '</b>건</td></tr>').join('');
  return '<div class="sm-card"><div class="sm-h">국가별 출원 현황'
    + ' <span class="sm-h__u">(단위: 건)</span></div>'
    + '<div class="gsl-map"><img class="gsl-map__img" src="world-map.svg" alt=""'
    + ' aria-hidden="true"><div class="gsl-marks">' + dots + '</div></div>'
    + '<table class="pt-tb pt-tb--ctry"><thead><tr><th>국가·청</th>'
    + '<th class="pt-tb__n">건수</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>'
    + (off.length ? '<div class="sm-foot">' + escapeHtml(off.join(', '))
      + ' 은 특정 국가 좌표가 없어 지도에 표시하지 않고 표에만 넣었습니다.</div>' : '')
    + '</div>';
}

/* ── 7) 신소재 키워드 TOP10 — 워드클라우드 ─────────────────────────────── */
function ptWords(rows) {
  const c = {};
  rows.forEach((r) => (r.words || []).forEach((w) => { c[w] = (c[w] || 0) + 1; }));
  const items = Object.keys(c).map((k) => ({ w: k, n: c[k] }))
    .sort((a, b) => b.n - a.n).slice(0, 10);
  if (!items.length) {
    return '<div class="sm-card"><div class="sm-h">신소재 관련 특허 키워드 TOP10</div>'
      + emptyState('사전에 걸린 키워드가 없습니다') + '</div>';
  }
  const max = items[0].n, min = items[items.length - 1].n;
  const size = (n) => (max === min ? 20 : 13 + (n - min) / (max - min) * 17);
  const shade = (n) => (max === min ? 0.85 : 0.5 + (n - min) / (max - min) * 0.5);
  return '<div class="sm-card"><div class="sm-h">신소재 관련 특허 키워드 TOP10</div>'
    + '<div class="pt-cloud">' + items.map((x) => '<span class="pt-cloud__w"'
      + ' style="font-size:' + size(x.n).toFixed(1) + 'px;opacity:' + shade(x.n).toFixed(2)
      + '" tabindex="0" data-tip="' + escapeHtml(x.w + ' · ' + x.n + '건')
      + '" title="' + escapeHtml(x.w + ' · ' + x.n + '건') + '">'
      + escapeHtml(x.w) + '<i>' + x.n + '</i></span>').join('') + '</div>'
    + '<div class="sm-foot">형태소 분석 없이 설정 파일(kipris_taxonomy.json)의 키워드'
    + ' 사전과 맞춰 센 결과입니다.</div></div>';
}

/** 출원번호 셀 — 눌러서 상세를 펼친다(KIPRIS 링크가 아니다).
 *  ★ KIPRIS 검색 화면은 전부 method="post" 인 SPA 라 ?query= 로는 검색이
 *    실행되지 않는다 — 링크를 누르면 빈 초기 화면만 뜬다(실측).
 *    그래서 이미 받아 둔 데이터로 우리가 상세를 보여 주고, KIPRIS 로 가야 할
 *    때는 번호를 복사해 붙여넣게 한다. */
function ptNoButton(appNo) {
  const no = String(appNo || '').trim();
  if (!no) return '—';
  return '<button class="pt-nobtn" type="button" data-appno="' + escapeHtml(no) + '"'
    + ' data-tip="눌러서 이 출원의 상세를 봅니다">' + escapeHtml(no) + '</button>';
}

/* ── 출원 상세 — 이미 받아 둔 데이터를 그 자리에서 펼친다 ──────────────────
   ★ KIPRIS 로 링크를 걸 수 없다. 검색 화면이 전부 method="post" 인 SPA 라
     ?query= 로는 검색이 실행되지 않고 초기 화면만 뜬다(실측).
   ★★ 그래서 상세는 우리가 보여 준다 — 수집 때 제목·초록·IPC·출원인·분류를
     이미 받아 뒀으므로 API 를 다시 부르지 않는다.
   ★★★ KIPRIS 로 가야 할 때를 위해 '번호 복사'를 둔다. 붙여넣어 검색하는 것이
     열리지 않는 링크보다 확실하다. */
function ptRowByNo(appNo) {
  const rows = (_ptData && Array.isArray(_ptData.rows)) ? _ptData.rows : [];
  return rows.find((r) => String(r.appNo) === String(appNo)) || null;
}

function ptDetailHtml(r) {
  const row = (k, v, cls) => (v
    ? '<div class="ptd__r"><span class="ptd__k">' + escapeHtml(k) + '</span>'
      + '<span class="ptd__v' + (cls ? ' ' + cls : '') + '">' + v + '</span></div>'
    : '');
  /* IPC 는 '|' 로 붙어 오므로 조각으로 끊어 보여 준다 */
  const ipc = String(r.ipc || '').split('|').map((x) => x.trim()).filter(Boolean);
  const ipcHtml = ipc.length
    ? ipc.map((x) => '<code class="ptd__ipc">' + escapeHtml(x) + '</code>').join(' ')
    : '';
  const words = (r.words || []).length
    ? r.words.map((x) => '<span class="ptd__w">' + escapeHtml(x) + '</span>').join('')
    : '';
  return '<div class="ptd" role="dialog" aria-modal="true" aria-labelledby="ptdTitle">'
    + '<div class="ptd__hd">'
    + '<div><div class="ptd__no">' + escapeHtml(r.appNo || '—')
    + (r.isOurs ? ' <span class="pt-own">자사</span>' : '') + '</div>'
    + '<h4 class="ptd__t" id="ptdTitle">' + escapeHtml(r.title || '(제목 없음)') + '</h4></div>'
    + '<button class="ptd__x" type="button" id="ptdClose" aria-label="닫기">✕</button>'
    + '</div>'
    + '<div class="ptd__bd">'
    + row('출원인', escapeHtml(r.applicantRaw || r.company || '—'))
    + row('출원일', escapeHtml(r.date || '—'))
    + row('상태', escapeHtml(r.kind || '—'))
    + row('국가', escapeHtml(r.country || '—'))
    + row('기술 분야', escapeHtml(r.catLabel || '—')
        + (r.newMaterial ? ' <span class="ptd__tag">신소재 관련</span>' : ''))
    + row('IPC', ipcHtml)
    + row('키워드', words)
    + row('요약', escapeHtml(r.summary || '(초록 없음)'), 'ptd__abs')
    + '</div>'
    + '<div class="ptd__ft">'
    + '<button class="ptd__btn ptd__btn--go" type="button" id="ptdCopy"'
    + ' data-no="' + escapeHtml(r.appNo || '') + '">출원번호 복사</button>'
    + '<a class="ptd__btn" href="https://www.kipris.or.kr/khome/search/searchResult.do?tab=patent"'
    + ' target="_blank" rel="noopener noreferrer">KIPRIS 열기</a>'
    + '<span class="ptd__hint">KIPRIS 검색은 주소로 바로 실행되지 않습니다 —'
    + ' 번호를 복사해 검색창에 붙여넣어 주세요.</span>'
    + '</div></div>';
}

function ptOpenDetail(appNo) {
  const r = ptRowByNo(appNo);
  if (!r) return;
  let wrap = document.getElementById('ptModal');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'ptModal';
    wrap.className = 'ptd-back';
    document.body.appendChild(wrap);
    // 배경 클릭으로 닫기(패널 안쪽 클릭은 통과시키지 않는다)
    wrap.addEventListener('click', (e) => { if (e.target === wrap) ptCloseDetail(); });
  }
  wrap.innerHTML = ptDetailHtml(r);
  wrap.classList.add('is-on');
  ptCloseDetail._last = document.activeElement;
  const x = document.getElementById('ptdClose');
  if (x && x.focus) x.focus();
  wrap.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('#ptdClose, #ptdCopy') : null;
    if (!t) return;
    if (t.id === 'ptdClose') { ptCloseDetail(); return; }
    const no = t.getAttribute('data-no') || '';
    const done = () => { t.textContent = '복사했습니다'; setTimeout(() => {
      t.textContent = '출원번호 복사'; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(no).then(done, () => { /* 권한 거부 시 조용히 */ });
    } else {
      /* 구형 브라우저 — 임시 입력칸을 만들어 복사한다 */
      const ta = document.createElement('textarea');
      ta.value = no; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* 무시 */ }
      ta.remove();
    }
  });
  document.addEventListener('keydown', ptDetailKey);
}

function ptCloseDetail() {
  const wrap = document.getElementById('ptModal');
  if (wrap) { wrap.classList.remove('is-on'); wrap.innerHTML = ''; }
  document.removeEventListener('keydown', ptDetailKey);
  const back = ptCloseDetail._last;
  if (back && back.focus) back.focus();
}

function ptDetailKey(e) {
  if (e.key === 'Escape') ptCloseDetail();
}

/* ── 8) 최근 주요 출원 목록 ────────────────────────────────────────────── */
function ptRecent(rows) {
  /* ★ 최신순 20건만 보여 주면 최근에 몰아 낸 회사(코웨이)로 목록이 다 차고,
     에이스침대(최신 2019년)처럼 예전에 낸 회사는 화면에서 사라진다 —
     '데이터가 없다'로 잘못 읽힌다. 회사를 골라 볼 수 있게 한다. */
  const cos = ptStackOrder(rows);
  const cnt = {};
  rows.forEach((r) => { const k = r.company || '미표기'; cnt[k] = (cnt[k] || 0) + 1; });
  /* ★ '전체 N' 칩은 두지 않는다 — 합계는 카드 제목과 KPI 가 이미 말하고,
     해제는 필터가 걸릴 때만 나오는 [전체 보기] 버튼이 맡는다. */
  const chips = '<div class="pt-chips" role="group" aria-label="출원인 골라 보기">'
    + cos.filter((c) => cnt[c.label]).map((c) => '<button class="pt-chip'
      + (_ptCo === c.label ? ' is-on' : '') + '" type="button" data-ptco="'
      + escapeHtml(c.label) + '"><i style="background:' + c.color + '"></i>'
      + escapeHtml(c.label) + ' <b>' + cnt[c.label] + '</b></button>').join('')
    + '</div>';

  const picked = ptApplyFilters(rows);
  const act = ptActiveFilters();
  /* ★ 고른 결과를 전부 볼 수 있어야 한다. 예전에는 필터가 걸리면 전 건을 싣고
     표에 460px 세로 스크롤을 줬는데, 페이지 안에 또 스크롤 영역이 생겨
     '95건이라는데 12건만 보인다'로 읽혔다 — 스크롤이 있다는 걸 알아채기 어렵다.
     페이지로 나눈다: 몇 건 중 어디를 보고 있는지 숫자로 드러나고,
     페이지 안에서는 페이지 자체만 스크롤하면 된다. */
  const total = picked.length;
  const pages = Math.max(1, Math.ceil(total / PT_PAGE_SIZE));
  const page = Math.min(Math.max(1, _ptPage), pages);   // 조건이 좁아져 범위를 넘으면 당긴다
  const from = (page - 1) * PT_PAGE_SIZE;
  const items = picked.slice(from, from + PT_PAGE_SIZE);
  const bar = act.length
    ? '<div class="pt-fbar">'
      + '<span class="pt-fbar__t">'
      + act.map((f) => '<b>' + escapeHtml(f.label) + '</b>').join(' + ')
      + '(으)로 필터링됨 · <b>' + picked.length + '건</b></span>'
      + act.map((f) => '<button class="pt-fbar__x" type="button" data-ptclear="'
        + escapeHtml(f.k) + '">' + escapeHtml(f.label) + ' 해제 ✕</button>').join('')
      + '<button class="pt-fbar__all" type="button" data-ptclear="all">전체 보기</button>'
      + '</div>'
    : '';
  if (!items.length) {
    return '<div class="sm-card sm-card--full"><div class="sm-h">최근 주요 특허 출원</div>'
      + bar + chips + emptyState('이 조건에 해당하는 출원이 없습니다') + '</div>';
  }
  /* 페이지 번호 — 많아지면 현재 쪽 주변만 남기고 양 끝을 … 로 줄인다 */
  const nums = [];
  if (pages <= 9) {
    for (let k = 1; k <= pages; k += 1) nums.push(k);
  } else {
    /* 현재 쪽 앞뒤 2쪽 + 양 끝을 남긴다 — 1쪽에서 가운데로 건너뛸 길이 있어야 한다 */
    const near = [1, 2, page - 2, page - 1, page, page + 1, page + 2, pages - 1, pages]
      .filter((k) => k >= 1 && k <= pages);
    const uniq = Array.from(new Set(near)).sort((a, b) => a - b);
    uniq.forEach((k, idx) => {
      if (idx && k - uniq[idx - 1] > 1) nums.push(0);   // 0 = 생략 표시
      nums.push(k);
    });
  }
  const pager = (pages > 1)
    ? '<div class="pt-pager" role="group" aria-label="목록 페이지">'
      + '<button class="pt-pg" type="button" data-ptpage="' + (page - 1) + '"'
      + (page <= 1 ? ' disabled' : '') + ' aria-label="이전 페이지">‹</button>'
      + nums.map((k) => (k === 0
        ? '<span class="pt-pg__gap">…</span>'
        : '<button class="pt-pg' + (k === page ? ' is-on' : '') + '" type="button"'
          + ' data-ptpage="' + k + '"' + (k === page ? ' aria-current="page"' : '')
          + '>' + k + '</button>')).join('')
      + '<button class="pt-pg" type="button" data-ptpage="' + (page + 1) + '"'
      + (page >= pages ? ' disabled' : '') + ' aria-label="다음 페이지">›</button>'
      + '</div>'
    : '';
  const rangeNote = '<div class="pt-range">' + total.toLocaleString('ko-KR') + '건 중 '
    + (from + 1).toLocaleString('ko-KR') + '~' + (from + items.length).toLocaleString('ko-KR')
    + '건 표시' + (pages > 1 ? ' · ' + page + '/' + pages + ' 페이지' : '') + '</div>';

  return '<div class="sm-card sm-card--full"><div class="sm-h">최근 주요 특허 출원'
    + ' <span class="sm-h__u">(최신순 · 전체 ' + total.toLocaleString('ko-KR')
    + '건)</span></div>'
    + bar + chips
    + '<div class="pt-scroll"><table class="pt-tb pt-tb--list"><thead><tr>'
    + '<th>번호</th><th>출원번호</th><th>출원일</th><th>출원인</th><th>국가</th>'
    + '<th>기술명</th><th>분류</th><th>요약</th></tr></thead><tbody>'
    + items.map((r, i) => '<tr>'
      + '<th scope="row">' + (from + i + 1) + '</th>'
      + '<td class="pt-tb__mono">' + ptNoButton(r.appNo) + '</td>'
      + '<td class="pt-tb__mono">' + escapeHtml(r.date || '—') + '</td>'
      + '<td>' + escapeHtml(r.company || '—')
      + (r.isOurs ? ' <span class="pt-own">자사</span>' : '') + '</td>'
      + '<td>' + escapeHtml(r.country || '—') + '</td>'
      + '<td class="pt-tb__t">' + escapeHtml(r.title || '—') + '</td>'
      + '<td>' + escapeHtml(r.catLabel || '—') + '</td>'
      + '<td class="pt-tb__s">' + escapeHtml(r.summary || '—') + '</td>'
      + '</tr>').join('') + '</tbody></table></div>'
    + rangeNote + pager + '</div>';
}

/* ── 9) 기간 필터 ──────────────────────────────────────────────────────── */
function ptRangeUi() {
  const sp = ptDataSpan();
  const today = ptToday();
  const r = ptRange();
  /* ★ min 은 데이터의 가장 오래된 출원일, max 는 오늘 — 미래 날짜와 데이터가
     없는 과거는 달력에서 아예 못 고르게 한다. */
  const inp = (id, val) => '<input class="pt-date" type="date" id="' + id
    + '" value="' + escapeHtml(val || '') + '"'
    + (sp.from ? ' min="' + escapeHtml(sp.from) + '"' : '')
    + ' max="' + escapeHtml(today) + '">';
  return '<div class="pt-filter">'
    + '<span class="pt-filter__l">조회 기간</span>'
    + inp('ptFrom', r.from)
    + '<span class="pt-filter__t">~</span>'
    + inp('ptTo', r.to)
    /* ★ 날짜를 고를 때마다 다시 그리지 않는다 — 입력칸이 새로 만들어져 포커스가
       튀고, 시작일만 고른 중간 상태로 화면이 한 번 바뀐다. [조회]로 확정한다. */
    + '<button class="pt-btn pt-btn--go" type="button" id="ptApply">조회</button>'
    /* ★ 별도의 '전체 범위' 버튼은 두지 않는다 — 달력의 min 이 데이터 최초
       출원일이라, 과거까지 보고 싶으면 시작일을 직접 당겨 고르면 된다.
       안내에 고를 수 있는 범위를 적어 두는 것으로 갈음한다. */
    + (sp.from ? '<span class="pt-filter__h">' + escapeHtml(sp.from) + ' ~ '
      + escapeHtml(today) + ' 사이에서 고를 수 있습니다 (기본 '
      + escapeHtml(PT_DEFAULT_FROM) + '부터)</span>' : '')
    + '</div>';
}

/* ── 값 툴팁 ───────────────────────────────────────────────────────────────
   ★ SVG <title> 만 쓰면 브라우저 기본 툴팁에 맡기게 되어 늦게 뜨고, 모바일에서는
     아예 뜨지 않는다. data-tip 을 읽어 우리가 직접 띄운다.
   ★★ mouseover 뿐 아니라 click(탭)·focus 에도 반응한다 — 손가락으로도 값을 본다. */
function ptTipEl() {
  let t = document.getElementById('ptTip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'ptTip';
    t.className = 'pt-tip';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  return t;
}

function ptTipShow(target, x, y) {
  const msg = target.getAttribute('data-tip');
  if (!msg) return;
  const t = ptTipEl();
  t.textContent = msg;          // 한 줄 문구 — ' · ' 로 항목을 가른다
  t.classList.add('is-on');
  /* 화면 밖으로 나가지 않게 가둔다 — 오른쪽 끝 막대는 왼쪽으로 눕는다 */
  const w = t.offsetWidth, h = t.offsetHeight, pad = 10;
  let left = x + 14, top = y - h - 12;
  if (left + w + pad > window.innerWidth) left = x - w - 14;
  if (left < pad) left = pad;
  if (top < pad) top = y + 18;
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}

function ptTipHide() {
  const t = document.getElementById('ptTip');
  if (t) t.classList.remove('is-on');
}

/** 카드 안의 [data-tip] 요소에 툴팁을 붙인다. 다시 그려도 한 번만 배선된다. */
function wirePtTips(root) {
  if (!root || root.dataset.tipWired === '1') return;
  root.dataset.tipWired = '1';
  const near = (e) => (e.target && e.target.closest ? e.target.closest('[data-tip]') : null);
  root.addEventListener('mousemove', (e) => {
    const t = near(e);
    if (t) ptTipShow(t, e.clientX, e.clientY); else ptTipHide();
  });
  root.addEventListener('mouseleave', ptTipHide);
  // 탭(모바일)·클릭: 같은 것을 다시 누르면 닫는다
  root.addEventListener('click', (e) => {
    const t = near(e);
    if (!t) { ptTipHide(); return; }
    const tip = document.getElementById('ptTip');
    if (tip && tip.classList.contains('is-on') && tip.dataset.for === t.getAttribute('data-tip')) {
      ptTipHide(); return;
    }
    const r = t.getBoundingClientRect();
    ptTipShow(t, r.left + r.width / 2, r.top + r.height / 2);
    ptTipEl().dataset.for = t.getAttribute('data-tip');
  });
  root.addEventListener('focusin', (e) => {
    const t = near(e);
    if (!t) return;
    const r = t.getBoundingClientRect();
    ptTipShow(t, r.left + r.width / 2, r.top);
  });
  root.addEventListener('focusout', ptTipHide);
  window.addEventListener('scroll', ptTipHide, { passive: true });
}

/* ── 추세 안내 — 데이터가 말하게 한다 ─────────────────────────────────────
   ★ '2015년 이후 급감' 같은 문장을 코드에 박지 않는다. 수집 결과가 바뀌면
     그 문장이 거짓이 된다. 정점·최근 합계를 세어 그때그때 만든다.
   ★★ 최근 1~2년이 적은 것을 '급감'이라고만 쓰지 않는다 — 특허는 출원 뒤
     약 1년 6개월이 지나 공개되므로, 최근 연도는 아직 덜 잡힌다. 그 사실을
     같이 적지 않으면 없는 추세를 만들어 보여 주는 셈이 된다. */
function ptTrendNote(rows) {
  const yc = {};
  rows.forEach((r) => {
    const y = (r.date || '').slice(0, 4);
    if (y) yc[y] = (yc[y] || 0) + 1;
  });
  const years = Object.keys(yc).sort();
  if (years.length < 3) return '';
  let peak = years[0];
  years.forEach((y) => { if (yc[y] > yc[peak]) peak = y; });
  const thisYear = new Date().getFullYear();
  // 공개 지연이 걸리는 최근 2년은 '덜 잡힌 구간'으로 따로 말한다
  const LAG = 2;
  const settled = years.filter((y) => Number(y) <= thisYear - LAG);
  const pending = years.filter((y) => Number(y) > thisYear - LAG);
  const last3 = settled.slice(-3);
  const avg = (ys) => (ys.length
    ? (ys.reduce((s2, y) => s2 + yc[y], 0) / ys.length) : 0);
  const early = settled.slice(0, Math.max(1, settled.length - 3));
  const dir = avg(last3) < avg(early) ? '줄어드는' : '늘어나는';
  const pendTxt = pending.length
    ? pending.map((y) => y + '년 ' + yc[y] + '건').join(' · ')
    : '';
  return '<div class="pt-trend">'
    + '<div class="pt-trend__h">특허 출원 흐름 — 있는 그대로</div>'
    + '<ul class="pt-trend__l">'
    + '<li>가장 많았던 해는 <b>' + peak + '년 ' + yc[peak] + '건</b>입니다.</li>'
    + '<li>공개가 마무리된 최근 3년(' + last3.join('·') + ')은 연평균 <b>'
    + avg(last3).toFixed(1) + '건</b>으로, 그 이전 평균(' + avg(early).toFixed(1)
    + '건)보다 ' + dir + ' 추세입니다.</li>'
    + (pendTxt ? '<li><b>' + escapeHtml(pendTxt) + '</b>은 아직 집계가 덜 된 구간입니다 — '
      + '특허는 출원 뒤 약 1년 6개월이 지나 공개되므로, 최근 연도의 낮은 수치를 '
      + '출원 감소로 읽으면 안 됩니다.</li>' : '')
    + '</ul></div>';
}

/* ── 오류 화면 ─────────────────────────────────────────────────────────── */
function ptErrorBox() {
  const d = _ptData || {};
  const probe = (d.probe && Array.isArray(d.probe.tries)) ? d.probe.tries : [];
  return '<div class="pt-err">'
    + '<div class="pt-err__h">특허 데이터를 불러오지 못했습니다</div>'
    + '<div class="pt-err__m">' + escapeHtml(d.reason || '알 수 없는 오류') + '</div>'
    + (probe.length ? '<div class="pt-err__d"><b>API 응답</b><ul>'
      + probe.map((t) => '<li><code>' + escapeHtml((t.keyParam || '') + ' · '
        + (t.path || '')) + '</code> — ' + escapeHtml(t.error || 'OK') + '</li>').join('')
      + '</ul></div>' : '')
    + ((d.errors && d.errors.length) ? '<div class="pt-err__d"><b>검색 오류</b><ul>'
      + d.errors.slice(0, 6).map((e) => '<li>' + escapeHtml((e.company || '') + ' / '
        + (e.variant || '') + ' (' + (e.scope || '') + '): ' + (e.error || '')) + '</li>').join('')
      + '</ul></div>' : '')
    + '<div class="pt-err__f">해결 순서 — ① .env 에 <code>KIPRIS_API_KEY</code> 설정'
    + ' ② <code>python kipris_patent.py --probe</code> 로 인증 확인'
    + ' ③ <code>python kipris_patent.py</code> 로 수집</div>'
    + '</div>';
}

/* ── 렌더 ──────────────────────────────────────────────────────────────── */
function renderPatent() {
  const el = document.getElementById('patentRoot');
  if (!el) return;
  let body;
  if (!_ptData) {
    body = '<div class="comp-todo"><span class="comp-todo__badge">준비중</span>'
      + ' [업데이트]를 눌러 데이터를 불러오세요</div>';
  } else if (_ptData.status !== 'ok') {
    body = ptErrorBox();
  } else {
    const r = ptRange();
    const cur = ptRows(r);
    const prev = ptRows(ptPrevRange(r));
    const ipcf = _ptData.ipcFilter || {};
    /* 집계 범위는 위쪽 안내 박스가 아니라 맨 아래 각주에서 한 줄로 밝힌다 */
    const scope = ipcf.enabled
      ? ' · 집계 범위: ' + (ipcf.label || ipcf.codes.join(', ')) + ' 분야'
      : '';
    body = ptRangeUi()
      + ptKpiCards(cur, prev)
      + ptTrendNote(cur)
      + '<div class="sm-wrap">'
      + ptYearly(cur)
      + '<div class="sm-grid2">' + ptTypes(cur) + ptTech(cur) + '</div>'
      + '<div class="sm-grid2">' + ptApplicants(cur) + ptWords(cur) + '</div>'
      /* ★ 국가별 지도·표는 잠시 뺀다 — 해외특허 API 권한이 열리기 전에는
         국내(KR) 하나만 찍혀 지도가 아무것도 말해 주지 않는다.
         ptCountries() 는 지우지 않고 남겨 뒀다. 해외 데이터가 들어오면
         이 줄의 주석을 풀기만 하면 된다. */
      // + ptCountries(cur)
      + ptRecent(cur)
      + '</div>'
      /* ★ 주황 안내 박스를 걷어냈다.
         - 해외특허 대기 안내: 해외 위젯(지도·비율 KPI)을 다 뺐으니 화면에서
           설명할 대상이 없다. 수집기의 foreignNote 는 그대로 두어 로그·JSON 에는
           남는다(왜 해외가 비었는지는 데이터 쪽에서 추적할 수 있어야 한다).
         - 자동 분류 정확도 안내: 내용은 유효하므로 지우지 않고 맨 아래 각주로
           옮긴다(경고 박스만큼 크게 말할 일은 아니다). */
      + ((_ptData.filteredOut && Object.keys(_ptData.filteredOut).length)
        ? '<div class="sm-foot">출원인 검색이 부분일치라 다른 기업이 섞여 옵니다 — '
          + escapeHtml(Object.keys(_ptData.filteredOut)
            .map((k) => k + ' ' + _ptData.filteredOut[k] + '건').join(', '))
          + ' 을 실제 출원인명 검증으로 제외했습니다.</div>'
        : '')
      + (_ptData.truncated ? '<div class="sm-foot">호출 상한에 걸려 일부 기업만 수집됐습니다'
        + ' — kipris_patent.py --max-calls 로 조정하세요.</div>' : '')
      + '<div class="comp-caption">데이터 출처: KIPRIS (특허정보검색서비스)' + scope
      + ' ※ 기간 및 항목은 설정에 따라 변경 가능합니다.'
      + (_ptData.lastUpdated ? ' · 수집 ' + escapeHtml(_ptData.lastUpdated) : '') + '</div>'
      + '<div class="comp-caption pt-fine">' + escapeHtml(_ptData.techNote
        || '기술분야 분류와 키워드 추출은 자동 키워드 매칭 기준이며, 완전히 정확하지 않을 수 있습니다.')
      + '</div>';
  }
  el.innerHTML = body;
  wirePatent();
  wirePtTips(el);
}

function wirePatent() {
  const root = document.getElementById('patentRoot');
  if (!root || root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  root.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'ptApply') { applyDates(); return; }
    const pg = e.target && e.target.closest ? e.target.closest('.pt-pg') : null;
    if (pg && !pg.disabled) {
      const k = parseInt(pg.getAttribute('data-ptpage'), 10);
      if (k >= 1) { _ptPage = k; renderPatent(); }
      return;
    }
    const chip = e.target && e.target.closest ? e.target.closest('.pt-chip') : null;
    if (chip) {
      _ptCo = chip.getAttribute('data-ptco') || '';
      _ptPage = 1;
      renderPatent();
      return;
    }
    // 필터 해제 버튼
    const clr = e.target && e.target.closest ? e.target.closest('[data-ptclear]') : null;
    if (clr) {
      const k = clr.getAttribute('data-ptclear');
      _ptPage = 1;
      if (k === 'all') ptClearFilters();
      else if (k === 'year') { _ptYear = ''; renderPatent(); }
      else if (k === 'kind') { _ptKind = ''; renderPatent(); }
      else if (k === 'cat') { _ptCat = ''; renderPatent(); }
      else if (k === 'co') { _ptCo = ''; renderPatent(); }
      return;
    }
    // 차트에서 고르기 — 도넛 조각·범례 / 연도 막대 / 기술분야 행 / 출원인 막대
    const pick = e.target && e.target.closest
      ? e.target.closest('[data-ptkind],[data-ptyear],[data-ptcat],[data-ptco]') : null;
    if (pick) {
      const py = pick.getAttribute('data-ptyear');
      const pc = pick.getAttribute('data-ptco');
      /* ★ 막대 세그먼트는 '그 해 · 그 기업' 한 칸이므로 두 축을 함께 켠다.
         같은 칸을 다시 누르면 둘 다 끈다(반쪽만 남으면 무엇을 보고 있는지 흐려진다). */
      if (py != null && pc != null) {
        if (_ptYear === py && _ptCo === pc) { _ptYear = ''; _ptCo = ''; }
        else { _ptYear = py; _ptCo = pc; }
        _ptPage = 1;
        renderPatent();
        return;
      }
      if (pick.hasAttribute('data-ptkind')) ptToggleFilter('kind', pick.getAttribute('data-ptkind'));
      else if (py != null) ptToggleFilter('year', py);
      else if (pick.hasAttribute('data-ptcat')) ptToggleFilter('cat', pick.getAttribute('data-ptcat'));
      else ptToggleFilter('co', pc);
      return;
    }
    const nob = e.target && e.target.closest ? e.target.closest('.pt-nobtn') : null;
    if (nob) ptOpenDetail(nob.getAttribute('data-appno'));
  });
  /* ★ [조회]를 눌러야 적용한다. 입력칸 값은 DOM 이 들고 있고, 누를 때 읽는다 —
     초안 상태를 자바스크립트에 따로 두면 둘이 어긋날 자리가 생긴다. */
  const applyDates = () => {
    const f = document.getElementById('ptFrom');
    const t = document.getElementById('ptTo');
    let a = (f && f.value) || '';
    let b = (t && t.value) || '';
    if (a && b && a > b) { const x = a; a = b; b = x; }   // 뒤집혀 들어오면 바로잡는다
    /* min/max 는 달력에서만 막힌다 — 값이 프로그램으로 들어오거나 직접 타이핑되면
       범위를 넘을 수 있으므로 여기서 한 번 더 가둔다. */
    const spc = ptDataSpan();
    const tdy = ptToday();
    if (b && b > tdy) b = tdy;
    if (a && spc.from && a < spc.from) a = spc.from;
    /* 기본값과 같은 날짜면 빈 값으로 둔다 — 빈 값 = '기본 기간'이라는 한 가지
       뜻만 갖게 해서, 나중에 기본값을 바꿔도 저장된 값이 어긋나지 않는다. */
    const def = ptDefaultRange();
    _ptFrom = (a && a !== def.from) ? a : '';
    _ptTo = (b && b !== def.to) ? b : '';
    _ptPage = 1;
    renderPatent();
  };
  root.addEventListener('keydown', (e) => {
    // 날짜칸에서 엔터 = 조회
    if (e.key === 'Enter' && e.target && (e.target.id === 'ptFrom' || e.target.id === 'ptTo')) {
      e.preventDefault(); applyDates(); return;
    }
    /* 차트에서 고르는 요소는 role="button" + tabindex 라 키보드로도 눌려야 한다 */
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target && e.target.closest
      ? e.target.closest('[data-ptkind],[data-ptyear],[data-ptcat],[data-ptco]') : null;
    if (!t) return;
    e.preventDefault();
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
