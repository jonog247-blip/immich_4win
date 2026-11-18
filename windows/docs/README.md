# Immich4Win

Immich as a portable Windows app. Your photos and videos stay on your PC, in a folder you choose,
served by Immich's own web interface at `http://localhost:2283`.

No Docker. No WSL. No Linux virtual machine. No account with anybody.

---

## What you get

A single folder containing everything Immich needs:

| Part | What it does |
| --- | --- |
| `Immich.exe` | Starts, stops, updates, backs up and diagnoses the whole stack |
| `Immich.bat` | Double-click to start Immich and open it in the browser |
| `Stop-Immich.bat` | Stop everything cleanly |
| `Status.bat` | Show what is running and on which port |
| `Doctor.bat` | Check every dependency and setting |
| `runtime\postgres` | PostgreSQL with the pgvector extension, the database |
| `runtime\redis` | Redis, the job queue |
| `runtime\node` | Node.js, runs the Immich server |
| `runtime\ffmpeg` | FFmpeg, thumbnails and video transcoding |
| `runtime\exiftool` | ExifTool, reads photo metadata |
| `runtime\python`, `runtime\ml` | Python and the AI models (search, faces, OCR) |
| `runtime\build\www` | The web interface |
| `app\server` | The Immich server |
| `scripts` | Setup, service and uninstall scripts |

---

## Setting it up

1. Copy or unzip the folder somewhere permanent, for example `C:\Immich4Win`.
   Avoid a folder inside `Program Files`: Windows protects it and Immich writes logs and caches
   next to itself.
2. Open the folder, hold **Shift**, right-click an empty area, choose *Open PowerShell window here*.
3. Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

That step downloads the binaries for your PC (about 700 MB), checks them, and reports anything that
failed. You do **not** need to be an administrator. Everything is written inside the folder.

If a download fails, run the same command again: finished steps are kept and only the rest is
retried.

### Options

```powershell
install.ps1 -SkipMl           # no AI: smart search, face recognition and OCR stay off
install.ps1 -SkipGeodata      # no place names: photos show coordinates instead of "London"
install.ps1 -InstallService   # start Immich automatically when you log on
install.ps1 -Force            # download again even if a file is already there
```

---

## Starting and stopping

Double-click **`Immich.bat`**. It starts Immich in the background, waits for it to answer, and opens
your browser. Closing the window does not stop Immich.

| I want to | Do this |
| --- | --- |
| Start it | `Immich.bat` |
| Stop it | `Stop-Immich.bat` |
| See if it is running | `Status.bat` |
| Open it again | `Immich.bat` (it notices Immich is already up) |
| Something is broken | `Doctor.bat` |
| Start with Windows | `scripts\service.ps1 -Action install` |

The same things from a terminal, if you prefer:

```powershell
Immich.exe start              # start and keep this window open, showing logs
Immich.exe start --detached   # start in the background
Immich.exe stop
Immich.exe restart
Immich.exe status
Immich.exe open
Immich.exe doctor
```

---

## Where your photos go

Everything you create lives in `%LOCALAPPDATA%\Immich4Win`, not in the program folder:

```
%LOCALAPPDATA%\Immich4Win\
  data\upload\        your photos and videos
  data\postgres\      the database
  data\model-cache\   downloaded AI models
  config\             settings and secrets
  logs\               one log per component
  backups\            database backups
```

To put photos on another drive (recommended for a large library), set it in Immich under
*Administration → Settings → Storage template*, or start Immich once with `IMMICH_HOME` pointing at
the drive you want.

**Back up that folder.** It holds the originals and the database. Nothing is uploaded anywhere.

---

## Backups

Immich backs up its own database from the web interface (*Administration → Settings → Backup*), and
`Immich.exe backup` does the same thing from a terminal:

```powershell
Immich.exe backup create               # save a backup now
Immich.exe backup list                 # see the backups
Immich.exe backup restore <name>       # restore one
```

This uses the bundled `pg_dump`, so it works with no PostgreSQL installation on the PC. Restoring
works the same way and refuses a backup from a newer PostgreSQL than the one installed.

For the photos themselves, copy the `data\upload` folder. A backup of only the database is not
enough to rebuild a library.

---

## Place names

Reverse geocoding turns coordinates into "London, England". It needs about 200 MB of place name
data:

```powershell
Immich.exe geodata download
```

This is optional. Without it, photos show coordinates and map them wherever the map already is.

---

## If something goes wrong

Run `Doctor.bat`. It checks each piece and prints what to do:

```powershell
Immich.exe doctor          # readable report
Immich.exe doctor --json   # same, for a script
Immich.exe logs server     # follow the server log
Immich.exe logs postgres
```

**"Port 2283 is already in use"**: something else, often a previous Immich, holds the port.
`Immich.exe stop` clears leftovers, and `Immich.exe start --port 2284` uses another port.

**Immich starts but the page does not load**: check `Immich.exe logs server`. A database that could
not start usually says why in `Immich.exe logs postgres`.

**The AI features are greyed out**: the machine learning service is not installed. Run
`scripts\install-ml.ps1`, or turn AI off in the admin settings.

**Windows Defender or SmartScreen warns about `Immich.exe`**: it is an unsigned binary built from
this repository. Choose *More info → Run anyway*, or build it yourself with
`node windows/scripts/make-exe.mjs`.

---

## Removing it

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

That removes the program and the logon task, and **keeps your photos and database**. To delete those
as well:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -RemoveData
```

It asks you to type `DELETE` before anything immutable happens.

---

## Building it yourself

From a clone of the Immich repository, on any machine with Node 20 or newer:

```powershell
node windows\scripts\build.mjs
```

The result is `dist\immich4win`. Steps that need network access a build machine may not have are
skipped with a note, and `install.ps1` finishes them on Windows. To rebuild only the launcher:

```powershell
node windows\scripts\make-exe.mjs --out dist\immich4win
```

---

## What is different from the Docker version

Immich normally runs as four containers behind Docker Compose. Here the same four programs run as
ordinary Windows processes, started and watched by `Immich.exe`:

- **gunicorn → uvicorn.** gunicorn's process model is POSIX only, so the AI service runs under
  uvicorn on Windows. The application code is the same.
- **better-sqlite3 → node:sqlite.** One optional component needs a SQLite driver. The native module
  is replaced by a small shim over the SQLite built into Node, so nothing has to be compiled.
- **Plugins are off.** Immich plugins are WebAssembly loaded by a tool without a Windows build. Every
  other feature works.
- **One service, not a stack.** There is no orchestrator: `Immich.exe` starts PostgreSQL first, then
  Redis, then the AI service, then the server, and restarts a component that dies.

Everything else — the API, the web interface, jobs, albums, sharing, search — is Immich as usual,
unmodified.

---

## Licence

Immich is licensed under the **GNU Affero General Public License v3.0**; see `LICENSE`. Every bundled
component keeps its own licence. `THIRD-PARTY-NOTICES.md` lists them and where to find the sources.
