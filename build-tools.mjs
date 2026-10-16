#!/usr/bin/env node
// pour-apps · build-tools.mjs — command-line tools with their own builds for every
// system. Reads tools.json, asks GitHub for each tool's newest stable release, picks
// one download per system, and writes tools.index.json in the Homebrew API shape Pour
// reads (each tool a "cask" with Pour-native installers and `binary` artifacts).
//
// A tool is listed only when it QUALIFIES — checked here, no human in the loop:
//   · the repository is public, not archived, and has a licence
//   · the newest release is not a draft or a pre-release
//   · at least two systems (or the tool's own min_systems) have a download
//   · every download has a SHA-256: GitHub's own asset digest, or the release's
//     checksums file (SHA256SUMS, checksums.txt, <asset>.sha256)
// Anything else is left out and reported, and the previous good entry is kept for a
// day so one bad release does not make a tool vanish.
//
//   GITHUB_TOKEN=… node build-tools.mjs            (works without a token, slower limits)
//
// Copyright (c) 2026 Jagadeesh Kumar S. All rights reserved.
import { readFileSync, writeFileSync } from "node:fs";

// node build-tools.mjs            → tools.json   → tools.index.json   (command-line tools)
// node build-tools.mjs desktop    → desktop.json → desktop.index.json (desktop apps' own installers
//                                     for Windows, Linux and FreeBSD, named like Homebrew's casks)
const MODE = process.argv.includes("desktop") ? "desktop" : "tools";
const SRC_FILE = MODE === "desktop" ? "desktop.json" : "tools.json";
const OUT_FILE = MODE === "desktop" ? "desktop.index.json" : "tools.index.json";
const src = JSON.parse(readFileSync(new URL(`./${SRC_FILE}`, import.meta.url), "utf8"));
const prev = (() => { try { return JSON.parse(readFileSync(OUT_FILE, "utf8")); } catch { return null; } })();
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const H = { "user-agent": "pour-tools-build", accept: "application/vnd.github+json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };

export const PLATFORMS = ["macos-arm64", "macos-x86_64", "linux-x86_64", "linux-arm64", "linux-i686", "windows-x86_64", "windows-arm64", "freebsd-x86_64"];

const OS = {
  macos: /(darwin|apple|macos|mac-?os|osx|[-_.]mac[-_.]|[-_.]mac$|universal)/i,
  linux: /linux/i,
  windows: /(windows|[-_.]win(32|64)?[-_.]|[-_.]win(32|64)?$|pc-windows|msvc|mingw|\.exe$|-win-)/i,
  freebsd: /freebsd/i,
};
const ARCH = {
  arm64: /(aarch64|arm64)/i,
  x86_64: /(x86[-_]?64|amd64|x64|64bit|win64|linux64|freebsd64)(?!.*(aarch64|arm64))/i,
  i686: /(i686|i386|[-_.]386|x86(?![-_]?64)|32bit|win32|linux32|freebsd32)/i,
};
const EXT_SKIP = /\.(sha256|sha512|sha1|md5|sig|asc|pem|crt|sbom|spdx|json|txt|deb|rpm|apk|msi|pkg|dmg|appimage|snap|flatpak|7z|vsix|whl|nupkg|bz2|gz|xz|zst|sh|ps1|py|jar|tar)$/i;
const NAME_SKIP = /(sha256sums|checksums|shasums|source|[-_.]src[-_.]|debug|dbgsym|symbols|\.d\.ts$|armv[5-7]|armhf|[-_.]arm([-_.]|$)|ppc|s390|riscv|mips|loong|android|musleabi|gnueabi|illumos|solaris|netbsd|openbsd|dragonfly|wasm|installer|setup|[-_.]pdb[-_.]|\.pdb$)/i;
const SKIP = { test: (n) => EXT_SKIP.test(n) || NAME_SKIP.test(n) };

/** One system's download from a release's assets: (platform) → asset or null. */
export function pick(assets, platform, override) {
  if (override) {
    const re = new RegExp(override, "i");
    return assets.find((a) => re.test(a.name)) || null;
  }
  const [os, arch] = platform.split("-");
  const ok = assets.filter((a) => {
    const n = a.name;
    if (NAME_SKIP.test(n)) return false;
    if (!/\.tar\.(gz|xz)$|\.tgz$|\.zip$/i.test(n) && EXT_SKIP.test(n)) return false;
    if (/\.(tar\.zst)$/i.test(n)) return false;
    if (!OS[os].test(n)) return false;
    for (const other of Object.keys(OS)) if (other !== os && OS[other].test(n) && !(os === "windows" && other === "macos")) {
      // "universal" belongs to macOS only; a Windows name never says darwin
      if (other === "macos" && /universal/i.test(n) && os !== "macos") return false;
      if (other !== "macos" || !/universal/i.test(n)) return false;
    }
    if (/(armv[567]|armhf|gnueabi|musleabi)/i.test(n)) return false;
    const archHit = Object.entries(ARCH).filter(([, re]) => re.test(n)).map(([k]) => k);
    if (archHit.length === 0) {
      // no arch in the name: macOS universal, or an x86_64 build by convention
      return os === "macos" ? true : arch === "x86_64";
    }
    if (os === "macos" && /universal/i.test(n)) return true;
    return archHit.includes(arch) && (arch !== "x86_64" || !archHit.includes("arm64"));
  });
  const score = (a) => {
    const n = a.name.toLowerCase();
    let s = 0;
    if (/\.tar\.gz$|\.tgz$/.test(n)) s += 40; else if (/\.zip$/.test(n)) s += 35; else if (/\.tar\.xz$/.test(n)) s += 30; else s += 20;
    // Rust's x86_64-unknown-linux-musl builds are static and run on every Linux;
    // other "musl" builds (bun, deno) need musl's loader, so glibc builds win there
    if (os === "linux" && /unknown-linux-musl/.test(n)) s += 8;
    else if (os === "linux" && /musl/.test(n)) s -= 2;
    if (os === "linux" && /gnu/.test(n)) s += 4;
    if (os === "windows" && /msvc/.test(n)) s += 3;
    if (/static/.test(n)) s += 2;
    if (/universal/.test(n)) s -= 1;
    if (ARCH[arch]?.test(a.name)) s += 10; // a build that names this architecture beats a guess
    if (/(full|extended|lite|minimal|nightly|debug|-dev[-_.])/.test(n)) s -= 5;
    return s - n.length / 100;
  };
  return ok.sort((a, b) => score(b) - score(a))[0] || null;
}

export function kindOf(name) {
  const n = name.toLowerCase();
  if (/\.tar\.gz$|\.tgz$/.test(n)) return "tar.gz";
  if (/\.tar\.xz$/.test(n)) return "tar.xz";
  if (/\.zip$/.test(n)) return "zip";
  return "binary";
}

/** A desktop app's installer for one system: msi/exe on Windows, AppImage/deb/rpm on Linux. */
export const APP_PLATFORMS = ["windows-x86_64", "windows-arm64", "linux-x86_64", "linux-arm64", "freebsd-x86_64"];
const APP_EXT = { windows: /\.(msi|exe)$/i, linux: /\.(appimage|deb|rpm)$/i, freebsd: /\.(pkg|txz)$/i };
const APP_SKIP = /(sha256|checksums|\.sig$|\.asc$|\.blockmap$|debug|symbols|source|[-_.]src[-_.]|armv[5-7]|armhf|[-_.]arm([-_.]|$)|i386|i686|[-_.]386|ia32|win32|x86(?![-_]?64)|ppc|s390|riscv|loong|android|portable|delta|\.zsync$|web-?setup|uninstall)/i;
export function pickApp(assets, platform, override) {
  if (override) {
    const re = new RegExp(override, "i");
    return assets.find((a) => re.test(a.name)) || null;
  }
  const [os, arch] = platform.split("-");
  const ok = assets.filter((a) => {
    const n = a.name;
    if (!APP_EXT[os].test(n) || APP_SKIP.test(n)) return false;
    if (os === "windows" && /\.(appimage|deb|rpm|dmg)$/i.test(n)) return false;
    if (os === "linux" && /(windows|darwin|macos|\.exe$|\.msi$)/i.test(n)) return false;
    if (os === "freebsd" && !/freebsd/i.test(n)) return false; // a bare .pkg is usually a macOS installer
    const archHit = Object.entries(ARCH).filter(([, re]) => re.test(n)).map(([k]) => k);
    if (archHit.length === 0) return arch === "x86_64";
    return archHit.includes(arch) && (arch !== "x86_64" || !archHit.includes("arm64"));
  });
  const score = (a) => {
    const n = a.name.toLowerCase();
    let s = 0;
    if (os === "windows") s += n.endsWith(".msi") ? 40 : 34 + (/(setup|install)/.test(n) ? 4 : 0);
    if (os === "linux") s += n.endsWith(".appimage") ? 40 : n.endsWith(".deb") ? 32 : 24;
    if (ARCH[arch]?.test(a.name)) s += 10;
    if (/(user|per-user)/.test(n)) s += 1;
    if (/[-_.]cli[-_.]/.test(n)) s -= 10; // the app, not its command-line variant
    if (/(nightly|beta|alpha|rc\d|-dev[-_.]|canary|insiders)/.test(n)) s -= 20;
    return s - n.length / 100;
  };
  return ok.sort((a, b) => score(b) - score(a))[0] || null;
}
export function appKind(name) {
  const n = name.toLowerCase();
  for (const k of ["msi", "exe", "appimage", "deb", "rpm"]) if (n.endsWith("." + k)) return k;
  return "binary";
}

/** Sources that are not GitHub releases: an official vendor's download folder with a checksums
 *  file (nodejs.org), or one checksum file per system (dl.min.io). Same qualification rules. */
async function direct(t) {
  const installers = [];
  let version = "";
  const get = async (u) => { const r = await fetch(u, { headers: { "user-agent": "pour-tools-build" } }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); };
  if (t.direct.checksums) {
    const text = await get(t.direct.checksums);
    const rows = text.split(/\r?\n/).map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[2], sha: m[1].toLowerCase() }));
    for (const p of PLATFORMS) {
      const a = pick(rows, p, t.assets?.[p]);
      if (!a) continue;
      installers.push({ platform: p, url: t.direct.base + a.name, sha256: a.sha, kind: kindOf(a.name) });
      version ||= (/\d+\.\d+\.\d+/.exec(a.name) || [""])[0];
    }
  } else if (t.direct.files) {
    for (const [p, f] of Object.entries(t.direct.files)) {
      const m = /^([0-9a-f]{64})\s+\*?(\S+)/i.exec((await get(f.sum)).trim());
      if (!m) continue;
      const file = m[2];
      installers.push({ platform: p, url: f.url.replace("{file}", file), sha256: m[1].toLowerCase(), kind: "binary" });
      version ||= (/RELEASE\.([0-9T:-]+Z)/.exec(file) || [, ""])[1].replace(/T.*/, "").replaceAll("-", ".") || file;
    }
  }
  return { installers, version };
}

