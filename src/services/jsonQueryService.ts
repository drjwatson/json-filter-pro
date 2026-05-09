interface JsonQueryModule {
  parse: (queryText: string) => unknown;
  stringify: (queryAst: unknown) => string;
  jsonquery: (data: unknown, query: unknown) => unknown;
  compile: (queryAst: unknown) => (data: unknown) => unknown;
}

let modulePromise: Promise<JsonQueryModule> | undefined;

function getJsonQueryModule(): Promise<JsonQueryModule> {
  if (!modulePromise) {
    modulePromise = import("@jsonquerylang/jsonquery");
  }

  return modulePromise;
}

export interface ParsedQuery {
  ast: unknown;
  normalizedText: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function parseQueryText(queryText: string): Promise<ParsedQuery> {
  const { parse, stringify } = await getJsonQueryModule();
  const ast = parse(queryText);
  const normalizedText = stringify(ast);

  return {
    ast,
    normalizedText
  };
}

export async function executeFullDocumentQuery(data: unknown, queryText: string): Promise<unknown> {
  const { jsonquery } = await getJsonQueryModule();
  return jsonquery(data, queryText);
}

export async function compileQueryAst(ast: unknown): Promise<(data: unknown) => unknown> {
  const { compile } = await getJsonQueryModule();
  return compile(ast as never) as (data: unknown) => unknown;
}

export function formatQueryError(error: unknown): string {
  const message = toErrorMessage(error);
  const stack = error && typeof error === "object" && "jsonquery" in error
    ? Reflect.get(error, "jsonquery")
    : undefined;

  if (!stack || !Array.isArray(stack) || stack.length === 0) {
    return message;
  }

  const firstStackItem = stack[stack.length - 1];
  if (!firstStackItem || typeof firstStackItem !== "object") {
    return message;
  }

  const queryPart = Reflect.get(firstStackItem, "query");
  if (!queryPart) {
    return message;
  }

  return `${message} (while evaluating ${JSON.stringify(queryPart)})`;
}
