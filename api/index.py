"""Vercel entry point. Vercel is file mein `app` (ASGI) dhoondhta hai."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from hosted_app import app  # noqa: E402,F401
