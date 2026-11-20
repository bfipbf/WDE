import fs from "node:fs/promises";

const PUBLIC = "bfipbf/SILENT-PBF";
const PRIVATE = "bfipbf/PRIVATE-PBF";
const token = process.env.PRIVATE_TOKEN;
const issue = Number(process.env.ISSUE_NUMBER);
const file = process.env.EVIDENCE_FILE;
const marker = "<!-- silent-pbf-issue:" + issue + " -->";
const publishMarker = "<!-- jim-evidence:" + process.env.GITHUB_RUN_ID + ":" + (process.env.EVIDENCE_KIND || "request") + " -->";

if (!token) throw Error("PRIVATE_TOKEN missing; refusing public fallback.");
if (!Number.isSafeInteger(issue) || issue < 1) throw Error("Invalid issue number.");
if (!file) throw Error("EVIDENCE_FILE missing.");

const evidence = await fs.readFile(file, "utf8");
if (!evidence.trim()) throw Error("Evidence is empty.");

// Put the exact originating gateway request in its own evidence comment, before Status.
// The mirror issue body stays source-only. Never alter the gateway run's result.
const kind = process.env.EVIDENCE_KIND || "";
const requestTypes = {
  "request": ["Jim Request", "json"],
  "bash": ["Jim Bash", "bash"],
  "sf-request": ["Sf Request", "json"],
  "sf-bash": ["Sf Bash", "bash"],
  "sf-deploy": ["Sf Deploy", "json"]
};
const requestType = requestTypes[kind];
if (!requestType) throw Error("Unknown evidence kind.");
const issueBody = process.env.ISSUE_BODY || "";
function extractRequest(body, heading, language) {
  const sections = body.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].trim() !== "### " + heading) continue;
    const section = [];
    for (const line of sections.slice(i + 1)) {
      if (/^#{1,3}\s+/.test(line)) break;
      section.push(line);
    }
    const source = section.join("\n");
    const fences = [...source.matchAll(/(?:^|\n)```(json|bash)[ \t]*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/gi)];
    if (fences.length !== 1 || fences[0][1].toLowerCase() !== language) throw Error("Expected one matching gateway request block.");
    found.push(fences[0][2]);
  }
  if (found.length !== 1) throw Error("Expected exactly one gateway heading.");
  if (!found[0].trim() || Buffer.byteLength(found[0], "utf8") > 12000) throw Error("Gateway request block invalid or too large.");
  return "### " + heading + "\n\n```" + language + "\n" + found[0] + "\n```\n\n";
}
// GitHub's <details> is presentation-only: keep the gateway request visible and unchanged.
function collapseCodeBlock(markdown, heading, language, summary) {
  const fence = String.fromCharCode(96).repeat(3);
  const pattern = new RegExp(
    "^### " + heading + "\\r?\\n\\r?\\n(" + fence + language + "[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n" + fence + ")[ \\t]*(?=\\r?\\n|$)",
    "m"
  );
  return markdown.replace(pattern, (_, codeBlock) =>
    "<details>\n<summary>" + summary + "</summary>\n\n" + codeBlock + "\n\n</details>"
  );
}
const requestBlock = extractRequest(issueBody, ...requestType);
const statusAt = evidence.search(/^Status: /m);
if (statusAt === -1) throw Error("Evidence lacks Status line.");
// Keep the gateway request copy visible for audit and quick review.
let formattedEvidence = evidence.slice(0, statusAt) + requestBlock + evidence.slice(statusAt);
if (kind === "bash" || kind === "sf-bash") {
  formattedEvidence = collapseCodeBlock(formattedEvidence, "Bash Script", "bash", "Bash Script");
} else if (kind === "sf-deploy") {
  formattedEvidence = collapseCodeBlock(formattedEvidence, "Terminal Command", "bash", "Sf Deploy — Terminal Command");
}

async function api(path, method = "GET", body) {
  const response = await fetch("https://api.github.com/repos/" + PRIVATE + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "silent-pbf-jim-evidence"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    // Do not print private issue body or response.
    throw Error("Private GitHub API " + method + " HTTP " + response.status);
  }
  return response.status === 204 ? null : response.json();
}
async function list(path) {
  const result = [];
  for (let page = 1; page <= 20; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const data = await api(path + separator + "per_page=100&page=" + page);
    if (!Array.isArray(data)) throw Error("Unexpected private API response.");
    result.push(...data);
    if (data.length < 100) return result;
  }
  throw Error("Private pagination limit exceeded.");
}

// The issue-sync workflow is the sole creator of mirrored issues.
// Wait briefly because independent GitHub Actions workflows start concurrently.
let targets = [];
for (let attempt = 0; attempt < 12; attempt++) {
  targets = (await list("/issues?state=all"))
    .filter(x => !x.pull_request && typeof x.body === "string" && x.body.includes(marker));
  if (targets.length) break;
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (targets.length !== 1) {
  throw Error("Expected one linked private issue; found " + targets.length + ". Evidence not published.");
}
const target = targets[0];
const comments = await list("/issues/" + target.number + "/comments");
const found = comments.filter(x => x.body?.includes(publishMarker));
if (found.length > 1) throw Error("Duplicate private evidence marker.");
if (!found.length) {
  await api("/issues/" + target.number + "/comments", "POST", {
    body: "Source: https://github.com/" + PUBLIC + "/issues/" + issue +
      "\n" + publishMarker + "\n\n" + formattedEvidence
  });
}
console.log("Jim evidence published to linked private issue #" + target.number + " only.");
