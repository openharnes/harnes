import { assertAgentic, isRejectedModelId, MODEL_CATALOG, WEAK_MODEL_MESSAGE } from "./models/catalog.ts";
import { inferRouteKind, routeTask, type RouterConfig } from "./models/router.ts";

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function runSmokeSuite(router: RouterConfig): SmokeResult[] {
  const results: SmokeResult[] = [];

  results.push({
    name: "reject-weak-models",
    ok: isRejectedModelId("gpt-oss:20b"),
    detail: isRejectedModelId("gpt-oss:20b") ? "gpt-oss:20b is blocked" : "weak model was not blocked",
  });

  for (const model of MODEL_CATALOG) {
    try {
      assertAgentic(model);
      results.push({
        name: `catalog-${model.id}`,
        ok: model.toolCalling === "reliable",
        detail: `${model.name} toolCalling=${model.toolCalling}`,
      });
    } catch (error) {
      results.push({
        name: `catalog-${model.id}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const explore = routeTask("explore", router);
  results.push({
    name: "route-explore-fast-open",
    ok: explore.tier === "fast-open",
    detail: `${explore.id} (${explore.tier})`,
  });

  const build = routeTask("build", router);
  results.push({
    name: "route-build-strong-open",
    ok: build.tier === "strong-open",
    detail: `${build.id} (${build.tier})`,
  });

  const hardClosed = routeTask("hard", { ...router, allowFrontier: false });
  results.push({
    name: "route-hard-stays-open-without-byok",
    ok: hardClosed.kind === "open",
    detail: `${hardClosed.id}`,
  });

  const inferred = inferRouteKind("compact the conversation");
  results.push({
    name: "infer-compact",
    ok: inferred === "compact",
    detail: inferred,
  });

  results.push({
    name: "weak-model-message",
    ok: WEAK_MODEL_MESSAGE.includes("too weak"),
    detail: WEAK_MODEL_MESSAGE,
  });

  return results;
}

export function smokePassed(results: SmokeResult[]): boolean {
  return results.every((result) => result.ok);
}
