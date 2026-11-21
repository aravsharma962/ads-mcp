/** Minimal in-memory Supabase stand-in for tests. Does NOT simulate RLS: code must filter by tenant itself. */
type Row = Record<string, any>;
type Result = { data: any; error: { message: string; code?: string } | null; count?: number | null };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  seq = 0;
  /** Per-table insert hook: may fill DB defaults on the row and return an error (e.g. unique violation). */
  hooks: Record<string, (row: Row, rows: Row[]) => { message: string; code?: string } | null> = {};
  constructor(seed: Record<string, Row[]> = {}) {
    for (const [k, v] of Object.entries(seed)) this.tables[k] = v.map((r) => ({ ...r }));
  }
  rows(t: string) {
    return (this.tables[t] ??= []);
  }
  from(table: string) {
    return new Query(this, table);
  }
  /** Session-like client for a given user id (what createClient() returns in tests). */
  session(userId: string | null) {
    return {
      from: (t: string) => this.from(t),
      auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null }, error: null }) },
    };
  }
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private payload: Row | Row[] | null = null;
  private onConflict: string[] | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  private returning = false;
  private rangeSel: [number, number] | null = null;
  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string) {
    if (this.op === "select") this.returning = true;
    else this.returning = true;
    return this;
  }
  insert(p: Row | Row[]) { this.op = "insert"; this.payload = p; return this; }
  upsert(p: Row | Row[], opts?: { onConflict?: string }) {
    this.op = "upsert"; this.payload = p;
    this.onConflict = opts?.onConflict ? opts.onConflict.split(",").map((s) => s.trim()) : null;
    return this;
  }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this; }
  lte(c: string, v: any) { this.filters.push((r) => r[c] <= v); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.lim = n; return this; }
  range(from: number, to: number) { this.rangeSel = [from, to]; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }

  private run(): Result {
    const rows = this.db.rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    let out: Row[] = [];
    if (this.op === "insert" || this.op === "upsert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload!];
      for (const p of list) {
        const row = { ...p };
        if (row.id === undefined && !["targets", "client_accounts", "memberships"].includes(this.table)) {
          row.id = ["messages", "usage_events", "events"].includes(this.table) ? ++this.db.seq : crypto.randomUUID();
        }
        if (this.op === "upsert" && this.onConflict) {
          const ex = rows.find((r) => this.onConflict!.every((k) => r[k] === row[k]));
          if (ex) { Object.assign(ex, row); out.push(ex); continue; }
        }
        const hookErr = this.db.hooks[this.table]?.(row, rows);
        if (hookErr) return { data: null, error: hookErr };
        rows.push(row);
        out.push(row);
      }
    } else if (this.op === "update") {
      for (const r of rows.filter(match)) { Object.assign(r, this.payload); out.push(r); }
    } else if (this.op === "delete") {
      const del = rows.filter(match);
      this.db.tables[this.table] = rows.filter((r) => !del.includes(r));
      out = del;
    } else {
      out = rows.filter(match);
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.rangeSel) out = out.slice(this.rangeSel[0], this.rangeSel[1] + 1);
    if (this.lim !== null) out = out.slice(0, this.lim);
    out = out.map((r) => ({ ...r }));
    if (this.mode === "single") {
      return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "single row expected", code: "PGRST116" } };
    }
    if (this.mode === "maybe") return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
  then<T1 = Result, T2 = never>(res?: ((v: Result) => T1 | PromiseLike<T1>) | null, rej?: ((e: any) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve().then(() => this.run()).then(res, rej);
  }
}
