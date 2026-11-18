#!/usr/bin/env node
'use strict';

/*
  Immich4Win product launcher.

  Runs Immich natively on Windows 11 without Docker. This file is the source of the
  single executable: make-exe.mjs packs it into a Node SEA blob, so `Immich.exe` on
  Windows is this script running on the Node runtime that is embedded in the binary.
  It is also directly runnable with `node launcher.cjs` for development on any OS.

  Process model (matches the docker compose stack):
    postgres.exe             database (runtime/postgres)
    redis-server.exe         queue + cache (runtime/redis)
    python + uvicorn         machine learning (runtime/ml, FastAPI + ONNX)
    node server/dist/main.js Immich API, web UI, job workers (app/server)
*/

const { spawn, spawnSync } = require('node:child_process');
const { createGzip, createGunzip, inflateRawSync } = require('node:zlib');
const {
  appendFileSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  cpSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { homedir, totalmem, availableParallelism } = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const PRODUCT = 'Immich4Win';
const PRODUCT_TITLE = 'Immich for Windows 11';
const IS_WINDOWS = process.platform === 'win32';
const IS_SEA = (() => {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
})();

const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  notInstalled: 3,
  alreadyRunning: 4,
  startFailed: 5,
  unhealthy: 6,
  needsSetup: 7,
};

const COMPONENTS = ['postgres', 'redis', 'machine-learning', 'server'];
const COMPONENT_LABELS = {
  postgres: 'database (PostgreSQL)',
  redis: 'queue (Redis)',
  'machine-learning': 'AI service (machine learning)',
  server: 'Immich server',
};

const CLI_PREFIX = PRODUCT.toLowerCase();

const DEFAULT_SETTINGS = {
  port: 2283,
  bind: '127.0.0.1',
  mediaLocation: '',
  database: { host: '127.0.0.1', port: 54329, user: 'postgres', password: '', name: 'immich', vectorExtension: 'pgvector' },
  redis: { enabled: true, port: 63799, password: '' },
  machineLearning: { enabled: true, port: 3003, workers: 1, threads: 0, ann: false },
  server: { workers: ['api', 'microservices'], logLevel: 'log' },
  geodata: { enabled: true, url: '' },
  performance: { sharedBuffersMb: 0, workMemMb: 0, preserveActiveLeaf: true },
  openBrowserOnStart: true,
};

const ANSI = { reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m' };
const colorEnabled = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code, text) => (colorEnabled ? `${code}${text}${ANSI.reset}` : `${text}`);
const ok = (text) => paint(ANSI.green, text);
const warn = (text) => paint(ANSI.yellow, text);
const bad = (text) => paint(ANSI.red, text);
const dim = (text) => paint(ANSI.dim, text);
const bold = (text) => paint(ANSI.bold, text);
const cyan = (text) => paint(ANSI.cyan, text);

const ROOT = resolveRoot();
const HOME = resolveHome();

const PATHS = {
  root: ROOT,
  home: HOME,
  runtime: path.join(ROOT, 'runtime'),
  app: path.join(ROOT, 'app'),
  config: path.join(HOME, 'config'),
  state: path.join(HOME, 'state'),
  data: path.join(HOME, 'data'),
  logs: path.join(HOME, 'logs'),
  plugins: path.join(HOME, 'plugins'),
  settings: path.join(HOME, 'config', 'settings.json'),
  secrets: path.join(HOME, 'config', 'secrets.json'),
  processState: path.join(HOME, 'state', 'processes.json'),
  launcherLog: path.join(HOME, 'logs', 'launcher.log'),
  upload: path.join(HOME, 'data', 'upload'),
  database: path.join(HOME, 'data', 'postgres'),
  redis: path.join(HOME, 'data', 'redis'),
  modelCache: path.join(HOME, 'data', 'model-cache'),
  backups: path.join(HOME, 'data', 'upload', 'backups'),
};

const RUNTIME = {
  node: path.join(PATHS.runtime, 'node', IS_WINDOWS ? 'node.exe' : 'node'),
  postgres: path.join(PATHS.runtime, 'postgres', 'bin'),
  redis: path.join(PATHS.runtime, 'redis'),
  ffmpeg: path.join(PATHS.runtime, 'ffmpeg', 'bin'),
  exiftool: path.join(PATHS.runtime, 'exiftool'),
  python: tool(path.join(PATHS.runtime, 'python'), 'python'),
  mlPython: tool(path.join(PATHS.runtime, 'python'), 'python'),
  mlVenvPython: tool(path.join(PATHS.runtime, 'ml', '.venv', 'Scripts'), 'python'),
  mlVenvScripts: path.join(PATHS.runtime, 'ml', '.venv', 'Scripts'),
  mlSource: path.join(PATHS.runtime, 'ml'),
  build: path.join(PATHS.runtime, 'build'),
  web: path.join(PATHS.runtime, 'build', 'www'),
  geodata: path.join(PATHS.runtime, 'build', 'geodata'),
  plugins: path.join(PATHS.runtime, 'build', 'plugins'),
  cli: path.join(PATHS.runtime, 'cli', 'cli.js'),
};


// Windows tools end in .exe. Keeping the lookup in one place means the same payload can be started
// on a non-Windows build machine for smoke tests, and a missing tool reports one clear path.
function tool(dir, name) {
  const candidate = path.join(dir, IS_WINDOWS ? `${name}.exe` : name);
  return existsSync(candidate) ? candidate : path.join(dir, `${name}.exe`);
}

function scriptPath(name) {
  for (const candidate of [path.join(ROOT, 'scripts', name), path.join(ROOT, 'windows', 'scripts', name)]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(ROOT, 'scripts', name);
}

function backupToolStatus(missing) {
  if (missing.length === 0) {
    return { status: 'pass', detail: 'psql, pg_dump, pg_dumpall, pg_restore' };
  }

  return {
    status: 'warn',
    detail: `in-app database backups and restores are unavailable (${missing.join(', ')} missing)`,
    fix: 'run install.ps1 again: it installs the full PostgreSQL build with client tools',
  };
}

function resolveRoot() {
  if (process.env.IMMICH4WIN_ROOT) {
    return path.resolve(process.env.IMMICH4WIN_ROOT);
  }

  return IS_SEA ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');
}

function resolveHome() {
  if (process.env.IMMICH_HOME) {
    return path.resolve(process.env.IMMICH_HOME);
  }

  const local = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  return path.join(local, 'Immich4Win');
}

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  try {
    mkdirSync(PATHS.logs, { recursive: true });
    appendFileSync(PATHS.launcherLog, `[${nowIso()}] ${message}\n`);
  } catch {
    // logging must never take the launcher down
  }
}

function fail(message) {
  console.error(`${bad('error')} ${message}`);
}

function info(message) {
  console.log(message);
}

function ensureHome() {
  for (const dir of [PATHS.home, PATHS.config, PATHS.state, PATHS.data, PATHS.logs, PATHS.plugins]) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, undefined, 2) + '\n');
  renameSync(temporary, file);
}

function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, extra) {
  if (!isPlainObject(extra)) {
    return extra === undefined ? base : extra;
  }

  const result = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(extra)) {
    result[key] = deepMerge(result[key], value);
  }

  return result;
}

function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function loadSettings() {
  const stored = readJson(PATHS.settings) ?? {};
  const settings = deepMerge(DEFAULT_SETTINGS, stored);
  settings.mediaLocation = settings.mediaLocation ? path.resolve(settings.mediaLocation) : PATHS.upload;
  return settings;
}

function persistSettings(settings) {
  const onDisk = { ...settings, database: { ...settings.database, password: '' }, redis: { ...settings.redis, password: '' } };
  writeJson(PATHS.settings, onDisk);
}

function loadSecrets(settings, { create = true } = {}) {
  const secrets = readJson(PATHS.secrets) ?? {};
  let changed = false;

  // Read-only callers (stop, status, doctor) must never mint a password: a cluster created with one
  // password rejects the next start if the file changed underneath it.
  if (!secrets.databasePassword && create) {
    secrets.databasePassword = randomSecret();
    changed = true;
  }

  if (!secrets.redisPassword && create) {
    secrets.redisPassword = randomSecret();
    changed = true;
  }

  if (changed) {
    writeJson(PATHS.secrets, secrets);
  }

  settings.database.password = secrets.databasePassword ?? settings.database.password;
  settings.redis.password = secrets.redisPassword ?? settings.redis.password;
  return secrets;
}

function settingsForDisplay(settings) {
  return {
    ...settings,
    mediaLocation: settings.mediaLocation,
    database: { ...settings.database, password: '<stored in secrets.json>' },
    redis: { ...settings.redis, password: '<stored in secrets.json>' },
  };
}

function isAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readProcessState() {
  return readJson(PATHS.processState) ?? {};
}

function writeProcessState(state) {
  writeJson(PATHS.processState, state);
}

function clearComponent(name) {
  const state = readProcessState();
  if (Object.hasOwn(state, name)) {
    delete state[name];
    writeProcessState(state);
  }
}

function runningComponent(name) {
  const entry = readProcessState()[name];
  if (!entry) {
    return undefined;
  }

  if (!isAlive(entry.pid)) {
    clearComponent(name);
    return undefined;
  }

  return entry;
}

function updateComponent(name, patch) {
  const state = readProcessState();
  state[name] = { ...state[name], ...patch };
  writeProcessState(state);
}

function killTree(pid, { force = false } = {}) {
  if (!pid) {
    return;
  }

  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
    return;
  }

  // The Immich server forks an "immich-api" and an "immich-microservices" worker. Detached children
  // lead their own group, so the group is signalled first or a worker keeps the port.
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // process already exited
    }
  }
}


// Which pids listen on a TCP port, using only tools that ship with the OS.
function pidsOnPort(port) {
  const pids = new Set();
  if (IS_WINDOWS) {
    const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    for (const line of (result.stdout || '').split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && /LISTEN/i.test(parts[3]) && parts[1]?.endsWith(`:${port}`)) {
        pids.add(Number(parts[4]));
      }
    }

    return [...pids].filter((value) => value > 0);
  }

  const result = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  for (const match of (result.stdout || '').matchAll(/pid=(\d+)/g)) {
    pids.add(Number(match[1]));
  }

  return [...pids].filter((value) => value > 0);
}

// True when the process belongs to this installation, so a port held by something else is left alone.
function isOurProcess(pid) {
  try {
    if (IS_WINDOWS) {
      const result = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'ExecutablePath', '/value'], { encoding: 'utf8', windowsHide: true });
      const executable = (result.stdout || '').match(/ExecutablePath=(.*)/)?.[1]?.trim() ?? '';
      return executable.toLowerCase().startsWith(ROOT.toLowerCase());
    }

    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    return command.includes(ROOT) || command.includes('immich-api') || command.includes('immich-microservices');
  } catch {
    return false;
  }
}