const gh = async (path) => {
  const r = await fetch(`https://api.github.com/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

async function checksums(release) {
  const map = {};
  const files = release.assets.filter((a) => /(sha256sums|checksums|shasums|\.sha256$|sha256\.txt$)/i.test(a.name) && a.size < 200_000).slice(0, 12);
  for (const f of files) {
    try {
      const r = await fetch(f.browser_download_url, { headers: { "user-agent": "pour-tools-build" }, redirect: "follow" });
      if (!r.ok) continue;
      const text = await r.text();
      for (const line of text.split(/\r?\n/)) {
        const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim()) || /^SHA256 \((.+)\) = ([0-9a-f]{64})$/i.exec(line.trim());
        if (!m) continue;
        const [h, name] = m[1].length === 64 ? [m[1], m[2]] : [m[2], m[1]];
        map[name.replace(/^.*\//, "")] = h.toLowerCase();
      }
      // <asset>.sha256 holding just the hash
      const solo = /^([0-9a-f]{64})\s*$/i.exec(text.trim());
      if (solo) map[f.name.replace(/\.sha256$/i, "")] = solo[1].toLowerCase();
    } catch { /* no checksum from this file */ }
  }
  return map;
}

const version = (rel) => {
  const t = String(rel.tag_name || "").replace(/^.*@/, "");
  const m = /\d+(\.\d+)+/.exec(t) || /^v?(\d+)$/.exec(t);
  if (m) return m[0].replace(/^v/, "");
  return (rel.published_at || "").slice(0, 10).replaceAll("-", ".") || t || "latest";
};

async function main() {
const casks = [];
const report = { listed: [], left_out: [] };
for (const t of src.tools || src.apps) {
  try {
    if (t.direct) {
      // an official vendor download folder: its checksums decide what qualifies
      const { installers, version: ver } = await direct(t);
      const need = t.min_systems ?? 2;
      if (installers.length < need) throw new Error(`downloads for ${installers.length} system(s), needs ${need}`);
      if (!t.licence) throw new Error("no licence stated");
      casks.push({
        token: t.token, full_token: `${src.tap}/${t.token}`, tap: src.tap, name: [t.name || t.token], old_tokens: t.aliases || [],
        desc: t.desc, homepage: t.homepage, version: ver, sha256: installers.find((i) => i.platform === "macos-arm64")?.sha256 ?? "no_check", url: "",
        artifacts: [{ binary: t.bin || [t.token] }], auto_updates: false, caveats: t.caveats || null,
        pour: { kind: "cli", installers, source: t.homepage, licence: t.licence },
      });
      report.listed.push(`${t.token} ${ver} · ${installers.map((i) => i.platform).join(" ")}`);
      continue;
    }
    const repo = await gh(`repos/${t.repo}`);
    const problems = [];
    if (repo.archived) problems.push("repository is archived");
    if (repo.private) problems.push("repository is private");
    if (!repo.license && !t.vendor) problems.push("no licence");
    let rel;
    try { rel = await gh(`repos/${t.repo}/releases/latest`); } catch { problems.push("no stable release"); }
    if (rel && (rel.draft || rel.prerelease)) problems.push("newest release is a pre-release");
    const installers = [];
    const desktop = MODE === "desktop";
    if (rel) {
      const sums = await checksums(rel);
      for (const p of desktop ? APP_PLATFORMS : PLATFORMS) {
        const a = desktop ? pickApp(rel.assets, p, t.assets?.[p]) : pick(rel.assets, p, t.assets?.[p]);
        if (!a) continue;
        const digest = (a.digest || "").startsWith("sha256:") ? a.digest.slice(7).toLowerCase() : sums[a.name];
        if (!digest || !/^[0-9a-f]{64}$/.test(digest)) { problems.push(`${p}: ${a.name} has no published SHA-256`); continue; }
        installers.push({ platform: p, url: a.browser_download_url, sha256: digest, kind: desktop ? appKind(a.name) : kindOf(a.name), size: a.size });
      }
    }
    const need = t.min_systems ?? (desktop ? 1 : 2);
    if (installers.length < need) problems.push(`downloads for ${installers.length} system(s), needs ${need}`);
    const fatal = problems.filter((p) => !/has no published SHA-256/.test(p) || installers.length < need);
    if (fatal.length) throw new Error(fatal.join("; "));
    if (desktop) {
      casks.push({
        token: t.token, full_token: `${src.tap}/${t.token}`, tap: src.tap, name: [t.name || repo.name],
        desc: (t.desc || repo.description || repo.name).replace(/\s+/g, " ").trim().slice(0, 200),
        homepage: repo.homepage && /^https:/.test(repo.homepage) ? repo.homepage : repo.html_url,
        version: version(rel), sha256: "no_check", url: "", artifacts: [{ app: [`${t.name || repo.name}.app`] }], auto_updates: true, caveats: null,
        pour: { kind: "app", installers, source: `github:${t.repo}`, licence: repo.license?.spdx_id || (t.vendor ? "vendor" : null), stars: repo.stargazers_count, release: rel.html_url },
      });
      report.listed.push(`${t.token} ${version(rel)} · ${installers.map((i) => i.platform + ":" + i.kind).join(" ")}`);
      continue;
    }
    const bins = t.bin || [t.token];
    const mac = installers.find((i) => i.platform === "macos-arm64");
    casks.push({
      token: t.token,
      full_token: `${src.tap}/${t.token}`,
      tap: src.tap,
      name: [t.name || t.token],
      old_tokens: t.aliases || [],
      desc: (t.desc || repo.description || repo.name).replace(/\s+/g, " ").trim().slice(0, 200),
      homepage: repo.homepage && /^https:/.test(repo.homepage) ? repo.homepage : repo.html_url,
      version: version(rel),
      sha256: mac?.sha256 ?? "no_check",
      url: "",
      artifacts: [{ binary: bins }],
      auto_updates: false,
      caveats: null,
      pour: { kind: "cli", installers, source: `github:${t.repo}`, licence: repo.license?.spdx_id || null, stars: repo.stargazers_count, release: rel.html_url },
    });
    report.listed.push(`${t.token} ${version(rel)} · ${installers.map((i) => i.platform).join(" ")}`);
  } catch (e) {
    const old = prev?.casks?.find((c) => c.token === t.token);
    const fresh = old && Date.now() - Date.parse(prev?.meta?.synced_at || 0) < 86_400_000;
    if (fresh) casks.push(old);
    report.left_out.push(`${t.token}: ${e.message}${fresh ? " (kept yesterday's entry)" : ""}`);
  }
}

const index = {
  meta: { name: MODE === "desktop" ? "pour-desktop" : "pour-tools", owner: "Jagadeesh Kumar S", synced_at: new Date().toISOString(), source: "https://github.com/JKS-sys/pour-apps-13-Oct-2026", [MODE === "desktop" ? "apps" : "tools"]: casks.length, systems: MODE === "desktop" ? APP_PLATFORMS : PLATFORMS },
  formulae: [],
  casks,
};
writeFileSync(OUT_FILE, JSON.stringify(index) + "\n");
console.log(`${OUT_FILE}: ${casks.length} ${MODE === "desktop" ? "apps" : "tools"} qualified, ${report.left_out.length} left out`);
for (const l of report.left_out) console.log(`  - ${l}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
