import os
import signal
import subprocess
import sys
from ipaddress import ip_address
from pathlib import Path

from .config import log, non_prefixed_settings, settings

if source_ref := os.getenv("IMMICH_SOURCE_REF"):
    log.info(f"Initializing Immich ML [{source_ref}]")
else:
    log.info("Initializing Immich ML")

module_dir = Path(__file__).parent

# on i915, Intel's runtime submits every allocation in the process with each run it gives OpenVINO's GPU plugin
drm = Path("/sys/class/drm")
if drm.exists() and any(driver.resolve().name == "i915" for driver in drm.glob("renderD*/device/driver")):
    os.environ.setdefault("NEOReadDebugKeys", "1")
    os.environ.setdefault("EnableDirectSubmission", "0")


def is_ipv6(host: str) -> bool:
    try:
        return ip_address(host).version == 6
    except ValueError:
        return False


bind_host = non_prefixed_settings.immich_host
if is_ipv6(bind_host):
    bind_host = f"[{bind_host}]"
bind_address = f"{bind_host}:{non_prefixed_settings.immich_port}"

# gunicorn drives a POSIX process model (fork, signals, control socket), so native Windows installs run the same
# ASGI app under uvicorn instead. Both serve immich_ml.main:app with the settings from config.py.
uvicorn_args = [
    sys.executable,
    "-m",
    "uvicorn",
    "immich_ml.main:app",
    "--host",
    bind_host.strip("[]"),
    "--port",
    str(non_prefixed_settings.immich_port),
    "--workers",
    str(settings.workers),
    "--timeout-worker-healthcheck",
    str(settings.worker_timeout),
    "--timeout-keep-alive",
    str(settings.http_keepalive_timeout_s),
    "--timeout-graceful-shutdown",
    "10",
    "--no-access-log",
]

gunicorn_args = [
    "python",
    "-m",
    "gunicorn",
    "immich_ml.main:app",
    "-k",
    "immich_ml.config.CustomUvicornWorker",
    "-c",
    module_dir / "gunicorn_conf.py",
    "-b",
    bind_address,
    "-w",
    str(settings.workers),
    "-t",
    str(settings.worker_timeout),
    "--keep-alive",
    str(settings.http_keepalive_timeout_s),
    "--graceful-timeout",
    "10",
    "--no-control-socket",
]

args = uvicorn_args if os.name == "nt" else gunicorn_args

try:
    with subprocess.Popen(args) as cmd:
        cmd.wait()
except KeyboardInterrupt:
    cmd.send_signal(signal.SIGINT)
exit(cmd.returncode)