// Runs one statement through the postgres client library the server ships, for PostgreSQL builds
// that come without psql.
const POSTGRES_QUERY_SCRIPT = String.raw`
// Runs inside the Immich server folder, where the postgres client library lives. The connection
// settings arrive through the environment and the statement through stdin, so nothing depends on
// how the arguments of a node -e invocation are laid out.
const { createRequire } = require('node:module');

const serverRoot = process.env.IMMICH4WIN_SERVER_ROOT;
if (!serverRoot) {
  process.stderr.write('IMMICH4WIN_SERVER_ROOT is not set');
  process.exit(2);
}

const port = Number(process.env.IMMICH4WIN_PG_PORT);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('IMMICH4WIN_PG_PORT is not a port number: ' + process.env.IMMICH4WIN_PG_PORT);
  process.exit(2);
}

let sql;
try {
  sql = require('node:fs').readFileSync(0, 'utf8');
} catch (error) {
  process.stderr.write('could not read the statement from stdin: ' + error.message);
  process.exit(2);
}

let postgres;
try {
  postgres = createRequire(serverRoot + '/package.json')('postgres');
} catch (error) {
  process.stderr.write('the postgres client library is missing: ' + error.message);
  process.exit(2);
}

const client = postgres({
  host: '127.0.0.1',
  port,
  username: process.env.IMMICH4WIN_PG_USER,
  password: process.env.IMMICH4WIN_PG_PASSWORD,
  database: 'postgres',
  max: 1,
  // an unreachable server must fail the command instead of hanging the supervisor
  connect_timeout: 10,
  idle_timeout: 5,
  onnotice: () => {},
});

client
  .unsafe(sql)
  .then((rows) => {
    for (const row of rows) {
      process.stdout.write(Object.values(row).map((value) => (value === null ? '' : String(value))).join('|') + '\n');
    }
  })
  .then(() => client.end({ timeout: 5 }))
  .catch(async (error) => {
    process.stderr.write((error && error.message ? error.message : String(error)));
    try {
      await client.end({ timeout: 1 });
    } catch {}
    process.exit(1);
  });
`;

function portIsOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findFreePort(preferred, host = '127.0.0.1') {
  for (let port = preferred; port < preferred + 200; port++) {
    if (!(await portIsOpen(port, host))) {
      return port;
    }
  }

  throw new Error(`unable to find a free port starting at ${preferred}`);
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ status: 0, body: '' });
    });

    request.on('error', () => resolve({ status: 0, body: '' }));
  });
}


// Downloads a (possibly large) file, following redirects and streaming to disk so a 400 MB archive
// never has to sit in memory.
function downloadFile(url, destination, { timeoutMs = 900_000, redirects = 5 } = {}) {
  return new Promise((resolve) => {
    const client = url.startsWith('http://') ? require('node:http') : require('node:https');
    const request = client.get(url, { timeout: timeoutMs, headers: { 'user-agent': `${PRODUCT}/${productVersion()}` } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume();
        resolve(downloadFile(new URL(response.headers.location, url).href, destination, { timeoutMs, redirects: redirects - 1 }));
        return;
      }

      if (status !== 200) {
        response.resume();
        resolve({ ok: false, status });
        return;
      }

      const total = Number(response.headers['content-length'] ?? 0);
      let received = 0;
      let lastReport = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0 && Date.now() - lastReport > 3000) {
          lastReport = Date.now();
          process.stderr.write(`\r    ${Math.round((received / total) * 100)}% of ${Math.round(total / 1024 ** 2)} MB`);
        }
      });

      pipeline(response, createWriteStream(destination))
        .then(() => {
          if (total > 0) {
            process.stderr.write(`\r    ${(received / 1024 ** 2).toFixed(1)} MB downloaded\n`);
          }

          resolve({ ok: true, status, bytes: received });
        })
        .catch((error) => resolve({ ok: false, status, error: error.message }));
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, status: 0, error: 'timed out' });
    });

    request.on('error', (error) => resolve({ ok: false, status: 0, error: error.message }));
  });
}

async function waitFor(predicate, { timeoutMs = 120_000, intervalMs = 500, label = 'service' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireFiles(files, hint) {
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length === 0) {
    return;
  }

  fail(`missing ${missing.length} required file(s):`);
  for (const file of missing) {
    console.error(`  - ${file}`);
  }

  if (hint) {
    console.error(`\n${hint}`);
  }

  process.exit(EXIT.notInstalled);
}

function serverPayload() {
  const installed = path.join(PATHS.app, 'server');
  if (existsSync(path.join(installed, 'dist', 'main.js'))) {
    return { root: installed, main: path.join(installed, 'dist', 'main.js') };
  }

  const development = path.join(ROOT, 'server');
  if (existsSync(path.join(development, 'dist', 'main.js'))) {
    return { root: development, main: path.join(development, 'dist', 'main.js') };
  }

  return undefined;
}

function webRoot() {
  if (existsSync(path.join(RUNTIME.web, 'index.html'))) {
    return RUNTIME.web;
  }

  const development = path.join(ROOT, 'web', 'build');
  return existsSync(path.join(development, 'index.html')) ? development : undefined;
}

function geodataRoot() {
  const candidates = [RUNTIME.geodata, path.join(PATHS.runtime, 'geodata'), path.join(ROOT, 'geodata')];
  return candidates.find((candidate) => existsSync(path.join(candidate, 'cities_data') ) || existsSync(path.join(candidate, 'cities500.txt')));
}

function appendPath(env, ...entries) {
  env.PATH = [...entries.filter(Boolean), env.PATH || process.env.PATH || ''].join(path.delimiter);
  env.Path = env.PATH;
}

function baseEnvironment() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_ENV;
  env.NO_COLOR = process.stdout.isTTY ? '' : '1';
  env.TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return env;
}

function toolEnvironment() {
  const env = baseEnvironment();
  appendPath(env, RUNTIME.ffmpeg, RUNTIME.exiftool, RUNTIME.postgres, RUNTIME.redis, PATHS.runtime);
  env.IMMICH_PG_BIN = RUNTIME.postgres;
  env.IMMICH_FFMPEG_PATH = tool(RUNTIME.ffmpeg, 'ffmpeg');
  env.IMMICH_FFPROBE_PATH = tool(RUNTIME.ffmpeg, 'ffprobe');
  env.IMMICH_EXIFTOOL_PATH = tool(RUNTIME.exiftool, 'exiftool');
  return env;
}

function serverEnvironment(settings, ports) {
  const env = toolEnvironment();
  const payload = serverPayload();
  const build = webRoot() ? RUNTIME.build : undefined;
  const geodata = geodataRoot();

  env.IMMICH_MEDIA_LOCATION = settings.mediaLocation;
  env.IMMICH_PORT = String(ports.server);
  env.IMMICH_HOST = settings.bind;
  env.IMMICH_LOG_LEVEL = settings.server.logLevel;
  env.IMMICH_ENV = 'production';
  env.IMMICH_ALLOW_SETUP = 'true';
  env.IMMICH_WORKERS_INCLUDE = settings.server.workers.join(',');
  env.IMMICH_PLUGINS_INSTALL_FOLDER = PATHS.plugins;
  env.IMMICH_ALLOW_EXTERNAL_PLUGINS = 'false';

  if (build) {
    env.IMMICH_BUILD_DATA = build;
  }

  if (geodata && (!build || !within(geodata, build))) {
    env.IMMICH_GEODATA_OVERRIDE = geodata;
  }

  env.DB_URL = `postgres://${encodeURIComponent(settings.database.user)}:${encodeURIComponent(settings.database.password)}@${settings.database.host}:${ports.database}/${encodeURIComponent(settings.database.name)}`;
  env.DB_VECTOR_EXTENSION = settings.database.vectorExtension;

  if (settings.redis.enabled) {
    env.REDIS_HOSTNAME = '127.0.0.1';
    env.REDIS_PORT = String(ports.redis);
    env.REDIS_PASSWORD = settings.redis.password;
  }

  if (settings.machineLearning.enabled) {
    env.IMMICH_MACHINE_LEARNING_URL = `http://127.0.0.1:${ports.ml}`;
  }

  if (payload) {
    env.IMMICH_SERVER_ROOT = payload.root;
  }

  return env;
}

function machineLearningEnvironment(settings, ports) {
  const env = baseEnvironment();
  appendPath(env, RUNTIME.python ? path.dirname(RUNTIME.python) : '', RUNTIME.mlVenvScripts);
  env.MACHINE_LEARNING_CACHE_FOLDER = PATHS.modelCache;
  env.MACHINE_LEARNING_WORKERS = String(settings.machineLearning.workers);
  env.MACHINE_LEARNING_WORKER_TIMEOUT = '300';
  env.MACHINE_LEARNING_MODEL_TTL = '300';
  env.MACHINE_LEARNING_ANN = settings.machineLearning.ann ? 'true' : 'false';
  env.MACHINE_LEARNING_MODEL_ARENA = 'true';
  // match the container: every Hugging Face cache lives with the rest of the Immich data
  env.TRANSFORMERS_CACHE = PATHS.modelCache;
  env.HF_HOME = PATHS.modelCache;
  env.HUGGINGFACE_HUB_CACHE = PATHS.modelCache;
  env.PYTHONDONTWRITEBYTECODE = '1';
  if (settings.machineLearning.threads > 0) {
    env.OMP_NUM_THREADS = String(settings.machineLearning.threads);
  }

  // the bundled interpreter finds its own standard library; only the staged site directory is named
  env.PYTHONPATH = [path.join(RUNTIME.mlSource, 'packages'), RUNTIME.mlSource, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.PYTHONNOUSERSITE = '1';
  env.IMMICH_HOST = '127.0.0.1';
  env.IMMICH_PORT = String(ports.ml);
  return env;
}

function currentPorts(settings) {
  const state = readProcessState();
  return {
    database: state.postgres?.port ?? settings.database.port,
    redis: state.redis?.port ?? settings.redis.port,
    ml: state['machine-learning']?.port ?? settings.machineLearning.port,
    server: state.server?.port ?? settings.port,
  };
}

function rotateLog(name) {
  const file = path.join(PATHS.logs, `${name}.log`);
  try {
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) {
      copyFileSync(file, `${file}.1`);
      rmSync(file, { force: true });
    }
  } catch {
    // rotation is best effort
  }

  return file;
}

