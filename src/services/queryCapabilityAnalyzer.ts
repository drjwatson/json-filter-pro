import { parseQueryText } from "./jsonQueryService";

export interface LargeQueryPlan {
  isLargeFileSafe: boolean;
  reason?: string;
  filterAst?: unknown;
  postFilterAst?: unknown;
  queryLimit?: number;
}

function isFunctionCall(node: unknown, name: string): node is [string, ...unknown[]] {
  return Array.isArray(node) && node.length > 0 && node[0] === name;
}

function readLimit(step: unknown): number | undefined {
  if (!isFunctionCall(step, "limit") || step.length < 2) {
    return undefined;
  }

  const value = step[1];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

export async function analyzeLargeFileCompatibility(queryText: string): Promise<LargeQueryPlan> {
  let ast: unknown;
  try {
    ast = (await parseQueryText(queryText)).ast;
  } catch (error) {
    return {
      isLargeFileSafe: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  if (isFunctionCall(ast, "filter")) {
    return {
      isLargeFileSafe: true,
      filterAst: ast
    };
  }

  if (!isFunctionCall(ast, "pipe")) {
    return {
      isLargeFileSafe: false,
      reason: "Large-file mode supports filter(...) and filter-first pipelines."
    };
  }

  const steps = ast.slice(1);
  if (steps.length === 0) {
    return {
      isLargeFileSafe: false,
      reason: "The query pipeline is empty."
    };
  }

  let cursor = 0;

  if (isFunctionCall(steps[cursor], "get")) {
    const getStep = steps[cursor] as [string, ...unknown[]];
    const hasNoArgs = getStep.length === 1;
    if (!hasNoArgs) {
      return {
        isLargeFileSafe: false,
        reason: "Large-file mode only supports get() without path before filter(...)."
      };
    }
    cursor += 1;
  }

  if (cursor >= steps.length || !isFunctionCall(steps[cursor], "filter")) {
    return {
      isLargeFileSafe: false,
      reason: "Large-file mode requires filter(...) as the first effective pipeline step."
    };
  }

  const filterAst = steps[cursor];
  cursor += 1;

  const trailingSteps = steps.slice(cursor);
  if (trailingSteps.length === 0) {
    return {
      isLargeFileSafe: true,
      filterAst
    };
  }

  let queryLimit: number | undefined;
  if (isFunctionCall(trailingSteps[0], "limit")) {
    queryLimit = readLimit(trailingSteps[0]);
    if (queryLimit === undefined) {
      return {
        isLargeFileSafe: false,
        reason: "limit(...) in large-file mode must be a finite numeric value."
      };
    }
  }

  const postFilterAst = trailingSteps.length === 1
    ? trailingSteps[0]
    : ["pipe", ...trailingSteps];

  return {
    isLargeFileSafe: true,
    filterAst,
    postFilterAst,
    queryLimit
  };
}
