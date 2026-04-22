import importlib
import sys
import types
import unittest


sys.modules.setdefault("asyncpg", types.ModuleType("asyncpg"))
normalize_outbox_payload = importlib.import_module("telegram_notifier").normalize_outbox_payload


class NormalizeOutboxPayloadTests(unittest.TestCase):
    def test_keeps_dict_payloads(self) -> None:
        payload = {"status": "offline", "event_type": "disconnect"}

        self.assertEqual(normalize_outbox_payload(payload), payload)

    def test_decodes_json_object_strings(self) -> None:
        payload = '{"status":"offline","event_type":"disconnect"}'

        self.assertEqual(
            normalize_outbox_payload(payload),
            {"status": "offline", "event_type": "disconnect"},
        )

    def test_wraps_non_object_json_values(self) -> None:
        self.assertEqual(normalize_outbox_payload('["a", "b"]'), {"value": ["a", "b"]})

    def test_wraps_invalid_json_strings(self) -> None:
        self.assertEqual(normalize_outbox_payload("not-json"), {"value": "not-json"})


if __name__ == "__main__":
    unittest.main()
