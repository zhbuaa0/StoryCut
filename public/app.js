const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const safeDemoTranscript = `00:00:00,000 --> 00:00:05,000
多数人以为，视频剪辑是从时间线开始的。

00:00:05,000 --> 00:00:10,000
但真正困难的，是先决定这个故事需要什么。

00:00:10,000 --> 00:00:14,000
嗯，我重新说一下，刚才那句不要。

00:00:14,000 --> 00:00:20,000
StoryCut 会把每个剪辑判断变成可以审阅的建议。

00:00:20,000 --> 00:00:27,000
创作者可以接受、拒绝，或者继续修改每个决定。

00:00:27,000 --> 00:00:34,000
AI 提出建议，创作者做出决定。`;

const pageMeta = {
  overview: ["CODEX REVIEW WORKSPACE", "项目总览"],
  review: ["TIMECODED FEEDBACK", "视频审片"],
  edit: ["CONVERSATIONAL EDIT", "对话剪辑工作台"],
  files: ["LOCAL PROJECT ARTIFACTS", "项目文件"],
  analyze: ["EXPLAINABLE ROUGH CUTS", "AI 分析"]
};

const localCacheKeys = {
  recentProjects: "storycut.recent-projects.v1",
  feedbackPrefix: "storycut.project-feedback.v1:",
  editOpinionsPrefix: "storycut.edit-opinions.v2:",
  editRevisionsPrefix: "storycut.edit-revisions.v1:",
  editTimelineViewPrefix: "storycut.edit-timeline-view.v2:"
};

const state = {
  project: null,
  artifacts: [],
  feedback: [],
  recentProjects: [],
  fileFilter: "all",
  decisions: [],
  decisionFilter: "ALL",
  aiAvailable: false,
  prompt: "",
  timeline: { subtitle: null, markers: [], duration: 0 },
  markerFilter: "all",
  reviewTimelineLoaded: false,
  currentCueId: null,
  reviewIndexTab: "subtitles",
  reviewIndexQuery: "",
  reviewIndexActiveCueId: null,
  reviewIndexActiveMarker: null,
  reviewPlaybackCache: null,
  editWorkspace: null,
  editSelection: { type: null, id: null, assetId: null },
  editSelections: [],
  editOpinions: [],
  editRevisions: [],
  editChatTab: "conversation",
  expandedEditRevisionId: null,
  editingOpinionId: null,
  editProposal: null,
  editMediaTab: "assets",
  editAssetQuery: "",
  editAssetFilter: "used",
  editPreviewMode: "standard",
  editDraftCache: null,
  editCompareEnabled: false,
  editCompareVersionId: null,
  editCompareWorkspace: null,
  editCompareCache: null,
  editComparison: null,
  editCompareView: "split",
  editVersionId: null,
  editTimelineZoom: 1,
  editTimelineSeekGesture: null,
  editAssetRenderLimit: 40
};

let subtitleRowsById = new Map();
let markerRowEntries = [];
let activeMarkerRows = [];
let reviewPositionFrame = 0;
let editPlayheadFrame = 0;
let reviewTimelineRequest = null;
let reviewPlaybackCachePollTimer = 0;
let reviewPlaybackCacheRequest = null;
let reviewPlaybackCacheGeneration = 0;
let editWorkspaceRequest = null;
let editDraftCachePollTimer = 0;
let editDraftCacheRequest = null;
let editDraftCacheGeneration = 0;
let editCompareWorkspaceRequest = null;
let editComparisonRequest = null;
let editCompareCacheRequest = null;
let editCompareCachePollTimer = 0;
let editCompareCacheGeneration = 0;
const EDIT_ASSET_BATCH_SIZE = 40;

function readLocalJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function loadRecentProjects() {
  const items = readLocalJson(localCacheKeys.recentProjects, []);
  state.recentProjects = Array.isArray(items)
    ? items
      .filter((item) => item && typeof item.projectPath === "string" && item.projectPath)
      .slice(0, 12)
    : [];
}

function feedbackCacheKey(projectPath) {
  return `${localCacheKeys.feedbackPrefix}${encodeURIComponent(projectPath)}`;
}

function editOpinionCacheKey(projectPath) {
  return `${localCacheKeys.editOpinionsPrefix}${encodeURIComponent(projectPath)}`;
}

function editRevisionCacheKey(projectPath) {
  return `${localCacheKeys.editRevisionsPrefix}${encodeURIComponent(projectPath)}`;
}

function editTimelineViewCacheKey(projectPath, versionId) {
  return `${localCacheKeys.editTimelineViewPrefix}${encodeURIComponent(projectPath)}:${encodeURIComponent(versionId || "default")}`;
}

function restoreCachedEditOpinions(projectPath) {
  const items = readLocalJson(editOpinionCacheKey(projectPath), []);
  return Array.isArray(items)
    ? items
      .filter((item) => item && typeof item.note === "string" && Array.isArray(item.context))
      .slice(0, 300)
      .map((item) => {
        const fallback = Math.max(0, Number(item.timelineTime) || 0);
        const start = Number.isFinite(Number(item.start)) ? Math.max(0, Number(item.start)) : fallback;
        const end = Number.isFinite(Number(item.end)) ? Math.max(start, Number(item.end)) : start;
        const legacySelection = item.selection?.type ? [item.selection] : [];
        const selections = Array.isArray(item.selections) && item.selections.length
          ? item.selections.filter((selection) => selection?.type)
          : legacySelection;
        return {
          ...item,
          id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
          start,
          end,
          selections,
          selection: selections[0] || item.selection
        };
      })
    : [];
}

function cacheEditOpinions() {
  if (!state.project) return;
  writeLocalJson(editOpinionCacheKey(state.project.editPath || state.project.projectPath), state.editOpinions);
}

function restoreCachedEditRevisions(projectPath) {
  const items = readLocalJson(editRevisionCacheKey(projectPath), []);
  return Array.isArray(items)
    ? items
      .filter((item) => item && typeof item.prompt === "string" && item.prompt && Array.isArray(item.opinions))
      .slice(0, 100)
      .map((item) => ({
        ...item,
        id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
        createdAt: item.createdAt || new Date().toISOString(),
        summary: item.summary || `${item.opinions.length} 条意见`
      }))
    : [];
}

function cacheEditRevisions() {
  if (!state.project) return;
  writeLocalJson(editRevisionCacheKey(state.project.editPath || state.project.projectPath), state.editRevisions);
}

function loadEditTimelineView(versionId) {
  if (!state.project) return { zoom: 1, scrollLeft: 0, time: 0 };
  const value = readLocalJson(editTimelineViewCacheKey(state.project.editPath || state.project.projectPath, versionId), {});
  return {
    zoom: Math.min(8, Math.max(1, Number(value.zoom) || 1)),
    scrollLeft: Math.max(0, Number(value.scrollLeft) || 0),
    time: Math.max(0, Number(value.time) || 0)
  };
}

function saveEditTimelineView() {
  if (!state.project || !state.editVersionId) return;
  const viewport = $("#editTimelineViewport");
  const video = $("#editPreviewVideo");
  writeLocalJson(editTimelineViewCacheKey(state.project.editPath || state.project.projectPath, state.editVersionId), {
    zoom: state.editTimelineZoom,
    scrollLeft: viewport?.scrollLeft || 0,
    time: video?.currentTime || 0
  });
}

let editTimelineViewSaveTimer = 0;
function scheduleEditTimelineViewSave() {
  window.clearTimeout(editTimelineViewSaveTimer);
  editTimelineViewSaveTimer = window.setTimeout(saveEditTimelineView, 900);
}

function restoreCachedFeedback(projectPath) {
  const items = readLocalJson(feedbackCacheKey(projectPath), []);
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && Number.isFinite(Number(item.start)) && Number.isFinite(Number(item.end)) && typeof item.note === "string")
    .slice(0, 300)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
      start: Math.max(0, Number(item.start)),
      end: Math.max(0, Number(item.end)),
      note: item.note.slice(0, 4000),
      mustKeep: String(item.mustKeep || "").slice(0, 2000),
      category: String(item.category || "story"),
      priority: String(item.priority || "normal"),
      locked: Boolean(item.locked)
    }));
}

function rememberCurrentProject() {
  if (!state.project) return;
  const current = {
    projectId: state.project.projectId,
    name: state.project.name,
    projectPath: state.project.projectPath,
    editPath: state.project.editPath,
    previewName: state.project.preview?.name || "",
    feedbackCount: state.feedback.length,
    openedAt: new Date().toISOString()
  };
  state.recentProjects = [
    current,
    ...state.recentProjects.filter((item) => (item.editPath || item.projectPath) !== (current.editPath || current.projectPath))
  ].slice(0, 12);
  writeLocalJson(localCacheKeys.recentProjects, state.recentProjects);
  renderRecentProjects();
}

