import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const VIEWPORTS = [
  { name: "phone-360x800", width: 360, height: 800, mobile: true },
  { name: "phone-390x844", width: 390, height: 844, mobile: true },
  { name: "phone-short-390x640", width: 390, height: 640, mobile: true },
  { name: "tablet-768x1024", width: 768, height: 1024, mobile: true },
  { name: "tablet-landscape-1024x768", width: 1024, height: 768, mobile: false },
  { name: "laptop-1366x768", width: 1366, height: 768, mobile: false },
  { name: "desktop-1440x900", width: 1440, height: 900, mobile: false },
];

function parseArgs(argv) {
  const result = {
    screenshots: false,
    screenshotsDir: path.join(ROOT, "tools", "result-page-snapshots"),
    targets: [],
    viewportNames: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--screenshots") {
      result.screenshots = true;
    } else if (arg === "--screenshots-dir") {
      result.screenshotsDir = path.resolve(ROOT, argv[++i] || "");
    } else if (arg === "--target") {
      result.targets.push(path.normalize(argv[++i] || ""));
    } else if (arg === "--viewports") {
      result.viewportNames = new Set((argv[++i] || "").split(",").filter(Boolean));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

function printHelp() {
  console.log(`Usage: node tools/result-page-check.mjs [options]

Checks mock-exam and quiz-1400 result-page layouts across common viewports.

Options:
  --target <path>          Limit to one source HTML. Can be repeated.
  --viewports <names>     Comma-separated viewport names.
  --screenshots           Save viewport screenshots for each checked page.
  --screenshots-dir <dir> Screenshot output directory.
  --help                  Show this help.
`);
}

function discoverSourceFiles() {
  const dirs = ["mock-exam", "quiz-1400"];
  const files = [];

  for (const dir of dirs) {
    const absDir = path.join(ROOT, dir);
    for (const name of readdirSync(absDir)) {
      if (/^(desktop|mobile)-\d+\.html$/i.test(name)) {
        files.push(path.join(dir, name));
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function findChrome() {
  const envPath = process.env.CHROME_PATH;
  const candidates = [
    envPath,
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);

  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH to a Chromium-based browser executable.");
  }
  return chrome;
}

function waitForBrowserWsUrl(proc) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Chrome DevTools endpoint.\n${output}`));
    }, 15000);

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });

    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before DevTools endpoint was ready. Exit code: ${code}\n${output}`));
    });
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (event) => reject(event.error || new Error("WebSocket error")));
      this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
      this.ws.addEventListener("close", () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("CDP connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  handleMessage(data) {
    const message = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      else resolve(message.result || {});
      return;
    }

    if (message.method && this.eventWaiters.has(message.method)) {
      const waiters = this.eventWaiters.get(message.method);
      this.eventWaiters.delete(message.method);
      for (const waiter of waiters) waiter(message.params || {});
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  waitFor(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const waiter = (params) => {
        clearTimeout(timer);
        resolve(params);
      };
      const waiters = this.eventWaiters.get(method) || [];
      waiters.push(waiter);
      this.eventWaiters.set(method, waiters);
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function createPageClient(browserWsUrl) {
  const port = new URL(browserWsUrl).port;
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`;
  const response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) throw new Error(`Failed to create Chrome target: ${response.status} ${response.statusText}`);
  const target = await response.json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  return client;
}

function extractStyle(sourceHtml, relativePath) {
  const matches = [...sourceHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  if (!matches.length) throw new Error(`No <style> block found in ${relativePath}`);
  return matches
    .map((match) => match[1])
    .sort((a, b) => b.length - a.length)[0];
}

function getKind(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("mock-exam/")) return "mock";
  if (normalized.startsWith("quiz-1400/")) return "quiz1400";
  throw new Error(`Unknown target kind: ${relativePath}`);
}

function getDevice(relativePath) {
  return path.basename(relativePath).startsWith("mobile-") ? "mobile" : "desktop";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildMockResultHtml(device) {
  const solved = Array.from({ length: 56 }, (_, i) => ({ no: i + 1, correct: (i % 5) + 1, mine: (i % 5) + 1 }));
  const wrong = Array.from({ length: 16 }, (_, i) => ({ no: i + 57, correct: (i % 5) + 1, mine: ((i + 2) % 5) + 1 }));
  const empty = Array.from({ length: 8 }, (_, i) => ({ no: i + 73, correct: (i % 5) + 1, mine: "-" }));
  const chip = (item, type) =>
    `<span class="result-chip ${type}"><span class="chip-no">${String(item.no).padStart(2, "0")}번</span><span class="chip-meta">C:${item.correct} / M:${item.mine}</span></span>`;
  const resultGrid = `
    <div class="result-insight-grid">
      <div class="result-mini-card correct"><span class="result-mini-label">정답</span><span class="result-mini-value">56</span></div>
      <div class="result-mini-card wrong"><span class="result-mini-label">오답</span><span class="result-mini-value">16</span></div>
      <div class="result-mini-card empty"><span class="result-mini-label">미응답</span><span class="result-mini-value">8</span></div>
    </div>
    <section class="result-section-list">
      <h3 class="result-section-title">틀린 문항</h3>
      <div class="result-chip-wrap">${wrong.map((item) => chip(item, "wrong")).join("")}</div>
    </section>
    <section class="result-section-list">
      <h3 class="result-section-title">미응답 문항</h3>
      <div class="result-chip-wrap">${empty.map((item) => chip(item, "empty")).join("")}</div>
    </section>
    <section class="result-section-list">
      <h3 class="result-section-title">정답 문항</h3>
      <div class="result-chip-wrap">${solved.map((item) => chip(item, "correct")).join("")}</div>
    </section>`;

  if (device === "mobile") {
    return `
      <div id="result-page" data-ux-enhanced="1" style="display:flex">
        <div id="result-shell">
          <section class="result-summary-card">
            <span class="result-emoji">📋</span>
            <h2>시험 결과</h2>
            <p id="score">총점: 56점 ( 필기: 25점 / 실기: 31점 )</p>
          </section>
          <div id="quick-nav-container-result">
            <p class="result-grid-title">학습 요약</p>
            <div id="quick-nav-grid-result">${resultGrid}</div>
          </div>
          <button id="result-return-btn">다시 풀기</button>
        </div>
      </div>`;
  }

  return `
    <div id="result-page" style="display:flex">
      <div class="result-heading">
        <span class="result-badge">1회 모의고사</span>
        <h2>시험 결과</h2>
        <p id="result-user-name" class="result-user-name">응시자: 자동검증</p>
      </div>
      <p id="score">총점: 56점 ( 필기: 25점 / 실기: 31점 )</p>
      <div id="quick-nav-container-result">
        <p class="result-grid-title">학습 요약</p>
        <div id="quick-nav-grid-result">${resultGrid}</div>
      </div>
      <button id="result-return-btn">다시 풀기</button>
    </div>`;
}

function buildQuiz1400ResultHtml() {
  const wrong = Array.from({ length: 14 }, (_, i) => ({
    no: i * 4 + 5,
    correct: (i % 5) + 1,
    mine: ((i + 2) % 5) + 1,
  }));
  const empty = Array.from({ length: 14 }, (_, i) => ({
    no: i * 7 + 1,
    correct: (i % 5) + 1,
    mine: "-",
  }));
  const item = (entry, type) => {
    const mineText = entry.mine === "-" ? "내 답 없음" : `내 답 ${entry.mine}번`;
    return `<div class="result-review-item ${type}"><span class="review-no">${entry.no}번</span><span class="review-answers"><span>정답 ${entry.correct}번</span><span>${mineText}</span></span></div>`;
  };

  return `
    <div id="result-page" style="display:flex">
      <div class="result-heading">
        <span class="result-badge" id="result-badge">2장</span>
        <h2>학습 결과</h2>
        <p id="result-user-name" class="result-user-name">응시자 : 자동검증</p>
      </div>
      <div id="score" class="result-summary pass">
        <div class="result-summary-main">
          <div class="result-status-card">
            <div class="result-status-label">합격</div>
            <div class="result-status-note">기준 통과, 복습 권장</div>
          </div>
          <div class="result-stats">
            <div class="result-stat"><strong>72.8%</strong><span>정답률</span></div>
            <div class="result-stat"><strong>75 / 103</strong><span>정답</span></div>
            <div class="result-stat"><strong>14</strong><span>오답</span></div>
            <div class="result-stat"><strong>14</strong><span>미응답</span></div>
          </div>
        </div>
        <div class="result-standard">장별 학습 기준: <strong>60% 이상</strong> · 합격 기준 정답 <strong>62문항 이상</strong></div>
      </div>
      <div id="quick-nav-container-result">
        <p class="result-grid-title">복습이 필요한 문항</p>
        <div id="result-grid-nav" style="display:none">
          <button id="result-prev-btn">← 이전</button>
          <span id="result-page-info"></span>
          <button id="result-next-btn" disabled>다음 →</button>
        </div>
        <div id="quick-nav-grid-result" class="result-review-board">
          <div class="result-review-overview">
            <div class="result-review-card correct"><span>정답</span><strong>75</strong></div>
            <div class="result-review-card wrong"><span>오답</span><strong>14</strong></div>
            <div class="result-review-card empty"><span>미응답</span><strong>14</strong></div>
          </div>
          <section class="result-review-section wrong">
            <h3 class="result-review-title">틀린 문항</h3>
            <div class="result-review-list">${wrong.map((entry) => item(entry, "wrong")).join("")}</div>
          </section>
          <section class="result-review-section empty">
            <h3 class="result-review-title">미응답 문항</h3>
            <div class="result-review-list">${empty.map((entry) => item(entry, "empty")).join("")}</div>
          </section>
        </div>
      </div>
      <div class="result-actions">
        <button id="result-chapter-btn">장 선택하기</button>
        <button id="result-return-btn">다시 풀기</button>
      </div>
    </div>`;
}

function buildHarness(relativePath, sourceHtml) {
  const css = extractStyle(sourceHtml, relativePath);
  const kind = getKind(relativePath);
  const device = getDevice(relativePath);
  const resultHtml = kind === "mock" ? buildMockResultHtml(device) : buildQuiz1400ResultHtml();
  const mode = kind === "mock" ? "mock" : "quiz1400";
  const expected = kind === "mock"
    ? { chips: 80, miniValues: ["56", "16", "8"] }
    : { reviewCards: 3, reviewSections: 2, wrongItems: 14, emptyItems: 14 };

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Result page check - ${escapeHtml(relativePath)}</title>
  <style>${css}</style>
</head>
<body class="${device}-page" data-result-mode="${mode}" data-expected="${escapeHtml(JSON.stringify(expected))}">
  ${resultHtml}
</body>
</html>`;
}

function sanitizeName(name) {
  return name.replace(/[^a-z0-9._-]+/gi, "_");
}

function evaluateExpression(fn) {
  return `(${fn.toString()})()`;
}

function layoutCheck() {
  const errors = [];
  const warnings = [];
  const winW = window.innerWidth;
  const tolerance = 2;
  const mode = document.body.dataset.resultMode;
  const expected = JSON.parse(document.body.dataset.expected || "{}");

  function visibleElements(selector) {
    return Array.from(document.querySelectorAll(selector)).filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
  }

  function labelOf(el) {
    if (el.id) return `#${el.id}`;
    if (el.className && typeof el.className === "string") return `.${el.className.trim().replace(/\s+/g, ".")}`;
    return el.tagName.toLowerCase();
  }

  function checkHorizontalBounds(el) {
    const rect = el.getBoundingClientRect();
    if (rect.left < -tolerance || rect.right > winW + tolerance) {
      errors.push(`${labelOf(el)} exceeds viewport horizontally: left=${rect.left.toFixed(1)}, right=${rect.right.toFixed(1)}, viewport=${winW}`);
    }
  }

  function checkScrollWidth(el) {
    if (el.scrollWidth > el.clientWidth + tolerance) {
      errors.push(`${labelOf(el)} has horizontal overflow: scrollWidth=${el.scrollWidth}, clientWidth=${el.clientWidth}`);
    }
  }

  function overlap(a, b) {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const x = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
    const y = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
    return x > tolerance && y > tolerance;
  }

  function isIntentionalOverlay(el) {
    const position = getComputedStyle(el).position;
    return position === "fixed" || position === "sticky";
  }

  function checkSiblingOverlap(selector) {
    const elements = visibleElements(selector);
    for (let i = 0; i < elements.length; i++) {
      for (let j = i + 1; j < elements.length; j++) {
        if (isIntentionalOverlay(elements[i]) || isIntentionalOverlay(elements[j])) continue;
        if (overlap(elements[i], elements[j])) {
          errors.push(`Sibling overlap: ${labelOf(elements[i])} and ${labelOf(elements[j])}`);
        }
      }
    }
  }

  const resultPage = document.getElementById("result-page");
  const resultGrid = document.getElementById("quick-nav-grid-result");
  const resultContainer = document.getElementById("quick-nav-container-result");

  if (!resultPage) errors.push("#result-page is missing");
  if (!resultGrid) errors.push("#quick-nav-grid-result is missing");
  if (!resultContainer) errors.push("#quick-nav-container-result is missing");

  if (document.documentElement.scrollWidth > winW + tolerance) {
    errors.push(`Document has horizontal overflow: scrollWidth=${document.documentElement.scrollWidth}, viewport=${winW}`);
  }
  if (document.body.scrollWidth > winW + tolerance) {
    errors.push(`Body has horizontal overflow: scrollWidth=${document.body.scrollWidth}, viewport=${winW}`);
  }

  visibleElements("#result-page, #result-shell, .result-heading, #score, #quick-nav-container-result, #quick-nav-grid-result, #result-grid-nav, .result-review-overview, .result-review-card, .result-review-section, .result-review-list, .result-review-item, .result-actions, #result-return-btn").forEach((el) => {
    checkHorizontalBounds(el);
    checkScrollWidth(el);
  });

  checkSiblingOverlap("#result-page > *");
  checkSiblingOverlap("#result-shell > *");
  checkSiblingOverlap("#quick-nav-container-result > *");
  checkSiblingOverlap(".result-summary-main > *");
  checkSiblingOverlap(".result-stats > *");
  checkSiblingOverlap(".result-actions > *");

  if (mode === "mock") {
    const chips = document.querySelectorAll(".result-chip");
    const miniValues = Array.from(document.querySelectorAll(".result-mini-value")).map((el) => el.textContent.trim());
    const sections = document.querySelectorAll(".result-section-list");
    if (chips.length !== expected.chips) errors.push(`Expected ${expected.chips} mock result chips, found ${chips.length}`);
    if (sections.length !== 3) errors.push(`Expected 3 mock result sections, found ${sections.length}`);
    if (JSON.stringify(miniValues) !== JSON.stringify(expected.miniValues)) {
      errors.push(`Unexpected mock mini-card values: ${miniValues.join(", ")}`);
    }
  } else if (mode === "quiz1400") {
    const reviewBoard = document.querySelector("#quick-nav-grid-result.result-review-board");
    const reviewCards = document.querySelectorAll(".result-review-card");
    const reviewSections = document.querySelectorAll(".result-review-section");
    const wrongItems = document.querySelectorAll(".result-review-item.wrong");
    const emptyItems = document.querySelectorAll(".result-review-item.empty");
    const resultText = resultContainer?.textContent || "";
    if (!reviewBoard) errors.push("Quiz result review board is missing");
    if (reviewCards.length !== expected.reviewCards) errors.push(`Expected ${expected.reviewCards} quiz review cards, found ${reviewCards.length}`);
    if (reviewSections.length !== expected.reviewSections) errors.push(`Expected ${expected.reviewSections} quiz review sections, found ${reviewSections.length}`);
    if (wrongItems.length !== expected.wrongItems) errors.push(`Expected ${expected.wrongItems} wrong quiz review items, found ${wrongItems.length}`);
    if (emptyItems.length !== expected.emptyItems) errors.push(`Expected ${expected.emptyItems} unanswered quiz review items, found ${emptyItems.length}`);
    if (resultText.includes("C:") || resultText.includes("M:")) {
      errors.push("Quiz result review board still contains C:/M: notation");
    }
  }

  const contentHeight = resultPage ? Math.round(resultPage.getBoundingClientRect().height) : 0;
  if (contentHeight > window.innerHeight * 3) {
    warnings.push(`Tall result page: ${contentHeight}px for viewport height ${window.innerHeight}px`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      resultHeight: contentHeight,
    },
  };
}

async function navigateTo(client, url, viewport) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile,
  });
  const loadPromise = client.waitFor("Page.loadEventFired", 10000);
  await client.send("Page.navigate", { url });
  await loadPromise;
  await client.send("Runtime.evaluate", {
    expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    awaitPromise: true,
  });
}

