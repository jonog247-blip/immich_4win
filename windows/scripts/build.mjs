#!/usr/bin/env node
'use strict';

/*
  Assembles the portable Windows 11 build in dist/immich4win.

  Every stage is independent and records what it did, so a build can run on any host and be finished
  on Windows: whatever could not be downloaded here (GitHub release assets are often blocked on CI
  machines and sandboxes) is listed at the end together with the install.ps1 step that fetches it.

    node windows/scripts/build.mjs                 full build
    node windows/scripts/build.mjs --skip-binaries skip PostgreSQL, Redis, FFmpeg, ExifTool
    node windows/scripts/build.mjs --skip-ml       leave the machine learning service out
    node windows/scripts/build.mjs --force-ml      reinstall the Python packages
*/

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const windowsRoot = resolve(here, '..');
const outDir = resolve(repoRoot, 'dist', 'immich4win');
const cacheDir = join(repoRoot, '.build', 'cache');

const toolchain = JSON.parse(readFileSync(join(windowsRoot, 'toolchain.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);

const runtimePaths = {
  node: join(outDir, 'runtime', 'node'),
  postgres: join(outDir, 'runtime', 'postgres'),
  redis: join(outDir, 'runtime', 'redis'),
  ffmpeg: join(outDir, 'runtime', 'ffmpeg'),
  exiftool: join(outDir, 'runtime', 'exiftool'),
  python: join(outDir, 'runtime', 'python'),
  ml: join(outDir, 'runtime', 'ml'),
  build: join(outDir, 'runtime', 'build'),
  cli: join(outDir, 'runtime', 'cli'),
  tools: join(outDir, 'build-tools'),
};

const report = [];

function step(message) {
  console.log(`\n==> ${message}`);
}

function note(message) {
  console.log(`    ${message}`);
}

function skipped(component, reason) {
  report.push({ component, status: 'skipped', reason });
  note(`skipped (${reason})`);
}

function staged(component, detail) {
  report.push({ component, status: 'ok', detail });
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: platform() === 'win32', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
  }

  return result;
}

// curl survives proxies, redirects and flaky links far better than fetch, and is present on Windows
// 10 1803 and later as well as on every build host
function download(url, destination, { optional = false } = {}) {
  if (existsSync(destination) && statSync(destination).size > 0) {
    note(`cached ${destination.slice(destination.indexOf('.build'))}`);
    return destination;
  }

  mkdirSync(dirname(destination), { recursive: true });
  const result = spawnSync('curl', ['-fL', '--retry', '4', '--retry-all-errors', '--connect-timeout', '30', '--max-time', '3600', '-o', destination, url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (result.status !== 0) {
    rmSync(destination, { force: true });
    if (optional) {
      note(`not available: ${url}`);
      return undefined;
    }

    throw new Error(`download failed: ${url}`);
  }

  return destination;
}

function releaseUrl(repository, tag, asset) {
  return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
}

function extract(archive, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  if (/\.(tar\.gz|tgz)$/i.test(archive)) {
    // tar.exe ships with Windows 10 1803 and later, so one call works on both hosts
    run('tar', ['-xzf', archive, '-C', destination]);
    return destination;
  }

  if (platform() === 'win32') {
    run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`]);
    return destination;
  }

  run('unzip', ['-q', '-o', archive, '-d', destination]);
  return destination;
}

function findFirst(root, matcher, depth = 5) {
  if (!existsSync(root)) {
    return undefined;
  }

  const queue = [{ dir: root, level: 0 }];
  while (queue.length > 0) {
    const { dir, level } = queue.shift();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (matcher(entry.name, full, entry)) {
        return full;
      }

      if (entry.isDirectory() && level < depth) {
        queue.push({ dir: full, level: level + 1 });
      }
    }
  }

  return undefined;
}

function copyTree(from, to, options = {}) {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, force: true, ...options });
}

function dirSize(target) {
  let total = 0;
  const queue = [target];
  while (queue.length > 0) {
    const dir = queue.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else {
        total += statSync(full).size;
      }
    }
  }

  return total;
}

function copyLaunchers() {
  step('launchers and scripts');
  for (const file of ['Setup.bat', 'Immich.bat', 'Start-Immich.bat', 'Stop-Immich.bat', 'Status.bat', 'Doctor.bat']) {
    copyFileSyncSafe(join(windowsRoot, file), join(outDir, file));
  }

  mkdirSync(join(outDir, 'scripts'), { recursive: true });
  for (const file of ['install.ps1', 'install-ml.ps1', 'install-geodata.ps1', 'service.ps1', 'set-exe-metadata.ps1', 'uninstall.ps1']) {
    const source = join(windowsRoot, 'scripts', file);
    if (existsSync(source)) {
      copyFileSyncSafe(source, join(outDir, 'scripts', file));
    }
  }

  copyFileSyncSafe(join(repoRoot, 'LICENSE'), join(outDir, 'LICENSE'));
  for (const file of ['README.md', 'THIRD-PARTY-NOTICES.md']) {
    const source = join(windowsRoot, 'docs', file);
    if (existsSync(source)) {
      copyFileSyncSafe(source, join(outDir, file));
    }
  }

  note('Immich.exe is built by make-exe.mjs; the .bat files call it');
}

async function stageNode() {
  step(`Node ${toolchain.node.version} runtime`);
  const name = toolchain.node.package;
  const tarball = await download(
    `https://registry.npmjs.org/${name}/-/${name}-${toolchain.node.version}.tgz`,
    join(cacheDir, 'node', `${name}-${toolchain.node.version}.tgz`),
  );

  const unpacked = join(cacheDir, 'node', 'unpacked');
  extract(tarball, unpacked);
  const declared = join(unpacked, 'package', toolchain.node.path ?? 'node.exe');
  const binary = existsSync(declared) ? declared : findFirst(unpacked, (file) => file === 'node.exe');
  if (!binary) {
    throw new Error('the Node.js package has no node.exe');
  }

  rmSync(runtimePaths.node, { recursive: true, force: true });
  mkdirSync(runtimePaths.node, { recursive: true });
  copyTree(dirname(binary), runtimePaths.node);
  note(`${(statSync(join(runtimePaths.node, 'node.exe')).size / 1024 ** 2).toFixed(0)} MB`);
  staged('node', toolchain.node.version);
}

async function stagePostgres() {
  step(`PostgreSQL ${toolchain.postgres.version}`);
  const asset = toolchain.postgres.asset.replace('{version}', toolchain.postgres.version);
  const archive = await download(releaseUrl(toolchain.postgres.repository, toolchain.postgres.version, asset), join(cacheDir, 'postgres', asset), {
    optional: true,
  });

  if (!archive) {
    skipped('postgres', 'release asset not reachable here, install.ps1 fetches it on Windows');
    return;
  }

  const unpacked = join(cacheDir, 'postgres', 'unpacked');
  extract(archive, unpacked);

  // the archives unpack to postgresql-<version>-<target>/ holding bin, lib and share
  const home = findFirst(unpacked, (file, full, entry) => entry.isDirectory() && existsSync(join(full, 'bin', 'postgres.exe')), 3);
  if (!home) {
    throw new Error('the PostgreSQL archive has no bin/postgres.exe');
  }

  rmSync(runtimePaths.postgres, { recursive: true, force: true });
  copyTree(home, runtimePaths.postgres);

  const required = ['psql.exe', 'pg_dump.exe', 'pg_dumpall.exe', 'pg_restore.exe'];
  const missing = required.filter((file) => !existsSync(join(runtimePaths.postgres, 'bin', file)));
  if (missing.length > 0) {
    // without the client tools Immich cannot back up or restore its own database
    throw new Error(`the PostgreSQL archive is missing ${missing.join(', ')}`);
  }

  note(`server + client tools (${required.join(', ')}) and contrib extensions`);
  staged('postgres', toolchain.postgres.version);

  await stagePgvector();
}

async function stagePgvector() {
  step('pgvector');
  const pgMajor = toolchain.postgres.version.split('.')[0];
  const version = toolchain.pgvector.version.replace(/^v/, '');
  const asset = toolchain.pgvector.asset.replace('{version}', version).replace('{pgMajor}', pgMajor);
  const zip = await download(releaseUrl(toolchain.pgvector.repository, toolchain.pgvector.version, asset), join(cacheDir, 'pgvector', asset), {
    optional: true,
  });

  if (!zip) {
    skipped('pgvector', 'release asset not reachable here, install.ps1 fetches it on Windows');
    return;
  }

  const extracted = join(cacheDir, 'pgvector', `pg${pgMajor}`);
  extract(zip, extracted);
  const control = findFirst(extracted, (file) => file === 'vector.control');
  const library = findFirst(extracted, (file) => file === 'vector.dll');
  if (!control || !library) {
    skipped('pgvector', 'the package has no vector.control/vector.dll');
    return;
  }

  // PostgreSQL reads extensions from share/extension (and lib/, or share/postgresql/extension/lib/postgresql)
  const shareTargets = [join(runtimePaths.postgres, 'share', 'extension'), join(runtimePaths.postgres, 'share', 'postgresql', 'extension')].filter(
    (target) => existsSync(dirname(target)),
  );
  for (const target of shareTargets) {
    mkdirSync(target, { recursive: true });
    for (const file of readdirSync(dirname(control))) {
      if (file.startsWith('vector')) {
        copyFileSyncSafe(join(dirname(control), file), join(target, file));
      }
    }
  }

  const libTargets = [join(runtimePaths.postgres, 'lib'), join(runtimePaths.postgres, 'lib', 'postgresql')].filter((target) => existsSync(dirname(target)));
  for (const target of libTargets) {
    mkdirSync(target, { recursive: true });
    copyFileSyncSafe(library, join(target, 'vector.dll'));
  }

  writeFileSync(join(runtimePaths.postgres, 'IMMICH4WIN-PGVECTOR'), `pgvector ${version}\nPostgreSQL ${pgMajor}\n`);
  note(`pgvector ${version} for PostgreSQL ${pgMajor}`);
  staged('pgvector', version);
}

async function stageRedis() {
  step(`Redis ${toolchain.redis.version}`);
  const asset = toolchain.redis.asset.replace('{version}', toolchain.redis.version);
  const zip = await download(releaseUrl(toolchain.redis.repository, toolchain.redis.version, asset), join(cacheDir, 'redis', asset), { optional: true });

  if (!zip) {
    skipped('redis', 'release asset not reachable here, install.ps1 fetches it on Windows');
    return;
  }

  const extracted = join(cacheDir, 'redis', 'unpacked');
  extract(zip, extracted);
  const server = findFirst(extracted, (file) => file.toLowerCase() === 'redis-server.exe');
  if (!server) {
    skipped('redis', 'the package has no redis-server.exe');
    return;
  }

  rmSync(runtimePaths.redis, { recursive: true, force: true });
  mkdirSync(runtimePaths.redis, { recursive: true });
  copyTree(dirname(server), runtimePaths.redis);
  note(`redis-server.exe and ${(dirSize(runtimePaths.redis) / 1024 ** 2).toFixed(0)} MB of runtime DLLs`);
  staged('redis', toolchain.redis.version);
}

async function latestRelease(repository, cacheName) {
  // Resolved tags are cached so a rebuild on a machine without GitHub access still works
  const cacheFile = join(cacheDir, cacheName, 'release.json');
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {
      // fall through and fetch again
    }
  }

  const result = spawnSync('curl', ['-fsSL', '--max-time', '60', `https://api.github.com/repos/${repository}/releases/latest`], { encoding: 'utf8' });
  if (result.status !== 0) {
    return undefined;
  }

  try {
    const release = JSON.parse(result.stdout);
    const summary = { tag_name: release.tag_name, assets: (release.assets ?? []).map((asset) => asset.name) };
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(summary, undefined, 2));
    return summary;
  } catch {
    return undefined;
  }
}

function pickAsset(release, pattern, fallback) {
  if (release?.assets) {
    const match = release.assets.find((name) => new RegExp(pattern).test(name));
    if (match) {
      return match;
    }
  }

  return fallback;
}

async function stageFfmpeg() {
  step('FFmpeg');
  const release = await latestRelease(toolchain.ffmpeg.repository, 'ffmpeg');
  // newest n7.1/n8 style build first, "master-latest" only as a fallback: the same files are inside
  const asset = pickAsset(release, toolchain.ffmpeg.assetPattern, toolchain.ffmpeg.fallbackAsset);
  const url = releaseUrl(toolchain.ffmpeg.repository, release?.tag_name ?? 'latest', asset);
  const zip = await download(url, join(cacheDir, 'ffmpeg', asset), { optional: true });
  if (!zip) {
    skipped('ffmpeg', 'release asset not reachable here, install.ps1 fetches it on Windows');
    return;
  }

  const extracted = join(cacheDir, 'ffmpeg', 'unpacked');
  extract(zip, extracted);
  const ffmpeg = findFirst(extracted, (file) => file === 'ffmpeg.exe');
  const ffprobe = findFirst(extracted, (file) => file === 'ffprobe.exe');
  if (!ffmpeg || !ffprobe) {
    skipped('ffmpeg', 'the package has no ffmpeg.exe/ffprobe.exe');
    return;
  }

  rmSync(runtimePaths.ffmpeg, { recursive: true, force: true });
  mkdirSync(join(runtimePaths.ffmpeg, 'bin'), { recursive: true });
  copyFileSyncSafe(ffmpeg, join(runtimePaths.ffmpeg, 'bin', 'ffmpeg.exe'));
  copyFileSyncSafe(ffprobe, join(runtimePaths.ffmpeg, 'bin', 'ffprobe.exe'));
  const license = findFirst(extracted, (file) => /^LICENSE/i.test(file));
  if (license) {
    copyFileSyncSafe(license, join(runtimePaths.ffmpeg, 'LICENSE.txt'));
  }

  note('ffmpeg.exe and ffprobe.exe');
  staged('ffmpeg', release?.tag_name ?? asset);
}

async function stageExiftool() {
  step(`ExifTool ${toolchain.exiftool.version}`);
  // exiftool.org publishes plain zips and no GitHub releases; the 64-bit build has the executable
  // and its support files at the archive root, so no Perl installation is involved
  const asset = `exiftool-${toolchain.exiftool.version}_64.zip`;
  const zip = await download(toolchain.exiftool.url.replace('{version}', toolchain.exiftool.version), join(cacheDir, 'exiftool', asset), {
    optional: true,
  });

  if (!zip) {
    skipped('exiftool', 'exiftool.org is not reachable here, install.ps1 fetches it on Windows');
    return;
  }

  const extracted = join(cacheDir, 'exiftool', 'unpacked');
  extract(zip, extracted);
  const executable = findFirst(extracted, (file) => /^exiftool.*\.exe$/i.test(file));
  if (!executable) {
    skipped('exiftool', 'the package has no exiftool executable');
    return;
  }

  rmSync(runtimePaths.exiftool, { recursive: true, force: true });
  mkdirSync(runtimePaths.exiftool, { recursive: true });
  // the launcher points IMMICH_EXIFTOOL_PATH at exiftool.exe, so the name has to be canonical, and
  // the shipped exiftool(-k).exe wants to be exiftool.exe for the -k behaviour to disappear
  copyFileSyncSafe(executable, join(runtimePaths.exiftool, 'exiftool.exe'));
  for (const entry of readdirSync(dirname(executable))) {
    if (entry !== 'exiftool.exe' && !/\.exe$/i.test(entry)) {
      copyFileSyncSafe(join(dirname(executable), entry), join(runtimePaths.exiftool, entry));
    }
  }

  note('exiftool.exe with exiftool_files/');
  staged('exiftool', toolchain.exiftool.version);
}

async function stagePython() {
  step(`CPython ${toolchain.python.version}`);
  const asset = toolchain.python.asset.replace('{version}', toolchain.python.version).replace('{tag}', toolchain.python.tag);
  const archive = await download(
    releaseUrl('astral-sh/python-build-standalone', toolchain.python.tag, asset),
    join(cacheDir, 'python', asset),
    { optional: true },
  );

  if (!archive) {
    skipped('python', 'release asset not reachable here, install.ps1 fetches it on Windows');
    return;
  }

  const extracted = join(cacheDir, 'python', 'unpacked');
  extract(archive, extracted);
  const home = findFirst(extracted, (file, full, entry) => entry.isDirectory() && file === 'python' && existsSync(join(full, 'python.exe')), 4);
  if (!home) {
    skipped('python', 'the archive has no python.exe');
    return;
  }

  rmSync(runtimePaths.python, { recursive: true, force: true });
  copyTree(home, runtimePaths.python);
  note(`${(dirSize(runtimePaths.python) / 1024 ** 2).toFixed(0)} MB`);
  staged('python', toolchain.python.version);
}

async function stageUv() {
  step(`uv ${toolchain.uv.version}`);
  const zip = await download(releaseUrl(toolchain.uv.repository, toolchain.uv.tag, toolchain.uv.asset), join(cacheDir, 'uv', toolchain.uv.asset), {
    optional: true,
  });

  if (!zip) {
    skipped('uv', 'release asset not reachable here, install.ps1 fetches it on Windows');
    return undefined;
  }

  const extracted = join(cacheDir, 'uv', 'unpacked');
  extract(zip, extracted);
  const executable = findFirst(extracted, (file) => file === 'uv.exe');
  if (!executable) {
    skipped('uv', 'the package has no uv.exe');
    return undefined;
  }

  mkdirSync(runtimePaths.tools, { recursive: true });
  copyFileSyncSafe(executable, join(runtimePaths.tools, 'uv.exe'));
  note('build-tools/uv.exe (used by install-ml.ps1)');
  staged('uv', toolchain.uv.version);
  return join(runtimePaths.tools, 'uv.exe');
}

function buildWeb() {
  step('web client');
  run('corepack', ['pnpm', '--filter', 'immich-web', 'build'], { cwd: repoRoot, env: { ...process.env, NODE_ENV: 'production' } });
  const build = join(repoRoot, 'web', 'build');
  if (!existsSync(join(build, 'index.html'))) {
    throw new Error('the web build produced no index.html');
  }

  rmSync(runtimePaths.build, { recursive: true, force: true });
  copyTree(build, join(runtimePaths.build, 'www'));
  note(`${(dirSize(join(runtimePaths.build, 'www')) / 1024 ** 2).toFixed(0)} MB`);
  staged('web', 'built');
}

// The backup orchestrator needs sqlite; compiling better-sqlite3 on Windows would require a whole
// toolchain, so the module is replaced by a thin wrapper over Node's built in node:sqlite.
function findSqliteCopies(root) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0) {
    const { dir, depth } = queue.pop();
    let resolved;
    try {
      // resolve symlinks as well: the isolated linker stores the real package elsewhere
      resolved = realpathSync(dir);
    } catch {
      continue;
    }

    if (seen.has(resolved) || depth > 8) {
      continue;
    }

    seen.add(resolved);
    let entries;
    try {
      entries = readdirSync(resolved, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(resolved, entry.name);
      const isDirectory = entry.isDirectory() || entry.isSymbolicLink();
      if (!isDirectory) {
        continue;
      }

      if (entry.name === 'better-sqlite3' && existsSync(join(full, 'package.json'))) {
        if (!found.includes(full)) {
          found.push(full);
        }

        continue;
      }

      // node_modules, .pnpm and @scope directories hold the packages
      if (entry.name === 'node_modules' || entry.name === 'pnpm' || entry.name.startsWith('@') || entry.name.startsWith('better-sqlite3@')) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }

  return found;
}

async function buildServer() {
  step('Immich server');
  const serverDir = join(repoRoot, 'server');
  run('corepack', ['pnpm', '--filter', 'immich', 'build'], { cwd: repoRoot, env: { ...process.env, NODE_ENV: 'production' } });

  const deployDir = join(outDir, 'app', 'server');
  rmSync(join(outDir, 'app'), { recursive: true, force: true });
  mkdirSync(deployDir, { recursive: true });

  // --ignore-scripts: better-sqlite3 has no prebuilt binary for every Node version and building it
  // needs Visual Studio, which a user installing Immich does not have
  // A hoisted node_modules is a plain folder tree: the default isolated linker produces symlinks
  // into a store, which cannot travel inside a zip and does not resolve on Windows at all.
  run(
    'corepack',
    ['pnpm', '--filter', 'immich', 'deploy', deployDir, '--prod', '--no-optional', '--ignore-scripts', '--node-linker=hoisted', '--os', 'win32', '--cpu', 'x64'],
    { cwd: repoRoot },
  );

  copyTree(join(serverDir, 'dist'), join(deployDir, 'dist'));
  for (const file of ['package.json', 'tsconfig.json', 'helmet.json']) {
    const source = join(serverDir, file);
    if (existsSync(source)) {
      copyFileSyncSafe(source, join(deployDir, file));
    }
  }

  step('sharp for win32-x64');
  const sharpVersion = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).dependencies.sharp.replace(/^[\^~]/, '');
  const sharpCache = join(cacheDir, 'sharp-win32');
  if (!existsSync(join(sharpCache, 'node_modules', 'sharp'))) {
    mkdirSync(sharpCache, { recursive: true });
    writeFileSync(join(sharpCache, 'package.json'), JSON.stringify({ name: 'sharp-win32', version: '1.0.0', private: true }, undefined, 2));
    run('npm', ['install', `sharp@${sharpVersion}`, '--os=win32', '--cpu=x64', '--ignore-scripts', '--force', '--no-audit', '--no-fund'], {
      cwd: sharpCache,
    });
  }

  // sharp resolves its own copies of detect-libc and @img/colour at runtime
  const sharpModules = join(sharpCache, 'node_modules');
  if (!existsSync(sharpModules)) {
    throw new Error('sharp could not be installed for win32-x64');
  }

  for (const entry of readdirSync(sharpModules)) {
    if (entry === '.package-lock.json') {
      continue;
    }

    const target = join(deployDir, 'node_modules', entry);
    rmSync(target, { recursive: true, force: true });
    copyTree(join(sharpModules, entry), target);
  }

  note(`sharp ${sharpVersion} with @img/sharp-win32-x64`);

  step('bcrypt for win32-x64');
  const bcryptDir = join(deployDir, 'node_modules', 'bcrypt');
  if (existsSync(join(bcryptDir, 'package.json'))) {
    const bcryptVersion = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).dependencies.bcrypt.replace(/^[\^~]/, '');
    const bcryptCache = join(cacheDir, 'bcrypt-win32');
    if (!existsSync(join(bcryptCache, 'node_modules', 'bcrypt', 'prebuilds', 'win32-x64'))) {
      mkdirSync(bcryptCache, { recursive: true });
      writeFileSync(join(bcryptCache, 'package.json'), JSON.stringify({ name: 'bcrypt-win32', version: '1.0.0', private: true }, undefined, 2));
      // the package ships prebuilds/win32-x64/bcrypt.node, an N-API binary that needs no compiler
      run('npm', ['install', `bcrypt@${bcryptVersion}`, '--os=win32', '--cpu=x64', '--ignore-scripts', '--force', '--no-audit', '--no-fund'], {
        cwd: bcryptCache,
      });
    }

    const prebuilt = join(bcryptCache, 'node_modules', 'bcrypt', 'prebuilds', 'win32-x64');
    if (existsSync(prebuilt)) {
      // bcrypt looks for prebuilds/<platform>-<arch>/bcrypt.node next to lib/, so the whole
      // package is taken from the Windows install and dropped over the Linux one
      rmSync(bcryptDir, { recursive: true, force: true });
      copyTree(join(bcryptCache, 'node_modules', 'bcrypt'), bcryptDir);
      note(`bcrypt ${bcryptVersion} with prebuilds/win32-x64 (no compiler needed)`);
    } else {
      skipped('bcrypt', 'prebuilt win32-x64 binary not available, logins would fail (install.ps1 retries)');
    }
  }

  step('sqlite for the backup orchestrator');
  const copies = findSqliteCopies(deployDir);
  if (copies.length === 0) {
    note('no better-sqlite3 in the tree, nothing to replace');
  }

  for (const target of copies) {
    rmSync(target, { recursive: true, force: true });
    copyTree(join(windowsRoot, 'scripts', 'better-sqlite3-shim'), target);
  }

  note(`better-sqlite3 mapped onto node:sqlite (${copies.length} copy/copies)`);

  // .bin holds command line shims, which are shell scripts and symlinks; nothing in the server
  // executes them and a zip cannot carry the links
  const binDirs = [];
  const collect = (dir, depth = 0) => {
    if (depth > 6) {
      return;
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === '.bin') {
        binDirs.push(join(dir, entry.name));
      } else if (entry.name === 'node_modules' || entry.name.startsWith('@') || depth < 2) {
        collect(join(dir, entry.name), depth + 1);
      }
    }
  };
  collect(deployDir);
  for (const dir of binDirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  note(`removed ${binDirs.length} .bin shim folders`);

  // anything still pointing outside the payload would break once the folder is copied
  const strays = [];
  const scan = (dir, depth = 0) => {
    if (depth > 10) {
      return;
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        strays.push(full);
      } else if (entry.isDirectory() && entry.name !== '.git') {
        scan(full, depth + 1);
      }
    }
  };
  scan(deployDir);
  if (strays.length > 0) {
    note(`${strays.length} symbolic link(s) remain and will be dropped when zipping:`);
    for (const stray of strays.slice(0, 5)) {
      note(`  ${stray.slice(deployDir.length + 1)}`);
    }
  }

  staged('server', `${(dirSize(deployDir) / 1024 ** 2).toFixed(0)} MB`);
}