function cacheCurrentFeedback() {
  if (!state.project) return;
  writeLocalJson(feedbackCacheKey(state.project.editPath || state.project.projectPath), state.feedback);
  rememberCurrentProject();
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  window.setTimeout(() => element.classList.remove("show"), 2600);
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function unloadMediaElement(video, rememberPosition = true) {
  if (!video) return;
  if (rememberPosition && video.dataset.artifactId) {
    video.dataset.resumeArtifactId = video.dataset.artifactId;
    video.dataset.resumeTime = String(Math.max(0, Number(video.currentTime) || 0));
  }
  try { video.pause(); } catch { /* detached media */ }
  video.removeAttribute("src");
  delete video.dataset.artifactId;
  delete video.dataset.mediaKey;
  delete video.dataset.cacheSource;
  delete video.dataset.reportedMediaError;
  try { video.load(); } catch { /* detached media */ }
}

function armMediaResume(video, artifactId) {
  const resumeTime = Number(video.dataset.resumeTime);
  const shouldResume = video.dataset.resumeArtifactId === artifactId && Number.isFinite(resumeTime) && resumeTime > 0;
  delete video.dataset.resumeArtifactId;
  delete video.dataset.resumeTime;
  if (!shouldResume) return;
  video.addEventListener("loadedmetadata", () => {
    video.currentTime = Math.min(resumeTime, Math.max(0, Number(video.duration) || resumeTime));
  }, { once: true });
}

function assetThumbnailMarkup(url, label = "素材首帧") {
  return url
    ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async">`
    : "";
}

function formatTime(seconds) {
  const totalMillis = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hours = Math.floor(totalMillis / 3600000);
  const minutes = Math.floor((totalMillis % 3600000) / 60000);
  const secs = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function parseTime(value) {
  const parts = String(value || "").trim().replace(",", ".").split(":");
  if (!parts.length || parts.some((part) => !Number.isFinite(Number(part)))) return NaN;
  if (parts.length === 1) return Number(parts[0]);
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  return Number(parts.at(-3)) * 3600 + Number(parts.at(-2)) * 60 + Number(parts.at(-1));
}

function jumpReviewVideo(time) {
  $("#reviewVideo").currentTime = Math.max(0, Number(time) || 0);
  updateReviewPosition();
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function recentProjectRows() {
  return state.recentProjects.map((item, index) => `
    <button class="recent-project-item" data-recent-project-index="${index}">
      <span class="recent-project-mark">▶</span>
      <span class="recent-project-copy">
        <strong>${escapeHtml(item.name || "未命名项目")}</strong>
        <small>${escapeHtml(item.projectPath)}</small>
      </span>
      <span class="recent-project-meta">
        <b>${Number(item.feedbackCount) || 0} 条建议</b>
        <small>${formatDate(item.openedAt)}</small>
      </span>
    </button>`).join("");
}

function renderRecentProjects() {
  const hasRecent = state.recentProjects.length > 0;
  const rows = recentProjectRows();
  $("#recentProjectsPanel").classList.toggle("hidden", !hasRecent || Boolean(state.project));
  $("#recentProjectsList").innerHTML = rows;
  $("#recentProjectsDialog").classList.toggle("hidden", !hasRecent);
  $("#recentProjectsDialogList").innerHTML = rows;
}

async function handleRecentProjectClick(event) {
  const button = event.target.closest("[data-recent-project-index]");
  if (!button) return;
  const item = state.recentProjects[Number(button.dataset.recentProjectIndex)];
  if (!item) return;
  $("#projectPath").value = item.projectPath;
  await openProjectByPath(item.projectPath, button);
}

function fileUrl(artifact) {
  return `/api/projects/file?projectId=${encodeURIComponent(state.project.projectId)}&fileId=${encodeURIComponent(artifact.id)}`;
}

function projectFileUrl(fileId) {
  return `/api/projects/file?projectId=${encodeURIComponent(state.project.projectId)}&fileId=${encodeURIComponent(fileId)}`;
}

function projectThumbnailUrl(fileId, at = 0.05) {
  return `/api/projects/thumbnail?projectId=${encodeURIComponent(state.project.projectId)}&fileId=${encodeURIComponent(fileId)}&at=${encodeURIComponent(Math.max(0, Number(at) || 0).toFixed(3))}`;
}

function documentUrl(artifact) {
  return `/api/projects/document?projectId=${encodeURIComponent(state.project.projectId)}&fileId=${encodeURIComponent(artifact.id)}`;
}

const editHeavyContainerIds = [
  "editAssetPanel",
  "editClipPanel",
  "editTimelineRuler",
  "editDiffLane",
  "editGraphicsLane",
  "editChapterLane",
  "editVideoLane",
  "editAudioLane",
  "editBgmLane",
  "editSfxLane"
];

function clearHeavyContainers(ids) {
  ids.forEach((id) => $("#" + id)?.replaceChildren());
}

function releaseEditPageResources(clearDom = true) {
  if (state.project && state.editVersionId) saveEditTimelineView();
  window.clearTimeout(editTimelineViewSaveTimer);
  window.clearTimeout(editDraftCachePollTimer);
  window.clearTimeout(editCompareCachePollTimer);
  editDraftCachePollTimer = 0;
  editCompareCachePollTimer = 0;
  unloadMediaElement($("#editPreviewVideo"));
  unloadMediaElement($("#editCompareVideo"));
  if (editPlayheadFrame) cancelAnimationFrame(editPlayheadFrame);
  editPlayheadFrame = 0;
  if (clearDom) clearHeavyContainers(editHeavyContainerIds);
}

function releaseReviewPageResources(clearDom = true) {
  window.clearTimeout(reviewPlaybackCachePollTimer);
  reviewPlaybackCachePollTimer = 0;
  unloadMediaElement($("#reviewVideo"));
  if (reviewPositionFrame) cancelAnimationFrame(reviewPositionFrame);
  reviewPositionFrame = 0;
  if (clearDom) {
    subtitleRowsById = new Map();
    markerRowEntries = [];
    activeMarkerRows = [];
    state.reviewIndexActiveCueId = null;
    state.reviewIndexActiveMarker = null;
    clearHeavyContainers(["subtitleList", "markerList", "timelineTrack", "feedbackQueue"]);
  }
}

function releaseFilesPageResources() {
  $("#artifactList")?.replaceChildren();
  $("#documentContent").textContent = "点击左侧的 Markdown、JSON、字幕或文本文件即可预览。";
}

function navigate(page) {
  if (!pageMeta[page]) return;
  const previousPage = document.body.dataset.page;
  if (previousPage === "edit" && page !== "edit") releaseEditPageResources();
  if (previousPage === "review" && page !== "review") releaseReviewPageResources();
  if (previousPage === "files" && page !== "files") releaseFilesPageResources();
  document.body.dataset.page = page;
  $$(".page").forEach((element) => element.classList.toggle("active", element.id === `page-${page}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  $("#pageEyebrow").textContent = pageMeta[page][0];
  $("#pageTitle").textContent = pageMeta[page][1];
  window.scrollTo({ top: 0, behavior: "auto" });
  if (page === "edit" && state.project) {
    if (state.editWorkspace) {
      renderEditWorkspace();
      restoreEditTimelineViewAfterRender(loadEditTimelineView(state.editVersionId));
    } else {
      $("#editWorkspaceMeta").textContent = "正在读取当前版本的 EDL 与代理片段…";
      loadEditWorkspace();
    }
  }
  if (page === "review" && state.project) {
    loadSelectedPreview();
    renderFeedback();
    renderReviewIndex();
    updateReviewPosition();
    if (!state.reviewTimelineLoaded) loadReviewTimeline();
  }
  if (page === "files" && state.project) renderArtifacts();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (document.body.dataset.page === "edit") releaseEditPageResources(false);
    if (document.body.dataset.page === "review") releaseReviewPageResources(false);
    return;
  }
  if (document.body.dataset.page === "edit" && state.editWorkspace) {
    loadEditPreviewVideo();
    ensureEditDraftCache();
    if (state.editCompareEnabled) {
      loadEditCompareVideo({ preserveTime: true });
      ensureEditCompareCache();
    }
  }
  if (document.body.dataset.page === "review" && state.project) {
    loadSelectedPreview();
    ensureReviewPlaybackCache();
  }
});

window.addEventListener("pagehide", () => {
  if (document.body.dataset.page === "edit") releaseEditPageResources(false);
  if (document.body.dataset.page === "review") releaseReviewPageResources(false);
});

$$(".nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
$$("[data-page-jump]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.pageJump)));

const projectDialog = $("#projectDialog");
const cacheDialog = $("#cacheDialog");
const GIGABYTE = 1024 * 1024 * 1024;
function showProjectDialog() {
  renderRecentProjects();
  if (typeof projectDialog.showModal === "function") projectDialog.showModal();
  else projectDialog.setAttribute("open", "");
  window.setTimeout(() => $("#projectPath").focus(), 50);
}

$("#openProjectButton").addEventListener("click", showProjectDialog);
$("#emptyOpenButton").addEventListener("click", showProjectDialog);
$("#editOpenProjectButton").addEventListener("click", showProjectDialog);

function cacheCards(sections) {
  return sections.map(([label, item, description]) => `
    <article class="cache-stat-card">
      <span>${escapeHtml(label)}</span>
      <strong>${formatBytes(item?.bytes || 0)}</strong>
      <small>${Number(item?.count) || 0} 个文件 · ${escapeHtml(description)}</small>
    </article>`).join("");
}

function renderCacheStatus(payload) {
  const sections = [
    ["播放代理", payload.media, "为浏览器优化的 H.264/AAC 视频"],
    ["首帧缩略图", payload.thumbnails, "素材池图片，滚动时按需复用"],
    ["项目索引", payload.projectIndex, "加快外置盘项目的再次打开"]
  ];
  $("#cacheSummary").innerHTML = cacheCards(sections);
  const project = payload.currentProject;
  $("#cacheProjectSection").classList.toggle("hidden", !project);
  if (project) {
    $("#cacheProjectTotal").textContent = formatBytes(project.totalBytes || 0);
    $("#cacheProjectSummary").innerHTML = cacheCards([
      ["播放代理", project.media, "只统计当前项目登记的代理"],
      ["首帧缩略图", project.thumbnails, "当前项目素材首帧"],
      ["项目索引", project.projectIndex, "当前项目快速恢复索引"]
    ]);
  }
  const settings = payload.settings || {};
  const maxBytes = Math.max(GIGABYTE, Number(settings.mediaMaxBytes) || 20 * GIGABYTE);
  const usedBytes = Number(payload.media?.bytes) || 0;
  const percent = Math.min(100, Math.max(0, usedBytes / maxBytes * 100));
  $("#cacheLimitInput").value = String(Math.max(1, Math.round(maxBytes / GIGABYTE)));
  $("#cacheLimitInput").disabled = settings.editable === false;
  $("#saveCacheLimitButton").disabled = settings.editable === false;
  $("#cacheLimitHint").textContent = settings.editable === false
    ? "容量由 STORYCUT_MEDIA_CACHE_MAX_BYTES 环境变量管理。"
    : "超出容量后自动按最久未使用顺序清理。";
  $("#cacheLimitUsage").textContent = `${formatBytes(usedBytes)} / ${formatBytes(maxBytes)}`;
  $("#cacheUsageBar").style.width = `${percent.toFixed(1)}%`;
  $("#cacheLocation").textContent = `${payload.location || "~/Library/Caches/StoryCut"}${payload.jobs?.proxyActive ? " · 播放代理生成中" : ""}`;
}

async function loadCacheStatus() {
  $("#cacheSummary").innerHTML = `<div class="cache-loading">正在统计缓存…</div>`;
  const projectQuery = state.project?.projectId ? `?projectId=${encodeURIComponent(state.project.projectId)}` : "";
  const response = await fetch(`/api/cache/status${projectQuery}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "无法读取缓存状态。");
  renderCacheStatus(payload);
  return payload;
}

async function showCacheDialog() {
  if (typeof cacheDialog.showModal === "function") cacheDialog.showModal();
  else cacheDialog.setAttribute("open", "");
  try { await loadCacheStatus(); } catch (error) { toast(error.message); }
}

$("#editCacheButton").addEventListener("click", showCacheDialog);
$("#headerCacheButton").addEventListener("click", showCacheDialog);

$("#cacheDialog").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cache-clear]");
  if (!button) return;
  const target = button.dataset.cacheClear;
  const scope = button.dataset.cacheScope || "global";
  const idleLabel = button.textContent;
  button.disabled = true;
  button.textContent = "正在清理…";
  try {
    const response = await fetch("/api/cache/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, scope, projectId: scope === "project" ? state.project?.projectId : undefined })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法清理缓存。");
    if (target === "media" || target === "all") {
      unloadMediaElement($("#reviewVideo"));
      unloadMediaElement($("#editPreviewVideo"));
      unloadMediaElement($("#editCompareVideo"));
      resetReviewPlaybackCache();
      resetEditDraftCache();
      resetEditCompareCache();
      if (document.body.dataset.page === "review") {
        loadSelectedPreview({ preservePlayback: true });
        ensureReviewPlaybackCache();
      }
      if (document.body.dataset.page === "edit") {
        loadEditPreviewVideo({ preservePlayback: true });
        ensureEditDraftCache();
        if (state.editCompareEnabled) ensureEditCompareCache();
      }
    }
    if (target === "project-index" || target === "all") $("#editIndexStatus").textContent = "索引将在下次刷新重建";
    await loadCacheStatus();
    toast(`${scope === "project" ? "当前项目" : "StoryCut 全部"}缓存已清理；源素材和项目文件没有改动。`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = idleLabel;
  }
});

$("#saveCacheLimitButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const gigabytes = Number($("#cacheLimitInput").value);
  if (!Number.isFinite(gigabytes) || gigabytes < 1 || gigabytes > 200) return toast("容量请输入 1–200 GB。");
  button.disabled = true;
  try {
    const response = await fetch("/api/cache/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaMaxBytes: Math.round(gigabytes * GIGABYTE) })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法保存缓存容量。");
    await loadCacheStatus();
    toast(`播放代理缓存上限已设为 ${Math.round(gigabytes)} GB。`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#openCacheDirectoryButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch("/api/cache/open", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法打开缓存目录。");
    toast("已在 Finder 中打开 StoryCut 缓存目录。 ");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#refreshProjectButton").addEventListener("click", async (event) => {
  if (!state.project) return;
  const selectedPreview = $("#previewSelect").value;
  await openProjectByPath(state.project.projectPath, event.currentTarget, { refresh: true });
  const stillAvailable = state.artifacts.some((item) => item.id === selectedPreview);
  if (stillAvailable && state.project.preview?.id === selectedPreview) {
    $("#previewSelect").value = selectedPreview;
    loadSelectedPreview();
  }
});

async function openProjectByPath(path, button = $("#confirmOpenProject"), options = {}) {
  if (!path) return toast("请输入本地项目目录。");
  const recentButton = button.matches("[data-recent-project-index]");
  const idleLabel = button.textContent;
  button.disabled = true;
  if (recentButton) button.classList.add("loading");
  else button.textContent = "正在扫描…";
  try {
    const response = await fetch("/api/projects/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, refresh: options.refresh === true })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法打开项目。");
    releaseEditPageResources();
    releaseReviewPageResources();
    releaseFilesPageResources();
    editWorkspaceRequest = null;
    reviewTimelineRequest = null;
    state.project = payload;
    state.artifacts = payload.artifacts || [];
    state.feedback = restoreCachedFeedback(payload.editPath || payload.projectPath);
    state.timeline = { subtitle: null, markers: [], duration: 0 };
    state.reviewTimelineLoaded = false;
    state.currentCueId = null;
    state.reviewIndexTab = "subtitles";
    state.reviewIndexQuery = "";
    state.reviewIndexActiveCueId = null;
    state.reviewIndexActiveMarker = null;
    resetReviewPlaybackCache();
    state.editWorkspace = null;
    state.editSelection = { type: null, id: null, assetId: null };
    state.editSelections = [];
    state.editOpinions = restoreCachedEditOpinions(payload.editPath || payload.projectPath);
    state.editRevisions = restoreCachedEditRevisions(payload.editPath || payload.projectPath);
    state.editChatTab = "conversation";
    state.expandedEditRevisionId = null;
    state.editingOpinionId = null;
    state.editProposal = null;
    state.editVersionId = payload.activeVersion || null;
    state.editPreviewMode = "standard";
    state.editCompareEnabled = false;
    state.editCompareVersionId = null;
    state.editCompareWorkspace = null;
    state.editCompareCache = null;
    state.editComparison = null;
    state.editCompareView = "split";
    state.editAssetRenderLimit = EDIT_ASSET_BATCH_SIZE;
    editCompareWorkspaceRequest = null;
    editComparisonRequest = null;
    editCompareCacheRequest = null;
    window.clearTimeout(editCompareCachePollTimer);
    resetEditDraftCache();
    state.editTimelineZoom = 1;
    $("#reviewIndexSearch").value = "";
    projectDialog.close();
    renderProject();
    rememberCurrentProject();
    const indexNote = payload.index?.cacheHit
      ? `索引已复用，${payload.index.durationMs || 0} ms 完成`
      : payload.index?.mode === "refreshed" ? `索引已刷新，耗时 ${payload.index.durationMs || 0} ms` : "已建立本地增量索引";
    toast(state.feedback.length
      ? `已打开 ${payload.name}，恢复 ${state.feedback.length} 条审片建议；${indexNote}。`
      : `已打开 ${payload.name}；${indexNote}。`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    if (recentButton) {
      button.classList.remove("loading");
      renderRecentProjects();
    } else {
      button.textContent = idleLabel;
    }
  }
}

$("#confirmOpenProject").addEventListener("click", async (event) => {
  event.preventDefault();
  await openProjectByPath($("#projectPath").value.trim(), event.currentTarget);
});

function detectPhase() {
  const kinds = new Set(state.artifacts.map((item) => item.kind));
  if (state.artifacts.some((item) => /packag|final|hq/i.test(item.name))) return "包装与交付";
  if (kinds.has("preview")) return "粗剪审片";
  if (kinds.has("edl")) return "纸剪与 EDL";
  if (kinds.has("story")) return "故事锁定";
  return "素材理解";
}

async function loadMemoryExcerpt() {
  const memory = state.project?.memory;
  if (!memory?.readable) {
    $("#memoryExcerpt").textContent = "项目中尚未找到 project.md。";
    return;
  }
  try {
    const response = await fetch(documentUrl(memory));
    const payload = await response.json();
    $("#memoryExcerpt").textContent = payload.content.slice(0, 1400);
  } catch {
    $("#memoryExcerpt").textContent = "无法读取项目记忆。";
  }
}

function renderProject() {
  const project = state.project;
  $("#emptyState").classList.add("hidden");
  $("#recentProjectsPanel").classList.add("hidden");
  $("#projectDashboard").classList.remove("hidden");
  $("#reviewNeedsProject").classList.add("hidden");
  $("#reviewWorkspace").classList.remove("hidden");
  $("#filesNeedsProject").classList.add("hidden");
  $("#filesWorkspace").classList.remove("hidden");
  $("#sidebarProjectName").textContent = project.name;
  $("#refreshProjectButton").classList.remove("hidden");
  $(".project-mini").classList.add("open");
  $("#dashboardProjectName").textContent = project.name;
  $("#dashboardProjectPath").textContent = project.projectPath;
  $("#currentPhase").textContent = detectPhase();
  $("#artifactCount").textContent = project.artifactCount;
  $("#latestVersion").textContent = project.preview?.name || "无预览";
  $("#lastUpdated").textContent = formatDate(project.updatedAt);

  if (project.preview) {
    $("#latestPreviewSummary").innerHTML = `
      <div class="preview-icon">▶</div>
      <div><strong>${escapeHtml(project.preview.name)}</strong>
      <p>${formatBytes(project.preview.sizeBytes)} · 更新于 ${formatDate(project.preview.modifiedAt)}<br>点击“开始审片”添加带时间码的反馈。</p></div>`;
  }
  loadMemoryExcerpt();
  renderPreviewOptions();
  renderFeedback();
  if (document.body.dataset.page === "files") renderArtifacts();
  if (document.body.dataset.page === "review") loadReviewTimeline();
  if (document.body.dataset.page === "edit") loadEditWorkspace();
}

function editDuration() {
  return Math.max(0.001, Number(state.editWorkspace?.duration) || 0.001);
}

function emptyEditSelection() {
  return { type: null, id: null, assetId: null };
}

function editSelectionKey(selection) {
  if (selection?.type === "clip" && selection.id) return `clip:${selection.id}`;
  if (selection?.type === "marker" && selection.id) return `marker:${selection.id}`;
  if (selection?.type === "asset" && selection.assetId) return `asset:${selection.assetId}`;
  return "";
}

function currentEditSelections() {
  const selections = Array.isArray(state.editSelections) ? state.editSelections.filter(editSelectionKey) : [];
  if (selections.length) return selections;
  return editSelectionKey(state.editSelection) ? [state.editSelection] : [];
}

function setCurrentEditSelections(selections, primary = null) {
  const unique = [];
  const seen = new Set();
  (selections || []).forEach((selection) => {
    const key = editSelectionKey(selection);
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(selection);
  });
  const primaryKey = editSelectionKey(primary);
  state.editSelections = unique;
  state.editSelection = unique.find((selection) => editSelectionKey(selection) === primaryKey)
    || unique.at(-1)
    || emptyEditSelection();
}

function isEditSelectionActive(type, id) {
  return currentEditSelections().some((selection) => editSelectionKey(selection) === `${type}:${id}`);
}

function editSelectedClip() {
  const id = state.editSelection.type === "clip" ? state.editSelection.id : null;
  return state.editWorkspace?.clips?.find((clip) => clip.id === id) || null;
}

function editTimelineMarkerEntries(type = null) {
  const markerTypes = type ? [type] : ["flower", "chapter", "bgm", "sfx"];
  const sourceMarkers = state.editWorkspace?.timeline?.markers || [];
  return markerTypes.flatMap((markerType) => groupVisibleMarkers(sourceMarkers
    .filter((item) => item.type === markerType && String(item.label || "").trim()))
    .map((marker) => {
      const items = marker.items?.length ? marker.items : [marker];
      const start = Math.min(editDuration(), Math.max(0, Math.min(...items.map((item) => Number(item.time) || 0))));
      const end = Math.min(editDuration(), Math.max(start, ...items.map((item) => Number(item.end) || Number(item.time) || start)));
      const label = items.map((item) => String(item.label || "").trim()).filter(Boolean).join(" / ") || markerLabel(markerType);
      const sources = [...new Set(items.map((item) => String(item.source || "").trim()).filter(Boolean))];
      const id = `${markerType}:${start.toFixed(3)}:${end.toFixed(3)}:${label}`;
      return { id, type: markerType, start, end, label, sources, items };
    }));
}

function editSelectedMarker() {
  if (state.editSelection.type !== "marker") return null;
  return editTimelineMarkerEntries().find((marker) => marker.id === state.editSelection.id)
    || state.editSelection.marker
    || null;
}

function resolveEditSelection(selection) {
  if (selection?.type === "clip") {
    const clip = state.editWorkspace?.clips?.find((item) => item.id === selection.id);
    return clip ? {
      type: "clip",
      selection,
      clip,
      start: Math.max(0, Number(clip.timelineIn) || 0),
      end: Math.max(0, Number(clip.timelineOut) || 0),
      label: clip.beat || clip.id
    } : null;
  }
  if (selection?.type === "marker") {
    const marker = editTimelineMarkerEntries().find((item) => item.id === selection.id)
      || selection.marker
      || (Number.isFinite(Number(selection.start)) ? {
        id: selection.id,
        type: selection.markerType || "marker",
        label: selection.label || markerLabel(selection.markerType),
        sources: selection.sources || [],
        start: Number(selection.start),
        end: Number(selection.end) || Number(selection.start)
      } : null);
    if (!marker) return null;
    const range = editMarkerOpinionRange(marker);
    return { type: "marker", selection, marker, start: range.start, end: range.end, label: marker.label };
  }
  if (selection?.type === "asset") {
    const asset = state.editWorkspace?.assets?.find((item) => item.id === selection.assetId);
    if (!asset) return null;
    const ranges = Array.isArray(asset.timelineRanges) ? asset.timelineRanges : [];
    const start = ranges.length ? Math.min(...ranges.map((range) => Number(range.start) || 0)) : null;
    const end = ranges.length ? Math.max(...ranges.map((range) => Number(range.end) || Number(range.start) || 0)) : null;
    return { type: "asset", selection, asset, start, end, label: asset.name || asset.id };
  }
  return null;
}

function selectedEditEntries() {
  return currentEditSelections().map(resolveEditSelection).filter(Boolean);
}

function editSelectionRange(entries = selectedEditEntries()) {
  const ranged = entries.filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end));
  if (!ranged.length) return null;
  return {
    start: Math.max(0, Math.min(...ranged.map((entry) => entry.start))),
    end: Math.min(editDuration(), Math.max(...ranged.map((entry) => entry.end)))
  };
}

function editSelectionSnapshot(entry) {
  if (entry.type === "clip") {
    return {
      type: "clip",
      id: entry.clip.id,
      assetId: entry.clip.sourceKey,
      label: entry.clip.beat || entry.clip.id,
      sourceKey: entry.clip.sourceKey,
      start: entry.start,
      end: entry.end,
      sourceIn: entry.clip.sourceIn,
      sourceOut: entry.clip.sourceOut
    };
  }
  if (entry.type === "marker") {
    return {
      type: "marker",
      id: entry.marker.id,
      markerType: entry.marker.type,
      label: entry.marker.label,
      sources: entry.marker.sources || [],
      start: entry.start,
      end: entry.end
    };
  }
  return {
    type: "asset",
    assetId: entry.asset.id,
    label: entry.asset.name || entry.asset.id,
    start: entry.start,
    end: entry.end
  };
}

function editMarkerOpinionRange(marker) {
  const start = Math.max(0, Number(marker?.start) || 0);
  const explicitEnd = Math.max(start, Number(marker?.end) || start);
  const end = explicitEnd > start ? explicitEnd : Math.min(editDuration(), start + 2);
  return { start, end };
}

function editClipAtTime(time) {
  const value = Number(time) || 0;
  return (state.editWorkspace?.clips || []).find((clip) => clip.status !== "excluded"
    && value >= Number(clip.timelineIn)
    && value < Number(clip.timelineOut)) || null;
}

function editPreviewArtifact() {
  const preview = state.editWorkspace?.preview;
  if (!preview) return state.project?.preview || state.artifacts.find((item) => item.playable) || null;
  if (state.editPreviewMode === "draft" && preview.draft) return preview.draft;
  return preview.standard || preview.draft || null;
}

function resetEditDraftCache() {
  window.clearTimeout(editDraftCachePollTimer);
  editDraftCachePollTimer = 0;
  editDraftCacheRequest = null;
  editDraftCacheGeneration += 1;
  state.editDraftCache = null;
  renderEditDraftCacheStatus();
}

function editProxyStatusLabel(cache) {
  const status = cache?.status || "starting";
  const progress = Math.max(0, Number(cache?.percent) || 0);
  if (status === "ready") return "已就绪";
  if (status === "error") return "失败 · 重试";
  if (status === "queued") return "排队中";
  if (status === "probing") return "分析中";
  if (status === "finalizing") return "封装中";
  if (status === "transcoding") return `生成 ${progress}%`;
  return "准备中";
}

function renderEditDraftCacheStatus() {
  const button = $("#editDraftCacheStatus");
  if (!button) return;
  const artifact = editPreviewArtifact();
  const compareArtifact = state.editCompareEnabled ? editCompareArtifact() : null;
  const caches = compareArtifact ? [state.editDraftCache, state.editCompareCache] : [state.editDraftCache];
  button.classList.toggle("hidden", !artifact);
  button.classList.remove("copying", "ready", "error");
  if (!artifact) return;
  const hasError = caches.some((cache) => cache?.status === "error");
  const allReady = caches.every((cache) => cache?.status === "ready");
  button.classList.add(hasError ? "error" : allReady ? "ready" : "copying");
  button.textContent = compareArtifact
    ? `A ${editProxyStatusLabel(state.editDraftCache)} · B ${editProxyStatusLabel(state.editCompareCache)}`
    : `播放代理 ${editProxyStatusLabel(state.editDraftCache)}`;
  const errors = [
    state.editDraftCache?.status === "error" ? `A：${state.editDraftCache.error || "生成失败"}` : "",
    state.editCompareCache?.status === "error" ? `B：${state.editCompareCache.error || "生成失败"}` : ""
  ].filter(Boolean);
  button.title = errors.length
    ? `${errors.join("；")}。点击重试失败的代理。`
    : allReady
      ? "A/B 已使用本机 H.264/AAC 播放代理，源素材没有改动。"
      : "正在后台生成浏览器专用 H.264/AAC 播放代理；完成前会回退项目视频。";
}

function editPreviewSource(artifact) {
  const cache = state.editDraftCache;
  const cached = cache?.artifactId === artifact?.id
    && cache.status === "ready"
    && (cache.proxyFileId || cache.cacheFileId);
  const proxyFileId = cache?.proxyFileId || cache?.cacheFileId;
  return cached
    ? { url: projectFileUrl(proxyFileId), key: `${artifact.id}:proxy:${proxyFileId}`, cached: true }
    : { url: fileUrl(artifact), key: `${artifact.id}:project`, cached: false };
}

function resetReviewPlaybackCache() {
  window.clearTimeout(reviewPlaybackCachePollTimer);
  reviewPlaybackCachePollTimer = 0;
  reviewPlaybackCacheRequest = null;
  reviewPlaybackCacheGeneration += 1;
  state.reviewPlaybackCache = null;
  renderReviewPlaybackCacheStatus();
}

function renderReviewPlaybackCacheStatus() {
  const button = $("#reviewPlaybackCacheStatus");
  if (!button) return;
  const cache = state.reviewPlaybackCache;
  const status = cache?.status || "starting";
  const progress = Math.max(0, Number(cache?.percent) || 0);
  button.classList.remove("working", "ready", "error");
  button.classList.add(status === "ready" ? "ready" : status === "error" ? "error" : "working");
  button.textContent = status === "ready"
    ? "本机代理已就绪"
    : status === "error"
      ? "代理失败 · 重试"
      : status === "transcoding"
        ? `生成代理 ${progress}%`
        : status === "queued"
          ? "代理排队中"
          : "准备播放代理";
  button.title = status === "error"
    ? cache?.error || "点击重新生成当前审片视频的播放代理"
    : status === "ready"
      ? `正在使用 ${cache?.cacheLocation || "本机 StoryCut 播放代理"}`
      : "后台生成浏览器优化的 H.264/AAC 视频；完成前仍使用项目视频。";
}

function reviewPreviewSource(artifact) {
  const cache = state.reviewPlaybackCache;
  const proxyFileId = cache?.proxyFileId || cache?.cacheFileId;
  const cached = cache?.artifactId === artifact?.id && cache.status === "ready" && proxyFileId;
  return cached
    ? { url: projectFileUrl(proxyFileId), key: `${artifact.id}:proxy:${proxyFileId}`, cached: true }
    : { url: fileUrl(artifact), key: `${artifact.id}:project`, cached: false };
}

function scheduleReviewPlaybackCachePoll(delay = 850) {
  window.clearTimeout(reviewPlaybackCachePollTimer);
  if (document.body.dataset.page !== "review" || document.visibilityState === "hidden") return;
  reviewPlaybackCachePollTimer = window.setTimeout(() => {
    reviewPlaybackCachePollTimer = 0;
    ensureReviewPlaybackCache();
  }, delay);
}

async function ensureReviewPlaybackCache({ retry = false } = {}) {
  const artifact = state.artifacts.find((item) => item.id === $("#previewSelect").value);
  const projectId = state.project?.projectId;
  if (!artifact || !projectId || document.visibilityState === "hidden") return;
  const key = `${projectId}:${artifact.id}`;
  if (state.reviewPlaybackCache?.key !== key) {
    resetReviewPlaybackCache();
    state.reviewPlaybackCache = { key, artifactId: artifact.id, status: "starting", percent: 0 };
  }
  if (!retry && ["ready", "error"].includes(state.reviewPlaybackCache.status)) return;
  if (reviewPlaybackCacheRequest?.key === key) return reviewPlaybackCacheRequest.promise;
  const generation = reviewPlaybackCacheGeneration;
  const promise = (async () => {
    try {
      const response = await fetch("/api/projects/playback-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, fileId: artifact.id, retry })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法生成审片播放代理。");
      if (generation !== reviewPlaybackCacheGeneration || state.reviewPlaybackCache?.key !== key) return;
      state.reviewPlaybackCache = { ...state.reviewPlaybackCache, ...payload, key, artifactId: artifact.id };
      renderReviewPlaybackCacheStatus();
      if (!['ready', 'error'].includes(payload.status)) scheduleReviewPlaybackCachePoll();
      else if (payload.status === "ready") loadSelectedPreview({ preservePlayback: true });
    } catch (error) {
      if (generation !== reviewPlaybackCacheGeneration || state.reviewPlaybackCache?.key !== key) return;
      state.reviewPlaybackCache = { ...state.reviewPlaybackCache, status: "error", error: error.message };
      renderReviewPlaybackCacheStatus();
    } finally {
      if (reviewPlaybackCacheRequest?.key === key) reviewPlaybackCacheRequest = null;
    }
  })();
  reviewPlaybackCacheRequest = { key, promise };
  return promise;
}

function scheduleEditDraftCachePoll(delay = 700) {
  window.clearTimeout(editDraftCachePollTimer);
  if (document.body.dataset.page !== "edit" || document.visibilityState === "hidden") return;
  editDraftCachePollTimer = window.setTimeout(() => {
    editDraftCachePollTimer = 0;
    ensureEditDraftCache();
  }, delay);
}

async function ensureEditDraftCache({ retry = false } = {}) {
  const artifact = editPreviewArtifact();
  const projectId = state.project?.projectId;
  if (!artifact || !projectId) {
    resetEditDraftCache();
    return;
  }
  if (document.visibilityState === "hidden") return;
  const key = `${projectId}:${artifact.id}`;
  if (state.editDraftCache?.key !== key) {
    window.clearTimeout(editDraftCachePollTimer);
    editDraftCacheGeneration += 1;
    state.editDraftCache = {
      key,
      artifactId: artifact.id,
      status: "starting",
      percent: 0,
      proxyFileId: null,
      cacheFileId: null,
      cacheLocation: "~/Library/Caches/StoryCut/media（播放代理）"
    };
  }
  if (!retry && state.editDraftCache.status === "ready") {
    renderEditDraftCacheStatus();
    return;
  }
  if (!retry && state.editDraftCache.status === "error") {
    renderEditDraftCacheStatus();
    return;
  }
  if (!retry && !["ready", "error", "starting"].includes(state.editDraftCache.status) && editDraftCachePollTimer) return;
  if (editDraftCacheRequest?.key === key) return editDraftCacheRequest.promise;
  const generation = editDraftCacheGeneration;
  const promise = (async () => {
    try {
      const response = await fetch("/api/projects/playback-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, fileId: artifact.id, retry })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法生成当前 A 版的播放代理。");
      if (generation !== editDraftCacheGeneration || state.editDraftCache?.key !== key) return;
      state.editDraftCache = { ...state.editDraftCache, ...payload, key, artifactId: artifact.id };
      renderEditDraftCacheStatus();
      if (!["ready", "error"].includes(payload.status)) {
        scheduleEditDraftCachePoll();
      } else if (payload.status === "ready") {
        loadEditPreviewVideo({ preservePlayback: true });
      }
    } catch (error) {
      if (generation !== editDraftCacheGeneration || state.editDraftCache?.key !== key) return;
      state.editDraftCache = {
        ...state.editDraftCache,
        status: "error",
        error: error instanceof Error ? error.message : "无法生成当前 A 版的播放代理。"
      };
      renderEditDraftCacheStatus();
    } finally {
      if (editDraftCacheRequest?.key === key) editDraftCacheRequest = null;
    }
  })();
  editDraftCacheRequest = { key, promise };
  return promise;
}

function editCompareArtifact() {
  const preview = state.editCompareWorkspace?.preview;
  if (!preview) return null;
  if (state.editPreviewMode === "draft" && preview.draft) return preview.draft;
  return preview.standard || preview.draft || null;
}

function resetEditCompareCache() {
  window.clearTimeout(editCompareCachePollTimer);
  editCompareCachePollTimer = 0;
  editCompareCacheRequest = null;
  editCompareCacheGeneration += 1;
  state.editCompareCache = null;
  renderEditDraftCacheStatus();
}

function comparePreviewSource(artifact) {
  const cache = state.editCompareCache;
  const proxyFileId = cache?.proxyFileId || cache?.cacheFileId;
  const cached = cache?.artifactId === artifact?.id
    && cache.status === "ready"
    && proxyFileId;
  return cached
    ? { url: projectFileUrl(proxyFileId), key: `${artifact.id}:proxy:${proxyFileId}`, cached: true }
    : { url: fileUrl(artifact), key: `${artifact.id}:project`, cached: false };
}

function scheduleEditCompareCachePoll(delay = 800) {
  window.clearTimeout(editCompareCachePollTimer);
  if (!state.editCompareEnabled || document.body.dataset.page !== "edit" || document.visibilityState === "hidden") return;
  editCompareCachePollTimer = window.setTimeout(() => {
    editCompareCachePollTimer = 0;
    ensureEditCompareCache();
  }, delay);
}

async function ensureEditCompareCache({ retry = false } = {}) {
  const artifact = editCompareArtifact();
  const projectId = state.project?.projectId;
  if (!state.editCompareEnabled || !artifact || !projectId || document.visibilityState === "hidden") return;
  const key = `${projectId}:${artifact.id}`;
  if (state.editCompareCache?.key !== key) {
    resetEditCompareCache();
    state.editCompareCache = { key, artifactId: artifact.id, status: "starting", percent: 0 };
  }
  if (!retry && ["ready", "error"].includes(state.editCompareCache.status)) {
    renderEditDraftCacheStatus();
    return;
  }
  if (editCompareCacheRequest?.key === key) return editCompareCacheRequest.promise;
  const generation = editCompareCacheGeneration;
  const promise = (async () => {
    try {
      const response = await fetch("/api/projects/playback-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, fileId: artifact.id, retry })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法生成 B 版播放代理。");
      if (generation !== editCompareCacheGeneration || state.editCompareCache?.key !== key) return;
      state.editCompareCache = { ...state.editCompareCache, ...payload, key, artifactId: artifact.id };
      renderEditDraftCacheStatus();
      if (!['ready', 'error'].includes(payload.status)) scheduleEditCompareCachePoll();
      else if (payload.status === "ready") loadEditCompareVideo({ preserveTime: true });
    } catch (error) {
      if (generation !== editCompareCacheGeneration || state.editCompareCache?.key !== key) return;
      state.editCompareCache = { ...state.editCompareCache, status: "error", error: error.message };
      renderEditDraftCacheStatus();
    } finally {
      if (editCompareCacheRequest?.key === key) editCompareCacheRequest = null;
    }
  })();
  editCompareCacheRequest = { key, promise };
  return promise;
}

function syncEditCompare({ force = false, playback = false } = {}) {
  if (!state.editCompareEnabled) return;
  const master = $("#editPreviewVideo");
  const compare = $("#editCompareVideo");
  const status = $("#editCompareSyncStatus");
  if (!master?.src || !compare?.src || compare.readyState < 1) {
    if (status) status.textContent = "B 正在载入…";
    return;
  }
  const masterTime = Number(master.currentTime) || 0;
  const compareDuration = Number(compare.duration) || masterTime;
  const target = Math.min(masterTime, Math.max(0, compareDuration));
  if (masterTime > compareDuration + .05) {
    compare.pause();
    if (status) status.textContent = `B 已结束 · A ${formatTime(masterTime)}`;
    return;
  }
  if (compare.readyState < 2) {
    if (status) status.textContent = `B 缓冲中 · ${formatTime(target)}`;
    return;
  }
  const drift = (Number(compare.currentTime) || 0) - target;
  if (force || Math.abs(drift) > .3) compare.currentTime = target;
  compare.playbackRate = !force && Math.abs(drift) > .04
    ? Math.min(16, Math.max(.25, master.playbackRate * (drift > 0 ? .94 : 1.06)))
    : master.playbackRate;
  if (playback && !master.paused && compare.paused) compare.play().catch(() => {});
  if (master.paused && !compare.paused) compare.pause();
  if (status) status.textContent = `A/B 同步 · 差 ${Math.abs(drift).toFixed(2)}s`;
}

function loadEditCompareVideo(options = {}) {
  const pane = $("#editComparePane");
  const video = $("#editCompareVideo");
  const artifact = editCompareArtifact();
  pane.classList.toggle("hidden", !state.editCompareEnabled);
  $("#editPreviewStage").classList.toggle("compare", state.editCompareEnabled);
  if (!state.editCompareEnabled || !artifact) {
    unloadMediaElement(video, false);
    return;
  }
  const source = comparePreviewSource(artifact);
  if (video.dataset.mediaKey !== source.key) {
    const masterTime = Number($("#editPreviewVideo").currentTime) || 0;
    const previousTime = options.preserveTime ? masterTime : 0;
    video.dataset.mediaKey = source.key;
    video.dataset.artifactId = artifact.id;
    video.dataset.cacheSource = source.cached ? "playback-proxy" : "project";
    delete video.dataset.reportedMediaError;
    video.src = source.url;
    video.muted = true;
    video.load();
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(previousTime, Math.max(0, Number(video.duration) || previousTime));
      syncEditCompare({ force: true, playback: true });
    }, { once: true });
  } else {
    syncEditCompare({ force: true, playback: true });
  }
  ensureEditCompareCache();
}

