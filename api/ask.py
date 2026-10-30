# -*- coding: utf-8 -*-
"""POST /api/ask — AI에게 물어보기(베타). 실제 처리는 프로젝트 루트의 ask_core.py.

★ 질문 원문을 로그로 남기지 않는다(print 하지 않는다).
★ 다른 출처에서 부르지 못하게 CORS 허용 헤더를 붙이지 않는다(같은 사이트 화면만 쓴다).
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ask_core  # noqa: E402

BODY_MAX = 4096


class handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > BODY_MAX:
                return self._send(400, {"ok": False, "kind": "error", "text": "요청이 올바르지 않습니다."})
            data = json.loads(self.rfile.read(n).decode("utf-8"))
            ip = (self.headers.get("x-forwarded-for") or "").split(",")[0].strip() or "?"
            status, out = ask_core.answer(data.get("q"), ip=ip, prev=data.get("prev") or [])
            self._send(status, out)
        except Exception:  # noqa: BLE001 — 질문 내용은 남기지 않는다
            self._send(500, {"ok": False, "kind": "error", "text": "일시적인 오류가 났습니다. 잠시 후 다시 시도해 주세요."})

    def do_GET(self):
        self._send(405, {"ok": False, "kind": "error", "text": "POST 로만 질문할 수 있습니다."})
