"""Small file-backed store: funding settlements (for `/funding/history`), the accounts the
agent has quoted (the keeper's liquidation watch list) and the hedger's orders (for `/hedge`).

NEAR RPC cannot list past events and the contract cannot enumerate accounts, so the agent keeps
both. Losing the files loses history and the watch list, never a balance: the contract's own
state is the source of truth for those. An account missing from the watch list is not scanned
for liquidation until it asks for a quote again, so keep the data directory on a volume that
survives a redeploy.

The two logs are append-only and bounded: once a file holds twice what is kept in memory it is
rewritten with the newest half, so a process that runs for months does not fill its disk.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

MAX_TAKERS = 10_000
MAX_FUNDING_IN_MEMORY = 20_000
MAX_HEDGE_IN_MEMORY = 2_000


class Store:
    def __init__(self, data_dir: Path | None):
        """`data_dir=None` keeps everything in memory (tests, throwaway runs)."""
        self._lock = threading.Lock()
        self._funding: list[dict[str, Any]] = []
        self._takers: dict[str, None] = {}  # insertion-ordered set
        self._hedge: list[dict[str, Any]] = []
        self._funding_path: Path | None = None
        self._takers_path: Path | None = None
        self._hedge_path: Path | None = None
        self._lines: dict[Path, int] = {}  # lines in each log file
        if data_dir is not None:
            data_dir.mkdir(parents=True, exist_ok=True)
            self._funding_path = data_dir / "funding.jsonl"
            self._takers_path = data_dir / "takers.json"
            self._hedge_path = data_dir / "hedge.jsonl"
            self._load()

    def _read_lines(self, path: Path, keep: int) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        if path.exists():
            with path.open() as f:
                for line in f:
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        continue  # a torn last line after a crash
                    del rows[: -keep * 2]  # never hold more than the file is allowed to
        self._lines[path] = len(rows)
        rows = rows[-keep:]
        if self._lines[path] > keep:
            self._rewrite(path, rows)
        return rows

    def _rewrite(self, path: Path, rows: list[dict[str, Any]]) -> None:
        """Replace a log with `rows`, atomically: a crash leaves the old file or the new one."""
        tmp = path.with_suffix(".tmp")
        with tmp.open("w") as f:
            f.writelines(json.dumps(r, separators=(",", ":")) + "\n" for r in rows)
        tmp.replace(path)
        self._lines[path] = len(rows)

    def _append(
        self, path: Path | None, rows: list[dict[str, Any]], keep: int, event: dict[str, Any]
    ) -> None:
        """Add `event` to a log in memory and on disk. The caller holds the lock."""
        rows.append(event)
        del rows[:-keep]
        if path is None:
            return
        with path.open("a") as f:
            f.write(json.dumps(event, separators=(",", ":")) + "\n")
        self._lines[path] = self._lines.get(path, 0) + 1
        if self._lines[path] > keep * 2:
            self._rewrite(path, rows)

    def _load(self) -> None:
        assert self._funding_path and self._takers_path and self._hedge_path
        self._funding = self._read_lines(self._funding_path, MAX_FUNDING_IN_MEMORY)
        self._hedge = self._read_lines(self._hedge_path, MAX_HEDGE_IN_MEMORY)
        if self._takers_path.exists():
            try:
                self._takers = dict.fromkeys(json.loads(self._takers_path.read_text()))
            except ValueError:
                self._takers = {}

    # -- funding ------------------------------------------------------------------------------

    def add_funding(self, event: dict[str, Any]) -> None:
        with self._lock:
            self._append(self._funding_path, self._funding, MAX_FUNDING_IN_MEMORY, event)

    def funding_history(self, series: str | None, limit: int) -> list[dict[str, Any]]:
        """Newest first."""
        with self._lock:
            rows = [e for e in reversed(self._funding) if series is None or e["series"] == series]
        return rows[: max(0, limit)]

    # -- hedge orders -------------------------------------------------------------------------

    def add_hedge_order(self, event: dict[str, Any]) -> None:
        """Append-only record of every order the hedger sent, whatever came of it."""
        with self._lock:
            self._append(self._hedge_path, self._hedge, MAX_HEDGE_IN_MEMORY, event)

    def hedge_orders(self, limit: int) -> list[dict[str, Any]]:
        """Newest first."""
        with self._lock:
            return list(reversed(self._hedge[-max(0, limit) :])) if limit > 0 else []

    # -- takers -------------------------------------------------------------------------------

    def add_taker(self, account_id: str) -> None:
        with self._lock:
            if account_id in self._takers:
                return
            if len(self._takers) >= MAX_TAKERS:
                self._takers.pop(next(iter(self._takers)))  # drop the oldest
            self._takers[account_id] = None
            self._save_takers()

    def remove_taker(self, account_id: str) -> None:
        with self._lock:
            if self._takers.pop(account_id, 0) is None:
                self._save_takers()

    def takers(self) -> list[str]:
        with self._lock:
            return list(self._takers)

    def _save_takers(self) -> None:
        if self._takers_path:
            tmp = self._takers_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(list(self._takers)))
            tmp.replace(self._takers_path)
