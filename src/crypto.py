"""Tokens ko encrypt/decrypt karna (Fernet). Key sirf environment mein rehti hai."""
import os

from cryptography.fernet import Fernet, InvalidToken


class CryptoError(Exception):
    pass


def _fernet() -> Fernet:
    key = os.environ.get("TOKEN_ENC_KEY")
    if not key:
        raise CryptoError("TOKEN_ENC_KEY set nahi hai")
    try:
        return Fernet(key.encode())
    except Exception as e:
        raise CryptoError("TOKEN_ENC_KEY sahi Fernet key nahi hai") from e


def encrypt(text: str) -> str:
    return _fernet().encrypt(text.encode()).decode()


def decrypt(blob: str) -> str:
    try:
        return _fernet().decrypt(blob.encode()).decode()
    except InvalidToken as e:
        raise CryptoError("Token decrypt nahi hua (key badal gayi ya data kharab)") from e
