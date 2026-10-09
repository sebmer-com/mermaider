import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { parse as parseJsonc } from "jsonc-parser";
import {
  parse as parseSql,
  type ColumnConstraint,
  type CreateColumnDef,
  type DataTypeDef,
  type Statement,
  type TableConstraint,
} from "pgsql-ast-parser";
import type {
  Attribute,
  Diagram,
  Diagnostic,
  Evidence,
  Extractor,
  GraphEdge,
  GraphNode,
  SourceFile,
} from "../types.js";
import { sha256, stableId } from "../util.js";

type Column = {
  name: string;
  type: string;
  notNull: boolean;
  evidence: Evidence[];
};
type Constraint = {
  name?: string;
  kind: "primary" | "unique" | "foreign";
  columns: string[];
  target?: string;
  targetColumns?: string[];
  evidence: Evidence[];
};
type Table = {
  name: string;
  columns: Map<string, Column>;
  constraints: Constraint[];
  evidence: Evidence[];
  dialect?: "sqlite";
};
const compare = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true }) || a.localeCompare(b, "en");
const unknown = Symbol("dynamic");
type Literal =
  | string
  | number
  | boolean
  | null
  | typeof unknown
  | Literal[]
  | { [key: string]: Literal };
const object = (
  value: Literal | undefined,
): { [key: string]: Literal } | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
const strings = (value: Literal | undefined): string[] | undefined =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? (value as string[])
      : undefined;
const qualified = (name: { name: string; schema?: string }): string =>
  !name.schema || name.schema === "public"
    ? name.name
    : `${name.schema}.${name.name}`;
const evidenceFor = (file: SourceFile, line = 1): Evidence => ({
  path: file.path,
  line,
  sha256: sha256(file.content),
});

function literal(
  node: ts.Expression | undefined,
  env: Map<string, Literal>,
): Literal {
  if (!node) return unknown;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node)) return env.get(node.text) ?? unknown;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return literal(node.expression, env);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((item) =>
      ts.isSpreadElement(item) ? unknown : literal(item, env),
    );
  if (ts.isObjectLiteralExpression(node)) {
    const result: { [key: string]: Literal } = {};
    for (const prop of node.properties) {
      if (ts.isShorthandPropertyAssignment(prop))
        result[prop.name.text] = env.get(prop.name.text) ?? unknown;
      else if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) ||
          ts.isStringLiteral(prop.name) ||
          ts.isNumericLiteral(prop.name))
      )
        result[prop.name.text] = literal(prop.initializer, env);
      else return unknown;
    }
    return result;
  }
  return unknown;
}

function tableName(value: Literal | undefined): string | undefined {
  if (typeof value === "string") return value.replace(/^public\./, "");
  const obj = object(value);
  if (
    obj &&
    typeof obj.name === "string" &&
    (obj.schema === undefined || typeof obj.schema === "string")
  )
    return qualified({
      name: obj.name,
      schema: obj.schema as string | undefined,
    });
  return undefined;
}

function typeName(type: DataTypeDef): string {
  return type.kind === "array"
    ? `${typeName(type.arrayOf)}[]`
    : `${qualified(type)}${type.config ? `(${type.config.join(",")})` : ""}`;
}