function compareVersionOptions() {
  const versions = state.editWorkspace?.versions || [];
  return versions.filter((version) => version.id !== state.editWorkspace?.activeVersion);
}

const editDifferenceLabels = {
  added: "新增",
  removed: "删除",
  trimmed: "收紧",
  extended: "延长",
  moved: "移动"
};

function renderEditComparisonSummary() {
  const target = $("#editCompareSummary");
  if (!target) return;
  if (!state.editCompareEnabled) {
    target.textContent = "";
    return;
  }
  const summary = state.editComparison?.summary;
  if (!summary) {
    target.textContent = "正在比较两个版本…";
    return;
  }
  if (!summary.hasChanges) {
    target.textContent = "两个版本的镜头与包装节点一致";
    return;
  }
  const totals = Object.keys(editDifferenceLabels).map((status) => ({
    status,
    count: Number(summary.clips?.[status] || 0) + Number(summary.markers?.[status] || 0)
  })).filter((item) => item.count > 0);
  target.textContent = totals.map((item) => `${editDifferenceLabels[item.status]} ${item.count}`).join(" · ");
}

function setEditCompareView(view) {
  const allowed = ["a", "split", "b"];
  state.editCompareView = allowed.includes(view) ? view : "split";
  $("#editPreviewStage").dataset.compareView = state.editCompareView;
  $$("#editCompareViews [data-edit-compare-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.editCompareView === state.editCompareView);
  });
  syncEditCompare({ force: true, playback: true });
}

