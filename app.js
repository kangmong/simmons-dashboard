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
 * loadCsv(path, opts) — CSV를 fetch + PapaParse로 로드한다.
 * @param {string} path         CSV 파일 경로
 * @param {object} [opts]       { papa?: object }
 * @returns {Promise<object[]>} 파싱된 행 배열
 */
async function loadCsv(path, opts = {}) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`CSV 로드 실패: ${path} (HTTP ${res.status})`);
  }
  const text = await res.text();
  return parseCsvText(text, opts);
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
const VIEWS = ['dashboard', 'simmons_news', 'material', 'competitor', 'domestic', 'fx', 'worldclock'];

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
async function loadDefaults() {
  await Promise.all(
    DATASETS.map(async (ds) => {
      if (STORE[ds.key] && STORE[ds.key].origin === 'upload') return;
      try {
        const rows = await loadCsv(ds.file);
        STORE[ds.key] = { rows, origin: 'default', file: ds.file };
      } catch (err) {
        STORE[ds.key] = { rows: [], origin: 'error', file: ds.file, message: String(err.message || err) };
      }
    })
  );
  renderUploadCards();
  refreshSections();
  updateResetState();
}

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

  renderUploadCards(); // 초기: 미로드 카드 표시 → loadDefaults()가 채움
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
    el.innerHTML = emptyState('데이터 없음');
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
  const body = hasData
    ? compMetricRow('매출', c.revenue, c.revenue_yoy, rate)
      + compMetricRow('순이익', c.net_income, c.net_income_yoy, rate)
    : '<div class="gco-empty">데이터 준비중</div>';
  return `<div class="gco-card" style="--c:${color}">
    <div class="gco-head">
      <div class="gco-logo"><span class="gco-logo__txt">${escapeHtml(c.ticker || c.name)}</span>${logoImg}</div>
      <div class="gco-id">
        <div class="gco-name">${escapeHtml(c.name)} <span class="gco-tk">(${escapeHtml(c.ticker)})</span></div>
        <div class="gco-qtr">${escapeHtml(c.quarter || '—')}</div>
      </div>
    </div>
    <div class="gco-body">${body}</div>
  </div>`;
}

