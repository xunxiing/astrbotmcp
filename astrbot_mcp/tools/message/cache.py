from __future__ import annotations

import asyncio
from typing import Dict, Tuple

from ...astrbot_client import AstrBotClient

_SESSION_CACHE_LOCK = asyncio.Lock()
_SESSION_CACHE: Dict[Tuple[str, str, str], str] = {}

_LAST_SAVED_MESSAGE_ID_LOCK = asyncio.Lock()
_LAST_SAVED_MESSAGE_ID_BY_SESSION: Dict[Tuple[str, str, str], str] = {}

_LAST_USER_MESSAGE_ID_LOCK = asyncio.Lock()
_LAST_USER_MESSAGE_ID_BY_SESSION: Dict[Tuple[str, str, str], str] = {}


def _session_cache_key(client: AstrBotClient, platform_id: str) -> Tuple[str, str, str]:
    return (client.base_url, client.settings.username or "", platform_id)


def _last_saved_key(client: AstrBotClient, session_id: str) -> Tuple[str, str, str]:
    return (client.base_url, client.settings.username or "", session_id)