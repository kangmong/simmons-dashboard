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
const VIEWS = ['dashboard', 'market', 'competitor', 'news', 'material', 'fx', 'insights'];

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

  // Leaflet 지도는 컨테이너 크기가 바뀌면(대시보드↔포커스) 재계산 필요
  if ((isDash || view === 'market') && _leaflet && _leaflet.map) {
    setTimeout(() => { try { _leaflet.map.invalidateSize(); } catch (e) {} }, 120);
  }
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

const _marketState = { metric: null };
let _worldTopoPromise = null;
function loadWorldTopo() {
  if (_worldTopoPromise) return _worldTopoPromise;
  _worldTopoPromise = fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
    .then((r) => { if (!r.ok) throw new Error('map HTTP ' + r.status); return r.json(); });
  return _worldTopoPromise;
}

/* ── 해외 시장 현황: World Bank 단계구분도 (Leaflet) ─────────────────────
   매트리스 시장 "규모"가 아니라 수요 잠재력 지표(인구·소득·소비). API 키 불필요. */
let _wbMarket = null;      // { consumer_power:{...}, consumption:{...}, population:{...}, gdp_percap:{...} }
let _wbMetric = 'consumer_power';  // 기본값: 가구 소비력
let _leaflet = null;       // { map, layer, geojson }
let _worldGeoPromise = null;

const CRIMSON_RAMP = ['#FDECEE', '#F7B9C1', '#EE8290', '#E24A5E', '#C8102E', '#8E0B20'];
const NODATA_COLOR = '#E5E8ED';

/** 응답의 market 를 저장하고 지도 갱신 */
function applyMarketUpdate(data) {
  const mk = data && data.sections && data.sections.market;
  if (!mk) return;
  if (mk.status === 'error') { _wbMarket = null; console.warn('[update] market error:', mk.reason); }
  else {
    _wbMarket = mk.indicators || null;
    const keys = _wbMarket ? Object.keys(_wbMarket) : [];
    if (keys.length && !keys.includes(_wbMetric)) _wbMetric = keys[0];
  }
  renderMarket();
}

/** 응답의 news(Google News RSS)를 저장하고 뉴스 섹션 갱신 */
function applyNewsUpdate(data) {
  const nw = data && data.sections && data.sections.news;
  if (!nw) return;
  if (nw.status === 'error') { _liveNews = null; console.warn('[update] news error:', nw.reason); }
  else { _liveNews = nw.items || []; }
  renderNews();
}

/** world countries GeoJSON (feature.id = ISO3) — 1회 로드 캐시 */
function loadWorldGeo() {
  if (_worldGeoPromise) return _worldGeoPromise;
  _worldGeoPromise = fetch('https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json')
    .then((r) => { if (!r.ok) throw new Error('geojson HTTP ' + r.status); return r.json(); });
  return _worldGeoPromise;
}

/** Leaflet 지도 1회 생성 (밝은 OSM 기반 베이스맵) */
function ensureLeafletMap() {
  if (_leaflet && _leaflet.map) return _leaflet;
  const el = document.getElementById('wbMap');
  if (!el || typeof L === 'undefined') return null;
  el.innerHTML = '';
  const map = L.map(el, { minZoom: 1, maxZoom: 6, worldCopyJump: true, scrollWheelZoom: false })
    .setView([25, 10], 1.4);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap · © CARTO', subdomains: 'abcd', maxZoom: 6,
  }).addTo(map);
  _leaflet = { map, layer: null, geojson: null };
  return _leaflet;
}

/** 분위 임계값 (색상 개수만큼 균등 분포) */
function quantileBins(sorted, nColors) {
  const bins = [];
  if (!sorted.length) return bins;
  for (let i = 1; i < nColors; i++) {
    const idx = Math.floor((sorted.length * i) / nColors);
    bins.push(sorted[Math.min(idx, sorted.length - 1)]);
  }
  return bins;
}

/** iso3 값(만) 큰 숫자를 읽기 쉽게 (억/만 축약, 그 외 천단위) */
function fmtWbValue(v, unit) {
  if (v == null || !isFinite(v)) return '데이터 없음';
  const n = Math.round(v);
  if (unit === '명') {
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '억 명';
    if (n >= 1e4) return Math.round(n / 1e4).toLocaleString('ko-KR') + '만 명';
    return n.toLocaleString('ko-KR') + ' 명';
  }
  // USD 등
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  return (unit === 'USD' ? '$' : '') + n.toLocaleString('en-US') + (unit === 'USD' ? '' : ' ' + unit);
}

/** 섹션 2 전체 렌더: 지표 토글 + 단계구분도 (데이터 없으면 안내) */
function renderMarket() {
  const toggleEl = document.getElementById('wbToggle');
  const mapEl = document.getElementById('wbMap');
  if (!mapEl) return;

  if (!_wbMarket) {
    if (_leaflet && _leaflet.map) { _leaflet.map.remove(); _leaflet = null; }
    if (toggleEl) toggleEl.innerHTML = '';
    mapEl.innerHTML = '<div class="wb-placeholder">‘업데이트’를 누르면 World Bank 데이터로 세계 지도를 표시합니다</div>';
    return;
  }

  const ORDER = ['consumer_power', 'consumption', 'population', 'gdp_percap'];
  const keys = Object.keys(_wbMarket).sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (!keys.includes(_wbMetric)) _wbMetric = keys[0];
  if (toggleEl) {
    toggleEl.innerHTML = keys.map((k) =>
      `<button class="mkt-tab ${k === _wbMetric ? 'is-active' : ''}" data-metric="${escapeHtml(k)}">${escapeHtml(_wbMarket[k].label)}</button>`).join('');
  }
  if (mapEl.querySelector('.wb-placeholder')) mapEl.innerHTML = '';
  renderChoropleth();
}

/** 현재 지표로 나라별 색을 칠한다 */
async function renderChoropleth() {
  const lf = ensureLeafletMap();
  const mapEl = document.getElementById('wbMap');
  if (!lf) { if (mapEl) mapEl.innerHTML = '<div class="wb-placeholder">지도를 불러오지 못했습니다 (Leaflet 로드 실패)</div>'; return; }

  let geo = lf.geojson;
  if (!geo) {
    try { geo = await loadWorldGeo(); lf.geojson = geo; }
    catch (e) { if (mapEl) mapEl.innerHTML = '<div class="wb-placeholder">지도 데이터를 불러오지 못했습니다 (오프라인?)</div>'; return; }
  }
  if (!_wbMarket || !_wbMarket[_wbMetric]) return;

  const ind = _wbMarket[_wbMetric];
  const data = ind.data || {};
  const isoOf = (f) => f.id || (f.properties && (f.properties.iso_a3 || f.properties.ISO_A3));

  // 색 스케일: 지도에 실제 있는 국가값만으로 분위 계산 (집계·미매칭 제외)
  const vals = [];
  geo.features.forEach((f) => { const v = data[isoOf(f)]; if (v != null && isFinite(v)) vals.push(v); });
  vals.sort((a, b) => a - b);
  const bins = quantileBins(vals, CRIMSON_RAMP.length);
  const colorFor = (v) => {
    if (v == null || !isFinite(v)) return NODATA_COLOR;
    let i = 0; while (i < bins.length && v > bins[i]) i++;
    return CRIMSON_RAMP[Math.min(i, CRIMSON_RAMP.length - 1)];
  };

  if (lf.layer) { lf.map.removeLayer(lf.layer); lf.layer = null; }
  lf.layer = L.geoJSON(geo, {
    style: (f) => {
      const v = data[isoOf(f)];
      return { fillColor: colorFor(v), fillOpacity: v == null ? 0.35 : 0.85, color: '#ffffff', weight: 0.5 };
    },
    onEachFeature: (f, layer) => {
      const v = data[isoOf(f)];
      const name = (f.properties && f.properties.name) || isoOf(f) || '';
      const yr = ind.year ? ' · ' + ind.year : '';
      layer.bindTooltip(
        `<b>${escapeHtml(name)}</b><br>${escapeHtml(ind.label)}: ${escapeHtml(fmtWbValue(v, ind.unit))}${escapeHtml(yr)}`,
        { sticky: true });
      layer.on('mouseover', () => layer.setStyle({ weight: 1.6, color: '#333333' }));
      layer.on('mouseout', () => { if (lf.layer) lf.layer.resetStyle(layer); });
    },
  }).addTo(lf.map);

  setTimeout(() => { if (_leaflet && _leaflet.map) _leaflet.map.invalidateSize(); }, 60);
}

