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
  // 미국 매트리스 제조업 PPI — 별도 섹션(us_ppi)을 그대로 읽는다.
  _usPpi = (data && data.sections && data.sections.us_ppi) || null;
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

/* ── 국외(Global) · 미국 매트리스 제조업 PPI ───────────────────────────────
   차트 하나, 선 하나. BLS PCU337910337910 의 월별 지수를 연평균으로 집계한다.

   ★ 단일 지표다. '하이엔드/프리미엄' 같은 가격대 구분을 만들지 않는다 —
     이 시리즈는 미국에서 만드는 전 매트리스를 하나로 평균한 값이고, BLS 는
     NAICS 337910 아래에 가격대별 하위 시리즈를 발표하지 않는다.
     (예전 화면의 티어 버튼은 HS 코드 = '소재' 구분이었고 가격대가 아니었다.
      근거 없는 구분이라 걷어냈다.)
   ★ 원지수를 그대로 그린다 — 기준월을 다시 잡지 않는다. 그래야 축 라벨과
     설명표의 '기준 시점(1983년 6월 = 100)'이 어긋나지 않는다.
   ★ 설명표의 숫자·추세 문구는 us_ppi.py 가 실데이터에서 계산해 payload.table
     로 보낸다. 프런트는 그 목록을 그대로 그린다 — 여기서 숫자를 만들지 않는다. */
let _usPpi = null;          // sections.us_ppi
let _gtCharts = {};         // 차트 툴팁 데이터·기하 (gtState/gtShowTip 공용)

const G_COL_PPI = 'var(--accent)';

/** Y축 단위 라벨 */
function gtYUnit(txt) {
  return '<div class="gt-yunit">' + escapeHtml(txt) + '</div>';
}

/** 연도별 원지수 선그래프(단일 계열).
    years: [{year, value, months, complete}] — us_ppi.py 의 연평균 그대로.
    마지막 해가 부분 연도면 그 구간만 점선으로 이어 '아직 안 끝난 해'임을 보인다. */
function gPpiChart(key, years, unitLabel) {
  const pts = (years || []).filter((y) => y && y.value != null);
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.value);
  let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;

  const padL = 42, padR = 10;
  const plotW = VIZ_W - padL - padR, plotH = VIZ_H - VIZ_PAD_T - VIZ_PAD_B;
  const X = (i) => padL + (i / (pts.length - 1)) * plotW;
  const Y = (v) => VIZ_PAD_T + plotH - ((v - lo) / (hi - lo)) * plotH;

  let grid = '';
  for (let k = 0; k <= VIZ_Y_TICKS; k += 1) {
    const v = lo + ((hi - lo) * k) / VIZ_Y_TICKS, y = Y(v);
    grid += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (VIZ_W - padR) + '" y2="'
      + y.toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>'
      + '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="'
      + VIZ_FS_AXIS + '" fill="var(--muted)">' + Math.round(v) + '</text>';
  }
  let xlab = '';
  pts.forEach((p, i) => {
    xlab += '<text x="' + X(i).toFixed(1) + '" y="' + (VIZ_H - 8) + '" text-anchor="middle" font-size="'
      + VIZ_FS_AXIS + '" fill="var(--muted)">' + p.year + '</text>';
  });
  // 완전한 해까지는 실선, 부분 연도로 넘어가는 마지막 구간만 점선
  const solid = [], dash = [];
  pts.forEach((p, i) => {
    const xy = X(i).toFixed(1) + ' ' + Y(p.value).toFixed(1);
    if (p.complete === false && i > 0) {
      if (!dash.length) dash.push('M' + X(i - 1).toFixed(1) + ' ' + Y(pts[i - 1].value).toFixed(1));
      dash.push('L' + xy);
    } else {
      solid.push((solid.length ? 'L' : 'M') + xy);
    }
  });
  let lines = '';
  if (solid.length > 1) {
    lines += '<path d="' + solid.join(' ') + '" fill="none" stroke="' + G_COL_PPI
      + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  }
  if (dash.length > 1) {
    lines += '<path d="' + dash.join(' ') + '" fill="none" stroke="' + G_COL_PPI
      + '" stroke-width="2" stroke-linecap="round" stroke-dasharray="5 3"/>';
  }
  _gtCharts[key] = {
    tip: pts.map((p) => ({
      q: p.year + '년 ' + (p.complete === false ? p.months + '개월 평균' : '연평균'),
      rows: [{ name: 'PPI (원지수)', color: G_COL_PPI, seg: p.complete === false,
        y: Y(p.value), val: p.value.toFixed(1) }],
    })),
    geom: { padL: padL, plotW: plotW, n: pts.length },
  };
  const hov = '<g class="gt-hov" aria-hidden="true">'
    + '<line class="gt-hov__l" x1="0" y1="' + VIZ_PAD_T + '" x2="0" y2="' + (VIZ_PAD_T + plotH) + '"/>'
    + '<circle class="gt-adot" data-si="0" r="3.5" cx="-99" cy="-99" fill="var(--card)" stroke="'
    + G_COL_PPI + '" stroke-width="2"/></g>';
  const partial = pts.filter((p) => p.complete === false).length > 0;
  return '<div class="gt-chartwrap" data-gt-chart="' + escapeHtml(key) + '">'
    + gtYUnit(unitLabel || '지수')
    + '<svg class="gt-chart" viewBox="0 0 ' + VIZ_W + ' ' + VIZ_H
    + '" preserveAspectRatio="xMidYMid meet" role="img"'
    + ' aria-label="미국 매트리스 제조업 PPI 연평균 추이">'
    + grid + lines + xlab + hov + '</svg>'
    + '<div class="gt-tip" hidden></div></div>'
    + '<div class="gt-legend"><span class="gt-lg"><i style="background:' + G_COL_PPI
    + '"></i>매트리스 제조업 PPI (연평균)</span>'
    + (partial ? '<span class="gt-lg gt-lg--seg"><i></i>진행 중인 해(부분 연도)</span>' : '')
    + '</div>';
}

