# -*- coding: utf-8 -*-
"""대시보드 데이터 사전 수집 → public/data/dashboard.json (GitHub Actions 전용 러너).

배경: 업데이트 버튼을 누르면 12개 수집기가 돌아 콜드 30초가 걸렸다.
      네트워크 대기가 99%라 코드로 더 줄일 여지가 없어(동시 요청 상향은 차단 위험),
      새벽에 미리 받아 JSON 으로 커밋해 두고 버튼은 그 파일만 읽게 한다.

★ 수집 로직은 api/update.py 의 run_fetchers 를 그대로 재사용한다(새 수집 코드 없음).
  dashboard_server.py 가 아니라 api/update.py 를 쓰는 이유: flask 의존이 없어 CI 에서 가볍다.

★ 내용이 바뀌지 않았으면 파일을 다시 쓰지 않는다.
  updated_at 같은 시각 필드만 달라지는 커밋으로 저장소가 불어나는 것을 막는다.

사용:
    python collect_all.py            # 수집 → 변경 있을 때만 저장
    python collect_all.py --force    # 캐시 무시하고 전부 새로 수집
    python collect_all.py --out PATH # 저장 위치 지정
"""
import io
import os
import sys
import json
import copy
import time
import datetime
import importlib.util

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_REL = os.path.join("public", "data", "dashboard.json")

# 비교에서 무시할 '매번 바뀌는' 필드 — 이것만 다르면 실질 변경이 아니다.
VOLATILE = ("updated_at", "updatedAt", "generated_at", "cached", "cached_at")


def _load_updater():
    """api/update.py 를 모듈로 로드(패키지가 아니라 경로 직접 지정)."""
    path = os.path.join(BASE, "api", "update.py")
    spec = importlib.util.spec_from_file_location("dash_updater", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _strip_volatile(obj):
    """시각·캐시 표시 필드를 재귀적으로 제거한 사본(내용 비교용)."""
    if isinstance(obj, dict):
        return {k: _strip_volatile(v) for k, v in obj.items() if k not in VOLATILE}
    if isinstance(obj, list):
        return [_strip_volatile(v) for v in obj]
    return obj


# ── CI 결과 판정 (--report) ──────────────────────────────────────────────
# ★ 이 단계는 '커밋·푸시 뒤'에 돌린다. 한 수집기가 실패해도 성공한 나머지는
#   이미 커밋된 뒤이므로 롤백되지 않는다. 여기서는 알림만 담당한다.
# 허용 실패 수는 ALLOWED_FAILURES 환경변수로 조정(기본 0 = 하나라도 실패하면 job 실패).
def report(out=None):
    out = out or os.path.join(BASE, OUT_REL)
    allowed = int(os.environ.get("ALLOWED_FAILURES", "0"))
    lines = []

    def say(s):
        print(s)
        lines.append(s)

    if not os.path.isfile(out):
        print("::error::수집 결과 파일이 없습니다: %s" % OUT_REL)
        _summary(["## ❌ 수집 실패", "", "결과 파일(`%s`)이 생성되지 않았습니다." % OUT_REL])
        return 1

    d = json.load(io.open(out, encoding="utf-8"))
    secs = d.get("sections", {})
    bad = [(n, (s or {}).get("reason", "")) for n, s in secs.items()
           if isinstance(s, dict) and s.get("status") not in ("ok", None)]
    ok_n = len(secs) - len(bad)

    say("## %s 수집 결과" % ("✅" if not bad else "⚠️"))
    say("")
    say("- 수집 시각: `%s`" % d.get("updated_at"))
    say("- 성공 **%d / %d**" % (ok_n, len(secs)))

    # 데이터가 며칠째 갱신되지 않으면 알려준다(스케줄이 멈췄을 수 있다).
    try:
        upd = datetime.datetime.strptime(d.get("updated_at", ""), "%Y-%m-%d %H:%M:%S")
        stale = (datetime.datetime.now() - upd).days
        if stale >= 2:
            say("- ⚠️ 마지막 갱신이 **%d일 전**입니다(스케줄 중단 여부 확인)" % stale)
            print("::warning::데이터가 %d일째 갱신되지 않았습니다" % stale)
    except Exception:  # noqa: BLE001
        pass

    if bad:
        say("")
        say("### 실패한 수집기")
        say("")
        say("| 수집기 | 사유 |")
        say("| --- | --- |")
        for n, why in bad:
            say("| `%s` | %s |" % (n, (why or "(사유 없음)").replace("|", "/")[:160]))
            # 실패 원인이 이메일·실행 화면에 바로 보이도록 주석(annotation)으로도 남긴다
            print("::error title=수집 실패: %s::%s" % (n, (why or "사유 없음")[:200]))
    _summary(lines)

    if len(bad) > allowed:
        print("::error::수집기 %d개 실패(허용 %d개) → job 을 실패로 표시합니다: %s"
              % (len(bad), allowed, ", ".join(n for n, _ in bad)))
        return 1
    if bad:
        print("[collect] 실패 %d건이지만 허용치(%d) 이내라 job 은 성공 처리합니다"
              % (len(bad), allowed))
    return 0


def _summary(lines):
    """GitHub Actions 실행 화면 요약(Job Summary)에 표로 남긴다."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with io.open(path, "a", encoding="utf-8") as f:
            f.write(chr(10).join(lines) + chr(10))
    except Exception as e:  # noqa: BLE001
        print("[collect] 요약 기록 실패(무시): %s" % e)


def main():
    if "--report" in sys.argv:
        return report()
    force = "--force" in sys.argv
    out = (sys.argv[sys.argv.index("--out") + 1]
           if "--out" in sys.argv else os.path.join(BASE, OUT_REL))

    up = _load_updater()
    print("[collect] 수집기 %d개 · force=%s" % (len(up.FETCHERS), force))
    t0 = time.time()
    sections = up.run_fetchers(force=force)
    elapsed = time.time() - t0

    ok = [n for n, s in sections.items() if isinstance(s, dict) and s.get("status") == "ok"]
    bad = [n for n, s in sections.items() if isinstance(s, dict) and s.get("status") not in ("ok", None)]
    print("[collect] %.1f초 · 성공 %d/%d" % (elapsed, len(ok), len(sections)))
    if bad:
        for n in bad:
            print("[collect] 실패 %s: %s" % (n, sections[n].get("reason")))

    # 전부 실패했으면 기존 파일을 덮어쓰지 않는다(멀쩡한 데이터를 잃지 않게).
    if not ok:
        print("[collect] 성공한 수집기가 없어 저장하지 않습니다(기존 파일 유지)")
        return 1

    payload = {
        "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "generated_by": "collect_all.py",
        "sections": sections,
    }

    # 기존 파일과 내용 비교 — 시각 필드만 다르면 저장을 생략한다.
    if os.path.isfile(out):
        try:
            old = json.load(io.open(out, encoding="utf-8"))
            if _strip_volatile(old.get("sections")) == _strip_volatile(sections):
                print("[collect] 내용 변경 없음 → 저장 생략 (기존 %s)"
                      % old.get("updated_at"))
                return 0
        except Exception as e:  # noqa: BLE001
            print("[collect] 기존 파일 비교 실패(무시하고 저장): %s" % e)

    d = os.path.dirname(os.path.abspath(out))
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with io.open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print("[collect] 저장: %s (%.0f KB)" % (out, os.path.getsize(out) / 1024.0))
    if bad:
        print("[collect] ⚠ 실패 %d건이 포함된 상태로 저장했습니다: %s" % (len(bad), ", ".join(bad)))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    sys.exit(main())
