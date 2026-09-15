import argparse
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("refresh_delivery_token", Path(__file__).with_name("refresh-delivery-token.py"))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)
TOKEN = "ghs_" + "unit_test_fixture" * 3
REPOSITORY = "example/quantum"


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.directory.chmod(0o750)
        self.output = self.directory / "delivery-token.json"
        self.git = self.directory / "git-credentials"
        self.record = {"token": TOKEN, "repository": REPOSITORY, "installation_id": 123,
                       "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}
        self.args = argparse.Namespace(app_id="123", pem_file=self.directory / "test.pem", repository=REPOSITORY,
                                       output=self.output, reader_gid=os.getgid(), git_credentials=self.git)

    def test_rotation_publishes_complete_files_and_keeps_old_open_readers_valid(self):
        refresh.publish(self.record, self.output, os.getgid(), self.git)
        with self.output.open() as old_reader:
            next_record = {**self.record, "token": TOKEN + "B"}
            refresh.publish(next_record, self.output, os.getgid(), self.git)
            self.assertEqual(json.load(old_reader)["token"], TOKEN)
            self.assertEqual(json.loads(self.output.read_text())["token"], TOKEN + "B")
        self.assertEqual(self.git.read_text(), f"https://x-access-token:{TOKEN}B@github.com\n")
        for output in (self.output, self.git):
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o640)
            self.assertEqual(output.stat().st_gid, os.getgid())

    def test_failed_renewal_leaves_both_files_unchanged(self):
        refresh.publish(self.record, self.output, os.getgid(), self.git)
        before = (self.output.read_bytes(), self.git.read_bytes())
        with patch.object(refresh, "mint_token", side_effect=refresh.RefreshError("github_http_503")):
            with self.assertRaisesRegex(refresh.RefreshError, "github_http_503"):
                refresh.refresh(self.args)
        self.assertEqual((self.output.read_bytes(), self.git.read_bytes()), before)

    def test_staging_failure_preserves_published_files_and_removes_temporaries(self):
        refresh.publish(self.record, self.output, os.getgid(), self.git)
        before = self.git.read_bytes()
        original_stage = refresh.stage_file
        def fail_second(destination, data, group):
            if destination == self.output:
                raise OSError("fixture write failure")
            return original_stage(destination, data, group)
        with patch.object(refresh, "stage_file", side_effect=fail_second):
            with self.assertRaises(OSError):
                refresh.publish({**self.record, "token": TOKEN + "B"}, self.output, os.getgid(), self.git)
        self.assertEqual(self.git.read_bytes(), before)
        self.assertEqual(list(self.directory.glob(".git-credentials.*")), [])

    def test_refuses_symlink_destination_and_world_writable_directory(self):
        victim = self.directory / "victim"
        victim.write_text("preserve")
        self.output.symlink_to(victim)
        with self.assertRaises(refresh.RefreshError):
            refresh.publish(self.record, self.output, os.getgid())
        self.assertEqual(victim.read_text(), "preserve")
        self.output.unlink()
        self.directory.chmod(0o777)
        with self.assertRaises(refresh.RefreshError):
            refresh.publish(self.record, self.output, os.getgid())

    def test_mint_is_restricted_to_the_requested_repository(self):
        with patch.object(refresh, "make_jwt", return_value="fixture-jwt"), patch.object(
            refresh, "github_json", side_effect=[{"id": 123}, self.record]
        ) as request:
            result = refresh.mint_token("123", "test.pem", REPOSITORY)
        self.assertEqual(result["repository"], REPOSITORY)
        self.assertEqual(request.call_args_list[0].args[1], "/repos/example/quantum/installation")
        self.assertEqual(request.call_args_list[1].args, (
            "POST", "/app/installations/123/access_tokens", "fixture-jwt", {"repositories": ["quantum"]},
        ))

    def test_mint_accepts_long_stateless_installation_tokens(self):
        stateless = "ghs_123_" + "jwt_header" * 30 + "." + "jwt-payload" * 90 + ".jwt_signature"
        with patch.object(refresh, "make_jwt", return_value="fixture-jwt"), patch.object(
            refresh, "github_json", side_effect=[{"id": 123}, {**self.record, "token": stateless}]
        ):
            self.assertEqual(refresh.mint_token("123", "test.pem", REPOSITORY)["token"], stateless)

    def test_mint_rejects_malformed_expired_and_near_expiry_credentials(self):
        invalid = [{"token": "github_pat_fixture"}, {"expires_at": "invalid"},
                   {"expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()},
                   {"expires_at": (datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat()}]
        for overrides in invalid:
            with self.subTest(overrides=overrides), patch.object(refresh, "make_jwt", return_value="fixture-jwt"), patch.object(
                refresh, "github_json", side_effect=[{"id": 123}, {**self.record, **overrides}]
            ):
                with self.assertRaises(refresh.RefreshError):
                    refresh.mint_token("123", "test.pem", REPOSITORY)

    def test_success_logs_metadata_without_any_token_prefix_or_value(self):
        log = io.StringIO()
        with patch.object(refresh, "mint_token", return_value=self.record), redirect_stdout(log):
            refresh.refresh(self.args)
        self.assertIn("delivery_token_refreshed repository=example/quantum expires_at=", log.getvalue())
        self.assertNotIn("ghs_", log.getvalue())

    def test_http_errors_never_read_or_disclose_response_body(self):
        with patch.object(refresh.http.client, "HTTPSConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 401
            response.read.return_value = TOKEN.encode()
            with self.assertRaisesRegex(refresh.RefreshError, "^github_http_401$"):
                refresh.github_json("GET", "/repos/example/quantum/installation", "fixture-jwt")
            response.read.assert_not_called()
            connection.return_value.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
