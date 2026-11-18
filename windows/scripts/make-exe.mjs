#!/usr/bin/env node
'use strict';

/*
  Builds Immich.exe: the launcher packed into a copy of the Node runtime with a Node SEA blob.

  The same binary is reused as the Node runtime for the Immich server, so the product needs no
  node.exe next to it. Injection only patches bytes, which means the exe can be produced on a
  Linux or macOS build host while the payload is assembled for Windows.

    node windows/scripts/make-exe.mjs --out dist/immich4win --windows
    node windows/scripts/make-exe.mjs --blob-only            just refresh the blob
*/

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const windowsRoot = resolve(here, '..');
const repoRoot = resolve(windowsRoot, '..');
const launcher = join(windowsRoot, 'exe', 'launcher.cjs');

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const outDir = resolve(value('out', join(repoRoot, 'dist', 'immich4win')));
const targetWindows = args.includes('--windows') || platform() === 'win32';
const blobOnly = args.includes('--blob-only');
const buildDir = join(repoRoot, '.build', 'exe');
const seaBlob = join(buildDir, 'sea-prep.blob');
const sentinel = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// postject is the same injector Node's own documentation recommends
const POSTJECT_VERSION = '1.0.0-alpha.6';

function step(message) {
  console.log(`\n==> ${message}`);
}

function fail(message) {
  console.error(`\nmake-exe: ${message}`);
  process.exit(1);
}

if (!existsSync(launcher)) {
  fail(`launcher not found at ${launcher}`);
}

if (Number(process.versions.node.split('.')[0]) < 20) {
  fail(`Node 20 or newer is required, this is ${process.versions.node}`);
}

step('sea-config.json');
mkdirSync(buildDir, { recursive: true });
const seaConfig = {
  main: launcher,
  output: seaBlob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
};

const seaConfigPath = join(buildDir, 'sea-config.json');
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, undefined, 2));
console.log('    launcher.cjs -> sea-prep.blob (no snapshot, no code cache: keeps the binary portable)');

step('generate the SEA blob');
const blob = spawnSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });
if (blob.status !== 0) {
  fail(`sea-config failed with ${blob.status}`);
}

const blobSize = statSync(seaBlob).size;
console.log(`    ${(blobSize / 1024 ** 2).toFixed(1)} MB`);

if (blobOnly) {
  console.log('\nblob refreshed');
  process.exit(0);
}

// The base image has to be the Node build for the target platform: the blob is portable but the
// executable is not.
function resolveBaseRuntime() {
  const fromPayload = join(outDir, 'runtime', 'node', targetWindows ? 'node.exe' : 'node');
  if (existsSync(fromPayload)) {
    return fromPayload;
  }

  const explicit = value('node', undefined);
  if (explicit) {
    return resolve(explicit);
  }

  // A host build can use the running interpreter, but only for the host platform
  const hostMatches = targetWindows ? platform() === 'win32' : platform() !== 'win32';
  return hostMatches ? process.execPath : undefined;
}

step('base runtime');
const base = resolveBaseRuntime();
if (!base) {
  fail(
    `no ${targetWindows ? 'Windows' : 'host'} node found.\n` +
      '  Run scripts/build.mjs first (it stages runtime/node), or pass --node <path to node.exe>.',
  );
}

console.log(`    ${base}`);

const exeName = targetWindows ? 'Immich.exe' : 'Immich';
const exePath = join(outDir, exeName);
mkdirSync(outDir, { recursive: true });

step(`Immich${targetWindows ? '.exe' : ''}`);
rmSync(exePath, { force: true });
copyFileSync(base, exePath);
chmodSync(exePath, 0o755);

function ensurePostject() {
  const local = join(buildDir, 'node_modules', 'postject');
  if (existsSync(join(local, 'dist', 'cli.js'))) {
    return join(local, 'dist', 'cli.js');
  }

  step(`postject ${POSTJECT_VERSION}`);
  writeFileSync(join(buildDir, 'package.json'), JSON.stringify({ name: 'immich4win-exe', private: true, version: '1.0.0' }, undefined, 2));
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', `postject@${POSTJECT_VERSION}`], {
    cwd: buildDir,
    stdio: 'inherit',
    shell: platform() === 'win32',
  });
  if (install.status !== 0) {
    fail('could not install postject (it is needed once, to inject the blob)');
  }

  return join(local, 'dist', 'cli.js');
}

const postject = ensurePostject();

const injectArgs = [postject, exePath, 'NODE_SEA_BLOB', seaBlob, '--sentinel-fuse', sentinel];
if (!targetWindows && platform() === 'darwin') {
  injectArgs.push('--macho-segment-name', 'NODE_SEA');
}

step('inject the blob');
const inject = spawnSync(process.execPath, injectArgs, { stdio: 'inherit' });
if (inject.status !== 0) {
  fail(`postject failed with ${inject.status} (is ${exeName} still running? stop Immich first)`);
}

console.log(`    ${(statSync(exePath).size / 1024 ** 2).toFixed(1)} MB`);

// Windows keeps the file version and product name in a resource section; without it Explorer shows
// an empty description and the file looks anonymous next to its own scripts
if (targetWindows) {
  const metadata = join(windowsRoot, 'scripts', 'set-exe-metadata.ps1');
  const version = JSON.parse(readFileSync(join(repoRoot, 'server', 'package.json'), 'utf8')).version;
  if (existsSync(metadata) && platform() === 'win32') {
    step('version resources');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', metadata, '-Path', exePath, '-Version', version],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      console.log('    skipped: set-exe-metadata.ps1 failed, the exe works without version info');
    }
  } else if (existsSync(metadata)) {
    console.log(`    deferred to Windows: scripts/set-exe-metadata.ps1 -Path ${exeName} -Version ${version}`);
  }
}

step('self test');
if ((targetWindows && platform() === 'win32') || (!targetWindows && platform() !== 'win32')) {
  try {
    const output = execFileSync(exePath, ['version', '--json'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, IMMICH4WIN_ROOT: outDir } });
    const info = JSON.parse(output.trim());
    console.log(`    Immich.exe version -> immich ${info.immich === 'not installed' ? '(payload not assembled yet)' : info.immich}`);
  } catch (error) {
    fail(`Immich.exe did not run: ${error.message}`);
  }
} else {
  console.log('    skipped: cross-built binary cannot run on this host');
}

console.log(`\n${exeName} ready in ${outDir}`);
