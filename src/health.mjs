// StoryCut health probe: cheap, dependency-free, runs once per /api/health call.
// Caches nothing — health is rare enough that freshness wins over speed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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

export async function readHealth() {
  const [ffmpeg, ffprobe, mlx, pyannote] = await Promise.all([
    probeBinary("ffmpeg"),
    probeBinary("ffprobe"),
    probePythonImport("mlx_whisper"),
    probePythonImport("pyannote"),
  ]);
  return {
    ok: true,
    mode: process.env.OPENAI_API_KEY ? "ai + local" : "local",
    ffmpeg,
    ffprobe,
    mlx,
    pyannote,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
  };
}