function stagePlugins() {
  step('plugins');
  mkdirSync(join(runtimePaths.build, 'plugins'), { recursive: true });
  // The WASM plugin runtime is built with extism-js, which has no Windows build; Immich itself keeps
  // working, only the experimental plugin feature stays off.
  skipped('plugin-core', 'wasm needs extism-js, which has no Windows build');
}

function stageCli() {
  step('Immich CLI');
  const cli = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
  if (!existsSync(cli)) {
    skipped('cli', 'not built in this checkout (pnpm --filter @immich/cli build)');
    return;
  }

  rmSync(runtimePaths.cli, { recursive: true, force: true });
  mkdirSync(runtimePaths.cli, { recursive: true });
  copyTree(join(repoRoot, 'packages', 'cli', 'dist'), join(runtimePaths.cli, 'dist'));
  staged('cli', 'present');
}

function resolveModelRevision() {
  try {
    const lock = readFileSync(join(repoRoot, 'machine-learning', 'uv.lock'), 'utf8');
    const match = lock.match(/ml-models\.git\?rev=([0-9a-f]{40})/);
    if (match) {
      return match[1];
    }
  } catch {
    // no lockfile: fall back to the branch head
  }

  return 'main';
}

function mlRequirements() {
  // Parsed line by line so extras such as "uvicorn[standard]" stay intact
  const pyproject = readFileSync(join(repoRoot, 'machine-learning', 'pyproject.toml'), 'utf8');
  const start = pyproject.indexOf('dependencies = [');
  if (start === -1) {
    throw new Error('machine-learning/pyproject.toml has no dependencies block');
  }

  const block = pyproject.slice(start + 'dependencies = ['.length).split(/^\]/m)[0];
  return [
    ...block
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim().replace(/,$/, '').replace(/^"(.*)"$/, '$1'))
      // gunicorn is POSIX only (Windows runs uvicorn directly); immich-model is staged from source
      .filter((line) => line && !line.startsWith('immich-model') && !line.startsWith('gunicorn')),
    'onnxruntime>=1.23.2,<2',
  ];
}