async function loadEditComparison() {
  const projectId = state.project?.projectId;
  const aVersionId = state.editWorkspace?.activeVersion;
  const bVersionId = state.editCompareVersionId;
  if (!state.editCompareEnabled || !projectId || !aVersionId || !bVersionId || aVersionId === bVersionId) {
    state.editComparison = null;
    renderEditComparisonSummary();
    renderEditTimeline();
    return;
  }
  const key = `${projectId}:${aVersionId}:${bVersionId}`;
  if (editComparisonRequest?.key === key) return editComparisonRequest.promise;
  state.editComparison = null;
  renderEditComparisonSummary();
  const promise = (async () => {
    const params = new URLSearchParams({ projectId, aVersionId, bVersionId });
    const response = await fetch(`/api/edit/compare?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法比较两个审片版本。");
    if (!state.editCompareEnabled
      || state.project?.projectId !== projectId
      || state.editWorkspace?.activeVersion !== aVersionId
      || state.editCompareVersionId !== bVersionId) return;
    state.editComparison = payload.comparison || null;
    renderEditComparisonSummary();
    renderEditTimeline();
  })().catch((error) => {
    if (state.project?.projectId === projectId) {
      state.editComparison = null;
      renderEditComparisonSummary();
      toast(error.message);
    }
  });
  editComparisonRequest = { key, promise };
  try { return await promise; } finally {
    if (editComparisonRequest?.key === key) editComparisonRequest = null;
  }
}

function renderEditCompareControls() {
  const versions = state.editWorkspace?.versions || [];
  const candidates = compareVersionOptions();
  const toggle = $("#editCompareToggle");
  toggle.disabled = versions.length < 2;
  toggle.classList.toggle("active", state.editCompareEnabled);
  toggle.textContent = state.editCompareEnabled ? "关闭 A/B" : "A/B 对比";
  const label = $("#editCompareVersionLabel");
  label.classList.toggle("hidden", !state.editCompareEnabled);
  const select = $("#editCompareVersionSelect");
  select.innerHTML = candidates.map((version) => `<option value="${escapeHtml(version.id)}">${escapeHtml(version.label)}</option>`).join("");
  if (!candidates.some((version) => version.id === state.editCompareVersionId)) {
    const activeIndex = versions.findIndex((version) => version.id === state.editWorkspace?.activeVersion);
    state.editCompareVersionId = versions[activeIndex - 1]?.id || candidates.at(-1)?.id || null;
  }
  select.value = state.editCompareVersionId || "";
  $("#editPreviewALabel").textContent = `A · ${state.editWorkspace?.versions?.find((item) => item.id === state.editWorkspace.activeVersion)?.label || state.editWorkspace?.activeVersion || "当前"}`;
  $("#editPreviewBLabel").textContent = `B · ${state.editCompareWorkspace?.versions?.find((item) => item.id === state.editCompareVersionId)?.label || state.editCompareVersionId || "选择版本"}`;
  $("#editCompareSyncStatus").classList.toggle("hidden", !state.editCompareEnabled);
  $("#editCompareBar").classList.toggle("hidden", !state.editCompareEnabled);
  $("#editPreviewStage").dataset.compareView = state.editCompareView;
  setEditCompareView(state.editCompareView);
  renderEditComparisonSummary();
  renderEditDraftCacheStatus();
}

async function loadEditCompareWorkspace(versionId = state.editCompareVersionId) {
  if (!state.project || !versionId || versionId === state.editWorkspace?.activeVersion) return;
  const projectId = state.project.projectId;
  const key = `${projectId}:${versionId}`;
  if (editCompareWorkspaceRequest?.key === key) return editCompareWorkspaceRequest.promise;
  const promise = (async () => {
    const response = await fetch(`/api/edit/workspace?projectId=${encodeURIComponent(projectId)}&versionId=${encodeURIComponent(versionId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法读取对比版本。");
    if (!state.editCompareEnabled || state.project?.projectId !== projectId || state.editCompareVersionId !== versionId) return;
    state.editCompareWorkspace = payload;
    resetEditCompareCache();
    renderEditCompareControls();
    loadEditCompareVideo({ preserveTime: true });
    await loadEditComparison();
  })().catch((error) => toast(error.message));
  editCompareWorkspaceRequest = { key, promise };
  try { return await promise; } finally {
    if (editCompareWorkspaceRequest?.key === key) editCompareWorkspaceRequest = null;
  }
}

function loadEditPreviewVideo(options = {}) {
  const video = $("#editPreviewVideo");
  const placeholder = $("#editPreviewPlaceholder");
  const artifact = editPreviewArtifact();
  if (!artifact) {
    unloadMediaElement(video, false);
    placeholder.classList.remove("hidden");
    return;
  }
  placeholder.classList.add("hidden");
  const source = editPreviewSource(artifact);
  if (video.dataset.mediaKey !== source.key) {
    const previousTime = Math.max(0, Number(video.currentTime) || 0);
    const sameArtifact = video.dataset.artifactId === artifact.id;
    const wasPlaying = !video.paused;
    const playbackRate = Number(video.playbackRate) || 1;
    const preservePlayback = options.preservePlayback && sameArtifact;
    if (preservePlayback) {
      video.addEventListener("loadedmetadata", () => {
        video.currentTime = Math.min(previousTime, Math.max(0, Number(video.duration) || previousTime));
        video.playbackRate = playbackRate;
        if (wasPlaying) video.play().catch(() => {});
      }, { once: true });
    } else {
      armMediaResume(video, artifact.id);
    }
    video.dataset.artifactId = artifact.id;
    video.dataset.mediaKey = source.key;
    video.dataset.cacheSource = source.cached ? "playback-proxy" : "project";
    delete video.dataset.reportedMediaError;
    video.src = source.url;
    video.playbackRate = 1;
    video.load();
  }
  $("#editPreviewTime").textContent = formatTime(video.currentTime);
  updateEditPlayhead();
  loadEditCompareVideo({ preserveTime: true });
}

function seekEditPreview(time) {
  const video = $("#editPreviewVideo");
  if (!video.src) return;
  video.currentTime = Math.max(0, Number(time) || 0);
  $("#editPreviewTime").textContent = formatTime(video.currentTime);
  updateEditPlayhead();
  syncEditCompare({ force: true });
}

function editSelectionLabel() {
  const entries = selectedEditEntries();
  if (entries.length > 1) return `已选 ${entries.length} 个对象 · ⌘/Ctrl 追加，Shift 连选`;
  const entry = entries[0];
  if (entry?.type === "clip") return `已选镜头：${entry.label} · ⌘/Ctrl 可追加`;
  if (entry?.type === "marker") return `已选${markerLabel(entry.marker.type)}：${entry.label} · ⌘/Ctrl 可追加`;
  if (entry?.type === "asset") return `已选素材：${entry.label} · ⌘/Ctrl 可追加`;
  return "尚未选中对象";
}

function selectedEditVersion() {
  const versionId = state.editWorkspace?.activeVersion || state.editVersionId;
  return state.editWorkspace?.versions?.find((item) => item.id === versionId) || null;
}

function selectedClipProxyDirectory() {
  const version = selectedEditVersion();
  if (!version) return "";
  return state.editPreviewMode === "draft"
    ? version.clipDraftDir || version.clipPreviewDir || ""
    : version.clipPreviewDir || version.clipDraftDir || "";
}

function displayProjectPath(relativePath) {
  const root = String(state.project?.editPath || state.project?.projectPath || "").replace(/\/$/, "");
  const relative = String(relativePath || "").replace(/^\//, "");
  return root && relative ? `${root}/${relative}` : relative || root;
}

function renderEditAssets() {
  const assets = state.editWorkspace?.assets || [];
  const clips = (state.editWorkspace?.clips || []).filter((clip) => clip.status !== "excluded");
  const previewArtifact = editPreviewArtifact();
  const usedAssets = assets.filter((asset) => asset.usedInCurrentCut || Number(asset.usedDuration) > 0);
  const currentCut = state.editWorkspace?.currentCut;
  const query = state.editAssetQuery.trim().toLocaleLowerCase();
  const effectiveFilter = state.editAssetFilter === "used" && !clips.length ? "all" : state.editAssetFilter;
  const proxyDirectory = selectedClipProxyDirectory();
  const pathLabel = $("#editAssetPath");
  const panel = $("#editAssetPanel");
  $("#editAssetCount").textContent = effectiveFilter === "used"
    ? `${clips.length} 个入片片段`
    : currentCut ? `${usedAssets.length} 个入片素材 · ${currentCut.clipCount || 0} 个镜头` : `${assets.length} 个素材`;
  pathLabel.textContent = effectiveFilter === "used" && proxyDirectory ? `当前目录 · ${displayProjectPath(proxyDirectory)}` : "";
  pathLabel.title = pathLabel.textContent;
  panel.classList.toggle("clip-mode", effectiveFilter === "used");
  const visible = assets.filter((asset) => {
    const haystack = `${asset.name} ${asset.pathLabel} ${asset.id}`.toLocaleLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (effectiveFilter === "used") return asset.status === "used" || asset.status === "partial";
    if (effectiveFilter === "partial") return asset.status === "partial";
    if (effectiveFilter === "excluded") return asset.status === "excluded" || asset.status === "unknown";
    return true;
  });
  $$(".edit-bin-filters button").forEach((button) => {
    button.classList.toggle("active", button.dataset.editAssetFilter === effectiveFilter);
  });
  if (effectiveFilter === "used") {
    const matchingClips = clips.filter((clip) => {
      if (!query) return true;
      return `${clip.proxyName} ${clip.sourceKey} ${clip.beat} ${clip.chapter}`.toLocaleLowerCase().includes(query);
    });
    const visibleClips = matchingClips.slice(0, state.editAssetRenderLimit);
    panel.innerHTML = matchingClips.length
      ? visibleClips.map((clip, index) => {
        const proxyFileId = state.editPreviewMode === "draft"
          ? clip.proxyDraftFileId || clip.proxyPreviewFileId
          : clip.proxyPreviewFileId || clip.proxyDraftFileId;
        const thumbnailFileId = proxyFileId || previewArtifact?.id;
        const thumbnailAt = proxyFileId ? 0.05 : Math.max(0, Number(clip.timelineIn) || 0);
        const thumbnailUrl = thumbnailFileId ? projectThumbnailUrl(thumbnailFileId, thumbnailAt) : "";
        const thumbnail = assetThumbnailMarkup(thumbnailUrl, `${clip.proxyName} 首帧`);
        const proxyPath = proxyDirectory ? `${proxyDirectory}/${clip.proxyName}` : clip.proxyName;
        return `
        <button class="edit-asset-card edit-proxy-card${isEditSelectionActive("clip", clip.id) ? " active" : ""}" data-edit-bin-clip="${escapeHtml(clip.id)}" aria-pressed="${isEditSelectionActive("clip", clip.id)}" aria-label="${escapeHtml(`${clip.proxyName}，跳转到 ${formatTime(clip.timelineIn)}`)}" title="${escapeHtml(proxyPath)}">
          <span class="edit-asset-thumb media-thumb media-thumb-${index % 6}">${thumbnail}<i>▶</i><b>${escapeHtml(String(clip.index + 1).padStart(2, "0"))} · ${escapeHtml(formatTime(clip.timelineIn).slice(3))}</b></span>
          <span class="edit-asset-copy"><strong>${escapeHtml(clip.proxyName)}</strong><small>${escapeHtml(clip.beat)} · ${escapeHtml(clip.chapter)}</small></span>
          <span class="edit-asset-duration"><span>${escapeHtml(clip.sourceKey)}</span><span>${formatTime(clip.duration)}</span></span>
        </button>`;
      }).join("") + (matchingClips.length > visibleClips.length
        ? `<button class="edit-load-more" type="button" data-edit-load-more>继续显示 ${Math.min(EDIT_ASSET_BATCH_SIZE, matchingClips.length - visibleClips.length)} 个片段 · 还剩 ${matchingClips.length - visibleClips.length} 个</button>`
        : "")
      : `<div class="edit-list-empty">当前版本没有符合搜索条件的入片片段。</div>`;
    return;
  }
  const visibleAssets = visible.slice(0, state.editAssetRenderLimit);
  panel.innerHTML = visible.length
    ? visibleAssets.map((asset, index) => {
      const previewTime = Math.max(0, Number(asset.timelineRanges?.[0]?.start) || 0);
      const proxyFileId = state.editPreviewMode === "draft"
        ? asset.proxyDraftFileId || asset.proxyPreviewFileId
        : asset.proxyPreviewFileId || asset.proxyDraftFileId;
      const thumbnailFileId = proxyFileId || asset.artifactId || previewArtifact?.id;
      const thumbnailAt = proxyFileId || asset.artifactId ? 0.05 : previewTime;
      const thumbnailUrl = thumbnailFileId ? projectThumbnailUrl(thumbnailFileId, thumbnailAt) : "";
      const thumbnail = assetThumbnailMarkup(thumbnailUrl, `${asset.name} 首帧`);
      return `
      <button class="edit-asset-card${isEditSelectionActive("asset", asset.id) ? " active" : ""}" data-edit-asset="${escapeHtml(asset.id)}" aria-pressed="${isEditSelectionActive("asset", asset.id)}">
        <span class="edit-asset-thumb media-thumb media-thumb-${index % 6}">${thumbnail}<i>${asset.type === "image" ? "▧" : "▶"}</i><b>${escapeHtml(asset.id)}</b></span>
        <span class="edit-asset-copy"><strong>${escapeHtml(asset.name)}</strong><small>${Number(asset.usedClipCount) || 0} 个入片镜头 · ${asset.status === "partial" ? "部分使用" : asset.status === "used" ? "已入片" : asset.status === "excluded" ? "未入片" : "待确认"}</small></span>
        <span class="edit-asset-duration">${asset.usedDuration ? `${formatTime(asset.usedDuration)} 入片` : asset.status === "unknown" ? "未核对" : "未入片"}</span>
      </button>`;
    }).join("") + (visible.length > visibleAssets.length
      ? `<button class="edit-load-more" type="button" data-edit-load-more>继续显示 ${Math.min(EDIT_ASSET_BATCH_SIZE, visible.length - visibleAssets.length)} 个素材 · 还剩 ${visible.length - visibleAssets.length} 个</button>`
      : "")
    : `<div class="edit-list-empty">当前版本没有符合筛选条件的入片素材。</div>`;
}

function renderEditClips() {
  const clips = state.editWorkspace?.clips || [];
  $("#editClipPanel").innerHTML = clips.length
    ? clips.map((clip) => `
      <button class="edit-clip-row${clip.status === "excluded" ? " excluded" : ""}${isEditSelectionActive("clip", clip.id) ? " active" : ""}" data-edit-clip="${escapeHtml(clip.id)}" aria-pressed="${isEditSelectionActive("clip", clip.id)}">
        <span class="edit-clip-index">${String(clip.index + 1).padStart(2, "0")}</span>
        <span class="edit-clip-time">${formatTime(clip.timelineIn)}</span>
        <span class="edit-clip-copy"><strong>${escapeHtml(clip.beat)}</strong><small>${escapeHtml(clip.sourceKey)} · ${escapeHtml(clip.chapter)}</small></span>
        <span class="edit-clip-state">${clip.status === "excluded" ? "已移除" : formatTime(clip.duration)}</span>
      </button>`).join("")
    : `<div class="edit-list-empty">当前 EDL 没有可解析的镜头。</div>`;
}

function renderEditSelection() {
  const entries = selectedEditEntries();
  const primary = resolveEditSelection(state.editSelection) || entries.at(-1) || null;
  const clip = primary?.clip || null;
  const marker = primary?.marker || null;
  const asset = primary?.asset || null;
  const selected = entries.length > 0;
  const selectionRange = editSelectionRange(entries);
  const markerRange = marker ? editMarkerOpinionRange(marker) : null;
  $("#editSelectionHint").textContent = editSelectionLabel();
  const selectionBanner = $("#editSelectionBanner");
  selectionBanner.classList.toggle("hidden", !selected);
  if (selected) {
    $("#editSelectionBannerTitle").textContent = entries.length > 1
      ? `已选 ${entries.length} 个对象${selectionRange ? ` · ${formatTime(selectionRange.start)}–${formatTime(selectionRange.end)}` : ""}`
      : clip
        ? `已选 1 个镜头 · ${formatTime(clip.timelineIn)}–${formatTime(clip.timelineOut)}`
        : marker
          ? `已选${markerLabel(marker.type)} · ${formatTime(markerRange.start)}–${formatTime(markerRange.end)}`
          : `已选素材 · ${asset.name}`;
    const labels = entries.map((entry) => entry.type === "clip"
      ? `${entry.clip.sourceKey} · ${entry.clip.id}`
      : entry.type === "marker"
        ? `${markerLabel(entry.marker.type)} · ${entry.marker.label}`
        : `素材 · ${entry.asset.name}`);
    $("#editSelectionBannerMeta").textContent = labels.length > 3
      ? `${labels.slice(0, 3).join("；")}；另 ${labels.length - 3} 项`
      : labels.join("；");
  }
  $("#editSelectionType").textContent = entries.length > 1 ? `多选（${entries.length}）` : clip ? "镜头" : marker ? markerLabel(marker.type) : asset ? "素材" : "—";
  $("#editSelectionEmpty").classList.toggle("hidden", selected);
  $("#editSelectionDetails").classList.toggle("hidden", !selected);
  if (!selected) return;
  $("#editSelectionTitle").textContent = entries.length > 1
    ? `${entries[0].label} 等 ${entries.length} 项`
    : clip?.beat || marker?.label || asset?.name || "—";
  $("#editSelectionPath").textContent = entries.length > 1
    ? entries.map((entry) => entry.type === "clip" ? entry.clip.sourceKey : entry.type === "marker" ? markerLabel(entry.marker.type) : entry.asset.name).join(" · ")
    : clip
      ? `${clip.sourceKey} · ${clip.sourcePathLabel}`
      : marker
        ? marker.sources.join(" / ") || `${markerLabel(marker.type)}时间线节点`
        : asset.pathLabel || "本地素材";
  $("#editSelectionIn").textContent = entries.length > 1 ? "多个范围" : clip ? formatTime(clip.sourceIn) : "—";
  $("#editSelectionOut").textContent = entries.length > 1 ? "多个范围" : clip ? formatTime(clip.sourceOut) : "—";
  $("#editSelectionTimeline").textContent = selectionRange
    ? `${formatTime(selectionRange.start)}–${formatTime(selectionRange.end)}`
    : asset ? `${asset.clipCount} 个镜头` : "—";
  $("#editSelectionStatus").textContent = entries.length > 1 ? "可批量提意见" : clip ? (clip.status === "excluded" ? "已移除" : "保留") : marker ? "可提意见" : "可选取";
  $("#editSelectionReason").textContent = entries.length > 1
    ? `这条意见会逐项引用 ${entries.length} 个对象及各自的精确时间范围，不会直接修改素材或包装。`
    : clip?.reason || (marker ? `意见会精确引用这个${markerLabel(marker.type)}的内容、时间范围和来源，不会直接修改包装文件。` : "选中素材后，可以在对话中指定具体源时间范围。");
  const primaryAction = $("[data-edit-action=\"remove\"]");
  const secondaryAction = $("[data-edit-action=\"trim\"]");
  const allClips = entries.every((entry) => entry.type === "clip");
  const allMarkers = entries.every((entry) => entry.type === "marker");
  primaryAction.textContent = entries.length > 1
    ? allClips ? "意见模板：移除所选镜头" : "意见模板：修改所选对象"
    : marker ? "意见模板：修改内容" : "意见模板：移除镜头";
  secondaryAction.textContent = entries.length > 1
    ? "意见模板：统一调整时长"
    : marker ? "意见模板：调整时长" : "意见模板：收紧当前段";
  const templatesAvailable = allMarkers || (allClips && entries.some((entry) => entry.clip.status !== "excluded"));
  $$("[data-edit-action]").forEach((button) => { button.disabled = !templatesAvailable; });
}

function nearestTimelineStep(target) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.reduce((best, step) => Math.abs(step - target) < Math.abs(best - target) ? step : best, steps[0]);
}

function minorTimelineStep(major) {
  if (major >= 60) return major / 6;
  if (major >= 30) return major / 6;
  if (major >= 15) return major / 3;
  return major / 5;
}

function formatRulerTime(seconds) {
  const formatted = formatTime(seconds);
  return seconds >= 3600 ? formatted.slice(0, 8) : formatted.slice(3, 8);
}

function renderTimelineRuler(duration, zoom) {
  const major = nearestTimelineStep(duration / Math.max(1, 10 * zoom));
  const minor = minorTimelineStep(major);
  const tickCount = Math.ceil(duration / minor);
  const majorTimes = [];
  const ticks = [];
  for (let index = 0; index <= tickCount; index += 1) {
    const time = index * minor;
    if (time > duration + .0001) break;
    const x = Math.min(1000, time / duration * 1000);
    const isMajor = index % Math.max(1, Math.round(major / minor)) === 0;
    if (isMajor) majorTimes.push(time);
    ticks.push(`<line class="edit-ruler-tick ${isMajor ? "major" : "minor"}" x1="${x.toFixed(3)}" x2="${x.toFixed(3)}" y1="${isMajor ? 15 : 20}" y2="27"></line>`);
  }
  const lastMajor = majorTimes.at(-1) ?? 0;
  if (duration - lastMajor < major * .62 && lastMajor > 0 && Math.abs(duration - lastMajor) > .001) majorTimes.pop();
  if (!majorTimes.some((time) => Math.abs(time - duration) < .001)) majorTimes.push(duration);
  const labels = majorTimes.map((time) => {
    const x = Math.min(1000, time / duration * 1000);
    const edge = time <= .001 ? "start" : Math.abs(time - duration) < .001 ? "end" : "middle";
    return `<text class="edit-ruler-label" transform="translate(${x.toFixed(3)} 0) scale(${(1 / zoom).toFixed(4)} 1)" x="0" y="11" text-anchor="${edge}">${escapeHtml(formatRulerTime(time))}</text>`;
  }).join("");
  return `<svg class="edit-timeline-ruler-svg" viewBox="0 0 1000 28" preserveAspectRatio="none" aria-label="时间轴刻度"><line class="edit-ruler-baseline" x1="0" x2="1000" y1="27" y2="27"></line>${ticks.join("")}${labels}</svg>`;
}

function markerCaptionClusters(entries, zoom) {
  const clusters = [];
  for (const entry of entries) {
    const previous = clusters.at(-1);
    const previousEntry = previous?.entries.at(-1);
    const closeOnScreen = previousEntry && (entry.x - previousEntry.x) * zoom <= 20;
    if (previous && closeOnScreen) {
      previous.entries.push(entry);
    } else {
      clusters.push({ x: entry.x, entries: [entry] });
    }
  }
  return clusters.map((cluster, index) => {
    const nextX = clusters[index + 1]?.x ?? 1000;
    const availablePixels = Math.max(24, Math.min(190, (nextX - cluster.x) * zoom - 8));
    const fullLabel = cluster.entries.map((entry) => entry.label).join(" · ");
    const fallbackLabel = cluster.entries.length > 1 ? `${cluster.entries[0].label} +${cluster.entries.length - 1}` : fullLabel;
    const maxCharacters = Math.max(3, Math.floor(availablePixels / 8));
    const sourceLabel = Array.from(fullLabel).length <= maxCharacters ? fullLabel : fallbackLabel;
    const characters = Array.from(sourceLabel);
    const label = characters.length <= maxCharacters ? sourceLabel : `${characters.slice(0, Math.max(2, maxCharacters - 1)).join("")}…`;
    return { ...cluster, label };
  });
}

function editDifferenceRange(difference) {
  const item = difference?.after || difference?.before || {};
  const start = Math.max(0, Number(item.timelineIn ?? item.timeline_in ?? item.time ?? item.start) || 0);
  const declaredEnd = Number(item.timelineOut ?? item.timeline_out ?? item.end);
  const duration = Math.max(0, Number(item.duration) || 0);
  const end = Number.isFinite(declaredEnd) ? Math.max(start, declaredEnd) : start + duration;
  return { start, end };
}

function editDifferenceLabel(difference) {
  const item = difference?.after || difference?.before || {};
  const subject = difference.kind === "marker"
    ? item.label || item.title || item.text || item.id || item.type || "包装节点"
    : item.beat || item.label || item.sourceKey || item.id || "镜头";
  return `${editDifferenceLabels[difference.status] || difference.status} · ${subject}`;
}

function renderEditTimeline() {
  const clips = state.editWorkspace?.clips || [];
  const duration = editDuration();
  const zoom = Math.max(1, Number(state.editTimelineZoom) || 1);
  const active = clips.filter((clip) => clip.status !== "excluded");
  $("#editTimelineEmpty").classList.toggle("hidden", active.length > 0);
  // SVG geometry keeps exact tick positions CSP-safe while the inverse text
  // scale preserves readable labels as the timeline zooms horizontally.
  $("#editTimelineRuler").innerHTML = renderTimelineRuler(duration, zoom);
  const playhead = Math.min(1000, Math.max(0, (Number($("#editPreviewVideo")?.currentTime) || 0) / duration * 1000));
  const playheadLine = `<line class="edit-playhead-line" x1="${playhead.toFixed(3)}" x2="${playhead.toFixed(3)}" y1="0" y2="38"></line>`;
  const renderClip = (clip, index = 0, audio = false) => {
    // SVG geometry attributes are not inline CSS, so they remain effective under
    // the strict style-src policy while preserving exact timeline positions.
    const start = Math.max(0, Number(clip.timelineIn) || 0);
    const end = Math.max(start, Number(clip.timelineOut) || start);
    const x = Math.min(1000, Math.max(0, start / duration * 1000));
    const width = Math.max(3, Math.min(1000 - x, (end - start) / duration * 1000));
    const label = audio ? "同期声" : clip.beat;
    const classes = `edit-timeline-clip-group${clip.status === "excluded" ? " excluded" : ""}${isEditSelectionActive("clip", clip.id) ? " active" : ""}`;
    const title = `${label} · ${formatTime(start)}`;
    const text = !audio && width * zoom > 42
      ? `<text class="edit-timeline-label" transform="translate(${x.toFixed(3)} 0) scale(${(1 / zoom).toFixed(4)} 1)" x="4" y="23">${escapeHtml(clip.sourceKey || clip.id)}</text>`
      : "";
    return `<g class="${classes} clip-tone-${index % 6}" data-edit-clip="${escapeHtml(clip.id)}" role="button" tabindex="0" aria-pressed="${isEditSelectionActive("clip", clip.id)}" aria-label="${escapeHtml(title)}"><rect class="edit-timeline-block" x="${x.toFixed(3)}" y="4" width="${width.toFixed(3)}" height="30" rx="3"></rect>${text}<title>${escapeHtml(title)}</title></g>`;
  };
  const renderLane = (items) => items.length
    ? `<svg class="edit-timeline-svg" viewBox="0 0 1000 38" preserveAspectRatio="none" role="list">${items.map((clip, index) => renderClip(clip, index)).join("")}${playheadLine}</svg>`
    : `<svg class="edit-timeline-svg" viewBox="0 0 1000 38" preserveAspectRatio="none" aria-hidden="true">${playheadLine}</svg>`;
  const renderAudioLane = (items) => {
    const waveform = Array.from({ length: 190 }, (_, index) => {
      const x = index * (1000 / 190) + 1;
      const pulse = Math.abs(Math.sin(index * .73) * .58 + Math.cos(index * .19) * .31);
      const height = 4 + pulse * 19;
      return `M${x.toFixed(3)} ${(19 - height / 2).toFixed(3)}V${(19 + height / 2).toFixed(3)}`;
    }).join("");
    const boundaries = items.map((clip) => {
      const x = Math.min(1000, Math.max(0, Number(clip.timelineIn) / duration * 1000));
      return `M${x.toFixed(3)} 4V34`;
    }).join("");
    return `<svg class="edit-timeline-svg" viewBox="0 0 1000 38" preserveAspectRatio="none" aria-label="同期声轻量波形"><path class="edit-audio-waveform" d="${waveform}"></path><path class="edit-audio-boundaries" d="${boundaries}"></path>${playheadLine}</svg>`;
  };
  const renderMarkerLane = (type) => {
    const entries = editTimelineMarkerEntries(type).map((marker) => {
      const { start, end } = marker;
      const minimumVisibleWidth = 1 / zoom;
      const rawX = Math.min(1000, Math.max(0, start / duration * 1000));
      const x = Math.min(1000 - minimumVisibleWidth, rawX);
      // The colored range is authoritative: it ends exactly when the graphic
      // disappears. A one-screen-pixel floor keeps point markers discoverable.
      const naturalWidth = Math.max(0, (end - start) / duration * 1000);
      const width = Math.min(1000 - x, Math.max(minimumVisibleWidth, naturalWidth));
      const { label } = marker;
      const title = `${markerLabel(type)} · ${formatTime(start)}–${formatTime(end)} · ${label}`;
      return { ...marker, x, width, title };
    });
    const captions = markerCaptionClusters(entries, zoom).map((cluster) => {
      const anchorAtEnd = cluster.x > 940;
      const labelX = anchorAtEnd ? -4 : 4;
      return `<g class="edit-marker-caption" aria-hidden="true"><line class="edit-marker-caption-stem" x1="${cluster.x.toFixed(3)}" x2="${cluster.x.toFixed(3)}" y1="11" y2="16"></line><text class="edit-marker-caption-label" transform="translate(${cluster.x.toFixed(3)} 0) scale(${(1 / zoom).toFixed(4)} 1)" x="${labelX}" y="10" text-anchor="${anchorAtEnd ? "end" : "start"}">${escapeHtml(cluster.label)}</text></g>`;
    }).join("");
    const markerNodes = entries.map((entry) => `<g class="edit-marker-group ${type}${isEditSelectionActive("marker", entry.id) ? " active" : ""}" data-edit-marker-id="${escapeHtml(entry.id)}" data-edit-marker-time="${entry.start}" data-edit-marker-end="${entry.end}" role="button" tabindex="0" aria-pressed="${isEditSelectionActive("marker", entry.id)}" aria-label="${escapeHtml(`${entry.title}，点击选择并提意见`)}"><rect class="edit-marker-block" x="${entry.x.toFixed(3)}" y="16" width="${entry.width.toFixed(3)}" height="18" rx="2"></rect><title>${escapeHtml(entry.title)}</title></g>`).join("");
    return `<svg class="edit-timeline-svg" viewBox="0 0 1000 38" preserveAspectRatio="none" role="list">${captions}${markerNodes}${playheadLine}</svg>`;
  };
  const renderDifferenceLane = () => {
    const differences = [...(state.editComparison?.clips || []), ...(state.editComparison?.markers || [])]
      .filter((item) => item.status !== "unchanged")
      .sort((a, b) => editDifferenceRange(a).start - editDifferenceRange(b).start);
    const nodes = differences.map((difference) => {
      const range = editDifferenceRange(difference);
      const minimumVisibleWidth = 2 / zoom;
      const x = Math.min(1000 - minimumVisibleWidth, Math.max(0, range.start / duration * 1000));
      const width = Math.min(1000 - x, Math.max(minimumVisibleWidth, (range.end - range.start) / duration * 1000));
      const label = editDifferenceLabel(difference);
      const text = width * zoom > 50
        ? `<text class="edit-diff-label" transform="translate(${x.toFixed(3)} 0) scale(${(1 / zoom).toFixed(4)} 1)" x="4" y="23">${escapeHtml(label)}</text>`
        : "";
      const title = `${label} · ${formatTime(range.start)}–${formatTime(range.end)}`;
      return `<g class="edit-diff-group ${escapeHtml(difference.status)}" data-edit-diff-time="${range.start}" role="button" tabindex="0" aria-label="${escapeHtml(`${title}，点击跳转`)}"><rect class="edit-diff-block" x="${x.toFixed(3)}" y="4" width="${width.toFixed(3)}" height="30" rx="3"></rect>${text}<title>${escapeHtml(title)}</title></g>`;
    }).join("");
    return `<svg class="edit-timeline-svg" viewBox="0 0 1000 38" preserveAspectRatio="none" role="list">${nodes}${playheadLine}</svg>`;
  };
  const showDifferenceLane = state.editCompareEnabled && Boolean(state.editComparison);
  $("#editDiffLaneRow").classList.toggle("hidden", !showDifferenceLane);
  $("#editDiffLane").innerHTML = showDifferenceLane ? renderDifferenceLane() : "";
  $("#editVideoLane").innerHTML = renderLane(active);
  $("#editAudioLane").innerHTML = renderAudioLane(active);
  $("#editGraphicsLane").innerHTML = renderMarkerLane("flower");
  $("#editChapterLane").innerHTML = renderMarkerLane("chapter");
  $("#editBgmLane").innerHTML = renderMarkerLane("bgm");
  $("#editSfxLane").innerHTML = renderMarkerLane("sfx");
  $(".edit-timeline").dataset.zoom = String(state.editTimelineZoom);
}

function updateEditPlayhead() {
  const duration = editDuration();
  const time = Number($("#editPreviewVideo")?.currentTime) || 0;
  const x = Math.min(1000, Math.max(0, time / duration * 1000)).toFixed(3);
  $$(".edit-timeline-svg .edit-playhead-line").forEach((line) => {
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
  });
}

function scheduleEditPlayheadUpdate() {
  if (editPlayheadFrame) return;
  editPlayheadFrame = requestAnimationFrame(() => {
    editPlayheadFrame = 0;
    $("#editPreviewTime").textContent = formatTime($("#editPreviewVideo").currentTime);
    updateEditPlayhead();
  });
}

function selectedEditOpinionContext() {
  const entries = selectedEditEntries();
  const multiple = entries.length > 1;
  const context = multiple ? [`受影响对象：共 ${entries.length} 个`] : [];
  entries.forEach((entry, index) => {
    const prefix = multiple ? `对象 ${index + 1}` : "";
    if (entry.type === "clip") {
      const clip = entry.clip;
      context.push(
        `${prefix ? `${prefix}（镜头）` : "受影响镜头"}：${clip.id} · ${clip.sourceKey || "未命名素材"}`,
        `${prefix ? `${prefix}正片范围` : "正片范围"}：${formatTime(clip.timelineIn)}–${formatTime(clip.timelineOut)}`,
        `${prefix ? `${prefix}源素材范围` : "源素材范围"}：${formatTime(clip.sourceIn)}–${formatTime(clip.sourceOut)}`,
        `${prefix ? `${prefix}故事节点` : "故事节点"}：${clip.beat || "未命名镜头"}`
      );
      return;
    }
    if (entry.type === "marker") {
      const marker = entry.marker;
      const markerClip = editClipAtTime(marker.start);
      context.push(
        `${prefix ? `${prefix}（${markerLabel(marker.type)}）` : "受影响节点"}：${markerLabel(marker.type)} · ${marker.label}`,
        `${prefix ? `${prefix}节点范围` : "节点范围"}：${formatTime(entry.start)}–${formatTime(entry.end)}`,
        `${prefix ? `${prefix}节点来源` : "节点来源"}：${marker.sources.join(" / ") || "当前版本包装方案"}`
      );
      if (markerClip) context.push(`${prefix ? `${prefix}所在镜头` : "所在镜头"}：${markerClip.beat || markerClip.id} · ${markerClip.sourceKey}`);
      return;
    }
    const asset = entry.asset;
    context.push(
      `${prefix ? `${prefix}（素材）` : "受影响素材"}：${asset.name}`,
      `${prefix ? `${prefix}成片使用情况` : "当前成片使用"}：${Number(asset.usedClipCount ?? asset.clipCount) || 0} 个镜头`
    );
  });
  if (!entries.length) context.push("受影响范围：用户尚未选择具体镜头、素材或包装节点");
  const selections = entries.map(editSelectionSnapshot);
  return {
    context,
    selections,
    selection: selections[0] || emptyEditSelection()
  };
}

function captureEditOpinion(existingOpinion = null) {
  const note = $("#editCommand").value.trim();
  if (!note) throw new Error("请先写下你的意见。");
  const start = parseTime($("#editOpinionStart").value);
  let end = parseTime($("#editOpinionEnd").value);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("请检查意见的开始和结束时间码。");
  if (end < start) throw new Error("意见结束时间不能早于开始时间。");
  if (end === start) end = Math.min(editDuration(), start + 2);
  const captured = selectedEditOpinionContext();
  const reuseExistingSelection = !captured.selections.length && existingOpinion;
  const context = reuseExistingSelection ? existingOpinion.context : captured.context;
  const selections = reuseExistingSelection
    ? existingOpinion.selections || (existingOpinion.selection?.type ? [existingOpinion.selection] : [])
    : captured.selections;
  const selection = selections[0] || captured.selection;
  const now = new Date().toISOString();
  return {
    id: existingOpinion?.id || crypto.randomUUID(),
    createdAt: existingOpinion?.createdAt || now,
    ...(existingOpinion ? { updatedAt: now } : {}),
    versionId: existingOpinion?.versionId || state.editWorkspace?.activeVersion || state.editVersionId || null,
    previewFile: existingOpinion?.previewFile || editPreviewArtifact()?.relativePath || null,
    timelineTime: Number((Number($("#editPreviewVideo")?.currentTime) || 0).toFixed(3)),
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    note,
    context,
    selection,
    selections
  };
}

function buildEditOpinionPrompt(opinions = state.editOpinions) {
  if (!opinions.length) throw new Error("请先加入至少一条意见。");
  const grouped = new Map();
  opinions.forEach((opinion, index) => {
    const versionId = opinion.versionId || "未记录版本";
    if (!grouped.has(versionId)) grouped.set(versionId, []);
    grouped.get(versionId).push({ opinion, index });
  });
  const opinionBlocks = [...grouped.entries()].map(([versionId, entries]) => [
    `## 审片版本：${versionId}`,
    ...entries.map(({ opinion, index }) => [
      `意见 ${index + 1}：`,
      `- 审片文件：${opinion.previewFile || "未记录文件"}`,
      `- 意见范围：${formatTime(opinion.start ?? opinion.timelineTime ?? 0)}–${formatTime(opinion.end ?? opinion.start ?? opinion.timelineTime ?? 0)}`,
      `- 播放位置：${formatTime(opinion.timelineTime || 0)}`,
      ...opinion.context.map((line) => `- ${line}`),
      "用户意见：",
      opinion.note
    ].join("\n"))
  ].join("\n\n")).join("\n\n");
  const prompt = [
    "请继续当前本地视频项目的剪辑审片。",
    "",
    "本轮只整理意见并生成结构化反馈，不要直接修改素材、EDL、字幕或项目文件；等待我确认后再执行。",
    `项目：${state.project?.name || "当前本地项目"}`,
    `当前查看版本：${state.editWorkspace?.activeVersion || "当前审片版本"}`,
    "",
    `本轮共 ${opinions.length} 条用户意见：`,
    opinionBlocks,
    "",
    "请输出：精确时间范围、受影响资产、建议动作、理由、需要保留的内容和待确认问题。"
  ].join("\n");
  return { prompt, summary: `${opinions.length} 条意见`, context: opinions.flatMap((opinion) => opinion.context) };
}

function cloneEditOpinions(opinions) {
  return opinions.map((opinion) => ({
    ...opinion,
    context: [...(opinion.context || [])],
    selections: (opinion.selections || []).map((selection) => ({ ...selection, sources: [...(selection.sources || [])] })),
    selection: opinion.selection ? { ...opinion.selection, sources: [...(opinion.selection.sources || [])] } : null
  }));
}

function renderEditRevisionHistory() {
  const revisions = state.editRevisions || [];
  $("#editRevisionCount").textContent = String(revisions.length);
  const panel = $("#editRevisionPanel");
  if (!revisions.length) {
    panel.innerHTML = `<div class="edit-revision-empty"><strong>还没有修订记录</strong><p>生成最终 Prompt 后，本轮待整理意见会自动归档到这里。</p></div>`;
    return;
  }
  panel.innerHTML = revisions.map((revision, index) => {
    const expanded = state.expandedEditRevisionId === revision.id;
    const versionIds = revision.versionIds?.length
      ? revision.versionIds.join(" / ")
      : revision.versionId || "未记录版本";
    const notes = revision.opinions.map((opinion) => opinion.note).filter(Boolean);
    return `
      <article class="edit-revision-card${expanded ? " expanded" : ""}" data-edit-revision-id="${escapeHtml(revision.id)}">
        <div class="edit-revision-head">
          <div><small>修订 ${revisions.length - index}</small><strong>${escapeHtml(formatDate(revision.createdAt))}</strong></div>
          <span>${revision.opinions.length} 条</span>
        </div>
        <p class="edit-revision-version">${escapeHtml(versionIds)}</p>
        <ol>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ol>
        ${expanded ? `<pre>${escapeHtml(revision.prompt)}</pre>` : ""}
        <div class="edit-revision-actions">
          <button type="button" data-edit-revision-action="toggle" data-edit-revision-id="${escapeHtml(revision.id)}">${expanded ? "收起" : "查看 Prompt"}</button>
          <button type="button" data-edit-revision-action="restore" data-edit-revision-id="${escapeHtml(revision.id)}">继续修订</button>
          <button type="button" data-edit-revision-action="copy" data-edit-revision-id="${escapeHtml(revision.id)}">复制 Prompt</button>
          <button type="button" data-edit-revision-action="delete" data-edit-revision-id="${escapeHtml(revision.id)}">删除记录</button>
        </div>
      </article>`;
  }).join("");
}

function renderEditChatTab() {
  const history = state.editChatTab === "history";
  $$("[data-edit-chat-tab]").forEach((button) => {
    const active = button.dataset.editChatTab === state.editChatTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#editConversation").classList.toggle("hidden", history);
  $("#editOpinionComposer").classList.toggle("hidden", history);
  $("#editRevisionPanel").classList.toggle("hidden", !history);
  renderEditRevisionHistory();
}

function archiveEditOpinionPrompt() {
  const opinions = cloneEditOpinions(state.editOpinions || []);
  const generated = buildEditOpinionPrompt(opinions);
  const versionIds = [...new Set(opinions.map((opinion) => opinion.versionId || "未记录版本"))];
  const revision = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    projectName: state.project?.name || "当前本地项目",
    versionId: state.editWorkspace?.activeVersion || state.editVersionId || null,
    versionIds,
    previewFiles: [...new Set(opinions.map((opinion) => opinion.previewFile).filter(Boolean))],
    opinions,
    ...generated
  };
  state.editRevisions = [revision, ...(state.editRevisions || [])].slice(0, 100);
  state.editOpinions = [];
  state.editProposal = null;
  state.editingOpinionId = null;
  state.expandedEditRevisionId = revision.id;
  state.editChatTab = "history";
  $("#editCommand").value = "";
  cacheEditOpinions();
  cacheEditRevisions();
  updateEditOpinionEditorState();
  renderEditProposal();
  renderEditChatTab();
  toast(`已归档 ${opinions.length} 条意见，并清空待整理列表。`);
  return revision;
}

function restoreEditRevision(revision) {
  if ((state.editOpinions || []).some((opinion) => opinion.sourceRevisionId === revision.id)) {
    state.editChatTab = "conversation";
    renderEditChatTab();
    return toast("这条修订已经恢复到待整理列表。 ");
  }
  const restoredAt = new Date().toISOString();
  const restored = cloneEditOpinions(revision.opinions || []).map((opinion) => ({
    ...opinion,
    id: crypto.randomUUID(),
    createdAt: restoredAt,
    updatedAt: restoredAt,
    sourceRevisionId: revision.id
  }));
  state.editOpinions = [...(state.editOpinions || []), ...restored].slice(-300);
  state.editProposal = null;
  state.editingOpinionId = null;
  state.editChatTab = "conversation";
  cacheEditOpinions();
  updateEditOpinionEditorState();
  renderEditProposal();
  renderEditChatTab();
  toast(`已把 ${restored.length} 条意见恢复为待整理，可继续修改。`);
}

function renderEditProposal() {
  const proposal = state.editProposal;
  const opinions = state.editOpinions || [];
  $("#editConfirmCount").textContent = `${opinions.length} 条待整理`;
  const target = $("#editProposalCard");
  if (!opinions.length && !proposal) {
    target.classList.add("hidden");
    target.innerHTML = "";
    return;
  }
  target.classList.remove("hidden");
  const opinionList = opinions.length
    ? `<ol class="edit-opinion-list">${opinions.map((opinion, index) => `
      <li class="edit-opinion-item${state.editingOpinionId === opinion.id ? " editing" : ""}" data-edit-opinion-id="${escapeHtml(opinion.id)}">
        <div class="edit-opinion-item-head">
          <span>意见 ${index + 1}</span>
          <div class="edit-opinion-item-actions">
            <button type="button" data-edit-opinion-action="edit" data-edit-opinion-id="${escapeHtml(opinion.id)}">编辑</button>
            <button type="button" data-edit-opinion-action="delete" data-edit-opinion-id="${escapeHtml(opinion.id)}">删除</button>
          </div>
        </div>
        <strong>${escapeHtml(opinion.note)}</strong>
        <small>${escapeHtml(`${opinion.versionId || "旧意见"} · ${formatTime(opinion.start ?? opinion.timelineTime ?? 0)}–${formatTime(opinion.end ?? opinion.start ?? opinion.timelineTime ?? 0)}`)}</small>
        <p>${escapeHtml((opinion.context || []).join("；") || "未指定范围")}</p>
      </li>`).join("")}</ol>`
    : "";
  if (!proposal) {
    target.innerHTML = `
      <div class="edit-proposal-head"><span class="edit-proposal-badge">${opinions.length} 条</span><strong>待整理意见</strong><button data-edit-proposal-action="clear" aria-label="清空意见">×</button></div>
      ${opinionList}
      <div class="edit-proposal-actions"><button data-edit-proposal-action="generate" class="button primary">生成最终 Prompt →</button></div>
      <small class="edit-proposal-note">可以继续加入意见；生成最终 Prompt 前不会写入任何项目文件。</small>`;
    return;
  }
  target.innerHTML = `
    <div class="edit-proposal-head"><span class="edit-proposal-badge">PROMPT</span><strong>最终意见 Prompt · ${opinions.length} 条</strong><button data-edit-proposal-action="dismiss" aria-label="关闭 Prompt">×</button></div>
    ${opinionList}
    <p class="edit-proposal-summary">${escapeHtml(proposal.summary)}</p>
    <pre class="edit-opinion-prompt">${escapeHtml(proposal.prompt)}</pre>
    <div class="edit-proposal-actions"><button data-edit-proposal-action="copy" class="button primary">复制意见 Prompt</button><button data-edit-proposal-action="generate" class="button secondary">重新生成</button></div>
    <small class="edit-proposal-note">仅生成文本，不会写入操作日志、草稿 EDL、字幕或源素材。</small>`;
}

function renderEditWorkspace() {
  const workspace = state.editWorkspace;
  const hasProject = Boolean(state.project);
  $("#editNeedsProject").classList.toggle("hidden", hasProject);
  $("#editWorkspace").classList.toggle("hidden", !hasProject);
  if (!hasProject || !workspace) return;
  $("#editWorkspaceMeta").textContent = workspace.base
    ? `${workspace.base.relativePath} · 当前成片 ${workspace.currentCut?.sourceCount || 0} 个素材 / ${workspace.currentCut?.clipCount || 0} 个镜头 · ${formatTime(workspace.duration)}`
    : "没有 EDL，将从对话指令开始建立草稿。";
  $("#editHistoryLabel").textContent = "意见模式 · 不写入";
  const index = state.project?.index;
  $("#editIndexStatus").textContent = index?.cacheHit
    ? `增量索引 · ${index.durationMs || 0} ms`
    : index?.mode === "refreshed" ? `索引已刷新 · ${index.durationMs || 0} ms` : "本地索引已建立";
  $("#editHeaderVersion").textContent = workspace.activeVersion || workspace.base?.name || "当前版本";
  $("#editVersionSelect").innerHTML = workspace.versions?.length
    ? workspace.versions.map((version) => `<option value="${escapeHtml(version.id)}">${escapeHtml(version.label)}${version.isActive ? " · 当前" : ""}</option>`).join("")
    : `<option value="${escapeHtml(workspace.activeVersion || "current")}">${escapeHtml(workspace.activeVersion || "当前版本")}</option>`;
  $("#editVersionSelect").value = workspace.activeVersion || $("#editVersionSelect").options[0]?.value || "";
  const hasDraftPreview = Boolean(workspace.preview?.draft);
  const draftButton = $("[data-edit-preview-mode=\"draft\"]");
  draftButton.disabled = !hasDraftPreview;
  if (!hasDraftPreview && state.editPreviewMode === "draft") state.editPreviewMode = "standard";
  $$(".edit-preview-modes button").forEach((button) => button.classList.toggle("active", button.dataset.editPreviewMode === state.editPreviewMode));
  renderEditCompareControls();
  $("#editConfirmCount").textContent = `${state.editOpinions?.length || 0} 条待整理`;
  $("#editTimelineClipCount").textContent = workspace.clips.filter((clip) => clip.status !== "excluded").length;
  $("#editTimelineDuration").textContent = formatTime(workspace.duration);
  $("#editUndoButton").disabled = !workspace.operations.some((item) => item.status === "applied");
  if (state.editMediaTab === "clips") renderEditClips();
  else renderEditAssets();
  renderEditSelection();
  renderEditTimeline();
  renderEditDraftCacheStatus();
  if (document.body.dataset.page === "edit") {
    loadEditPreviewVideo();
    ensureEditDraftCache();
    if (state.editCompareEnabled && state.editCompareVersionId && state.editCompareWorkspace?.activeVersion !== state.editCompareVersionId) {
      loadEditCompareWorkspace();
    }
  }
  renderEditProposal();
  renderEditChatTab();
  updateEditOpinionEditorState();
}

function restoreEditTimelineViewAfterRender(view) {
  requestAnimationFrame(() => {
    if (document.body.dataset.page !== "edit") return;
    $("#editTimelineViewport").scrollLeft = view.scrollLeft;
    const video = $("#editPreviewVideo");
    const restoreTime = () => seekEditPreview(Math.min(view.time, Math.max(0, Number(video.duration) || view.time)));
    if (video.readyState >= 1) restoreTime();
    else video.addEventListener("loadedmetadata", restoreTime, { once: true });
  });
}

async function loadEditWorkspace(versionId = state.editVersionId) {
  if (!state.project) return;
  const projectId = state.project.projectId;
  const requestKey = `${projectId}:${versionId || "active"}`;
  if (editWorkspaceRequest?.key === requestKey) return editWorkspaceRequest.promise;
  const promise = (async () => {
    try {
      const versionQuery = versionId ? `&versionId=${encodeURIComponent(versionId)}` : "";
      const response = await fetch(`/api/edit/workspace?projectId=${encodeURIComponent(projectId)}${versionQuery}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取剪辑工作台。");
      if (state.project?.projectId !== projectId || editWorkspaceRequest?.key !== requestKey) return;
      state.editWorkspace = payload;
      state.editVersionId = payload.activeVersion || versionId || null;
      state.editProposal = null;
      state.editAssetRenderLimit = EDIT_ASSET_BATCH_SIZE;
      const view = loadEditTimelineView(state.editVersionId);
      state.editTimelineZoom = view.zoom;
      $("#editTimelineZoom").value = String(view.zoom);
      $(".edit-timeline").dataset.zoom = String(view.zoom);
      if (document.body.dataset.page === "edit") {
        renderEditWorkspace();
        restoreEditTimelineViewAfterRender(view);
      }
    } catch (error) {
      if (state.project?.projectId === projectId && editWorkspaceRequest?.key === requestKey) toast(error.message);
    }
  })();
  editWorkspaceRequest = { key: requestKey, promise };
  try {
    return await promise;
  } finally {
    if (editWorkspaceRequest?.key === requestKey) editWorkspaceRequest = null;
  }
}

function setEditOpinionRange(start, end = start) {
  const normalizedStart = Math.max(0, Math.min(editDuration(), Number(start) || 0));
  const normalizedEnd = Math.max(normalizedStart, Math.min(editDuration(), Number(end) || normalizedStart));
  $("#editOpinionStart").value = formatTime(normalizedStart);
  $("#editOpinionEnd").value = formatTime(normalizedEnd);
}

function updateEditOpinionEditorState() {
  const editing = Boolean(state.editingOpinionId);
  $("#editProposeButton").textContent = editing ? "保存修改" : "加入意见 +";
  $("#editCancelOpinionButton").classList.toggle("hidden", !editing);
  $("#editCommand").setAttribute("aria-label", editing ? "编辑意见描述" : "意见描述");
}

function cancelEditOpinion({ clearCommand = true } = {}) {
  state.editingOpinionId = null;
  if (clearCommand) $("#editCommand").value = "";
  updateEditOpinionEditorState();
  updateOpinionRangeFromSelection();
  renderEditProposal();
}

function startEditOpinion(opinionId) {
  const opinion = state.editOpinions.find((item) => item.id === opinionId);
  if (!opinion) return;
  state.editingOpinionId = opinion.id;
  state.editProposal = null;
  $("#editCommand").value = opinion.note;
  setEditOpinionRange(opinion.start ?? opinion.timelineTime ?? 0, opinion.end ?? opinion.start ?? opinion.timelineTime ?? 0);
  const selections = opinion.selections?.length
    ? opinion.selections
    : opinion.selection?.type ? [opinion.selection] : [];
  if (selections.length) setCurrentEditSelections(selections, selections.at(-1));
  renderEditSelectionState();
  updateEditOpinionEditorState();
  renderEditProposal();
  $("#editCommand").focus();
  $("#editCommand").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function applyEditSelection(selection, { additive = false, range = false } = {}) {
  const current = currentEditSelections();
  const key = editSelectionKey(selection);
  if (range && selection.type === "clip") {
    const clips = (state.editWorkspace?.clips || []).filter((clip) => clip.status !== "excluded");
    const anchorId = state.editSelection.type === "clip"
      ? state.editSelection.id
      : [...current].reverse().find((item) => item.type === "clip")?.id;
    const anchorIndex = clips.findIndex((clip) => clip.id === anchorId);
    const targetIndex = clips.findIndex((clip) => clip.id === selection.id);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const rangeSelections = clips.slice(start, end + 1).map((clip) => ({ type: "clip", id: clip.id, assetId: clip.sourceKey }));
      setCurrentEditSelections(additive ? [...current, ...rangeSelections] : rangeSelections, selection);
      return;
    }
  }
  if (additive) {
    const exists = current.some((item) => editSelectionKey(item) === key);
    const next = exists ? current.filter((item) => editSelectionKey(item) !== key) : [...current, selection];
    const primary = exists && editSelectionKey(state.editSelection) === key ? next.at(-1) : selection;
    setCurrentEditSelections(next, primary);
    return;
  }
  setCurrentEditSelections([selection], selection);
}

function updateOpinionRangeFromSelection() {
  const range = editSelectionRange();
  if (range) setEditOpinionRange(range.start, range.end);
  else {
    const time = Number($("#editPreviewVideo")?.currentTime) || 0;
    setEditOpinionRange(time, time);
  }
}

function editSelectionOptions(event) {
  return { additive: Boolean(event?.metaKey || event?.ctrlKey), range: Boolean(event?.shiftKey) };
}

function selectEditAsset(assetId, options = {}) {
  applyEditSelection({ type: "asset", id: null, assetId }, options);
  updateOpinionRangeFromSelection();
  renderEditSelectionState();
}

function updateEditSelectionClasses() {
  const keys = new Set(currentEditSelections().map(editSelectionKey));
  $$("[data-edit-bin-clip]", $("#editAssetPanel")).forEach((item) => {
    const active = keys.has(`clip:${item.dataset.editBinClip}`);
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  $$("[data-edit-asset]", $("#editAssetPanel")).forEach((item) => {
    const active = keys.has(`asset:${item.dataset.editAsset}`);
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  $$("[data-edit-clip]", $("#editClipPanel")).forEach((item) => {
    const active = keys.has(`clip:${item.dataset.editClip}`);
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  $$(".edit-timeline-clip-group[data-edit-clip]").forEach((item) => {
    const active = keys.has(`clip:${item.dataset.editClip}`);
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  $$(".edit-marker-group[data-edit-marker-id]").forEach((item) => {
    const active = keys.has(`marker:${item.dataset.editMarkerId}`);
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
}

function renderEditSelectionState() {
  updateEditSelectionClasses();
  renderEditSelection();
}

function selectEditClip(clipId, seekTime = null, options = {}) {
  const clip = state.editWorkspace?.clips?.find((item) => item.id === clipId);
  if (!clip) return;
  applyEditSelection({ type: "clip", id: clipId, assetId: clip.sourceKey }, options);
  updateOpinionRangeFromSelection();
  renderEditSelectionState();
  seekEditPreview(seekTime === null ? clip.timelineIn : seekTime);
}

function selectEditMarker(markerId, options = {}) {
  const marker = editTimelineMarkerEntries().find((item) => item.id === markerId);
  if (!marker) return;
  applyEditSelection({ type: "marker", id: marker.id, assetId: null, marker }, options);
  const range = editMarkerOpinionRange(marker);
  updateOpinionRangeFromSelection();
  renderEditSelectionState();
  seekEditPreview(range.start);
}

$("#editAssetPanel").addEventListener("click", (event) => {
  const loadMore = event.target.closest("[data-edit-load-more]");
  if (loadMore) {
    const panel = event.currentTarget;
    const scrollTop = panel.scrollTop;
    state.editAssetRenderLimit += EDIT_ASSET_BATCH_SIZE;
    renderEditAssets();
    panel.scrollTop = scrollTop;
    return;
  }
  const clipButton = event.target.closest("[data-edit-bin-clip]");
  if (clipButton) return selectEditClip(clipButton.dataset.editBinClip, null, editSelectionOptions(event));
  const button = event.target.closest("[data-edit-asset]");
  if (button) selectEditAsset(button.dataset.editAsset, editSelectionOptions(event));
});
$("#editClipPanel").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-clip]");
  if (button) selectEditClip(button.dataset.editClip, null, editSelectionOptions(event));
});
$("#editClearSelectionButton").addEventListener("click", () => {
  setCurrentEditSelections([]);
  updateOpinionRangeFromSelection();
  renderEditSelectionState();
});

function editTimelineTimeFromRect(clientX, rect) {
  if (!rect || rect.width <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return Number((ratio * editDuration()).toFixed(3));
}

function seekEditTimelineGesture(clientX) {
  const gesture = state.editTimelineSeekGesture;
  if (!gesture) return;
  seekEditPreview(editTimelineTimeFromRect(clientX, gesture.rect));
}

$("#editTimelineViewport").addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const surface = event.target.closest(".edit-track, #editTimelineRuler");
  if (!surface) return;
  event.currentTarget.focus({ preventScroll: true });
  const rect = surface.getBoundingClientRect();
  const video = $("#editPreviewVideo");
  const marker = event.target.closest("[data-edit-marker-time]");
  const clip = event.target.closest("[data-edit-clip]");
  const difference = event.target.closest("[data-edit-diff-time]");
  const time = marker
    ? Number(marker.dataset.editMarkerTime)
    : difference
      ? Number(difference.dataset.editDiffTime)
      : editTimelineTimeFromRect(event.clientX, rect);
  state.editTimelineSeekGesture = {
    pointerId: event.pointerId,
    rect: { left: rect.left, width: rect.width },
    wasPlaying: !video.paused
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.classList.add("scrubbing");
  video.pause();
  const selectionOptions = editSelectionOptions(event);
  if (marker) selectEditMarker(marker.dataset.editMarkerId, selectionOptions);
  else if (clip) selectEditClip(clip.dataset.editClip, time, selectionOptions);
  else seekEditPreview(time);
  event.preventDefault();
});

$("#editTimelineViewport").addEventListener("pointermove", (event) => {
  if (state.editTimelineSeekGesture?.pointerId === event.pointerId) seekEditTimelineGesture(event.clientX);
});

function finishEditTimelineSeek(event) {
  const gesture = state.editTimelineSeekGesture;
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  state.editTimelineSeekGesture = null;
  event.currentTarget.classList.remove("scrubbing");
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  saveEditTimelineView();
  if (gesture.wasPlaying) $("#editPreviewVideo").play().catch(() => {});
}

$("#editTimelineViewport").addEventListener("pointerup", finishEditTimelineSeek);
$("#editTimelineViewport").addEventListener("pointercancel", finishEditTimelineSeek);
$("#editTimelineViewport").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const video = $("#editPreviewVideo");
  const step = event.shiftKey ? 5 : event.altKey ? .1 : 1;
  const direction = event.key === "ArrowLeft" ? -1 : 1;
  const duration = Number.isFinite(Number(video.duration)) && Number(video.duration) > 0
    ? Number(video.duration)
    : editDuration();
  seekEditPreview(Math.min(duration, Math.max(0, (Number(video.currentTime) || 0) + direction * step)));
  scheduleEditTimelineViewSave();
});

function activeWorkspaceVideo() {
  if (document.body.dataset.page === "edit") return $("#editPreviewVideo");
  if (document.body.dataset.page === "review") return $("#reviewVideo");
  return null;
}

function isTextEntryTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest("textarea, select, [contenteditable=\"true\"]")) return true;
  const input = target.closest("input");
  return Boolean(input && !["button", "checkbox", "radio", "range"].includes(input.type));
}

document.addEventListener("keydown", (event) => {
  if (event.repeat || event.defaultPrevented || isTextEntryTarget(event.target)) return;
  if (event.code === "Backslash" && document.body.dataset.page === "edit" && state.editCompareEnabled) {
    event.preventDefault();
    const views = ["a", "split", "b"];
    const next = views[(views.indexOf(state.editCompareView) + 1) % views.length];
    setEditCompareView(next);
    toast(next === "a" ? "只看 A 版。" : next === "b" ? "只看 B 版。" : "A/B 分屏查看。");
    return;
  }
  if (event.code !== "Space") return;
  const video = activeWorkspaceVideo();
  if (!video?.src) return;
  event.preventDefault();
  if (video.paused) video.play().catch(() => {});
  else video.pause();
});
$("#editPreviewVideo").addEventListener("timeupdate", () => {
  scheduleEditPlayheadUpdate();
  scheduleEditTimelineViewSave();
  syncEditCompare({ playback: true });
});
$("#editPreviewVideo").addEventListener("play", () => syncEditCompare({ force: true, playback: true }));
$("#editPreviewVideo").addEventListener("pause", () => syncEditCompare());
$("#editPreviewVideo").addEventListener("seeking", () => syncEditCompare({ force: true }));
$("#editPreviewVideo").addEventListener("ratechange", () => syncEditCompare({ force: true }));
$("#editPreviewVideo").addEventListener("loadedmetadata", () => {
  const clip = editSelectedClip();
  if (clip) seekEditPreview(clip.timelineIn);
  else updateEditPlayhead();
});
$("#editPreviewVideo").addEventListener("error", (event) => {
  const video = event.currentTarget;
  if (video.dataset.cacheSource === "playback-proxy" && state.editDraftCache?.status === "ready") {
    state.editDraftCache = { ...state.editDraftCache, status: "error", error: "播放代理不可用，已回退项目视频。", proxyFileId: null, cacheFileId: null };
    renderEditDraftCacheStatus();
    loadEditPreviewVideo({ preservePlayback: true });
    return toast("播放代理不可用，已自动回退项目视频。 ");
  }
  if (video.dataset.reportedMediaError !== video.dataset.mediaKey) {
    video.dataset.reportedMediaError = video.dataset.mediaKey || "project";
    toast("当前视频无法播放；可重新读取项目或切换审片版本。 ");
  }
});
$("#editCompareVideo").addEventListener("error", (event) => {
  const video = event.currentTarget;
  if (video.dataset.cacheSource === "playback-proxy" && state.editCompareCache?.status === "ready") {
    state.editCompareCache = { ...state.editCompareCache, status: "error", error: "B 版播放代理不可用，已回退项目视频。", proxyFileId: null, cacheFileId: null };
    loadEditCompareVideo({ preserveTime: true });
    return toast("B 版播放代理不可用，已自动回退项目视频。 ");
  }
  if (video.dataset.reportedMediaError !== video.dataset.mediaKey) {
    video.dataset.reportedMediaError = video.dataset.mediaKey || "project";
    toast("B 版视频无法播放，请切换对比版本。 ");
  }
});
$("#editCompareVideo").addEventListener("waiting", () => {
  if (state.editCompareEnabled) $("#editCompareSyncStatus").textContent = "B 缓冲中…";
});
$("#editCompareVideo").addEventListener("canplay", () => syncEditCompare({ force: true, playback: true }));
$("#editCompareVideo").addEventListener("ended", () => {
  if (state.editCompareEnabled) $("#editCompareSyncStatus").textContent = "B 已结束";
});
$("#editSetStartButton").addEventListener("click", () => {
  $("#editOpinionStart").value = formatTime($("#editPreviewVideo").currentTime);
});
$("#editSetEndButton").addEventListener("click", () => {
  $("#editOpinionEnd").value = formatTime($("#editPreviewVideo").currentTime);
});
let editAssetSearchTimer = 0;
$("#editAssetSearch").addEventListener("input", (event) => {
  state.editAssetQuery = event.target.value;
  state.editAssetRenderLimit = EDIT_ASSET_BATCH_SIZE;
  window.clearTimeout(editAssetSearchTimer);
  editAssetSearchTimer = window.setTimeout(renderEditAssets, 120);
});
$(".edit-bin-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-asset-filter]");
  if (!button) return;
  state.editAssetFilter = button.dataset.editAssetFilter;
  state.editAssetRenderLimit = EDIT_ASSET_BATCH_SIZE;
  $$(".edit-bin-filters button").forEach((item) => item.classList.toggle("active", item === button));
  renderEditAssets();
});
$("#editAssetPanel").addEventListener("scroll", (event) => {
  const panel = event.currentTarget;
  if (panel.scrollHeight - panel.scrollTop - panel.clientHeight > 180) return;
  if (!panel.querySelector("[data-edit-load-more]")) return;
  const scrollTop = panel.scrollTop;
  state.editAssetRenderLimit += EDIT_ASSET_BATCH_SIZE;
  renderEditAssets();
  panel.scrollTop = scrollTop;
}, { passive: true });
$(".edit-preview-modes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-preview-mode]");
  if (!button) return;
  state.editPreviewMode = button.dataset.editPreviewMode;
  $$(".edit-preview-modes button").forEach((item) => item.classList.toggle("active", item === button));
  const time = Number($("#editPreviewVideo").currentTime) || 0;
  loadEditPreviewVideo();
  $("#editPreviewVideo").addEventListener("loadedmetadata", () => seekEditPreview(time), { once: true });
  renderEditAssets();
  ensureEditDraftCache();
  resetEditCompareCache();
  loadEditCompareVideo({ preserveTime: true });
  const usingProxy = state.editDraftCache?.artifactId === editPreviewArtifact()?.id && state.editDraftCache?.status === "ready";
  toast(state.editPreviewMode === "draft"
    ? usingProxy ? "已切换到本机播放代理。" : "已切换到流畅版，播放代理正在后台生成；暂时使用原视频。"
    : usingProxy ? "已切换到审片版的本机播放代理。" : "已切换到审片版，浏览器专用代理正在后台生成。");
});

$("#editCompareViews").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-compare-view]");
  if (!button) return;
  setEditCompareView(button.dataset.editCompareView);
});

$("#editCompareToggle").addEventListener("click", async () => {
  if ((state.editWorkspace?.versions?.length || 0) < 2) return toast("当前项目至少需要两个可审版本才能 A/B 对比。");
  state.editCompareEnabled = !state.editCompareEnabled;
  if (!state.editCompareEnabled) {
    resetEditCompareCache();
    unloadMediaElement($("#editCompareVideo"), false);
    state.editCompareWorkspace = null;
    state.editComparison = null;
    editComparisonRequest = null;
    renderEditCompareControls();
    renderEditTimeline();
    loadEditCompareVideo();
    return toast("已关闭 A/B 对比。");
  }
  state.editCompareView = "split";
  state.editComparison = null;
  renderEditCompareControls();
  await loadEditCompareWorkspace();
  toast("A 为当前审片版本，B 已静音同步；差异轨道正在标出新增、删除和时长变化。");
});

$("#editCompareVersionSelect").addEventListener("change", async (event) => {
  state.editCompareVersionId = event.target.value;
  state.editCompareWorkspace = null;
  state.editComparison = null;
  editComparisonRequest = null;
  resetEditCompareCache();
  renderEditComparisonSummary();
  renderEditTimeline();
  await loadEditCompareWorkspace(state.editCompareVersionId);
});

$("#editDraftCacheStatus").addEventListener("click", () => {
  let retried = false;
  if (state.editDraftCache?.status === "error") {
    state.editDraftCache.status = "starting";
    state.editDraftCache.percent = 0;
    ensureEditDraftCache({ retry: true });
    retried = true;
  }
  if (state.editCompareEnabled && state.editCompareCache?.status === "error") {
    state.editCompareCache.status = "starting";
    state.editCompareCache.percent = 0;
    ensureEditCompareCache({ retry: true });
    retried = true;
  }
  renderEditDraftCacheStatus();
  if (retried) return;
  if (state.editDraftCache?.status === "ready" && (!state.editCompareEnabled || state.editCompareCache?.status === "ready")) {
    toast(`播放代理已保存在 ${state.editDraftCache.cacheLocation || "本机 StoryCut 缓存"}。`);
  }
});

$("#editVersionSelect").addEventListener("change", async (event) => {
  saveEditTimelineView();
  setCurrentEditSelections([]);
  state.editingOpinionId = null;
  updateEditOpinionEditorState();
  resetEditDraftCache();
  state.editComparison = null;
  editComparisonRequest = null;
  state.editVersionId = event.target.value;
  await loadEditWorkspace(state.editVersionId);
  if (state.editCompareEnabled) {
    renderEditCompareControls();
    state.editCompareWorkspace = null;
    resetEditCompareCache();
    await loadEditCompareWorkspace();
  }
  toast(`已切换到 ${state.editWorkspace?.versions?.find((item) => item.id === state.editVersionId)?.label || state.editVersionId}`);
});

function setEditTimelineZoom(value, anchorClientX = null) {
  const next = Math.min(8, Math.max(1, Math.round(Number(value) || 1)));
  if (next === state.editTimelineZoom) return;
  const viewport = $("#editTimelineViewport");
  const content = $("#editTimelineContent");
  const oldWidth = Math.max(1, content.scrollWidth);
  const bounds = viewport.getBoundingClientRect();
  const anchorX = anchorClientX === null
    ? Math.min(bounds.width, Math.max(0, bounds.width / 2))
    : Math.min(bounds.width, Math.max(0, anchorClientX - bounds.left));
  const anchorRatio = Math.min(1, Math.max(0, (viewport.scrollLeft + anchorX) / oldWidth));
  state.editTimelineZoom = next;
  $("#editTimelineZoom").value = String(next);
  renderEditTimeline();
  requestAnimationFrame(() => {
    viewport.scrollLeft = Math.max(0, anchorRatio * content.scrollWidth - anchorX);
    saveEditTimelineView();
  });
}

$("#editTimelineZoom").addEventListener("input", (event) => setEditTimelineZoom(event.target.value));
$("#editTimelineFitButton").addEventListener("click", () => {
  setEditTimelineZoom(1);
  requestAnimationFrame(() => { $("#editTimelineViewport").scrollLeft = 0; });
});
$("#editTimelineViewport").addEventListener("wheel", (event) => {
  if (!event.metaKey && !event.ctrlKey) return;
  event.preventDefault();
  setEditTimelineZoom(state.editTimelineZoom + (event.deltaY < 0 ? 1 : -1), event.clientX);
}, { passive: false });
$("#editTimelineViewport").addEventListener("scroll", scheduleEditTimelineViewSave, { passive: true });
$(".edit-chat-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-chat-tab]");
  if (!button) return;
  state.editChatTab = button.dataset.editChatTab;
  renderEditChatTab();
});
$("#editRevisionPanel").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-edit-revision-action]");
  if (!button) return;
  const revision = state.editRevisions.find((item) => item.id === button.dataset.editRevisionId);
  if (!revision) return;
  const action = button.dataset.editRevisionAction;
  if (action === "toggle") {
    state.expandedEditRevisionId = state.expandedEditRevisionId === revision.id ? null : revision.id;
    renderEditRevisionHistory();
    return;
  }
  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(revision.prompt);
      toast("修订 Prompt 已复制。");
    } catch {
      toast("无法访问剪贴板，请展开记录后手动复制。");
    }
    return;
  }
  if (action === "restore") {
    restoreEditRevision(revision);
    return;
  }
  if (action === "delete") {
    state.editRevisions = state.editRevisions.filter((item) => item.id !== revision.id);
    if (state.expandedEditRevisionId === revision.id) state.expandedEditRevisionId = null;
    cacheEditRevisions();
    renderEditRevisionHistory();
    toast("已删除这条修订记录。");
  }
});
$(".edit-media-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-media-tab]");
  if (!button) return;
  state.editMediaTab = button.dataset.editMediaTab;
  $$(".edit-media-tabs button").forEach((item) => item.classList.toggle("active", item === button));
  $("#editAssetPanel").classList.toggle("hidden", state.editMediaTab !== "assets");
  $("#editClipPanel").classList.toggle("hidden", state.editMediaTab !== "clips");
  if (state.editMediaTab === "clips") {
    renderEditClips();
  } else {
    renderEditAssets();
  }
});
$(".edit-inspector").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-action]");
  const entries = selectedEditEntries();
  const clip = editSelectedClip();
  const marker = editSelectedMarker();
  if (!button || !entries.length) return;
  if (entries.length > 1) {
    const allClips = entries.every((entry) => entry.type === "clip");
    $("#editCommand").value = button.dataset.editAction === "remove"
      ? allClips ? `这 ${entries.length} 个镜头不用剪辑入正片，请一起移除。` : `统一修改这 ${entries.length} 个所选对象：`
      : `统一调整这 ${entries.length} 个所选对象的时长，建议：`;
  } else {
    $("#editCommand").value = marker
      ? button.dataset.editAction === "remove"
        ? `修改这个${markerLabel(marker.type)}「${marker.label}」：`
        : `调整这个${markerLabel(marker.type)}「${marker.label}」的出现时间，建议：`
      : button.dataset.editAction === "remove"
        ? "这个镜头不用剪辑入正片，移除即可。"
        : `把 ${clip.beat} 收紧，只保留核心动作和反应。`;
  }
  $("#editCommand").focus();
});
$("#editRefreshButton").addEventListener("click", async (event) => {
  if (!state.project) return;
  await openProjectByPath(state.project.projectPath, event.currentTarget, { refresh: true });
});
$("#editHeaderPromptButton").addEventListener("click", () => {
  if (!state.editOpinions.length) {
    state.editChatTab = "conversation";
    renderEditChatTab();
    $("#editCommand").focus();
    return toast("先加入一条或多条意见，再生成总 Prompt。");
  }
  try {
    archiveEditOpinionPrompt();
  } catch (error) {
    toast(error.message);
  }
});
$("#editProposeButton").addEventListener("click", () => {
  if (!state.project) return toast("请先打开一个项目。");
  try {
    const editingIndex = state.editingOpinionId
      ? state.editOpinions.findIndex((item) => item.id === state.editingOpinionId)
      : -1;
    const existingOpinion = editingIndex >= 0 ? state.editOpinions[editingIndex] : null;
    const nextOpinion = captureEditOpinion(existingOpinion);
    if (editingIndex >= 0) state.editOpinions.splice(editingIndex, 1, nextOpinion);
    else state.editOpinions.push(nextOpinion);
    state.editProposal = null;
    state.editingOpinionId = null;
    cacheEditOpinions();
    $("#editCommand").value = "";
    setEditOpinionRange(nextOpinion.end, nextOpinion.end);
    updateEditOpinionEditorState();
    renderEditProposal();
    toast(editingIndex >= 0 ? `已更新意见 ${editingIndex + 1}。` : `已加入第 ${state.editOpinions.length} 条意见。`);
    $("#editProposalCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    toast(error.message);
  }
});
$("#editCancelOpinionButton").addEventListener("click", () => cancelEditOpinion());
$("#editProposalCard").addEventListener("click", async (event) => {
  const opinionButton = event.target.closest("[data-edit-opinion-action]");
  if (opinionButton) {
    const opinionId = opinionButton.dataset.editOpinionId;
    if (opinionButton.dataset.editOpinionAction === "edit") {
      startEditOpinion(opinionId);
      return;
    }
    if (opinionButton.dataset.editOpinionAction === "delete") {
      const index = state.editOpinions.findIndex((item) => item.id === opinionId);
      if (index < 0) return;
      state.editOpinions.splice(index, 1);
      state.editProposal = null;
      if (state.editingOpinionId === opinionId) {
        state.editingOpinionId = null;
        $("#editCommand").value = "";
        updateEditOpinionEditorState();
      }
      cacheEditOpinions();
      renderEditProposal();
      toast(`已删除意见 ${index + 1}。`);
      return;
    }
  }
  const button = event.target.closest("[data-edit-proposal-action]");
  if (!button) return;
  const action = button.dataset.editProposalAction;
  if (action === "clear") {
    state.editOpinions = [];
    state.editProposal = null;
    state.editingOpinionId = null;
    $("#editCommand").value = "";
    updateEditOpinionEditorState();
    cacheEditOpinions();
    renderEditProposal();
    return;
  }
  if (action === "dismiss") {
    state.editProposal = null;
    renderEditProposal();
    return;
  }
  if (action === "generate") {
    try {
      archiveEditOpinionPrompt();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (!state.editProposal) return;
  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(state.editProposal.prompt);
      toast("意见 Prompt 已复制，可以粘贴到后续 Codex 对话。");
    } catch {
      toast("无法访问剪贴板，请从卡片中手动复制。");
    }
  }
});
$("#recentProjectsList").addEventListener("click", handleRecentProjectClick);
$("#recentProjectsDialogList").addEventListener("click", handleRecentProjectClick);

$("#openMemoryButton").addEventListener("click", async () => {
  const memory = state.project?.memory;
  if (!memory) return toast("当前项目没有 project.md。");
  navigate("files");
  await openArtifact(memory);
});

function renderPreviewOptions() {
  const versions = state.project?.versions || [];
  const versionLabels = new Map();
  const versionPreviews = versions
    .flatMap((version) => [
      version.preview ? { ...version.preview, reviewLabel: `${version.label || version.id} · 审片版` } : null,
      version.draftPreview ? { ...version.draftPreview, reviewLabel: `${version.label || version.id} · 流畅版` } : null
    ])
    .filter(Boolean);
  versionPreviews.forEach((item) => versionLabels.set(item.id, item.reviewLabel));
  const preferredIds = new Set(versionPreviews.map((item) => item.id));
  const standalonePreviews = state.artifacts.filter((item) => item.playable
    && item.kind === "preview"
    && !preferredIds.has(item.id)
    && !/(^|\/)(clips_(preview|draft)|master_segments[^/]*|animations)\//i.test(item.relativePath || ""));
  const previews = [...versionPreviews, ...standalonePreviews]
    .filter((item, index, items) => item?.id && items.findIndex((candidate) => candidate.id === item.id) === index);
  $("#previewSelect").innerHTML = previews.length
    ? previews.map((item) => `<option value="${item.id}">${escapeHtml(versionLabels.get(item.id) || item.relativePath)}</option>`).join("")
    : `<option value="">没有找到视频</option>`;
  const preferred = state.project.preview?.id || previews[0]?.id;
  if (preferred) $("#previewSelect").value = preferred;
  if (document.body.dataset.page === "review") loadSelectedPreview();
}

function loadSelectedPreview(options = {}) {
  const artifact = state.artifacts.find((item) => item.id === $("#previewSelect").value);
  const video = $("#reviewVideo");
  if (!artifact) {
    unloadMediaElement(video, false);
    $("#videoPlaceholder").classList.remove("hidden");
    return;
  }
  $("#videoPlaceholder").classList.add("hidden");
  const source = reviewPreviewSource(artifact);
  if (video.dataset.mediaKey === source.key && video.getAttribute("src")) {
    ensureReviewPlaybackCache();
    return;
  }
  const previousTime = Math.max(0, Number(video.currentTime) || 0);
  const sameArtifact = video.dataset.artifactId === artifact.id;
  const wasPlaying = !video.paused;
  const playbackRate = Number(video.playbackRate) || Number($("#playbackRateSelect").value) || 1;
  const preservePlayback = options.preservePlayback && sameArtifact;
  video.dataset.artifactId = artifact.id;
  video.dataset.mediaKey = source.key;
  video.dataset.cacheSource = source.cached ? "playback-proxy" : "project";
  delete video.dataset.reportedMediaError;
  if (preservePlayback) {
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(previousTime, Math.max(0, Number(video.duration) || previousTime));
      video.playbackRate = playbackRate;
      if (wasPlaying) video.play().catch(() => {});
    }, { once: true });
  } else {
    armMediaResume(video, artifact.id);
  }
  video.src = source.url;
  video.playbackRate = playbackRate;
  video.load();
  ensureReviewPlaybackCache();
}

$("#previewSelect").addEventListener("change", loadSelectedPreview);
$("#reviewPlaybackCacheStatus").addEventListener("click", () => ensureReviewPlaybackCache({ retry: state.reviewPlaybackCache?.status === "error" }));
$("#reviewVideo").addEventListener("timeupdate", scheduleReviewPositionUpdate);
$("#reviewVideo").addEventListener("error", (event) => {
  const video = event.currentTarget;
  if (video.dataset.cacheSource === "playback-proxy" && state.reviewPlaybackCache?.status === "ready") {
    state.reviewPlaybackCache = {
      ...state.reviewPlaybackCache,
      status: "error",
      error: "审片播放代理不可用，已回退项目视频。",
      proxyFileId: null,
      cacheFileId: null
    };
    loadSelectedPreview({ preservePlayback: true });
    return toast("审片播放代理不可用，已自动回退项目视频。");
  }
  if (video.dataset.reportedMediaError !== video.dataset.mediaKey) {
    video.dataset.reportedMediaError = video.dataset.mediaKey || "project";
    toast("当前审片视频无法播放；可刷新项目或切换版本。");
  }
});
$("#playbackRateSelect").addEventListener("change", (event) => {
  $("#reviewVideo").playbackRate = Number(event.target.value) || 1;
});

$("#setStartButton").addEventListener("click", () => {
  $("#feedbackStart").value = formatTime($("#reviewVideo").currentTime);
});
$("#setEndButton").addEventListener("click", () => {
  $("#feedbackEnd").value = formatTime($("#reviewVideo").currentTime);
});

$("#quickFeedback").addEventListener("click", (event) => {
  const button = event.target.closest("[data-feedback]");
  if (!button) return;
  const note = $("#feedbackNote");
  note.value = note.value.trim() ? `${note.value.trim()} ${button.dataset.feedback}` : button.dataset.feedback;
  note.focus();
});

$("#addFeedbackButton").addEventListener("click", () => {
  const start = parseTime($("#feedbackStart").value);
  let end = parseTime($("#feedbackEnd").value);
  const note = $("#feedbackNote").value.trim();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return toast("请检查开始和结束时间码。");
  if (end < start) return toast("结束时间不能早于开始时间。");
  if (!note) return toast("请先写下你的观看感受或修改意图。");
  if (end === start) end = start + 2;
  state.feedback.push({
    id: crypto.randomUUID(),
    start,
    end,
    note,
    mustKeep: $("#mustKeep").value.trim(),
    category: $("#feedbackCategory").value,
    priority: $("#feedbackPriority").value,
    locked: $("#feedbackLock").checked
  });
  $("#feedbackStart").value = formatTime(end);
  $("#feedbackEnd").value = formatTime(end);
  $("#feedbackNote").value = "";
  $("#mustKeep").value = "";
  $("#feedbackLock").checked = false;
  cacheCurrentFeedback();
  renderFeedback();
});

function renderFeedback() {
  const count = state.feedback.length;
  $("#queueCount").textContent = `${count} 条`;
  $("#pendingCount").textContent = count;
  $("#feedbackBadge").textContent = count;
  $("#feedbackBadge").classList.toggle("hidden", count === 0);
  $("#saveReviewButton").disabled = !count || !state.project;
  if (document.body.dataset.page === "review") {
    $("#feedbackQueue").innerHTML = count
      ? state.feedback.map((item) => `
        <article class="feedback-item" data-feedback-id="${item.id}">
          <div class="feedback-meta"><span>${formatTime(item.start)}–${formatTime(item.end)}</span><span>${escapeHtml(item.category)}</span>${item.locked ? "<span>LOCK</span>" : ""}</div>
          <p>${escapeHtml(item.note)}</p>
          <button aria-label="删除反馈">×</button>
        </article>`).join("")
      : `<div class="queue-empty">播放视频并添加第一条意见。</div>`;
    renderTimeline();
    if (state.reviewIndexTab === "markers") renderMarkerList();
  } else {
    $("#feedbackQueue").replaceChildren();
  }
}

$("#feedbackQueue").addEventListener("click", (event) => {
  const itemElement = event.target.closest("[data-feedback-id]");
  if (!itemElement) return;
  const item = state.feedback.find((entry) => entry.id === itemElement.dataset.feedbackId);
  if (!item) return;
  if (event.target.closest("button")) {
    state.feedback = state.feedback.filter((entry) => entry.id !== item.id);
    cacheCurrentFeedback();
    renderFeedback();
  } else {
    jumpReviewVideo(item.start);
  }
});

async function loadReviewTimeline() {
  if (!state.project) return;
  const projectId = state.project.projectId;
  if (reviewTimelineRequest?.key === projectId) return reviewTimelineRequest.promise;
  const promise = (async () => {
    try {
      const response = await fetch(`/api/reviews/timeline?projectId=${encodeURIComponent(projectId)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取审片时间线。");
      if (state.project?.projectId !== projectId || reviewTimelineRequest?.key !== projectId) return;
      state.timeline = payload;
      state.reviewTimelineLoaded = true;
      state.currentCueId = null;
      $("#subtitleSource").textContent = payload.subtitle?.relativePath || "未找到 SRT / ASS 字幕";
      if (document.body.dataset.page === "review") {
        renderReviewIndex();
        updateReviewPosition();
      }
    } catch (error) {
      if (state.project?.projectId === projectId && reviewTimelineRequest?.key === projectId) toast(error.message);
    }
  })();
  reviewTimelineRequest = { key: projectId, promise };
  try {
    return await promise;
  } finally {
    if (reviewTimelineRequest?.key === projectId) reviewTimelineRequest = null;
  }
}

function timelineDuration() {
  return Math.max(
    1,
    Number($("#reviewVideo").duration) || 0,
    Number(state.timeline.duration) || 0,
    ...state.feedback.map((item) => item.end),
    ...state.timeline.markers.map((item) => item.end || item.time)
  );
}

function markerLabel(type) {
  return ({ cut: "剪辑点", sfx: "音效", flower: "花字", chapter: "章节卡", bgm: "BGM", feedback: "反馈" })[type] || type;
}

function combinedMarkers() {
  return [
    ...state.timeline.markers,
    ...state.feedback.map((item) => ({
      type: "feedback",
      time: item.start,
      end: item.end,
      label: item.note,
      source: "本轮反馈"
    }))
  ].sort((a, b) => a.time - b.time);
}

function groupVisibleMarkers(markers) {
  const groups = new Map();
  for (const marker of markers) {
    const key = `${marker.type}:${Math.round(marker.time * 2)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(marker);
      existing.time = Math.min(existing.time, marker.time);
    } else {
      groups.set(key, { ...marker, items: [marker] });
    }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

function matchesReviewQuery(parts) {
  const query = state.reviewIndexQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return parts.join(" ").toLocaleLowerCase().includes(query);
}

function renderSubtitleList() {
  const cues = state.timeline.subtitle?.cues || [];
  $("#subtitleCount").textContent = cues.length;
  const visible = cues.filter((cue) => matchesReviewQuery([
    cue.index,
    formatTime(cue.start),
    formatTime(cue.end),
    cue.text
  ]));
  $("#subtitleList").innerHTML = visible.length
    ? visible.map((cue) => `
      <button class="review-list-row subtitle-list-row${cue.corrected ? " corrected" : ""}" data-cue-id="${escapeHtml(cue.id)}" data-cue-time="${cue.start}">
        <span class="review-row-index">${cue.index}</span>
        <span class="review-row-time">${formatTime(cue.start)}</span>
        <span class="review-row-copy">${escapeHtml(cue.text)}</span>
        ${cue.corrected ? '<span class="review-row-status">已校正</span>' : '<span class="review-row-jump">↗</span>'}
      </button>`).join("")
    : `<div class="review-list-empty">${cues.length ? "没有匹配的字幕。" : "未找到可用字幕。"}</div>`;
  subtitleRowsById = new Map($$("#subtitleList [data-cue-id]").map((row) => [row.dataset.cueId, row]));
  state.reviewIndexActiveCueId = null;
}

function filteredMarkers() {
  return combinedMarkers()
    .filter((item) => state.markerFilter === "all" || item.type === state.markerFilter)
    .filter((item) => matchesReviewQuery([
      markerLabel(item.type),
      formatTime(item.time),
      item.label,
      item.source
    ]));
}

function renderMarkerList() {
  const allMarkers = combinedMarkers();
  $("#markerCount").textContent = allMarkers.length;
  const markers = filteredMarkers();
  $("#markerList").innerHTML = markers.length
    ? markers.map((item, index) => `
      <button class="review-list-row marker-list-row ${item.type}" data-marker-row="${index}" data-marker-time="${item.time}" data-marker-end="${item.end || item.time}">
        <span class="review-row-dot"></span>
        <span class="review-row-time">${formatTime(item.time)}</span>
        <span class="review-row-type">${markerLabel(item.type)}</span>
        <span class="review-row-copy">${escapeHtml(item.label)}</span>
        <span class="review-row-jump">↗</span>
      </button>`).join("")
    : `<div class="review-list-empty">${allMarkers.length ? "没有匹配的剪辑节点。" : "当前没有剪辑节点。"}</div>`;
  const rows = $$("#markerList [data-marker-row]");
  markerRowEntries = markers.map((item, index) => ({ item, row: rows[index] })).filter((entry) => entry.row);
  activeMarkerRows = [];
  state.reviewIndexActiveMarker = null;
}

function renderReviewIndex() {
  const subtitlesActive = state.reviewIndexTab === "subtitles";
  $("#subtitleIndexPanel").classList.toggle("hidden", !subtitlesActive);
  $("#markerIndexPanel").classList.toggle("hidden", subtitlesActive);
  $$("#reviewIndexTabs button").forEach((button) => {
    const active = button.dataset.reviewIndexTab === state.reviewIndexTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#reviewIndexSearch").placeholder = subtitlesActive ? "搜索字幕" : "搜索剪辑节点";
  $("#subtitleCount").textContent = state.timeline.subtitle?.cues?.length || 0;
  $("#markerCount").textContent = combinedMarkers().length;
  if (subtitlesActive) renderSubtitleList();
  else renderMarkerList();
  renderTimeline();
}

function renderTimeline() {
  const duration = timelineDuration();
  const laneTop = { cut: 3, sfx: 24, flower: 45, chapter: 66, bgm: 87, feedback: 108 };
  const filtered = filteredMarkers();
  const markers = groupVisibleMarkers(filtered);
  $("#timelineTrack").innerHTML = markers.map((item) => {
    const left = Math.min(99.7, Math.max(0, item.time / duration * 100));
    const labels = item.items.map((entry) => entry.label).filter(Boolean);
    const uniqueLabels = [...new Set(labels)];
    const count = item.items.length;
    const title = `${markerLabel(item.type)} · ${formatTime(item.time)} · ${uniqueLabels.join(" / ")}`;
    const countLabel = count > 1 ? `<span>${count}</span>` : "";
    return `<button class="timeline-marker ${item.type}${count > 1 ? " stacked" : ""}" data-marker-time="${item.time}" data-marker-left="${left}" data-marker-top="${laneTop[item.type] ?? 3}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${countLabel}</button>`;
  }).join("");
  $$("#timelineTrack .timeline-marker").forEach((marker) => {
    marker.style.setProperty("left", `${marker.dataset.markerLeft}%`);
    marker.style.setProperty("top", `${marker.dataset.markerTop}px`);
  });
  updateReviewPosition();
}

$("#reviewIndexTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-review-index-tab]");
  if (!button) return;
  state.reviewIndexTab = button.dataset.reviewIndexTab;
  state.reviewIndexQuery = "";
  state.reviewIndexActiveCueId = null;
  state.reviewIndexActiveMarker = null;
  $("#reviewIndexSearch").value = "";
  renderReviewIndex();
  updateReviewIndexSelection($("#reviewVideo").currentTime);
});

$("#reviewIndexSearch").addEventListener("input", (event) => {
  state.reviewIndexQuery = event.target.value;
  state.reviewIndexActiveCueId = null;
  state.reviewIndexActiveMarker = null;
  if (state.reviewIndexTab === "subtitles") renderSubtitleList();
  else {
    renderMarkerList();
    renderTimeline();
  }
  updateReviewIndexSelection($("#reviewVideo").currentTime);
});

$("#markerFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-marker-filter]");
  if (!button) return;
  state.markerFilter = button.dataset.markerFilter;
  $$("#markerFilters button").forEach((item) => item.classList.toggle("active", item === button));
  renderTimeline();
  renderMarkerList();
  updateReviewIndexSelection($("#reviewVideo").currentTime);
});

$("#timelineTrack").addEventListener("click", (event) => {
  const marker = event.target.closest("[data-marker-time]");
  if (!marker) return;
  jumpReviewVideo(marker.dataset.markerTime);
});

$("#markerList").addEventListener("click", (event) => {
  const marker = event.target.closest("[data-marker-time]");
  if (!marker) return;
  jumpReviewVideo(marker.dataset.markerTime);
});

$("#subtitleList").addEventListener("click", (event) => {
  const cue = event.target.closest("[data-cue-time]");
  if (!cue) return;
  jumpReviewVideo(cue.dataset.cueTime);
});

// Seeking should never rebuild or switch the index panel. This keeps scrubbing
// responsive and preserves the user's current subtitle/marker context.
$("#reviewVideo").addEventListener("seeked", updateReviewPosition);

function findSubtitleCue(time) {
  const cues = state.timeline.subtitle?.cues || [];
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle];
    if (time < cue.start) high = middle - 1;
    else if (time >= cue.end) low = middle + 1;
    else return cue;
  }
  return null;
}

