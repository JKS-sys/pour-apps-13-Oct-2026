#!/usr/bin/env node
// pour-apps · build-scoop.mjs — Windows software, synced automatically from the Scoop
// community's manifest buckets (ScoopInstaller/Main and ScoopInstaller/Extras: thousands
// of maintained JSON manifests, each with a download URL and its hash, kept current by
// Scoop's own update bots). Writes windows.index.json — the pour-windows registry —
// which Pour on Windows uses for any name Homebrew has no Windows build for.
//
// A manifest is listed only when it QUALIFIES (checked here, nobody in the loop):
//   · a stable version (not "nightly"/"latest"), a licence, an https homepage
//   · a 64-bit (or arm64) download over https with a SHA-256 hash (md5/sha1/sha512-only
//     manifests are left out: Pour verifies SHA-256)
//   · a download Pour can place: zip, 7z, tar.*, msi, or a single .exe program
//   · no PowerShell steps (installer/pre_install/post_install/uninstaller scripts) and no
//     installer program to run with arguments — Pour never runs a manifest's script
//   · it names the programs it puts on PATH (`bin`) or, for apps, the program a shortcut
//     opens
//   · no dependencies on other manifests
// Everything else is left out and counted by reason.
//
//   node build-scoop.mjs        (needs network access to codeload.github.com and tar)
//
// Copyright (c) 2026 Jagadeesh Kumar S. All rights reserved.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUCKETS = [
  { name: "main", repo: "ScoopInstaller/Main", branch: "master" },
  { name: "extras", repo: "ScoopInstaller/Extras", branch: "master" },
];
const TAP = "jks-sys/pour-windows";

export const KIND = (u) => {
  const p = u.split(/[?]/)[0].toLowerCase();
  const frag = p.includes("#/") ? p.slice(p.indexOf("#/") + 2) : p;
  if (/\.zip$/.test(frag)) return "zip";
  if (/\.7z$/.test(frag)) return "tar"; // Windows' tar (libarchive) reads 7z
  if (/\.(tar\.gz|tgz|tar\.xz|tar\.bz2)$/.test(frag)) return "tar.gz";
  if (/\.msi$/.test(frag)) return "msi";
  if (/\.exe$/.test(frag)) return "binary";
  return null;
};

const sha = (h) => {
  if (typeof h !== "string") return null;
  const m = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(h.trim());
  return m ? m[1].toLowerCase() : null;
};

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** Program names from `bin`: "a.exe", ["sub/b.exe", "alias"], [["c.exe", "c"]]. */
export function programs(bin) {
  const out = [];
  for (const b of arr(bin)) {
    const [path, alias] = Array.isArray(b) ? b : [b];
    if (typeof path !== "string") continue;
    const name = (typeof alias === "string" && alias) || path.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "");
    if (/^[A-Za-z0-9._+-]{1,60}$/.test(name) && !out.includes(name.toLowerCase())) out.push(name.toLowerCase());
  }
  return out;
}

