"""Manual one-shot extraction, bypassing Dagster — for verification and debugging.

Run inside the analytics container (env is already wired there):

    docker compose exec dagster-daemon python -m offermind_analytics.run_pipeline

Shares pipeline names (and therefore incremental-cursor state) with the
scheduled Dagster assets.
"""

from __future__ import annotations

from offermind_analytics.assets_dlt import app_pipeline, auth_pipeline
from offermind_analytics.dlt_sources import offermind_app_source, offermind_auth_source


def main() -> None:
    """Run both extraction pipelines once and print their load summaries."""
    app_info = app_pipeline().run(offermind_app_source())
    print(app_info)  # noqa: T201
    auth_info = auth_pipeline().run(offermind_auth_source())
    print(auth_info)  # noqa: T201


if __name__ == "__main__":
    main()
