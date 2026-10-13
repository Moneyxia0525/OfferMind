"""Read-only ClickHouse access for the analytics agent.

The real boundary is the server: the `analytics_agent` ClickHouse user holds
SELECT on the marts and staging databases only, runs under a `readonly=2`
profile, and its limits carry `<constraints><max>` so a model-authored
`SETTINGS` clause cannot raise them (see
`analytics/clickhouse/users.d/analytics-agent.xml`). Everything here is the
second layer: it keeps obvious mistakes from becoming ClickHouse errors, and
turns the errors that do happen into text the model can act on.

Nothing in this module raises. Every failure comes back as an `Error: ...`
string so the model can read it, adjust, and retry — the same contract the
career agent's tools follow.
"""

from __future__ import annotations

import functools
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

import clickhouse_connect
from backend.agents.analytics_agent.settings import WarehouseSettings

if TYPE_CHECKING:
    from clickhouse_connect.driver.client import Client


class QueryResult(Protocol):
    """The slice of a clickhouse-connect result this module reads."""

    column_names: Any
    result_rows: Any


class QueryClient(Protocol):
    """Anything that can run a query (structural, so fakes qualify).

    Declaring the minimal surface rather than the concrete driver client keeps
    this module a leaf and lets tests drive it with a plain stub — the same
    reason `career_agent/render_scratch.py` declares `ScratchBackend`.
    """

    def query(self, query: str) -> QueryResult:
        """Run a read query and return its result."""
        ...


#: Statements the agent may run. Read-only by intent; the grants enforce it.
_ALLOWED_LEADS = frozenset(
    {"SELECT", "WITH", "DESCRIBE", "DESC", "SHOW", "EXPLAIN", "EXISTS"},
)

#: Leading keywords worth naming in the error, so the model learns the rule
#: instead of guessing. Anything else falls through to a generic message.
_WRITE_LEADS = frozenset(
    {
        "INSERT",
        "ALTER",
        "CREATE",
        "DROP",
        "TRUNCATE",
        "RENAME",
        "ATTACH",
        "DETACH",
        "OPTIMIZE",
        "SYSTEM",
        "KILL",
        "GRANT",
        "REVOKE",
        "SET",
        "USE",
    },
)

#: Statements where a row limit is meaningless (they return metadata).
_NO_LIMIT_LEADS = frozenset({"DESCRIBE", "DESC", "SHOW", "EXPLAIN", "EXISTS"})

_LINE_COMMENT = re.compile(r"--[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_STRING_LITERAL = re.compile(r"'(?:[^'\\]|\\.|'')*'")
_LIMIT_CLAUSE = re.compile(r"\bLIMIT\b", re.IGNORECASE)

#: ClickHouse names the offending aggregate in code 184, e.g.
#: `Aggregate function min(first_seen_date) AS first_seen_date is found in WHERE`.
_OFFENDING_AGGREGATE = re.compile(r"Aggregate function (.+?)(?: AS (\w+))? is found", re.DOTALL)

_SHADOWING_FIX = (
    "别名复用了列名，因此对该名称的其他引用（包括 WHERE 中的引用）都会解析为别名，"
    "而不是原列。请重命名别名（例如 `sum(x) AS total_x`），并修复 SELECT 列表中的"
    "所有聚合别名，不只是上面指出的那一个。不要把条件移到 HAVING：那会按聚合结果"
    "筛选，而不是按每一行筛选，最终回答的是另一个问题。"
)

_HAVING_FIX = (
    "WHERE 中使用了聚合别名，而 WHERE 会在聚合前筛选行。请将该条件移到 HAVING；"
    "如果你的目的是筛选行，则在 WHERE 中重复底层表达式。"
)


