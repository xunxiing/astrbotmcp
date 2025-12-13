from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class AstrBotSettings:
    """Configuration for connecting to an AstrBot instance."""

    base_url: str
    timeout: float = 30.0
    username: str | None = None
    password: str | None = None
    default_provider: str | None = None
    default_model: str | None = None
    file_root: str | None = None
    direct_media_mode: str | None = None


def _get_env(name: str) -> str | None:
    value = os.getenv(name)
    if value:
        value = value.strip()
    return value or None


def get_settings() -> AstrBotSettings:
    """
    Load AstrBot connection settings from environment variables.

    Required:
      - ASTRBOT_BASE_URL: Base URL of the AstrBot HTTP API,
        for example: http://127.0.0.1:8000

    Optional:
      - ASTRBOT_TIMEOUT: Request timeout in seconds (default: 30).
      - ASTRBOT_USERNAME: Dashboard username.
      - ASTRBOT_PASSWORD: Dashboard password.
      - ASTRBOT_DEFAULT_PROVIDER: Default provider id to use for /api/chat/send.
      - ASTRBOT_DEFAULT_MODEL: Default model id to use for /api/chat/send.
      - ASTRBOTMCP_FILE_ROOT: Base directory for resolving relative local file_path.
      - ASTRBOTMCP_DIRECT_MEDIA_MODE: How send_platform_message_direct handles local media:
        - auto (default): try local path first, then fallback to upload+URL.
        - local: always send local absolute paths to AstrBot platform adapters.
        - upload: upload to AstrBot first and send an http(s) URL.
    """
    base_url = _get_env("ASTRBOT_BASE_URL")
    if not base_url:
        raise RuntimeError(
            "ASTRBOT_BASE_URL is not set. Please set it to the base URL "
            "of your AstrBot HTTP API, e.g. http://127.0.0.1:8000"
        )

    timeout_str = _get_env("ASTRBOT_TIMEOUT")
    timeout: float = 30.0
    if timeout_str:
        try:
            timeout = float(timeout_str)
        except ValueError:
            raise RuntimeError("ASTRBOT_TIMEOUT must be a number (seconds).")

    # Normalize trailing slash
    base_url = base_url.rstrip("/")

    username = _get_env("ASTRBOT_USERNAME")
    password = _get_env("ASTRBOT_PASSWORD")
    default_provider = _get_env("ASTRBOT_DEFAULT_PROVIDER")
    default_model = _get_env("ASTRBOT_DEFAULT_MODEL")
    file_root = _get_env("ASTRBOTMCP_FILE_ROOT") or _get_env("ASTRBOT_MCP_FILE_ROOT")
    direct_media_mode = _get_env("ASTRBOTMCP_DIRECT_MEDIA_MODE") or _get_env(
        "ASTRBOT_MCP_DIRECT_MEDIA_MODE"
    )

    return AstrBotSettings(
        base_url=base_url,
        timeout=timeout,
        username=username,
        password=password,
        default_provider=default_provider,
        default_model=default_model,
        file_root=file_root,
        direct_media_mode=direct_media_mode,
    )