/** 분기 매출 막대 (회사별 색). key=값 필드, fmt=포맷터, tkKey=티커/코드 필드 */
function compRevBars(companies, key, fmt, tkKey) {
  key = key || 'revenue'; fmt = fmt || fmtUsd; tkKey = tkKey || 'ticker';
  const withRev = companies.filter((c) => c[key] != null && c[key] > 0);
  if (!withRev.length) return '';
  const maxV = Math.max(...withRev.map((c) => c[key]));
  const bars = companies.map((c, i) => {
    const color = COMP_COLORS[i % COMP_COLORS.length];
    const v = c[key], tk = c[tkKey] || '';
    if (v == null) {
      return `<div class="gbar"><div class="gbar__head"><span>${escapeHtml(c.name)}</span><span class="gbar__val">—</span></div></div>`;
    }
    const pct = Math.max(2, (v / maxV) * 100);
    return `<div class="gbar">
      <div class="gbar__head"><span>${escapeHtml(c.name)} ${tk ? `<span class="gco-tk">(${escapeHtml(tk)})</span>` : ''}</span><span class="gbar__val">${escapeHtml(fmt(v))}</span></div>
      <div class="gbar__track"><div class="gbar__fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
    </div>`;
  }).join('');
  return `<h3 class="subhead">분기 매출 비교</h3><div class="gbars">${bars}</div>`;
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
        <div class="gco-qtr">${escapeHtml(c.quarter || '—')}</div>
      </div>
    </div>
    <div class="gco-body">${body}</div>
  </div>`;
}

/** 경쟁사 분석 전체 렌더 (국외 + 국내) */
function renderCompetitor() {
  const el = document.getElementById('compRoot');
  if (!el) return;
  const g = _competitors && _competitors.global;
  const rate = _competitors && _competitors.usd_krw_rate;
  const rateNote = (rate != null)
    ? `<div class="comp-fxnote">적용 환율: 1 USD = ${Math.round(rate).toLocaleString('ko-KR')}원</div>`
    : '';
  const globalHtml = (g && g.length)
    ? `<div class="gco-grid">${g.map((c, i) => compGlobalCard(c, i, rate)).join('')}</div>
       ${rateNote}
       ${compRevBars(g)}
       <div class="comp-caption">출처: SEC EDGAR</div>`
    : emptyState('국외 경쟁사 데이터 준비중');

  // 국내: 배열이면 카드+막대, 아니면 준비중/데이터 없음
  const k = _competitors && _competitors.korea;
  let koreaHtml;
  if (Array.isArray(k) && k.length) {
    koreaHtml = `<div class="gco-grid">${k.map(compKoreaCard).join('')}</div>
       ${compRevBars(k, 'revenue_krw', fmtKrwShort, 'code')}
       <div class="comp-caption">출처: 네이버 금융</div>`;
  } else if (k && k.status && k.status !== '준비중') {
    koreaHtml = '<div class="comp-todo"><span class="comp-todo__badge">데이터 없음</span> 네이버 금융 조회 실패</div>';
  } else {
    koreaHtml = '<div class="comp-todo"><span class="comp-todo__badge">준비중</span> 국내 브랜드 재무 (네이버 금융)</div>';
  }

  el.innerHTML = `
    <div class="comp-group">
      <div class="comp-group__head">국내 <span class="comp-group__tag">Korea</span></div>
      <div class="comp-group__sub">분기별 실적 (네이버 금융 · 자동 갱신)
        <span class="comp-group__desc">매출·순이익(원화) · 전년 동기 대비(YoY) 기준</span>
      </div>
      ${koreaHtml}
    </div>
    <div class="comp-group">
      <div class="comp-group__head">국외 <span class="comp-group__tag">Global</span></div>
      <div class="comp-group__sub">분기별 실적 (최근 10-Q · 자동 갱신)
        <span class="comp-group__desc">매출·순이익 · 전년 동기 대비(YoY) 기준 · SEC EDGAR</span>
      </div>
      ${globalHtml}
    </div>`;
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

/* ── 스폰지 주원료 시황 (ICIS Asia, 고정 데이터) ── */
const ICIS_DATA = {
  periods: ["2021-01","2021-02","2021-03","2021-04","2021-05","2021-06","2021-07","2021-08","2021-09","2021-10","2021-11","2021-12","2022-01","2022-02","2022-03","2022-04","2022-05","2022-06","2022-07","2022-08","2022-09","2022-10","2022-11","2022-12","2023-01","2023-02","2023-03","2023-04","2023-05","2023-06","2023-07","2023-08","2023-09","2023-10","2023-11","2023-12","2024-01","2024-02","2024-03","2024-04","2024-05","2024-06","2024-07","2024-08","2024-09","2024-10","2024-11","2024-12","2025-01","2025-02","2025-03","2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03","2026-04","2026-05","2026-06"],
  PPG: [2600,2600,2650,2550,2800,2600,2300,2450,2450,2350,2550,2300,2300,1900,2000,2000,1850,1850,1825,1300,1350,1600,1750,1400,1180,1500,1600,1600,1550,1395,1450,1435,1435,1450,1350,1350,1400,1370,1350,1400,1400,1388,1350,1320,1296,1299,1295,1266,1261,1250,1250,1182,1150,1156,1160,1194,1188,1224,1186,1191,1221,1209,1776,2110,1666,1350],
  TDI: [1900,1950,2800,2700,2500,2080,1900,2050,2150,2300,2450,2450,2450,2600,2950,3000,2900,2550,2600,2500,2550,2750,3000,2500,2600,2800,2650,2400,2450,2200,2200,2200,2050,2100,2050,1950,1950,2100,2100,2025,1960,1900,1880,1872,1800,1800,1800,1800,1850,1938,1808,1682,1680,1650,1740,1975,1825,1800,1700,1810,1825,1888,2500,2890,2563,2238],
  MDI: [2300,2600,3300,2900,2450,2200,2400,2600,2600,3000,2700,2500,2500,2800,2800,2700,2650,2400,2200,2050,1950,1950,1850,1600,1750,1850,2000,1900,1800,1775,1850,1930,1950,1900,1750,1750,1800,2100,2100,2063,2100,2163,2200,2175,2113,2200,2200,2100,2175,2238,2150,2010,1988,1925,1832,1817,1763,1686,1650,1765,1765,1750,2300,2920,2688,2375],
  PO: [2100,2100,2400,2350,2275,1850,1790,2070,2070,2240,2250,2070,1700,1800,1500,1450,1375,1330,1220,1050,1120,1250,1050,1050,1050,1150,1380,1165,1200,1210,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,965,948,920,903,915,920,904,907,910,925,955,962,994,1000,1355,1710,1713,1398],
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

// 그래프 아래 "주요 시황 원자재 링크" (클릭 시 새 탭)
const MATERIAL_LINKS = [
  { name: '글로벌 컨테이너 운임지수', desc: 'Freightos Baltic Index (FBX)', icon: '🚢',
    url: 'https://app.terminal.freightos.com/fbx?ticker=FBX&frequency=%22weekly%22' },
  { name: '제재목 (Lumber)', desc: 'Trading Economics Lumber', icon: '🪵',
    url: 'https://tradingeconomics.com/commodity/lumber' },
];

let _icisChart = null;
let _matReady = false;      // [업데이트] 누르기 전엔 빈 초기 상태
let _matYear = null;        // 선택된 연도('2021'~'2026' | 'all')
let _matUsdKrw = null;      // USD/KRW 환율(업데이트 시 확보)

// 해상 정시성(Sea-Intelligence) — 연도별 선 색상 + 상태
const SR_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SR_YEAR_COLORS = {
  '2021': '#94A3B8', '2022': '#3B82F6', '2023': '#12B981',
  '2024': '#F59E0B', '2025': '#8B5CF6', '2026': '#C8102E',
};
let _srData = null;   // {months, years:{...}} | {error:'reason'} | null
let _srYear = null;   // '2021'~'2026' | 'all'
let _srChart = null;

// 국제유가(PETRONET 월별 제품가) — 9개 유종 색상 + 상태
const OIL_COLORS = {
  gasoline95: '#C8102E', diesel005: '#12B981', naphtha: '#3B82F6',
};
const OIL_DEFAULT_ON = ['gasoline95', 'diesel005', 'naphtha']; // 남긴 3개 모두 기본 표시
const OIL_RANGES = [
  { key: '1y', label: '1년', months: 12 }, { key: '3y', label: '3년', months: 36 },
  { key: '5y', label: '5년', months: 60 }, { key: '10y', label: '10년', months: 120 },
  { key: 'all', label: '전체', months: null },
];
let _oilData = null;   // {rows:[{period,...}], series:[{key,label}], source, unit} | {error} | null
let _oilRange = null;  // 선택된 기간(null=미선택 → "기간을 선택하세요")
let _oilOn = null;     // Set(켜진 유종 key) — 최초 로드 시 OIL_DEFAULT_ON
let _oilChart = null;

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

  const oil = data && data.sections && data.sections.oil_prices;
  if (oil && oil.status === 'ok' && Array.isArray(oil.rows) && oil.rows.length) {
    _oilData = { rows: oil.rows, series: oil.series || [], source: oil.source, unit: oil.unit };
    if (!_oilOn) _oilOn = new Set(OIL_DEFAULT_ON);  // 기본 3개만 켜기(최초 1회)
  } else {
    _oilData = { error: (oil && oil.reason) || '데이터 없음' };
  }
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

/** 섹션 5 전체 렌더: 업데이트 전 안내 → 업데이트 후 연도 툴바 → 연도 선택 시 그래프 */
function renderMaterial() {
  const root = document.getElementById('materialRoot');
  if (!root) return;
  if (!_matReady) {
    root.innerHTML = emptyState('업데이트 버튼을 누르면 표시됩니다');
    return;
  }
  const years = ['2021', '2022', '2023', '2024', '2025', '2026', 'all'];
  const toolbar = `<div class="icis-years">${years.map((y) =>
    `<button class="icis-year${y === _matYear ? ' is-active' : ''}" data-year="${y}">${y === 'all' ? '전체' : y}</button>`).join('')}</div>`;

  let body;
  if (!_matYear) {
    body = '<div class="icis-prompt">연도를 선택하세요</div>';
  } else {
    const { periods, series } = icisViewData(_matYear);
    body = buildIcisChart(periods, series) + icisLatest(periods, series) + icisTermsTable();
  }

  root.innerHTML = `<div class="viz-root viz-figure icis-figure">
    <div class="viz-head"><div>
      <div class="viz-title">스폰지 주원료 시황 (ICIS Asia)</div>
      <div class="viz-sub">PPG·TDI·MDI·PO 월별 (USD/톤)</div>
    </div></div>
    ${toolbar}
    ${body}
    <div class="viz-tooltip" id="icisTooltip"></div>
    <div class="comp-caption">출처: ICIS Asia</div>
  </div>
  ${renderScheduleReliabilityHtml()}
  ${renderOilPricesHtml()}
  ${renderMaterialLinksHtml()}`;

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

  // 국제유가: 기간 칩 + 범례 토글
  const oilFig = root.querySelector('.oil-figure');
  if (oilFig) {
    const chipsEl = oilFig.querySelector('.oil-ranges');
    if (chipsEl) chipsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.oil-range');
      if (!b || b.disabled) return;  // 데이터 없으면 칩 비활성
      _oilRange = b.dataset.range;
      renderMaterial();
    });
    const legEl = oilFig.querySelector('.oil-legend');
    if (legEl) legEl.addEventListener('click', (e) => {
      const b = e.target.closest('.oil-leg');
      if (!b || !_oilOn) return;
      const k = b.dataset.key;
      if (_oilOn.has(k)) _oilOn.delete(k); else _oilOn.add(k);
      renderMaterial();
    });
    if (_oilData && !_oilData.error) wireOilChart();
  }
}

/** 4개 원료 월별 선그래프 SVG (null 구간 선 끊김) */
function buildIcisChart(periods, series) {
  const n = periods.length;
  if (!n || !series.length) return '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
  const singleYear = periods.every((p) => p.slice(0, 4) === periods[0].slice(0, 4));

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.08 || 100; ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = 720, H = 300, padL = 54, padR = 16, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${Math.round(val).toLocaleString('en-US')}</text>`;
  }).join('');

  const step = Math.max(1, Math.ceil(n / 8));
  const xticks = periods.map((p, i) => {
    if (!(i % step === 0 || i === n - 1)) return '';
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 18).toFixed(1)}" text-anchor="${a}" font-size="9.5" fill="var(--muted)">${escapeHtml(singleYear ? p.slice(5) + '월' : p)}</text>`;
  }).join('');

  const lines = series.map((s) => {
    let path = '', pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  // 각 데이터 점 표시
  const dots = series.map((s) => s.values.map((v, i) => v == null ? '' :
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.4" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1"/>`).join('')).join('');
  // 값 라벨: 연도별 보기(12개월)에서만 항상 표시. 시리즈별 위/아래 번갈아 배치로 겹침 완화
  const labels = singleYear ? series.map((s, si) => s.values.map((v, i) => {
    if (v == null) return '';
    const x = X(i), y = Y(v);
    let ly = (si % 2 === 0) ? y - 7 : y + 13;
    if (ly < padT + 8) ly = y + 13;
    if (ly > padT + plotH) ly = y - 7;
    return `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${s.color}">${Math.round(v).toLocaleString('en-US')}</text>`;
  }).join('')).join('') : '';

  const legend = `<div class="viz-legend">${series.map((s) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${s.color}"></span>${s.key}</span>`).join('')}</div>`;
  _icisChart = { periods, series, geom: { X, Y, n, W, padL } };

  return `${legend}
    <svg class="viz-svg icis-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="스폰지 주원료 시황">
      ${grid}${xticks}${lines}${dots}${labels}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="icis-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="icis-dots"></g>
      <rect class="icis-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 최신값 병기 (USD/톤 → ≈ 원/톤) + 적용 환율 */
