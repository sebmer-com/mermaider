import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseExtractor } from "../src/extractors/database.js";
import type { SourceFile } from "../src/types.js";

test("PostgreSQL schema replays ordered create, rename, add/drop columns and foreign keys", () => {
  const files = [
    {
      path: "migrations/10_evolve.sql",
      content:
        "ALTER TABLE users RENAME TO members; ALTER TABLE members RENAME COLUMN old_name TO display_name; ALTER TABLE members DROP COLUMN retired; ALTER TABLE members ADD COLUMN email text UNIQUE; DROP TABLE obsolete;",
    },
    {
      path: "migrations/2_create.sql",
      content:
        "CREATE TABLE users (id integer PRIMARY KEY, old_name text, retired text); CREATE TABLE obsolete (id integer); CREATE TABLE sessions (id integer PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id));",
    },
  ];
  const result = databaseExtractor.extract(files);
  assert.deepEqual(result.diagnostics, []);
  const diagram = result.diagrams[0];
  assert.deepEqual(
    diagram.nodes.map((node) => node.label),
    ["members", "sessions"],
  );
  assert.deepEqual(
    diagram.nodes
      .find((node) => node.label === "members")!
      .attributes!.map((column) => column.name),
    ["display_name", "email", "id"],
  );
  assert.equal(diagram.edges.length, 1);
  assert.equal(
    diagram.nodes.find((node) => node.id === diagram.edges[0].to)!.label,
    "members",
  );
  assert.deepEqual(diagram.edges[0].cardinality, { from: "}o", to: "||" });
  assert.deepEqual(result, databaseExtractor.extract([...files].reverse()));
});

test("node-pg-migrate literal interpreter reconstructs up only and never executes helpers or down", () => {
  const result = databaseExtractor.extract([
    {
      path: "packages/api/migrations/001_schema.mjs",
      content: `
const id = { type: 'integer', primaryKey: true };
export function up(pgm) {
  pgm.createTable('teams', { id, name: 'text' });
  pgm.createTable('people', { id, team_id: { type: 'integer', references: 'teams(id)' } });
}
export function down(pgm) { pgm.dropTable('people'); pgm.dropTable('teams'); }
`,
    },
    {
      path: "packages/api/migrations/002_rename.mjs",
      content: `export const up = (pgm) => { pgm.renameTable('teams', 'groups'); pgm.renameColumn('people', 'team_id', 'group_id'); pgm.addColumns('people', { email: { type: 'text', unique: true } }); };`,
    },
    {
      path: "packages/api/migrations/003_dynamic.mjs",
      content: `export function up(pgm) { throw new Error('must never run'); for (const name of names) pgm.createTable(name, {}); pgm.sql(computeSQL()); }`,
    },
  ]);
  const diagram = result.diagrams[0];
  assert.deepEqual(
    diagram.nodes.map((node) => node.label),
    ["groups", "people"],
  );
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0].label, "group_id → id");
  assert.equal(diagram.edges[0].cardinality!.to, "|o");
  assert.match(diagram.title, /partial/);
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "DATABASE_DYNAMIC_MIGRATION",
    ),
  );
  assert.ok(
    result.diagnostics.some((item) => item.code === "DATABASE_DYNAMIC_SQL"),
  );
});

test("unsupported SQL and unresolved foreign keys produce explicit incomplete diagnostics", () => {
  const result = databaseExtractor.extract([
    {
      path: "db/schema.sql",
      content:
        "CREATE TABLE child (id integer PRIMARY KEY, parent_id integer REFERENCES missing(id)); DO $$ BEGIN EXECUTE 'ALTER TABLE child ADD COLUMN unknown text'; END $$;",
    },
  ]);
  assert.ok(
    result.diagnostics.some((item) => item.code === "DATABASE_UNSUPPORTED_DDL"),
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "DATABASE_UNRESOLVED_FOREIGN_KEY",
    ),
  );
  assert.equal(result.diagrams[0].edges.length, 0);
  assert.match(result.diagrams[0].title, /partial/);
});

const d1: SourceFile = {
  path: "apps/api/wrangler.jsonc",
  content: '{"d1_databases":[{"binding":"DB","migrations_dir":"migrations"}]}',
};
test("SQLite D1 reconstructs table rebuilds, triggers and final foreign keys offline", () => {
  const result = databaseExtractor.extract([
    d1,
    {
      path: "apps/api/migrations/0001.sql",
      content:
        "CREATE TABLE owners (id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE jobs (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES owners(id), old_value TEXT CHECK(old_value GLOB '[a-z]*')); CREATE TRIGGER stamp AFTER INSERT ON jobs BEGIN UPDATE jobs SET old_value = 'created' WHERE id = NEW.id; END;",
    },
    {
      path: "apps/api/migrations/0002.sql",
      content:
        "PRAGMA foreign_keys=OFF; CREATE TABLE jobs_next (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES owners(id), state TEXT NOT NULL); INSERT INTO jobs_next SELECT id, owner_id, old_value FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_next RENAME TO jobs; PRAGMA foreign_keys=ON;",
    },
  ]);
  assert.deepEqual(result.diagnostics, []);
  const diagram = result.diagrams[0];
  assert.equal(diagram.id, "data:schema:apps/api/migrations");
  assert.deepEqual(
    diagram.nodes.map((node) => node.label),
    ["jobs", "owners"],
  );
  assert.deepEqual(
    diagram.nodes
      .find((node) => node.label === "jobs")!
      .attributes!.map((column) => column.name),
    ["id", "owner_id", "state"],
  );
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0].cardinality!.to, "||");
  assert.equal(diagram.nodes[0].evidence.length, 2);
});

test("SQLite blocks external access and does not apply later migrations after unsafe input", () => {
  for (const sql of [
    "ATTACH DATABASE '/tmp/should-not-exist.db' AS other;",
    "SELECT load_extension('/tmp/unsafe');",
    "PRAGMA writable_schema=ON;",
    "VACUUM INTO '/tmp/should-not-exist.db';",
  ]) {
    const result = databaseExtractor.extract([
      d1,
      {
        path: "apps/api/migrations/1.sql",
        content: "CREATE TABLE safe (id INTEGER PRIMARY KEY);",
      },
      { path: "apps/api/migrations/2.sql", content: sql },
      {
        path: "apps/api/migrations/3.sql",
        content: "CREATE TABLE skipped (id INTEGER);",
      },
    ]);
    assert.deepEqual(
      result.diagrams[0].nodes.map((node) => node.label),
      ["safe"],
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === "DATABASE_UNSAFE_SQLITE"),
    );
    assert.match(result.diagrams[0].title, /partial/);
  }
});

test("failed SQLite migrations discard all partial effects and retain the accepted prefix", () => {
  const result = databaseExtractor.extract([
    d1,
    {
      path: "apps/api/migrations/1.sql",
      content: "CREATE TABLE safe (id INTEGER PRIMARY KEY);",
    },
    {
      path: "apps/api/migrations/2.sql",
      content: "CREATE TABLE transient (id INTEGER); INVALID SQL;",
    },
    {
      path: "apps/api/migrations/3.sql",
      content: "CREATE TABLE skipped (id INTEGER);",
    },
  ]);
  assert.deepEqual(
    result.diagrams[0].nodes.map((node) => node.label),
    ["safe"],
  );
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "DATABASE_SQLITE_RECONSTRUCTION_FAILED",
    ),
  );
});
