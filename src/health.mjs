// Dependency discovery starts child processes and importing MLX can take a few
// seconds on a busy editing machine. Deduplicate concurrent probes and cache the
// result so a health request never creates a process-spawn storm.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedHealth = null;
let cachedHealthAt = 0;
let pendingHealth = null;

async function probeBinary(name, versionFlag = "-version") {
  try {
    const { stdout } = await execFileP(name, [versionFlag], { timeout: 2000 });
    return { ok: true, version: String(stdout || "").split("\n")[0].trim() };
  } catch (error) {
    return { ok: false, error: error.code === "ENOENT" ? "missing" : "spawn-failed" };
  }
}

async function probePythonImport(module) {
  try {
    await execFileP("python3", ["-c", `import ${module}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function readHealth({ force = false } = {}) {
  if (!force && cachedHealth && Date.now() - cachedHealthAt < HEALTH_CACHE_TTL_MS) return cachedHealth;
  if (!force && pendingHealth) return pendingHealth;
  pendingHealth = (async () => {
    const [ffmpeg, ffprobe, mlx, pyannote] = await Promise.all([
      probeBinary("ffmpeg"),
      probeBinary("ffprobe"),
      probePythonImport("mlx_whisper"),
      probePythonImport("pyannote"),
    ]);
    cachedHealth = Object.freeze({
      ok: true,
      mode: process.env.OPENAI_API_KEY ? "ai + local" : "local",
      ffmpeg,
      ffprobe,
      mlx,
      pyannote,
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    });
    cachedHealthAt = Date.now();
    return cachedHealth;
  })();
  try {
    return await pendingHealth;
  } finally {
    pendingHealth = null;
  }
}