function icisLatest(periods, series) {
  const rate = _matUsdKrw;
  const items = series.map((s) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) return { key: s.key, color: s.color, v: s.values[i] };
    return null;
  }).filter(Boolean);
  if (!items.length) return '';
  const rows = items.map((it) => {
    const krw = (rate != null) ? ` <span class="icis-krw">≈ 약 ${escapeHtml(fmtKrwShort(it.v * rate))}/톤</span>` : '';
    return `<span class="icis-latest__item"><span class="icis-dot" style="background:${it.color}"></span><b>${it.key}</b> ${it.v.toLocaleString('en-US')} USD/톤${krw}</span>`;
  }).join('');
  const rateNote = (rate != null)
    ? `<span class="icis-rate">적용 환율: 1 USD = ${Math.round(rate).toLocaleString('ko-KR')}원</span>` : '';
  return `<div class="icis-latest"><div class="icis-latest__head">최신값 ${rateNote}</div><div class="icis-latest__row">${rows}</div></div>`;
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

/* ── 해상 정시성 (Sea-Intelligence Global Schedule Reliability) ── */

/** 선택 연도에 맞춰 표시할 연도(선) 목록 구성 */
function srViewData(year) {
  const yrs = Object.keys(_srData.years).sort();
  const months = _srData.months;
  const pick = (year === 'all') ? yrs : yrs.filter((y) => y === year);
  const series = pick.map((y) => ({
    key: y,
    color: SR_YEAR_COLORS[y] || 'var(--slate)',
    values: (_srData.years[y] || []).slice(0, months.length),
  })).filter((s) => s.values.some((v) => v != null));
  return { months, series };
}