/** 지표 토글 (인구 / 1인당 GDP / 가계소비지출) */
function initMarket() {
  const t = document.getElementById('wbToggle');
  if (!t) return;
  t.addEventListener('click', (e) => {
    const b = e.target.closest('.mkt-tab');
    if (!b) return;
    _wbMetric = b.dataset.metric;
    renderMarket();
  });
}

/* ============================================================
   3) 경쟁사 분석 섹션 — 매출 비교 막대 + 회사별 카드
   스키마: company,ticker,region,revenue_usd_bn,revenue_yoy_pct,operating_margin_pct,year,source
   ============================================================ */

/** 경쟁사 CSV 정규화 (빈 값은 null로 유지) */
function getCompetitorData() {
  const entry = STORE.competitor;
  if (!entry || !entry.rows.length) return null;
  return entry.rows
    .map((r) => ({
      company: String(r.company || '').trim(),
      ticker: String(r.ticker || '').trim(),
      region: String(r.region || '').trim(),
      revenue: num(r.revenue_usd_bn),
      yoy: num(r.revenue_yoy_pct),
      margin: num(r.operating_margin_pct),
      year: String(r.year || '').trim(),
      source: String(r.source || '').trim(),
    }))
    .filter((r) => r.company);
}

/** 상단: 매출 비교 막대 (revenue 내림차순, 1위=100%) */
function renderCompBars() {
  const el = document.getElementById('compBars');
  if (!el) return;
  const rows = getCompetitorData();
  if (!rows) { el.innerHTML = emptyState('경쟁사 데이터 준비중'); return; }
  const withRev = rows.filter((r) => r.revenue != null && r.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  if (!withRev.length) {
    el.innerHTML = `<h2 class="subhead">매출 비교</h2><div class="chart-empty">매출 데이터가 없습니다.</div>`;
    return;
  }
  const maxV = withRev[0].revenue;
  const bars = withRev.map((r) => {
    const pct = Math.max(2, (r.revenue / maxV) * 100);
    return `<div class="cbar">
      <div class="cbar__head">
        <span class="cbar__name">${escapeHtml(r.company)}</span>
        <span class="cbar__val">$${r.revenue.toFixed(2)}B</span>
      </div>
      <div class="cbar__track"><div class="cbar__fill" style="width:${pct.toFixed(1)}%"></div></div>
    </div>`;
  }).join('');
  el.innerHTML = `<h2 class="subhead">매출 비교</h2><div class="cbars">${bars}</div>`;
}

/** 하단: 회사별 카드 (3열). 빈 값 항목은 숨김 */
function renderCompCards() {
  const el = document.getElementById('compCards');
  if (!el) return;
  const rows = getCompetitorData();
  if (!rows) { el.innerHTML = ''; return; }
  el.innerHTML = rows.map((r) => {
    const sub = [r.ticker, r.region].filter(Boolean).join(' · ');
    const badge = r.source ? renderBadge(r.source) : '';

    let revHtml = '';
    if (r.revenue != null) {
      const yoyHtml = r.yoy != null
        ? `<span class="cc-yoy ${r.yoy >= 0 ? 'up' : 'down'}">${r.yoy >= 0 ? '▲' : '▼'} ${Math.abs(r.yoy).toFixed(1)}%</span>`
        : '';
      revHtml = `<div class="cc-metric">
        <div class="cc-metric__label">매출</div>
        <div class="cc-metric__value">$${r.revenue.toFixed(2)}B ${yoyHtml}</div>
      </div>`;
    }
    let marginHtml = '';
    if (r.margin != null) {
      marginHtml = `<div class="cc-metric">
        <div class="cc-metric__label">영업이익률</div>
        <div class="cc-metric__value ${r.margin < 0 ? 'cc-neg' : ''}">${r.margin.toFixed(1)}%</div>
      </div>`;
    }
    const body = (revHtml || marginHtml)
      ? `<div class="cc-metrics">${revHtml}${marginHtml}</div>`
      : `<div class="cc-empty">데이터 준비중</div>`;

    return `<div class="cc-card">
      <div class="cc-card__head">
        <div class="cc-card__id">
          <div class="cc-card__name">${escapeHtml(r.company)}</div>
          ${sub ? `<div class="cc-card__sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        ${badge}
      </div>
      ${body}
    </div>`;
  }).join('');
}

/** 출처·기준연도 캡션 (year 열에서 연도) */
function renderCompCaption() {
  const el = document.getElementById('compCaption');
  if (!el) return;
  const rows = getCompetitorData();
  if (!rows) { el.innerHTML = ''; return; }
  const years = [...new Set(rows.map((r) => r.year).filter(Boolean))].sort();
  const srcs = [...new Set(rows.map((r) => r.source).filter(Boolean))];
  const parts = [];
  if (srcs.length) parts.push(`출처: ${srcs.join(' · ')}`);
  if (years.length) parts.push(`${years.join('/')} 연간 기준`);
  el.innerHTML = parts.length ? `<div class="comp-caption">${escapeHtml(parts.join(' · '))}</div>` : '';
}

/* ── 실시간 경쟁사 (SEC EDGAR) ── */
let _liveCompetitors = null;
// 전역(:root) 토큰 사용 — 경쟁사 섹션은 .viz-root 밖이라 --series-* 는 해석되지 않음
const COMP_COLORS = ['var(--blue)', 'var(--green)', 'var(--amber)', 'var(--violet)'];

/** 큰 USD 금액 포맷: $X.XXB / $XXX.XM / $숫자 */
function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  const n = Number(v), a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

/** 응답의 competitors 저장 후 경쟁사 섹션 갱신 */
function applyCompetitorsUpdate(data) {
  const cp = data && data.sections && data.sections.competitors;
  if (!cp) return;
  if (cp.status === 'error') { _liveCompetitors = null; console.warn('[update] competitors error:', cp.reason); }
  else { _liveCompetitors = cp.companies || []; }
  renderCompetitor();
}

/** 매출 5년 추이 선그래프 (2개사, 실제 $ 축) */
function buildCompTrendSvg(companies) {
  const series = companies
    .map((c, i) => ({ name: c.name, color: COMP_COLORS[i % COMP_COLORS.length], trend: c.revenue_trend || { years: [], values: [] } }))
    .filter((s) => s.trend.values && s.trend.values.length);
  if (!series.length) return '<div class="chart-empty">매출 추이 데이터가 없습니다.</div>';

  const years = [...new Set(series.flatMap((s) => s.trend.years))].sort();
  series.forEach((s) => { s.byYear = new Map(s.trend.years.map((y, k) => [y, s.trend.values[k]])); });
  let maxV = 0;
  series.forEach((s) => s.trend.values.forEach((v) => { if (v > maxV) maxV = v; }));
  const yMax = niceMax(maxV * 1.1), yMin = 0;

  const W = 680, H = 260, padL = 56, padR = 16, padT = 20, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB, n = years.length;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const val = yMin + (yMax - yMin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${fmtUsd(val)}</text>`;
  }).join('');
  const xticks = years.map((yr, i) => `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--muted)">${escapeHtml(yr)}</text>`).join('');

  const lines = series.map((s) => {
    let path = '', pen = false; const dots = [], labels = [];
    years.forEach((yr, i) => {
      if (!s.byYear.has(yr)) { pen = false; return; }
      const v = s.byYear.get(yr), x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
      dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`);
      labels.push(`<text x="${x.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${s.color}">${fmtUsd(v)}</text>`);
    });
    return (path ? `<path d="${path.trim()}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>` : '') + dots.join('') + labels.join('');
  }).join('');

  const legend = `<div class="viz-legend">${series.map((s) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</span>`).join('')}</div>`;
  return `${legend}<svg class="viz-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="경쟁사 매출 추이">
    ${grid}${xticks}${lines}
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
  </svg>`;
}

/** 실시간 경쟁사 렌더: 재무 비교 + 매출 추이 + 공시 피드 */
function renderCompLive(companies) {
  const barsEl = document.getElementById('compBars');
  const cardsEl = document.getElementById('compCards');
  const capEl = document.getElementById('compCaption');

  // A) 재무 비교 (매출 막대 + 순이익)
  const withRev = companies.filter((c) => c.revenue != null);
  const maxRev = Math.max(...withRev.map((c) => c.revenue), 0) || 1;
  const bars = companies.map((c, i) => {
    const color = COMP_COLORS[i % COMP_COLORS.length];
    if (c.revenue == null) {
      return `<div class="cbar"><div class="cbar__head"><span class="cbar__name">${escapeHtml(c.name)} <span class="cc-card__sub">(${escapeHtml(c.ticker)})</span></span><span class="cbar__val">데이터 준비중</span></div></div>`;
    }
    const pct = Math.max(2, (c.revenue / maxRev) * 100);
    const ni = c.net_income != null ? `순이익 ${fmtUsd(c.net_income)}` : '순이익 —';
    return `<div class="cbar">
      <div class="cbar__head"><span class="cbar__name">${escapeHtml(c.name)} <span class="cc-card__sub">(${escapeHtml(c.ticker)})</span></span><span class="cbar__val">${fmtUsd(c.revenue)}</span></div>
      <div class="cbar__track"><div class="cbar__fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
      <div class="cbar__sub">${ni} · FY${escapeHtml(c.fy || '—')}</div>
    </div>`;
  }).join('');
  const fyLabel = (companies.find((c) => c.fy) || {}).fy || '';
  barsEl.innerHTML = `<h2 class="subhead">재무 요약${fyLabel ? ` (FY${escapeHtml(fyLabel)})` : ''}</h2>
    <div class="cbars">${bars}</div>
    <h2 class="subhead">매출 추이 (최근 5년)</h2>
    ${buildCompTrendSvg(companies)}`;

  // B) 재무 비교 표 (지표별 두 회사 비교, 더 나은 쪽 강조)
  if (cardsEl) cardsEl.innerHTML = buildCompTable(companies, fyLabel);
  if (capEl) capEl.innerHTML = '<div class="comp-caption">출처: SEC EDGAR</div>';
}

/** 재무 비교 표 — 지표(행) × 회사(열). 더 나은 쪽 강조 */
function buildCompTable(companies, fyLabel) {
  const cos = companies;
  const METRICS = [
    { key: 'revenue', label: '매출', type: 'money', better: 'high' },
    { key: 'operating_income', label: '영업이익', type: 'money', better: 'high' },
    { key: 'net_income', label: '순이익', type: 'money', better: 'high' },
    { key: 'operating_margin', label: '영업이익률', type: 'pct', better: 'high' },
    { key: 'net_margin', label: '순이익률', type: 'pct', better: 'high' },
    { key: 'assets', label: '총자산', type: 'money', better: 'high' },
    { key: 'liabilities', label: '총부채', type: 'money', better: 'low' },
    { key: 'equity', label: '자기자본', type: 'money', better: 'high' },
    { key: 'debt_ratio', label: '부채비율', type: 'pct', better: 'low' },
    { key: 'eps', label: '주당순이익(EPS)', type: 'eps', better: 'high' },
  ];
  const fmtVal = (m, v) => {
    if (v == null || !isFinite(v)) return '—';
    if (m.type === 'money') return fmtUsd(v);
    if (m.type === 'pct') return v.toFixed(1) + '%';
    if (m.type === 'eps') { const n = Number(v); return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2); }
    return String(v);
  };
  const bestIdx = (m) => {
    const valid = cos.map((c, i) => ({ v: c[m.key], i })).filter((o) => o.v != null && isFinite(o.v));
    if (valid.length < 2) return -1; // 비교 불가 → 강조 없음
    let best = valid[0];
    valid.forEach((o) => { if (m.better === 'low' ? o.v < best.v : o.v > best.v) best = o; });
    if (valid.filter((o) => o.v === best.v).length > 1) return -1; // 동점
    return best.i;
  };
  const head = `<tr><th>지표</th>${cos.map((c) =>
    `<th>${escapeHtml(c.name)}<span class="cmp-tk">${escapeHtml(c.ticker)}</span></th>`).join('')}</tr>`;
  const body = METRICS.map((m) => {
    const bi = bestIdx(m);
    const tds = cos.map((c, i) =>
      `<td class="${i === bi ? 'cmp-best' : ''}">${escapeHtml(fmtVal(m, c[m.key]))}</td>`).join('');
    return `<tr><th class="cmp-metric">${escapeHtml(m.label)}</th>${tds}</tr>`;
  }).join('');
  return `<h2 class="subhead">재무 비교 표${fyLabel ? ` — FY${escapeHtml(fyLabel)} 연간 기준` : ''}</h2>
    <div class="comp-fin-wrap"><table class="comp-fin">
      <thead>${head}</thead><tbody>${body}</tbody>
    </table></div>`;
}

/** 섹션 3 전체 렌더: 실시간(SEC) 우선, 없으면 CSV */
function renderCompetitor() {
  const barsEl = document.getElementById('compBars');
  if (!barsEl) return;
  if (_liveCompetitors && _liveCompetitors.length) { renderCompLive(_liveCompetitors); return; }
  renderCompBars();
  renderCompCards();
  renderCompCaption();
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

/** 필터 칩 그룹 HTML */
function filterGroup(label, group, values, active) {
  const chips = ['전체', ...values]
    .map((v) => `<button class="chip ${v === active ? 'is-active' : ''}" data-group="${group}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>`)
    .join('');
  return `<div class="news-filter-group"><span class="news-filter-label">${label}</span>${chips}</div>`;
}

/** 썸네일 이모지: region 국기 우선 → category 아이콘 → 기본(📰). 외부 이미지 미사용 */
function newsThumb(region, category) {
  const r = String(region || '').toLowerCase();
  const flag =
    /미국|usa|united states|u\.s|북미|north america/.test(r) ? '🇺🇸' :
    /유럽|europe|\beu\b|영국|독일|프랑스|germany|france|\buk\b/.test(r) ? '🇪🇺' :
    /중국|china|prc/.test(r) ? '🇨🇳' :
    /일본|japan/.test(r) ? '🇯🇵' :
    /한국|korea/.test(r) ? '🇰🇷' :
    /글로벌|global|world|전\s*세계/.test(r) ? '🌐' : null;
  if (flag) return flag;
  const c = String(category || '').toLowerCase();
  if (/신제품|제품|트렌드|product/.test(c)) return '🛏️';
  if (/시장|실적|매출|market|earnings|sales/.test(c)) return '📈';
  if (/m&a|인수|합병|merger|acquis/.test(c)) return '🤝';
  if (/규제|정책|regulation|policy/.test(c)) return '📋';
  if (/공급망|물류|supply/.test(c)) return '🚚';
  return '📰';
}

let _liveNews = null; // Google News RSS 실시간 항목 (업데이트 버튼)

/** 실시간 뉴스 항목 하나 렌더 (제목 클릭 → 원문 새 탭) */
function renderLiveNewsItem(it) {
  const url = safeUrl(it.link);
  const meta = [it.source, it.date].filter(Boolean).join(' · ');
  const tag = url ? 'a' : 'div';
  const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
  return `<${tag} class="news-item${url ? '' : ' news-item--nolink'}"${attrs}>
    <div class="news-thumb" aria-hidden="true">📰</div>
    <div class="news-item__body">
      <div class="news-item__top"><h3 class="news-item__title">${escapeHtml(it.title)}</h3></div>
      <div class="news-item__meta">${escapeHtml(meta)}</div>
    </div>
  </${tag}>`;
}

/** 뉴스 섹션: 실시간(Google News) 우선, 없으면 CSV, 없으면 준비중 */
function renderNews() {
  const listEl = document.getElementById('newsList');
  const aiEl = document.getElementById('newsAI');
  if (!listEl) return;

  // 1) 실시간 뉴스(업데이트 버튼)
  if (_liveNews && _liveNews.length) {
    listEl.innerHTML = _liveNews.map(renderLiveNewsItem).join('')
      + '<div class="comp-caption">출처: Google News</div>';
    if (aiEl) aiEl.innerHTML = renderNewsTranslations(_liveNews);
    return;
  }

  // 2) CSV 폴백
  const rows = (STORE.news ? STORE.news.rows.slice() : [])
    .sort((a, b) => String(b.date).localeCompare(String(a.date))); // 날짜 최신순

  if (!rows.length) {
    listEl.innerHTML = emptyState('뉴스 데이터 준비중');
    if (aiEl) aiEl.innerHTML = renderNewsAI([]);
    return;
  }

  listEl.innerHTML = rows.map((r) => {
    const url = safeUrl(r.url);
    const region = String(r.region || '').trim();
    const meta = [region, fmtDate(r.date)].filter(Boolean).join(' · ');
    const summary = String(r.summary || '').trim();
    const thumb = newsThumb(region, r.category);
    const badge = r.source ? renderBadge(r.source) : '';
    const tag = url ? 'a' : 'div';
    const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="news-item${url ? '' : ' news-item--nolink'}"${attrs}>
      <div class="news-thumb" aria-hidden="true">${thumb}</div>
      <div class="news-item__body">
        <div class="news-item__top">
          <h3 class="news-item__title">${escapeHtml(r.title)}</h3>
          ${badge}
        </div>
        <div class="news-item__meta">${escapeHtml(meta)}</div>
        ${summary ? `<div class="news-item__summary">${escapeHtml(summary)}</div>` : ''}
      </div>
    </${tag}>`;
  }).join('');

  if (aiEl) aiEl.innerHTML = renderNewsAI(rows);
}

/** 하단 "뉴스 한글 번역" 박스 — 각 뉴스 제목의 한국어 번역(title_ko)을 나열. 번역만, 요약 아님. */
function renderNewsTranslations(items) {
  const lines = (items || []).map((it) => it.title_ko || it.title).filter(Boolean);
  const has = lines.length > 0;
  const body = has
    ? lines.map((s) => `<span class="news-ai__line">· ${escapeHtml(s)}</span>`).join('')
    : '번역 준비중';
  const tag = has ? '<span class="news-ai__tag">자동번역</span>' : '<span class="news-ai__tag">준비중</span>';
  return `<div class="news-ai__label">뉴스 한글 번역 ${tag}</div>
    <div class="news-ai__body">${body}</div>`;
}

/** 하단 AI 요약 박스 — 지금은 summary 모음(최대 3줄), 없으면 "요약 준비중" (실제 AI는 추후 연결) */
function renderNewsAI(rows) {
  const summaries = rows.map((r) => String(r.summary || '').trim()).filter(Boolean).slice(0, 3);
  const body = summaries.length
    ? summaries.map((s) => `<span class="news-ai__line">· ${escapeHtml(s)}</span>`).join('')
    : '요약 준비중';
  return `<div class="news-ai__label">✨ AI 요약 <span class="news-ai__tag">준비중</span></div>
    <div class="news-ai__body">${body}</div>`;
}

/* ============================================================
   5) 원자재 원가 동향 섹션
   ============================================================ */

const MATERIAL_KO = {
  polyurethane_foam: '폴리우레탄 폼',
  memory_foam: '메모리폼',
  steel_spring: '스프링강',
  latex: '라텍스',
  cotton: '면',
  wool: '울',
};
const MAT_PALETTE = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

function matName(m) { return MATERIAL_KO[String(m).trim()] || String(m).replace(/_/g, ' '); }
function matUnit(u) { return String(u || '').replace(/_per_/i, '/').replace(/_/g, ' '); }
/** 값 라벨 소수 자릿수: 원유(배럴)=1, 그 외(kg·mmbtu 등)=2 */
function matDecimals(unit) { return /배럴|bbl|barrel/i.test(String(unit || '')) ? 1 : 2; }

/** x축용 짧은 날짜: YYYY-MM-DD→MM-DD, YYYY-MM→YY-MM, 그 외는 뒤 5자 */
function shortDate(d) {
  const s = String(d);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${m[1].slice(2)}-${m[2]}`;
  m = s.match(/^(\d{4})M(\d{2})$/); // World Bank 월간: 2024M06 → 24.06
  if (m) return `${m[1].slice(2)}.${m[2]}`;
  return s.length > 7 ? s.slice(-5) : s;
}

/** 느슨한 숫자 파싱: 콤마·%·공백 제거, FRED 결측치 "." → null */
function numLoose(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/[,%\s]/g, '');
  if (s === '' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 열이 대부분 숫자인지 (가격 열 자동 인식용) */
function isNumericColumn(rows, key) {
  let nonEmpty = 0, numeric = 0;
  for (const r of rows) {
    const s = String(r[key] == null ? '' : r[key]).trim();
    if (s === '' || s === '.') continue;
    nonEmpty++;
    if (numLoose(r[key]) != null) numeric++;
  }
  return nonEmpty > 0 && numeric >= nonEmpty * 0.7;
}

/** 다양한 CSV 스키마 → 우리 열(날짜/가격/변동/자재/단위/지역/출처) 자동 인식 */
function detectMaterialColumns(keys, rows) {
  const norm = (s) => String(s).trim().toLowerCase();
  const find = (cands) => {
    for (const c of cands) { const hit = keys.find((k) => norm(k) === norm(c)); if (hit) return hit; }
    return null;
  };
  const date = find(['date', '날짜', 'observation_date']);
  let price = find(['price', '종가', 'close', 'adj close', 'adjclose', '가격']);
  const change = find(['변동 %', '변동%', 'mom_change_pct', 'change %', 'change%', '전월대비', '전월대비 %']);
  const material = find(['material', '자재', '품목']);
  const unit = find(['unit', '단위']);
  const region = find(['region', '지역']);
  const source = find(['source', '출처']);

  const exclude = new Set([date, change, material, unit, region, source].filter(Boolean));
  if (!price) {
    // FRED류 시리즈코드형 열(예: WTISPLC, PCU3273...)이면 그 열을 가격으로
    price = keys.find((k) => !exclude.has(k) && /^[A-Z][A-Z0-9_.]{2,}$/.test(String(k).trim()) && isNumericColumn(rows, k)) || null;
  }
  if (!price) {
    // 숫자로만 채워진 첫 번째 열
    price = keys.find((k) => !exclude.has(k) && isNumericColumn(rows, k)) || null;
  }
  return { date, price, change, material, unit, region, source };
}

/** 자재명: material 열 없으면 파일명에서 유추, 그래도 못 찾으면 파일명 자체 */
function inferMaterialFromFilename(file) {
  const base = String(file || '').replace(/\.[^.]+$/, '');
  const l = base.toLowerCase();
  if (/wti|crude|oil|유가|원유/.test(l)) return '유가';
  if (/urethane|foam|우레탄|폼/.test(l)) return '우레탄';
  if (/steel|철강|스틸/.test(l)) return '철강';
  if (/rubber|latex|라텍스|고무/.test(l)) return '라텍스';
  return base || '원자재';
}

/** STORE.material을 자동 인식·정규화한 행 배열로 반환 (날짜+가격 못 찾으면 null) */
function getMaterialData() {
  const entry = STORE.material;
  if (!entry || !entry.rows.length) return null;
  const rows = entry.rows;
  const col = detectMaterialColumns(Object.keys(rows[0]), rows);
  if (!col.date || !col.price) return null; // 최소 날짜+가격이 있어야 함

  const inferred = inferMaterialFromFilename(entry.file);
  const norm = rows
    .map((r) => {
      const source = col.source ? String(r[col.source]).trim() : null;
      const price = numLoose(r[col.price]);
      return {
        date: String(r[col.date] == null ? '' : r[col.date]).trim(),
        material: col.material ? (String(r[col.material]).trim() || inferred) : inferred,
        price,
        change: col.change ? numLoose(r[col.change]) : null,
        unit: col.unit ? String(r[col.unit]).trim() : '',
        region: col.region ? String(r[col.region]).trim() : '',
        source,
        pending: source === '준비중' && price == null,
      };
    })
    .filter((r) => r.date !== '');

  // 변동 열이 없으면 자재별 날짜순으로 '이전 행 대비 %' 계산
  if (!col.change) {
    const groups = new Map();
    norm.forEach((r) => { if (!groups.has(r.material)) groups.set(r.material, []); groups.get(r.material).push(r); });
    groups.forEach((arr) => {
      arr.sort((a, b) => a.date.localeCompare(b.date));
      let prev = null;
      arr.forEach((r) => {
        if (r.price != null && prev != null && prev !== 0) r.change = ((r.price - prev) / prev) * 100;
        if (r.price != null) prev = r.price;
      });
    });
  }

  return { rows: norm, hasSource: !!col.source, hasChangeCol: !!col.change, col };
}

/** 변동률 → 화살표/색상/라벨 */
function momMeta(v) {
  const n = num(v);
  if (n == null) return { cls: 'mt-mom--flat', label: '—' };
  if (n > 0) return { cls: 'mt-mom--up', label: `▲ ${n.toFixed(1)}%` };
  if (n < 0) return { cls: 'mt-mom--down', label: `▼ ${Math.abs(n).toFixed(1)}%` };
  return { cls: 'mt-mom--flat', label: '0.0%' };
}

/** 자재별 최신가격/변동 카드 (자재별 최신 date 행 사용) */
function renderMaterialCards() {
  const el = document.getElementById('materialCards');
  if (!el) return;
  const data = getMaterialData();
  if (!data) {
    el.innerHTML = emptyState('원자재 가격 데이터 준비중');
    return;
  }

  // 자재별 최신 행
  const latest = new Map();
  data.rows.forEach((r) => {
    if (!r.material) return;
    const cur = latest.get(r.material);
    if (!cur || r.date.localeCompare(cur.date) >= 0) latest.set(r.material, r);
  });

  // 환율(fx) 재사용 — USD/KRW 쌍일 때만 원화 환산(그 외 쌍이면 환산 불가 → 생략)
  const fxRate = (_fx && _fx.pair === 'USD/KRW' && _fx.rate != null) ? _fx.rate : null;
  // "USD/배럴" → "원/배럴" (단위 뒷부분 그대로 유지)
  const krwUnit = (unit) => {
    const parts = String(unit || '').split('/');
    return parts.length > 1 ? '원/' + parts.slice(1).join('/') : '원';
  };
  const rateNote = fxRate != null
    ? `<div class="mt-fxrate">적용 환율: 1 USD = ${Math.round(fxRate).toLocaleString('ko-KR')}원${_fx.date ? ` (${escapeHtml(_fx.date)})` : ''}</div>`
    : '';

  el.innerHTML = rateNote + [...latest.values()]
    .map((r) => {
      const badge = r.source ? renderBadge(r.source) : '';
      if (r.pending) {
        return `<div class="mt-card mt-card--pending">
          <div class="mt-card__name"><span>${escapeHtml(matName(r.material))}</span>${badge}</div>
          <div class="mt-pending-text">데이터 준비중</div>
        </div>`;
      }
      const mom = momMeta(r.change);
      const unit = matUnit(r.unit);
      const krw = (fxRate != null && r.price != null)
        ? `<div class="mt-price-krw">≈ ${Math.round(r.price * fxRate).toLocaleString('ko-KR')}${escapeHtml(krwUnit(unit))}</div>`
        : '';
      return `<div class="mt-card">
        <div class="mt-card__name"><span>${escapeHtml(matName(r.material))}</span>${badge}</div>
        <div class="mt-card__price">
          <span class="mt-price-num">${r.price == null ? '—' : r.price.toLocaleString()}</span>
          ${unit ? `<span class="mt-price-unit">${escapeHtml(unit)}</span>` : ''}
        </div>
        ${krw}
        <div class="mt-card__foot">
          <span class="mt-mom ${mom.cls}">${mom.label}</span>
          <span class="mt-region">${escapeHtml(r.region || fmtDate(r.date))}</span>
        </div>
      </div>`;
    })
    .join('');
}

let _materialCharts = [];

/** 자재명 → 선 색 (기존 유지: 면=파랑, 원유=초록, 가스=주황, 고무=보라) */
function matColor(name, idx) {
  const n = String(name);
  if (/면|cotton/i.test(n)) return 'var(--series-1)';
  if (/원유|wti|crude|oil/i.test(n)) return 'var(--series-2)';
  if (/가스|gas/i.test(n)) return 'var(--series-3)';
  if (/고무|rubber|latex/i.test(n)) return 'var(--series-4)';
  return ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'][idx % 4];
}

/** 자재별 개별 라인차트 4개 (2×2). 각 차트는 자기 "실제 가격" y축으로 자동 스케일 */
function renderMaterialChart() {
  const host = document.getElementById('materialChart');
  if (!host) return;
  _materialCharts = [];
  const data = getMaterialData();
  const head = `<div class="viz-head"><div class="viz-title">자재별 가격 추이</div></div>`;
  if (!data) { host.innerHTML = `<div class="viz-root viz-figure">${head}${emptyState('원자재 가격 데이터 준비중')}</div>`; return; }

  const byMat = new Map();
  data.rows.forEach((r) => {
    if (r.pending || r.price == null) return;
    if (!byMat.has(r.material)) byMat.set(r.material, { material: r.material, unit: r.unit, points: [] });
    byMat.get(r.material).points.push({ date: r.date, price: r.price });
  });
  if (!byMat.size) { host.innerHTML = `<div class="viz-root viz-figure">${head}<div class="chart-empty">차트로 표시할 가격 데이터가 없습니다.</div></div>`; return; }

  const mats = [...byMat.values()];
  mats.forEach((s) => s.points.sort((a, b) => a.date.localeCompare(b.date)));
  const xCats = [...new Set(mats.flatMap((s) => s.points.map((p) => p.date)))].sort((a, b) => a.localeCompare(b));

  const W = 340, H = 200, padL = 42, padR = 14, padT = 26, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = xCats.length;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const xStep = Math.max(1, Math.ceil(n / 5));

  const minis = mats.map((s, idx) => {
    const color = matColor(s.material, idx);
    const dec = matDecimals(s.unit);
    const priceByDate = new Map(s.points.map((p) => [p.date, p.price]));
    const values = xCats.map((d) => (priceByDate.has(d) ? priceByDate.get(d) : null));

    // 실제 가격 y축 자동 스케일 (0 고정 아님)
    const prices = values.filter((v) => v != null);
    let ymin = Math.min(...prices), ymax = Math.max(...prices);
    if (ymin === ymax) { const dd = Math.abs(ymin) * 0.1 || 1; ymin -= dd; ymax += dd; }
    const yp = (ymax - ymin) * 0.18; ymin -= yp; ymax += yp;
    const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

    // y 그리드 3줄 + 실제 가격 라벨
    const grid = [0, 0.5, 1].map((t) => {
      const val = ymin + (ymax - ymin) * t;
      const y = Y(val);
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
        <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${val.toFixed(dec)}</text>`;
    }).join('');

    // x축 라벨 (24.01~24.12, 솎아서)
    const xticks = xCats.map((d, i) => {
      if (!(i % xStep === 0 || i === n - 1)) return '';
      return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--muted)">${escapeHtml(shortDate(d))}</text>`;
    }).join('');

    // 선 + 점
    let path = '', pen = false;
    const dots = [];
    values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
      pen = true;
      dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${color}" stroke="var(--surface-1)" stroke-width="1.2"/>`);
    });
    const line = path ? `<path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '';

    // 값 라벨(실제 가격) — 각 점 위/아래 번갈아, 선 색 + 흰 헤일로
    const labels = values.map((v, i) => {
      if (v == null) return '';
      const x = X(i), py = Y(v);
      let ly = (i % 2 === 0) ? py - 7 : py + 12;
      if (ly < padT + 8) ly = py + 12;
      if (ly > H - 6) ly = py - 7;
      return `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${color}">${v.toFixed(dec)}</text>`;
    }).join('');

    _materialCharts.push({ idx, name: s.material, unit: s.unit, color, dec, xCats, values, geom: { X, Y, n, W, padL } });

    return `<div class="mat-mini">
      <div class="mat-mini__title"><span class="mat-mini__dot" style="background:${color}"></span>${escapeHtml(s.material)} <span class="mat-mini__unit">(${escapeHtml(matUnit(s.unit))})</span></div>
      <svg class="mat-mini__svg" data-i="${idx}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(s.material)} 가격 추이">
        ${grid}${xticks}${line}${dots.join('')}${labels}
        <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
        <line class="mat-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
        <g class="mat-dots"></g>
        <rect class="mat-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
      </svg>
    </div>`;
  }).join('');

  host.innerHTML = `<div class="viz-root viz-figure">
    ${head}
    <div class="mat-grid">${minis}</div>
    <div class="viz-tooltip" id="materialTooltip"></div>
  </div>`;

  wireMaterialInteraction();
}

