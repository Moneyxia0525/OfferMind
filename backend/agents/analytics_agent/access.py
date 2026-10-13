"""Who may run the analytics agent.

This agent reads every user's activity — costs, run counts, email domains, and
the display names in `dim_user` — so it is not scoped to the caller the way the
career agent's storage is. Access is therefore an explicit allowlist rather
than a role inferred from the app.

Two modes, matching the rest of the backend:

* **single-user** (no `LANGGRAPH_AUTH`): there is one operator, and they are
  already the only person who can reach the server. Allowed.
* **multi-user**: the caller's id or email must appear in
  `ANALYTICS_AGENT_ALLOWED_USERS`. An empty list denies everyone — the safe
  direction for a setting an operator may not have noticed.
"""

from __future__ import annotations

import os

from backend.agents.analytics_agent.settings import AccessSettings

#: Shown when access is refused. States the rule and how to change it, so an
#: operator reading their own transcript knows what to do next.
REFUSAL = (
    "数据分析助手仅限管理员使用，因为它会读取此部署中所有用户的活动和成本数据。\n\n"
    "如需授权，请将用户 ID 或邮箱加入 `.env` 中的 "
    "`ANALYTICS_AGENT_ALLOWED_USERS`，然后重新创建后端容器。"
    "在此之前，你仍可从助手选择器使用求职助手。"
)


def auth_enabled() -> bool:
    """Whether the server is running with custom auth (multi-user mode)."""
    return bool(os.environ.get("LANGGRAPH_AUTH"))


def is_allowed(
    identity: str | None,
    email: str | None = None,
    *,
    multi_user: bool | None = None,
    settings: AccessSettings | None = None,
) -> bool:
    """Whether this caller may run the analytics agent.

    `multi_user` defaults to whether custom auth is configured; pass it
    explicitly in tests to exercise both modes without touching the process
    environment.
    """
    if multi_user is None:
        multi_user = auth_enabled()
    if not multi_user:
        return True
    allowed = (settings or AccessSettings()).allowed()
    if not allowed:
        return False
    candidates = {value.strip().lower() for value in (identity, email) if value}
    return bool(candidates & allowed)
