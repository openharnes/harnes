import {
  defaultModelForTier,
  getModel,
  type ModelSpec,
  type QualityTier,
} from "./catalog.ts";

export type RouteKind = "explore" | "compact" | "build" | "hard";

export interface RouterConfig {
  fastOpenId: string;
  strongOpenId: string;
  frontierByokId?: string;
  allowFrontier: boolean;
}

export const DEFAULT_ROUTER: RouterConfig = {
  fastOpenId: "qwen3-coder-8b",
  strongOpenId: "qwen3-coder-30b",
  frontierByokId: "claude-sonnet",
  allowFrontier: false,
};

export function routeTask(kind: RouteKind, config: RouterConfig = DEFAULT_ROUTER): ModelSpec {
  if (kind === "explore" || kind === "compact") {
    return getModel(config.fastOpenId);
  }
  if (kind === "hard" && config.allowFrontier && config.frontierByokId) {
    return getModel(config.frontierByokId);
  }
  return getModel(config.strongOpenId);
}

export function tierForRoute(kind: RouteKind, allowFrontier: boolean): QualityTier {
  if (kind === "explore" || kind === "compact") return "fast-open";
  if (kind === "hard" && allowFrontier) return "frontier-byok";
  return "strong-open";
}

export function inferRouteKind(prompt: string): RouteKind {
  const text = prompt.toLowerCase();
  if (/\b(compact|summarize conversation|compress context)\b/.test(text)) return "compact";
  if (/\b(explore|search|where is|explain|read-only|plan|what'?s in|whats in this|list files)\b/.test(text)) return "explore";
  if (/\b(architect|multi-file|refactor the whole|migrate|redesign)\b/.test(text)) return "hard";
  return "build";
}

export { defaultModelForTier };
