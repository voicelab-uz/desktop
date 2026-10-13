const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "../..");
const desktopAuthManagerPath = path.join(repositoryRoot, "src/helpers/desktopAuthManager.js");
const voiceLabApiClientPath = path.join(repositoryRoot, "src/helpers/voiceLabApiClient.js");
const rendererAuthPath = path.join(repositoryRoot, "src/lib/auth.ts");
const ipcHandlersPath = path.join(repositoryRoot, "src/helpers/ipcHandlers.js");
const executableExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const forbiddenDesktopSessionRoutes = ["/api/v2/auth/login", "/api/v2/auth/refresh"];

function executableSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...executableSourceFiles(location));
    } else if (executableExtensions.has(path.extname(entry.name))) {
      files.push(location);
    }
  }
  return files;
}

test("desktop executable sources never reference generic login or refresh routes", () => {
  const sourceFiles = [
    path.join(repositoryRoot, "main.js"),
    path.join(repositoryRoot, "preload.js"),
    ...executableSourceFiles(path.join(repositoryRoot, "preloads")),
    ...executableSourceFiles(path.join(repositoryRoot, "src")),
  ];

  for (const sourceFile of sourceFiles) {
    const source = fs.readFileSync(sourceFile, "utf8");
    for (const forbiddenRoute of forbiddenDesktopSessionRoutes) {
      assert.equal(
        source.includes(forbiddenRoute),
        false,
        `${path.relative(repositoryRoot, sourceFile)} references forbidden desktop auth route ${forbiddenRoute}`
      );
    }
  }
});

test("every DesktopAuthManager POST uses a dedicated desktop auth endpoint", () => {
  const source = fs.readFileSync(desktopAuthManagerPath, "utf8");
  const postRequestPattern = /_request\(\s*["']([^"']+)["']\s*,\s*\{\s*method:\s*["']POST["']/g;
  const postRoutes = [...source.matchAll(postRequestPattern)].map((match) => match[1]);

  assert.deepEqual([...new Set(postRoutes)].sort(), [
    "/api/v2/auth/desktop/authorizations",
    "/api/v2/auth/desktop/logout",
    "/api/v2/auth/desktop/token",
  ]);
  for (const route of postRoutes) {
    assert.match(route, /^\/api\/v2\/auth\/desktop\//);
    assert.equal(forbiddenDesktopSessionRoutes.includes(route), false);
  }
});

test("desktop VoiceLab data requests are limited to documented API routes", () => {
  const source = fs.readFileSync(voiceLabApiClientPath, "utf8");
  const endpointConstants = [
    ...source.matchAll(/const\s+\w+_PATH\s*=\s*(\[[^\n]+\])\.join\(["']\/["']\)/g),
  ].map((match) => [...match[1].matchAll(/["']([^"']*)["']/g)].map((part) => part[1]).join("/"));

  assert.deepEqual(endpointConstants.sort(), [
    "/v1/desktop/me",
    "/v1/desktop/onboarding",
    "/v1/desktop/stt",
    "/v1/desktop/transcriptions",
    "/v1/desktop/usage",
  ]);
  assert.doesNotMatch(source, /\/api\/v1\/billing\/desktop\//);
  assert.doesNotMatch(source, /\/api\/v1\/desktop\/sync/);
  assert.doesNotMatch(source, /\/approve(?:["'/?]|$)/);
  assert.doesNotMatch(source, /\/polar\/checkout/);
});

test("renderer auth helpers delegate to desktop auth instead of website account routes", () => {
  const source = fs.readFileSync(rendererAuthPath, "utf8");

  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\/api\/auth\/(?:forgot-password|resend-verification-code)/);
  assert.match(source, /authStartBrowser/);
});

test("legacy website IPC cannot attach a desktop bearer token", () => {
  const source = fs.readFileSync(ipcHandlersPath, "utf8");

  assert.match(source, /const getAuthHeaderFromWindow = async \(\) => \(\{\}\);/);
});
