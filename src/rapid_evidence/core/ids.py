import secrets
import string


_ALPHABET = string.ascii_letters + string.digits + "-_"


def new_id(prefix: str) -> str:
    suffix = secrets.token_urlsafe(12)
    suffix = suffix.translate(str.maketrans("-._", "___"))
    return f"{prefix}-{suffix[:12]}"