function findHostUv() {
  return [
    process.env.UV,
    join(runtimePaths.tools, platform() === 'win32' ? 'uv.exe' : 'uv'),
    process.env.HOME && join(process.env.HOME, '.cargo', 'bin', 'uv'),
    process.env.HOME && join(process.env.HOME, '.local', 'bin', 'uv'),
  ].filter((candidate) => candidate && existsSync(candidate))[0];
}

async function buildMachineLearning() {
  step('machine learning service');
  const mlSource = join(repoRoot, 'machine-learning');
  rmSync(runtimePaths.ml, { recursive: true, force: true });
  mkdirSync(runtimePaths.ml, { recursive: true });
  copyTree(join(mlSource, 'immich_ml'), join(runtimePaths.ml, 'immich_ml'), {
    filter: (source) => !source.includes('__pycache__') && !source.endsWith('.pyc'),
  });
  copyFileSyncSafe(join(mlSource, 'pyproject.toml'), join(runtimePaths.ml, 'pyproject.toml'));
  if (existsSync(join(mlSource, 'uv.lock'))) {
    copyFileSyncSafe(join(mlSource, 'uv.lock'), join(runtimePaths.ml, 'uv.lock'));
  }

  note('service sources in runtime/ml');

  if (flag('skip-ml')) {
    skipped('machine-learning', '--skip-ml');
    return;
  }

  await stagePython();
  await stageUv();

  // The site directory is platform specific but not host specific: uv resolves Windows wheels from
  // any machine, so the packages are staged even when the interpreter itself could not be fetched.
  if (!existsSync(join(runtimePaths.python, 'python.exe'))) {
    note('python runtime missing; install.ps1 downloads it on Windows');
    report.push({ component: 'python', status: 'post-install', reason: 'install.ps1 downloads python-build-standalone' });
  }

  const packages = join(runtimePaths.ml, 'packages');
  const hostUv = findHostUv();
  if (!hostUv) {
    report.push({ component: 'machine-learning', status: 'needs-windows', reason: 'run scripts/install-ml.ps1 to install runtime/ml/packages' });
    note('run scripts/install-ml.ps1 on Windows to install the ML packages');
    return;
  }

  if (!existsSync(join(packages, 'uvicorn')) || flag('force-ml')) {
    rmSync(packages, { recursive: true, force: true });
    mkdirSync(packages, { recursive: true });
    note('installing Windows packages with uv (this takes a few minutes)');
    const platformArgs = platform() === 'win32' ? [] : ['--python-platform', 'windows', '--python-version', '3.12'];
    run(hostUv, ['pip', 'install', ...platformArgs, '--target', packages, '--no-cache', '--link-mode', 'copy', ...mlRequirements()], {
      env: { ...process.env, UV_LINK_MODE: 'copy' },
    });
    staged('machine-learning', 'packages staged');
  } else {
    note('packages already staged');
  }

  step('AI model definitions');
  const revision = resolveModelRevision();
  const sourceRoot = join(cacheDir, 'ml-models');
  if (!findFirst(sourceRoot, (name, full) => name === '__init__.py' && full.includes('immich_model'), 3)) {
    rmSync(sourceRoot, { recursive: true, force: true });
    const archive = join(cacheDir, `ml-models-${revision}.tar.gz`);
    try {
      download(`https://codeload.github.com/immich-app/ml-models/tar.gz/${revision}`, archive);
      extract(archive, sourceRoot);
    } catch {
      note('could not fetch immich-app/ml-models; install.ps1 adds the model definitions on Windows');
    }
  }

  // The model definitions are a pure-Python package pinned by the lockfile; a resolver would pull in
  // the export extra (torch), so the sources are copied straight into the site directory.
  const models = join(packages, 'immich_model');
  const modelPackage = findFirst(sourceRoot, (name, full) => name === 'immich_model' && existsSync(join(full, '__init__.py')), 4);
  if (modelPackage) {
    rmSync(models, { recursive: true, force: true });
    copyTree(modelPackage, models, { filter: (source) => !source.includes('__pycache__') });
    note(`immich-app/ml-models ${revision.slice(0, 8)}`);
    staged('ml-models', revision.slice(0, 8));
  } else {
    report.push({ component: 'ml-models', status: 'post-install', reason: 'run install.ps1 to fetch the model definitions' });
  }

  note(`packages: ${(dirSize(packages) / 1024 ** 2).toFixed(0)} MB`);
  rmSync(join(runtimePaths.ml, '.venv'), { recursive: true, force: true });
}

