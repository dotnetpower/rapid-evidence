import json
import os
import threading


class JsonlAuditLedger:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()

    def record(self, event_type: str, payload: dict) -> None:
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        with self._lock:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                line = json.dumps({"event_type": event_type, "payload": payload}, sort_keys=True) + "\n"
                os.write(fd, line.encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
