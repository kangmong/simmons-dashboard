# -*- coding: utf-8 -*-
"""Gemini 로 JSON 한 덩어리를 받는 공용 호출.

환율 해석 수집기(fx_analysis.py)가 쓰는 모델 고르기(pick_model)와 키 읽기
(_load_env_key)를 그대로 빌려 쓴다 — 모델 이름을 여기 따로 적지 않는다.

★ 이 함수는 '받아 온 JSON' 만 돌려준다. 받아들일지 말지(원문 대조·날짜 검사)는
  부르는 쪽이 정한다. AI 가 준 값을 그대로 믿고 쓰지 않는다.
★ 실패하면 예외 대신 (None, 이유) 를 돌려준다 — 부르는 쪽이 기존 데이터를
  그대로 두고 넘어갈 수 있게.
"""
import json
import os
import time

import requests

from fx_analysis import GEM_BASE, HDR, _load_env_key, _strip_fence, pick_model


def gemini_json(prompt, schema, temperature=0.1, max_tokens=8192, tag="ai"):
    key = _load_env_key("GEMINI_API_KEY")
    if not key:
        return None, "GEMINI_API_KEY 가 없습니다(.env 또는 GitHub Secrets)"
    model, order, memo = pick_model(key, os.environ.get("GEMINI_MODEL"))
    if not model:
        return None, "쓸 수 있는 Gemini 모델이 없습니다: %s" % memo
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,   # 3.x Flash 는 사고 토큰을 여기서 먼저 쓴다
            "responseMimeType": "application/json",
            "responseSchema": schema,
        },
    }
    hdr = dict(HDR, **{"x-goog-api-key": key, "content-type": "application/json"})
    last = "원인 미기록"
    for mdl in order[:4]:
        url = "%s/models/%s:generateContent" % (GEM_BASE, mdl)
        for attempt in range(3):
            try:
                r = requests.post(url, headers=hdr, json=body, timeout=90)
                if r.status_code in (404, 400) and attempt == 0:
                    last = "%s HTTP %s" % (mdl, r.status_code)
                    break                                  # 이 모델은 못 쓴다 → 다음
                if r.status_code in (429, 500, 503):
                    last = "%s HTTP %s" % (mdl, r.status_code)
                    time.sleep(4 * (2 ** attempt))
                    continue
                r.raise_for_status()
                d = r.json()
                cands = d.get("candidates") or []
                if not cands:
                    last = "%s 응답 없음" % mdl
                    break
                text = "".join(p.get("text", "") for p in
                               (cands[0].get("content") or {}).get("parts") or [])
                return json.loads(_strip_fence(text)), mdl
            except json.JSONDecodeError as e:
                last = "%s JSON 파싱 실패: %s" % (mdl, e)
                break
            except Exception as e:  # noqa: BLE001
                last = "%s %s" % (mdl, str(e)[:140])
                if attempt < 2:
                    time.sleep(4 * (2 ** attempt))
                    continue
                break
        print("[%s] 모델 %s 실패 → 다음 후보 (%s)" % (tag, mdl, last))
    return None, last