function stageGeodata() {
  step('geodata');
  mkdirSync(join(runtimePaths.build, 'geodata'), { recursive: true });
  if (flag('skip-geodata')) {
    skipped('geodata', '--skip-geodata');
    return;
  }

  note('run "Immich.exe geodata download" (or scripts\\install-geodata.ps1) for place names');
  report.push({ component: 'geodata', status: 'post-install', reason: 'run Immich.exe geodata download' });
}

function writeManifest() {
  step('manifest');
  const version = JSON.parse(readFileSync(join(repoRoot, 'server', 'package.json'), 'utf8')).version;
  const manifest = {
    product: 'Immich4Win',
    immich: version,
    builtAt: new Date().toISOString(),
    builtOn: `${platform()}-${process.arch}`,
    toolchain,
    parallelism: availableParallelism(),
    components: report,
  };

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, undefined, 2));
  writeFileSync(join(outDir, 'VERSION'), `${version}\n`);
  note(`manifest.json + VERSION (Immich ${version})`);
}

function copyFileSyncSafe(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { force: true });
}

async function main() {
  console.log('Immich4Win build');
  console.log(`  repository ${repoRoot}`);
  console.log(`  output     ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  copyLaunchers();

  if (!flag('skip-binaries')) {
    await stageNode();
    await stagePostgres();
    await stageRedis();
    await stageFfmpeg();
    await stageExiftool();
  } else {
    step('binaries');
    skipped('binaries', '--skip-binaries');
  }

  if (!flag('skip-web')) {
    buildWeb();
  } else {
    step('web');
    skipped('web', '--skip-web');
  }

  await buildServer();
  stagePlugins();
  stageCli();
  await buildMachineLearning();
  stageGeodata();

  if (!flag('skip-exe')) {
    step('Immich.exe');
    run(process.execPath, [join(windowsRoot, 'scripts', 'make-exe.mjs'), '--out', outDir, '--windows']);
    staged('exe', 'Node SEA');
  } else {
    step('Immich.exe');
    skipped('exe', '--skip-exe');
  }

  writeManifest();

  const megabytes = (dirSize(outDir) / 1024 ** 2).toFixed(0);
  console.log(`\nImmich4Win assembled in ${(process.uptime() / 60).toFixed(1)} minutes`);
  console.log(`  ${outDir} (${megabytes} MB)`);

  const pending = report.filter((entry) => entry.status !== 'ok');
  if (pending.length > 0) {
    console.log('\n  run scripts/install.ps1 on the Windows 11 PC to finish:');
    for (const entry of pending) {
      console.log(`    - ${entry.component}: ${entry.reason}`);
    }
  }

  console.log('\n  start with Immich.bat');
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    console.error(`\nbuild failed: ${error.message}`);
    process.exit(1);
  });