function updateCurrentSubtitle(time) {
  const cue = findSubtitleCue(time);
  const overlay = $("#currentSubtitleOverlay");
  if (!cue) {
    overlay.classList.add("hidden");
    if (state.currentCueId !== null) {
      state.currentCueId = null;
      $("#subtitleCueTime").textContent = "当前时间没有字幕";
      $("#currentSubtitleText").value = "";
      $("#currentSubtitleText").disabled = true;
      $("#saveSubtitleButton").disabled = true;
      $("#subtitleCorrectionStatus").textContent = "播放到有字幕的位置，即可实时查看和校正。";
      $("#subtitleCorrectionStatus").classList.remove("corrected");
    }
    return;
  }
  overlay.textContent = cue.text;
  overlay.classList.remove("hidden");
  if (state.currentCueId === cue.id) return;
  state.currentCueId = cue.id;
  $("#subtitleCueTime").textContent = `${formatTime(cue.start)}–${formatTime(cue.end)} · 第 ${cue.index} 条`;
  $("#currentSubtitleText").value = cue.text;
  $("#currentSubtitleText").disabled = false;
  $("#saveSubtitleButton").disabled = false;
  $("#subtitleCorrectionStatus").textContent = cue.corrected
    ? "已保存为待处理校正；原始主字幕保持不变。"
    : "校正会保存为独立记录，不覆盖主字幕。";
  $("#subtitleCorrectionStatus").classList.toggle("corrected", Boolean(cue.corrected));
}