/** 해상 정시성 블록 HTML (ICIS와 동일 스타일: 연도 버튼 → 선그래프) */
function renderScheduleReliabilityHtml() {
  if (!_srData) return '';
  const head = `<div class="viz-head"><div>
      <div class="viz-title">해상 정시성 (Global Schedule Reliability)</div>
      <div class="viz-sub">월별 정시 도착 비율(%) · 연도별</div>
    </div></div>`;
  if (_srData.error) {
    return `<div class="viz-root viz-figure sr-figure">${head}
      <div class="chart-empty">데이터를 불러오지 못했습니다(사이트 접근 차단 가능)</div>
      <div class="comp-caption">출처: Sea-Intelligence</div>
    </div>`;
  }
  const years = Object.keys(_srData.years).sort().concat(['all']);
  const toolbar = `<div class="icis-years sr-years">${years.map((y) =>
    `<button class="icis-year sr-year${y === _srYear ? ' is-active' : ''}" data-year="${y}">${y === 'all' ? '전체' : y}</button>`).join('')}</div>`;

  let body;
  if (!_srYear) {
    body = '<div class="icis-prompt">연도를 선택하세요</div>';
  } else {
    const { months, series } = srViewData(_srYear);
    body = buildSrChart(months, series);
  }
  return `<div class="viz-root viz-figure sr-figure">${head}
    ${toolbar}
    ${body}
    <div class="viz-tooltip" id="srTooltip"></div>
    <div class="comp-caption">출처: Sea-Intelligence</div>
  </div>`;
}

/** 연도별 정시성(%) 선그래프 SVG (null 구간 선 끊김, 단일 연도 시 값 라벨) */
function buildSrChart(months, series) {
  const n = months.length;
  if (!n || !series.length) return '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
  const single = series.length === 1;

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.12 || 5; ymin = Math.max(0, ymin - yp); ymax = Math.min(100, ymax + yp);

  const W = 720, H = 300, padL = 46, padR = 16, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${Math.round(val)}%</text>`;
  }).join('');

  const xticks = months.map((m, i) =>
    `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 18).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="var(--muted)">${escapeHtml(m)}</text>`).join('');

  const lines = series.map((s) => {
    let path = '', pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  const dots = series.map((s) => s.values.map((v, i) => v == null ? '' :
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.4" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1"/>`).join('')).join('');

  // 값 라벨: 단일 연도 보기일 때만 각 점에 %(소수1자리) 표시
  const labels = single ? series[0].values.map((v, i) => {
    if (v == null) return '';
    const x = X(i), y = Y(v) - 8;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${series[0].color}">${v.toFixed(1)}%</text>`;
  }).join('') : '';

  const legend = `<div class="viz-legend">${series.map((s) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${s.color}"></span>${s.key}</span>`).join('')}</div>`;
  _srChart = { months, series, geom: { X, Y, n, W, padL } };

  return `${legend}
    <svg class="viz-svg sr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="해상 정시성">
      ${grid}${xticks}${lines}${dots}${labels}
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

/* ── 국제유가 (PETRONET 일일국제제품가격, 월별) ── */

/** 선택 기간(_oilRange)에 맞춰 rows 슬라이스(뒤에서 N개월) */
function oilSliceRows() {
  const rows = _oilData.rows;
  const r = OIL_RANGES.find((x) => x.key === _oilRange) || OIL_RANGES[OIL_RANGES.length - 1];
  if (!r.months || rows.length <= r.months) return rows;
  return rows.slice(rows.length - r.months);
}

/** 국제유가 블록 HTML (스폰지·해상정시성 카드와 동일 구조/클래스).
 *  다른 카드와 동일하게 업데이트 전에는 차트를 그리지 않고 빈 상태 문구 + 비활성 칩만 표시. */
