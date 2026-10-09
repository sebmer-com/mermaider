import path from "node:path";
import ts from "typescript";
import type {
  Diagram,
  Diagnostic,
  Evidence,
  Extractor,
  GraphEdge,
  GraphNode,
  SourceFile,
} from "../types.js";
import { sha256, stableId } from "../util.js";

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const compare = (a: string, b: string) => a.localeCompare(b, "en");
const isText = (
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Extracts declarations, never a whole-program execution or control-flow graph. */
export const codeExtractor: Extractor = {
  id: "code",
  extract(files) {
    const sources = files
      .filter((file) => CODE.test(file.path))
      .sort((a, b) => compare(a.path, b.path));
    const known = new Set(sources.map((file) => file.path));
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const diagrams: Diagram[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const file of sources) {
      const ast = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
      );
      const evidence = (node: ts.Node, symbol?: string): Evidence => ({
        path: file.path,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        sha256: sha256(file.content),
        ...(symbol ? { symbol } : {}),
      });
      const note = (code: string, message: string, diagramId?: string) => {
        const value: Diagnostic = {
          code,
          message,
          severity: "warning",
          path: file.path,
          ...(diagramId ? { diagramId } : {}),
        };
        diagnostics.push(value);
        return value;
      };
      const scopedName = (node: ts.Node, ownName: string): string => {
        const names = [ownName];
        let parent = node.parent;
        while (parent && !ts.isSourceFile(parent)) {
          if (
            (ts.isClassDeclaration(parent) ||
              ts.isClassExpression(parent) ||
              ts.isModuleDeclaration(parent) ||
              ts.isFunctionDeclaration(parent)) &&
            parent.name
          )
            names.unshift(parent.name.getText(ast));
          parent = parent.parent;
        }
        return names.join(".");
      };
      if (
        (ast as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
          .parseDiagnostics?.length
      )
        note(
          "CODE_PARSE_ERROR",
          "This source contains syntax errors; extracted declarations may be incomplete.",
        );
      const workflowStepTypes = new Set<string>();
      for (const statement of ast.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !isText(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== "cloudflare:workers"
        )
          continue;
        const binding = statement.importClause?.namedBindings;
        if (binding && ts.isNamedImports(binding))
          for (const element of binding.elements)
            if ((element.propertyName ?? element.name).text === "WorkflowStep")
              workflowStepTypes.add(element.name.text);
        if (binding && ts.isNamespaceImport(binding))
          workflowStepTypes.add(`${binding.name.text}.WorkflowStep`);
      }
      const importDependency = (
        specifier: string,
        node: ts.Node,
        kind: string,
      ) => {
        let target = specifier;
        if (specifier.startsWith(".")) {
          const base = path.posix.normalize(
            path.posix.join(path.posix.dirname(file.path), specifier),
          );
          const stem = base.replace(/\.[cm]?jsx?$/, "");
          const candidates = [
            base,
            ...[
              ".ts",
              ".tsx",
              ".mts",
              ".cts",
              ".js",
              ".jsx",
              ".mjs",
              ".cjs",
            ].map((ext) => stem + ext),
            ...["index.ts", "index.tsx", "index.js"].map((name) =>
              path.posix.join(base, name),
            ),
          ];
          target = candidates.find((candidate) => known.has(candidate)) ?? base;
          if (!known.has(target))
            note(
              "CODE_UNRESOLVED_IMPORT",
              `Relative import ${specifier} is not resolved in the selected source files.`,
              "code:dependencies",
            );
        }
        const from = stableId("module", file.path);
        const to = stableId(
          specifier.startsWith(".") ? "module" : "import",
          target,
        );
        if (!nodes.has(from))
          nodes.set(from, {
            id: from,
            label: file.path,
            kind: "module",
            evidence: [evidence(ast)],
          });
        if (!nodes.has(to))
          nodes.set(to, {
            id: to,
            label: target,
            kind: specifier.startsWith(".") ? "module" : "import-specifier",
            evidence: [evidence(node)],
          });
        const id = stableId("import", `${from}\0${to}\0${kind}`);
        const old = edges.get(id);
        if (old) old.evidence.push(evidence(node));
        else
          edges.set(id, {
            id,
            from,
            to,
            label: kind,
            kind: "dependency",
            evidence: [evidence(node)],
          });
      };
      walk(ast, (node) => {
        if (ts.isImportDeclaration(node) && isText(node.moduleSpecifier))
          importDependency(
            node.moduleSpecifier.text,
            node,
            node.importClause?.isTypeOnly ? "imports type" : "imports",
          );
        if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          isText(node.moduleSpecifier)
        )
          importDependency(node.moduleSpecifier.text, node, "re-exports");
        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression &&
          isText(node.moduleReference.expression)
        )
          importDependency(
            node.moduleReference.expression.text,
            node,
            "imports",
          );
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === "require"))
        ) {
          const arg = node.arguments[0];
          if (arg && isText(arg)) importDependency(arg.text, node, "loads");
          else
            note(
              "CODE_DYNAMIC_IMPORT",
              "Dynamic module expression cannot be resolved statically.",
              "code:dependencies",
            );
        }
        const name =
          ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node)
            ? scopedName(node, node.name.text)
            : undefined;
        if (!name) return;
        let values: { value: string; node: ts.Node }[] = [];
        if (ts.isEnumDeclaration(node))
          values = node.members.map((member) => ({
            value: member.name.getText(ast),
            node: member,
          }));
        if (
          ts.isTypeAliasDeclaration(node) &&
          /(?:state|status)(?:s)?$/i.test(name) &&
          ts.isUnionTypeNode(node.type)
        ) {
          values = node.type.types.flatMap((type) =>
            ts.isLiteralTypeNode(type) &&
            (isText(type.literal) || ts.isNumericLiteral(type.literal))
              ? [{ value: type.literal.text, node: type }]
              : [],
          );
          if (values.length !== node.type.types.length)
            note(
              "CODE_PARTIAL_STATE_VALUES",
              `State alias ${name} includes non-literal members; only explicit values are listed.`,
              `code:states:${file.path}:${name}`,
            );
        }
        if (values.length)
          diagrams.push({
            id: `code:states:${file.path}:${name}`,
            title: `${name}: declared values (transitions unspecified)`,
            family: "states",
            syntax: "state",
            provenance: "extracted",
            context: "implemented",
            nodes: values.map((value) => ({
              id: stableId("state", `${file.path}\0${name}\0${value.value}`),
              label: value.value,
              kind: "declared-value",
              evidence: [evidence(value.node, name)],
            })),
            edges: [],
          });
      });

      // A typed WorkflowStep parameter identifies the API, rather than any arbitrary .do().
      const workflowId = `code:workflow:${file.path}`;
      const workflowNodes: GraphNode[] = [];
      const workflowEdges: GraphEdge[] = [];
      const workflowDiagnostics: Diagnostic[] = [];
      const owners = new Map<
        ts.Node,
        { id: string; name: string; step: string }
      >();
      walk(ast, (node) => {
        if (
          !ts.isFunctionDeclaration(node) &&
          !ts.isMethodDeclaration(node) &&
          !ts.isArrowFunction(node) &&
          !ts.isFunctionExpression(node)
        )
          return;
        const parameter = node.parameters.find((param) => {
          if (!param.type || !ts.isIdentifier(param.name)) return false;
          let matches = false;
          walk(param.type, (child) => {
            if (
              ts.isTypeReferenceNode(child) &&
              workflowStepTypes.has(child.typeName.getText(ast))
            )
              matches = true;
          });
          return matches;
        });
        if (!parameter || !ts.isIdentifier(parameter.name)) return;
        const name = scopedName(
          node,
          node.name?.getText(ast) ??
            (ts.isVariableDeclaration(node.parent)
              ? node.parent.name.getText(ast)
              : `anonymous@${evidence(node).line}`),
        );
        owners.set(node, {
          id: stableId("workflow", `${file.path}\0${name}`),
          name,
          step: parameter.name.text,
        });
      });
      const duplicateSteps = new Map<string, number>();
      walk(ast, (node) => {
        if (
          !ts.isCallExpression(node) ||
          !ts.isPropertyAccessExpression(node.expression) ||
          !["do", "sleep", "sleepUntil", "waitForEvent"].includes(
            node.expression.name.text,
          ) ||
          !ts.isIdentifier(node.expression.expression)
        )
          return;
        const stepReceiver = node.expression.expression.text;
        let parent: ts.Node | undefined = node.parent;
        let owner: ReturnType<typeof owners.get>;
        let conditional = false;
        while (parent) {
          if (
            ts.isIfStatement(parent) ||
            ts.isSwitchStatement(parent) ||
            ts.isConditionalExpression(parent) ||
            ts.isIterationStatement(parent, false) ||
            ts.isTryStatement(parent)
          )
            conditional = true;
          if (owners.has(parent)) {
            owner = owners.get(parent);
            break;
          }
          if (
            (ts.isArrowFunction(parent) ||
              ts.isFunctionExpression(parent) ||
              ts.isFunctionDeclaration(parent) ||
              ts.isMethodDeclaration(parent)) &&
            parent.parameters.some(
              (parameter) =>
                ts.isIdentifier(parameter.name) &&
                parameter.name.text === stepReceiver,
            )
          )
            break;
          parent = parent.parent;
        }
        if (!owner || owner.step !== node.expression.expression.text) return;
        if (!workflowNodes.some((value) => value.id === owner!.id))
          workflowNodes.push({
            id: owner.id,
            label: owner.name,
            kind: "workflow-function",
            evidence: [evidence(parent!, owner.name)],
          });
        const first = node.arguments[0];
        const staticName = first && isText(first) ? first.text : null;
        const label =
          staticName ?? `[dynamic ${node.expression.name.text} step]`;
        const key = `${owner.id}\0${node.expression.name.text}\0${label}`;
        const count = duplicateSteps.get(key) ?? 0;
        duplicateSteps.set(key, count + 1);
        const id = stableId("step", `${key}\0${count}`);
        workflowNodes.push({
          id,
          label,
          kind: `workflow-${node.expression.name.text}`,
          evidence: [evidence(node, owner.name)],
        });
        workflowEdges.push({
          id: stableId("declares", id),
          from: owner.id,
          to: id,
          label: `declares ${node.expression.name.text}`,
          kind: "declaration",
          evidence: [evidence(node, owner.name)],
        });
        if (!staticName)
          workflowDiagnostics.push(
            note(
              "CODE_DYNAMIC_WORKFLOW_STEP",
              `A step name in ${owner.name} is dynamic; its possible runtime values are unknown.`,
              workflowId,
            ),
          );
        if (conditional)
          workflowDiagnostics.push(
            note(
              "CODE_WORKFLOW_BRANCH_OR_LOOP",
              `Step ${label} is inside conditional, loop or error-handling code; execution paths and repetitions are not inferred.`,
              workflowId,
            ),
          );
      });
      if (workflowNodes.length) {
        workflowDiagnostics.push(
          note(
            "CODE_WORKFLOW_STRUCTURE_ONLY",
            "This diagram shows declared workflow steps and ownership, not execution order, complete call paths or runtime transitions.",
            workflowId,
          ),
        );
        diagrams.push({
          id: workflowId,
          title: `${file.path}: workflow step declarations`,
          family: "pipeline",
          syntax: "flowchart",
          provenance: "extracted",
          context: "implemented",
          nodes: workflowNodes,
          edges: workflowEdges,
          diagnostics: workflowDiagnostics,
        });
      }
    }
    if (nodes.size)
      diagrams.unshift({
        id: "code:dependencies",
        title: "Declared module dependencies (unresolved specifiers retained)",
        family: "dependencies",
        syntax: "flowchart",
        provenance: "extracted",
        context: "implemented",
        nodes: [...nodes.values()],
        edges: [...edges.values()],
        diagnostics: diagnostics.filter(
          (item) => item.diagramId === "code:dependencies",
        ),
      });
    return { diagrams, diagnostics };
  },
};