function scrollRowWithinReviewList(row) {
  const list = row?.closest(".review-list");
  if (!list) return;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (rowRect.top < listRect.top) {
    list.scrollTop -= listRect.top - rowRect.top;
  } else if (rowRect.bottom > listRect.bottom) {
    list.scrollTop += rowRect.bottom - listRect.bottom;
  }
}

function updateReviewIndexSelection(time) {
  if (state.reviewIndexTab === "subtitles") {
    if (state.reviewIndexActiveCueId === state.currentCueId) return;
    subtitleRowsById.get(state.reviewIndexActiveCueId)?.classList.remove("active");
    const activeSubtitle = subtitleRowsById.get(state.currentCueId) || null;
    activeSubtitle?.classList.add("active");
    if (activeSubtitle) scrollRowWithinReviewList(activeSubtitle);
    state.reviewIndexActiveCueId = state.currentCueId;
    return;
  }

  const nextMarkerRows = markerRowEntries
    .filter(({ item }) => {
      const start = Number(item.time) || 0;
      const end = Math.max(start + 1.5, Number(item.end) || start);
      return time >= start && time <= end;
    })
    .map(({ row }) => row);
  const nextSet = new Set(nextMarkerRows);
  activeMarkerRows.forEach((row) => {
    if (!nextSet.has(row)) row.classList.remove("active");
  });
  nextMarkerRows.forEach((row) => row.classList.add("active"));
  activeMarkerRows = nextMarkerRows;
  const markerKey = nextMarkerRows.map((row) => row.dataset.markerRow).join(",") || null;
  if (nextMarkerRows[0] && state.reviewIndexActiveMarker !== markerKey) scrollRowWithinReviewList(nextMarkerRows[0]);
  state.reviewIndexActiveMarker = markerKey;
}

