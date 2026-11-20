import fs from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";

const apiKey = process.env.SF_BFI_PROD_APIKEY || "";
const issueBody = process.env.ISSUE_BODY || "";
const evidenceFile = (process.env.RUNNER_TEMP || "/tmp") + "/jim-request-comment.md";
const fence = "\x60\x60\x60";
const credentialOrigin = "https://gateway.prod.bravo.bfi.co.id";

function readRequest(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let section = null;
  for (const line of lines) {
    if (/^### Jim Request\s*$/.test(line)) {
      section = [];
      sections.push(section);
    } else if (section && /^#{1,3}\s+/.test(line)) {
      section = null;
    } else if (section) {
      section.push(line);
    }
  }
  if (sections.length !== 1) throw new Error("Harus ada tepat satu heading ### Jim Request.");
  const matches = [...sections[0].join("\n").matchAll(/(?:^|\n)\x60{3}json[ \t]*\n([\s\S]*?)\n\x60{3}[ \t]*(?=\n|$)/gi)];
  if (matches.length !== 1 || Buffer.byteLength(matches[0][1], "utf8") > 10000) {
    throw new Error("Jim Request wajib berisi satu JSON code block maksimal 10 KB.");
  }
  let request;
  try { request = JSON.parse(matches[0][1]); }
  catch { throw new Error("JSON Jim Request tidak valid."); }
  if (!request || Array.isArray(request) || typeof request !== "object") {
    throw new Error("Request harus JSON object.");
  }
  if (Object.keys(request).some(k => !["url", "method", "body"].includes(k))) {
    throw new Error("Property yang didukung: url, method, body.");
  }
  if (typeof request.url !== "string" || request.url.length > 2048) {
    throw new Error("url wajib berupa string maksimal 2048 karakter.");
  }
  let url;
  try { url = new URL(request.url); } catch { throw new Error("URL tidak valid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Hanya URL HTTPS tanpa credentials atau fragment yang diperbolehkan.");
  }
  const method = String(request.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) {
    throw new Error("Method yang didukung: GET, HEAD, POST.");
  }
  if (method !== "POST" && Object.hasOwn(request, "body")) {
    throw new Error("body hanya dapat digunakan untuk POST.");
  }
  if (method === "POST" && (!Object.hasOwn(request, "body") || request.body === null)) {
    throw new Error("POST memerlukan property body.");
  }
  return { url, method, body: request.body };
}

// Protect the runner from local-network targets; this is not a hostname/path allowlist.
async function checkDestination(url) {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || net.isIP(hostname)) {
    throw new Error("URL ke localhost, jaringan lokal, atau alamat IP langsung ditolak.");
  }
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length) throw new Error("DNS target tidak ditemukan.");
  for (const { address } of records) {
    const v4 = net.isIP(address) === 4 ? address.split(".").map(Number) : null;
    if (v4 && (v4[0] === 0 || v4[0] === 10 || v4[0] === 127 ||
      v4[0] >= 224 || (v4[0] === 169 && v4[1] === 254) ||
      (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
      (v4[0] === 192 && v4[1] === 168) ||
      (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) ||
      (v4[0] === 192 && v4[1] === 0 && v4[2] === 0))) {
      throw new Error("URL mengarah ke alamat jaringan non-public.");
    }
    if (net.isIP(address) === 6 && (
      address === "::1" || address === "::" ||
      /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address) ||
      /^::ffff:/i.test(address))) {
      throw new Error("URL mengarah ke alamat jaringan non-public.");
    }
  }
}

function hideSecrets(value) {
  let out = String(value ?? "");
  if (apiKey) out = out.split(apiKey).join("[HIDDEN]");
  return out;
}
function quote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
async function main() {
  let request;
  let response;
  let result = {};
  let errorMessage = "";
  let sentBody;
  try {
    request = readRequest(issueBody);
    await checkDestination(request.url);
    const headers = { "Accept": "application/json" };
    // Never forward the production key to an arbitrary destination.
    if (request.url.origin === credentialOrigin) {
      if (!apiKey) throw new Error("GitHub Secret SF_BFI_PROD_APIKEY belum tersedia.");
      headers["X-Apikey"] = apiKey;
    }
    if (request.method === "POST") {
      sentBody = JSON.stringify(request.body);
      if (Buffer.byteLength(sentBody, "utf8") > 10000) {
        throw new Error("POST body maksimal 10 KB.");
      }
      headers["Content-Type"] = "application/json";
    }
    response = await fetch(request.url, {
      method: request.method,
      headers,
      ...(sentBody === undefined ? {} : { body: sentBody }),
      redirect: "error",
      signal: AbortSignal.timeout(30000)
    });
    const responseText = await response.text();
    if (Buffer.byteLength(responseText, "utf8") > 50000) {
      result = { notice: "Response melebihi 50 KB; tidak ditampilkan." };
    } else {
      try { result = JSON.parse(responseText); }
      catch { result = { text: responseText.slice(0, 2000) }; }
    }
    if (!response.ok) {
      errorMessage = "Gateway HTTP " + response.status;
      process.exitCode = 1;
    }
  } catch (error) {
    errorMessage = error.message;
    process.exitCode = 1;
  }

  const status = response ? response.status : "N/A";
  const method = request?.method || "N/A";
  const curl = request
    ? ["curl --location --request " + method + " " + quote(request.url.toString()),
       "  --header 'Accept: application/json'",
       ...(request.url.origin === credentialOrigin ? ["  --header 'X-Apikey: [HIDDEN]'"] : []),
       ...(sentBody === undefined ? [] : ["  --header 'Content-Type: application/json'", "  --data " + quote(sentBody)])].join(" \\\n")
    : "Request tidak valid; cURL tidak tersedia.";
  const lines = [
    "## Jim API — Issue #" + (process.env.ISSUE_NUMBER || "?"), "",
    "Status: **" + (errorMessage ? "FAILED" : "SUCCESS") + "** · HTTP " + status + " · " + method, "",
    "<details>", "<summary>cURL (API key masked)</summary>", "", fence + "bash",
    hideSecrets(curl), fence, "", "</details>", "",
    "<details>", "<summary>Response JSON — HTTP " + status + "</summary>", ""
  ];
  if (errorMessage) lines.push("Error: " + hideSecrets(errorMessage), "");
  lines.push(fence + "json", hideSecrets(JSON.stringify(result, null, 2)), fence, "", "</details>");
  await fs.writeFile(evidenceFile, lines.join("\n"), { mode: 0o600 });
  console.log("Jim API " + (errorMessage ? "FAILED" : "SUCCESS") + " HTTP " + status + " (detail di Issue).");
}
await main();
