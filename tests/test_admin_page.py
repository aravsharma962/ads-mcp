"""Admin page static checks. Chalane ka: python tests/test_admin_page.py"""
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["STORE"] = "memory"
from cryptography.fernet import Fernet
os.environ["TOKEN_ENC_KEY"] = Fernet.generate_key().decode()

PAGE = Path(__file__).resolve().parent.parent / "src" / "admin_page.html"


def html() -> str:
    return PAGE.read_text(encoding="utf-8")


def test_page_exists_and_is_html():
    h = html()
    assert h.lstrip().lower().startswith("<!doctype html>")


def test_page_never_uses_dangerous_html_sinks():
    h = html().lower()
    for bad in ("innerhtml", "insertadjacenthtml", "outerhtml", "document.write"):
        assert bad not in h, bad


def test_page_sends_x_admin_header():
    h = html()
    assert "X-Admin" in h
    assert "same-origin" in h


def test_token_input_is_password_type():
    h = html()
    m = re.search(r"<input[^>]*id=\"tok\"[^>]*>", h)
    assert m and 'type="password"' in m.group(0)
    # no text-type input for the token anywhere
    assert not re.search(r"<input[^>]*type=\"text\"[^>]*id=\"tok\"", h)


def test_no_external_script_or_link_sources():
    h = html()
    for tag in re.findall(r"<(?:script|link|img|iframe)\b[^>]*>", h, flags=re.I):
        assert not re.search(r"(?:src|href)\s*=\s*[\"']?(?:https?:)?//", tag, flags=re.I), tag
    assert "@import" not in h


def test_page_handles_401_back_to_login():
    h = html()
    assert "401" in h and "showLogin" in h


def test_no_secret_patterns():
    h = html()
    patterns = [
        r"EAA[A-Za-z0-9]{20,}",          # Meta tokens
        r"sk-[A-Za-z0-9]{20,}",
        r"eyJ[A-Za-z0-9_-]{20,}",         # JWTs
        r"AKIA[0-9A-Z]{16}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"(?i)(password|secret|token|api[_-]?key)\s*[:=]\s*[\"'][^\"']{8,}[\"']",
    ]
    for p in patterns:
        assert not re.search(p, h), p


def test_route_serves_page_without_login_and_404_when_disabled():
    from starlette.testclient import TestClient
    import hosted_app
    os.environ["ADMIN_PASSWORD"] = "pw-test-long-enough-123"
    with TestClient(hosted_app.app, base_url="http://localhost") as c:
        r = c.get("/admin")
        assert r.status_code == 200 and "text/html" in r.headers["content-type"]
        assert r.text == html() and "pw-test-long-enough-123" not in r.text
        os.environ["ADMIN_PASSWORD"] = ""
        assert c.get("/admin").status_code == 404
    os.environ["ADMIN_PASSWORD"] = "pw-test-long-enough-123"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("OK ", name)
    print("ALL TESTS PASSED")