function updateReviewPosition() {
  const video = $("#reviewVideo");
  const time = Number(video.currentTime) || 0;
  $("#reviewTimeDisplay").textContent = formatTime(time);
  const percent = Math.min(100, Math.max(0, time / timelineDuration() * 100));
  $("#timelineTrack").style.setProperty("--playhead", `${percent}%`);
  updateCurrentSubtitle(time);
  updateReviewIndexSelection(time);
}

function scheduleReviewPositionUpdate() {
  if (reviewPositionFrame) return;
  reviewPositionFrame = requestAnimationFrame(() => {
    reviewPositionFrame = 0;
    updateReviewPosition();
  });
}

$("#reviewVideo").addEventListener("loadedmetadata", () => {
  $("#reviewVideo").playbackRate = Number($("#playbackRateSelect").value) || 1;
  renderTimeline();
  updateReviewPosition();
});

$("#saveSubtitleButton").addEventListener("click", async () => {
  const cue = findSubtitleCue($("#reviewVideo").currentTime);
  const correctedText = $("#currentSubtitleText").value.trim();
  if (!cue || !correctedText) return toast("当前没有可校正的字幕。");
  const button = $("#saveSubtitleButton");
  button.disabled = true;
  button.textContent = "保存中…";
  try {
    const response = await fetch("/api/reviews/subtitle-corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: state.project.projectId,
        track: state.timeline.subtitle.relativePath,
        cueId: cue.id,
        index: cue.index,
        start: cue.start,
        end: cue.end,
        originalText: cue.originalText || cue.text,
        correctedText
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "字幕校正保存失败。");
    state.timeline = payload.timeline;
    state.currentCueId = null;
    updateReviewPosition();
    renderReviewIndex();
    toast(`字幕校正已保存，共 ${payload.count} 条待处理。`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "保存校正";
  }
});

$("#saveReviewButton").addEventListener("click", async () => {
  const button = $("#saveReviewButton");
  const preview = state.artifacts.find((item) => item.id === $("#previewSelect").value);
  button.disabled = true;
  button.textContent = "正在写入项目…";
  try {
    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: state.project.projectId,
        preview: preview?.relativePath || "",
        feedback: state.feedback
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "反馈文件生成失败。");
    if (payload.project) {
      state.project = payload.project;
      state.artifacts = payload.project.artifacts || [];
      $("#artifactCount").textContent = payload.project.artifactCount;
      renderArtifacts();
    }
    cacheCurrentFeedback();
    state.prompt = payload.prompt;
    $("#generatedPrompt").textContent = payload.prompt;
    $("#savedFiles").textContent = `第 ${payload.round} 轮 · 已写入 ${payload.files.join("、")}`;
    $("#promptResult").classList.remove("hidden");
    $("#promptResult").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("反馈文件和 Codex Prompt 已生成。");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "生成文件与 Codex Prompt";
  }
});