class Schema {
  tables = new Map<string, Table>();
  diagnostics: Diagnostic[] = [];
  constructor(readonly id: string) {}
  warn(code: string, message: string, evidence: Evidence) {
    this.diagnostics.push({
      code,
      message,
      severity: "warning",
      path: evidence.path,
      diagramId: this.id,
    });
  }
  table(name: string | undefined, evidence: Evidence): Table | undefined {
    const table = name ? this.tables.get(name) : undefined;
    if (!table)
      this.warn(
        "DATABASE_UNRESOLVED_TABLE",
        `Cannot apply schema change to ${name ?? "a dynamic table name"}; current schema is incomplete.`,
        evidence,
      );
    return table;
  }
  create(
    name: string,
    evidence: Evidence,
    ifNotExists = false,
  ): Table | undefined {
    if (this.tables.has(name)) {
      if (!ifNotExists)
        this.warn(
          "DATABASE_DUPLICATE_TABLE",
          `Table ${name} is created more than once without a supported intervening drop.`,
          evidence,
        );
      return undefined;
    }
    const table: Table = {
      name,
      columns: new Map(),
      constraints: [],
      evidence: [evidence],
    };
    this.tables.set(name, table);
    return table;
  }
  rename(table: Table, name: string, evidence: Evidence) {
    if (this.tables.has(name)) {
      this.warn(
        "DATABASE_RENAME_COLLISION",
        `Cannot rename ${table.name} to existing table ${name}.`,
        evidence,
      );
      return;
    }
    const old = table.name;
    this.tables.delete(old);
    table.name = name;
    table.evidence.push(evidence);
    this.tables.set(name, table);
    for (const value of this.tables.values())
      for (const fk of value.constraints)
        if (fk.target === old) fk.target = name;
  }
  dropColumn(table: Table, name: string, evidence: Evidence) {
    table.columns.delete(name);
    table.constraints = table.constraints.filter(
      (item) => !item.columns.includes(name),
    );
    for (const value of this.tables.values())
      value.constraints = value.constraints.filter(
        (item) =>
          item.target !== table.name || !item.targetColumns?.includes(name),
      );
    table.evidence.push(evidence);
  }
  renameColumn(table: Table, old: string, name: string, evidence: Evidence) {
    const column = table.columns.get(old);
    if (!column || table.columns.has(name)) {
      this.warn(
        "DATABASE_UNRESOLVED_COLUMN",
        `Cannot rename column ${table.name}.${old} to ${name}.`,
        evidence,
      );
      return;
    }
    table.columns.delete(old);
    column.name = name;
    column.evidence.push(evidence);
    table.columns.set(name, column);
    for (const constraint of table.constraints)
      constraint.columns = constraint.columns.map((value) =>
        value === old ? name : value,
      );
    for (const value of this.tables.values())
      for (const fk of value.constraints)
        if (fk.target === table.name)
          fk.targetColumns = fk.targetColumns?.map((value) =>
            value === old ? name : value,
          );
    table.evidence.push(evidence);
  }
  sqlColumn(table: Table, column: CreateColumnDef, evidence: Evidence) {
    table.columns.set(column.name.name, {
      name: column.name.name,
      type: typeName(column.dataType),
      notNull: !!column.constraints?.some(
        (item) => item.type === "not null" || item.type === "primary key",
      ),
      evidence: [evidence],
    });
    for (const constraint of column.constraints ?? [])
      this.sqlConstraint(table, constraint, evidence, [column.name.name]);
  }
  sqlConstraint(
    table: Table,
    constraint: TableConstraint | ColumnConstraint,
    evidence: Evidence,
    local?: string[],
  ) {
    if (constraint.type === "primary key" || constraint.type === "unique") {
      const columns =
        "columns" in constraint
          ? constraint.columns.map((column) => column.name)
          : (local ?? []);
      table.constraints.push({
        name: constraint.constraintName?.name,
        kind: constraint.type === "primary key" ? "primary" : "unique",
        columns,
        evidence: [evidence],
      });
    } else if (
      constraint.type === "foreign key" ||
      constraint.type === "reference"
    ) {
      table.constraints.push({
        name: constraint.constraintName?.name,
        kind: "foreign",
        columns:
          constraint.type === "foreign key" && "localColumns" in constraint
            ? constraint.localColumns.map((column) => column.name)
            : (local ?? []),
        target: qualified(constraint.foreignTable),
        targetColumns: constraint.foreignColumns?.map((column) => column.name),
        evidence: [evidence],
      });
    }
  }
  sql(text: string, evidence: Evidence) {
    let statements: Statement[];
    try {
      statements = parseSql(text, { locationTracking: true });
    } catch {
      this.warn(
        "DATABASE_UNSUPPORTED_SQL",
        "SQL cannot be parsed by the PostgreSQL schema adapter; no statements in this SQL block were applied.",
        evidence,
      );
      return;
    }
    for (const statement of statements) {
      const ev = {
        ...evidence,
        line:
          (evidence.line ?? 1) +
          text.slice(0, statement._location?.start ?? 0).split("\n").length -
          1,
      };
      if (statement.type === "create table") {
        const table = this.create(
          qualified(statement.name),
          ev,
          statement.ifNotExists,
        );
        if (!table) continue;
        for (const column of statement.columns) {
          if (column.kind === "column") this.sqlColumn(table, column, ev);
          else
            this.warn(
              "DATABASE_UNSUPPORTED_DDL",
              "CREATE TABLE LIKE is not expanded; table columns are incomplete.",
              ev,
            );
        }
        if (statement.inherits?.length)
          this.warn(
            "DATABASE_UNSUPPORTED_DDL",
            "Inherited table columns are not expanded.",
            ev,
          );
        for (const constraint of statement.constraints ?? [])
          this.sqlConstraint(table, constraint, ev);
      } else if (statement.type === "drop table") {
        for (const name of statement.names) this.tables.delete(qualified(name));
      } else if (statement.type === "alter table") {
        const table = this.table(qualified(statement.table), ev);
        if (!table) continue;
        table.evidence.push(ev);
        for (const change of statement.changes) {
          if (change.type === "rename")
            this.rename(
              table,
              table.name.includes(".")
                ? `${table.name.slice(0, table.name.lastIndexOf(".") + 1)}${change.to.name}`
                : change.to.name,
              ev,
            );
          else if (change.type === "add column")
            this.sqlColumn(table, change.column, ev);
          else if (change.type === "drop column")
            this.dropColumn(table, change.column.name, ev);
          else if (change.type === "rename column")
            this.renameColumn(table, change.column.name, change.to.name, ev);
          else if (change.type === "add constraint")
            this.sqlConstraint(table, change.constraint, ev);
          else if (change.type === "drop constraint") {
            if (
              !table.constraints.some(
                (item) => item.name === change.constraint.name,
              ) &&
              !change.ifExists
            )
              this.warn(
                "DATABASE_UNRESOLVED_CONSTRAINT",
                `Constraint ${change.constraint.name} was not extracted; its removal cannot be reconstructed.`,
                ev,
              );
            table.constraints = table.constraints.filter(
              (item) => item.name !== change.constraint.name,
            );
          } else if (change.type === "rename constraint") {
            const constraint = table.constraints.find(
              (item) => item.name === change.constraint.name,
            );
            if (constraint) constraint.name = change.to.name;
            else
              this.warn(
                "DATABASE_UNRESOLVED_CONSTRAINT",
                `Constraint ${change.constraint.name} was not extracted.`,
                ev,
              );
          } else if (change.type === "alter column") {
            const column = table.columns.get(change.column.name);
            if (!column) {
              this.warn(
                "DATABASE_UNRESOLVED_COLUMN",
                `Column ${table.name}.${change.column.name} was not extracted.`,
                ev,
              );
              continue;
            }
            if (change.alter.type === "set type")
              column.type = typeName(change.alter.dataType);
            if (change.alter.type === "set not null") column.notNull = true;
            if (change.alter.type === "drop not null") column.notNull = false;
          } else
            this.warn(
              "DATABASE_UNSUPPORTED_DDL",
              `Unsupported ALTER TABLE operation ${change.type}.`,
              ev,
            );
        }
      } else if (
        ![
          "insert",
          "update",
          "delete",
          "comment",
          "begin",
          "commit",
          "rollback",
          "start transaction",
          "create schema",
          "create index",
          "drop index",
          "set",
          "create extension",
        ].includes(statement.type)
      ) {
        this.warn(
          "DATABASE_UNSUPPORTED_DDL",
          `Statement ${statement.type} is outside the supported table-schema subset.`,
          ev,
        );
      }
    }
  }
  pgColumn(table: Table, name: string, input: Literal, evidence: Evidence) {
    const config = typeof input === "string" ? { type: input } : object(input);
    if (!config || typeof config.type !== "string") {
      this.warn(
        "DATABASE_DYNAMIC_COLUMN",
        `Column ${table.name}.${name} has a dynamic or unsupported type.`,
        evidence,
      );
      return;
    }
    table.columns.set(name, {
      name,
      type: config.type,
      notNull: config.notNull === true || config.primaryKey === true,
      evidence: [evidence],
    });
    if (config.primaryKey === true)
      table.constraints.push({
        kind: "primary",
        columns: [name],
        evidence: [evidence],
      });
    if (config.unique === true)
      table.constraints.push({
        kind: "unique",
        columns: [name],
        evidence: [evidence],
      });
    if (
      config.references !== undefined &&
      config.notNull !== unknown &&
      config.primaryKey !== unknown
    )
      this.pgForeign(table, [name], config.references, evidence);
    for (const key of ["notNull", "primaryKey", "unique"])
      if (config[key] === unknown)
        this.warn(
          "DATABASE_DYNAMIC_CONSTRAINT",
          `Column ${table.name}.${name} has dynamic ${key}.`,
          evidence,
        );
  }
  pgForeign(
    table: Table,
    columns: string[],
    references: Literal,
    evidence: Evidence,
    name?: string,
  ) {
    const ref =
      typeof references === "string"
        ? /^([^()]+?)(?:\s*\(([^)]+)\))?$/.exec(references)
        : null;
    const target = ref
      ? ref[1].trim().replace(/^public\./, "")
      : tableName(references);
    if (!target) {
      this.warn(
        "DATABASE_DYNAMIC_CONSTRAINT",
        `Foreign key on ${table.name} has an unsupported target.`,
        evidence,
      );
      return;
    }
    const targetColumns = ref?.[2]?.split(",").map((item) => item.trim());
    table.constraints.push({
      name,
      kind: "foreign",
      columns,
      target,
      targetColumns,
      evidence: [evidence],
    });
  }
  pgConstraint(
    table: Table,
    name: string | undefined,
    config: Literal,
    evidence: Evidence,
  ) {
    const obj = object(config);
    if (!obj) {
      this.warn(
        "DATABASE_DYNAMIC_CONSTRAINT",
        "Constraint configuration is not a literal object.",
        evidence,
      );
      return;
    }
    let handled = false;
    for (const [key, kind] of [
      ["primaryKey", "primary"],
      ["unique", "unique"],
    ] as const) {
      if (obj[key] !== undefined) {
        const columns = strings(obj[key]);
        if (columns) {
          table.constraints.push({ name, kind, columns, evidence: [evidence] });
          handled = true;
        }
      }
    }
    if (obj.foreignKeys !== undefined) {
      const foreigns: Literal[] = Array.isArray(obj.foreignKeys)
        ? obj.foreignKeys
        : [obj.foreignKeys];
      for (const value of foreigns) {
        const fk = object(value);
        const columns = strings(fk?.columns);
        if (fk && columns && fk.references !== undefined) {
          this.pgForeign(table, columns, fk.references, evidence, name);
          handled = true;
        } else
          this.warn(
            "DATABASE_DYNAMIC_CONSTRAINT",
            "Foreign-key definition is not statically supported.",
            evidence,
          );
      }
    }
    if (!handled && obj.check === undefined)
      this.warn(
        "DATABASE_UNSUPPORTED_CONSTRAINT",
        "Constraint shape is outside the supported primary/unique/foreign-key subset.",
        evidence,
      );
  }
  pgCall(method: string, args: Literal[], evidence: Evidence) {
    if (method === "sql") {
      if (typeof args[0] === "string") this.sql(args[0], evidence);
      else
        this.warn(
          "DATABASE_DYNAMIC_SQL",
          "pgm.sql argument is dynamic; it was not evaluated.",
          evidence,
        );
      return;
    }
    if (
      [
        "createIndex",
        "dropIndex",
        "createSchema",
        "createExtension",
        "createType",
        "addTypeValue",
        "createFunction",
        "createTrigger",
        "dropTrigger",
        "dropFunction",
        "createPolicy",
        "alterPolicy",
        "dropPolicy",
        "grantOnTables",
        "grantOnSchemas",
        "grantOnSequences",
        "noTransaction",
      ].includes(method)
    ) {
      // These can matter to execution/security but are outside the ER schema subset.
      this.warn(
        "DATABASE_NON_TABLE_OPERATION",
        `pgm.${method} is outside the extracted table-schema subset.`,
        evidence,
      );
      return;
    }
    const name = tableName(args[0]);
    if (!name) {
      this.warn(
        "DATABASE_DYNAMIC_TABLE",
        `pgm.${method} has a dynamic or unsupported table identifier.`,
        evidence,
      );
      return;
    }
    if (method === "dropTable") {
      this.tables.delete(name);
      return;
    }
    if (method === "createTable") {
      const columns = object(args[1]);
      if (!columns) {
        this.warn(
          "DATABASE_DYNAMIC_COLUMNS",
          `Columns for ${name} are not statically defined.`,
          evidence,
        );
        return;
      }
      const table = this.create(
        name,
        evidence,
        object(args[2])?.ifNotExists === true,
      );
      if (!table) return;
      for (const [column, value] of Object.entries(columns))
        this.pgColumn(table, column, value, evidence);
      const constraints = object(args[2])?.constraints;
      if (constraints !== undefined)
        this.pgConstraint(table, undefined, constraints, evidence);
      return;
    }
    const table = this.table(name, evidence);
    if (!table) return;
    table.evidence.push(evidence);
    if (method === "renameTable" && typeof args[1] === "string")
      this.rename(table, args[1], evidence);
    else if (
      (method === "addColumns" || method === "addColumn") &&
      object(args[1])
    )
      for (const [column, value] of Object.entries(object(args[1])!))
        this.pgColumn(table, column, value, evidence);
    else if (
      (method === "dropColumns" || method === "dropColumn") &&
      strings(args[1])
    )
      for (const column of strings(args[1])!)
        this.dropColumn(table, column, evidence);
    else if (
      method === "renameColumn" &&
      typeof args[1] === "string" &&
      typeof args[2] === "string"
    )
      this.renameColumn(table, args[1], args[2], evidence);
    else if (method === "addConstraint" && typeof args[1] === "string")
      this.pgConstraint(table, args[1], args[2], evidence);
    else if (method === "dropConstraint" && typeof args[1] === "string") {
      if (!table.constraints.some((item) => item.name === args[1]))
        this.warn(
          "DATABASE_UNRESOLVED_CONSTRAINT",
          `Constraint ${args[1]} was not extracted; its removal cannot be reconstructed.`,
          evidence,
        );
      table.constraints = table.constraints.filter(
        (item) => item.name !== args[1],
      );
    } else if (
      method === "alterColumn" &&
      typeof args[1] === "string" &&
      object(args[2])
    ) {
      const column = table.columns.get(args[1]);
      const config = object(args[2])!;
      if (!column)
        this.warn(
          "DATABASE_UNRESOLVED_COLUMN",
          `Column ${name}.${args[1]} was not extracted.`,
          evidence,
        );
      else {
        if (typeof config.type === "string") column.type = config.type;
        if (typeof config.notNull === "boolean")
          column.notNull = config.notNull;
        if (config.type === unknown || config.notNull === unknown)
          this.warn(
            "DATABASE_DYNAMIC_COLUMN",
            `Column ${name}.${args[1]} has dynamic type/nullability changes.`,
            evidence,
          );
        if (
          Object.keys(config).some(
            (key) => !["type", "notNull", "default", "using"].includes(key),
          )
        )
          this.warn(
            "DATABASE_UNSUPPORTED_DDL",
            "alterColumn includes unsupported constraint changes.",
            evidence,
          );
      }
    } else
      this.warn(
        "DATABASE_UNSUPPORTED_MIGRATION",
        `pgm.${method} is unsupported or has non-literal arguments.`,
        evidence,
      );
  }
  pgMigration(file: SourceFile) {
    const ast = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
    );
    const env = new Map<string, Literal>();
    let up: ts.FunctionLikeDeclaration | undefined;
    for (const statement of ast.statements) {
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            if (
              declaration.name.text === "up" &&
              (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer))
            )
              up = declaration.initializer;
            else if (statement.declarationList.flags & ts.NodeFlags.Const)
              env.set(
                declaration.name.text,
                literal(declaration.initializer, env),
              );
          }
        }
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === "up")
        up = statement;
    }
    if (
      !up?.body ||
      !ts.isBlock(up.body) ||
      !up.parameters[0] ||
      !ts.isIdentifier(up.parameters[0].name)
    ) {
      this.warn(
        "DATABASE_UNSUPPORTED_MIGRATION",
        "No supported up(pgm) function body found; module was not executed.",
        evidenceFor(file),
      );
      return;
    }
    const pgm = up.parameters[0].name.text;
    for (const statement of up.body.statements) {
      const ev = evidenceFor(
        file,
        ast.getLineAndCharacterOfPosition(statement.getStart(ast)).line + 1,
      );
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.flags & ts.NodeFlags.Const
      ) {
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name))
            env.set(
              declaration.name.text,
              literal(declaration.initializer, env),
            );
        continue;
      }
      let expression = ts.isExpressionStatement(statement)
        ? statement.expression
        : ts.isReturnStatement(statement)
          ? statement.expression
          : undefined;
      if (expression && ts.isAwaitExpression(expression))
        expression = expression.expression;
      if (
        expression &&
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === pgm
      )
        this.pgCall(
          expression.expression.name.text,
          expression.arguments.map((arg) => literal(arg, env)),
          ev,
        );
      else if (!ts.isEmptyStatement(statement))
        this.warn(
          "DATABASE_DYNAMIC_MIGRATION",
          "Conditional, loop, helper call or other executable migration statement was not evaluated.",
          ev,
        );
    }
  }
  diagram(group: string): Diagram {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const table of [...this.tables.values()].sort((a, b) =>
      compare(a.name, b.name),
    )) {
      const attributes: Attribute[] = [...table.columns.values()]
        .sort((a, b) => compare(a.name, b.name))
        .map((column) => {
          const key = table.constraints.some(
            (item) =>
              item.kind === "primary" && item.columns.includes(column.name),
          )
            ? "PK"
            : table.constraints.some(
                  (item) =>
                    item.kind === "foreign" &&
                    item.columns.includes(column.name),
                )
              ? "FK"
              : table.constraints.some(
                    (item) =>
                      item.kind === "unique" &&
                      item.columns.length === 1 &&
                      item.columns[0] === column.name,
                  )
                ? "UK"
                : undefined;
          return {
            name: column.name,
            type: column.type,
            ...(key ? { key } : {}),
          };
        });
      nodes.push({
        id: stableId("table", `${group}\0${table.name}`),
        label: table.name,
        kind: "table",
        attributes,
        evidence: table.evidence,
      });
      for (const fk of table.constraints.filter(
        (item) => item.kind === "foreign",
      )) {
        const target = this.tables.get(fk.target!);
        const targetColumns = fk.targetColumns?.length
          ? fk.targetColumns
          : target?.constraints.find((item) => item.kind === "primary")
              ?.columns;
        if (
          !target ||
          !targetColumns?.length ||
          targetColumns.some((name) => !target.columns.has(name)) ||
          fk.columns.some((name) => !table.columns.has(name)) ||
          targetColumns.length !== fk.columns.length
        ) {
          this.warn(
            "DATABASE_UNRESOLVED_FOREIGN_KEY",
            `Foreign key from ${table.name} to ${fk.target} is unresolved; no relationship was invented.`,
            fk.evidence[0],
          );
          continue;
        }
        const unique = table.constraints.some(
          (item) =>
            item.kind !== "foreign" &&
            item.columns.length === fk.columns.length &&
            item.columns.every((name) => fk.columns.includes(name)),
        );
        // SQLite allows NULL in some PRIMARY KEY forms; only its declared NOT NULL proves this bound.
        const required = fk.columns.every(
          (name) =>
            table.columns.get(name)!.notNull ||
            (table.dialect !== "sqlite" &&
              table.constraints.some(
                (item) =>
                  item.kind === "primary" && item.columns.includes(name),
              )),
        );
        const identity = `${table.name}\0${fk.columns.join(",")}\0${target.name}\0${targetColumns.join(",")}`;
        const id = stableId("fk", `${group}\0${identity}`);
        if (!edges.some((edge) => edge.id === id))
          edges.push({
            id,
            from: stableId("table", `${group}\0${table.name}`),
            to: stableId("table", `${group}\0${target.name}`),
            kind: "foreign-key",
            label: `${fk.columns.join(", ")} → ${targetColumns.join(", ")}`,
            cardinality: {
              from: unique ? "o|" : "}o",
              to: required ? "||" : "|o",
            },
            evidence: fk.evidence,
          });
      }
    }
    return {
      id: this.id,
      title: `${group}: ${this.diagnostics.length ? "partial reconstructed" : "reconstructed"} table schema`,
      family: "data",
      syntax: "er",
      provenance: "extracted",
      context: "implemented",
      nodes,
      edges,
      diagnostics: this.diagnostics,
    };
  }
}

