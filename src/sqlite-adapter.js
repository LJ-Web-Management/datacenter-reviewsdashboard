// Gives better-sqlite3 (Node) the same async API as Cloudflare D1, so the app code is shared.
export function d1FromSqlite(sqlite) {
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = sqlite.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const make = (sql, params = []) => ({
    bind: (...args) => make(sql, args),
    runSync() {
      const s = prep(sql);
      if (s.reader) return { results: s.all(...params), success: true, meta: { changes: 0 } };
      const info = s.run(...params);
      return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    },
    async first(col) {
      const row = prep(sql).get(...params);
      if (row == null) return null;
      return col ? row[col] : row;
    },
    async all() {
      const s = prep(sql);
      return { results: s.reader ? s.all(...params) : (s.run(...params), []), success: true };
    },
    async run() {
      return this.runSync();
    },
  });
  return {
    prepare: (sql) => make(sql),
    async batch(statements) {
      return sqlite.transaction(() => statements.map((st) => st.runSync()))();
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
  };
}
