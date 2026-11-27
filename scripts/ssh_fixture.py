#!/usr/bin/env python3
"""Run commands against an isolated loopback OpenSSH fixture, then clean up.

No existing SSH keys, authorized_keys, system services or host trust are modified.
Usage: python3 scripts/ssh_fixture.py cargo test -p shell-ex-core -- --ignored
"""
import getpass
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time


def main():
    command = sys.argv[1:] or ["cargo", "test", "-p", "shell-ex-core", "--", "--ignored", "--test-threads=1"]
    sshd = shutil.which("sshd") or "/usr/sbin/sshd"
    if not Path(sshd).exists():
        raise SystemExit("OpenSSH server is required for the loopback integration fixture")
    with tempfile.TemporaryDirectory(prefix="shell-ex-integration-") as temporary:
        root = Path(temporary)
        for name in ("host", "identity"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / name)], check=True)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        user = getpass.getuser()
        env = os.environ.copy()
        elevated_sshd = env.get("SHELL_EX_TEST_SSHD_SUDO") == "1"
        # GitHub's Linux runner has a locked password. OpenSSH rejects such an
        # account before public-key authentication when UsePAM is disabled.
        # PAM account/session handling permits the generated test key without
        # unlocking the account or enabling password/interactive authentication.
        use_pam = sys.platform.startswith("linux") and (os.geteuid() == 0 or elevated_sshd)
        config = root / "sshd_config"
        config.write_text(
            f"ListenAddress 127.0.0.1\nPort {port}\nHostKey {root}/host\n"
            f"PidFile {root}/sshd.pid\nAuthorizedKeysFile {root}/identity.pub\n"
            f"StrictModes no\nUsePAM {'yes' if use_pam else 'no'}\n"
            "AuthenticationMethods publickey\nPubkeyAuthentication yes\n"
            "PasswordAuthentication no\nKbdInteractiveAuthentication no\n"
            "PermitRootLogin prohibit-password\nAllowTcpForwarding yes\nGatewayPorts no\nSubsystem sftp internal-sftp\n"
        )
        env.update(SHELL_EX_TEST_HOST="127.0.0.1", SHELL_EX_TEST_PORT=str(port), SHELL_EX_TEST_USER=user,
                   SHELL_EX_TEST_KEY=str(root / "identity"), SHELL_EX_TEST_ROOT=str(root))
        if os.geteuid() == 0 or elevated_sshd:
            env["SHELL_EX_TEST_PTY"] = "1"
        else:
            env.pop("SHELL_EX_TEST_PTY", None)
            print("Unprivileged sshd fixture: remote PTY requires root login-record privileges; testing service transports", flush=True)
        # A private test agent supplies only the generated fixture identity.
        agent = None
        ssh_agent = shutil.which("ssh-agent")
        if ssh_agent:
            env["SSH_AUTH_SOCK"] = str(root / "agent.sock")
            agent = subprocess.Popen([ssh_agent, "-D", "-a", env["SSH_AUTH_SOCK"]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                if Path(env["SSH_AUTH_SOCK"]).exists():
                    break
                if agent.poll() is not None:
                    break
                time.sleep(0.02)
            if agent.poll() is None:
                subprocess.run(["ssh-add", str(root / "identity")], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                env["SHELL_EX_TEST_AGENT"] = "1"
            else:
                print("Fixture SSH Agent unavailable (the environment may block Unix sockets); agent check excluded", flush=True)
                env.pop("SSH_AUTH_SOCK", None)
                agent = None
        with (root / "sshd.log").open("w+") as log:
            server_command = (["sudo", "-n"] if elevated_sshd else []) + [sshd, "-D", "-e", "-f", str(config)]
            server = subprocess.Popen(server_command, stdout=log, stderr=log)
            protected = None
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError("Test sshd failed: " + log.read())
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.02)
                else:
                    raise RuntimeError("Test sshd never became ready")
                print(f"Loopback OpenSSH fixture ready on 127.0.0.1:{port}", flush=True)
                # This is a fixture-owned directory only. Never alter sudoers,
                # the SSH user, or any production path. CI's runner already
                # has passwordless sudo, and remains a non-root SSH login.
                if elevated_sshd and os.geteuid() != 0:
                    protected = root / "root-only-fixture"
                    subprocess.run(
                        ["sudo", "-n", "install", "-d", "-m", "0700", "-o", "root", "-g", "root", str(protected)],
                        check=True,
                    )
                    env["SHELL_EX_TEST_SUDO_ROOT"] = str(protected)
                result = subprocess.run(command, env=env)
                if result.returncode:
                    log.seek(0)
                    print("OpenSSH fixture diagnostic log:\n" + log.read()[-12000:], file=sys.stderr)
                return result.returncode
            finally:
                if protected is not None:
                    subprocess.run(["sudo", "-n", "rm", "-rf", "--", str(protected)], check=True)
                if elevated_sshd and (root / "sshd.pid").exists():
                    # Only stop the PID written by this isolated fixture; do
                    # not touch the runner's system sshd service.
                    test_pid = (root / "sshd.pid").read_text().strip()
                    if not test_pid.isdigit():
                        raise RuntimeError("Unexpected fixture sshd PID file")
                    subprocess.run(["sudo", "-n", "kill", "-TERM", test_pid], check=False)
                else:
                    server.terminate()
                try:
                    server.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
                if agent:
                    agent.terminate()
                    agent.wait(timeout=3)


if __name__ == "__main__":
    raise SystemExit(main())
