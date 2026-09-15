"""기사 썸네일 이미지 프록시.

왜 필요한가
-----------
배포본은 https 로 서비스되는데, 국내 언론사 썸네일 중에는
  (a) http 로만 제공되거나,
  (b) https 인증서가 만료된
호스트가 있다. 둘 다 브라우저가 막아 버려(전자는 mixed content, 후자는
인증서 오류) 이미지가 통째로 안 뜬다. 실제로 wsobi.com 은 인증서가 만료돼
https 가 거부되고, http 는 mixed content 로 막힌다 — 어느 쪽으로도 못 받는다.

그래서 서버가 대신 받아서 같은 출처(https)로 흘려 준다.

★ 화면에서는 이 경로를 기본으로 쓰지 않는다. 직접 로드가 실패했을 때만
  onerror 에서 한 번 우회한다(app.js skImgFallback) — 평소에는 대역폭을 쓰지 않는다.

안전장치 (임의 주소를 받아 주는 엔드포인트라 반드시 필요하다)
-----------------------------------------------------------
- http/https 만 허용
- 사설·루프백·링크로컬 대역으로는 요청하지 않는다(SSRF 차단)
- 응답이 image/* 가 아니면 거부
- 최대 크기 제한, 짧은 타임아웃
- 리다이렉트를 직접 따라가며 매 홉마다 위 검사를 다시 한다
"""

import ipaddress
import socket
import urllib.parse
from http.server import BaseHTTPRequestHandler

import requests

MAX_BYTES = 6 * 1024 * 1024        # 6MB — 기사 썸네일은 보통 수백 KB
TIMEOUT = 8
MAX_REDIRECTS = 3
UA = {"User-Agent": "Mozilla/5.0 (compatible; SimmonsDashboard/1.0)"}


def _is_public_host(host):
    """호스트가 공인 IP 로만 풀리는지. 하나라도 사설이면 False(SSRF 차단)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:  # noqa: BLE001
        return False
    if not infos:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def _check(url):
    """허용되는 주소면 (True, None), 아니면 (False, 사유)."""
    try:
        u = urllib.parse.urlparse(url)
    except Exception:  # noqa: BLE001
        return False, "주소를 해석할 수 없습니다"
    if u.scheme not in ("http", "https"):
        return False, "http/https 만 허용합니다"
    if not u.hostname:
        return False, "호스트가 없습니다"
    if not _is_public_host(u.hostname):
        return False, "내부망 주소로는 요청하지 않습니다"
    return True, None


def fetch_image(url):
    """이미지를 받아 (content, content_type) 로 돌려준다. 실패하면 예외."""
    seen = 0
    while True:
        ok, why = _check(url)
        if not ok:
            raise ValueError(why)
        # ★ verify=False: 인증서가 만료된 언론사 호스트를 받으려는 것이 이 함수의
        #   존재 이유다. 받아 오는 것은 공개된 기사 썸네일뿐이고, 자격증명을
        #   실어 보내지 않으므로(쿠키·인증 헤더 없음) 이 경로에서는 감수한다.
        r = requests.get(url, headers=UA, timeout=TIMEOUT, stream=True,
                         allow_redirects=False, verify=False)
        if r.status_code in (301, 302, 303, 307, 308):
            loc = r.headers.get("Location")
            r.close()
            seen += 1
            if not loc or seen > MAX_REDIRECTS:
                raise ValueError("리다이렉트가 너무 많습니다")
            url = urllib.parse.urljoin(url, loc)
            continue
        r.raise_for_status()
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if not ctype.startswith("image/"):
            r.close()
            raise ValueError("이미지가 아닙니다 (%s)" % (ctype or "unknown"))
        buf = bytearray()
        for chunk in r.iter_content(64 * 1024):
            buf.extend(chunk)
            if len(buf) > MAX_BYTES:
                r.close()
                raise ValueError("이미지가 너무 큽니다")
        r.close()
        return bytes(buf), ctype


class handler(BaseHTTPRequestHandler):      # noqa: N801  (Vercel 규약)
    def do_GET(self):                        # noqa: N802
        qs = urllib.parse.urlparse(self.path).query
        url = (urllib.parse.parse_qs(qs).get("u") or [""])[0]
        if not url:
            self._fail(400, "u 파라미터가 필요합니다")
            return
        try:
            content, ctype = fetch_image(url)
        except Exception as e:               # noqa: BLE001
            self._fail(502, str(e)[:200])
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        # 하루 캐시 — 같은 썸네일을 매번 다시 받지 않게
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(content)

    def _fail(self, code, msg):
        body = msg.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):            # noqa: D102  (Vercel 로그 소음 줄이기)
        return
