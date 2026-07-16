import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeLocally, normalizeDecisions } from "./src/analyze.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 4173);
const maxBodyBytes = 200_000;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions"],
  properties: {
    summary: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "start", "end", "text", "action", "reason", "confidence"],
        properties: {
          id: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          text: { type: "string" },
          action: { type: "string", enum: ["KEEP", "CUT", "MOVE", "B-ROLL"] },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
};

function headers(type = "text/plain; charset=utf-8") {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
}

function json(res, status, payload) {
  res.writeHead(status, headers(mime[".json"]));
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("Input is too large. Limit: 200 KB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("The model returned no structured output.");
}

async function analyzeWithOpenAI(transcript) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "medium" },
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: "You are StoryCut, an explainable rough-cut editor. Analyze only the supplied transcript. Return concise editorial proposals. KEEP essential ideas, CUT errors or repetition, MOVE a strong hook that appears too late, and use B-ROLL only when a concrete visual would improve clarity. Never infer personal facts. Never reproduce secrets."
          }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: transcript.slice(0, 30_000) }]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "storycut_decisions",
          strict: true,
          schema: responseSchema
        }
      }
    })
  });
  if (!response.ok) {
    const safeMessage = response.status === 401
      ? "OpenAI authentication failed. Check the server-side API key."
      : `OpenAI request failed with status ${response.status}.`;
    throw new Error(safeMessage);
  }
  const payload = await response.json();
  return normalizeDecisions(JSON.parse(extractOutputText(payload)));
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
    res.writeHead(403, headers());
    return res.end("Forbidden");
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, headers(mime[path.extname(filePath)] || "application/octet-stream"));
    res.end(data);
  } catch {
    res.writeHead(404, headers());
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/status") {
      return json(res, 200, {
        aiAvailable: Boolean(process.env.OPENAI_API_KEY),
        mode: process.env.OPENAI_API_KEY ? "AI + local fallback" : "Local demo"
      });
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      const body = await readJson(req);
      const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
      if (transcript.length < 20) return json(res, 400, { error: "Add a longer transcript before analyzing." });
      if (transcript.length > 30_000) return json(res, 400, { error: "Transcript limit: 30,000 characters." });
      const requestedMode = body.mode === "ai" ? "ai" : "local";
      let result;
      let mode = "local";
      if (requestedMode === "ai" && process.env.OPENAI_API_KEY) {
        result = await analyzeWithOpenAI(transcript);
        mode = "ai";
      } else {
        result = analyzeLocally(transcript);
      }
      return json(res, 200, { ...result, mode });
    }
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405, headers());
    res.end("Method not allowed");
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Unexpected error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`StoryCut is running at http://127.0.0.1:${port}`);
  console.log(`Mode: ${process.env.OPENAI_API_KEY ? "AI enabled" : "local demo (no API key)"}`);
});
