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

## 이탈리아 시장 지표

| 지표 | 소스 | 키 | 주기 |
|---|---|---|---|
| 가격지수 | Eurostat HICP `prc_hicp_midx` · COICOP **CP05111**(Household furniture) | 불필요 | 월 → 연평균 |
| 수입단가 | UN Comtrade · HS 940421/940429 · 금액÷중량 | 불필요 | 월 → 연 |

★ 매트리스 전용 HICP 코드는 없다. COICOP 468개를 전수 조회해 확인했고
`CP05111`(가정용 가구)이 최근접이다. 책상·의자도 함께 포함된다.

`italy_trade.py` 는 증분 수집이다(한 요청에 기간 1개, 초당 1회 제한).
과거 구간을 채우려면:

```bash
python italy_trade.py --fill 12
```

공표 지연이 약 3개월이라 최신 확정치는 2~3개월 전 데이터다.

## 미국 매트리스 가격·교역 지표

`us_market.py` 가 두 소스를 모은다. **'시장 규모'가 아니다** — 무료 공개 통계에
티어별·전체 시장 규모가 존재하지 않음이 조사로 확인됐다(ISPA 회원 전용,
Census ASM 수량 없음, Current Industrial Reports 폐지).

| 지표 | 소스 | 키 | 주기 |
|---|---|---|---|
| 매트리스 출고가격 지수 | BLS PPI `PCU337910337910` | **불필요** | 월 |
| 비교용 전체 상품 PPI | BLS PPI `WPU00000000` | 불필요 | 월 |
| 매트리스 수입 단가 | UN Comtrade · HS 9404 · reporter=USA(842) | **불필요** | 월 |

### 수입 단가는 왜 '개당'인가

미국은 **개당(USD/개)**, 이탈리아는 **kg당(USD/kg)** 이다. 원칙은 하나다 —
**그 나라가 실제로 보고한 수량을 쓴다.**

| | 중량 netWgt | 수량 qty | 쓰는 단가 |
|---|---|---|---|
| 미국(842) | `isNetWgtEstimated=True` (추정) | `isQtyEstimated=False` · 단위 5=개 | **개당** |
| 이탈리아(380) | `isNetWgtEstimated=False` (실보고) | `isQtyEstimated=True` (추정) | **kg당** |

미국 `netWgt` 은 Comtrade 가 금액을 **연도별 고정계수로 나눠 역산한 값**이다.
실측하면 금액÷중량이 2024년 전월 `7.2196`, 2025년 전월 `6.7784` USD/kg 로
소수 4자리까지 같다. 월별 정보가 0 이므로 이 값으로 단가 그래프를 그리면
Comtrade 계수의 계단만 보인다. 그래서 쓰지 않는다.

수량 단위 코드는 공식 레퍼런스로 확인했다 —
`https://comtradeapi.un.org/files/v1/app/reference/QuantityUnits.json`
에서 `5 = "u" Number of items`, `8 = "kg" Weight in kilograms`.

### Census 를 쓰지 않는 이유

Census 국제무역 API 도 무료지만 **키 발급이 필수**다(키 없이 호출하면 JSON 이
아니라 `Missing Key` HTML 이 200 으로 돌아온다). 키가 없는 동안 수입단가 선이
아예 비었다. UN Comtrade 공개 preview 는 키가 필요 없고 같은 HS 세분 코드로
금액·수량이 함께 오므로 2026-08 에 갈아탔다. `CENSUS_API_KEY` 는 더 이상
쓰지 않는다.

### UN Comtrade 호출 제한

실측(2026-08): 무간격 연속 8회 모두 HTTP 200, 레이트 리밋 헤더는 없다.
`reporterCode="842,380"` 처럼 두 나라를 한 요청에 넣는 것도 되지만, 이탈리아
저장 포맷을 건드리지 않기 위해 나라별 파일로 분리했다. 한 실행에서 새로 받는
달이 나라당 `MAX_NEW=4` 개뿐이라 호출 수는 문제가 되지 않는다(간격 1.2초 유지).

`europe_flow` 와 `us_market` 은 같은 수집 그룹에 두어 두 나라의 Comtrade 호출이
**동시에 나가지 않게** 했다(그룹끼리는 병렬, 그룹 안은 순차).

과거 구간을 채우려면:

```bash
python us_trade.py --fill 25
```

### BLS 시리즈에 대해

조사에서 실재를 확인한 코드만 쓴다. 후보로 시험한 `WPU121103` / `WPU1210` /
`PCU33791033791011` 은 모두 "Series does not exist" 였다. 다른 코드를 추측해
넣지 말 것.

BLS 원지수는 기준연도가 시리즈마다 달라 수준 비교가 성립하지 않는다. 그래서
화면 기본값은 **표시 구간 첫 달 = 100** 으로 재산정한 지수이고, `원지수` 토글로
BLS 원값도 볼 수 있다.

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
