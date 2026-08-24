# SIMMONS 해외 매트리스 업계 동향 대시보드

정적 화면(`index.html` + `app.js` + `styles.css`) + 실시간 데이터 API(`/api/update`) 로 구성된
글로벌 매트리스 시장 인텔리전스 대시보드입니다. **API 키를 전혀 쓰지 않고** 공개 소스만 사용합니다.

- **시몬스 코리아 소식** — Google News RSS (팝업·행사·신제품 등 국내 소식)
- **경쟁사 분석** — SEC EDGAR (Sleep Number·Tempur Sealy 재무/매출추이)
- **업계 주요 뉴스** — Google News RSS + 제목 한국어 번역
- **원자재·원가 동향** — World Bank 핑크시트(월간 원자재 가격) + 원화 환산
- **환율** — Frankfurter(ECB) USD/KRW

> 화면은 항상 **빈 초기 상태**로 시작하며, 사이드바 **[업데이트]** 버튼을 눌러야
> `/api/update` 에서 데이터를 받아 채웁니다.

---

## 프로젝트 구조

```
├─ index.html            # 대시보드 화면
├─ app.js                # 프런트 로직 (fetch 경로 = 상대경로 '/api/update')
├─ styles.css
├─ api/
│  └─ update.py          # ▶ Vercel 서버리스 함수 (배포용). 모든 데이터 수집 로직.
├─ dashboard_server.py   # ▶ 로컬 개발용 Flask 서버 (같은 로직, 로컬 테스트 전용)
├─ vercel.json           # 라우팅: /api/update → 함수, 그 외 → 정적 파일
├─ requirements.txt      # requests / pandas / openpyxl
├─ .gitignore            # csv·log·__pycache__ 등 제외
└─ .vercelignore         # 배포 번들에서 dashboard_server.py·csv·log 제외
```

> `api/update.py` 와 `dashboard_server.py` 는 **같은 수집 로직**을 담고 있습니다(하나는 서버리스,
> 하나는 Flask). 데이터 로직을 고칠 때는 **두 파일을 함께** 맞춰 주세요.

---

## 1) 로컬에서 실행 (Flask)

`dashboard_server.py` 가 정적 파일 + `/api/update` 를 같은 출처(`:5000`)로 서빙합니다.

```bash
pip install flask flask-cors requests pandas openpyxl
python dashboard_server.py
# 브라우저에서 http://127.0.0.1:5000 접속 → [업데이트] 클릭
```

## 1-b) 로컬에서 Vercel 함수 그대로 실행 (선택)

Vercel CLI 로 서버리스 함수까지 로컬에서 똑같이 구동할 수 있습니다.

```bash
npm i -g vercel
vercel dev
# http://localhost:3000 접속
```

---

## 2) GitHub 에 올리고 Vercel 에 배포하기

### (A) GitHub 저장소에 올리기

프로젝트 폴더에서:

```bash
git init
git add .
git commit -m "SIMMONS 매트리스 동향 대시보드 (Vercel 구조)"

# GitHub 에서 빈 저장소를 먼저 만든 뒤, 그 주소로 연결
git remote add origin https://github.com/<사용자명>/<저장소명>.git
git branch -M main
git push -u origin main
```

> `.gitignore` 가 `*.csv` / `*.log` / `__pycache__` 를 자동 제외하므로 배포에 필요한 파일만 올라갑니다.

### (B) Vercel 에 배포하기

**방법 1 — 웹 대시보드 (권장, 가장 쉬움)**