def _illegal_aggregation_hint(message: str) -> str:
    """Tell the two causes of code 184 apart.

    Both print the same shape, and they need opposite fixes: a shadowed column
    must be renamed, while a genuine aggregate-in-WHERE must move to HAVING.
    The difference is whether the alias also appears inside the aggregate it
    names — `min(first_seen_date) AS first_seen_date` shadows, `count() AS n`
    does not.
    """
    match = _OFFENDING_AGGREGATE.search(message)
    if match is not None:
        expression, alias = match.group(1), match.group(2)
        if alias and re.search(rf"\b{re.escape(alias)}\b", expression):
            return _SHADOWING_FIX
    if "in WHERE" in message:
        return _HAVING_FIX
    # "found inside another aggregate" with no alias named: still shadowing —
    # a genuinely nested aggregate is rare next to how often an alias collides.
    return _SHADOWING_FIX


#: ClickHouse error codes worth a tailored recovery hint. Anything else keeps
#: the server's own message, which is usually specific enough.
_ERROR_HINTS = {
    46: (
        "此处不存在该函数。大多数标准 SQL 函数都可用（DATE_TRUNC、EXTRACT、DATEDIFF、"
        "COALESCE、IFNULL、NOW），不要因此避开它们；问题通常是误造了 ClickHouse "
        "`toXxx` 系列中的函数名。星期和月份名称应使用 `dateName('weekday', d)` / "
        "`dateName('month', d)`，而不是 `toDayName`；字符串聚合应使用 "
        "`arrayStringConcat(groupArray(x), ',')`，而不是 `STRING_AGG`。请先查看 "
        "`warehouse-analysis` skill 中的方言参考。"
    ),
    47: "列不存在。请运行 describe_data('<table>') 查看准确的列名。",
    60: "表不存在。请运行 describe_data() 查看可用表。",
    81: "数据库不存在。这里只能读取数据集市和暂存层数据库。",
    159: (
        "查询超过了 30 秒限制。请缩小日期范围、按表的排序键筛选，或进行聚合而不是扫描明细行。"
    ),
    241: (
        "查询内存不足。请减少 GROUP BY 的基数、增加日期筛选，或分阶段聚合。"
    ),
    386: (
        "JOIN 或 UNION 比较了两种不同的整数类型，常见情况是 `numbers()`（UInt64）"
        "与算术表达式（Int16）比较。ClickHouse 不会自动扩展类型，请将两侧转换为相同"
        "类型，例如 `toUInt64(toDayOfWeek(d) - 1)`。"
    ),
    403: (
        "`JOIN ... ON` 至少需要两侧之间存在一个普通等式（`a.key = b.key`；两侧可以包含"
        "计算表达式）。函数谓词或不等式无法为 ClickHouse 提供连接键；请将它们放到 "
        "`WHERE`，或作为真实等式旁边的额外 `AND` 条件。还应确认是否真的需要 JOIN："
        "通常直接对真实数据分组，比连接到生成的辅助表更简单。"
    ),
    452: ("该 SETTINGS 值超过了当前用户的上限。限制可以降低，不能提高。"),
    497: (
        "访问被拒绝。此连接只能读取数据集市和暂存层数据库。如果你要查看结构，请使用 "
        "describe_data('<table>')；它包含 information_schema 不提供的列含义和注意事项，"
        "也可以使用 `DESCRIBE <table>` 作为基础备选方案。如果你正在访问 bronze 层或尝试"
        "写入数据，则超出了范围；请直接说明，而不要寻找其他路径。"
    ),
}


def strip_noise(sql: str) -> str:
    """Return `sql` with comments and string literals blanked out.

    Used for classification only, so a `;` or a keyword inside a literal or a
    comment cannot be mistaken for statement structure. Literals collapse to
    `''` rather than vanishing, keeping token boundaries intact.
    """
    without_comments = _BLOCK_COMMENT.sub(" ", _LINE_COMMENT.sub(" ", sql))
    return _STRING_LITERAL.sub("''", without_comments)