function renderOilPricesHtml() {
  const head = `<div class="viz-head"><div>
      <div class="viz-title">국제유가 (PETRONET)</div>
      <div class="viz-sub">일일국제제품가격 · 월별 (USD/배럴)</div>
    </div></div>`;
  const cap = '<div class="comp-caption">출처: 한국석유공사 PETRONET</div>';
  const ok = _oilData && !_oilData.error && Array.isArray(_oilData.rows) && _oilData.rows.length;

  // 기간 칩 — 데이터 없으면 비활성(disabled)
  const chips = `<div class="icis-years oil-ranges">${OIL_RANGES.map((r) =>
    `<button class="icis-year oil-range${r.key === _oilRange ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-range="${r.key}"${ok ? '' : ' disabled'}>${r.label}</button>`).join('')}</div>`;

  let body;
  if (!_oilData) {                                   // 1) 데이터 없음
    body = '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>';
  } else if (_oilData.error) {
    body = '<div class="chart-empty">데이터를 불러오지 못했습니다 (PETRONET 접근 차단 가능)</div>';
  } else if (!_oilRange) {                            // 2) 데이터 있음 · 기간 미선택
    body = '<div class="icis-prompt">기간을 선택하세요</div>';
  } else {                                            // 3) 기간 선택됨 → 차트
    // 범례(3개) — 클릭 토글, 꺼진 항목은 흐리게
    const legend = `<div class="viz-legend oil-legend">${_oilData.series.map((s) => {
      const on = _oilOn && _oilOn.has(s.key);
      const color = OIL_COLORS[s.key] || 'var(--slate)';
      return `<button class="viz-legend__item oil-leg${on ? '' : ' is-off'}" data-key="${s.key}" type="button" aria-pressed="${on}">
        <span class="viz-legend__swatch" style="background:${on ? color : 'var(--muted)'}"></span>${escapeHtml(s.label)}</button>`;
    }).join('')}</div>`;
    body = `${legend}${buildOilChart(oilSliceRows())}<div class="viz-tooltip" id="oilTooltip"></div>`;
  }
  return `<div class="viz-root viz-figure oil-figure">${head}${chips}${body}${cap}</div>`;
}

/** 9개 유종 중 켜진 것만 월별 선그래프 (connectNulls: 결측은 건너뛰고 이어 그림, dot 없음) */
function buildOilChart(rows) {
  const n = rows.length;
  if (!n) { _oilChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const on = (_oilData.series || []).filter((s) => _oilOn && _oilOn.has(s.key));
  const series = on.map((s) => ({
    key: s.key, label: s.label, color: OIL_COLORS[s.key] || 'var(--slate)',
    values: rows.map((r) => (r[s.key] == null ? null : r[s.key])),
  }));
  const periods = rows.map((r) => r.period);
  if (!series.length) { _oilChart = null; return '<div class="chart-empty">범례에서 유종을 선택하세요.</div>'; }

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { _oilChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.1 || 5; ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = 720, H = 300, padL = 48, padR = 16, padT = 16, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--muted)">$${Math.round(val)}</text>`;
  }).join('');

  const TICKS = Math.min(7, n);
  const tickIdx = [];
  for (let k = 0; k < TICKS; k++) {
    const i = TICKS <= 1 ? 0 : Math.round((k / (TICKS - 1)) * (n - 1));
    if (!tickIdx.includes(i)) tickIdx.push(i);
  }
  const xticks = tickIdx.map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="${a}" font-size="9" fill="var(--muted)">${escapeHtml(periods[i])}</text>`;
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

  _oilChart = { periods, series, geom: { X, Y, n, W, padL } };

  return `<svg class="viz-svg oil-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="국제유가 월별">
      ${grid}${xticks}${lines}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="oil-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="oil-dots"></g>
      <rect class="oil-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 크로스헤어 + 툴팁 (연-월 · 유종 · $값) */
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

/** 주요 시황 원자재 링크 HTML */
function renderMaterialLinksHtml() {
  const cards = MATERIAL_LINKS.map((l) => `<a class="matlink" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">
    <span class="matlink__icon" aria-hidden="true">${l.icon}</span>
    <span class="matlink__txt">
      <span class="matlink__name">${escapeHtml(l.name)}</span>
      <span class="matlink__desc">${escapeHtml(l.desc)}</span>
    </span>
    <span class="matlink__go" aria-hidden="true">↗</span>
  </a>`).join('');
  return `<h3 class="subhead matlink-head">주요 시황 원자재 링크</h3><div class="matlink-grid">${cards}</div>`;
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
    const initial = brand ? brand.charAt(0) : '·';
    const imgTag = img
      ? `<img class="dom-thumb__img" src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const tag = url ? 'a' : 'div';
    const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="dom-item${url ? '' : ' dom-item--nolink'}"${attrs}>
      <div class="dom-thumb" style="--dom-c:${color}">
        <span class="dom-thumb__ini">${escapeHtml(initial)}</span>
        ${imgTag}
      </div>
      <div class="dom-item__body">
        <h3 class="dom-item__title"><span class="dom-brand" style="color:${color}">[${escapeHtml(brand)}]</span> ${escapeHtml(title)}</h3>
        <div class="dom-item__meta">${escapeHtml(meta)}</div>
      </div>
    </${tag}>`;
  }).join('');
}