1. [vercel.com](https://vercel.com) 로그인 → **Add New… → Project**
2. **Import Git Repository** 에서 방금 올린 GitHub 저장소 선택
3. 설정은 건드릴 것 없이(`vercel.json` 이 라우팅을 처리) **Deploy** 클릭
4. 빌드가 끝나면 `https://<프로젝트>.vercel.app` 주소가 나옵니다 → 접속 후 **[업데이트]** 클릭

**방법 2 — Vercel CLI**

```bash
npm i -g vercel
vercel          # 최초: 질문 몇 개에 답하면 프리뷰 배포
vercel --prod   # 프로덕션(정식 도메인)으로 배포
```

이후 GitHub `main` 에 push 할 때마다 **자동 재배포**됩니다.

```bash
git add .
git commit -m "변경 내용"
git push
```

---

## 응답 형식 (`/api/update`)

`GET /api/update` → 모든 섹션을 모아 아래 JSON 반환(개별 섹션 실패는 그 섹션 `status` 로만 표시):

```json
{
  "updated_at": "2026-07-21 14:58:13",
  "sections": {
    "simmons_news": { "status": "ok", "items": [ { "title": "...", "source": "...", "date": "...", "link": "...", "image": null } ] },
    "news":        { "status": "ok", "items": [ { "title": "...", "title_ko": "...", "link": "...", "date": "..." } ] },
    "competitors": { "status": "ok", "companies": [ { "ticker": "SNBR", "revenue": ..., "revenue_trend": {...} } ] },
    "fx":          { "status": "ok", "pair": "USD/KRW", "rate": 1481.18, "change_pct": 0.12, "date": "2026-07-20" }
  }
}
```

---

## 원자재 · 원가 동향 (ICIS 시황 그래프)

스폰지 주원료(PPG·TDI·MDI·PO) 월별 시황은 `app.js` 의 `ICIS_DATA` 상수로 그립니다(외부 호출 없음).
그 아래 "주요 시황 원자재 링크"는 `MATERIAL_LINKS` 상수의 외부 사이트로 연결됩니다.

## 미국 매트리스 제조업 PPI (국외 섹션의 유일한 지표)

`us_ppi.py` 하나가 담당한다. **API 키가 필요 없고 비용도 없다.**

| 항목 | 값 |
|---|---|
| 소스 | 미국 노동통계국(BLS) 공개 API **v1** — https://www.bls.gov/developers/ |
| 시리즈 | `PCU337910337910` — PPI industry data for Mattress mfg, NSA (NAICS 337910) |
| 기준월 | **1983년 6월 = 100** (data.bls.gov 시리즈 페이지 `Base Date = 198306` 실측 확인) |
| 구간 | 2016년 1월 ~ 현재 · 월별 → **연평균**으로 집계해 선 그래프 하나 |
| 키 | **불필요** |

### 왜 '전체' 하나뿐인가 — 하이엔드/프리미엄이 없는 이유

이 시리즈는 스프링·폼·에어·특수 매트리스를 **하나로 평균한 값**이고, BLS 는
NAICS 337910 아래에 가격대별 하위 시리즈를 발표하지 않는다. 지수 안에서
"프리미엄만" 떼어낼 방법이 데이터 구조상 없다.

★ 예전 화면의 `하이엔드`/`프리미엄` 버튼은 **가격대가 아니라 HS 코드(소재)** 를
  전환하는 것이었다 — 하이엔드=940421(폼·라텍스), 프리미엄=940429(스프링 등).
  가격대 근거가 없는 라벨이라 2026-08 에 걷어냈다. 함께 제거한 것:
  `tiers.py` · `us_market.py` · `us_trade.py` · `italy_trade.py` · `italy_hicp.py`
  · `europe_flow.py` · `public/data/{us,italy}-trade.json`.
  (이탈리아 Eurostat HICP 지표는 이번 개편 대상에서 제외했다 — 다시 필요해지면
   별도로 붙인다.)

### v1 API 의 실측 제약 (2026-08, 실제 호출로 확인)

| | |
|---|---|
| 한 요청 기간 | **10년까지** — 2016~2026 을 한 번에 넣으면 `"Year range has been reduced to the system-allowed limit of 10 years."` 가 붙고 **뒤쪽 연도가 잘린다** |
| 그래서 | `CHUNK_YEARS = 10` 으로 쪼개 **2회** 호출한다(2016~2025 · 2026~) |
| 일 호출 한도 | 25회 / IP — 하루 1회 자동 수집에서 2회만 쓴다 |
| 잠정치 | 최근 4개월은 footnote `code="P"` (Preliminary). 공표 후 4개월까지 개정된다 |

증분 저장을 두지 않는다 — 매 실행에서 2016년부터 **전 구간을 다시 받으므로**
BLS 개정치가 자동으로 반영된다.

### 설명표는 어떻게 만들어지는가

차트 아래 13행 설명표는 `us_ppi.py` 가 `payload["table"]` (`[{k, v}]`) 로 계산해
보내고, `app.js` 의 `gPpiTable()` 이 그대로 그린다. **숫자를 하드코딩하지 않는다.**

| 표의 행 | 어디서 나오나 |
|---|---|
| 최근 값 / 몇 배 | 마지막 월 관측치와 `값 ÷ 100` |
| `2016~2020년 흐름` 등 | `BAND_EDGES` 구간의 **첫 달 → 마지막 달** 월값 + 연 환산 변화율로 고른 추세 문구 |
| 정체 구간의 `248~255` | 그 구간 월값의 최소~최대 (한 점만 찍으면 '정체'라는 말과 어긋나 보인다) |
| 진행 중인 해 | 부분 연도 첫 달 → 마지막 달 + 잠정치 개월 수 |
| 한 줄 요약 | 전체 방향 + 연 환산 변화율이 가장 컸던 **완전 연도** 구간 |

구간 경계(`BAND_EDGES`)만 편집 판단이다. 마지막 구간은 `None` 이라 **마지막 완전
연도까지 스스로 늘어나고**, 진행 중인 해 행은 해가 바뀌면 자동으로 다음 해로
옮겨 간다 — 새 데이터가 들어와도 표를 손댈 필요가 없다.

### 자동 갱신

`us_ppi` 는 `FETCHERS` 에 등록되어 있어 **KOIMA 월간지수(`koima_index`)와 똑같이**
`.github/workflows/collect.yml` 이 매일 새벽(UTC 20:00 = KST 05:00) 돌면서 받아
`public/data/dashboard.json` 에 커밋한다. BLS 가 새 달을 발표하면 **다음 실행에서
그래프와 설명표에 자동 반영된다**(매달보다 촘촘한 주기이고, 내용이 바뀌지 않은
날은 커밋하지 않는다).

수동 확인:

```bash
python us_ppi.py            # BLS 호출 → 연평균·구간·설명표를 JSON 으로 출력
```

## 국내 실적·점유율 (시몬스·코웨이·에이스침대)

`public/data/simmons-market.json` **한 파일이 국내 섹션 세 차트의 유일한 소스**다.
차트에 값을 하드코딩하지 않으므로 이 파일만 고치면 배포 시 반영된다.

| 차트 | 내용 | JSON 키 |
|---|---|---|
| A | 시몬스 최근 실적 추이 (매출 막대 + 영업이익 라인) | `simmonsPerformance` |
| B | 3사 지난해 매출 비교 + 증감률 | `competitorRevenueLastYear` |
| C | 시장 점유율 도넛 | `marketShare2025` |

★ **시몬스는 비상장사다.** DART 등 공시 API 로 자동 조회가 되지 않는다. 수치는
실적 발표 기사(헤럴드경제·아주경제·인더스트리뉴스 등)를 보고 수기 입력한 값이며,
같은 사실을 차트 A 우측 상단 ⓘ 툴팁에 표시한다.

`isProvisional: true` 로 두면 **잠정치** 배지가 뜬다(확정 실적 발표 전 1~2월용).
연도별로 표시하려면 해당 `simmonsPerformance` 항목에 `"provisional": true` 를 넣는다.

### 새 연도 실적 기사 알림 (무료 · 수동 반영)

`.github/workflows/check-simmons-earnings.yml` → `scripts/check-news-alert.js`

★ **API 키도 결제도 필요 없다.** 예전에 있던 Anthropic API 기반 "자동 검색 +
  자동 merge" 파이프라인은 걷어냈다. 이제 이 자동화는 **알림만 보낸다** —
  데이터 파일은 건드리지 않고, 사람이 Issue 를 보고 손으로 반영한다.

**쓰는 것**

| | |
|---|---|
| 뉴스 검색 | Google 뉴스 RSS `news.google.com/rss/search` — 키 불필요 |
| HTTP | Node 내장 `https` 모듈 (라이브러리 설치 없음) |
| XML 파싱 | 정규식으로 `<item>` 의 `<title>`·`<link>` 만 추출 (파서 불필요) |
| Issue 생성 | GitHub REST API · 기본 `GITHUB_TOKEN` |

**실행 시점** — 3월 1~31일 + 4월 1~15일 매일 06:00 UTC(15:00 KST).
cron 은 이 구간을 한 줄로 못 쓰므로 두 줄로 나눴고, cron 은 월·일만 거르므로
시즌을 벗어난 실행은 첫 스텝에서 즉시 skip 한다. 수동 실행도 된다 —
`dry_run`(Issue 안 만듦) / `force`(시즌 밖에서도 실행).

**동작**

1. `simmonsPerformance` 의 **마지막 연도 + 1** 을 계산한다.
   연도를 하드코딩하지 않으므로 2027년에도 코드를 고칠 필요가 없다.
2. 검색어 3개를 각각 따로 호출 — `시몬스 {연도}년 매출` /
   `에이스침대 {연도}년 매출` / `코웨이 {연도}년 매트리스 매출`
3. 제목에 **그 연도 숫자**가 있고 **`매출` 또는 `억원`** 이 있는 것만 남긴다.
   (예: `시몬스 "작년 매출 3천239억원"` 은 연도 숫자가 없어 걸러진다 — 지난해 기사다)
4. `public/data/.seen-news-urls.json` 과 대조해 **새 링크만** 남긴다.
   같은 기사로 매일 중복 알림이 가지 않게 한다.
5. 하나라도 남으면 Issue 를 열고, 알림 보낸 링크를 seen 파일에 기록해 커밋한다.
   (Issue 생성이 성공한 뒤에만 기록한다 — 실패하면 다음 날 다시 알린다)
6. 없으면 아무것도 하지 않고 조용히 종료한다.

Issue 본문에는 검색어별 기사 제목·링크와 반영 체크리스트가 들어간다. RSS 검색은
관련도 기준이라 **분기 실적 기사가 섞일 수 있어서**, 체크리스트에 "연간(12월 결산)
수치인가", "서로 다른 언론사 2곳 이상에서 같은 수치인가" 를 넣어 뒀다.

**필요한 권한** — 기본 `GITHUB_TOKEN` 으로 충분하다(`issues: write` + `contents: write`).
따로 발급할 시크릿이 없다.

로컬 테스트 (Issue 생성·파일 쓰기 없이 미리보기만):

```bash
node scripts/check-news-alert.js --dry-run
```

★ `.github/workflows/collect.yml` 에는 `ANTHROPIC_API_KEY` 참조가 남아 있는데
  **이건 실적 알림과 무관하다.** 예측 카드의 해설 문장(`icis_forecast.py` /
  `oil_forecast.py` / `sr_forecast.py`)이 쓰는 것이고, 키가 없으면 통계 예측값만
  표시하는 폴백으로 동작한다. 그래서 지우지 않았다.
