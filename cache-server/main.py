"""Entry point for starting the local video cache server."""

from __future__ import annotations

import uvicorn
import config


def main() -> None:
    uvicorn.run(
        "server:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
