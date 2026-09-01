const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const workflowsDir = path.join(root, ".github", "workflows");
const releasePath = path.join(workflowsDir, "release-desktop.yml");
const release = fs.readFileSync(releasePath, "utf8");
const workflows = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => [name, fs.readFileSync(path.join(workflowsDir, name), "utf8")]);

test("no workflow builds with direct electron-builder publication", () => {
  for (const [name, contents] of workflows) {
    assert.doesNotMatch(contents, /--publish\s+(?:always|onTagOrDraft)/, name);
  }
});

test("workflow actions use a Node 24-compatible runtime", () => {
  const legacyActionRuntime =
    /actions\/(?:checkout|setup-node|cache|upload-artifact|download-artifact)@v4|github\/codeql-action\/(?:init|autobuild|analyze)@v3|softprops\/action-gh-release@v2|microsoft\/setup-msbuild@v2|ilammy\/msvc-dev-cmd@v1/;

  for (const [name, contents] of workflows) {
    assert.doesNotMatch(contents, legacyActionRuntime, name);
  }

  assert.match(release, /actions\/checkout@v5/);
  assert.match(release, /actions\/setup-node@v5/);
  assert.match(release, /actions\/upload-artifact@v6/);
  assert.match(release, /actions\/download-artifact@v7/);

  const localMsvcAction = fs.readFileSync(
    path.join(root, ".github", "actions", "setup-msvc", "action.yml"),
    "utf8"
  );
  assert.match(localMsvcAction, /using: composite/);
  assert.match(localMsvcAction, /VsDevCmd\.bat/);
});

test("helper build workflows install runtime dependencies and link AT-SPI correctly", () => {
  const meetingAec = fs.readFileSync(
    path.join(workflowsDir, "build-meeting-aec-helper.yml"),
    "utf8"
  );
  const linuxTextMonitor = fs.readFileSync(
    path.join(workflowsDir, "build-linux-text-monitor.yml"),
    "utf8"
  );

  assert.match(meetingAec, /node-version: "24"/);
  assert.match(meetingAec, /Install Node dependencies[\s\S]*?npm ci --ignore-scripts/);
  assert.match(linuxTextMonitor, /pkg-config --cflags --libs atspi-2 gobject-2\.0 glib-2\.0/);
});

test("release builds are private and promotion is the only writer", () => {
  assert.match(release, /permissions:\n\s+contents: read/);
  assert.match(release, /build-macos:[\s\S]*?--publish never/);
  assert.match(release, /build-linux:[\s\S]*?--publish never/);
  assert.match(release, /build-windows:[\s\S]*?--publish never/);
  assert.match(release, /promote-release:[\s\S]*?permissions:\n\s+contents: write/);
  assert.match(release, /environment: desktop-release-production/);
  assert.equal((release.match(/gh release create/g) || []).length, 1);
  assert.doesNotMatch(
    release.slice(0, release.indexOf("promote-release:")),
    /gh release (?:create|upload)/
  );
});

test("all release architectures depend on the complete test gate", () => {
  for (const job of ["build-macos", "build-linux", "build-windows"]) {
    assert.match(
      release,
      new RegExp(`  ${job}:[\\s\\S]*?needs: \\[validate-release, test-gate\\]`),
      job
    );
  }
  assert.match(
    release,
    /needs: \[validate-release, test-gate, build-macos, build-linux, build-windows\]/
  );
  assert.match(
    release,
    /build-windows:[\s\S]*?if: \$\{\{ vars\.ENABLE_WINDOWS_RELEASE == 'true' \}\}/
  );
  assert.match(release, /--include-windows "\$\{\{ vars\.ENABLE_WINDOWS_RELEASE == 'true' \}\}"/);
  assert.match(
    release,
    /vars\.ENABLE_WINDOWS_RELEASE != 'true' && needs\.build-windows\.result == 'skipped'/
  );
});

test("release tests rebuild native modules for Node instead of Electron", () => {
  const testGate = release.slice(
    release.indexOf("  test-gate:"),
    release.indexOf("  build-macos:")
  );

  assert.match(testGate, /npm ci --ignore-scripts/);
  assert.match(testGate, /npm rebuild better-sqlite3/);
  assert.doesNotMatch(testGate, /ffmpeg-static/);
  assert.match(testGate, /ELECTRON_OVERRIDE_DIST_PATH: \/tmp/);
});

