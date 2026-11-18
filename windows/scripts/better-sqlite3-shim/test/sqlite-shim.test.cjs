/*
  Tests for the node:sqlite backed better-sqlite3 shim.

  Run with the shim resolvable as "better-sqlite3", either inside the assembled payload or via
  NODE_PATH:

    node windows/scripts/better-sqlite3-shim/test/sqlite-shim.test.cjs

  The last block runs the real kysely SqliteDialect from server/node_modules, which is what the
  backups orchestrator uses, so a regression there fails here rather than in an installed product.
*/

const Database = require('better-sqlite3');
const assert = require('node:assert');
const os = require('node:os'), fs = require('node:fs'), path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
const dbPath = path.join(dir, 'state.sqlite3');

// 1. the exact orchestrator sequence
{
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 1');
  console.log('  pragma journal_mode ->', JSON.stringify(db.pragma('journal_mode')));
  db.close();
  assert.equal(db.open, false);
}

// 2. reopen, schema, prepared statements, all the bind type coercions
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER, created TEXT)`);
  const insert = db.prepare('INSERT INTO t (name, active, created) VALUES (?, ?, ?)');
  const r1 = insert.run('alpha', true, new Date('2024-01-02T03:04:05Z'));
  const r2 = insert.run('beta', false, undefined);
  assert.equal(r1.changes, 1); assert.equal(typeof r1.lastInsertRowid, 'number');
  assert.notEqual(r1.lastInsertRowid, r2.lastInsertRowid);

  // named parameters, both syntaxes
  db.prepare('INSERT INTO t (name, active) VALUES (:name, :active)').run({ name: 'gamma', active: 1 });
  db.prepare('INSERT INTO t (name) VALUES (@name)').run({ name: 'delta' });
  db.prepare('INSERT INTO t (name) VALUES ($name)').run({ name: 'epsilon' });

  const rows = db.prepare('SELECT name, active, created FROM t ORDER BY id').all();
  assert.equal(rows.length, 5);
  assert.equal(rows[0].active, 1);
  assert.equal(rows[1].created, null, 'undefined binds as NULL');
  assert.equal(rows[0].created, '2024-01-02T03:04:05.000Z', 'Date binds as ISO string');
  console.log('  rows ->', JSON.stringify(rows.map(r => r.name)));

  // get / pluck / raw
  assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 5);
  assert.equal(db.prepare('SELECT name FROM t WHERE id = ?').pluck().get(1), 'alpha');
  const rawRow = db.prepare('SELECT name, active FROM t WHERE id = ?').raw().get(2);
  assert.deepEqual(rawRow, ['beta', 0]);
  console.log('  pluck/raw OK');

  // iterate
  const names = [...db.prepare('SELECT name FROM t').iterate()].map(r => r.name);
  assert.deepEqual(names, ['alpha','beta','gamma','delta','epsilon']);
  console.log('  iterate OK');

  // transactions: commit, rollback, nested, immediate
  const tx = db.transaction((n) => { db.prepare('INSERT INTO t (name) VALUES (?)').run(n); return n; });
  tx.immediate('zeta');
  assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 6);

  const bad = db.transaction(() => { db.prepare('INSERT INTO t (name) VALUES (?)').run('rolled-back'); throw new Error('nope'); });
  assert.throws(() => bad(), /nope/);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM t WHERE name = 'rolled-back'`).get().n, 0);
  assert.equal(db.inTransaction, false);

  const outer = db.transaction(() => {
    db.prepare('INSERT INTO t (name) VALUES (?)').run('outer');
    try { db.transaction(() => { db.prepare('INSERT INTO t (name) VALUES (?)').run('inner'); throw new Error('x'); })(); } catch {}
  });
  outer();
  const after = db.prepare('SELECT name FROM t WHERE name IN (?, ?) ORDER BY name').all('outer', 'inner').map(r => r.name);
  assert.deepEqual(after, ['outer'], 'nested failure rolls back only the savepoint');
  assert.equal(db.inTransaction, false);
  console.log('  transactions OK (commit, rollback, savepoints, immediate)');

  // constraint errors and messages
  assert.throws(() => db.prepare('INSERT INTO t (name) VALUES (NULL)').run(), /NOT NULL/);
  assert.match((() => { try { db.prepare('SELEC nonsense'); } catch (e) { return e.message; } })(), /SqliteError.*\[Immich\]|SqliteError/);

  // readonly
  db.close();
  const ro = new Database(dbPath, { readonly: true });
  assert.equal(ro.prepare('SELECT count(*) AS n FROM t').get().n, 7);
  assert.throws(() => ro.prepare('INSERT INTO t (name) VALUES (?)').run('x'), /readonly|read-only/i);
  ro.close();
  console.log('  readonly OK');
}

// 3. the real kysely SqliteDialect from the repo's node_modules
{
  const kyselyPath = path.join(__dirname, '..', '..', '..', '..', 'server', 'node_modules', 'kysely');
  if (!fs.existsSync(kyselyPath)) {
    console.log('  kysely not installed here, skipping the dialect test');
    return;
  }

  const { Kysely, SqliteDialect, sql } = require(kyselyPath);
  const db = new Database(path.join(dir, 'kysely.sqlite3'));
  db.pragma('journal_mode = WAL');
  const kysely = new Kysely({ dialect: new SqliteDialect({ database: db }) });
  const run = async () => {
    await kysely.schema.createTable('yucca').addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement()).addColumn('name', 'text').execute();
    await kysely.insertInto('yucca').values([{ name: 'snapshot-a' }, { name: 'snapshot-b' }]).execute();
    const rows = await kysely.selectFrom('yucca').selectAll().orderBy('id').execute();
    assert.deepEqual(rows.map((r) => r.name), ['snapshot-a', 'snapshot-b']);
    await kysely.updateTable('yucca').set({ name: 'snapshot-c' }).where('id', '=', 1).execute();
    const one = await kysely.selectFrom('yucca').select('name').where('id', '=', 1).executeTakeFirstOrThrow();
    assert.equal(one.name, 'snapshot-c');
    await kysely.deleteFrom('yucca').where('id', '=', 2).execute();
    assert.equal((await kysely.selectFrom('yucca').selectAll().execute()).length, 1);
    const count = await kysely.selectFrom('yucca').select(sql`count(*)`.as('n')).executeTakeFirst();
    console.log('  kysely SqliteDialect OK -> rows:', JSON.stringify(rows.map(r=>r.name)), 'count:', count.n);
    await kysely.destroy();
  };
  run().catch((e) => { console.error('  KYSELY FAILED:', e.message); process.exitCode = 1; });
}