def leading_keyword(sql: str) -> str:
    """Return the statement's first bare keyword, upper-cased (`""` if none)."""
    match = re.search(r"[A-Za-z]+", strip_noise(sql).lstrip().lstrip("("))
    return match.group(0).upper() if match else ""


def classify_statement(sql: str) -> str | None:
    """Return `None` when `sql` is a single readable statement, else an error.

    Rejects empty input, multiple statements, and anything that is not a read.
    The message names the rule so the model can correct itself in one turn.
    """
    stripped = sql.strip()
    if not stripped:
        return "错误：查询为空。请传入一条 SELECT 语句。"

    cleaned = strip_noise(stripped).strip().rstrip(";").strip()
    if ";" in cleaned:
        return (
            "错误：每次调用只能执行一条语句。请拆分查询，并为每条语句单独调用 run_sql。"
        )

    lead = leading_keyword(cleaned)
    if lead in _WRITE_LEADS:
        return (
            f"错误：不允许执行 {lead}。此助手只有数据仓库的只读权限；请使用 SELECT "
            f"（或 DESCRIBE / SHOW / EXPLAIN）。"
        )
    if lead not in _ALLOWED_LEADS:
        allowed = "、".join(sorted(_ALLOWED_LEADS))
        return f"错误：不支持的语句 '{lead or sql[:20]}'。可用语句：{allowed}。"
    return None


def ensure_limit(sql: str, limit: int) -> tuple[str, bool]:
    """Append `LIMIT limit` when the statement has none.

    Returns the SQL to run and whether a limit was added, so the caller can say
    so rather than letting the model believe it saw the whole result. Metadata
    statements (`DESCRIBE`, `SHOW`, ...) are returned untouched.
    """
    body = sql.strip().rstrip(";").rstrip()
    if leading_keyword(body) in _NO_LIMIT_LEADS:
        return body, False
    if _LIMIT_CLAUSE.search(strip_noise(body)):
        return body, False
    return f"{body}\nLIMIT {limit}", True


@dataclass
class QueryOutcome:
    """A successful read, plus what the caller must disclose about it."""

    columns: list[str]
    rows: list[tuple[Any, ...]]
    elapsed_s: float
    read_rows: int | None = None
    limit_injected: bool = False
    #: The row limit appended to the query, when one was.
    injected_limit: int | None = None
    #: True when the server's `max_result_rows` cap truncated the result.
    #: `result_overflow_mode=break` truncates without raising, so an
    #: undisclosed partial result would read as a complete answer.
    server_capped: bool = False
    types: list[str] = field(default_factory=list)

    @property
    def row_count(self) -> int:
        """Number of rows returned."""
        return len(self.rows)


@functools.lru_cache(maxsize=1)
def get_client() -> Client:
    """Build (once) the read-only ClickHouse client.

    Lazy on purpose: agent modules are imported by the core-server just to
    enumerate graphs, which must not require a reachable warehouse.

    `autogenerate_session_id=False` matters: a ClickHouse session serializes
    its queries, so the client's default per-connection session id makes two
    parallel `run_sql` calls — which a model issues routinely — fail with
    "concurrent queries within the same session". The agent keeps no session
    state (no temporary tables, no SET), so the id buys nothing and costs
    concurrency.
    """
    settings = WarehouseSettings()
    return clickhouse_connect.get_client(
        host=settings.host,
        port=settings.port,
        username=settings.agent_user,
        password=settings.agent_password,
        connect_timeout=settings.connect_timeout,
        send_receive_timeout=settings.send_receive_timeout,
        autogenerate_session_id=False,
        client_name="offermind-analytics-agent",
    )


def friendly_error(exc: Exception) -> str:
    """Render a ClickHouse exception as an `Error: ...` line plus a hint."""
    message = str(exc).strip()
    code_match = re.search(r"Code:\s*(\d+)", message)
    # Keep the server's own sentence: it names the column or table at fault.
    first_line = message.split("\n")[0].strip()
    code = int(code_match.group(1)) if code_match else None
    # 184 has two opposite fixes depending on the cause, so it is derived from
    # the message rather than looked up.
    hint = _illegal_aggregation_hint(message) if code == 184 else _ERROR_HINTS.get(code)  # noqa: PLR2004
    return f"错误（ClickHouse）：{first_line}" + (f"\n提示：{hint}" if hint else "")