$("#copyPromptButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.prompt);
    toast("Prompt 已复制，可以回到 Codex 对话粘贴。");
  } catch {
    toast("无法访问剪贴板，请从下方手动复制。");
  }
});

function artifactIcon(kind) {
  return ({ preview: "▶", story: "ST", edl: "ED", transcript: "CC", memory: "PM", plan: "PL", review: "RV", image: "IM", inventory: "IN", selects: "SE" })[kind] || "TX";
}

function renderArtifacts() {
  const items = state.fileFilter === "all"
    ? state.artifacts
    : state.artifacts.filter((item) => item.kind === state.fileFilter);
  $("#fileCountLabel").textContent = `${items.length} 个`;
  $("#artifactList").innerHTML = items.length
    ? items.map((item) => `
      <button class="artifact-item" data-artifact-id="${item.id}">
        <span class="artifact-type">${artifactIcon(item.kind)}</span>
        <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.relativePath)} · ${formatBytes(item.sizeBytes)}</small></span>
        <small>${formatDate(item.modifiedAt)}</small>
      </button>`).join("")
    : `<div class="queue-empty">这个分类中没有文件。</div>`;
}

$("#fileFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-kind]");
  if (!button) return;
  state.fileFilter = button.dataset.kind;
  $$("#fileFilters button").forEach((item) => item.classList.toggle("active", item === button));
  renderArtifacts();
});

$("#artifactList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-artifact-id]");
  const artifact = state.artifacts.find((item) => item.id === button?.dataset.artifactId);
  if (artifact) await openArtifact(artifact);
});

async function openArtifact(artifact) {
  $$(".artifact-item").forEach((item) => item.classList.toggle("active", item.dataset.artifactId === artifact.id));
  $("#documentTitle").textContent = artifact.name;
  if (artifact.playable) {
    navigate("review");
    $("#previewSelect").value = artifact.id;
    loadSelectedPreview();
    return;
  }
  if (!artifact.readable) {
    $("#documentContent").textContent = `${artifact.relativePath}\n\n这个文件不支持文本预览。`;
    return;
  }
  $("#documentContent").textContent = "正在读取…";
  try {
    const response = await fetch(documentUrl(artifact));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "读取失败。");
    $("#documentContent").textContent = payload.content;
  } catch (error) {
    $("#documentContent").textContent = error.message;
  }
}

// Existing StoryCut transcript analyzer, now hosted on its own page.
const transcript = $("#transcript");
const analyzeButton = $("#analyzeButton");
const resultsPanel = $("#resultsPanel");
const decisionList = $("#decisionList");
const modeSelect = $("#analysisMode");

function updateStats() {
  const counts = Object.fromEntries(["KEEP", "CUT", "MOVE", "B-ROLL"].map((action) => [action, 0]));
  state.decisions.forEach((decision) => counts[decision.action]++);
  $("#stats").innerHTML = Object.entries(counts).map(([action, count]) => `<div class="stat"><strong>${count}</strong><span>${action}</span></div>`).join("");
}

function renderDecisions() {
  const visible = state.decisionFilter === "ALL" ? state.decisions : state.decisions.filter((item) => item.action === state.decisionFilter);
  decisionList.innerHTML = visible.map((item) => `
    <article class="decision" data-id="${escapeHtml(item.id)}">
      <div><span class="action ${item.action}">${item.action}</span><div class="timecode">${formatTime(item.start)}–${formatTime(item.end)}</div></div>
      <div class="decision-copy"><blockquote>${escapeHtml(item.text)}</blockquote><div class="reason">${escapeHtml(item.reason)}</div><div class="confidence">${Math.round(item.confidence * 100)}% confidence · ${item.review}</div></div>
      <div class="review-actions"><button class="review-button accept ${item.review === "accepted" ? "active" : ""}" data-review="accepted" aria-label="接受">✓</button><button class="review-button reject ${item.review === "rejected" ? "active" : ""}" data-review="rejected" aria-label="拒绝">×</button></div>
    </article>`).join("");
}

async function analyze() {
  if (transcript.value.trim().length < 20) return toast("请先添加更长的转录文本。");
  analyzeButton.disabled = true;
  analyzeButton.textContent = "分析中…";
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcript.value, mode: modeSelect.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "分析失败。");
    state.decisions = payload.decisions;
    $("#summary").textContent = `${payload.summary} · ${payload.mode === "ai" ? "GPT-5.6 分析" : "本地演示分析"}`;
    updateStats();
    renderDecisions();
    resultsPanel.classList.remove("hidden");
    resultsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(error.message);
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = "分析故事 →";
  }
}

$("#demoButton").addEventListener("click", () => {
  transcript.value = safeDemoTranscript;
  transcript.dispatchEvent(new Event("input"));
  toast("已载入不含隐私信息的示例。");
});
transcript.addEventListener("input", () => $("#charCount").textContent = `${transcript.value.length.toLocaleString()} / 30,000`);
analyzeButton.addEventListener("click", analyze);

const dropzone = $("#dropzone");
const mediaFileInput = $("#mediaFile");
const progressElement = $("#mediaProgress");
const progressBar = $("#progressBar");
const progressStage = $("#progressStage");

function setProgress(stage, percent) {
  progressElement.classList.remove("hidden");
  progressStage.textContent = stage;
  if (Number.isFinite(percent)) progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

async function uploadFile(file) {
  const response = await fetch("/api/upload", { method: "POST", headers: { "X-Filename": file.name }, body: file });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "上传到本地服务失败。");
  return payload;
}

async function runTranscriptionStream(fileId) {
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, language: "auto" })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `转写请求失败 (${response.status})。`);
  }
  if (!response.body) throw new Error("本地转写流不可用。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      let eventName = "message";
      let dataLine = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) dataLine += line.slice(5).trimStart();
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
      }
      if (!dataLine) continue;
      let parsed;
      try { parsed = JSON.parse(dataLine); } catch { continue; }
      if (eventName === "error") throw new Error(parsed.error || "转写失败。");
      if (parsed.type === "progress") setProgress(`正在转写 ${formatTime(parsed.processed_sec || 0)}`, parsed.total_sec ? parsed.processed_sec / parsed.total_sec * 100 : undefined);
      if (parsed.type === "done") return parsed.transcript;
    }
  }
  throw new Error("转写结束，但没有返回结果。");
}

async function handleMediaFile(file) {
  if (!file) return;
  if (!/\.(mp4|mov|m4a|wav|mp3)$/i.test(file.name)) return toast("请选择 mp4、mov、m4a、wav 或 mp3。");
  try {
    setProgress("正在复制到本地工作目录…", 4);
    const upload = await uploadFile(file);
    $("#dropzoneMeta").textContent = `${file.name} · ${formatBytes(upload.sizeBytes)} · ${formatTime(upload.duration)}`;
    setProgress("正在启动本地 MLX Whisper…", 8);
    const resultTranscript = await runTranscriptionStream(upload.fileId);
    setProgress("正在生成剪辑建议…", 94);
    const response = await fetch("/api/analyze-transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: resultTranscript, mode: modeSelect.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "分析失败。");
    state.decisions = payload.decisions;
    $("#summary").textContent = `${file.name} · ${payload.summary}`;
    updateStats();
    renderDecisions();
    resultsPanel.classList.remove("hidden");
    setProgress("完成。", 100);
    toast("本地转写和分析已完成。");
  } catch (error) {
    setProgress(error.message, 0);
    toast(error.message);
  }
}

mediaFileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) handleMediaFile(file);
  mediaFileInput.value = "";
});
$("#pickFile").addEventListener("click", (event) => {
  event.preventDefault();
  mediaFileInput.click();
});
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
}));
dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) handleMediaFile(file);
});

$(".filter-row").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.decisionFilter = button.dataset.filter;
  $$(".filter").forEach((item) => item.classList.toggle("active", item === button));
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
$("#exportButton").addEventListener("click", () => {
  const data = { project: "StoryCut", version: "0.4.0", exportedAt: new Date().toISOString(), decisions: state.decisions };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "storycut-timeline.json";
  link.click();
  URL.revokeObjectURL(url);
});

async function checkStatus() {
  const response = await fetch("/api/status");
  const status = await response.json();
  state.aiAvailable = status.aiAvailable;
  $("#modeLabel").textContent = status.aiAvailable ? "本地工作台 · AI 可用" : "本地工作台";
  modeSelect.querySelector('option[value="ai"]').disabled = !status.aiAvailable;
  if (!status.aiAvailable) modeSelect.value = "local";
}

loadRecentProjects();
renderRecentProjects();
document.body.dataset.page = "overview";
checkStatus().catch(() => $("#modeLabel").textContent = "本地工作台");