/** Tokenization is only an execution guard; SQLite itself parses/reconstructs DDL. */
function sqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  const pattern =
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[.;]/g;
  for (const match of sql.matchAll(pattern)) {
    const token = match[0];
    if (
      token.startsWith("--") ||
      token.startsWith("/*") ||
      token.startsWith("'")
    )
      continue;
    tokens.push(token.replace(/^["`\[]|["`\]]$/g, "").toLowerCase());
  }
  return tokens;
}

// Fixed program, no repository JS is imported. A separate process bounds blocking SQL.
const SQLITE_RECONSTRUCT = String.raw`
import { DatabaseSync } from 'node:sqlite';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const files = JSON.parse(input); const create = () => { const db = new DatabaseSync(':memory:', { allowExtension: false }); db.exec('PRAGMA trusted_schema=OFF; PRAGMA hard_heap_limit=67108864; PRAGMA max_page_count=16384'); return db; }; let db = create();
const q = x => '"' + x.replaceAll('"', '""') + '"';
const results = []; const applied = []; let error;
for (const file of files) { try { db.exec(file.content); applied.push(file.path); } catch(e) { error = {path:file.path, message: String(e.message)}; db.close(); db = create(); for (const previous of files.filter(x=>applied.includes(x.path))) db.exec(previous.content); break; } }
for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
 const name = row.name; const columns = db.prepare('PRAGMA table_info(' + q(name) + ')').all();
 const foreignKeys = db.prepare('PRAGMA foreign_key_list(' + q(name) + ')').all();
 const uniques = db.prepare('PRAGMA index_list(' + q(name) + ')').all().filter(x=>x.unique && !x.partial).map(x=>db.prepare('PRAGMA index_info(' + q(x.name) + ')').all().map(y=>y.name));
 results.push({name,columns,foreignKeys,uniques});
}
db.close(); process.stdout.write(JSON.stringify({tables:results,applied,error}));
`;

function sqliteSchema(schema: Schema, files: SourceFile[]) {
  const admitted: SourceFile[] = [];
  for (const file of files) {
    const tokens = sqlTokens(file.content);
    let unsafe = tokens.some((token) =>
      [
        "attach",
        "detach",
        "vacuum",
        "load_extension",
        "readfile",
        "writefile",
      ].includes(token),
    );
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "pragma") {
        const name = tokens[i + 2] === "." ? tokens[i + 3] : tokens[i + 1];
        if (
          ![
            "foreign_keys",
            "defer_foreign_keys",
            "legacy_alter_table",
            "user_version",
          ].includes(name)
        )
          unsafe = true;
      }
      if (tokens[i] === "virtual" && tokens[i + 1] === "table") unsafe = true;
    }
    if (unsafe) {
      schema.warn(
        "DATABASE_UNSAFE_SQLITE",
        "Migration contains an external-access or unsupported SQLite construct; reconstruction stopped before this migration.",
        evidenceFor(file),
      );
      break;
    }
    admitted.push(file);
  }
  try {
    const raw = execFileSync(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", SQLITE_RECONSTRUCT],
      {
        input: JSON.stringify(admitted),
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env.PATH },
      },
    );
    const result = JSON.parse(raw) as {
      applied: string[];
      error?: { path: string; message: string };
      tables: {
        name: string;
        columns: { name: string; type: string; notnull: number; pk: number }[];
        foreignKeys: {
          id: number;
          seq: number;
          table: string;
          from: string;
          to: string | null;
        }[];
        uniques: (string | null)[][];
      }[];
    };
    const provenance = files
      .filter((file) => result.applied.includes(file.path))
      .map((file) => evidenceFor(file));
    if (result.error)
      schema.warn(
        "DATABASE_SQLITE_RECONSTRUCTION_FAILED",
        "SQLite migration failed in the isolated schema database; this is only the successfully applied prefix, with failed migration effects discarded.",
        evidenceFor(files.find((file) => file.path === result.error!.path)!),
      );
    for (const row of result.tables) {
      // Every preceding migration can affect rename/rebuild lineage. Retain this conservative provenance.
      const table: Table = {
        name: row.name,
        dialect: "sqlite",
        columns: new Map(
          row.columns.map((column) => [
            column.name,
            {
              name: column.name,
              type: column.type || "any",
              notNull: !!column.notnull,
              evidence: provenance,
            },
          ]),
        ),
        constraints: [],
        evidence: provenance,
      };
      const primary = row.columns
        .filter((column) => column.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      if (primary.length)
        table.constraints.push({
          kind: "primary",
          columns: primary,
          evidence: provenance,
        });
      for (const columns of row.uniques)
        if (columns.every((value) => typeof value === "string"))
          table.constraints.push({
            kind: "unique",
            columns: columns as string[],
            evidence: provenance,
          });
      for (const id of new Set(row.foreignKeys.map((fk) => fk.id))) {
        const parts = row.foreignKeys
          .filter((fk) => fk.id === id)
          .sort((a, b) => a.seq - b.seq);
        table.constraints.push({
          kind: "foreign",
          columns: parts.map((fk) => fk.from),
          target: parts[0].table,
          targetColumns: parts.every((fk) => fk.to)
            ? parts.map((fk) => fk.to!)
            : undefined,
          evidence: provenance,
        });
      }
      schema.tables.set(table.name, table);
    }
  } catch {
    schema.warn(
      "DATABASE_SQLITE_RUNTIME_FAILED",
      "Isolated SQLite reconstruction failed or exceeded its time/output limit; Node.js 22.13+ with node:sqlite is required.",
      evidenceFor(files[0]),
    );
  }
}

function migrationGroup(file: string): string {
  const match = /^(.*(?:^|\/)(?:migrations|migration))(?:\/|$)/.exec(file);
  return match?.[1] ?? path.posix.dirname(file);
}

function d1Directories(files: SourceFile[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files.filter((item) =>
    /(?:^|\/)wrangler(?:\.[\w-]+)?\.jsonc?$/.test(item.path),
  )) {
    let config: any;
    try {
      config = parseJsonc(file.content);
    } catch {
      continue;
    }
    const visit = (value: any) => {
      if (!value || typeof value !== "object") return;
      for (const db of value.d1_databases ?? [])
        if (db && typeof db === "object")
          paths.add(
            path.posix.normalize(
              path.posix.join(
                path.posix.dirname(file.path),
                typeof db.migrations_dir === "string"
                  ? db.migrations_dir
                  : "migrations",
              ),
            ),
          );
      for (const env of Object.values(value.env ?? {})) visit(env);
    };
    visit(config);
  }
  return paths;
}

export const databaseExtractor: Extractor = {
  id: "database",
  extract(files) {
    const groups = new Map<string, SourceFile[]>();
    const d1 = d1Directories(files);
    for (const file of files
      .filter(
        (item) =>
          (/\.sql$/i.test(item.path) ||
            /(?:^|\/)(?:migrations|migration)\/.+\.[cm]?[jt]s$/.test(
              item.path,
            )) &&
          !/(?:\.down\.sql|\/down\/)/i.test(item.path),
      )
      .sort((a, b) => compare(a.path, b.path))) {
      const group = migrationGroup(file.path);
      groups.set(group, [...(groups.get(group) ?? []), file]);
    }
    const diagrams: Diagram[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const [group, sources] of groups) {
      const schema = new Schema(`data:schema:${group}`);
      const sqlite =
        d1.has(group) ||
        sources.some((file) =>
          /\bAUTOINCREMENT\b|\bPRAGMA\s+(?:foreign_keys|user_version)\b|--\s*mermaider:dialect\s+sqlite\b/i.test(
            file.content,
          ),
        );
      if (sqlite && sources.every((file) => /\.sql$/i.test(file.path)))
        sqliteSchema(schema, sources);
      else
        for (const file of sources) {
          if (/\.sql$/i.test(file.path))
            schema.sql(file.content, evidenceFor(file));
          else schema.pgMigration(file);
        }
      const diagram = schema.diagram(group);
      if (diagram.nodes.length || schema.diagnostics.length)
        diagrams.push(diagram);
      diagnostics.push(...schema.diagnostics);
    }
    return { diagrams, diagnostics };
  },
};
