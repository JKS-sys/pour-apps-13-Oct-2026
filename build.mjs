#!/usr/bin/env node
// pour-apps · build.mjs — read apps.json, ask every app's live feed for its
// newest build, and write index.json in the Homebrew API shape Pour reads.
// Works with Node 18+. `node build.mjs` (fetch) or `node build.mjs --offline`.
import { readFileSync, writeFileSync } from "node:fs";

const src = JSON.parse(readFileSync(new URL("./apps.json", import.meta.url), "utf8"));
const offline = process.argv.includes("--offline");
const prev = (() => { try { return JSON.parse(readFileSync("index.json", "utf8")); } catch { return null; } })();

const MAC_TAGS = ["golden_gate", "tahoe", "sequoia", "sonoma", "ventura", "monterey", "big_sur"];
const PLATFORM_KEYS = {
  "macos-arm64":   ["darwin-aarch64", "darwin-aarch64-app", "macos-aarch64", "macos-arm64", "mac_arm"],
  "macos-x86_64":  ["darwin-x86_64", "darwin-x86_64-app", "macos-x86_64", "macos-intel", "mac_intel"],
  "linux-x86_64":  ["linux-x86_64-deb", "deb", "linux-x86_64", "linux-x86_64-appimage", "appimage"],
  "linux-arm64":   ["linux-aarch64-deb", "deb_arm", "linux-aarch64", "linux-arm64"],
  "windows-x86_64":["windows-x86_64", "windows-x86_64-nsis", "windows"],
  "windows-arm64": ["windows-aarch64", "windows-arm64"],
  "freebsd-x86_64":["freebsd", "freebsd-x86_64", "freebsd_amd64"],
};
const kindOf = (u) => {
  const p = u.split(/[?#]/)[0].toLowerCase();
  if (p.endsWith(".app.tar.gz")) return "tar.gz";
  for (const k of ["dmg", "zip", "pkg", "exe", "msi", "deb", "rpm", "appimage"]) if (p.endsWith("." + k)) return k;
  if (p.endsWith(".tar.gz") || p.endsWith(".tgz")) return "tar.gz";
  return "unknown";
};

async function feed(app) {
  if (!app.feed) return null;
  if (offline) return prev?.casks?.find((c) => c.token === app.token)?._feed ?? null;
  const r = await fetch(app.feed, { headers: { "user-agent": "pour-apps-build" } });
  if (!r.ok) throw new Error(`${app.feed}: HTTP ${r.status}`);
  const j = await r.json();
  const base = app.feed.slice(0, app.feed.lastIndexOf("/") + 1);
  const abs = (u) => (/^https?:/.test(u) ? u : base + u);
  const map = {};
  for (const section of ["platforms", "files", "downloads"]) {
    for (const [k, e] of Object.entries(j[section] ?? {})) {
      const u = typeof e === "string" ? e : e?.url || e?.file || e?.name;
      if (u) map[k.toLowerCase()] = { url: abs(u), sha256: typeof e === "object" ? e?.sha256?.toLowerCase() : undefined };
    }
  }
  const pick = (plat) => PLATFORM_KEYS[plat].map((k) => map[k]).find(Boolean);
  const out = { version: String(j.version).replace(/^v/, ""), platforms: {} };
  for (const plat of Object.keys(PLATFORM_KEYS)) { const hit = pick(plat); if (hit) out.platforms[plat] = hit; }
  return out;
}

const casks = [];
for (const app of src.apps) {
  let f = null;
  try { f = await feed(app); } catch (e) { console.error(`! ${app.token}: ${e.message}`); f = prev?.casks?.find((c) => c.token === app.token)?._feed ?? null; }
  const bid = `${src.bundle_prefix}.${app.token}`;
  const mac = f?.platforms?.["macos-arm64"];
  const intel = f?.platforms?.["macos-x86_64"];
  const artifacts = [
    { uninstall: [{ quit: bid }] },
    { app: [app.app] },
    ...(app.binary ? [{ binary: [`$APPDIR/${app.app}/Contents/MacOS/${app.binary}`], target: `$HOMEBREW_PREFIX/bin/${app.binary}` }] : []),
    { zap: [{ trash: [
      `~/.${app.token}`,
      `~/Library/Application Support/${bid}`,
      `~/Library/Caches/${bid}`,
      `~/Library/Preferences/${bid}.plist`,
      `~/Library/Saved Application State/${bid}.savedState`,
      `~/Library/WebKit/${bid}`,
    ] }] },
  ];
  const variations = {};
  if (intel) for (const t of MAC_TAGS) variations[t] = { url: intel.url, ...(intel.sha256 ? { sha256: intel.sha256 } : {}) };
  const installers = [];
  for (const [plat, hit] of Object.entries(f?.platforms ?? {})) {
    if (plat.startsWith("macos")) continue;
    installers.push({ platform: plat, url: hit.url, kind: kindOf(hit.url), ...(hit.sha256 ? { sha256: hit.sha256 } : {}) });
  }
  casks.push({
    token: app.token,
    full_token: `${src.tap}/${app.token}`,
    tap: src.tap,
    name: [app.name],
    desc: app.desc,
    homepage: app.homepage,
    version: f?.version ?? "0.0.0",
    sha256: mac?.sha256 ?? "no_check",
    url: mac?.url ?? "",
    container: mac?.url?.endsWith(".app.tar.gz") ? { type: "tar" } : null,
    depends_on: { macos: { ">=": ["11"] } },
    artifacts,
    auto_updates: true,
    caveats: app.status === "coming-soon" ? `${app.name} is not released yet. Watch ${app.homepage} — it will appear here the day it ships.` : `${app.name} is free; Pro unlocks more. Releases: ${app.releases}`,
    variations,
    pour: {
      livecheck: app.feed ?? null,
      clear_quarantine: true,
      installers,
      status: app.status ?? "released",
      releases: app.releases ?? null,
    },
    _feed: f,
  });
}

const index = {
  meta: { name: "pour-apps", owner: src.owner, synced_at: new Date().toISOString(), source: "https://github.com/JKS-sys/pour-apps-13-Oct-2026", apps: casks.length },
  formulae: [],
  casks,
};
writeFileSync("index.json", JSON.stringify(index, null, 1) + "\n");
console.log(`index.json: ${casks.length} apps · ${casks.filter((c) => c.url).length} with a macOS build · ${casks.reduce((n, c) => n + c.pour.installers.length, 0)} installers for other systems`);
