import os

from rapid_evidence.core.models import FetchResult


class FileSystemResultSink:
    def __init__(self, directory: str):
        self.directory = directory

    def write(self, result: FetchResult) -> None:
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        os.chmod(self.directory, 0o700)
        path = os.path.join(self.directory, f"{result.request_id}.json")
        tmp_path = path + ".tmp"
        with open(tmp_path, "wb") as handle:
            payload = (
                f"{{\"request_id\":\"{result.request_id}\",\"source\":\"{result.source}\",\"target\":\"{result.target}\",\"status\":\"{result.status.value}\"}}"
            ).encode("utf-8")
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)
        dir_fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    def list_result_ids(self) -> list[str]:
        if not os.path.isdir(self.directory):
            return []
        return [name.removesuffix(".json") for name in os.listdir(self.directory) if name.endswith(".json")]
