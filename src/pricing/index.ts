// Fetches and caches model specs from models.dev (zai provider)
// Costs in the TOML are per 1M tokens in USD

const GITHUB_RAW =
  "https://raw.githubusercontent.com/sst/models.dev/refs/heads/dev/providers/zai/models";
const MODEL_LIST_API =
  "https://api.github.com/repos/sst/models.dev/contents/providers/zai/models";

export interface ModelCost {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export interface ModelSpec {
  name: string;
  tool_call: boolean;
  reasoning: boolean;
  attachment: boolean;
  temperature: boolean;
  interleaved?: { field: string };
  cost: ModelCost;
  limit: ModelLimit;
  modalities?: { input: string[]; output: string[] };
}

const cache = new Map<string, ModelSpec>();
let lastFetch = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

// Fallback pricing for new models not yet in models.dev
// Costs are per 1M tokens in USD
const FALLBACK_PRICING: Record<string, ModelSpec> = {
  "glm-5.1": {
    name: "GLM-5.1",
    tool_call: true,
    reasoning: true,
    attachment: false,
    temperature: true,
    interleaved: { field: "reasoning_content" },
    cost: { input: 1.50, output: 4.80, cache_read: 0.30, cache_write: 0 },
    limit: { context: 200000, output: 131072 },
    modalities: { input: ["text"], output: ["text"] },
  },
};

function parseToml(raw: string): Record<string, any> {
  const result: Record<string, any> = {};
  let currentSection: string | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch?.[1]) {
      currentSection = sectionMatch[1];
      result[currentSection] = result[currentSection] || {};
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch?.[1] && kvMatch[2]) {
      const key = kvMatch[1];
      let value: any = kvMatch[2].trim();

      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1);
      else if (value.startsWith("[")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((v: string) => v.trim().replace(/"/g, ""))
          .filter(Boolean);
      } else {
        const num = Number(value.replace(/_/g, ""));
        if (!isNaN(num)) value = num;
      }

      if (currentSection) {
        result[currentSection][key] = value;
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

async function fetchModelList(): Promise<string[]> {
  const resp = await fetch(MODEL_LIST_API, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });

  if (!resp.ok) {
    console.error(`Failed to fetch model list: ${resp.status}`);
    return [];
  }

  const items = (await resp.json()) as { name: string }[];
  return items
    .filter((i) => i.name.endsWith(".toml"))
    .map((i) => i.name.replace(".toml", ""));
}

async function fetchModelSpec(modelId: string): Promise<ModelSpec | null> {
  const resp = await fetch(`${GITHUB_RAW}/${modelId}.toml`);
  if (!resp.ok) return null;

  const raw = await resp.text();
  const p = parseToml(raw);

  if (!p.cost || !p.limit) return null;

  return {
    name: p.name || modelId,
    tool_call: p.tool_call ?? false,
    reasoning: p.reasoning ?? false,
    attachment: p.attachment ?? false,
    temperature: p.temperature ?? false,
    ...(p.interleaved?.field ? { interleaved: { field: p.interleaved.field } } : {}),
    cost: {
      input: p.cost.input ?? 0,
      output: p.cost.output ?? 0,
      cache_read: p.cost.cache_read ?? 0,
      cache_write: p.cost.cache_write ?? 0,
    },
    limit: {
      context: p.limit.context ?? 128000,
      output: p.limit.output ?? 8192,
    },
    ...(p.modalities ? { modalities: p.modalities } : {}),
  };
}

export async function refreshPricing(): Promise<void> {
  const modelIds = await fetchModelList();
  const results = await Promise.allSettled(
    modelIds.map((id) => fetchModelSpec(id).then((s) => [id, s] as const))
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value[1]) {
      cache.set(result.value[0], result.value[1]);
    }
  }

  lastFetch = Date.now();
  console.log(`Model cache loaded: ${cache.size} models`);
}

export async function ensurePricing(): Promise<void> {
  if (Date.now() - lastFetch > CACHE_TTL || cache.size === 0) {
    await refreshPricing();
  }
}

export function getModelSpec(modelId: string): ModelSpec | null {
  return cache.get(modelId) || FALLBACK_PRICING[modelId] || null;
}

export function listModels(): Map<string, ModelSpec> {
  return cache;
}

// 4-tier cost calculation matching closedrouter's approach:
// cache tokens are subtracted from input to avoid double-billing
export function calculateCostCents(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): number {
  const spec = cache.get(modelId) || FALLBACK_PRICING[modelId];
  if (!spec) {
    const inputCost = (inputTokens / 1_000_000) * 10;
    const outputCost = (outputTokens / 1_000_000) * 30;
    return Math.ceil((inputCost + outputCost) * 100);
  }

  const uncachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const inputCost = (uncachedInput / 1_000_000) * spec.cost.input;
  const outputCost = (outputTokens / 1_000_000) * spec.cost.output;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * spec.cost.cache_read;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * spec.cost.cache_write;

  return Math.ceil((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100);
}
