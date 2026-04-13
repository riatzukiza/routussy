// End-to-end proxy test against zai API - no Discord needed
import { migrate, getDb } from "./src/db";
import { ensureGuild, ensureUser, setUserBudget } from "./src/db/users";
import { createKey } from "./src/keys";
import { createProxyRoutes } from "./src/proxy";
import { AbsoluteQuotaAdapter } from "./src/quota";
import { ensurePricing } from "./src/pricing";

const UPSTREAM_URL = process.env.UPSTREAM_URL || "https://api.z.ai/api/paas/v4";
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY!;
if (!UPSTREAM_API_KEY) {
  console.error("Set UPSTREAM_API_KEY env var to run this test");
  process.exit(1);
}
const PORT = 3999;

process.env.DATABASE_PATH = ":memory:";

async function setup() {
  await migrate();
  await ensurePricing();

  await ensureGuild("test-guild");
  const userId = await ensureUser("test-user", "test-guild");
  await setUserBudget(userId, 100_00); // $100

  const key = await createKey(userId, "test-key", null);
  return key;
}

async function main() {
  console.log("Setting up test environment...");
  const key = await setup();
  console.log(`Test key: ${key.prefix}...`);

  const quota = new AbsoluteQuotaAdapter();
  const routes = createProxyRoutes({
    upstreamUrl: UPSTREAM_URL,
    upstreamApiKey: UPSTREAM_API_KEY,
    upstreamPrefix: process.env.UPSTREAM_PREFIX ?? "",
    quota,
  });

  Bun.serve({
    port: PORT,
    routes: {
      ...routes,
      "/health": {
        GET: () => Response.json({ ok: true }),
      },
    },
    fetch() {
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  console.log(`Proxy running on http://localhost:${PORT}`);
  console.log("---");

  // Test 1: Models endpoint
  console.log("Test 1: GET /v1/models");
  const modelsResp = await fetch(`http://localhost:${PORT}/v1/models`, {
    headers: { Authorization: `Bearer ${key.rawKey}` },
  });
  const models = await modelsResp.json();
  console.log(`  Status: ${modelsResp.status}`);
  console.log(`  Models: ${(models as any).data?.map((m: any) => m.id).join(", ")}`);
  console.log("---");

  // Test 2: Chat completions (non-streaming)
  console.log("Test 2: POST /v1/chat/completions (non-streaming)");
  const chatResp = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.rawKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "glm-4.5-air",
      messages: [{ role: "user", content: "Say hello in exactly 5 words." }],
    }),
  });
  const chatBody = await chatResp.json() as any;
  console.log(`  Status: ${chatResp.status}`);
  console.log(`  Model: ${chatBody.model}`);
  console.log(`  Response: ${chatBody.choices?.[0]?.message?.content}`);
  console.log(`  Usage: ${JSON.stringify(chatBody.usage)}`);
  console.log("---");

  // Check quota after non-streaming
  const db = getDb();
  const usageLog = await db.selectFrom("usage_log").selectAll().execute();
  console.log(`  Usage log entries: ${usageLog.length}`);
  if (usageLog[0]) {
    console.log(`  Recorded: model=${usageLog[0].model} in=${usageLog[0].input_tokens} out=${usageLog[0].output_tokens} cost=${usageLog[0].cost_cents}c`);
  }

  const userRow = await db.selectFrom("users").selectAll().where("discord_id", "=", "test-user").executeTakeFirst();
  console.log(`  User spent: ${userRow?.spent_cents}c / ${userRow?.budget_cents}c`);
  console.log("---");

  // Test 3: Chat completions (streaming)
  console.log("Test 3: POST /v1/chat/completions (streaming)");
  const streamResp = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.rawKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "glm-4.5-air",
      messages: [{ role: "user", content: "Count from 1 to 5, one number per line." }],
      stream: true,
    }),
  });
  console.log(`  Status: ${streamResp.status}`);
  console.log(`  Content-Type: ${streamResp.headers.get("Content-Type")}`);

  const streamText = await streamResp.text();
  const sseLines = streamText.split("\n").filter((l) => l.startsWith("data:"));
  console.log(`  SSE data lines: ${sseLines.length}`);

  // show last few lines
  const lastLines = sseLines.slice(-3);
  for (const line of lastLines) {
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      console.log("  Last: [DONE]");
    } else {
      try {
        const parsed = JSON.parse(payload);
        if (parsed.usage) {
          console.log(`  Usage from stream: ${JSON.stringify(parsed.usage)}`);
        }
      } catch {}
    }
  }

  // wait a moment for async usage recording
  await Bun.sleep(500);

  const usageLog2 = await db.selectFrom("usage_log").selectAll().execute();
  console.log(`  Usage log entries after streaming: ${usageLog2.length}`);
  if (usageLog2[1]) {
    console.log(`  Recorded: model=${usageLog2[1].model} in=${usageLog2[1].input_tokens} out=${usageLog2[1].output_tokens} cost=${usageLog2[1].cost_cents}c`);
  }

  const userRow2 = await db.selectFrom("users").selectAll().where("discord_id", "=", "test-user").executeTakeFirst();
  console.log(`  User spent: ${userRow2?.spent_cents}c / ${userRow2?.budget_cents}c`);
  console.log("---");

  // Test 4: Invalid key
  console.log("Test 4: Invalid API key");
  const badResp = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: "Bearer rsy-invalidkey",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "glm-4.5-air",
      messages: [{ role: "user", content: "test" }],
    }),
  });
  console.log(`  Status: ${badResp.status}`);
  const badBody = await badResp.json() as any;
  console.log(`  Error: ${badBody.error?.message}`);
  console.log("---");

  // Test 5: Image generation
  console.log("Test 5: POST /v1/images/generations");
  const imageResp = await fetch(`http://localhost:${PORT}/v1/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.rawKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "glm-image",
      prompt: "A simple red circle on white background, minimal",
      size: "1024x1024",
      n: 1,
    }),
  });
  const imageBody = await imageResp.json() as any;
  console.log(`  Status: ${imageResp.status}`);
  if (imageResp.ok && imageBody.data) {
    console.log(`  Images generated: ${imageBody.data.length}`);
    console.log(`  Image URL: ${imageBody.data[0]?.url?.slice(0, 60)}...`);
  } else {
    console.log(`  Error: ${JSON.stringify(imageBody.error || imageBody)}`);
  }
  console.log("---");

  // Check quota after image generation
  await Bun.sleep(500);
  const usageLog3 = await db.selectFrom("usage_log").selectAll().execute();
  console.log(`  Usage log entries after image: ${usageLog3.length}`);
  const imageUsage = usageLog3.find(e => e.endpoint === "images");
  if (imageUsage) {
    console.log(`  Image cost recorded: ${imageUsage.cost_cents}c`);
  }

  const userRow3 = await db.selectFrom("users").selectAll().where("discord_id", "=", "test-user").executeTakeFirst();
  console.log(`  User spent: ${userRow3?.spent_cents}c / ${userRow3?.budget_cents}c`);
  console.log("---");

  console.log("All tests complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