async function evaluateLayout(client) {
  const response = await client.send("Runtime.evaluate", {
    expression: evaluateExpression(layoutCheck),
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Runtime evaluation failed");
  }
  return response.result.value;
}

async function saveScreenshot(client, outputPath) {
  const response = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(outputPath, Buffer.from(response.data, "base64"));
}

function waitForExit(proc, timeoutMs = 3000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeDirAfterUnlock(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chromePath = findChrome();
  const allFiles = discoverSourceFiles();
  const targetSet = args.targets.length
    ? new Set(args.targets.map((target) => path.normalize(target)))
    : null;
  const files = allFiles.filter((file) => !targetSet || targetSet.has(path.normalize(file)));
  const viewports = args.viewportNames
    ? VIEWPORTS.filter((viewport) => args.viewportNames.has(viewport.name))
    : VIEWPORTS;

  if (files.length === 0) throw new Error("No source files matched.");
  if (viewports.length === 0) throw new Error("No viewports matched.");
  if (args.screenshots) mkdirSync(args.screenshotsDir, { recursive: true });

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "result-page-check-"));
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "result-page-chrome-"));
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const failures = [];
  const warnings = [];
  let checked = 0;
  let client;

  try {
    const browserWsUrl = await waitForBrowserWsUrl(chrome);
    client = await createPageClient(browserWsUrl);

    for (const relativePath of files) {
      const sourcePath = path.join(ROOT, relativePath);
      const sourceHtml = readFileSync(sourcePath, "utf8");
      const harness = buildHarness(relativePath, sourceHtml);
      const harnessName = `${sanitizeName(relativePath)}.html`;
      const harnessPath = path.join(tempDir, harnessName);
      writeFileSync(harnessPath, harness, "utf8");
      const harnessUrl = pathToFileURL(harnessPath).href;

      for (const viewport of viewports) {
        checked++;
        await navigateTo(client, harnessUrl, viewport);
        const result = await evaluateLayout(client);
        const label = `${relativePath} @ ${viewport.name}`;
        if (!result.ok) {
          failures.push({ label, errors: result.errors, metrics: result.metrics });
        }
        for (const warning of result.warnings) {
          warnings.push(`${label}: ${warning}`);
        }
        if (args.screenshots) {
          const outName = `${sanitizeName(relativePath.replaceAll("\\", "__"))}__${viewport.name}.png`;
          await saveScreenshot(client, path.join(args.screenshotsDir, outName));
        }
      }
    }
  } finally {
    if (client) client.close();
    chrome.kill();
    await waitForExit(chrome);
    await removeDirAfterUnlock(tempDir);
    await removeDirAfterUnlock(userDataDir);
  }

  console.log(`Checked ${checked} result-page viewport cases across ${files.length} files.`);
  if (warnings.length) {
    console.log(`Warnings: ${warnings.length}`);
    for (const warning of warnings.slice(0, 20)) console.log(`  - ${warning}`);
    if (warnings.length > 20) console.log(`  - ... ${warnings.length - 20} more warnings`);
  }

  if (failures.length) {
    console.error(`Failures: ${failures.length}`);
    for (const failure of failures) {
      console.error(`\n${failure.label}`);
      for (const error of failure.errors) console.error(`  - ${error}`);
      console.error(`  metrics: ${JSON.stringify(failure.metrics)}`);
    }
    process.exit(1);
  }

  if (args.screenshots) {
    console.log(`Screenshots saved to ${args.screenshotsDir}`);
  }
  console.log("Result-page checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
