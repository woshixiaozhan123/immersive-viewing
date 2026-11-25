"""Entry point for starting the local video cache server."""

from __future__ import annotations

import uvicorn

import config
import server as server_mod


def main() -> None:
    uv_config = uvicorn.Config(
        server_mod.app,
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )
    uv_server = uvicorn.Server(uv_config)
    server_mod.set_uvicorn_server(uv_server)
    uv_server.run()


if __name__ == "__main__":
    main()
