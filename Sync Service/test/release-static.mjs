import { createHash, createPublicKey, verify } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(here, "..");
const releaseRoot = resolve(serviceRoot, "..");
const overlayPath = join(releaseRoot, "overlay.js");
const workerPath = join(serviceRoot, "src", "index.js");
const manifestPath = join(serviceRoot, "public", "updates", "manifest.json");
const injectorPath = join(releaseRoot, "Source", "Injector.cs");
const portableLauncherPath = join(releaseRoot, "Source", "PortableLauncher.cs");
const licensePath = join(releaseRoot, "LICENSE");
const overlay = readFileSync(overlayPath, "utf8");
const worker = readFileSync(workerPath, "utf8");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const injector = readFileSync(injectorPath, "utf8");
const portableLauncher = readFileSync(portableLauncherPath, "utf8");
const license = readFileSync(licensePath, "utf8");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

for (const path of [overlayPath, workerPath]) {
  const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  assert(checked.status === 0, `Syntax check failed for ${path}: ${checked.stderr}`);
}

const version = overlay.match(/const\s+VERSION\s*=\s*["']([^"']+)["']/)?.[1];
assert(version && version === manifest.version, "Overlay and signed manifest versions do not match");
assert(overlay.includes("Wookie's Starwatch"), "Current overlay branding is missing");
assert(overlay.includes('data-action="toggle">Starwatch</button>'), "Starwatch drawer button is missing");
assert(overlay.includes("battleSharing: saved.sync?.battleSharing === true"), "New-user battle contribution is not explicit opt-in");
assert(overlay.includes('data-action="privacy-consent"'), "Shared-data consent control is missing");
assert(overlay.includes('data-action="diagnostic-copy"'), "Privacy-safe diagnostics control is missing");
assert(worker.includes('url.pathname === "/v1/account/delete"'), "Authenticated cloud deletion route is missing");
assert(portableLauncher.includes('internal const string Version = "2.1.0"'), "Portable launcher version is not 2.1.0");
assert(portableLauncher.includes("DispatchNativeAlerts"), "Portable background alert dispatcher is missing");
assert(injector.includes('path == "/alert/schedule"'), "Native alert scheduling route is missing");
assert(portableLauncher.includes('WookiesStarwatch.overlay.js'), "Portable launcher embedded fallback is missing");
assert(portableLauncher.includes('Environment.SpecialFolder.LocalApplicationData'), "Portable launcher update cache is not under LocalAppData");
assert(portableLauncher.includes('new NotifyIcon'), "Portable launcher tray controller is missing");
assert(portableLauncher.includes('new System.Threading.Timer'), "Portable launcher game monitor is missing");
assert(portableLauncher.includes('WookiesStarwatch.LICENSE.txt'), "Portable launcher embedded MIT notice is missing");
assert(license.startsWith("MIT License"), "MIT license heading is missing");
assert(license.includes("Copyright (c) 2026 Wookie's Starwatch contributors"), "MIT copyright notice is missing");

const updateAsset = new URL(manifest.overlayUrl);
assert(updateAsset.protocol === "https:", "Update asset must use HTTPS");
assert(updateAsset.pathname === `/updates/overlay-${version}.js`, "Update asset is not immutable/versioned");
const assetPath = join(serviceRoot, "public", ...updateAsset.pathname.split("/").filter(Boolean));
const asset = readFileSync(assetPath);
const digest = createHash("sha256").update(asset).digest("hex").toUpperCase();
assert(digest === String(manifest.sha256).toUpperCase(), "Signed update asset hash does not match manifest");
assert(asset.equals(readFileSync(overlayPath)), "Signed update asset is not the current overlay");

const modulus = injector.match(/<Modulus>([^<]+)<\/Modulus>/)?.[1];
const exponent = injector.match(/<Exponent>([^<]+)<\/Exponent>/)?.[1];
assert(modulus && exponent, "Launcher update public key could not be read");
const base64Url = (value) => Buffer.from(value, "base64").toString("base64url");
const publicKey = createPublicKey({ key: { kty: "RSA", n: base64Url(modulus), e: base64Url(exponent) }, format: "jwk" });
const signedText = `${manifest.version}\n${manifest.overlayUrl}\n${String(manifest.sha256).toUpperCase()}\n${manifest.minimumLauncherVersion}\n${manifest.publishedAt}\n`;
assert(verify("RSA-SHA256", Buffer.from(signedText), publicKey, Buffer.from(manifest.signature, "base64")), "Manifest signature is invalid");

const forbiddenNames = new Set(["update-private.xml", ".env", ".dev.vars"]);
const forbiddenExtensions = new Set([".pem", ".pfx", ".p12", ".key"]);
const walk = (root) => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ["node_modules", ".wrangler"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      const lower = basename(path).toLowerCase();
      assert(!forbiddenNames.has(lower), `Forbidden private file found: ${path}`);
      assert(![...forbiddenExtensions].some((extension) => lower.endsWith(extension)), `Possible private key found: ${path}`);
    }
  }
};
walk(releaseRoot);

for (const document of ["PRIVACY.md", "KNOWN ISSUES.md", "TROUBLESHOOTING.md", "FRIEND_BETA_README.md", "RELEASE.md"]) {
  readFileSync(join(releaseRoot, document));
}

console.log(`Release checks passed for overlay ${version} / service ${worker.match(/SERVICE_VERSION\s*=\s*"([^"]+)"/)?.[1] || "unknown"}.`);