function spawnComponent(name, command, args, options = {}) {
  const logFile = rotateLog(name);
  const stream = createWriteStream(logFile, { flags: 'a' });
  stream.write(`\n===== ${nowIso()} ${path.basename(command)} ${args.join(' ')}\n`);

  // A detached child that inherits our pipes dies on its next write once the supervisor exits.
  // Those children append to the log file themselves instead.
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.detached ? ['ignore', stream.fd ?? 'ignore', stream.fd ?? 'ignore'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: Boolean(options.detached),
  });

  if (!options.detached) {
    child.stdout.on('data', (chunk) => stream.write(chunk));
    child.stderr.on('data', (chunk) => stream.write(chunk));
  }

  child.on('error', (error) => stream.write(`[spawn error] ${error.message}\n`));
  child.on('exit', (code, signal) => {
    stream.write(`===== ${nowIso()} exited code=${code} signal=${signal}\n`);
    stream.end();
    const state = readProcessState();
    if (state[name]?.pid === child.pid) {
      delete state[name];
      writeProcessState(state);
    }
  });

  updateComponent(name, { pid: child.pid, startedAt: nowIso(), command, args });
  if (options.detached) {
    child.unref();
  }

  return child;
}

function psql(port, settings, sql) {
  const env = toolEnvironment();
  env.PGPASSWORD = settings.database.password;
  const client = tool(RUNTIME.postgres, 'psql');
  if (existsSync(client)) {
    return spawnSync(
      client,
      ['-h', '127.0.0.1', '-p', String(port), '-U', settings.database.user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
      { env, encoding: 'utf8', windowsHide: true },
    );
  }

  // No psql in the payload: talk to the server over TCP with the library the server already ships
  env.IMMICH4WIN_SERVER_ROOT = path.join(PATHS.app, 'server');
  const node = resolveNodeRuntime();
  if (!node) {
    // A caller must never receive an empty reason: without this the error reads "unable to query
    // the database: " and the user has nothing to act on
    return { status: 127, stdout: '', stderr: 'no Node runtime is available for the database client' };
  }

  env.IMMICH4WIN_PG_PORT = String(port);
  env.IMMICH4WIN_PG_USER = settings.database.user;
  env.IMMICH4WIN_PG_PASSWORD = settings.database.password;
  const result = spawnSync(node, ['-e', POSTGRES_QUERY_SCRIPT], {
    env,
    input: sql,
    encoding: 'utf8',
    windowsHide: true,
    // a stuck connection attempt must not freeze start or stop forever
    timeout: 60_000,
  });

  if (result.error) {
    return { status: 127, stdout: result.stdout ?? '', stderr: result.error.message };
  }

  if (result.status !== 0 && !(result.stderr || '').trim()) {
    // the client exits non-zero with an empty stream when it cannot even be loaded
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: `the database client exited with ${result.status}` };
  }

  return result;
}

function volumeTuning(settings) {
  const totalGb = totalmem() / 1024 ** 3;
  const shared = settings.performance.sharedBuffersMb || Math.round(Math.min(2048, Math.max(128, totalGb * 1024 * 0.0625)));
  const workMem = settings.performance.workMemMb || Math.round(Math.min(256, Math.max(16, totalmem() / 1024 ** 2 / 1024)));
  return { shared, workMem };
}

async function startPostgres(settings, ports, options = {}) {
  const running = runningComponent('postgres');
  if (running) {
    return { pid: running.pid, port: running.port ?? settings.database.port, started: false };
  }

  // The cluster has to be created with the password the server presents on every later start
  loadSecrets(settings);

  requireFiles(
    ['postgres', 'initdb', 'pg_ctl'].map((file) => tool(RUNTIME.postgres, file)),
    'the PostgreSQL runtime is missing — run install.ps1',
  );

  mkdirSync(PATHS.database, { recursive: true });
  const clusterFile = path.join(PATHS.database, 'PG_VERSION');

  if (!existsSync(clusterFile)) {
    info(`  ${dim('initialising the database cluster')}`);
    const passwordFile = path.join(PATHS.state, 'initdb-password.tmp');
    writeFileSync(passwordFile, settings.database.password);
    const result = spawnSync(
      tool(RUNTIME.postgres, 'initdb'),
      [
        '-D', PATHS.database,
        '-U', settings.database.user,
        `--pwfile=${passwordFile}`,
        '--auth=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
        '--data-checksums',
      ],
      { env: toolEnvironment(), encoding: 'utf8', windowsHide: true },
    );
    rmSync(passwordFile, { force: true });

    if (result.status !== 0) {
      throw new Error(`initdb failed (exit ${result.status}): ${((result.stderr || '') + (result.stdout || '')).trim().slice(0, 800)}`);
    }
  }

  const port = await findFreePort(settings.database.port);
  const tuning = volumeTuning(settings);
  const postgresArgs = [
    '-D', PATHS.database,
    '-p', String(port),
    '-c', 'listen_addresses=127.0.0.1',
    '-c', `shared_buffers=${tuning.shared}MB`,
    '-c', 'max_connections=200',
    '-c', 'jit=off',
    '-c', 'random_page_cost=1.1',
    '-c', 'effective_io_concurrency=200',
    '-c', `maintenance_work_mem=${Math.max(64, tuning.workMem * 4)}MB`,
    '-c', `work_mem=${tuning.workMem}MB`,
    '-c', 'wal_compression=on',
    '-c', 'timezone=UTC',
    '-c', 'log_timezone=UTC',
  ];

  const child = spawnComponent('postgres', tool(RUNTIME.postgres, 'postgres'), postgresArgs, {
    detached: options.detached,
    env: toolEnvironment(),
    cwd: PATHS.database,
  });

  // An open socket is not enough: PostgreSQL accepts TCP before it will answer a query, and the
  // first bootstrap query would then fail with a connection reset. The ready probe has to succeed
  // as an authenticated statement.
  await waitFor(
    async () => {
      if (!isAlive(child.pid)) {
        throw new Error(`the database exited during startup\n${lastLines('postgres', 15)}`);
      }

      if (!(await portIsOpen(port))) {
        return false;
      }

      const probe = psql(port, settings, 'SELECT 1');
      return probe.status === 0 && probe.stdout.trim() === '1';
    },
    { label: 'the database', timeoutMs: 120_000 },
  );

  updateComponent('postgres', { port });

  const exists = psql(port, settings, `SELECT 1 FROM pg_database WHERE datname = '${settings.database.name}'`);
  if (exists.status !== 0) {
    throw new Error(`unable to query the database: ${(exists.stderr || '').trim().slice(0, 800)}`);
  }

  if (exists.stdout.trim() !== '1') {
    info(`  ${dim(`creating database '${settings.database.name}'`)}`);
    const created = psql(port, settings, `CREATE DATABASE "${settings.database.name}"`);
    if (created.status !== 0) {
      throw new Error(`unable to create the database: ${(created.stderr || '').trim().slice(0, 800)}`);
    }
  }

  const extension = checkVectorExtension();
  if (extension.status === 'fail') {
    throw new Error(extension.detail + ' — ' + extension.fix);
  }

  return { pid: child.pid, port, started: true };
}

async function startRedis(settings, ports, options = {}) {
  const running = runningComponent('redis');
  if (running) {
    return { pid: running.pid, port: running.port ?? settings.redis.port, started: false };
  }

  const server = tool(RUNTIME.redis, 'redis-server');
  if (!settings.redis.enabled) {
    return undefined;
  }

  if (!existsSync(server)) {
    throw new Error(
      `the queue (redis-server.exe) is missing from ${RUNTIME.redis}.\n` +
        '  Immich needs Redis to run background jobs (thumbnails, transcoding, AI).\n' +
        '  Run install.ps1 (or Immich.exe install) to download it.',
    );
  }

  loadSecrets(settings);

  mkdirSync(PATHS.redis, { recursive: true });
  const port = await findFreePort(settings.redis.port);
  const configFile = path.join(PATHS.state, 'redis.conf');
  writeFileSync(
    configFile,
    [
      'bind 127.0.0.1',
      `port ${port}`,
      'protected-mode yes',
      `requirepass ${settings.redis.password}`,
      `dir "${PATHS.redis.replaceAll('\\', '/')}"`,
      'appendonly yes',
      'appendfsync everysec',
      'save 3600 1 300 100',
      'maxmemory-policy noeviction',
      'enable-debug-command no',
      '[string] logfile',
    ]
      .map((line) => (line === '[string] logfile' ? `logfile "${path.join(PATHS.logs, 'redis-out.log').replaceAll('\\', '/')}"` : line))
      .join('\n'),
  );

  const spawnRedis = () => spawnComponent('redis', server, [configFile], { env: toolEnvironment(), cwd: RUNTIME.redis });
  let child = spawnRedis();

  await waitFor(
    () => {
      if (!isAlive(child.pid)) {
        throw new Error(`the queue exited during startup\n${lastLines('redis', 10)}`);
      }

      return portIsOpen(port);
    },
    { label: 'the queue', timeoutMs: 30_000 },
  ).catch((error) => {
    // An older redis-server rejects a directive it does not know and exits, which would turn a
    // supported configuration into a start failure. The hardening lines are optional, so they are
    // dropped once and the start retried before reporting anything.
    const log = lastLines('redis', 20);
    if (!/FATAL CONFIG FILE ERROR|Bad directive/i.test(log)) {
      throw error;
    }

    const optional = ['enable-debug-command no'];
    const kept = readFileSync(configFile, 'utf8').split('\n').filter((line) => !optional.includes(line.trim()));
    writeFileSync(configFile, kept.join('\n'));
    clearComponent('redis');
    child = spawnRedis();
    return waitFor(() => (isAlive(child.pid) ? portIsOpen(port) : false), { label: 'the queue', timeoutMs: 30_000 });
  });

  updateComponent('redis', { port });
  return { pid: child.pid, port, started: true };
}

