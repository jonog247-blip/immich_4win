'use strict';

/*
  better-sqlite3, backed by Node's built-in node:sqlite.

  better-sqlite3 is a native addon: using it on Windows would mean compiling C++ with Visual Studio
  on every machine that installs Immich. Only the backups orchestrator imports it, and only for a
  small state database, so this module implements the part of the API it uses on top of node:sqlite,
  which ships inside the Node runtime the product already bundles.

  Supported
    new Database(path, options)          open, create, read only, busy timeout
    db.prepare(sql)                      .run(...), .get(...), .all(...), .iterate(...)
                                         .raw(), .pluck(), .expand(), .safeIntegers(), .columns()
    db.exec(sql)                         several statements at once
    db.pragma(text[, {simple}])          read a pragma, or set one
    db.transaction(fn)                   deferred, .immediate, .exclusive, nested via savepoints
    db.close(), db.open, db.inTransaction, db.name, db.memory

  Differences worth knowing
    - Named parameters accept :name, @name and $name with a plain object.
    - .iterate() returns an iterator directly (better-sqlite3 returns one as well, from 7.x).
    - .run() reports changes and lastInsertRowid, not better-sqlite3's totalChanges extension.
*/

const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer)
  );
}

// node:sqlite binds null, number, bigint, string and Uint8Array; better-sqlite3 also takes
// booleans, Dates and undefined, and accepts arrays or objects for parameters
function normalizeValue(value) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value === undefined) {
    return null;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return value;
}

function bindNamed(params) {
  const named = {};
  for (const [key, value] of Object.entries(params)) {
    named[key] = normalizeValue(value);
  }

  return named;
}

// node:sqlite takes positional parameters as separate arguments and named ones as a single object,
// where better-sqlite3 accepts .run([a, b]) and .run({ name: value }) for both
function apply(statement, method, params) {
  if (params.length === 1 && isPlainObject(params[0])) {
    return statement[method](bindNamed(params[0]));
  }

  const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return statement[method](...values.map(normalizeValue));
}

// better-sqlite3 exposes `reader: true` on statements that return rows; kysely's SqliteDialect uses
// it to choose between all() and run()
function returnsRows(statement, sql) {
  if (typeof statement.columns === 'function') {
    try {
      return statement.columns().length > 0;
    } catch {
      // fall through to the text check
    }
  }

  return /^\s*(select|with|pragma|explain)\b/i.test(String(sql));
}

class Statement {
  constructor(statement, database, sql) {
    this.statement = statement;
    this.database = database;
    this.source = sql;
    this.reader = returnsRows(statement, sql);
    this.rawMode = false;
    this.pluckMode = false;
  }

  run(...params) {
    this.database.assertOpen();
    const result = apply(this.statement, 'run', params);
    return { changes: Number(result.changes ?? 0), lastInsertRowid: result.lastInsertRowid ?? 0 };
  }

  get(...params) {
    this.database.assertOpen();
    return this.shape(apply(this.statement, 'get', params));
  }

  all(...params) {
    this.database.assertOpen();
    return apply(this.statement, 'all', params).map((row) => this.shape(row));
  }

  *iterate(...params) {
    for (const row of this.all(...params)) {
      yield row;
    }
  }

  columns() {
    return (this.statement.columns?.() ?? []).map((column) => column);
  }

  // kysely's SqliteDialect configures the statement before executing it
  raw(toggle = true) {
    this.rawMode = toggle !== false;
    this.statement.setReturnArrays?.(this.rawMode);
    return this;
  }

  pluck(toggle = true) {
    this.pluckMode = toggle !== false;
    return this;
  }

  expand(toggle = true) {
    this.statement.setAllowBareNamedParameters?.(toggle !== false);
    return this;
  }

  safeIntegers(toggle = true) {
    this.statement.setReadBigInts?.(toggle !== false);
    return this;
  }

  shape(row) {
    if (row === undefined || row === null) {
      return row;
    }

    if (this.pluckMode) {
      return Array.isArray(row) ? row[0] : Object.values(row)[0];
    }

    return row;
  }
}

class Database extends EventEmitter {
  constructor(filename = ':memory:', options = {}) {
    super();
    this.name = filename;
    this.memory = filename === ':memory:' || filename === '';
    this.readonly = Boolean(options.readonly);
    this.timeout = options.timeout ?? 5000;
    this.unsafeMode = Boolean(options.unsafeMode);
    this.verbose = options.verbose;
    this.open = false;
    this.inTransaction = false;
    this.savepointDepth = 0;
    this.handle = this.openHandle();
  }

