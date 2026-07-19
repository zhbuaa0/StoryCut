const demoTranscript = `00:00:00,000 --> 00:00:05,000
Most people think video editing starts on the timeline.

00:00:05,000 --> 00:00:10,000
But the biggest problem comes first: deciding what the story needs.

00:00:10,000 --> 00:00:14,000
Um, let me restart that sentence. Sorry.

00:00:14,000 --> 00:00:20,000
StoryCut turns each editorial choice into a visible proposal.

00:00:20,000 --> 00:00:27,000
For example, the timeline can show why a mistake should be cut.

00:00:27,000 --> 00:00:34,000
The creator can accept, reject, or revise every suggestion.

00:00:34,000 --> 00:00:40,000
AI proposes. The creator decides.`;

const state = { decisions: [], filter: "ALL", aiAvailable: false };
const transcript = document.querySelector("#transcript");
const analyzeButton = document.querySelector("#analyzeButton");
const resultsPanel = document.querySelector("#resultsPanel");
const decisionList = document.querySelector("#decisionList");
const modeSelect = document.querySelector("#analysisMode");

function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("show");
  window.setTimeout(() => element.classList.remove("show"), 2200);
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateStats() {
  const counts = Object.fromEntries(["KEEP", "CUT", "MOVE", "B-ROLL"].map((action) => [action, 0]));
  state.decisions.forEach((decision) => counts[decision.action]++);
  document.querySelector("#stats").innerHTML = Object.entries(counts)
    .map(([action, count]) => `<div class="stat"><strong>${count}</strong><span>${action}</span></div>`).join("");
}

function renderDecisions() {
  const visible = state.filter === "ALL" ? state.decisions : state.decisions.filter((item) => item.action === state.filter);
  decisionList.innerHTML = visible.map((item) => `
    <article class="decision" data-id="${item.id}">
      <div>
        <span class="action ${item.action}">${item.action}</span>
        <div class="timecode">${formatTime(item.start)}–${formatTime(item.end)}</div>
      </div>
      <div class="decision-copy">
        <blockquote>${escapeHtml(item.text)}</blockquote>
        <div class="reason">${escapeHtml(item.reason)}</div>
        <div class="confidence">${Math.round(item.confidence * 100)}% confidence · ${item.review}</div>
      </div>
      <div class="review-actions">
        <button class="review-button accept ${item.review === "accepted" ? "active" : ""}" data-review="accepted" aria-label="Accept">✓</button>
        <button class="review-button reject ${item.review === "rejected" ? "active" : ""}" data-review="rejected" aria-label="Reject">×</button>
      </div>
    </article>`).join("");
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}

async function checkStatus() {
  const response = await fetch("/api/status");
  const status = await response.json();
  state.aiAvailable = status.aiAvailable;
  document.querySelector("#modeLabel").textContent = status.mode;
  modeSelect.querySelector('option[value="ai"]').disabled = !status.aiAvailable;
  if (!status.aiAvailable) modeSelect.value = "local";
}

async function analyze() {
  if (transcript.value.trim().length < 20) return toast("Add a longer transcript first.");
  analyzeButton.disabled = true;
  analyzeButton.textContent = "Analyzing…";
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcript.value, mode: modeSelect.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Analysis failed.");
    state.decisions = payload.decisions;
    document.querySelector("#summary").textContent = `${payload.summary} · ${payload.mode === "ai" ? "GPT-5.6 analysis" : "local demo analysis"}`;
    updateStats();
    renderDecisions();
    resultsPanel.classList.remove("hidden");
    resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(error.message);
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = "Analyze story →";
  }
}

document.querySelector("#demoButton").addEventListener("click", () => {
  transcript.value = demoTranscript;
  transcript.dispatchEvent(new Event("input"));
  toast("Safe demo transcript loaded.");
});

transcript.addEventListener("input", () => {
  document.querySelector("#charCount").textContent = `${transcript.value.length.toLocaleString()} / 30,000`;
});

analyzeButton.addEventListener("click", analyze);

// --- Media upload + transcription (v0.2) --------------------------------

const dropzone = document.querySelector("#dropzone");
const mediaFileInput = document.querySelector("#mediaFile");
const pickFileButton = document.querySelector("#pickFile");
const progressEl = document.querySelector("#mediaProgress");
const progressBar = document.querySelector("#progressBar");
const progressStage = document.querySelector("#progressStage");

