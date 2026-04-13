// Proxy-only entry point - no Discord required
// For dev instances and standalone proxy deployments

import { migrate } from "./db";
import { createProxyRoutes } from "./proxy";
import { AbsoluteQuotaAdapter } from "./quota";
import { ensurePricing } from "./pricing";
import { ensureGuild, ensureUser, setUserBudget } from "./db/users";
import { createKey, listUserKeys } from "./keys";

const REQUIRED_ENV = ["UPSTREAM_URL", "UPSTREAM_API_KEY"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || "3010");
const UPSTREAM_URL = process.env.UPSTREAM_URL!;
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY!;
const UPSTREAM_PREFIX = process.env.UPSTREAM_PREFIX ?? "";
const IMAGE_COST_CENTS = parseFloat(process.env.IMAGE_COST_CENTS ?? "1.5");

// Default user/key for dev instances
const DEV_GUILD_ID = process.env.DEV_GUILD_ID ?? "dev-guild";
const DEV_USER_ID = process.env.DEV_USER_ID ?? "dev-user";
const DEV_USER_BUDGET = parseInt(process.env.DEV_USER_BUDGET ?? "100000"); // $1000 default

async function main() {
  console.log("Running migrations...");
  await migrate();

  console.log("Loading pricing data...");
  await ensurePricing();

  // Setup dev user and key
  console.log("Setting up dev user...");
  await ensureGuild(DEV_GUILD_ID);
  const userId = await ensureUser(DEV_USER_ID, DEV_GUILD_ID);
  await setUserBudget(userId, DEV_USER_BUDGET);

  // Check for existing keys or create one
  const existingKeys = await listUserKeys(userId);
  let apiKey: string;

  if (existingKeys.length > 0) {
    const activeKey = existingKeys.find((k) => k.active);
    if (activeKey) {
      console.log(`Using existing API key: ${activeKey.key_prefix}...`);
      apiKey = process.env.DEV_API_KEY ?? ""; // User must provide via env
    } else {
      console.log("No active keys found, creating new one...");
      const newKey = await createKey(userId, "dev-key", null);
      apiKey = newKey.rawKey;
      console.log(`Created API key: ${newKey.prefix}...`);
      console.log(`Full key (save this): ${newKey.rawKey}`);
    }
  } else {
    const newKey = await createKey(userId, "dev-key", null);
    apiKey = newKey.rawKey;
    console.log(`Created API key: ${newKey.prefix}...`);
    console.log(`Full key (save this): ${newKey.rawKey}`);
  }

  const quota = new AbsoluteQuotaAdapter();
  const proxyRoutes = createProxyRoutes({
    upstreamUrl: UPSTREAM_URL,
    upstreamApiKey: UPSTREAM_API_KEY,
    upstreamPrefix: UPSTREAM_PREFIX,
    imageCostCents: IMAGE_COST_CENTS,
    quota,
  });

  Bun.serve({
    port: PORT,
    routes: {
      ...proxyRoutes,
      "/health": {
        GET: () => Response.json({ status: "ok", timestamp: new Date().toISOString() }),
      },
      "/config": {
        GET: () =>
          Response.json({
            upstream: UPSTREAM_URL,
            prefix: UPSTREAM_PREFIX,
            imageCostCents: IMAGE_COST_CENTS,
          }),
      },
    },
    fetch(req) {
      return Response.json(
        { error: { message: "Not found", type: "error", code: 404 } },
        { status: 404 }
      );
    },
  });

  console.log(`Routussy proxy listening on http://localhost:${PORT}`);
  console.log(`Upstream: ${UPSTREAM_URL}`);
  console.log(`Image cost: ${IMAGE_COST_CENTS}c per image`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