/** 미니차트별 크로스헤어 + 툴팁 (날짜 · 실제 가격) */
function wireMaterialInteraction() {
  const fig = document.querySelector('#materialChart .viz-figure');
  const tip = document.getElementById('materialTooltip');
  if (!fig || !tip) return;
  _materialCharts.forEach((c) => {
    const svg = fig.querySelector(`.mat-mini__svg[data-i="${c.idx}"]`);
    if (!svg) return;
    const overlay = svg.querySelector('.mat-overlay');
    const cross = svg.querySelector('.mat-cross');
    const dots = svg.querySelector('.mat-dots');
    const g = c.geom;
    const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
    overlay.addEventListener('mousemove', (evt) => {
      const rect = svg.getBoundingClientRect();
      const sx = (evt.clientX - rect.left) * (g.W / rect.width);
      let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
      i = Math.max(0, Math.min(g.n - 1, i));
      const v = c.values[i];
      if (v == null) { clear(); return; }
      const cx = g.X(i), cy = g.Y(v);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
      dots.innerHTML = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${c.color}" stroke="var(--surface-1)" stroke-width="2"/>`;
      tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.xCats[i])}</div>
        <div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${c.color}"></span><span>${escapeHtml(c.name)}</span><span class="viz-tt-val">${v.toFixed(c.dec)} ${escapeHtml(matUnit(c.unit))}</span></div>`;
      const fr = fig.getBoundingClientRect();
      let left = evt.clientX - fr.left + 14;
      if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${evt.clientY - fr.top + 14}px`;
      tip.classList.add('is-visible');
    });
    overlay.addEventListener('mouseleave', clear);
  });
}

/** 섹션 5 전체 렌더 */
function renderMaterial() {
  renderMaterialCards();
  renderMaterialChart();
}

/* ============================================================
   6) AI 인사이트 (Impact 분석) — 외부 API 없이 규칙 기반 자동 계산
   근거 없는 수치 금지. 데이터 없으면 "데이터 부족". 모든 수치에 출처 자재명 표기.
   ============================================================ */

/** 원자재 최신 변동 신호 (자재별 최신 mom_change_pct 중 절대값 최대) */
function insightMaterialSignal() {
  const md = getMaterialData();
  if (!md) return null;
  const latest = new Map();
  md.rows.forEach((r) => {
    if (r.pending || r.change == null) return;
    const cur = latest.get(r.material);
    if (!cur || r.date.localeCompare(cur.date) >= 0) latest.set(r.material, r);
  });
  const arr = [...latest.values()].filter((r) => r.change != null);
  if (!arr.length) return null;
  arr.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return { name: matName(arr[0].material), change: arr[0].change, count: arr.length };
}

/** 섹션 6 렌더 */
function renderInsights() {
  const el = document.getElementById('body-insights');
  if (!el) return;

  const sig = insightMaterialSignal();

  // 근거 데이터 (뉴스 건수·수입 상위국) — 실데이터만
  const newsCount = STORE.news && STORE.news.rows ? STORE.news.rows.length : 0;
  let topImport = null;
  const gm = getMarketData();
  if (gm && gm.rows.length) {
    // 수입(import) 지표만 — 없으면 표시하지 않음 (근거 없는 라벨 방지)
    const imp = gm.rows
      .filter((r) => !r.isWorld && r.value > 0 && /import|수입/i.test(String(r.metric)))
      .sort((a, b) => b.value - a.value);
    if (imp.length) topImport = imp[0].region;
  }

  // ── 1) 헤드라인 ──
  let headline, headClass;
  if (sig) {
    const dir = sig.change > 0.05 ? '상승' : sig.change < -0.05 ? '하락' : '보합';
    headline = `${sig.name} 원자재 가격 ${Math.abs(sig.change).toFixed(1)}% ${dir}`;
    headClass = sig.change > 0.3 ? 'ai-up' : sig.change < -0.3 ? 'ai-down' : 'ai-flat';
  } else {
    headline = '원자재 변동 데이터가 없습니다 — 데이터 부족';
    headClass = 'ai-flat';
  }
  const basisParts = [];
  if (sig) basisParts.push(`원자재 ${sig.count}종`);
  if (newsCount) basisParts.push(`뉴스 ${newsCount}건`);
  if (topImport) basisParts.push(`수입 상위 ${topImport}`);
  const basis = basisParts.length ? basisParts.join(' · ') : '가용 데이터 없음';

  // ── 2) SIMMONS 영향 분석 ──
  const costUp = !!sig && sig.change > 0.3;
  const costDown = !!sig && sig.change < -0.3;
  let cost;
  if (!sig) cost = { cls: 'ai-na', val: '데이터 부족', src: '—' };
  else if (costUp) cost = { cls: 'ai-up', val: `▲ +${sig.change.toFixed(1)}%`, src: sig.name };
  else if (costDown) cost = { cls: 'ai-down', val: `▼ ${Math.abs(sig.change).toFixed(1)}%`, src: sig.name };
  else cost = { cls: 'ai-flat', val: `- 보합 (${sig.change >= 0 ? '+' : ''}${sig.change.toFixed(1)}%)`, src: sig.name };

  const trend = costUp ? { cls: 'ai-up', txt: '상승 압력 ▲' } : costDown ? { cls: 'ai-down', txt: '완화 ▼' } : { cls: 'ai-flat', txt: '중립 -' };
  const metrics = [
    { label: '원가', cls: cost.cls, val: cost.val, src: cost.src },
    { label: '생산', cls: sig ? trend.cls : 'ai-na', val: sig ? trend.txt : '데이터 부족', src: sig ? '원가 연동' : '—' },
    { label: '재고', cls: sig ? trend.cls : 'ai-na', val: sig ? trend.txt : '데이터 부족', src: sig ? '원가 연동' : '—' },
    { label: '납기', cls: 'ai-na', val: '영향 낮음', src: '근거 없음' },
    { label: '품질', cls: 'ai-na', val: '영향 낮음', src: '근거 없음' },
  ];
  const metricsHtml = metrics.map((m) => `<div class="ai-metric">
      <div class="ai-metric__label">${escapeHtml(m.label)}</div>
      <div class="ai-metric__val ${m.cls}">${escapeHtml(m.val)}</div>
      <div class="ai-metric__src">${escapeHtml(m.src)}</div>
    </div>`).join('');

  // ── 3) 종합 영향도 + 추천 체크리스트 ──
  let stars = 0, scoreBasis;
  if (sig) {
    const a = Math.abs(sig.change);
    stars = a >= 5 ? 5 : a >= 3 ? 4 : a >= 1.5 ? 3 : a >= 0.5 ? 2 : 1;
    scoreBasis = `원자재 최대 변동 ${sig.name} ${sig.change >= 0 ? '+' : ''}${sig.change.toFixed(1)}% 기준`;
  } else {
    scoreBasis = '원자재 변동 데이터 부족';
  }
  const starStr = '★★★★★'.slice(0, stars) + '☆☆☆☆☆'.slice(0, 5 - stars);

  let actions;
  if (costUp) actions = ['공급처 다변화 검토', '장기 계약으로 원가 안정화', '가격 상승분 제품가 반영 시점 검토'];
  else if (costDown) actions = ['원가 하락분 반영 — 원가 개선 기회', '저가 시점 원자재 재고 확보 검토'];
  else if (sig) actions = ['원자재 변동 미미 — 현 계약·재고 유지', '주간 모니터링 지속'];
  else actions = ['원자재 데이터 업로드 후 재분석 권장'];
  const actionsHtml = actions.map((a) => `<li>${escapeHtml(a)}</li>`).join('');

  el.innerHTML = `
    <div class="ai-headline ${headClass}">
      <div class="ai-headline__eyebrow">주요 이슈</div>
      <div class="ai-headline__text">${escapeHtml(headline)}</div>
      <div class="ai-basis">근거: ${escapeHtml(basis)} <span class="ai-basis__tag">규칙 기반 자동 계산</span></div>
    </div>

    <div class="ai-block">
      <div class="ai-block__title">SIMMONS 영향 분석</div>
      <div class="ai-metric-grid">${metricsHtml}</div>
    </div>

    <div class="ai-overall">
      <div class="ai-score">
        <div class="ai-score__label">종합 영향도</div>
        <div class="ai-score__stars" title="${escapeHtml(scoreBasis)}">${starStr}</div>
        <div class="ai-score__basis">${escapeHtml(scoreBasis)}</div>
      </div>
      <div class="ai-actions">
        <div class="ai-actions__title">추천 체크리스트 <span class="ai-actions__tag">규칙 기반 제안</span></div>
        <ul class="ai-actions__list">${actionsHtml}</ul>
      </div>
    </div>`;
}

/** 필터 클릭(위임) — 한 번만 연결 */
function initNews() {
  const filtersEl = document.getElementById('newsFilters');
  if (!filtersEl) return;
  filtersEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    _newsState[chip.dataset.group] = chip.dataset.value;
    renderNews();
  });
}

/* ── 환율 (EUR/USD) ── */
let _fx = null; // { pair, rate, change_pct, date, series:{dates,values} }
let _fxChart = null; // 추이 차트 hover 캐시

/** 응답의 fx 저장 후 환율 카드 갱신 */
function applyFxUpdate(data) {
  const fx = data && data.sections && data.sections.fx;
  if (!fx) return;
  _fx = (fx.status === 'error') ? null : fx;
  if (fx.status === 'error') console.warn('[update] fx error:', fx.reason);
  renderFx();
}

/** 환율 카드 렌더 (현재값 + 전일대비 + 최근 5년 추이) */
function renderFx() {
  const el = document.getElementById('body-fx');
  if (!el) return;
  const note = '<div class="fx-note">유로화 대비 원화 가치. 유럽산 원자재·설비 수입 시 원화 부담을 가늠할 수 있습니다.</div>';
  if (!_fx || _fx.rate == null) {
    el.innerHTML = emptyState('환율 데이터 준비중') + note;
    return;
  }
  const rateStr = Number(_fx.rate).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // 원화: 천단위 콤마 + 소수 2자리
  const c = _fx.change_pct;
  const chgHtml = (c == null)
    ? '<div class="fx-change fx-flat">전일 대비 —</div>'
    : `<div class="fx-change ${c > 0 ? 'up' : c < 0 ? 'down' : 'fx-flat'}">${c > 0 ? '▲' : c < 0 ? '▼' : ''} ${Math.abs(c).toFixed(2)}% <span class="fx-change__lbl">전일 대비</span></div>`;
  el.innerHTML = `
    <div class="fx-card">
      <div class="fx-rate">${rateStr}<span class="fx-unit">원</span></div>
      ${chgHtml}
      <div class="fx-date">기준일 ${escapeHtml(_fx.date || '—')}</div>
    </div>
    ${note}
    <div id="fxChart"></div>
    <div class="comp-caption">출처: Frankfurter (ECB 기반)</div>`;
  renderFxChart();
}

/** 최근 5년 추이 선그래프 (원자재 추이와 같은 톤: 크림슨 선 + 크로스헤어 툴팁) */
function renderFxChart() {
  const host = document.getElementById('fxChart');
  if (!host) return;
  const s = _fx && _fx.series;
  if (!s || !Array.isArray(s.dates) || !s.dates.length) { host.innerHTML = ''; _fxChart = null; return; }

  const dates = s.dates, values = s.values;
  const n = dates.length;
  const W = 520, H = 210, padL = 48, padR = 14, padT = 18, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const color = 'var(--accent)'; // 크림슨 계열

  // y축 자동 스케일 (0부터 시작 아님)
  const vals = values.filter((v) => v != null);
  let ymin = Math.min(...vals), ymax = Math.max(...vals);
  if (ymin === ymax) { const dd = Math.abs(ymin) * 0.1 || 0.01; ymin -= dd; ymax += dd; }
  const yp = (ymax - ymin) * 0.12; ymin -= yp; ymax += yp;
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = [0, 0.5, 1].map((t) => {
    const val = ymin + (ymax - ymin) * t;
    const y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">${Math.round(val).toLocaleString('ko-KR')}</text>`;
  }).join('');

  // x축 라벨: 연-월(YYYY-MM) 형식으로 통일 + 양 끝 포함해 균등 간격으로만 표시.
  // (모든 점마다 찍지 않고 고정 개수만 → 오른쪽 끝 라벨 겹침 방지)
  const TICKS = Math.min(6, n);
  const tickIdx = [];
  for (let k = 0; k < TICKS; k++) {
    const i = TICKS === 1 ? 0 : Math.round((k / (TICKS - 1)) * (n - 1));
    if (!tickIdx.includes(i)) tickIdx.push(i);
  }
  const xticks = tickIdx.map((i) => {
    const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="${anchor}" font-size="9" fill="var(--muted)">${escapeHtml(dates[i].slice(0, 7))}</text>`;
  }).join('');

  let path = '', pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    const x = X(i), y = Y(v);
    path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  const line = path ? `<path d="${path.trim()}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '';

  _fxChart = { dates, values, color, geom: { X, Y, n, W, padL } };

  host.innerHTML = `<div class="viz-root viz-figure">
    <div class="viz-head"><div class="viz-title">최근 5년 추이 (EUR/KRW)</div></div>
    <svg class="fx-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="EUR/KRW 최근 5년 추이">
      ${grid}${xticks}${line}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="fx-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="fx-dots"></g>
      <rect class="fx-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>
    <div class="viz-tooltip" id="fxTooltip"></div>
  </div>`;

  wireFxInteraction();
}

/** 추이 차트 크로스헤어 + 툴팁 (날짜 · 값) */
function wireFxInteraction() {
  const fig = document.querySelector('#fxChart .viz-figure');
  const tip = document.getElementById('fxTooltip');
  if (!fig || !tip || !_fxChart) return;
  const svg = fig.querySelector('.fx-svg');
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
    const v = c.values[i];
    if (v == null) { clear(); return; }
    const cx = g.X(i), cy = g.Y(v);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    dots.innerHTML = `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${c.color}" stroke="var(--surface-1)" stroke-width="2"/>`;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.dates[i])}</div>
      <div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${c.color}"></span><span>EUR/KRW</span><span class="viz-tt-val">${v.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 원</span></div>`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 데이터 변경 시 데이터 의존 섹션 재렌더 */
function refreshSections() {
  renderMarket();
  renderCompetitor();
  renderNews();
  renderMaterial();
  renderFx();
  renderInsights();
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
  initNews();
  initMarket();
  initReport();
  initUpdate();
  // 로드 시 항상 "초기 상태(데이터 없음)"로 시작한다.
  // 저장된 값/기본 CSV를 자동으로 불러오지 않는다 — 데이터는 오직 [업데이트]로만 채운다.
  refreshSections(); // 빈 STORE → 모든 섹션 "준비중" 빈 상태
});