function setProgress(stage, percent) {
  progressEl.classList.remove("hidden");
  progressStage.textContent = stage;
  if (typeof percent === "number" && Number.isFinite(percent)) {
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  } else if (stage === "done") {
    progressBar.style.width = "100%";
  }
}

function hideProgress() {
  progressEl.classList.add("hidden");
  progressBar.style.width = "0%";
}

async function uploadFile(file) {
  const headers = { "X-Filename": file.name };
  const response = await fetch("/api/upload", {
    method: "POST",
    headers,
    body: file  // raw bytes; server enforces 500 MB cap
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Upload failed.");
  return payload;
}

async function runTranscriptionStream(fileId, language) {
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, language })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Transcription request failed (${response.status}).`);
  }
  if (!response.body) throw new Error("Transcription stream unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return await new Promise((resolve, reject) => {
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let eventName = "message";
            let dataLine = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("data:")) dataLine += line.slice(5).trimStart();
              else if (line.startsWith("event:")) eventName = line.slice(6).trim();
            }
            if (!dataLine) continue;
            let parsed;
            try { parsed = JSON.parse(dataLine); } catch { continue; }
            if (eventName === "error") return reject(new Error(parsed.error || "Transcription failed."));
            if (eventName === "end") return resolve(null);
            if (parsed && parsed.type === "done") return resolve(parsed.transcript);
          }
        }
      } catch (error) {
        reject(error);
      }
    })();
  });
}

async function analyzeTranscriptPayload(transcript, mode) {
  const response = await fetch("/api/analyze-transcript", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, mode })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Analysis failed.");
  return payload;
}

async function handleMediaFile(file) {
  if (!file) return;
  if (!/\.(mp4|mov|m4a|wav|mp3)$/i.test(file.name)) {
    toast("Unsupported file type. Use mp4, mov, m4a, wav, or mp3.");
    return;
  }
  try {
    setProgress("Uploading…");
    const upload = await uploadFile(file);
    document.querySelector("#dropzoneMeta").textContent = `${file.name} · ${(upload.sizeBytes / 1024 / 1024).toFixed(1)} MB · ${upload.duration.toFixed(1)} s · ${upload.audio.codec || "audio"}`;
    setProgress("Transcribing… (loading model on first run)");
    let transcript;
    try {
      transcript = await runTranscriptionStream(upload.fileId, "auto");
    } catch (error) {
      setProgress(error.message, 0);
      toast(error.message);
      return;
    }
    if (!transcript) {
      toast("Transcription finished but produced no transcript.");
      return;
    }
    setProgress(`Transcribed ${transcript.segments.length} segments · analyzing…`);
    const result = await analyzeTranscriptPayload(transcript, modeSelect.value);
    state.decisions = result.decisions;
    const segCount = transcript.segments.length;
    document.querySelector("#summary").textContent =
      `Transcribed ${segCount} segment${segCount === 1 ? "" : "s"} from ${file.name} · ${result.summary} · ${result.mode === "ai" ? "GPT-5.6 analysis" : "local demo analysis"}`;
    updateStats();
    renderDecisions();
    resultsPanel.classList.remove("hidden");
    resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    setProgress("Done.", 100);
    toast("Transcription complete.");
  } catch (error) {
    setProgress(error.message);
    toast(error.message);
  }
}

if (mediaFileInput) {
  mediaFileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) handleMediaFile(file);
    mediaFileInput.value = "";
  });
}

if (pickFileButton) {
  pickFileButton.addEventListener("click", (event) => {
    event.preventDefault();
    mediaFileInput.click();
  });
}

if (dropzone) {
  ["dragenter", "dragover"].forEach((evt) => dropzone.addEventListener(evt, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((evt) => dropzone.addEventListener(evt, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  }));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) handleMediaFile(file);
  });
}

document.querySelector(".filter-row").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
  renderDecisions();
});

decisionList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-review]");
  const card = event.target.closest("[data-id]");
  if (!button || !card) return;
  const item = state.decisions.find((decision) => decision.id === card.dataset.id);
  if (!item) return;
  item.review = item.review === button.dataset.review ? "pending" : button.dataset.review;
  renderDecisions();
});

document.querySelector("#exportButton").addEventListener("click", () => {
  const exportData = {
    project: "StoryCut",
    version: "0.1.0",
    exportedAt: new Date().toISOString(),
    decisions: state.decisions
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "storycut-timeline.json";
  link.click();
  URL.revokeObjectURL(url);
});

checkStatus().catch(() => {
  document.querySelector("#modeLabel").textContent = "Local demo";
});