async function startMachineLearning(settings, ports, options = {}) {
  const running = runningComponent('machine-learning');
  if (running) {
    return { pid: running.pid, port: running.port ?? settings.machineLearning.port, started: false };
  }

  if (settings.machineLearning.enabled === false) {
    return undefined;
  }

  if (!existsSync(RUNTIME.mlPython) || !existsSync(path.join(RUNTIME.mlSource, 'packages', 'uvicorn'))) {
    return undefined;
  }

  const port = await findFreePort(settings.machineLearning.port);
  mkdirSync(PATHS.modelCache, { recursive: true });

  const child = spawnComponent(
    'machine-learning',
    RUNTIME.mlPython,
    // immich_ml.__main__ builds the uvicorn command from the same settings the container uses,
    // so the worker count, health check timeout and keep-alive come from one place
    ['-m', 'immich_ml'],
    { env: machineLearningEnvironment(settings, { ml: port }), cwd: RUNTIME.mlSource, detached: options.detached },
  );

  await waitFor(
    async () => {
      if (!isAlive(child.pid)) {
        throw new Error(`the AI service exited during startup\n${lastLines('machine-learning', 15)}`);
      }

      const response = await httpGet(`http://127.0.0.1:${port}/ping`);
      return response.status === 200;
    },
    { label: 'the AI service', timeoutMs: 300_000 },
  );

  updateComponent('machine-learning', { port });
  return { pid: child.pid, port, started: true };
}


function isSingleExecutable() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

// The bundled node.exe runs the Immich server and every helper script.
function resolveNodeRuntime() {
  if (existsSync(RUNTIME.node)) {
    return RUNTIME.node;
  }

  const self = path.resolve(process.execPath);
  const wrappers = ['Immich.exe', 'immich.exe'].map((name) => path.join(ROOT, name));
  if (!isSingleExecutable() && !wrappers.includes(self)) {
    return process.execPath;
  }

  return undefined;
}

// An earlier run may still hold the port; it has to go before a new server can bind.
async function clearOrphanedServer(settings) {
  const hosted = pidsOnPort(settings.port);
  const ours = hosted.filter((pid) => isOurProcess(pid));
  if (ours.length === 0) {
    return;
  }

  info(`  ${warn('an earlier Immich process still holds the port, stopping it')}`);
  for (const pid of ours) {
    killTree(pid, { force: true });
  }

  await waitFor(async () => !(await portIsOpen(settings.port)), { label: 'the old server to exit', timeoutMs: 20_000 }).catch(() => {});
}

async function startServer(settings, ports, options = {}) {
  const payload = serverPayload();
  if (!payload) {
    requireFiles([path.join(PATHS.app, 'server', 'dist', 'main.js')], 'the Immich server payload is missing — re-run install.ps1');
  }

  // A crashed run can leave an Immich worker behind: it keeps the port and answers readiness
  // probes, so the new server silently fails to bind.
  await clearOrphanedServer(settings);

  const port = await findFreePort(settings.port, settings.bind === '0.0.0.0' ? '127.0.0.1' : settings.bind);
  if (port !== settings.port) {
    info(`  ${warn(`port ${settings.port} is in use, using ${port}`)}`);
  }

  ports.server = port;
  const node = resolveNodeRuntime();
  if (!node) {
    throw new Error('the bundled Node.js runtime (runtime/node/node.exe) is missing — run install.ps1');
  }

  const child = spawnComponent('server', node, ['--enable-source-maps', payload.main], {
    env: serverEnvironment(settings, ports),
    cwd: payload.root,
    detached: options.detached,
  });

  await waitFor(
    async () => {
      if (!isAlive(child.pid)) {
        throw new Error(`the Immich server exited during startup\n${lastLines('server', 25)}`);
      }

      const response = await httpGet(`http://127.0.0.1:${port}/api/server/ping`);
      return response.status === 200;
    },
    { label: 'the Immich server', timeoutMs: 300_000 },
  );

  updateComponent('server', { port });
  return { pid: child.pid, port, started: true };
}

function serverUrl(settings, ports) {
  const host = settings.bind === '0.0.0.0' ? 'localhost' : settings.bind;
  return `http://${host}:${ports.server}`;
}

function printRunning(settings, ports) {
  info('');
  info(`  ${bold(PRODUCT_TITLE)} ${ok('is running')}`);
  info(`  ${cyan(serverUrl(settings, ports))}`);
  info('');
  info(`  ${dim('first run')}  create your admin account in the browser`);
  info(`  ${dim('data')}       ${settings.mediaLocation}`);
  info(`  ${dim('logs')}       ${PATHS.logs}`);
  info('');
  info(`  ${dim('stop')}       ${CLI_PREFIX}.exe stop`);
  info(`  ${dim('status')}     ${CLI_PREFIX}.exe status`);
  info('');
}

async function startEverything(options) {
  const settings = loadSettings();
  if (options.port) {
    settings.port = options.port;
  }

  loadSecrets(settings);
  const ports = currentPorts(settings);

  if (options.dryRun) {
    info(JSON.stringify({
      root: ROOT,
      home: HOME,
      mediaLocation: settings.mediaLocation,
      database: tool(RUNTIME.postgres, 'postgres'),
      redis: tool(RUNTIME.redis, 'redis-server'),
      machineLearning: RUNTIME.mlPython,
      server: serverPayload()?.main,
      ports,
    }, undefined, 2));
    return EXIT.ok;
  }

  const started = [];
  try {
    info(bold(`  starting ${PRODUCT_TITLE}`));

    const postgres = await startPostgres(settings, ports, options);
    ports.database = postgres.port;
    started.push('postgres');
    info(`  ${ok('database')}         ${dim(`127.0.0.1:${postgres.port}`)}`);

    const redis = await startRedis(settings, ports, options);
    if (redis) {
      ports.redis = redis.port;
      started.push('redis');
      info(`  ${ok('queue')}            ${dim(`127.0.0.1:${redis.port}`)}`);
    } else {
      info(`  ${warn('queue')}            ${dim('disabled (set redis.enabled=true, or run install.ps1)')}`);
    }

    const ml = await startMachineLearning(settings, ports, options);
    if (ml) {
      ports.ml = ml.port;
      started.push('machine-learning');
      info(`  ${ok('AI service')}       ${dim(`127.0.0.1:${ml.port}`)}`);
    } else {
      info(`  ${warn('AI service')}       ${dim('disabled (smart search, faces and OCR need the ML runtime)')}`);
    }

    const server = await startServer(settings, ports, options);
    ports.server = server.port;
    started.push('server');
    info(`  ${ok('Immich server')}    ${dim(`127.0.0.1:${server.port}`)}`);

    printRunning(settings, ports);
    log(`started ${started.join(', ')}`);

    if (settings.openBrowserOnStart && !options.noBrowser) {
      openUrl(serverUrl(settings, ports));
    }

    return EXIT.ok;
  } catch (error) {
    fail(error.message);
    log(`start failed: ${error.stack || error.message}`);
    await stopEverything({ quiet: true });
    return EXIT.startFailed;
  }
}

function stopComponent(name) {
  const entry = runningComponent(name);
  if (!entry) {
    return false;
  }

  if (name === 'postgres') {
    const pgCtl = tool(RUNTIME.postgres, 'pg_ctl');
    if (existsSync(pgCtl)) {
      spawnSync(pgCtl, ['stop', '-D', PATHS.database, '-m', 'fast', '-w', '-t', '60'], {
        env: toolEnvironment(),
        stdio: 'ignore',
        windowsHide: true,
      });
    }
  }

  if (name === 'redis') {
    const cli = tool(RUNTIME.redis, 'redis-cli');
    if (existsSync(cli)) {
      const settings = loadSettings();
      loadSecrets(settings);
      spawnSync(cli, ['-p', String(entry.port ?? settings.redis.port), '-a', settings.redis.password, '--no-auth-warning', 'shutdown', 'nosave'], {
        env: toolEnvironment(),
        stdio: 'ignore',
        windowsHide: true,
      });
    }
  }

  if (name === 'machine-learning') {
    spawnSync('taskkill', ['/PID', String(entry.pid), '/T'], { stdio: 'ignore', windowsHide: true });
  }

  if (!(await_exit(entry.pid, 15_000))) {
    killTree(entry.pid, { force: true });
  }

  clearComponent(name);
  return true;
}

function await_exit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }

    spawnSync(IS_WINDOWS ? 'cmd' : 'sleep', IS_WINDOWS ? ['/c', 'ping', '-n', '2', '127.0.0.1'] : ['0.5'], { stdio: 'ignore', windowsHide: true });
  }

  return !isAlive(pid);
}

// The background supervisor is the parent of every component: stopping the stack has to end there,
// otherwise it restarts whatever was just stopped.
function stopSupervisor({ quiet = false } = {}) {
  const record = readJson(path.join(PATHS.state, 'supervisor.json'));
  if (!record?.pid || !isAlive(record.pid) || record.pid === process.pid) {
    return false;
  }

  killTree(record.pid, { force: false });
  if (!waitForProcessExit(record.pid, 10_000)) {
    killTree(record.pid, { force: true });
  }

  rmSync(path.join(PATHS.state, 'supervisor.json'), { force: true });
  if (!quiet) {
    info(`  ${ok('stopped')} supervisor ${record.pid}`);
  }

  return true;
}

async function stopEverything(options = {}) {
  const stopped = [];
  const supervisorStopped = stopSupervisor({ quiet: options.quiet });
  for (const name of ['server', 'machine-learning', 'redis', 'postgres']) {
    if (stopComponent(name)) {
      stopped.push(name);
      if (!options.quiet) {
        info(`  ${ok('stopped')} ${name}`);
      }
    }
  }

  // A crashed run leaves workers the pid files no longer describe; they hold ports and cluster
  // locks. Read-only here: stopping must never mint new secrets.
  const settings = loadSettings();
  loadSecrets(settings, { create: false });
  const orphans = new Set();
  for (const port of [settings.port, settings.redis.port, settings.machineLearning.port, settings.database.port]) {
    for (const pid of pidsOnPort(port)) {
      if (isOurProcess(pid) && pid !== process.pid) {
        orphans.add(pid);
      }
    }
  }

  for (const pid of orphans) {
    killTree(pid, { force: true });
    if (!options.quiet) {
      info(`  ${ok('stopped')} leftover process ${pid}`);
    }
  }

  if (stopped.length === 0 && orphans.size === 0 && !supervisorStopped && !options.quiet) {
    info(`  ${warn('Immich is not running')}`);
  }

  log(`stopped ${stopped.join(', ') || 'nothing'}`);
  return EXIT.ok;
}

function openUrl(url) {
  if (process.env.IMMICH4WIN_NO_OPEN) {
    return;
  }

  if (IS_WINDOWS) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }

  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function lastLines(name, count) {
  const file = path.join(PATHS.logs, `${name}.log`);
  try {
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    return `\n${dim(`  --- ${file} (last ${count} lines) ---`)}\n${lines.slice(-count).map((line) => `  ${line}`).join('\n')}`;
  } catch {
    return '';
  }
}