/** 보고서 다운로드: 브라우저 인쇄(→ PDF로 저장) */
function initReport() {
  const btn = document.getElementById('reportBtn');
  if (btn) btn.addEventListener('click', () => window.print());
}

/* ============================================================
   실시간 업데이트 — 백엔드 /api/update (World Bank 핑크시트)
   서버(python dashboard_server.py) 실행 중일 때만 동작.
   지금은 "원자재" 섹션만 연결 (섹션별 apply 함수로 확장 가능).
   ============================================================ */

/** 응답의 materials 를 원자재 섹션 STORE 형식으로 변환해 채운다 */
function applyMaterialsUpdate(data) {
  const m = data && data.sections && data.sections.materials;
  if (!m) return;

  if (m.status === 'error') {
    // 파일 자체 실패: 섹션은 비우되 사유는 콘솔에 남김
    STORE.material = { rows: [], origin: 'update', file: 'World Bank Pink Sheet', message: m.reason || '' };
    console.warn('[update] materials error:', m.reason);
  } else {
    // 라벨→단위/상태 조회 (series 는 단위를 담지 않으므로 rows 에서 가져옴)
    const unitByLabel = {}, statusByLabel = {};
    (m.rows || []).forEach((r) => { unitByLabel[r.label] = r.unit; statusByLabel[r.label] = r.status; });

    const series = m.series;
    let rows;
    if (series && Array.isArray(series.periods) && series.periods.length) {
      // 최근 12개월을 롱포맷(자재 × 월)으로 → 기존 시계열 차트 로직 재사용
      // mom_change_pct 는 넣지 않아 getMaterialData 가 월별 전월대비를 자동 계산하게 함
      const labels = Object.keys(series).filter((k) => k !== 'periods');
      rows = [];
      series.periods.forEach((per, i) => {
        labels.forEach((label) => {
          const arr = series[label];
          const v = arr && arr[i] != null ? arr[i] : '';
          rows.push({
            date: String(per).trim(),
            material: label,
            price: v,
            unit: unitByLabel[label] || '',
            region: 'Global',
            source: statusByLabel[label] === 'ok' ? '실데이터' : '준비중',
          });
        });
      });
    } else {
      // series 없으면 최신값만 (구버전 호환)
      rows = (m.rows || []).map((r) => ({
        date: String(r.period || m.period || '').trim(),
        material: r.label,
        price: r.value,
        unit: r.unit,
        region: 'Global',
        mom_change_pct: r.change_pct,
        source: r.status === 'ok' ? '실데이터' : '준비중',
      }));
    }
    STORE.material = { rows, origin: 'update', file: 'World Bank Pink Sheet' };
  }
  // 원자재 섹션 + (원자재에서 파생되는) AI 인사이트 재렌더 — 기존 렌더 로직 재사용
  renderMaterial();
  renderInsights();
}

