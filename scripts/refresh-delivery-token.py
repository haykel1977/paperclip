#!/usr/bin/env python3
"""Publish a repository-scoped installation token without restarting Paperclip.

Requires Python 3 and OpenSSL. Credentials never appear in argv or log output.
The output directory must already exist; see doc/DELIVERY-TOKEN-ROTATION.md.
"""

import argparse
import base64
from datetime import datetime, timezone
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time


class RefreshError(Exception):
    """A diagnostic that contains no credentials or response body."""


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_jwt(app_id, pem_file):
    now = int(time.time())
    header = b64url(b'{"alg":"RS256","typ":"JWT"}')
    payload = b64url(json.dumps({"iat": now - 60, "exp": now + 540, "iss": app_id}, separators=(",", ":")).encode())
    message = f"{header}.{payload}".encode("ascii")
    # Only a file path is in argv; the JWT payload goes through stdin.
    signature = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(pem_file)],
        input=message, capture_output=True, timeout=15, check=False,
    )
    if signature.returncode:
        raise RefreshError("app_jwt_signing_failed")
    return f"{header}.{payload}.{b64url(signature.stdout)}"


def github_json(method, api_path, jwt, body=None):
    # Fixed HTTPS host and no redirects: never forward Authorization elsewhere.
    connection = http.client.HTTPSConnection("api.github.com", timeout=20)
    try:
        connection.request(method, api_path, body=json.dumps(body) if body is not None else None, headers={
            "Authorization": f"Bearer {jwt}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "paperclip-token-refresh",
            "Content-Type": "application/json",
        })
        response = connection.getresponse()
        if response.status not in (200, 201):
            raise RefreshError(f"github_http_{response.status}")
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise RefreshError("github_response_too_large")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise RefreshError("github_response_invalid") from None
        if not isinstance(result, dict):
            raise RefreshError("github_response_invalid")
        return result
    finally:
        connection.close()


def mint_token(app_id, pem_file, repository):
    jwt = make_jwt(app_id, pem_file)
    installation = github_json("GET", f"/repos/{repository}/installation", jwt)
    installation_id = installation.get("id")
    if type(installation_id) is not int or installation_id <= 0:
        raise RefreshError("github_installation_invalid")
    result = github_json("POST", f"/app/installations/{installation_id}/access_tokens", jwt,
                         {"repositories": [repository.split("/", 1)[1]]})
    token, expires_at = result.get("token"), result.get("expires_at")
    # Support both legacy opaque tokens and GitHub's longer ghs_APPID_JWT format.
    if not isinstance(token, str) or not re.fullmatch(r"ghs_[A-Za-z0-9_.-]+", token):
        raise RefreshError("github_token_invalid")
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expiry.tzinfo is None or (expiry - datetime.now(timezone.utc)).total_seconds() <= 300:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise RefreshError("github_token_expiry_invalid") from None
    record = {"token": token, "expires_at": expiry.isoformat().replace("+00:00", "Z"),
              "repository": repository, "installation_id": installation_id}
    if len(json.dumps(record).encode()) > 16 * 1024:
        raise RefreshError("github_token_record_too_large")
    return record


def check_destination(destination):
    if not destination.is_absolute():
        raise RefreshError("output_absolute_path_required")
    parent = destination.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_mode & 0o002:
        raise RefreshError("output_directory_unsafe")
    try:
        current = destination.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(current.st_mode):
        raise RefreshError("output_must_be_regular_file")


def stage_file(destination, data, reader_gid):
    check_destination(destination)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fchown(stream.fileno(), os.geteuid(), reader_gid)
            os.fchmod(stream.fileno(), 0o640)
            os.fsync(stream.fileno())
        return Path(temporary)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def publish(record, output, reader_gid, git_credentials=None):
    outputs = [(output, (json.dumps(record, separators=(",", ":")) + "\n").encode())]
    if git_credentials is not None:
        if git_credentials == output:
            raise RefreshError("outputs_must_differ")
        # Compatibility for an existing installation-only Git store. Its helper
        # and repository routing must be checked before opting into replacement.
        outputs.insert(0, (git_credentials, f"https://x-access-token:{record['token']}@github.com\n".encode()))
    staged = []
    try:
        # Prepare every file before replacing either published version. A failed
        # renewal/preparation leaves existing credentials untouched.
        for destination, data in outputs:
            staged.append((stage_file(destination, data, reader_gid), destination))
        for temporary, destination in staged:
            os.replace(temporary, destination)
            directory_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)


def refresh(args):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        raise RefreshError("repository_invalid")
    if not re.fullmatch(r"[0-9]+", args.app_id) or args.reader_gid < 0:
        raise RefreshError("app_id_or_reader_gid_invalid")
    check_destination(args.output)
    parent = args.output.parent.stat()
    if parent.st_uid != os.geteuid() or parent.st_gid != args.reader_gid or parent.st_mode & 0o027:
        raise RefreshError("token_directory_requires_writer_owner_reader_group_and_0750")
    if not parent.st_mode & 0o010:
        raise RefreshError("token_directory_not_traversable_by_reader")
    if args.git_credentials is not None:
        check_destination(args.git_credentials)
    lock_path = args.output.with_name(f".{args.output.name}.lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "wb") as lock:
        # Avoid simultaneous manual/timer refreshes publishing out of order.
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        record = mint_token(args.app_id, args.pem_file, args.repository)
        publish(record, args.output, args.reader_gid, args.git_credentials)
    print(f"delivery_token_refreshed repository={args.repository} expires_at={record['expires_at']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-id", required=True)
    parser.add_argument("--pem-file", required=True, type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reader-gid", required=True, type=int)
    parser.add_argument("--git-credentials", type=Path, help="Replace an existing installation-only Git store too")
    args = parser.parse_args()
    try:
        refresh(args)
    except RefreshError as error:
        print(f"delivery_token_refresh_failed reason={error}", file=sys.stderr)
        return 1
    except Exception:
        # Exceptions from HTTP, filesystem and subprocess libraries may contain
        # sensitive request/response data. Emit a fixed diagnostic, no traceback.
        print("delivery_token_refresh_failed reason=io_or_lock_failure", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
