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

## 이탈리아 수출입 통계

`italy_trade.py` 가 UN Comtrade 공개 preview 엔드포인트로 HS 9404 월별
수출입(금액·순중량)을 받는다. 한 요청에 기간 1개만 허용되고 초당 1회 수준의
레이트 리밋이 있어 **증분 수집**이다. 받아둔 월은
`public/data/italy-trade.json` 에 커밋해 두고, 실행마다 빠진 월만 최대 4개씩
채운다. 과거 구간을 한 번에 채우려면:

```bash
python italy_trade.py --fill 10   # 최대 10회 반복 실행
```

공표 지연이 약 3개월이라 최신 확정치는 항상 2~3개월 전 데이터다.

### 단가 기반 티어

단가(= 금액 ÷ 순중량, USD/kg)의 분위로 티어를 나눈다. 대상은 매트리스
3개 하위코드(9404.10·.21·.29)다.

| 구간 | 기준 |
|---|---|
| 하이엔드 | 단가 ≥ Q3 |
| 프리미엄 | Q2 ≤ 단가 < Q3 |
| 제외 | 단가 < Q2 (저가 물량) |

경계는 매 실행에서 재계산되고 수집 로그에 분포·경계·티어별 건수가 찍힌다.
방식을 바꾸려면 `italy_trade.py` 의 `TIER_MODE` / `TIER_HS` 를 고친다.

## 미국 매트리스 가격·교역 지표

`us_market.py` 가 두 소스를 모은다. **'시장 규모'가 아니다** — 무료 공개 통계에
티어별·전체 시장 규모가 존재하지 않음이 조사로 확인됐다(ISPA 회원 전용,
Census ASM 수량 없음, Current Industrial Reports 폐지).

| 지표 | 소스 | 키 | 주기 |
|---|---|---|---|
| 매트리스 출고가격 지수 | BLS PPI `PCU337910337910` | **불필요** | 월 |
| 비교용 전체 상품 PPI | BLS PPI `WPU00000000` | 불필요 | 월 |
| 매트리스 수입 단가 | Census 국제무역 API · HS 9404 | **필요** | 월 |

### Census API 키 발급

1. https://api.census.gov/data/key_signup.html 에서 이메일로 신청한다(무료·즉시).
2. 메일로 받은 키를 프로젝트 루트 `.env` 에 넣는다.

```
CENSUS_API_KEY=여기에_발급받은_키
```

3. GitHub Actions 자동 수집에도 쓰려면 저장소 Settings → Secrets and variables →
   Actions 에 `CENSUS_API_KEY` 를 추가하고, `.github/workflows/collect.yml` 의
   수집 스텝 `env:` 에 `CENSUS_API_KEY: ${{ secrets.CENSUS_API_KEY }}` 를 넣는다.

**키가 없어도 정상 동작한다.** 수입 단가 블록만 숨고 PPI 는 그대로 표시된다.
`.env` 는 `.gitignore` 에 있어 커밋되지 않는다.

### BLS 시리즈에 대해

조사에서 실재를 확인한 코드만 쓴다. 후보로 시험한 `WPU121103` / `WPU1210` /
`PCU33791033791011` 은 모두 "Series does not exist" 였다. 다른 코드를 추측해
넣지 말 것.

BLS 원지수는 기준연도가 시리즈마다 달라 수준 비교가 성립하지 않는다. 그래서
화면 기본값은 **표시 구간 첫 달 = 100** 으로 재산정한 지수이고, `원지수` 토글로
BLS 원값도 볼 수 있다.