def run_readonly(
    sql: str,
    *,
    display_limit: int | None = None,
    client: QueryClient | None = None,
    settings: WarehouseSettings | None = None,
) -> QueryOutcome | str:
    """Run a read-only query, returning a `QueryOutcome` or an `Error: ...` string.

    `display_limit` appends a row limit when the statement has none — pass
    `None` when the full result is wanted (a chart, or a `save_as` export).
    """
    settings = settings or WarehouseSettings()
    rejection = classify_statement(sql)
    if rejection is not None:
        return rejection

    body = sql.strip().rstrip(";").rstrip()
    limit_injected = False
    if display_limit is not None:
        body, limit_injected = ensure_limit(body, display_limit)

    started = time.monotonic()
    try:
        result = (client or get_client()).query(body)
    except Exception as exc:
        return friendly_error(exc)
    elapsed = time.monotonic() - started

    rows = [tuple(row) for row in result.result_rows]
    summary = getattr(result, "summary", None) or {}
    read_rows = summary.get("read_rows")
    return QueryOutcome(
        columns=list(result.column_names),
        types=[str(t) for t in getattr(result, "column_types", [])],
        rows=rows,
        elapsed_s=elapsed,
        read_rows=int(read_rows) if read_rows is not None else None,
        limit_injected=limit_injected,
        injected_limit=display_limit if limit_injected else None,
        server_capped=len(rows) >= settings.server_max_result_rows,
    )


def _cell(value: Any, max_width: int) -> str:  # noqa: ANN401 — any column type
    """Render one value for a markdown table, escaping pipes and truncating."""
    if value is None:
        return "∅"
    text = str(value).replace("|", "\\|").replace("\n", " ")
    return text if len(text) <= max_width else f"{text[: max_width - 1]}…"


def render_table(outcome: QueryOutcome, *, max_rows: int = 200, max_width: int = 80) -> str:
    """Render a result as a markdown table with a one-line summary above it.

    The summary always states how many rows exist versus how many are shown, so
    a truncated result is never mistaken for a complete one.
    """
    shown = outcome.rows[:max_rows]
    parts = [f"{outcome.row_count} 行"]
    if len(shown) < outcome.row_count:
        parts.append(f"显示 {len(shown)} 行")
    parts.append(f"耗时 {outcome.elapsed_s:.2f} 秒")
    if outcome.read_rows is not None:
        parts.append(f"扫描 {outcome.read_rows:,} 行")
    header = " · ".join(parts)

    notices = []
    # Only worth saying when the limit actually bit. Announcing it on a complete
    # result would suggest rows are missing when none are.
    if outcome.limit_injected and outcome.row_count == outcome.injected_limit:
        notices.append(
            f"查询未设置 LIMIT，已自动添加 {outcome.injected_limit}，并已达到该上限，"
            "因此仍有更多行。请进行聚合，或自行设置 LIMIT。",
        )
    if outcome.server_capped:
        notices.append(
            "服务器的 10,000 行上限截断了结果。请进一步聚合或筛选；以上数字并不完整。",
        )

    if not outcome.columns:
        return "\n".join([header, *notices])
    if not shown:
        return "\n".join([header, "", "_没有数据行。_", *notices])

    head = "| " + " | ".join(outcome.columns) + " |"
    rule = "| " + " | ".join("---" for _ in outcome.columns) + " |"
    body = ["| " + " | ".join(_cell(value, max_width) for value in row) + " |" for row in shown]
    return "\n".join([header, "", head, rule, *body, *(["", *notices] if notices else [])])