/** 요약 3칸 — 최신 월값 / 올해 평균 / 첫 해 대비 변화. 전부 payload 값에서 만든다. */
function gPpiSummary(u) {
  const ys = u.years || [], last = u.latest;
  if (!ys.length || !last) return '';
  const cell = (k, v) => '<div class="gs-cell"><span class="gs-k">' + escapeHtml(k)
    + '</span><span class="gs-v">' + v + '</span></div>';
  const cur = ys[ys.length - 1], first = ys[0];
  let out = cell('최근 값 (' + last.month + ')', last.value.toFixed(1));
  out += cell(cur.year + '년 평균' + (cur.complete ? '' : ' (' + cur.months + '개월)'),
    cur.value.toFixed(1));
  if (first.value) {
    const chg = ((last.value - first.value) / first.value) * 100;
    out += cell(first.year + '년 대비',
      '<span class="gs-gap' + (chg < 0 ? ' gs-gap--neg' : '') + '">'
      + (chg > 0 ? '+' : '') + chg.toFixed(1) + '%</span>');
  }
  return '<div class="gs">' + out + '</div>';
}

/** 지표 설명표 — us_ppi.py 가 만든 payload.table({k,v}) 을 그대로 그린다.
    ★ 여기서 값을 계산하거나 문구를 덧붙이지 않는다. 표 내용을 고칠 일이 생기면
      us_ppi.py 한 곳만 고친다(새 데이터가 들어오면 자동으로 최신화된다). */
function gPpiTable(u) {
  const rows = (u && u.table) || [];
  if (!rows.length) return '';
  return '<div class="icis-terms"><h3 class="subhead">지표 설명</h3>'
    + '<div class="icis-term-wrap"><table class="icis-termtable">'
    + '<thead><tr><th>항목</th><th>설명</th></tr></thead><tbody>'
    + rows.map((r) => '<tr><td>' + escapeHtml(r.k) + '</td><td>'
      + escapeHtml(r.v) + '</td></tr>').join('')
    + '</tbody></table></div></div>';
}

/** 수집 시각 여러 개 중 가장 최근 날짜(YYYY-MM-DD). 하나도 없으면 null. */
function gSrcDate() {
  let best = null;
  for (let i = 0; i < arguments.length; i += 1) {
    const s = arguments[i];
    if (!s) continue;
    const d = String(s).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (best == null || d > best)) best = d;
  }
  return best;
}

/** 차트 하단 출처 각주. 국내 카드 각주와 같은 클래스(.sm-foot)를 써서 스타일이 동일하다. */
function gSrcFoot(text, date) {
  return '<div class="sm-foot">' + escapeHtml(text)
    + (date ? ' · 최종 업데이트: ' + escapeHtml(date) : '') + '</div>';
}

/** 미국 매트리스 제조업 PPI 블록 — 차트 + 요약 + 설명표. */
function gUsPpiBlock() {
  const u = _usPpi;
  if (!u || u.status !== 'ok' || !(u.years || []).length) {
    return emptyState((u && u.reason) || '업데이트 버튼을 누르면 표시됩니다');
  }
  const chart = gPpiChart('gusppi', u.years, u.unit);
  if (!chart) return emptyState('연도가 2개 미만이라 추이를 그릴 수 없습니다');
  // 부분 연도·잠정치는 '숨기지 않고 밝힌다' — 나중에 값이 바뀔 수 있는 구간이다.
  let caveat = '';
  if (u.partial_year) {
    caveat += ' ' + u.partial_year.year + '년은 아직 '
      + u.partial_year.months + '개월치라 부분 연도 평균이며 점선으로 표시했습니다.';
  }
  if (u.prelim_months) {
    caveat += ' 최근 ' + u.prelim_months + '개월은 BLS 잠정치로, 공표 후 4개월까지 개정될 수 있습니다.';
  }
  return gPpiSummary(u) + chart
    + '<div class="g-note">' + escapeHtml(u.note || '') + escapeHtml(caveat) + '</div>'
    + gSrcFoot('출처: ' + (u.source || ''), gSrcDate(u.updatedAt))
    + gPpiTable(u);
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
    return '<div class="sm-hrow' + (mine ? ' is-mine' : '') + '">'
      + '<div class="sm-hname" title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + '</div>'
      + '<div class="sm-htrack"><div class="sm-hbar" style="width:' + w.toFixed(1) + '%"></div></div>'
      + '<div class="sm-hval">' + smNum(r.revenue) + ' ' + smDelta(r.yoyChangePct) + '</div>'
      + '</div>';
  }).join('');
  return '<div class="sm-hbars">' + bars + '</div>'
    + (c.note ? '<div class="sm-foot">※ ' + escapeHtml(c.note) + '</div>' : '');
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
  const legend = rows.map((r) => '<span><i style="background:'
    + (SM_SHARE_COL[r.name] || '#9CA3AF') + '"></i>' + escapeHtml(r.name)
    + ' <b>' + r.share + '%</b></span>').join('');
  return '<div class="sm-donutwrap">'
    + '<svg class="sm-donut" viewBox="0 0 ' + S + ' ' + S + '" role="img" aria-label="'
    + escapeHtml(yr) + '년 시장 점유율">'
    + '<g transform="rotate(-90 ' + cc + ' ' + cc + ')">' + segs + '</g>'
    + center + '</svg>'
    + '<div class="sm-legend sm-legend--wrap">' + legend + '</div></div>';
}

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
    + '<div class="sm-card"><div class="sm-h">코웨이·시몬스·에이스침대 '
    + (cy ? escapeHtml(String(cy)) + '년' : '지난해') + ' 매출 비교'
    + ' <span class="sm-h__u">(단위: ' + unit + ')</span></div>'
    + smRevCompare(d) + '</div>'
    + '<div class="sm-card"><div class="sm-h">' + escapeHtml(String(sy))
    + '년 침대 매트리스 시장 점유율</div>'
    + smShareDonut(d) + '</div>'
    + '</div></div>';
}