function checkVectorExtension() {
  // PostgreSQL builds disagree on where share/ lives
  const control = [
    path.join(PATHS.runtime, 'postgres', 'share', 'extension', 'vector.control'),
    path.join(PATHS.runtime, 'postgres', 'share', 'postgresql', 'extension', 'vector.control'),
  ].find((candidate) => existsSync(candidate));
  if (control) {
    const version = (readFileSync(control, 'utf8').match(/default_version\s*=\s*'([^']+)'/) || [])[1];
    return { status: 'pass', detail: `pgvector ${version || ''}`.trim(), fix: '' };
  }

  return {
    status: 'fail',
    detail: 'pgvector is not installed in the bundled PostgreSQL',
    fix: 're-run install.ps1 (it copies pgvector into runtime/postgres)',
  };
}

function diskFreeBytes(target) {
  try {
    const stats = require('node:fs').statfsSync ? require('node:fs').statfsSync(target) : undefined;
    return stats ? Number(stats.bavail) * Number(stats.bsize) : undefined;
  } catch {
    return undefined;
  }
}

function checkLongPaths() {
  if (!IS_WINDOWS) {
    return undefined;
  }

  const result = spawnSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    return undefined;
  }

  const match = result.stdout.match(/0x([0-9a-f]+)/i);
  return match ? Number.parseInt(match[1], 16) === 1 : undefined;
}