/** API 기본 경로 — 상대경로('/api/update')로 호출한다.
 *  같은 출처에서 서빙되므로(로컬: dashboard_server.py, 배포: Vercel) 절대주소가 필요 없다. */
const API_BASE = '';

/** [초기화] 버튼: 서버 호출 없이 화면 상태만 처음(준비중)으로 되돌린다 */
function resetDashboard() {
  if (!window.confirm('초기화할까요?')) return;
  // 업데이트/기본값으로 채워졌던 모든 섹션 데이터 제거 → 각 섹션 "준비중" 빈 상태
  Object.keys(STORE).forEach((k) => delete STORE[k]);
  _materialCharts = []; // 원자재 미니차트 hover 캐시 비우기
  _wbMarket = null;     // World Bank 지도 데이터 비우기 (renderMarket 이 지도 제거)
  _liveNews = null;     // 실시간 뉴스 비우기
  _liveCompetitors = null; // SEC 경쟁사 데이터 비우기
  _fx = null;           // 환율 비우기
  _fxChart = null;      // 환율 추이 차트 캐시 비우기
  // "마지막 업데이트" 텍스트 되돌리기
  const lbl = document.getElementById('lastUpdated');
  if (lbl) lbl.textContent = '아직 업데이트하지 않았습니다';
  const dashUpd = document.getElementById('dashUpdated');
  if (dashUpd) dashUpd.textContent = '—';
  // 원자재·시장·경쟁사·뉴스·AI 인사이트 재렌더(빈 STORE → emptyState/데이터 부족)
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
    try {
      const res = await fetch(API_BASE + '/api/update', { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (lbl && data.updated_at) lbl.textContent = '마지막 업데이트: ' + data.updated_at;
      const dashUpd = document.getElementById('dashUpdated');
      if (dashUpd && data.updated_at) dashUpd.textContent = data.updated_at;
      applyFxUpdate(data);        // 먼저 환율을 반영해야 원자재 카드의 원화 환산이 나온다
      applyMaterialsUpdate(data);
      applyMarketUpdate(data);
      applyNewsUpdate(data);
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
