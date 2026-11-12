"""Capabilities explicitly granted to an individual agent run."""
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class AgentCapabilities:
    remember: Callable[[str], Any] | None = None
    schedule: Callable[[str, str, int | None], Any] | None = None
    operate: Callable[[str, str], Any] | None = None
    on_usage: Callable[[int, int], Any] | None = None
    max_turns: int = 6
    read_only: bool = False
    web_search: bool = False
    on_evidence: Callable[[list[str]], Any] | None = None
