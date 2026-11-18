/*
  Types for the node:sqlite backed better-sqlite3 shim.

  The server is compiled from source and the orchestrator is JavaScript, so nothing type checks
  against these at build time; they exist so an editor knows what the replacement provides.
*/

declare module 'better-sqlite3' {
  export type BindingParameter = null | number | bigint | string | boolean | Date | Buffer | Uint8Array;
  export type BindParameters = BindingParameter[] | Record<string, BindingParameter>;

  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement<Row = unknown> {
    source: string;
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): Row | undefined;
    all(...params: unknown[]): Row[];
    iterate(...params: unknown[]): IterableIterator<Row>;
    columns(): { name: string; column: string | null; table: string | null; database: string | null; type: string | null }[];
    raw(toggle?: boolean): this;
    pluck(toggle?: boolean): this;
    expand(toggle?: boolean): this;
    safeIntegers(toggle?: boolean): this;
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    timeout?: number;
    verbose?: (message?: unknown, ...rest: unknown[]) => void;
    unsafeMode?: boolean;
  }

  export interface Transaction<Args extends unknown[] = unknown[]> {
    (...args: Args): unknown;
    deferred(...args: Args): unknown;
    immediate(...args: Args): unknown;
    exclusive(...args: Args): unknown;
  }

  export default class Database {
    constructor(filename?: string, options?: DatabaseOptions);
    name: string;
    open: boolean;
    readonly: boolean;
    memory: boolean;
    inTransaction: boolean;
    prepare<Row = unknown>(sql: string): Statement<Row>;
    exec(sql: string): this;
    pragma(text: string, options?: { simple?: boolean }): unknown;
    transaction<Args extends unknown[]>(fn: (...args: Args) => unknown): Transaction<Args>;
    close(): this;
    defaultSafeIntegers(): this;
  }

  export { Database };
}
