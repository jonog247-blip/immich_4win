# Third-party notices

Immich4Win distributes Immich together with the programs it needs to run on Windows. Each keeps its
own licence. This file lists them, the version bundled, and where the corresponding source can be
obtained.

Regenerate the version numbers from `windows/toolchain.json`, which is the single source of truth
for what the build downloads.

---

## Immich

| | |
| --- | --- |
| Version | 3.4.0-rc.0 |
| Licence | GNU Affero General Public License v3.0 |
| Source | https://github.com/immich-app/immich |
| Included | `app/server`, `runtime/build/www`, `runtime/ml/immich_ml`, `Immich.exe` (launcher) |

The full licence text is in `LICENSE`. Because Immich is served over a network, the AGPL requires
that the source of this build stays available to its users: it is the repository named above, plus
the Windows-specific changes in `windows/`.

---

## PostgreSQL

| | |
| --- | --- |
| Version | 18.6.1 |
| Licence | PostgreSQL Licence (MIT-like) |
| Source | https://github.com/postgres/postgres |
| Binaries | https://github.com/theseus-rs/postgresql-binaries |
| Included | `runtime/postgres` (server, `initdb`, `pg_ctl`, `psql`, `pg_dump`, `pg_dumpall`, `pg_restore`, contrib extensions) |
| Licence text | `runtime/postgres/share/doc/postgresql/copyright` |

Includes contributions licensed under the PostgreSQL Licence, including `uuid-ossp`, `unaccent`,
`cube`, `earthdistance`, `pg_trgm`, `btree_gin` and `pg_stat_statements`.

---

## pgvector

| | |
| --- | --- |
| Version | 0.8.7 |
| Licence | PostgreSQL Licence |
| Source | https://github.com/pgvector/pgvector |
| Binaries | https://github.com/czkwg8/pgvector-windows-binary |
| Included | `runtime/postgres/share/postgresql/extension/vector*`, `vector.dll`, or `share/extension` depending on the PostgreSQL layout |
| Licence text | `runtime/postgres/share/extension/vector.control` names the licence; the repository carries `LICENSE` |

---

## Redis

| | |
| --- | --- |
| Version | 8.10.3 |
| Licence | GNU Affero General Public License v3.0 (Redis 8 is AGPLv3; earlier versions were RSALv2/SSPLv1) |
| Source | https://github.com/redis/redis |
| Windows build | https://github.com/redis-windows/redis-windows |
| Included | `runtime/redis` |
| Licence text | `runtime/redis/LICENSE` |

Redis is used only as a local job queue. It listens on `127.0.0.1` with a generated password and is
not reachable from the network.

---

## Node.js

| | |
| --- | --- |
| Version | 24.22.2 |
| Licence | MIT |
| Source | https://github.com/nodejs/node |
| Included | `runtime/node/node.exe`, and the runtime inside `Immich.exe` |
| Licence text | Not shipped separately; see the notice below |

Node.js is distributed under the MIT licence and additionally bundles OpenSSL (Apache-2.0), V8 (BSD),
libuv (MIT), zlib (zlib licence) and ICU (Unicode licence). The full text is in the Node.js
distribution: https://github.com/nodejs/node/blob/main/LICENSE

`Immich.exe` is `node.exe` with a Node SEA blob appended. It contains the same third-party code as
the Node runtime plus `postject` (MIT), which is used once at build time and is not redistributed.

---

## FFmpeg

| | |
| --- | --- |
| Version | current BtbN `win64-gpl` build |
| Licence | GNU General Public License v3.0, because the build includes GPL components (x264, x265 and others) |
| Source | https://github.com/FFmpeg/FFmpeg |
| Windows build | https://github.com/BtbN/FFmpeg-Builds |
| Included | `runtime/ffmpeg/bin/ffmpeg.exe`, `ffprobe.exe` |
| Licence text | `runtime/ffmpeg/LICENSE.txt` |

The GPL build is chosen because it decodes the widest range of video. It is invoked as a separate
program, which is the arrangement the GPL permits for aggregation. The corresponding source is
available from the links above, and BtbN publishes the exact build configuration for each release.

---

## ExifTool

| | |
| --- | --- |
| Version | 13.60 |
| Licence | Artistic Licence 2.0, or GPLv1+ at your option |
| Source | https://github.com/exiftool/exiftool |
| Windows build | https://exiftool.org |
| Included | `runtime/exiftool` |
| Licence text | `runtime/exiftool/README` |

The Windows executable bundles a Perl interpreter so no Perl installation is required.

---

## Python (CPython)

| | |
| --- | --- |
| Version | 3.12.16 |
| Licence | Python Software Foundation Licence 2.0 |
| Source | https://github.com/python/cpython |
| Windows build | https://github.com/astral-sh/python-build-standalone |
| Included | `runtime/python` |
| Licence text | `runtime/python/LICENSE.txt` |

The standalone build additionally contains OpenSSL (Apache-2.0), libffi (MIT), XZ Utils
(public domain / 0BSD), SQLite (public domain), bzip2 (BSD-like), zlib and mpdecimal (BSD-2-Clause).

---

## Python packages in the machine learning service

Installed into `runtime/ml/packages` by `scripts/install-ml.ps1` from the dependencies declared in
`machine-learning/pyproject.toml`. The important ones:

| Package | Licence |
| --- | --- |
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| pydantic, pydantic-settings | MIT |
| onnxruntime | MIT |
| numpy | BSD-3-Clause |
| pillow, pillow-jxl-plugin | MIT-CMU / Apache-2.0 |
| opencv-python-headless | Apache-2.0 (OpenCV) |
| tokenizers, huggingface-hub | Apache-2.0 |
| rapidocr | Apache-2.0 |
| onnx | Apache-2.0 |
| rich | MIT |
| orjson | Apache-2.0 / MIT |

Each installed distribution carries its own licence file under
`runtime/ml/packages/<package>.dist-info/`.

### AI model definitions

`runtime/ml/packages/immich_model` is taken from https://github.com/immich-app/ml-models at the
revision pinned in `machine-learning/uv.lock`, and carries the same AGPLv3 licence as Immich.

### AI models

Weights are **not** distributed. They are downloaded on first use into
`data\model-cache` from Hugging Face, and each carries the licence chosen by its publisher (for
example InsightFace models are non-commercial, and CLIP is MIT). Review those terms before using AI
features commercially.

---

## uv

| | |
| --- | --- |
| Version | 0.13.7 |
| Licence | MIT OR Apache-2.0 |
| Source | https://github.com/astral-sh/uv |
| Included | `runtime/build-tools/uv.exe` (build and install helper only) |

`uv` is used by `install-ml.ps1` to resolve the Python packages. It is not needed at runtime and can
be deleted once the AI service is installed.

---

## Geodata

Downloaded on demand by `Immich.exe geodata download`, not redistributed.

| Data | Licence |
| --- | --- |
| GeoNames (`cities500`, `admin1CodesASCII`, `admin2Codes`, `countryInfo`) | Creative Commons Attribution 4.0 |
| Natural Earth `ne_10m_admin_0_countries` | Public domain |

---

## JavaScript packages

`app/server/node_modules` and `runtime/build/www` contain the packages listed in
`pnpm-lock.yaml`, each under its own licence; the Immich repository's dependency policy governs
them. Licence texts are in `node_modules/<package>/LICENSE`.

`windows/scripts/better-sqlite3-shim` is part of this build and is MIT licensed, matching the
`better-sqlite3` API it implements on top of `node:sqlite`.

---

## postject

MIT, https://github.com/nodejs/postject. Used at build time to inject the SEA blob; it is not
redistributed.