function canWrite(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function toolVersion(exe, args) {
  if (!existsSync(exe)) {
    return 'not installed';
  }

  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  return `${result.stdout || ''}`.split('\n')[0].trim().slice(0, 100) || 'unknown';
}

function postgresVersion() {
  return toolVersion(tool(RUNTIME.postgres, 'postgres'), ['--version']);
}

function productVersion() {
  const payload = serverPayload();
  try {
    return JSON.parse(readFileSync(path.join(payload.root, 'package.json'), 'utf8')).version;
  } catch {
    return 'not installed';
  }
}

async function commandDoctor(options) {
  const settings = loadSettings();
  loadSecrets(settings);
  const results = [];
  const add = (status, label, detail, fix) => results.push({ status, label, detail, fix });

  if (IS_WINDOWS) {
    const ver = spawnSync('cmd', ['/c', 'ver'], { encoding: 'utf8', windowsHide: true });
    add('pass', 'Windows', (ver.stdout || '').trim() || 'unknown', 'Immich4Win targets Windows 11 x64');
  } else {
    add('warn', 'Windows', `${process.platform} ${process.arch} (development host)`, 'Ship and run this build on Windows 11 x64');
  }

  add(existsSync(RUNTIME.node) || !IS_SEA ? 'pass' : 'fail', 'Node runtime', existsSync(RUNTIME.node) ? RUNTIME.node : process.execPath, 'Re-run install.ps1');

  const payload = serverPayload();
  add(payload ? 'pass' : 'fail', 'Immich server', payload ? productVersion() : 'payload missing', 'Re-run install.ps1');

  const web = webRoot();
  add(web ? 'pass' : 'fail', 'Web app', web ?? 'missing (the UI will not load)', 'Re-run install.ps1');

  const geodata = geodataRoot();
  add(geodata ? 'pass' : 'warn', 'Reverse geocoding data', geodata ?? 'not downloaded (map search and place names disabled)', `${CLI_PREFIX}.exe geodata download`);

  // backups and the database-restore screen need the client tools; the server itself does not
  const pg = ['postgres', 'initdb', 'pg_ctl'].map((file) => tool(RUNTIME.postgres, file));
  const pgClients = ['psql', 'pg_dump', 'pg_dumpall', 'pg_restore'].map((file) => tool(RUNTIME.postgres, file));
  add(pg.every((file) => existsSync(file)) ? 'pass' : 'fail', 'PostgreSQL', pg.every((file) => existsSync(file)) ? postgresVersion() : 'binaries missing', 'Re-run install.ps1');

  const extension = checkVectorExtension();
  add(extension.status, 'pgvector', extension.detail, extension.fix);

  const missingClients = pgClients.filter((file) => !existsSync(file)).map((file) => path.basename(file));
  const backupCheck = backupToolStatus(missingClients);
  add(backupCheck.status, 'Backup tools', backupCheck.detail, backupCheck.fix ?? '');

  const ffmpegExists = existsSync(tool(RUNTIME.ffmpeg, 'ffmpeg'));
  add(ffmpegExists ? 'pass' : 'fail', 'FFmpeg', ffmpegExists ? toolVersion(tool(RUNTIME.ffmpeg, 'ffmpeg'), ['-version']).slice(0, 60) : 'missing', 'Re-run install.ps1');

  const exiftoolExists = existsSync(RUNTIME.exiftool);
  add(exiftoolExists ? 'pass' : 'fail', 'ExifTool', exiftoolExists ? RUNTIME.exiftool : 'missing', 'Re-run install.ps1');

  const redisReady = existsSync(tool(RUNTIME.redis, 'redis-server'));
  add(redisReady ? 'pass' : 'fail', 'Redis', redisReady ? 'bundled' : 'missing (background jobs cannot run)', 'Run install.ps1, or Immich.exe install');

  const mlReady = existsSync(RUNTIME.mlPython) && existsSync(path.join(RUNTIME.mlSource, 'packages', 'uvicorn'));
  add(mlReady ? 'pass' : 'warn', 'Machine learning', mlReady ? `python ${RUNTIME.mlPython}` : 'not installed (smart search, faces, OCR disabled)', 'Re-run install.ps1 without -SkipMl');

  const free = diskFreeBytes(PATHS.home);
  if (free !== undefined) {
    add(free > 20 * 1024 ** 3 ? 'pass' : 'warn', 'Free disk space', `${(free / 1024 ** 3).toFixed(0)} GB available`, 'Keep at least 20 GB free for imports and thumbnails');
  }

  add(canWrite(PATHS.data) ? 'pass' : 'fail', 'Data folder', `${PATHS.data}${canWrite(PATHS.data) ? '' : ' (not writeable)'}`, 'Choose a writeable IMMICH_HOME, or fix NTFS permissions');

  if (IS_WINDOWS) {
    const longPaths = checkLongPaths();
    add(longPaths === true ? 'pass' : 'warn', 'Long path support', longPaths === true ? 'enabled' : longPaths === false ? 'disabled' : 'unknown', 'Set HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem LongPathsEnabled=1 (Administrator)');
  }

  const serverBusy = await portIsOpen(settings.port);
  const owned = Boolean(runningComponent('server'));
  add(!serverBusy || owned ? 'pass' : 'warn', `Port ${settings.port}`, serverBusy ? 'in use by another process' : 'available', `Change it with: ${CLI_PREFIX}.exe config set port <number>`);

  const failing = results.filter((row) => row.status === 'fail');

  if (options.json) {
    info(JSON.stringify({ home: HOME, root: ROOT, results }, undefined, 2));
    return failing.length === 0 ? EXIT.ok : EXIT.unhealthy;
  }

  info(bold(`  ${PRODUCT_TITLE} doctor`));
  info('');
  for (const row of results) {
    const label = row.status === 'pass' ? ok('pass') : row.status === 'warn' ? warn('warn') : bad('fail');
    info(`  ${label}  ${row.label.padEnd(24)} ${dim(String(row.detail))}`);
    if (row.status !== 'pass' && row.fix) {
      info(`        ${dim('->')} ${row.fix}`);
    }
  }

  info('');
  info(failing.length === 0 ? ok('  no blocking problems found') : bad(`  ${failing.length} blocking problem(s) found`));
  return failing.length === 0 ? EXIT.ok : EXIT.unhealthy;
}

async function commandStatus(options) {
  ensureHome();
  const settings = loadSettings();
  const ports = currentPorts(settings);
  const rows = [];

  for (const name of COMPONENTS) {
    const entry = runningComponent(name);
    const port = entry?.port ?? ports[name === 'machine-learning' ? 'ml' : name === 'postgres' ? 'database' : name];
    const reachable = port ? await portIsOpen(port) : false;
    rows.push({
      component: name,
      label: COMPONENT_LABELS[name],
      state: entry ? (reachable ? 'running' : 'starting') : 'stopped',
      pid: entry?.pid ?? null,
      port: port ?? null,
    });
  }

  const serverRow = rows.find((row) => row.component === 'server');
  const url = serverRow?.state === 'running' ? serverUrl(settings, ports) : null;

  if (options.json) {
    info(JSON.stringify({ url, root: ROOT, home: HOME, mediaLocation: settings.mediaLocation, components: rows }, undefined, 2));
    return url ? EXIT.ok : EXIT.unhealthy;
  }

  info(bold(`  ${PRODUCT_TITLE}`));
  info(`  ${dim('install')}  ${ROOT}`);
  info(`  ${dim('data')}     ${settings.mediaLocation}`);
  info('');
  for (const row of rows) {
    const state = row.state === 'running' ? ok('running ') : row.state === 'starting' ? warn('starting') : dim('stopped ');
    const pid = row.pid ? String(row.pid).padEnd(7) : dim('-'.padEnd(7));
    const port = row.port ? dim(`:${row.port}`) : '';
    info(`  ${state}  ${row.label.padEnd(26)} ${pid} ${port}`);
  }

  info('');
  info(`  ${url ? cyan(url) : dim('not running')}`);
  if (url) {
    info(`  ${dim('open')} ${CLI_PREFIX}.exe open     ${dim('stop')} ${CLI_PREFIX}.exe stop`);
  } else {
    info(`  ${dim('start it with')} ${CLI_PREFIX}.exe start`);
  }

  return url ? EXIT.ok : EXIT.unhealthy;
}


// Keeps the stack healthy while the launcher runs: restarts a component that dies and shuts
// everything down cleanly on Ctrl+C, console close or sign out.
async function supervise(options, settings, ports) {
  let stopping = false;
  let failures = 0;

  const shutdown = async (reason) => {
    if (stopping) {
      return;
    }

    stopping = true;
    info('');
    info(`  ${dim(`shutting down (${reason})`)}`);
    await stopEverything({ quiet: false });
    process.exit(EXIT.ok);
  };

  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('closed'));
  if (IS_WINDOWS) {
    process.on('SIGBREAK', () => void shutdown('Ctrl+Break'));
  }

  info(`  ${dim('supervising: stopping a component restarts it; Ctrl+C shuts everything down')}`);
  info('');

  while (!stopping) {
    await sleep(3000);
    if (stopping) {
      break;
    }

    const running = COMPONENTS.filter((name) => runningComponent(name));
    const expected = COMPONENTS.filter((name) => {
      if (name === 'machine-learning') {
        return settings.machineLearning.enabled !== false && existsSync(RUNTIME.mlPython) && existsSync(path.join(RUNTIME.mlSource, 'packages', 'uvicorn'));
      }

      return true;
    });

    const missing = expected.filter((name) => !running.includes(name));
    if (missing.length === 0) {
      failures = 0;
      continue;
    }

    failures += 1;
    const backoff = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
    fail(`${missing.join(', ')} stopped unexpectedly, restarting in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
    if (stopping) {
      break;
    }

    try {
      const current = currentPorts(settings);
      if (missing.includes('postgres')) {
        current.database = (await startPostgres(settings, current, {})).port;
      }

      const redis = missing.includes('redis') ? await startRedis(settings, current, {}) : undefined;
      if (redis) {
        current.redis = redis.port;
      }

      const ml = missing.includes('machine-learning') ? await startMachineLearning(settings, current, {}) : undefined;
      if (ml) {
        current.ml = ml.port;
      }

      if (missing.includes('server')) {
        current.server = (await startServer(settings, current, {})).port;
      }

      info(`  ${ok('recovered')} ${missing.join(', ')}`);
    } catch (error) {
      fail(`restart failed: ${error.message}`);
    }
  }

  return EXIT.ok;
}

// Re-launches this executable with "start --foreground" in its own process group, so the
// supervisor outlives the console that started it.
function launchDetached(options) {
  ensureHome();
  const args = ['start', '--foreground'];
  if (options.noBrowser) {
    args.push('--no-browser');
  }

  if (options.port) {
    args.push('--port', String(options.port));
  }

  const command = isSingleExecutable() ? process.execPath : path.join(ROOT, 'Immich.exe');
  if (!existsSync(command)) {
    fail('Immich.exe is missing; start with Immich.bat instead');
    return EXIT.notInstalled;
  }

  mkdirSync(PATHS.logs, { recursive: true });
  const log = path.join(PATHS.logs, 'supervisor.log');
  const stream = createWriteStream(log, { flags: 'a' });
  stream.write(`\n===== ${nowIso()} ${command} ${args.join(' ')}\n`);
  const child = spawn(command, args, {
    cwd: ROOT,
    env: baseEnvironment(),
    detached: true,
    stdio: ['ignore', stream.fd ?? 'ignore', stream.fd ?? 'ignore'],
    windowsHide: true,
  });
  child.unref();
  writeJson(path.join(PATHS.state, 'supervisor.json'), { pid: child.pid, startedAt: nowIso(), args });

  info(`  ${ok('starting in the background')} ${dim(`supervisor pid ${child.pid}`)}`);
  info(`  ${dim('logs')} ${log}`);
  info(`  ${dim('stop')} ${CLI_PREFIX}.exe stop`);
  return EXIT.ok;
}

async function commandStart(options) {
  ensureHome();
  const settings = loadSettings();
  if (options.port) {
    settings.port = options.port;
  }

  loadSecrets(settings);

  const already = COMPONENTS.map((name) => [name, runningComponent(name)]).filter(([, entry]) => entry);
  if (already.length > 0 && !options.force) {
    const [name, entry] = already[0];
    info(`${warn('already running')} ${name} (pid ${entry.pid})`);
    if (options.json) {
      info(JSON.stringify({ alreadyRunning: true, component: name, pid: entry.pid }, undefined, 2));
    }

    if (name === 'server') {
      printRunning(settings, currentPorts(settings));
    }

    return EXIT.alreadyRunning;
  }

  if (already.length > 0 && options.force) {
    await stopEverything({ quiet: true });
  }

  if (options.detached) {
    return launchDetached(options);
  }

  const code = await startEverything(options);
  if (options.json) {
    const ports = currentPorts(settings);
    info(JSON.stringify({ started: code === EXIT.ok, code, url: code === EXIT.ok ? serverUrl(settings, ports) : null }, undefined, 2));
  }

  // In a console the launcher stays as the supervisor, so closing the window cannot orphan
  // PostgreSQL mid-write. Scripts that need it to return use --detached.
  if (code !== EXIT.ok || !options.foreground) {
    return code;
  }

  return supervise(options, settings, currentPorts(settings));
}

async function commandStop(options) {
  ensureHome();
  const code = await stopEverything({ quiet: options.quiet || options.json });
  if (options.json) {
    const remaining = COMPONENTS.filter((name) => runningComponent(name));
    info(JSON.stringify({ stopped: remaining.length === 0, remaining }, undefined, 2));
  }

  return code;
}

async function commandRestart(options) {
  await stopEverything({ quiet: true });
  return commandStart({ ...options, force: true });
}

async function commandOpen(options) {
  ensureHome();
  const settings = loadSettings();
  const running = runningComponent('server');

  if (!running) {
    const code = await startEverything({ noBrowser: true });
    if (code !== EXIT.ok) {
      return code;
    }
  }

  const ports = currentPorts(settings);
  const url = serverUrl(settings, ports);
  openUrl(url);
  info(url);
  return EXIT.ok;
}

async function commandLogs(options) {
  const name = options.component || 'server';
  const file = path.join(PATHS.logs, `${name}.log`);
  const count = options.lines || 60;

  info(bold(`  ${file}`));
  if (!existsSync(file)) {
    info(`  ${warn('no log yet')} — start Immich first`);
    return EXIT.ok;
  }

  if (options.follow) {
    const { spawn: spawnChild } = require('node:child_process');
    const follower = IS_WINDOWS
      ? spawnChild('powershell.exe', ['-NoProfile', '-Command', `Get-Content -Wait -Tail ${count} -LiteralPath '${file.replaceAll("'", "''")}'`], { stdio: 'inherit' })
      : spawnChild('tail', ['-n', String(count), '-f', file], { stdio: 'inherit' });
    return new Promise((resolve) => follower.on('exit', () => resolve(EXIT.ok)));
  }

  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  info(lines.slice(-count).join('\n'));
  return EXIT.ok;
}

async function commandVersion(options) {
  const info0 = {
    product: PRODUCT,
    title: PRODUCT_TITLE,
    immich: productVersion(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    postgres: postgresVersion(),
    ffmpeg: toolVersion(tool(RUNTIME.ffmpeg, 'ffmpeg'), ['-version']).slice(0, 40),
    exiftool: toolVersion(tool(RUNTIME.exiftool, 'exiftool'), ['-ver']),
    root: ROOT,
    home: HOME,
    // whether this process is the packed Immich.exe or launcher.cjs under node
    singleExecutable: isSingleExecutable(),
    launcher: __filename,
  };

  if (options.json) {
    info(JSON.stringify(info0, undefined, 2));
    return EXIT.ok;
  }

  info(bold(`  ${PRODUCT_TITLE}`));
  info(`  ${dim('immich')}    ${info0.immich}`);
  info(`  ${dim('node')}      ${info0.node} ${dim(`(${info0.platform})`)}`);
  info(`  ${dim('launcher')}  ${dim(IS_SEA ? 'packed into Immich.exe' : __filename)}`);
  info(`  ${dim('postgres')}  ${info0.postgres}`);
  info(`  ${dim('ffmpeg')}    ${info0.ffmpeg}`);
  info(`  ${dim('exiftool')}  ${info0.exiftool}`);
  info(`  ${dim('install')}   ${info0.root}`);
  info(`  ${dim('data')}      ${info0.home}`);
  return EXIT.ok;
}

function parseSettingValue(raw) {
  if (raw === 'true' || raw === 'false') {
    return raw === 'true';
  }

  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

function getSetting(settings, dottedKey) {
  return dottedKey.split('.').reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), settings);
}

function planChange(settings, dottedKey, rawValue) {
  const known = getSetting(settings, dottedKey);
  if (known === undefined) {
    return { error: `unknown setting '${dottedKey}'` };
  }

  const value = parseSettingValue(rawValue);
  const changes = [];

  if (dottedKey === 'bind') {
    if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(String(value))) {
      return { error: "bind must be '127.0.0.1' (this PC only) or '0.0.0.0' (your network)" };
    }

    const firewall = value === '0.0.0.0';
    changes.push({
      target: 'Windows Defender Firewall',
      action: firewall ? 'create' : 'remove',
      name: `Immich4Win (port ${settings.port})`,
      detail: firewall ? `allow inbound TCP ${settings.port} so phones and other computers can reach this PC` : 'remove the inbound rule',
    });
  }

  if (dottedKey === 'port') {
    changes.push({ target: 'Immich server', action: 'listen', detail: `http://127.0.0.1:${value}` });
  }

  if (dottedKey === 'mediaLocation') {
    changes.push({ target: 'storage', action: 'create', detail: path.resolve(String(value)) });
    if (within(settings.mediaLocation, PATHS.data) && !within(path.resolve(String(value)), PATHS.data)) {
      changes.push({
        target: 'storage',
        action: 'warn',
        detail: 'this moves new uploads only — existing files stay in the old folder, use the Immich CLI "immich upload --import" or the library feature to re-link them',
      });
    }
  }

  if (dottedKey === 'machineLearning.enabled') {
    changes.push({ target: 'AI service', action: value ? 'enable' : 'disable', detail: value ? 'smart search, facial recognition and OCR will run' : 'AI features become unavailable' });
  }

  if (dottedKey === 'redis.enabled') {
    changes.push({ target: 'queue', action: value ? 'enable' : 'disable', detail: value ? 'bundled Redis on port 127.0.0.1' : 'jobs fall back to the in-process queue' });
  }

  if (dottedKey === 'server.workers') {
    changes.push({ target: 'Immich workers', action: 'set', detail: Array.isArray(value) ? value.join(', ') : String(value) });
  }

  return { key: dottedKey, from: known, to: value, changes };
}

function printPlan(plan) {
  info('');
  info(bold('  planned changes'));
  for (const change of plan.changes) {
    const glyph = change.action === 'warn' ? warn('!') : change.action === 'remove' ? bad('-') : ok('+');
    info(`    ${glyph} ${change.target}: ${change.action} ${change.detail ? dim(change.detail) : ''}`.trimEnd());
    if (change.name) {
      info(`      ${dim(change.name)}`);
    }
  }

  info('');
}