/** 한 소그룹(국내/국외) 렌더: 소제목 + 대표 상품 3개 + 기사 목록 */
function brandGroupHtml(title, tag, items, featured, colors, emptyMsg) {
  const head = `<div class="comp-group__head">${escapeHtml(title)}${tag ? ` <span class="comp-group__tag">${escapeHtml(tag)}</span>` : ''}</div>`;
  if (!items || !items.length) return `<div class="brand-group">${head}${emptyState(emptyMsg)}</div>`;
  const featList = (featured && featured.length) ? featured : items.slice(0, 3);
  return `<div class="brand-group">
    ${head}
    <div class="dom-feature"><div class="dom-feature__head">대표 출시 상품</div>
      <div class="dom-feature__grid">${brandFeatureCards(featList, colors)}</div></div>
    <div class="dom-divider"></div>
    ${brandListItems(items, colors)}
  </div>`;
}

/** 국내외 브랜드 신제품 렌더: 국내 + 국외(Global) 두 소그룹 */
function renderBrands() {
  const el = document.getElementById('domesticList');
  if (!el) return;
  const hasKor = _domestic && _domestic.length;
  const hasGlo = _globalBrands && _globalBrands.length;
  if (!hasKor && !hasGlo) { el.innerHTML = emptyState('브랜드 신제품 데이터 준비중'); return; }
  const kor = brandGroupHtml('국내', '', _domestic, _domesticFeatured, DOM_BRAND_COLORS, '국내 브랜드 신제품 준비중');
  const glo = brandGroupHtml('국외', 'Global', _globalBrands, _globalFeatured, DOM_BRAND_COLORS, '국외 브랜드 신제품 준비중');
  const foot = '<div class="dom-note">뉴스 기사 기반으로, 상품명·사진이 정확하지 않을 수 있습니다.</div>'
    + '<div class="comp-caption">출처: Google News</div>';
  el.innerHTML = kor + '<div class="brand-divider"></div>' + glo + foot;
}

/* ── 환율 (우리은행 스타일: USD·EUR·JPY 원화 시세표 + 기간별 추이) ── */
let _fx = null;        // { rows:[{cur,now,change,prev}], series:{dates,USD,EUR,JPY}, source }
let _fxCur = null;     // 선택 통화(USD|EUR|JPY). null=미선택
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

