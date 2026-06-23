import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1"));
const defaultOneDriveRoot = path.join(
  process.env.USERPROFILE || "C:\\Users\\COM-JHYUTG",
  "OneDrive", "바탕 화면", "01. 개인용", "01. 자기계발", "01. 코딩", "00. 업무 관련 코딩", "1. 청각장애인 요양보호사 양성"
);
const oneDriveRoot = process.env.ONEDRIVE_LOGIN_ROOT || defaultOneDriveRoot;
const issues = [];

function walkHtml(dir, predicate, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, predicate, acc);
    else if (entry.isFile() && entry.name.endsWith(".html") && predicate(full, entry.name)) acc.push(full);
  }
  return acc;
}

const files = [path.join(repoRoot, "quiz-1400", "login.html")];
files.push(...walkHtml(path.join(oneDriveRoot, "01. 합격!! 모의고사"), (full, name) => full.includes("개선판") && full.includes("최종 코드") && /로그인 코드\.html$/.test(name)));
files.push(...walkHtml(path.join(oneDriveRoot, "02. 합격!! 1400題"), (full, name) => full.includes("개선판") && /^1\. .*로그인 코드\.html$/.test(name)));

for (const file of files) {
  if (!fs.existsSync(file)) {
    issues.push(`${file}: file not found`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(path.join("quiz-1400", "login.html"))) {
    if (!text.includes("login-error")) issues.push(`${file}: missing inline login error box`);
    if (!text.includes("quiz1400LoginViewportGuard20260623")) issues.push(`${file}: missing viewport guard`);
    if (/catch\(error => \{\s*alert\(getAuthorizationErrorMessage\(error\)\);\s*\}\)/.test(text)) issues.push(`${file}: authorization denial still uses alert`);
  } else {
    if (!text.includes("olLoginViewportGuard20260623")) issues.push(`${file}: missing viewport guard`);
    if (/alert\(message\);\s*olShowScopeDeniedNotice\(message\)/.test(text)) issues.push(`${file}: mock scope denial still uses alert`);
    if (/alert\(msg\);\s*if\(error&&error\.code==='scope-denied'\)showDenied\(msg\)/.test(text)) issues.push(`${file}: 1400 scope denial still uses alert`);
  }
}

if (issues.length) {
  console.error(issues.join("\n"));
  process.exit(1);
}
console.log(`login layout static check passed: ${files.length} files`);