function applyFirewall(settings) {
  const port = settings.port;
  const name = 'Immich4Win';
  const remoteAddress = settings.bind === '0.0.0.0';
  const netsh = (args) => spawnSync('netsh', args, { encoding: 'utf8', windowsHide: true });

  netsh(['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`, 'dir=in', 'protocol=TCP']);
  if (!remoteAddress) {
    return { applied: true, detail: 'rule removed (PC-only mode)' };
  }

  const result = netsh(['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`]);
  return { applied: result.status === 0, detail: result.status === 0 ? `inbound TCP ${port} allowed` : 'could not change the firewall, run as Administrator' };
}

async function commandConfig(options) {
  ensureHome();
  const settings = loadSettings();
  loadSecrets(settings);
  const [action, key, ...rest] = options.positionals;

  if (!action || action === 'show' || action === 'list') {
    if (options.json) {
      info(JSON.stringify({ file: PATHS.settings, settings: settingsForDisplay(settings) }, undefined, 2));
    } else {
      info(bold(`  ${PATHS.settings}`));
      info(JSON.stringify(settingsForDisplay(settings), undefined, 2));
    }

    return EXIT.ok;
  }

  if (action === 'path') {
    info(PATHS.settings);
    return EXIT.ok;
  }

  if (action === 'get') {
    if (!key) {
      fail('usage: config get <key>');
      return EXIT.usage;
    }

    const value = getSetting(settings, key);
    info(typeof value === 'object' ? JSON.stringify(value, undefined, 2) : String(value));
    return EXIT.ok;
  }

  if (action === 'set') {
    if (!key || rest.length === 0) {
      fail('usage: config set <key> <value>');
      return EXIT.usage;
    }

    const plan = planChange(settings, key, rest.join(' '));
    if (plan.error) {
      fail(plan.error);
      info(dim(`  try: ${CLI_PREFIX}.exe config show`));
      return EXIT.usage;
    }

    if (plan.changes.length > 0) {
      printPlan(plan);
    }

    const keys = key.split('.');
    const next = deepMerge(settings, {});
    let target = next;
    for (const part of keys.slice(0, -1)) {
      target = target[part];
    }

    target[keys.at(-1)] = plan.to;
    persistSettings(next);

    if (options.yes) {
      if (IS_WINDOWS) {
        const firewall = applyFirewall({ ...next, port: next.port });
        info(`  ${firewall.applied ? ok('firewall') : bad('firewall')} ${firewall.detail}`);
      }
    } else if (plan.changes.some((change) => change.target === 'Windows Defender Firewall')) {
      info(`  ${warn('firewall not changed')} — re-run with --yes to apply it`);
    }

    info('');
    info(`${ok('saved')} ${plan.key}: ${JSON.stringify(plan.from)} -> ${JSON.stringify(plan.to)}`);
    info(dim('  restart Immich for the change to take effect'));
    return EXIT.ok;
  }

  if (action === 'reset') {
    persistSettings(DEFAULT_SETTINGS);
    info(`${ok('reset')} ${PATHS.settings}`);
    return EXIT.ok;
  }

  fail(`unknown config action '${action}'`);
  return EXIT.usage;
}

async function commandSetup(options) {
  ensureHome();
  const settings = loadSettings();
  loadSecrets(settings);

  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  info(bold(`  ${PRODUCT_TITLE} first-run setup`));
  info(dim('  press Enter to accept the value in [brackets]'));
  info('');

  const ask = async (question, current, parse = (value) => value) => {
    const answer = (await rl.question(`  ${question} ${dim(`[${current}]`)}: `)).trim();
    return answer === '' ? current : parse(answer);
  };

  try {
    if (!options.yes) {
      settings.mediaLocation = path.resolve(await ask('Library folder for photos and videos', settings.mediaLocation));
      settings.port = await ask('Web port', settings.port, Number);
      settings.bind = await ask('Listening address: 127.0.0.1 (this PC only) or 0.0.0.0 (whole network)', settings.bind);
      settings.machineLearning.enabled = await ask('Enable AI features (smart search, faces, OCR) true/false', settings.machineLearning.enabled, (value) => value === 'true');
      settings.openBrowserOnStart = await ask('Open the browser after start true/false', settings.openBrowserOnStart, (value) => value === 'true');
    }

    mkdirSync(settings.mediaLocation, { recursive: true });
    persistSettings(settings);
    info('');
    info(`${ok('saved')} ${PATHS.settings}`);
    info(`  ${dim('next')} ${CLI_PREFIX}.exe doctor   then   ${CLI_PREFIX}.exe start`);
    return EXIT.ok;
  } finally {
    rl.close();
  }
}

function backupFileName() {
  const stamp = new Date().toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '');
  const major = (postgresVersion().match(/(\d+)\./) || [])[1] || '18';
  return `immich-db-backup-${stamp}-v${productVersion()}-pg${major}.sql.gz`;
}

async function commandBackup(options) {
  ensureHome();
  const settings = loadSettings();
  loadSecrets(settings);
  const [action = 'create', target] = options.positionals;
  mkdirSync(PATHS.backups, { recursive: true });

  if (action === 'list') {
    const files = existsSync(PATHS.backups) ? readdirSync(PATHS.backups).filter((file) => file.endsWith('.sql.gz')).toSorted().toReversed() : [];
    if (files.length === 0) {
      info(`  ${warn('no database backups yet')}`);
      return EXIT.ok;
    }

    for (const file of files) {
      const size = (statSync(path.join(PATHS.backups, file)).size / 1024 ** 2).toFixed(1);
      info(`  ${size.padStart(9)} MB  ${file}`);
    }

    return EXIT.ok;
  }

  const running = runningComponent('postgres');
  if (!running) {
    fail('the database is not running — start Immich first');
    return EXIT.unhealthy;
  }

  const env = toolEnvironment();
  env.PGPASSWORD = settings.database.password;
  const connection = ['-h', '127.0.0.1', '-p', String(running.port), '-U', settings.database.user, '-d', settings.database.name];

  if (action === 'create') {
    const file = path.join(PATHS.backups, target && target.endsWith('.sql.gz') ? target : backupFileName());
    const dump = spawn(tool(RUNTIME.postgres, 'pg_dump'), [...connection, '--clean', '--if-exists', '--no-owner'], { env, windowsHide: true });
    let stderr = '';
    dump.stderr.on('data', (chunk) => (stderr += chunk));

    try {
      await pipeline(dump.stdout, createGzip({ level: 6 }), createWriteStream(file));
    } catch (error) {
      fail(`backup failed: ${error.message} ${stderr.slice(0, 400)}`);
      return EXIT.startFailed;
    }

    const exitCode = await new Promise((resolve) => dump.on('exit', resolve));
    if (exitCode !== 0) {
      fail(`pg_dump failed: ${stderr.slice(0, 600)}`);
      return EXIT.startFailed;
    }

    info(`${ok('backup created')} ${file}`);
    info(dim(`  ${(statSync(file).size / 1024 ** 2).toFixed(1)} MB — visible in Immich under Administration > Backups`));
    return EXIT.ok;
  }

  if (action === 'restore') {
    if (!target) {
      fail('usage: backup restore <file.sql.gz> [--yes]');
      return EXIT.usage;
    }

    const file = path.isAbsolute(target) ? target : path.join(PATHS.backups, target);
    if (!existsSync(file)) {
      fail(`backup not found: ${file}`);
      return EXIT.usage;
    }

    if (!options.yes) {
      info(bold('  this replaces the current database contents'));
      info(`  ${dim('source')} ${file}`);
      info(`  ${dim('target')} ${settings.database.name} on 127.0.0.1:${running.port}`);
      info('');
      info(`  re-run with ${bold('--yes')} to restore`);
      return EXIT.ok;
    }

    const psqlProcess = spawn(
      tool(RUNTIME.postgres, 'psql'),
      [...connection, '--single-transaction', '-v', 'ON_ERROR_STOP=on', '-q'],
      { env, windowsHide: true },
    );

    let stderr = '';
    psqlProcess.stderr.on('data', (chunk) => (stderr += chunk));

    const feed = pipeline(createReadStream(file), createGunzip(), psqlProcess.stdin).catch((error) => {
      stderr += error.message;
    });

    const exitCode = await new Promise((resolve) => psqlProcess.on('exit', resolve));
    await feed;

    if (exitCode !== 0) {
      fail(`restore failed: ${stderr.slice(0, 800)}`);
      return EXIT.startFailed;
    }

    info(`${ok('restore complete')} — restart Immich so every worker reloads the restored data`);
    return EXIT.ok;
  }

  fail(`unknown backup action '${action}' — use create, list or restore`);
  return EXIT.usage;
}

function runNodeScript(main, argv, extraEnv) {
  const node = resolveNodeRuntime() ?? process.execPath;
  const child = spawn(node, [main, ...argv], { stdio: 'inherit', env: { ...toolEnvironment(), ...extraEnv }, windowsHide: false });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? EXIT.internal)));
}

async function commandAdmin(options) {
  const payload = serverPayload();
  if (!payload) {
    fail('the Immich server payload is missing — re-run install.ps1');
    return EXIT.notInstalled;
  }

  const settings = loadSettings();
  loadSecrets(settings);
  return runNodeScript(payload.main, ['immich-admin', ...options.positionals], serverEnvironment(settings, currentPorts(settings)));
}

async function commandCli(options) {
  const candidate = [RUNTIME.cli, path.join(ROOT, 'packages', 'cli', 'dist', 'index.js'), path.join(ROOT, 'packages', 'cli', 'bin', 'immich')].find((file) =>
    existsSync(file),
  );

  if (!candidate) {
    fail('the Immich CLI is not part of this build');
    info(dim('  install it with: npm install -g @immich/cli'));
    return EXIT.notInstalled;
  }

  const settings = loadSettings();
  return runNodeScript(candidate, options.positionals, { IMMICH_INSTANCE_URL: serverUrl(settings, currentPorts(settings)) });
}


// The files immich-app/base-images puts in /build/geodata (stage "geodata").
const GEODATA_SOURCES = [
  { url: 'https://download.geonames.org/export/dump/cities500.zip', file: 'cities500.zip', zip: true },
  { url: 'https://download.geonames.org/export/dump/admin1CodesASCII.txt', file: 'admin1CodesASCII.txt' },
  { url: 'https://download.geonames.org/export/dump/admin2Codes.txt', file: 'admin2Codes.txt' },
  { url: 'https://download.geonames.org/export/dump/countryInfo.txt', file: 'countryInfo.txt' },
  {
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson',
    file: 'ne_10m_admin_0_countries.geojson',
  },
];

const GEODATA_REQUIRED = ['cities500.txt', 'admin1CodesASCII.txt', 'admin2Codes.txt', 'countryInfo.txt', 'ne_10m_admin_0_countries.geojson'];