test("packaging force-rebuilds better-sqlite3 for the target Electron ABI", () => {
  const builder = JSON.parse(fs.readFileSync(path.join(root, "electron-builder.json"), "utf8"));
  const nativeRebuild = fs.readFileSync(
    path.join(root, "scripts", "rebuild-electron-native.js"),
    "utf8"
  );

  assert.equal(builder.beforeBuild, "scripts/rebuild-electron-native.js");
  assert.match(nativeRebuild, /onlyModules:\s*NATIVE_MODULES/);
  assert.match(nativeRebuild, /force:\s*true/);
  assert.match(nativeRebuild, /buildFromSource:\s*true/);
  assert.match(nativeRebuild, /getAbi\(electronVersion, "electron"\)/);
  assert.match(nativeRebuild, /return true/);

  const afterPack = fs.readFileSync(path.join(root, "scripts", "afterPack.js"), "utf8");
  assert.match(afterPack, /verifyBetterSqliteElectronAbi/);
  assert.match(afterPack, /packaged better-sqlite3 does not match Electron/);
});

test("manual and tag releases resolve immutable version provenance", () => {
  const contract = fs.readFileSync(path.join(root, "scripts", "release-contract.js"), "utf8");
  assert.match(release, /workflow_dispatch:[\s\S]*?tag:/);
  assert.match(release, /git rev-list -n 1 "\$RELEASE_TAG"/);
  assert.match(release, /release-contract\.js provenance/);
  assert.match(contract, /tag \$\{tag\} must equal v\$\{PACKAGE\.version\}/);
  assert.match(contract, /const releaseTargets = includeWindows \? TARGETS : CORE_TARGETS/);
});

test("promotion uses GitHub CLI's atomic asset upload and publication flow", () => {
  const promotion = release.slice(release.indexOf("  promote-release:"));
  assert.match(promotion, /actions\/checkout@v5[\s\S]*?fetch-depth: 0/);
  const createIndex = release.indexOf('gh release create "$TAG" "${assets[@]}"');
  const countIndex = release.indexOf("actual_count=");
  assert.ok(createIndex > 0);
  assert.ok(countIndex > createIndex);
  assert.match(release, /gh release create "\$TAG" "\$\{assets\[@\]\}"[\s\S]*?--verify-tag/);
  assert.doesNotMatch(release, /gh release create[\s\S]*?--draft/);
  assert.doesNotMatch(release, /gh release edit/);
  assert.doesNotMatch(release, /cleanup_draft/);
});

test("package verification covers signing, notarization, preloads, and secrets", () => {
  const afterPack = fs.readFileSync(path.join(root, "scripts", "afterPack.js"), "utf8");
  assert.match(afterPack, /writePackageVerification/);
  assert.match(afterPack, /preloads: configuredPreloadPaths/);
  assert.doesNotMatch(afterPack, /verifyOwnedSidecars|sidecars: sidecarCount/);
  assert.match(afterPack, /packagedResourcesSecretFree: true/);
  assert.match(release, /VOICELAB_SIGNATURE_VERIFIED/);
  assert.match(release, /VOICELAB_NOTARIZATION_VERIFIED/);
  assert.match(release, /stapler validate/);
  assert.match(release, /hdiutil verify "\$dmg"/);
  assert.doesNotMatch(release, /spctl --assess --type open/);
  assert.match(release, /Get-AuthenticodeSignature/);
});

test("macOS release and local signed builds reject ad-hoc identities", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const verifier = fs.readFileSync(path.join(root, "scripts", "verify-macos-signature.js"), "utf8");

  assert.match(release, /-c\.mac\.forceCodeSigning=true/);
  assert.match(packageJson.scripts["build:mac"], /forceCodeSigning=true/);
  assert.match(packageJson.scripts["build:mac:arm64"], /forceCodeSigning=true/);
  assert.match(packageJson.scripts["build:mac:x64"], /forceCodeSigning=true/);
  assert.match(packageJson.scripts["build:mac:signed"], /forceCodeSigning=true/);
  assert.match(packageJson.scripts["build:mac:unsigned"], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.match(packageJson.scripts["verify:mac-signature"], /verify-macos-signature\.js/);
  assert.match(verifier, /Signature=adhoc/);
  assert.match(verifier, /TeamIdentifier/);
  assert.match(verifier, /--compare/);
  assert.match(verifier, /codesign[\s\S]*-R/);
});

test("macOS verification maps the Node x64 name to the Mach-O x86_64 architecture", () => {
  assert.match(
    release,
    /if \[\[ "\$expected_macho_arch" == "x64" \]\]; then expected_macho_arch="x86_64"; fi/
  );
  assert.match(release, /grep -Fx "\$expected_macho_arch"/);
});
