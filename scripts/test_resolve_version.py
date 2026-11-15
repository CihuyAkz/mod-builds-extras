import unittest

from resolve_version import resolve_version


FALLBACK = "125f2a61cc744361ab0a6c8da1fcecc9c75cd5c1"
EXACT = "ac874422ed8f892505ff73d67ae486ecfee7a516"


class ResolveVersionTests(unittest.TestCase):
    def test_pattern_matches_incrementing_development_build_numbers(self):
        versions = {"0.8.0-dev.*": FALLBACK}
        for version in ("0.8.0-dev.89", "0.8.0-dev.90", "0.8.0-dev.1000"):
            with self.subTest(version=version):
                self.assertEqual(resolve_version(version, versions), FALLBACK)

    def test_exact_version_wins_over_matching_pattern(self):
        self.assertEqual(
            resolve_version(
                "0.8.0-dev.89",
                {"0.8.0-dev.*": FALLBACK, "0.8.0-dev.89": EXACT},
            ),
            EXACT,
        )

    def test_more_specific_pattern_wins(self):
        self.assertEqual(
            resolve_version(
                "0.8.0-dev.89",
                {"0.8.*": FALLBACK, "0.8.0-dev.*": EXACT},
            ),
            EXACT,
        )

    def test_other_version_family_is_not_silently_mapped(self):
        with self.assertRaises(ValueError):
            resolve_version("0.9.0-dev.1", {"0.8.0-dev.*": FALLBACK})

    def test_invalid_exact_commit_is_not_hidden_by_pattern(self):
        with self.assertRaises(ValueError):
            resolve_version(
                "0.8.0-dev.89",
                {"0.8.0-dev.89": "invalid", "0.8.0-dev.*": FALLBACK},
            )

    def test_invalid_pattern_commit_is_rejected(self):
        with self.assertRaises(ValueError):
            resolve_version("0.8.0-dev.89", {"0.8.0-dev.*": "invalid"})

    def test_non_table_is_rejected(self):
        with self.assertRaises(ValueError):
            resolve_version("0.8.0-dev.89", [])


if __name__ == "__main__":
    unittest.main()