// Minimal zip reader: the geonames archive is a plain deflate zip, so stored and deflated entries
// are enough and the launcher stays free of third party dependencies.
function extractZip(archive, destination) {
  const buffer = readFileSync(archive);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= 0 && offset > buffer.length - 66_000; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06_05_4b_50) {
      end = offset;
      break;
    }
  }

  if (end === -1) {
    return false;
  }

  const entries = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index++) {
    if (buffer.readUInt32LE(pointer) !== 0x02_01_4b_50) {
      return false;
    }

    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) {
      continue;
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(start, start + compressedSize);
    writeFileSync(path.join(destination, path.basename(name)), method === 0 ? payload : inflateRawSync(payload));
  }

  return true;
}

async function downloadGeodata(root, options) {
  const destination = root ?? RUNTIME.geodata;
  mkdirSync(destination, { recursive: true });
  const staging = path.join(PATHS.state, 'geodata-cache');
  mkdirSync(staging, { recursive: true });

  info(`  ${dim('downloading place names into')} ${destination}`);
  for (const source of GEODATA_SOURCES) {
    const archive = path.join(staging, source.file);
    if (!existsSync(archive) || options.force) {
      info(`  ${dim('fetching')} ${source.url}`);
      const result = await downloadFile(source.url, archive);
      if (!result.ok) {
        fail(`download failed (${result.error ?? `HTTP ${result.status}`}): ${source.url}`);
        return EXIT.startFailed;
      }
    }

    if (source.zip) {
      if (!extractZip(archive, destination)) {
        fail(`could not unpack ${source.file}`);
        return EXIT.startFailed;
      }
    } else {
      copyFileSync(archive, path.join(destination, source.file));
    }

    info(`  ${ok(source.zip ? 'unpacked' : 'saved')} ${source.file}`);
  }

  // Immich compares this marker with the value in the database to decide whether to re-import
  writeFileSync(path.join(destination, 'geodata-date.txt'), new Date().toISOString());

  const missing = GEODATA_REQUIRED.filter((file) => !existsSync(path.join(destination, file)));
  if (missing.length > 0) {
    fail(`geodata is incomplete, missing: ${missing.join(', ')}`);
    return EXIT.startFailed;
  }

  const total = GEODATA_REQUIRED.reduce((sum, file) => sum + statSync(path.join(destination, file)).size, 0);
  info(`  ${ok('geodata ready')} ${(total / 1024 ** 2).toFixed(1)} MB`);
  info(`  ${dim('restart Immich to import it; the first import takes a minute or two')}`);
  return EXIT.ok;
}

async function commandGeodata(options) {
  const [action = 'status'] = options.positionals;
  const root = geodataRoot();

  if (action === 'status') {
    if (!root) {
      info(`  ${warn('not downloaded')} — reverse geocoding and place search stay empty`);
      info(`  ${dim('download with')} ${CLI_PREFIX}.exe geodata download`);
      return EXIT.ok;
    }

    info(`  ${ok('present')} ${root}`);
    for (const file of ['cities500.txt', 'admin1CodesASCII.txt', 'admin2Codes.txt', 'countryInfo.txt', 'ne_10m_admin_0_countries.geojson', 'geodata-date.txt']) {
      const full = path.join(root, file);
      const size = existsSync(full) ? `${(statSync(full).size / 1024 ** 2).toFixed(1)} MB` : 'missing';
      info(`  ${existsSync(full) ? ok('ok  ') : warn('miss')} ${file.padEnd(36)} ${dim(size)}`);
    }

    return EXIT.ok;
  }

  if (action === 'download') {
    return downloadGeodata(root, options);
  }

  fail(`unknown geodata action '${action}' — use status or download`);
  return EXIT.usage;
}

async function commandService(options) {
  const [action = 'status'] = options.positionals;
  const script = scriptPath('service.ps1');
  if (!existsSync(script)) {
    fail(`service helper not found: ${script}`);
    return EXIT.notInstalled;
  }

  // the CLI speaks install/uninstall, the PowerShell helper registers/removes the task
  const mapped = { uninstall: 'remove', delete: 'remove' }[action] ?? action;
  if (!['install', 'remove', 'status', 'start', 'stop'].includes(mapped)) {
    fail(`unknown service action '${action}' (use install, uninstall, status, start or stop)`);
    return EXIT.usage;
  }

  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', mapped], {
    stdio: 'inherit',
    windowsHide: false,
  });
  return result.status ?? EXIT.internal;
}

async function commandInstall(options) {
  const script = scriptPath('install.ps1');
  if (!existsSync(script)) {
    fail(`installer not found: ${script}`);
    return EXIT.notInstalled;
  }

  const scriptArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (options.force) {
    scriptArgs.push('-Force');
  }

  if (options.positionals.length > 0) {
    scriptArgs.push(...options.positionals);
  }

  const result = spawnSync('powershell.exe', scriptArgs, { stdio: 'inherit', windowsHide: false, cwd: ROOT });
  return result.status ?? EXIT.internal;
}

async function commandUninstall(options) {
  const script = scriptPath('uninstall.ps1');
  if (!existsSync(script)) {
    fail(`uninstaller not found: ${script}`);
    return EXIT.notInstalled;
  }

  const scriptArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (options.yes) {
    scriptArgs.push('-Yes');
  }

  for (const positional of options.positionals) {
    if (positional === '--data' || positional === '--remove-data') {
      scriptArgs.push('-RemoveData');
    }
  }

  const result = spawnSync('powershell.exe', scriptArgs, { stdio: 'inherit', windowsHide: false, cwd: ROOT });
  return result.status ?? EXIT.internal;
}

async function commandUrl() {
  const settings = loadSettings();
  const ports = currentPorts(settings);
  if (!runningComponent('server')) {
    fail('Immich is not running');
    return EXIT.unhealthy;
  }

  info(serverUrl(settings, ports));
  return EXIT.ok;
}

function usage() {
  info(`${bold(PRODUCT_TITLE)}  ${dim(`immich ${productVersion()}`)}`);
  info('');
  info(`${bold('usage')}  ${CLI_PREFIX}.exe <command> [options]`);
  info('');
  info(`${bold('run')}`);
  info(`  start [--force] [--no-browser]   start database, queue, AI and the web server`);
  info(`  stop                             stop everything cleanly`);
  info(`  restart                          stop, then start`);
  info(`  status [--json]                  what is running, on which port`);
  info(`  open                             open the web app (starts Immich if needed)`);
  info(`  logs [component] [--lines N] [--follow]`);
  info('');
  info(`${bold('care')}`);
  info(`  doctor [--json]                  check every dependency and setting`);
  info(`  backup create|list|restore       database backups (pg_dump, no Docker)`);
  info(`  geodata [status|download]        place names for reverse geocoding`);
  info(`  admin <args>                     immich-admin (reset-admin-password, list-users, ...)`);
  info(`  cli <args>                       Immich CLI (upload, import)`);
  info('');
  info(`${bold('configure')}`);
  info(`  setup                            first-run wizard`);
  info(`  config [show]                    print the configuration`);
  info(`  config set <key> <value> [--yes] preview, then apply a change`);
  info(`  config get <key>                 read one value`);
  info(`  service install|uninstall|status start Immich at Windows logon`);
  info(`  uninstall [--data] [--yes]       remove Immich4Win (--data also deletes your photos)`);
  info(`  version [--json]                 component versions`);
  info('');
  info(`${bold('examples')}`);
  info(`  ${dim(`${CLI_PREFIX}.exe start`)}`);
  info(`  ${dim(`${CLI_PREFIX}.exe config set mediaLocation "D:\\Photos\\Immich" --yes`)}`);
  info(`  ${dim(`${CLI_PREFIX}.exe config set bind 0.0.0.0 --yes`)}`);
  info(`  ${dim(`${CLI_PREFIX}.exe backup create`)}`);
  info('');
}

function parseArguments(argv) {
  const positionals = [];
  const flags = new Set();
  const values = {};
  const valueFlags = new Set(['lines', 'component']);

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (argument.startsWith('--')) {
      const [key, inline] = argument.slice(2).split('=');
      if (inline !== undefined) {
        values[key] = inline;
      } else if (valueFlags.has(key) && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        values[key] = argv[++index];
      } else {
        flags.add(key);
      }

      continue;
    }

    positionals.push(argument);
  }

  return { positionals, flags, values };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const command = parsed.positionals.shift() ?? 'help';
  const options = {
    positionals: parsed.positionals,
    flags: parsed.flags,
    json: parsed.flags.has('json'),
    yes: parsed.flags.has('yes'),
    force: parsed.flags.has('force'),
    quiet: parsed.flags.has('quiet'),
    dryRun: parsed.flags.has('dry-run'),
    follow: parsed.flags.has('follow'),
    noBrowser: parsed.flags.has('no-browser'),
    detached: parsed.flags.has('detached'),
    foreground: parsed.flags.has('foreground'),
    port: parsed.values.port ? Number(parsed.values.port) : undefined,
    component: parsed.values.component,
    lines: parsed.values.lines ? Number(parsed.values.lines) : undefined,
  };

  switch (command) {
    case 'start': {
      return commandStart(options);
    }

    case 'stop': {
      return commandStop(options);
    }

    case 'restart': {
      return commandRestart(options);
    }

    case 'status': {
      return commandStatus(options);
    }

    case 'open': {
      return commandOpen(options);
    }

    case 'logs': {
      return commandLogs({ ...options, component: options.component || options.positionals[0] });
    }

    case 'doctor': {
      return commandDoctor(options);
    }

    case 'backup': {
      return commandBackup(options);
    }

    case 'admin': {
      return commandAdmin(options);
    }

    case 'cli': {
      return commandCli(options);
    }

    case 'geodata': {
      return commandGeodata(options);
    }

    case 'config': {
      return commandConfig(options);
    }

    case 'setup': {
      return commandSetup(options);
    }

    case 'service': {
      return commandService(options);
    }

    case 'url': {
      return commandUrl();
    }

    case 'install': {
      return commandInstall(options);
    }

    case 'uninstall': {
      return commandUninstall(options);
    }

    case 'version':
    case '--version':
    case '-v': {
      return commandVersion(options);
    }

    case 'help':
    case '--help':
    case '-h': {
      usage();
      return EXIT.ok;
    }

    default: {
      fail(`unknown command '${command}'`);
      info('');
      usage();
      return EXIT.usage;
    }
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code ?? EXIT.ok))
    .catch((error) => {
      fail(error?.message ?? String(error));
      if (process.env.IMMICH4WIN_DEBUG) {
        console.error(error);
      }

      log(`unhandled: ${error?.stack ?? error}`);
      process.exit(EXIT.internal);
    });
}

module.exports = { main, parseArguments, deepMerge, DEFAULT_SETTINGS };
