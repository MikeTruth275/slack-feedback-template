// Bedrock Runtime client for the duplicate-detection rerank step.
// Calls Claude Haiku via Bedrock with the new feedback + JQL candidate list,
// asks for a strict-JSON ranked list back. IAM-authenticated (no API key).

const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";
const COMPANY_NAME = process.env.COMPANY_NAME || "your company";
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";
const BEDROCK_TIMEOUT_MS = Number(process.env.BEDROCK_TIMEOUT_MS || "4000");

let clientPromise = null;

async function getClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
    return new BedrockRuntimeClient({ region: BEDROCK_REGION });
  })();
  return clientPromise;
}

function buildPrompt(newFeedback, candidates) {
  const candidateLines = candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.key} [${c.status || "?"}]: ${truncate(c.summary, 200)}`
    )
    .join("\n");

  return `You are helping a product team identify duplicate feature requests. Given a new piece of feedback and a list of existing Jira tickets, score each ticket on how likely it is to be a duplicate of (or already covers) the new feedback.

New feedback:
Title: ${truncate(newFeedback.title || "", 200)}
Description: ${truncate(newFeedback.description || "", 800)}

Candidate tickets:
${candidateLines}

Return STRICT JSON (no prose, no markdown fences) shaped exactly:
{"matches":[{"key":"PROJ-123","score":0.0,"reason":"one short sentence"}]}

Rules:
- score is 0.0 to 1.0. 1.0 = clearly the same request. 0.0 = unrelated.
- Sort by score descending. Include at most the top 3.
- Only include tickets with score >= 0.2.
- reason must be a single short sentence (<=120 chars) explaining the overlap.
- If no ticket scores >= 0.2, return {"matches":[]}.`;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

// Race the Bedrock invoke against a timeout so a slow model call can't block
// the post-feedback flow indefinitely. AbortController cancels the in-flight
// request rather than just letting it dangle.
async function invokeWithTimeout(client, command, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await client.send(command, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Returns array of { key, score, reason } sorted desc, capped at 3.
// On any failure (timeout, parse error, IAM denied) returns a graceful
// fallback derived from the JQL order so the PM still sees something useful.
async function rerankCandidates({ feedback, candidates }) {
  if (!candidates || candidates.length === 0) return [];

  const fallback = candidates.slice(0, 3).map((c, i) => ({
    key: c.key,
    score: Math.max(0.2, 0.6 - i * 0.15),
    reason: "Matched on keywords (LLM rerank unavailable).",
  }));

  try {
    const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
    const client = await getClient();

    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 600,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildPrompt(feedback, candidates) }],
        },
      ],
    };

    const command = new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });

    const response = await invokeWithTimeout(client, command, BEDROCK_TIMEOUT_MS);
    const decoded = JSON.parse(Buffer.from(response.body).toString("utf8"));
    const text = decoded?.content?.[0]?.text?.trim() || "";

    // Be defensive: model occasionally wraps JSON in fences despite the
    // prompt. Strip leading/trailing fences before parsing.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned);
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];

    // Filter to known candidate keys to defend against the model hallucinating
    // a key. Re-clamp scores into [0,1].
    const validKeys = new Set(candidates.map((c) => c.key));
    const cleanMatches = matches
      .filter((m) => m && validKeys.has(m.key))
      .map((m) => ({
        key: m.key,
        score: Math.max(0, Math.min(1, Number(m.score) || 0)),
        reason: String(m.reason || "").slice(0, 200),
      }))
      .filter((m) => m.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return cleanMatches.length > 0 ? cleanMatches : [];
  } catch (error) {
    console.warn(
      "Bedrock rerank failed, using JQL fallback ordering:",
      error.message || error
    );
    return fallback;
  }
}

function buildRoutingPrompt(feedback, areas) {
  const areaLines = areas
    .map((a) => `- ${a.name}: ${truncate(a.description || "(no description)", 400)}`)
    .join("\n");

  const customerLine = feedback.customer ? `Customer: ${truncate(feedback.customer, 120)}\n` : "";
  const typeLine = feedback.type ? `Type: ${truncate(feedback.type, 60)}\n` : "";

  return `You are classifying a piece of customer feedback into one of a fixed set of product areas at ${COMPANY_NAME}. Pick the single best area, or return null if none clearly fits.

Product areas:
${areaLines}

Feedback:
${customerLine}${typeLine}Title: ${truncate(feedback.title || "", 200)}
Description: ${truncate(feedback.description || "", 1200)}

Return STRICT JSON (no prose, no markdown fences) shaped exactly:
{"area":"<area name or null>","confidence":0.0,"reason":"one short sentence"}

Rules:
- area must be EXACTLY one of the area names listed above, or null if none clearly fits.
- confidence is 0.0 to 1.0. 1.0 = unambiguous fit. Below ~0.5 = weak signal.
- reason must be a single short sentence (<=160 chars) explaining the choice.`;
}

// Classifies feedback into one of the provided product areas. Returns
// { area, confidence, reason } or null on failure/timeout/no-match. Never
// throws -- routing-nudge is a best-effort enhancement, never a blocker.
async function classifyRouting({ feedback, areas }) {
  if (!areas || areas.length === 0) return null;

  try {
    const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
    const client = await getClient();

    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildRoutingPrompt(feedback, areas) }],
        },
      ],
    };

    const command = new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });

    const response = await invokeWithTimeout(client, command, BEDROCK_TIMEOUT_MS);
    const decoded = JSON.parse(Buffer.from(response.body).toString("utf8"));
    const text = decoded?.content?.[0]?.text?.trim() || "";

    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned);

    if (!parsed || parsed.area == null) return null;

    // Defend against the model inventing an area name.
    const validNames = new Set(areas.map((a) => a.name));
    if (!validNames.has(parsed.area)) return null;

    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const reason = String(parsed.reason || "").slice(0, 200);

    return { area: parsed.area, confidence, reason };
  } catch (error) {
    console.warn(
      "Bedrock routing classifier failed:",
      error.message || error
    );
    return null;
  }
}

module.exports = { rerankCandidates, classifyRouting };
