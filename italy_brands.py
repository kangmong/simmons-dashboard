# -*- coding: utf-8 -*-
"""이탈리아 프리미엄 매트리스 브랜드 — 참고 정보 (단일 관리 지점).

★ 브랜드를 추가·수정할 일이 생기면 이 파일만 고친다.
★ 세 곳 모두 비상장이라 분기 실적이 없다. 추정 매출을 만들지 않는다.
★ verified=False 인 항목은 화면에 '확인 필요'로 표시된다. 확인되지 않은 값은
  비워 두고(빈 문자열) 지어내지 않는다.

확인 근거(2026-08 조사):
  Dorelan     dorelan.com/pages/about-us — 연혁 첫 항목 1968, 본사 Forlì.
              페이지 하단 사업자 정보가 "B&T Srl"(Forlì FC). Srl 은 이탈리아법상
              증권시장 상장이 불가한 형태여서 비상장이 확정된다.
  Altrenotti  altrenotti.it/en/contacts — 법인명 "Absolutely Italian Goods SpA",
              본사 Via degli Artigiani 2, 10017 Montanaro (TO). 1930년 토리노
              공방에서 시작한 4대 가족기업. SpA 이지만 상장 근거는 찾지 못했다.
  Bellaflex   ★이탈리아 브랜드로 확인되지 않는다. 검색되는 Bellaflex(bellaflex.co)
              는 레바논 트리폴리 소재로 1963년 설립(=60년 역사와 일치)이며
              사이트 제목도 "Premium Bedding & Mattresses Lebanon" 이다.
              동명의 이탈리아 업체는 찾지 못했다 → 국적·설립연도·본사를 비워 두고
              화면에 확인 필요로 표시한다.
"""

# name         : 표시명
# founded      : 설립연도(문자열, 미확인이면 "")
# hq           : 본사 소재지(미확인이면 "")
# entity       : 법인명(있으면 표기)
# positioning  : 포지셔닝 한 줄
# listed       : 상장 여부 — True / False / None(미확인)
# verified     : 위 정보가 출처로 확인됐는지
# note         : 화면에 함께 띄울 단서(없으면 "")
ITALY_BRANDS = [
    {
        "name": "Dorelan",
        "founded": "1968",
        "hq": "포를리(Forlì), 에밀리아로마냐",
        "entity": "B&T Srl",
        "positioning": "이탈리아 수면용품 시장 선도 업체. 포를리 4만㎡ 생산시설을 두고 "
                       "호텔 컨트랙트(Dorelan Hotel) 사업을 함께 운영한다.",
        "listed": False,
        "verified": True,
        "note": "",
    },
    {
        "name": "Altrenotti",
        "founded": "1930",
        "hq": "몬타나로(Montanaro), 토리노주 피에몬테",
        "entity": "Absolutely Italian Goods SpA",
        "positioning": "토리노 공방에서 시작한 4대 가족기업. 럭셔리 매트리스·침대·"
                       "베드리넨을 수작업 기반으로 만든다.",
        "listed": False,
        "verified": True,
        "note": "'100년 전통'으로 알려져 있으나 확인된 설립연도는 1930년(약 96년)이다.",
    },
    {
        "name": "Bellaflex",
        "founded": "",
        "hq": "",
        "entity": "",
        "positioning": "",
        "listed": False,
        "verified": False,
        "note": "이탈리아 브랜드로 확인되지 않는다. 검색되는 Bellaflex 는 레바논 "
                "트리폴리 소재(1963년 설립)로, 60년 역사라는 설명과 일치한다. "
                "동명의 이탈리아 업체는 찾지 못해 설립연도·본사를 비워 두었다.",
    },
]

ITALY_BRANDS_NOTE = "비상장 기업으로 실적 미공시 · 참고 정보"

# 상장사가 나타나면 여기에 티커를 넣는다(현재는 없음). 값이 있으면 프런트가
# 차트 라인 추가를 검토할 수 있게 payload 에 실려 나간다.
ITALY_LISTED_TICKERS = []


def italy_brands_payload():
    """프런트로 보낼 브랜드 정보(사본)."""
    return {
        "note": ITALY_BRANDS_NOTE,
        "listed_tickers": list(ITALY_LISTED_TICKERS),
        "brands": [dict(b) for b in ITALY_BRANDS],
    }