  openHandle() {
    const handle = new DatabaseSync(this.name, {
      readOnly: this.readonly,
      // better-sqlite3 waits up to `timeout` ms for a lock before failing; node:sqlite takes the same
      timeout: this.timeout,
    });
    this.open = true;
    return handle;
  }

  assertOpen() {
    if (!this.open || !this.handle) {
      throw new Error('The database connection is not open');
    }
  }

  prepare(sql) {
    this.assertOpen();
    let statement;
    try {
      statement = this.handle.prepare(sql);
    } catch (error) {
      error.message = `SqliteError: ${error.message} in ${String(sql).trim().slice(0, 200)}`;
      throw error;
    }

    if (this.unsafeMode) {
      return statement;
    }

    return new Statement(statement, this, sql);
  }

  exec(sql) {
    this.assertOpen();
    this.handle.exec(sql);
    return this;
  }

  pragma(text, options = {}) {
    this.assertOpen();
    const trimmed = String(text).trim();
    const assignment = /^([a-z_]+)\s*=\s*(.+)$/i.exec(trimmed);

    if (assignment) {
      // setting a pragma: better-sqlite3 returns the value the pragma settled on, so it is read back
      this.handle.prepare(`PRAGMA ${trimmed}`).run();
      const name = assignment[1];
      let rows;
      try {
        rows = this.handle.prepare(`PRAGMA ${name}`).all();
      } catch {
        return undefined;
      }

      return options.simple ? Object.values(rows[0] ?? {})[0] : rows;
    }

    const rows = this.handle.prepare(`PRAGMA ${trimmed}`).all();
    if (rows.length === 0) {
      return undefined;
    }

    return options.simple ? Object.values(rows[0])[0] : rows;
  }

  transaction(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('transaction() expects a function');
    }

    const database = this;
    const run = (...args) => database.runTransaction(fn, args, 'deferred');
    run.deferred = (...args) => database.runTransaction(fn, args, 'deferred');
    run.immediate = (...args) => database.runTransaction(fn, args, 'immediate');
    run.exclusive = (...args) => database.runTransaction(fn, args, 'exclusive');
    return run;
  }

  runTransaction(fn, args, mode) {
    this.assertOpen();
    const nested = this.inTransaction;
    const savepoint = `immich4win_savepoint_${this.savepointDepth}`;
    const begin = mode === 'immediate' ? 'BEGIN IMMEDIATE' : mode === 'exclusive' ? 'BEGIN EXCLUSIVE' : 'BEGIN';

    if (nested) {
      this.handle.exec(`SAVEPOINT ${savepoint}`);
      this.savepointDepth += 1;
    } else {
      this.handle.exec(begin);
      this.inTransaction = true;
    }

    let result;
    try {
      result = fn(...args);
    } catch (error) {
      this.rollback(nested, savepoint, error);
      throw error;
    }

    if (nested) {
      this.handle.exec(`RELEASE ${savepoint}`);
      this.savepointDepth -= 1;
    } else {
      this.handle.exec('COMMIT');
      this.inTransaction = false;
    }

    return result;
  }

  rollback(nested, savepoint, original) {
    try {
      if (nested) {
        this.handle.exec(`ROLLBACK TO ${savepoint}`);
        this.handle.exec(`RELEASE ${savepoint}`);
        this.savepointDepth = Math.max(0, this.savepointDepth - 1);
      } else {
        this.handle.exec('ROLLBACK');
        this.inTransaction = false;
      }
    } catch (error) {
      // a failing rollback must not hide why the transaction was rolled back
      original.rollbackError = error;
    }
  }

  close() {
    if (!this.open) {
      return this;
    }

    this.handle.close();
    this.handle = undefined;
    this.open = false;
    this.inTransaction = false;
    return this;
  }

  // present in better-sqlite3; node:sqlite reads integers as numbers and switches to bigint on
  // overflow, which is what the callers here expect anyway
  defaultSafeIntegers() {
    return this;
  }

  backup() {
    throw new Error('the node:sqlite shim does not implement better-sqlite3 backup()');
  }

  serialize() {
    throw new Error('the node:sqlite shim does not implement better-sqlite3 serialize()');
  }
}

// `new Database()` is the documented form; the call form is kept for older call sites
function createDatabase(...args) {
  return new Database(...args);
}

createDatabase.Database = Database;
createDatabase.default = createDatabase;
createDatabase.SqliteError = Error;

module.exports = createDatabase;
