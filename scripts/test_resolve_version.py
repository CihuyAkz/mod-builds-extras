import unittest

from resolve_version import resolve_version


FALLBACK = "125f2a61cc744361ab0a6c8da1fcecc9c75cd5c1"
EXACT = "ac874422ed8f892505ff73d67ae486ecfee7a516"


class ResolveVersionTests(unittest.TestCase):
    def test_exact_version_wins_over_universal_fallback(self):
        self.assertEqual(
            resolve_version("0.8.0", {"0.8.0": EXACT, "*": FALLBACK}),
            EXACT,
        )

    def test_universal_fallback_resolves_development_version(self):
        self.assertEqual(
            resolve_version("0.8.0-dev.81", {"*": FALLBACK}),
            FALLBACK,
        )

    def test_universal_fallback_resolves_other_versions(self):
        self.assertEqual(
            resolve_version("9.9.9", {"*": FALLBACK}),
            FALLBACK,
        )

    def test_missing_exact_and_fallback_is_rejected(self):
        with self.assertRaises(ValueError):
            resolve_version("0.8.0-dev.81", {"0.8.0": EXACT})

    def test_invalid_exact_commit_is_not_hidden_by_fallback(self):
        with self.assertRaises(ValueError):
            resolve_version("0.8.0", {"0.8.0": "invalid", "*": FALLBACK})

    def test_invalid_fallback_commit_is_rejected(self):
        with self.assertRaises(ValueError):
            resolve_version("0.8.0-dev.81", {"*": "invalid"})

    def test_non_table_is_rejected(self):
        with self.assertRaises(ValueError):
            resolve_version("0.8.0-dev.81", [])


if __name__ == "__main__":
    unittest.main()
