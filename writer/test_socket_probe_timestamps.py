import unittest
import sys
import types
from datetime import timezone

sys.modules.setdefault("asyncpg", types.SimpleNamespace())
websockets_module = types.ModuleType("websockets")
websockets_exceptions_module = types.ModuleType("websockets.exceptions")
websockets_exceptions_module.ConnectionClosed = RuntimeError
sys.modules.setdefault("websockets", websockets_module)
sys.modules.setdefault("websockets.exceptions", websockets_exceptions_module)

from socket_probe_v2 import parse_source_added_at


class SourceAddedAtTests(unittest.TestCase):
    def test_parses_iso_source_added_at(self) -> None:
        parsed = parse_source_added_at({"date_added": "2026-03-25T00:02:31Z"})

        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.tzinfo, timezone.utc)
        self.assertEqual(parsed.isoformat(), "2026-03-25T00:02:31+00:00")

    def test_parses_epoch_milliseconds(self) -> None:
        parsed = parse_source_added_at({"created_at": 1774393351000})

        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.tzinfo, timezone.utc)

    def test_returns_none_when_source_timestamp_is_missing_or_invalid(self) -> None:
        self.assertIsNone(parse_source_added_at({}))
        self.assertIsNone(parse_source_added_at({"date_added": "not-a-date"}))


if __name__ == "__main__":
    unittest.main()
