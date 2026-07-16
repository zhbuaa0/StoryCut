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