/** 원화 시세 포맷: 천단위 콤마 + 소수 2자리 */
function fxNum(v) {
  return (v == null) ? '—' : Number(v).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 환율 섹션 렌더: 상단 시세표 + 기간 버튼 + 추이 그래프 */
function renderFx() {
  const el = document.getElementById('body-fx');
  if (!el) return;
  const note = '<div class="fx-note">원/달러·원/유로·원/엔 시세. 수입 원자재·설비 결제 시 원가 부담을 가늠할 수 있습니다.</div>';
  if (!_fx || !Array.isArray(_fx.rows) || !_fx.rows.length) {
    el.innerHTML = emptyState('환율 데이터 준비중') + note;
    return;
  }

  // 1) 상단 시세표
  const rowByCur = {};
  _fx.rows.forEach((r) => { rowByCur[r.cur] = r; });
  const trs = FX_CURS.map((cur) => {
    const r = rowByCur[cur]; if (!r) return '';
    const m = FX_META[cur], c = r.change;
    const chg = (c == null)
      ? '<span class="fxr-flat">—</span>'
      : `<span class="fxr-chg ${c > 0 ? 'up' : c < 0 ? 'down' : 'fxr-flat'}">${c > 0 ? '▲' : c < 0 ? '▼' : ''} ${fxNum(Math.abs(c))}</span>`;
    return `<tr>
      <td class="fxr-cur"><span class="fxr-dot" style="background:${m.color}"></span><b>${m.label}</b> <span class="fxr-sub">${m.sub}</span></td>
      <td class="fxr-now">${fxNum(r.now)}</td>
      <td>${chg}</td>
      <td class="fxr-prev">${fxNum(r.prev)}</td>
    </tr>`;
  }).join('');
  const table = `<div class="fxr-wrap"><table class="fxr-table">
    <thead><tr><th>통화</th><th>현재기준율</th><th>전일대비</th><th>전일기준율</th></tr></thead>
    <tbody>${trs}</tbody>
  </table></div>`;

  // 2) 통화 칩(1줄) + 기간 칩(2줄) — 두 값을 조합해 단일 통화 추이를 그림
  const curChips = `<div class="icis-years fx-curs">${[...FX_CURS, 'all'].map((cur) => {
    const label = (cur === 'all') ? '전체' : `${FX_META[cur].name}(${FX_META[cur].label})`;
    return `<button class="icis-year fx-cur${cur === _fxCur ? ' is-active' : ''}" data-cur="${cur}">${escapeHtml(label)}</button>`;
  }).join('')}</div>`;
  const months = [3, 6, 9, 12];
  const monChips = `<div class="icis-years fx-months">${months.map((mm) =>
    `<button class="icis-year fx-month${mm === _fxMonths ? ' is-active' : ''}" data-months="${mm}">${mm}개월</button>`).join('')}</div>`;

  let chartBody, sub;
  if (!_fxCur || !_fxMonths) {   // 통화·기간 중 하나라도 미선택 → 안내
    _fxChart = null;
    sub = '통화와 기간을 선택하세요';
    chartBody = '<div class="icis-prompt">통화와 기간을 선택하세요</div>';
  } else if (_fxCur === 'all') { // 전체: 세 통화 동시 표시(범례 O)
    sub = '원/달러 · 원/유로 · 원/엔 (100엔 기준)';
    chartBody = buildFxChart(fxSlice(_fxMonths), 'all')
      + '<div class="fx-jpy-note">* JPY는 100엔 단위</div>';
  } else {                       // 단일 통화(범례 X)
    const m = FX_META[_fxCur];
    sub = `${m.name}(${m.label}) · 원${_fxCur === 'JPY' ? ' (100엔 기준)' : ''}`;
    chartBody = buildFxChart(fxSlice(_fxMonths), _fxCur)
      + (_fxCur === 'JPY' ? '<div class="fx-jpy-note">* JPY는 100엔 단위</div>' : '');
  }

  el.innerHTML = `
    ${table}
    ${note}
    <div class="viz-root viz-figure fx-figure">
      <div class="viz-head"><div>
        <div class="viz-title">원화 환율 추이</div>
        <div class="viz-sub">${escapeHtml(sub)}</div>
      </div></div>
      ${curChips}
      ${monChips}
      ${chartBody}
      <div class="viz-tooltip" id="fxTooltip"></div>
      <div class="comp-caption">출처: Frankfurter (ECB 기반)</div>
    </div>`;

  const curEl = el.querySelector('.fx-curs');
  if (curEl) curEl.addEventListener('click', (e) => {
    const b = e.target.closest('.fx-cur');
    if (!b) return;
    _fxCur = b.dataset.cur;      // 단일 선택(이전 선택 자동 해제), 기간은 유지
    renderFx();
  });
  const mEl = el.querySelector('.fx-months');
  if (mEl) mEl.addEventListener('click', (e) => {
    const b = e.target.closest('.fx-month');
    if (!b) return;
    _fxMonths = parseInt(b.dataset.months, 10);  // 통화는 유지
    renderFx();
  });
  if (_fxCur && _fxMonths) wireFxInteraction();
}

/** series를 최근 N개월로 슬라이스 */
function fxSlice(months) {
  const empty = { dates: [], USD: [], EUR: [], JPY: [] };
  const s = _fx && _fx.series;
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
  const isAll = cur === 'all';
  const curList = isAll ? FX_CURS : [cur];
  const series = curList.map((c) => ({ key: c, color: FX_META[c].color, values: slice[c] || [] }))
    .filter((sr) => sr.values.some((v) => v != null));
  if (!series.length) { _fxChart = null; return '<div class="chart-empty">추이 데이터가 없습니다.</div>'; }

  // Y축: 통화별 자릿수가 달라 고정 금지 → 데이터 min/max 기준 + 여유(변동이 평평해지지 않게)
  const all = series.flatMap((sr) => sr.values).filter((v) => v != null);
  let ymin = Math.min(...all), ymax = Math.max(...all);
  if (ymin === ymax) { const d = Math.abs(ymin) * 0.05 || 1; ymin -= d; ymax += d; }
  const yp = (ymax - ymin) * 0.14 || 10; ymin -= yp; ymax += yp;

  const W = 720, H = 280, padL = 52, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--muted)">${Math.round(val).toLocaleString('ko-KR')}</text>`;
  }).join('');

  const TICKS = Math.min(6, n);
  const tickIdx = [];
  for (let k = 0; k < TICKS; k++) {
    const i = TICKS <= 1 ? 0 : Math.round((k / (TICKS - 1)) * (n - 1));
    if (!tickIdx.includes(i)) tickIdx.push(i);
  }
  const xticks = tickIdx.map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="${a}" font-size="9" fill="var(--muted)">${escapeHtml(dates[i].slice(0, 7))}</text>`;
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
  { ko: '카이로', tz: 'Africa/Cairo', lat: 30.04, lon: 31.24, dir: 'se' },
  { ko: '요하네스버그', tz: 'Africa/Johannesburg', lat: -26.20, lon: 28.05, dir: 's' },
  { ko: '뉴욕', tz: 'America/New_York', lat: 40.71, lon: -74.01, dir: 'e' },
  { ko: '시카고', tz: 'America/Chicago', lat: 41.88, lon: -87.63, dir: 'w' },
  { ko: '로스앤젤레스', tz: 'America/Los_Angeles', lat: 34.05, lon: -118.24, dir: 's' },
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
    return `<button class="wc-mk wc-${c.dir}" data-i="${i}" type="button"
        style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%" aria-label="${escapeHtml(c.ko)}">
        <span class="wc-dot"></span><span class="wc-name">${escapeHtml(c.ko)}</span>
      </button>`;
  }).join('');
  root.innerHTML = `<div class="wc-map">
      <img class="wc-map__img" src="world-map.svg" alt="" aria-hidden="true">
      <div class="wc-markers">${dots}</div>
      <div class="wc-tip" id="wcTip" hidden></div>
    </div>
    ${wcTableHtml()}
    <div class="comp-caption">출처: Open-Meteo</div>`;
  wcWire();
  wcTick();
}

/** 하단 비교 표(서울 기준 시차 동→서 정렬). tbody는 wcTick가 매 틱 갱신 */
function wcTableHtml() {
  return `<div class="wc-tablewrap"><table class="wc-table">
    <thead><tr><th>도시</th><th>현재 시각</th><th>날짜</th><th>서울 대비</th><th>날씨</th></tr></thead>
    <tbody id="wcTableBody"></tbody>
  </table></div>`;
}

/** 매 틱(30초): 마커 주야 구분 + 하단 표 + 열린 툴팁 갱신 */
function wcTick() {
  const root = document.getElementById('worldclockRoot');
  if (!root || !_wcShown) return;
  const now = new Date();
  const seoulOff = wcOffsetMin(wcParts('Asia/Seoul', now), now);
  // 마커 주야 색
  root.querySelectorAll('.wc-mk').forEach((mk) => {
    const st = wcState(+mk.dataset.i, now, seoulOff);
    const night = (st.h >= 19 || st.h < 6);
    mk.classList.toggle('is-night', night);
    mk.classList.toggle('is-day', !night);
  });
  // 하단 표(시차 동→서 = diffMin 내림차순)
  const body = root.querySelector('#wcTableBody');
  if (body) {
    const rows = WORLD_CITIES.map((c, i) => ({ i, c, st: wcState(i, now, seoulOff) }))
      .sort((a, b) => b.st.diffMin - a.st.diffMin);
    body.innerHTML = rows.map(({ i, c, st }) => {
      const w = _wcWeather && _wcWeather[i];
      const wx = w ? `${wmoIcon(w.code)} ${w.temp != null ? Math.round(w.temp) + '°' : '—'}` : '—';
      return `<tr data-i="${i}"><td class="wc-tc-city">${escapeHtml(c.ko)}</td>
        <td class="wc-tc-num">${st.timeStr}</td><td class="wc-tc-num">${st.dateStr}</td>
        <td class="wc-tc-num">${wcOffsetLabel(st.diffMin)}</td><td>${wx}</td></tr>`;
    }).join('');
  }
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
  markers.addEventListener('click', (e) => {
    const mk = e.target.closest('.wc-mk'); if (!mk) return;
    const i = +mk.dataset.i;
    if (_wcOpen === i) { _wcOpen = null; wcHideTip(); }
    else { _wcOpen = i; wcShowTip(i, true); }
    e.stopPropagation();
  });
  // 바깥 탭/클릭 → 닫기
  document.addEventListener('click', wcOutside);
  // 표 행 hover → 지도 마커 강조
  const body = root.querySelector('#wcTableBody');
  if (body) {
    body.addEventListener('mouseover', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const mk = root.querySelector(`.wc-mk[data-i="${tr.dataset.i}"]`);
      if (mk) mk.classList.add('is-hi');
    });
    body.addEventListener('mouseout', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      if (_wcOpen != null) return;
      const mk = root.querySelector(`.wc-mk[data-i="${tr.dataset.i}"]`);
      if (mk) mk.classList.remove('is-hi');
    });
  }
}

/** 지도 바깥 클릭 시 핀 툴팁 닫기 */
function wcOutside(e) {
  const root = document.getElementById('worldclockRoot');
  if (!root || _wcOpen == null) return;
  if (e.target.closest('.wc-mk') || e.target.closest('#wcTip')) return;
  _wcOpen = null; wcHideTip();
}

/** [업데이트]에 연결: Open-Meteo로 15개 도시 날씨 1회 요청 → 마커 표시.
 *  실패해도 마커·시계는 뜨고 기온만 '—'. */
async function updateWorldWeather() {
  // 먼저 마커부터 표시(시계 동작 보장). 날씨는 도착하면 채우고, 실패/지연이면 '—' 유지
  _wcShown = true;
  _wcWeather = null;
  renderWorldClock();
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
  renderWorldClock();  // 날씨 반영해 재렌더(실패 시 '—')
}

/** [초기화]: 마커 제거하고 회색 지도 + 안내 상태로 */
function resetWorldClock() {
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
  renderCompetitor();
  renderBrands();
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
  _matReady = false; _matYear = null; _matUsdKrw = null; // 원자재: 업데이트 전 초기 상태
  _srData = null; _srYear = null; _srChart = null;       // 해상 정시성 비우기
  _oilData = null; _oilRange = null; _oilOn = null; _oilChart = null; // 국제유가 비우기
  _domestic = null; _domesticFeatured = null;       // 국내 브랜드 비우기
  _globalBrands = null; _globalFeatured = null;     // 국외 브랜드 비우기
  _competitors = null;      // 경쟁사(국외 SEC) 데이터 비우기
  _fx = null;           // 환율 비우기
  _fxChart = null;      // 환율 추이 차트 캐시 비우기
  _fxCur = null;        // 선택 통화 미선택으로 리셋
  _fxMonths = null;     // 환율 추이 기간 미선택 상태로 리셋
  // "마지막 업데이트" 텍스트 되돌리기
  const lbl = document.getElementById('lastUpdated');
  if (lbl) lbl.textContent = '아직 업데이트하지 않았습니다';
  const dashUpd = document.getElementById('dashUpdated');
  if (dashUpd) dashUpd.textContent = '—';
  resetWorldClock();  // 세계 시간: 마커 제거 → 회색 지도 + 안내
  // 원자재·시장·경쟁사·뉴스 재렌더(빈 STORE → emptyState/데이터 부족)
  refreshSections();
}

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
    updateWorldWeather();  // 세계 시간: Open-Meteo 날씨(서버 /api/update와 독립) → 마커 표시
    try {
      const res = await fetch(API_BASE + '/api/update', { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (lbl && data.updated_at) lbl.textContent = '마지막 업데이트: ' + data.updated_at;
      const dashUpd = document.getElementById('dashUpdated');
      if (dashUpd && data.updated_at) dashUpd.textContent = data.updated_at;
      applyFxUpdate(data);
      applyMaterialUpdate(data);
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
