import ipaddress
import socket
from urllib.parse import urlparse


class GuardedHTTPTransport:
    def __init__(self, fallback=None):
        self.fallback = fallback


def validate_public_http_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("URL must use http or https")
    if not parsed.hostname:
        raise ValueError("URL must include host")

    try:
        if parsed.hostname.replace(".", "").isdigit() and parsed.hostname.count(".") >= 3:
            ip = ipaddress.ip_address(parsed.hostname)
        else:
            infos = socket.getaddrinfo(parsed.hostname, None, proto=socket.IPPROTO_TCP)
            ip = ipaddress.ip_address(infos[0][4][0])
    except OSError as exc:
        raise ValueError(f"failed to resolve host: {parsed.hostname}") from exc

    if not ip.is_global:
        raise ValueError("URL resolves to a non-public address")

    return url