/** 제목 옆 약어 배지 + hover/포커스 툴팁.
    ★ 약어를 그 자리에서 풀어 준다 — 'PPI' 만 보고 뜻을 몰라 멈추는 일이 없게.
      배지 텍스트에 이미 우리말 뜻이 들어가고, 툴팁은 원어와 정의를 덧붙인다.
    ★ 툴팁 문구는 DOM 안에 그대로 있어 스크린리더도 읽는다(title 중복 방지). */
function gcAbbr(label, tip) {
  return '<span class="gc-abbr" tabindex="0" role="note">' + escapeHtml(label)
    + '<span class="gc-abbr__bub">' + escapeHtml(tip) + '</span></span>';
}

const PPI_ABBR = 'PPI(생산자물가지수)';
const PPI_ABBR_TIP = 'PPI = Producer Price Index, 생산자물가지수 — '
  + '공장이 도매로 파는 판매가격의 변화를 측정하는 지표';

/** 국외 섹션 — 미국 매트리스 제조업 PPI 블록 하나. 그 외에는 만들지 않는다.
    payload 에 us_ppi 섹션이 없으면(구버전 dashboard.json) null 을 돌려
    호출부가 기존 SEC 분기 실적 카드를 그대로 쓰게 한다. */
function gtGlobalHtml() {
  if (!_usPpi) return null;
  return '<div class="gc-block"><div class="gc-h">미국 매트리스 제조업'
    + gcAbbr(PPI_ABBR, PPI_ABBR_TIP) + '</div>'
    + gUsPpiBlock() + '</div>';
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

  el.innerHTML = `
    <div class="comp-group">
      <div class="comp-group__head">국내 <span class="comp-group__tag">Korea</span></div>
      <div class="comp-group__sub">시몬스·경쟁사 실적과 시장 점유율
        <span class="comp-group__desc">단위 억원 · 비상장사 수기 입력 · 출처는 각 차트에 표기</span>
      </div>
      ${koreaHtml}
    </div>
    <div class="comp-group">
      <div class="comp-group__head">국외 <span class="comp-group__tag">Global</span></div>
      <div class="comp-group__sub">${gTier ? '미국 매트리스 가격 동향' : '분기별 실적'}
        <span class="comp-group__desc${gTier ? ' comp-group__desc--own' : ''}">${gTier ? '미국 매트리스 공장 출고가격(생산자물가지수)의 연평균 추이 · BLS 월별 데이터 자동 수집' : '매출·순이익 · 전년 동기 대비(YoY) 기준 · SEC EDGAR'}</span>
      </div>
      ${globalHtml}
    </div>`;
  wireGtControls();
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
let _icisForecast = null; // 순수 추가: 다음 달 주원료 예측(백엔드 계산). null이면 예측 섹션 숨김
let _srForecast = null;   // 순수 추가: 다음 달 해상 정시성 예측(백엔드 계산). null이면 섹션 숨김
let _oilForecast = null;  // 순수 추가: 다음 달 국제유가 예측(백엔드 계산). null이면 섹션 숨김

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
  // 순수 추가: 다음 달 예측 저장(있을 때만; 없으면 예측 섹션 숨김)
  const fc = data && data.sections && data.sections.icis_forecast;
  _icisForecast = (fc && fc.status === 'ok') ? fc : null;
  const srf = data && data.sections && data.sections.sr_forecast;
  _srForecast = (srf && srf.status === 'ok') ? srf : null;  // 순수 추가: 정시성 예측
  const oilf = data && data.sections && data.sections.oil_forecast;
  _oilForecast = (oilf && oilf.status === 'ok') ? oilf : null;  // 순수 추가: 유가 예측
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
  // 연도 칩은 데이터(ICIS_DATA.periods)에서 뽑는다 — 하드코딩 배열이 아니라서
  // 나중에 2027 데이터가 추가되면 2027 칩이 자동으로 생긴다.
  const icisYears = Array.from(new Set(ICIS_DATA.periods.map((p) => p.slice(0, 4)))).sort();
  const years = icisYears.concat(['all']);
  // 데이터가 비면 칩을 그리지 않는다(빈 툴바가 남아 레이아웃이 뜨는 것 방지).
  const toolbar = icisYears.length
    ? `<div class="icis-years">${years.map((y) =>
      `<button class="icis-year${y === _matYear ? ' is-active' : ''}" data-year="${y}">${y === 'all' ? '전체' : y}</button>`).join('')}</div>`
    : '';

  let body;
  if (!_matYear) {
    body = '<div class="icis-prompt">연도를 선택하세요</div>';
  } else {
    const { periods, series } = icisViewData(_matYear);
    body = buildIcisChart(periods, series) + icisLatest() + icisTermsTable()
      + renderIcisForecastHtml();  // 순수 추가: 용어표 아래 '다음 달 전망'
  }

  // 순수 추가: KOIMA 요약 한 줄을 맨 앞에 덧붙인다(데이터 없으면 '' → 기존 출력과 동일).
  root.innerHTML = renderKoimaSummaryHtml() + `<div class="viz-root viz-figure icis-figure">
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
  ${renderKoimaHtml()}
  ${renderKoimaPriceHtml()}
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

  wireKoimaControls(root);  // 순수 추가: KOIMA 부문별 지수 카드
  wireKpControls(root);     // 순수 추가: KOIMA 일일 국제원자재가격 카드
}

/** 4개 원료 월별 선그래프 SVG (null 구간 선 끊김) */
function buildIcisChart(periods, series) {
  const n = periods.length;
  if (!n || !series.length) return '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
  const singleYear = periods.every((p) => p.slice(0, 4) === periods[0].slice(0, 4));

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
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
    const p = periods[i];
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(singleYear ? p.slice(5) + '월' : p)}</text>`;
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
/** 순수 추가: 적용 환율의 기준일(YYYY-MM-DD). _fx.series 의 마지막 유효 USD 값 날짜.
 *  usd_krw 섹션에는 날짜가 없어(rate 만 옴) 같은 값을 주는 _fx 에서 날짜만 빌려온다.
 *  ★ 환율 값·원화 환산 계산에는 관여하지 않는다(표기용). 없으면 null. */
function fxAsOfDate() {
  try {
    const s = _fx && _fx.series;
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
    color: srYearColor(y),
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

  // 스폰지 카드(renderMaterial의 _matYear 분기)와 동일 조건: 연도를 고르기 전에는
  // 차트와 함께 지표 설명·예측도 내보내지 않는다.
  let body, extras = '';
  if (!_srYear) {
    body = '<div class="icis-prompt">연도를 선택하세요</div>';
  } else {
    const { months, series } = srViewData(_srYear);
    body = buildSrChart(months, series);
    extras = renderSrTermsHtml() + renderSrForecastHtml();
  }
  return `<div class="viz-root viz-figure sr-figure">${head}
    ${toolbar}
    ${body}
    <div class="viz-tooltip" id="srTooltip"></div>
    <div class="comp-caption">출처: Sea-Intelligence</div>
    ${extras}
  </div>`;
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
function buildSrChart(months, series) {
  const n = months.length;
  if (!n || !series.length) return '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
  const single = series.length === 1;

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
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

  const dots = series.map((s) => s.values.map((v, i) => v == null ? '' :
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1"/>`).join('')).join('');

  // 값 라벨: 점이 VIZ_LABEL_MAX_PTS 이하인 단일 연도 보기(12개월)에서만 표시.
  // 여러 연도를 겹쳐 보는 경우는 라벨 없이 툴팁으로만 값을 보여준다.
  const labels = (single && n <= VIZ_LABEL_MAX_PTS) ? series[0].values.map((v, i) => {
    if (v == null) return '';
    const x = X(i), y = Y(v) - 6;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_LABEL}" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${series[0].color}">${v.toFixed(1)}%</text>`;
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

  // 스폰지 카드(renderMaterial의 _matYear 분기)와 동일 조건: 기간을 고르기 전에는
  // 차트와 함께 예측 섹션(적용 환율·면책 문구 포함)도 내보내지 않는다.
  let body, extras = '';
  if (!_oilData) {                                   // 1) 데이터 없음
    body = '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>';
  } else if (_oilData.error) {
    body = '<div class="chart-empty">데이터를 불러오지 못했습니다 (PETRONET 접근 차단 가능)</div>';
  } else if (!_oilRange) {                            // 2) 데이터 있음 · 기간 미선택
    body = '<div class="icis-prompt">기간을 선택하세요</div>';
  } else {                                            // 3) 기간 선택됨 → 차트 + 예측
    // 범례(3개) — 클릭 토글, 꺼진 항목은 흐리게
    const legend = `<div class="viz-legend oil-legend">${_oilData.series.map((s) => {
      const on = _oilOn && _oilOn.has(s.key);
      const color = OIL_COLORS[s.key] || 'var(--slate)';
      return `<button class="viz-legend__item oil-leg${on ? '' : ' is-off'}" data-key="${s.key}" type="button" aria-pressed="${on}">
        <span class="viz-legend__swatch" style="background:${on ? color : 'var(--muted)'}"></span>${escapeHtml(s.label)}</button>`;
    }).join('')}</div>`;
    body = `${legend}${buildOilChart(oilSliceRows())}<div class="viz-tooltip" id="oilTooltip"></div>`;
    extras = renderOilForecastHtml();
  }
  return `<div class="viz-root viz-figure oil-figure">${head}${chips}${body}${cap}${extras}</div>`;
}

/** 순수 추가(유가 예측 전용): 환율 카드(_fx)의 최신 USD 기준환율 + 기준일 참조.
 *  - 환율을 새로 수집하지 않고 이미 받아둔 fx 데이터만 읽는다.
 *  - 데이터가 없거나 값이 이상하면 null → 호출부에서 원화 환산을 생략(USD만 표시).
 *  ★ 스폰지 카드(_matUsdKrw/fmtKrwShort)와 표기 패턴은 같지만 공통화하지 않고 별도 작성. */
function oilFxLatest() {
  try {
    const fx = _fx;
    if (!fx || !Array.isArray(fx.rows) || !fx.rows.length) return null;
    const row = fx.rows.find((r) => r && r.cur === 'USD');
    const rate = row ? Number(row.now) : NaN;
    if (!isFinite(rate) || rate <= 0) return null;
    // 기준일: series.USD의 마지막 유효값에 대응하는 날짜(없으면 날짜 없이 환율만 표기)
    let date = null;
    const s = fx.series;
    if (s && Array.isArray(s.dates) && Array.isArray(s.USD)) {
      for (let i = s.USD.length - 1; i >= 0; i--) {
        if (s.USD[i] != null) { date = s.dates[i] || null; break; }
      }
    }
    return { rate, date };
  } catch (e) {  // 어떤 이유로든 환율 참조 실패 시 카드가 깨지지 않게 환산만 생략
    console.warn('[oil-fc] 환율 참조 실패 → 원화 환산 생략:', e);
    return null;
  }
}

/** 순수 추가(유가 예측 전용): 배럴당 USD → 원화 표기.
 *  ★ 톤당 원료가(213만 원/톤)와 자릿수가 달라 fmtKrwShort를 쓰지 않는다.
 *    1만 원 이상은 "15.0만"(만 단위 소수 1자리), 그 미만은 "9,853"(원 단위 전체).
 *  bare=true면 단위('원')를 붙이지 않는다(신뢰구간의 앞쪽 값처럼 이어 쓸 때). */
function oilKrwPerBbl(usd, rate, bare) {
  if (usd == null || !isFinite(Number(usd)) || rate == null || !isFinite(rate)) return null;
  const w = Number(usd) * rate;
  const sign = w < 0 ? '-' : '', a = Math.abs(w);
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(1)}만${bare ? '' : ' 원'}`;
  return `${sign}${Math.round(a).toLocaleString('ko-KR')}${bare ? '' : '원'}`;
}

/** 순수 추가: 출처 아래 '다음 달 전망'(국제유가). 예측 없으면 '' 반환(섹션 숨김).
 *  숫자는 백엔드 계산(_oilForecast), 문장(comment/summary/spread/caution)만 AI.
 *  원화 병기는 표시 계층 전용 — 예측 계산은 USD 그대로, 그릴 때만 환율을 곱한다. */
function renderOilForecastHtml() {
  const fc = _oilForecast;
  if (!fc || !Array.isArray(fc.products) || !fc.products.some((p) => p && p.status === 'ok')) return '';
  const rcls = (r) => (r === '상방' ? 'up' : (r === '하방' ? 'down' : 'flat'));
  const num = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fx = oilFxLatest();                 // null이면 아래 모든 원화 병기가 자동 생략된다
  const rate = fx ? fx.rate : null;
  const krw = (usd, bare) => (rate == null ? null : oilKrwPerBbl(usd, rate, bare));
  const chk = [];                           // 콘솔 검증용(표시값 ↔ 실제 계산값)
  const cards = fc.products.map((p) => {
    const color = p.color || 'var(--slate)';
    const head = `<div class="oilfc__head"><span class="icis-dot" style="background:${color}"></span><b>${escapeHtml(p.label || p.code)}</b>`;
    if (p.status !== 'ok') {
      return `<div class="oilfc__card">${head}</div><div class="oilfc__na">데이터 부족</div>
        <div class="oilfc__reason">${escapeHtml(p.reason || '')}</div></div>`;
    }
    const d = p.delta, dp = p.delta_pct;
    const dcls = d > 0 ? 'up' : (d < 0 ? 'down' : 'flat');
    const arrow = d > 0 ? '▲' : (d < 0 ? '▼' : '–');
    // 원화 병기(환율 없으면 전부 빈 문자열 → USD만 표시)
    const vKrw = krw(p.predict);
    const vKrwHtml = vKrw ? ` <span class="oilfc__krw">≈ ${escapeHtml(vKrw)}/배럴</span>` : '';
    const ciLo = krw(p.ci_low, true), ciHi = krw(p.ci_high);
    const ciKrwHtml = (ciLo && ciHi) ? ` <span class="oilfc__krw">(${escapeHtml(ciLo)} ~ ${escapeHtml(ciHi)})</span>` : '';
    const dKrw = krw(Math.abs(d));
    const dKrwHtml = dKrw ? ` <span class="oilfc__krw">≈ ${escapeHtml(dKrw)}</span>` : '';
    if (rate != null) chk.push({ 유종: p.label || p.code, USD: p.predict, 표시: vKrw, 실제원: Math.round(p.predict * rate) });
    return `<div class="oilfc__card">
      ${head}<span class="oilfc__risk ${rcls(p.risk)}">${escapeHtml(p.risk)}</span></div>
      <div class="oilfc__val">${num(p.predict)} <span class="oilfc__unit">USD/배럴</span>${vKrwHtml}</div>
      <div class="oilfc__delta ${dcls}">${arrow} ${num(Math.abs(d))} (${Math.abs(dp).toFixed(1)}%)${dKrwHtml} <span class="oilfc__prev">${escapeHtml(p.prev_month || '')} 실측 ${num(p.prev)} 대비</span></div>
      <div class="oilfc__ci">신뢰구간 ${num(p.ci_low)} ~ ${num(p.ci_high)}${ciKrwHtml}</div>
      ${p.comment ? `<div class="oilfc__cmt">${escapeHtml(p.comment)}</div>` : ''}
    </div>`;
  }).join('');
  const gen = fc.generated_at ? `<span class="oilfc__gen">예측 생성 ${escapeHtml(fc.generated_at)}</span>` : '';
  const sub = fc.last_data_month ? `<div class="oilfc__sub">최신 데이터 ${escapeHtml(fc.last_data_month)} 기준${fc.months_ahead != null ? ' · ' + fc.months_ahead + '개월 후 추정' : ''}</div>` : '';
  const summary = fc.summary ? `<div class="oilfc__summary">${escapeHtml(fc.summary)}</div>` : '';
  const spread = fc.spread ? `<div class="oilfc__line"><b>제품 간 가격차</b> ${escapeHtml(fc.spread)}</div>` : '';
  const caution = fc.caution ? `<div class="oilfc__caution">⚠ ${escapeHtml(fc.caution)}</div>` : '';
  // 적용 환율 명시(환율 없으면 줄 자체를 생략) + 콘솔 검증 출력
  let fxnote = '';
  if (rate != null) {
    const dt = fx.date ? ` (${escapeHtml(fx.date)} 기준)` : '';
    fxnote = `<div class="oilfc__fxnote">적용 환율: 1 USD = ${Math.round(rate).toLocaleString('ko-KR')}원${dt}</div>`;
    console.log(`[oil-fc] 원화 환산 검증 · 적용 환율 1 USD = ${rate}원${fx.date ? ` (${fx.date} 기준)` : ''}`);
    if (console.table) console.table(chk); else console.log(chk);
  } else {
    console.log('[oil-fc] 환율 데이터 없음 → 원화 환산 생략, USD만 표시');
  }
  return `<div class="oilfc">
    <h3 class="subhead oilfc__title">다음 달 전망 <span class="oilfc__month">(${escapeHtml(fc.target_month || '')} 예측)</span>${gen}</h3>
    ${sub}
    <div class="oilfc__grid">${cards}</div>
    ${summary}${spread}${caution}${fxnote}
    <div class="oilfc__disc">통계적 추세 기반 참고용 추정치입니다. 국제유가는 OPEC 정책, 지정학적 분쟁, 수요 충격 등 예측 불가한 요인에 크게 좌우되며, 과거 데이터만으로는 급변 구간을 예측할 수 없습니다.</div>
  </div>`;
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

  const W = VIZ_W, H = VIZ_H, padL = 42, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">$${Math.round(val)}</text>${vizKrwTick(padL - 6, y, val, _matUsdKrw)}`;
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
const KOIMA_DEFAULT_CAT = 'petchem';   // 기본 선택 부문: 유화원료

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
    // 부문·끝점만 기본값을 잡고 기간은 미선택으로 둔다(유가 카드와 동일한 2단계 유지)
    if (!_koimaCat) _koimaCat = KOIMA_DEFAULT_CAT;
    if (!_koimaEnd) _koimaEnd = k.latestPeriod || null;
    const rc = (koimaCatOf(_koimaCat) || {}).rows || [];
    console.log('[koima] 부문 %d개 · 최신월 %s · 기본 탭 %s(%d행)',
      k.categories.length, k.latestPeriod, _koimaCat, rc.length);
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

/** KOIMA 카드 HTML — 유가 카드와 동일한 3단계 빈 상태 */
function renderKoimaHtml() {
  const head = `<div class="viz-head"><div>
      <div class="viz-title">원자재 월간 부문별 지수 (KOIMA)</div>
      <div class="viz-sub">8개 부문 월별 지수 · 2010.12 = 100 기준</div>
    </div></div>`;
  const cap = '<div class="comp-caption">출처: 한국수입협회 국제원자재가격정보</div>';
  const ok = _koimaData && !_koimaData.error && _koimaData.categories.length;
  const cat = ok ? koimaCatOf(_koimaCat) : null;
  const dis = ok ? '' : ' disabled';

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

  let body;
  if (!_koimaData) {                                   // 1) 데이터 없음
    body = '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>';
  } else if (_koimaData.error) {
    body = `<div class="chart-empty">데이터를 불러오지 못했습니다 (${escapeHtml(_koimaData.error)})</div>`;
  } else if (!_koimaRange) {                            // 2) 데이터 있음 · 기간 미선택
    body = '<div class="icis-prompt">기간을 선택하세요</div>';
  } else {                                              // 3) 선택됨 → 차트 + 표
    const rows = koimaSliceRows();
    body = buildKoimaChart(rows, cat) + '<div class="viz-tooltip" id="koimaTooltip"></div>'
      + koimaRecentTable(rows, cat);
  }
  return `<div class="viz-root viz-figure koima-figure">${head}${tabs}${controls}${chips}${body}${cap}</div>`;
}

/** 단일 시리즈 월별 선그래프 (dot 없음, Y축 auto — 0에서 시작하지 않음) */
function buildKoimaChart(rows, cat) {
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

  const W = VIZ_W, H = VIZ_H, padL = 42, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
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
      ${grid}${xticks}${line}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="koima-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="koima-dots"></g>
      <rect class="koima-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
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
    _koimaCat = b.dataset.cat;
    const cat = koimaCatOf(_koimaCat);
    if (cat) _koimaEnd = koimaClampEnd(cat, _koimaEnd);  // 짧은 구간 부문으로 옮길 때 보정
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
const KP_DEFAULT_CAT = 'petchem';

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

/** 증감 표기: "10.00 (▲1.01%)" — ▲빨강 ▼파랑 */
function kpDelta(val, pct) {
  if (val == null && pct == null) return '<span class="kp-chg flat">–</span>';
  const v = val == null ? (pct || 0) : val;
  const cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
  const arrow = v > 0 ? '▲' : (v < 0 ? '▼' : '–');
  const av = val == null ? '-' : Math.abs(val).toFixed(2);
  const ap = pct == null ? '-' : Math.abs(pct).toFixed(2);
  return `<span class="kp-chg ${cls}">${av} (${arrow}${ap}%)</span>`;
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
    if (!_kpCat) _kpCat = KP_DEFAULT_CAT;
    let cat = kpCatOf(_kpCat) || kpCatsOrdered()[0] || null;
    if (cat) { _kpCat = cat.key; if (_kpItem == null) _kpItem = kpFirstItemNo(cat); }
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

/** 요약 바 — 원본처럼 한 줄: 가격 / 단위 / 거래시장 / 현물·선물 / 전주평균 / 전월평균 / 전일·전주·전월비 */
function kpSummaryBar(item, rows) {
  if (!item || !rows.length) return '';
  const r = rows[rows.length - 1];
  const cell = (label, val) => `<div class="kp-sum__cell"><span class="kp-sum__k">${label}</span><span class="kp-sum__v">${val}</span></div>`;
  return `<div class="kp-sum">
    <div class="kp-sum__main">
      <span class="kp-sum__price">${kpPrice(r.price)}</span>
      <span class="kp-sum__unit">${escapeHtml(item.unit || '')}</span>
      <span class="kp-sum__date">${escapeHtml(r.date)} 기준</span>
    </div>
    <div class="kp-sum__grid">
      ${cell('거래시장', escapeHtml(item.market || '-'))}
      ${cell('현물/선물', escapeHtml(item.spotFutures || '-'))}
      ${cell('전주평균', kpPrice(item.weekAvg))}
      ${cell('전월평균', kpPrice(item.monthAvg))}
      ${cell('전일비', kpDelta(r.domValue, r.domPct))}
      ${cell('전주비', kpDelta(r.wowValue, r.wowPct))}
      ${cell('전월비', kpDelta(r.momValue, r.momPct))}
    </div>
  </div>`;
}

/** 카드 HTML — 3단계 빈 상태 */
function renderKoimaPriceHtml() {
  const head = `<div class="viz-head"><div>
      <div class="viz-title">일일 국제원자재가격 (KOIMA)</div>
      <div class="viz-sub">부문별 주요 품목 일별 가격</div>
    </div></div>`;
  const cap = '<div class="comp-caption">출처: 한국수입협회 국제원자재가격정보</div>';
  const ok = _kpData && !_kpData.error && _kpData.categories.length;
  const cat = ok ? kpCatOf(_kpCat) : null;
  const item = ok ? kpItemOf(cat, _kpItem) : null;
  const dis = ok ? '' : ' disabled';

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

  let body;
  if (_kpBusy) {                                    // 로드 중
    body = '<div class="icis-prompt kp-busy">국제원자재가격을 불러오는 중입니다…</div>';
  } else if (!_kpData) {                            // 1) 데이터 없음
    body = '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>';
  } else if (_kpData.error) {
    body = `<div class="chart-empty">데이터를 불러오지 못했습니다 (${escapeHtml(_kpData.error)})</div>`;
  } else if (!_kpRange || !item) {                  // 2) 데이터 있음 · 미선택
    body = '<div class="icis-prompt">품목과 기간을 선택하세요</div>';
  } else {                                          // 3) 선택됨
    const rows = kpSliceRows(item);
    body = kpSummaryBar(item, rows) + buildKpChart(rows, item, cat)
      + '<div class="viz-tooltip" id="kpTooltip"></div>' + kpRecentTable(rows, item);
  }
  const warn = (ok && _kpData.failures && _kpData.failures.length)
    ? `<div class="kp-warn">일부 품목 수집 실패 ${_kpData.failures.length}건 (해당 품목은 목록에서 제외)</div>` : '';
  return `<div class="viz-root viz-figure kp-figure">${head}${tabs}${controls}${chips}${body}${warn}${cap}</div>`;
}

/** 단일 품목 일별 선그래프 (dot 없음, Y축 auto) */
function buildKpChart(rows, item, cat) {
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

  const W = VIZ_W, H = VIZ_H, padL = 48, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
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
    </svg>`;
}

/** 최근 12일 표 — 2열(6행씩), 최신일이 왼쪽 위 */
function kpRecentTable(rows, item) {
  if (!rows.length || !item) return '';
  const recent = rows.slice(-12).reverse();
  const half = Math.ceil(recent.length / 2);
  const left = recent.slice(0, half), right = recent.slice(half);
  const cells = (r) => (r
    ? `<td class="kp-t__d">${escapeHtml(r.date)}</td>
       <td class="kp-t__v">${kpPrice(r.price)}</td>
       <td>${kpDelta(r.domValue, r.domPct)}</td>
       <td>${kpDelta(r.wowValue, r.wowPct)}</td>
       <td>${kpDelta(r.momValue, r.momPct)}</td>`
    : '<td colspan="5" class="kp-t__blank"></td>');
  const body = left.map((r, i) => `<tr>${cells(r)}${cells(right[i])}</tr>`).join('');
  const hg = '<th>기간</th><th>품목별 가격</th><th>전일비(%)</th><th>전주비(%)</th><th>전월비(%)</th>';
  return `<h3 class="subhead kp-t__head">${escapeHtml(item.name)} 최근 ${recent.length}일</h3>
    <div class="kp-t__wrap"><table class="kp-t">
      <thead><tr>${hg}${hg}</tr></thead><tbody>${body}</tbody>
    </table></div>`;
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
    _kpCat = b.dataset.cat;
    _kpItem = kpFirstItemNo(kpCatOf(_kpCat));   // 부문 변경 시 첫 품목으로 리셋
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
      <div class="comp-caption">${fxAsOfDate() ? `기준일 ${escapeHtml(fxAsOfDate())} · ` : ''}출처: Frankfurter (ECB 기반)</div>
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
    <div class="comp-caption">출처: Open-Meteo</div>`;
  wcWire();
  wcTick();
}

/** 매 틱(30초): 마커 주야 구분 + 열린 툴팁 갱신 */
function wcTick() {
  const root = document.getElementById('worldclockRoot');
  if (!root || !_wcShown) return;
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
  markers.addEventListener('click', (e) => {
    const mk = e.target.closest('.wc-mk'); if (!mk) return;
    const i = +mk.dataset.i;
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

/** [업데이트]에 연결: Open-Meteo로 18개 도시 날씨 1회 요청 → 마커 표시.
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
  _icisForecast = null; // 순수 추가: 예측 초기화(섹션 숨김)
  _srData = null; _srYear = null; _srChart = null;       // 해상 정시성 비우기
  _srForecast = null; // 순수 추가: 정시성 예측 초기화(섹션 숨김)
  _oilData = null; _oilRange = null; _oilOn = null; _oilChart = null; // 국제유가 비우기
  _oilForecast = null; // 순수 추가: 유가 예측 초기화(섹션 숨김)
  // 순수 추가: KOIMA 부문별 지수 → 1단계(데이터 없음)로 복귀
  _koimaData = null; _koimaCat = null; _koimaEnd = null; _koimaRange = null; _koimaChart = null;
  // 순수 추가: KOIMA 일일 국제원자재가격 → 1단계로 복귀
  _kpData = null; _kpCat = null; _kpItem = null; _kpRange = null; _kpChart = null; _kpBusy = false;
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
  oil_prices: '국제유가', domestic: '국내 브랜드', global_brands: '국외 브랜드',
  competitors: '경쟁사 실적', fx: '환율', icis_forecast: '주원료 예측',
  sr_forecast: '정시성 예측', oil_forecast: '유가 예측', koima_index: 'KOIMA 월간지수',
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
    updateWorldWeather();  // 세계 시간: Open-Meteo 날씨(서버 /api/update와 독립) → 마커 표시
    // 순수 추가: KOIMA 일일가격 — 미리 수집해 둔 정적 JSON 로드(즉시 완료).
    // await 하지 않는다 — 다른 카드가 이 로드를 기다리지 않게 한다.
    fetchKoimaPrice();
    // 순수 추가: 국내 실적·점유율 정적 JSON. await 하지 않는다 —
    // 다른 카드가 이 로드를 기다리지 않게 하고, 끝나면 스스로 다시 그린다.
    fetchSimmonsMarket();
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
