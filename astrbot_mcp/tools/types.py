from __future__ import annotations

import sys
from typing import Literal

if sys.version_info < (3, 12):
    from typing_extensions import TypedDict
else:
    from typing import TypedDict


class MessagePart(TypedDict, total=False):
    """
    A single message part for send_platform_message.

    Types:
      - plain:  {"type": "plain", "text": "..."}
      - reply:  {"type": "reply", "message_id": "..."}
      - quote:  {"type": "quote", "message_id": "..."}  (alias of reply)
      - reference: {"type": "reference", "message_id": "..."}  (alias of reply)
      - image:  {"type": "image", "file_path": "..."} or {"type": "image", "url": "https://..."}
      - file:   {"type": "file", "file_path": "..."}  or {"type": "file", "url": "https://..."}
      - record: {"type": "record", "file_path": "..."} or {"type": "record", "url": "https://..."}
      - video:  {"type": "video", "file_path": "..."} or {"type": "video", "url": "https://..."}
    """

    type: Literal[
        "plain",
        "reply",
        "quote",
        "reference",
        "image",
        "file",
        "record",
        "video",
    ]
    text: str
    message_id: str
    id: str
    file_path: str
    url: str
    file_name: str
    mime_type: str