/** One manifest → a registry entry, or the reason it does not qualify. */
export function qualify(token, m) {
  if (typeof m.version !== "string" || /nightly|latest|^dev/i.test(m.version)) return { why: "no stable version" };
  const lic = typeof m.license === "string" ? m.license : m.license?.identifier;
  if (!lic) return { why: "no licence" };
  if (typeof m.homepage !== "string" || !/^https:\/\//.test(m.homepage)) return { why: "no https homepage" };
  for (const k of ["pre_install", "post_install", "pre_uninstall", "post_uninstall"]) if (m[k]) return { why: "runs PowerShell steps" };
  if (m.installer || m.uninstaller) return { why: "runs an installer program or script" };
  if (m.depends) return { why: "depends on other manifests" };
  const installers = [];
  for (const [arch, plat] of [["64bit", "windows-x86_64"], ["arm64", "windows-arm64"]]) {
    const a = m.architecture?.[arch] || (arch === "64bit" && !m.architecture ? m : null);
    if (!a) continue;
    if (a.installer || a.pre_install || a.post_install) return { why: "runs PowerShell steps" };
    const urls = arr(a.url ?? m.url), hashes = arr(a.hash ?? m.hash);
    if (urls.length !== 1 || hashes.length !== 1) continue; // several files to combine: not supported
    const url = urls[0], h = sha(hashes[0]);
    if (typeof url !== "string" || !/^https:\/\//.test(url)) continue;
    if (!h) continue;
    const kind = KIND(url);
    if (!kind) continue;
    installers.push({ platform: plat, url: url.split("#/")[0], sha256: h, kind });
  }
  if (!installers.length) return { why: "no 64-bit https download with a SHA-256 Pour can place" };
  let bins = programs(m.bin ?? m.architecture?.["64bit"]?.bin);
  const app = !bins.length && arr(m.shortcuts).length > 0;
  if (app) bins = programs(arr(m.shortcuts).map((s) => (Array.isArray(s) ? s[0] : null)).filter(Boolean).slice(0, 1));
  if (!bins.length) return { why: "names no program" };
  const desc = typeof m.description === "string" ? m.description.replace(/\s+/g, " ").trim().slice(0, 200) : token;
  return {
    cask: {
      token,
      full_token: `${TAP}/${token}`,
      tap: TAP,
      name: [token],
      desc,
      homepage: m.homepage,
      version: m.version,
      sha256: "no_check",
      url: "",
      artifacts: [{ binary: bins }],
      auto_updates: false,
      caveats: typeof m.notes === "string" ? m.notes.slice(0, 400) : Array.isArray(m.notes) ? m.notes.join("\n").slice(0, 400) : null,
      pour: { kind: app ? "app" : "cli", installers, source: "scoop", licence: lic },
    },
  };
}

async function main() {
  const casks = new Map();
  const reasons = {};
  let seen = 0;
  for (const b of BUCKETS) {
    const dir = mkdtempSync(join(tmpdir(), `scoop-${b.name}-`));
    const r = await fetch(`https://codeload.github.com/${b.repo}/tar.gz/refs/heads/${b.branch}`, { headers: { "user-agent": "pour-scoop-sync" } });
    if (!r.ok) throw new Error(`${b.repo}: HTTP ${r.status}`);
    writeFileSync(join(dir, "b.tgz"), Buffer.from(await r.arrayBuffer()));
    execFileSync("tar", ["-xzf", join(dir, "b.tgz"), "-C", dir]);
    const root = readdirSync(dir).find((d) => d !== "b.tgz");
    const bucket = join(dir, root, "bucket");
    for (const f of readdirSync(bucket).filter((f) => f.endsWith(".json"))) {
      seen++;
      const token = f.slice(0, -5).toLowerCase();
      if (!/^[a-z0-9][a-z0-9+._@-]{0,59}$/.test(token) || casks.has(token)) continue;
      let m;
      try { m = JSON.parse(readFileSync(join(bucket, f), "utf8")); } catch { reasons["unreadable manifest"] = (reasons["unreadable manifest"] || 0) + 1; continue; }
      const q = qualify(token, m);
      if (q.cask) { q.cask.pour.bucket = b.name; casks.set(token, q.cask); }
      else reasons[q.why] = (reasons[q.why] || 0) + 1;
    }
    rmSync(dir, { recursive: true, force: true });
  }
  const list = [...casks.values()].sort((a, b) => a.token.localeCompare(b.token));
  const index = { meta: { name: "pour-windows", owner: "Jagadeesh Kumar S", synced_at: new Date().toISOString(), source: "Scoop buckets: ScoopInstaller/Main, ScoopInstaller/Extras", seen, listed: list.length, left_out: reasons }, formulae: [], casks: list };
  writeFileSync("windows.index.json", JSON.stringify(index) + "\n");
  console.log(`windows.index.json: ${list.length} of ${seen} manifests qualified`);
  for (const [w, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  - ${n} × ${w}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
