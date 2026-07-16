import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8"
}).trim().split("\n").filter(Boolean);

const forbiddenExtensions = new Set([".mp4", ".mov", ".mkv", ".wav", ".aiff", ".pem", ".key"]);
const forbiddenNames = new Set([".env", "id_rsa", "id_ed25519"]);
const patterns = [
  { label: "OpenAI-style API key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "hard-coded home path", regex: /\/Users\/[A-Za-z0-9._-]+\// }
];

const findings = [];
for (const relative of tracked) {
  const base = path.basename(relative);
  const ext = path.extname(relative).toLowerCase();
  if (forbiddenNames.has(base) || forbiddenExtensions.has(ext)) findings.push(`${relative}: forbidden public file type`);
  const full = path.join(root, relative);
  const stat = fs.statSync(full);
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const content = fs.readFileSync(full, "utf8");
  for (const pattern of patterns) {
    if (pattern.regex.test(content)) findings.push(`${relative}: possible ${pattern.label}`);
  }
}

if (findings.length) {
  console.error("Privacy check failed:\n" + findings.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`Privacy check passed (${tracked.length} public files scanned).`);
