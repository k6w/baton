/**
 * Package built binaries (dist/baton-<target>, from `bun scripts/build.ts --all`) for release:
 *
 *   dist/release/baton-<target>.tar.gz (.zip on Windows)   one archive per platform, `baton` inside
 *   dist/release/SHA256SUMS                                 checksums (install.sh and `baton update` verify them)
 *   dist/release/baton.rb                                   Homebrew formula for the tap
 *   dist/npm/<package>/                                     npm: `batonsh` + one package per platform
 *
 *   bun scripts/release.ts [--repo owner/name]
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BATON_VERSION } from "../packages/protocol/src/version.ts"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const REPO = arg("--repo") ?? process.env.BATON_REPO ?? "batonsh/baton"
const V = BATON_VERSION
const OUT = "dist/release"
const NPM = "dist/npm"

/** target → npm os/cpu (+ libc) */
const TARGETS: Record<string, { os: string; cpu: string; libc?: string; exe?: string }> = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
  "linux-x64-musl": { os: "linux", cpu: "x64", libc: "musl" },
  "windows-x64": { os: "win32", cpu: "x64", exe: ".exe" },
}

const run = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" })
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${p.exitCode})`)
}
const sha256 = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex")

rmSync(OUT, { recursive: true, force: true })
rmSync(NPM, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const built: string[] = []
const sums: string[] = []
for (const [target, t] of Object.entries(TARGETS)) {
  const bin = `dist/baton-${target}${t.exe ?? ""}`
  if (!existsSync(bin)) {
    console.warn(`skip ${target}: ${bin} not built`)
    continue
  }
  built.push(target)
  // archive: a folder with the binary, the license and the readme
  const stage = join(OUT, `baton-${target}`)
  mkdirSync(stage, { recursive: true })
  copyFileSync(bin, join(stage, `baton${t.exe ?? ""}`))
  chmodSync(join(stage, `baton${t.exe ?? ""}`), 0o755)
  copyFileSync("LICENSE", join(stage, "LICENSE"))
  copyFileSync("README.md", join(stage, "README.md"))
  const archive = t.exe ? `baton-${target}.zip` : `baton-${target}.tar.gz`
  if (t.exe) run(["zip", "-qr", archive, `baton-${target}`], OUT)
  else run(["tar", "-czf", archive, `baton-${target}`], OUT)
  rmSync(stage, { recursive: true })
  sums.push(`${sha256(join(OUT, archive))}  ${archive}`)

  // npm platform package
  const name = `@batonsh/cli-${target}`
  const dir = join(NPM, `cli-${target}`)
  mkdirSync(join(dir, "bin"), { recursive: true })
  copyFileSync(bin, join(dir, "bin", `baton${t.exe ?? ""}`))
  chmodSync(join(dir, "bin", `baton${t.exe ?? ""}`), 0o755)
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: V,
        description: `Baton binary for ${target}`,
        license: "MIT",
        repository: { type: "git", url: `https://github.com/${REPO}` },
        os: [t.os],
        cpu: [t.cpu],
        ...(t.libc ? { libc: [t.libc] } : {}),
        files: ["bin"],
        preferUnplugged: true,
      },
      null,
      2,
    )}\n`,
  )
}
if (!built.length) throw new Error("no binaries in dist/ — run bun scripts/build.ts --all first")
writeFileSync(join(OUT, "SHA256SUMS"), `${sums.join("\n")}\n`)

// npm: the `batonsh` package picks the right platform package at run time
const main = join(NPM, "batonsh")
mkdirSync(join(main, "bin"), { recursive: true })
writeFileSync(
  join(main, "package.json"),
  `${JSON.stringify(
    {
      name: "batonsh",
      version: V,
      description: "One terminal for all your coding agents — Claude Code, Codex, OpenCode and more, working as a team",
      license: "MIT",
      homepage: `https://github.com/${REPO}`,
      repository: { type: "git", url: `https://github.com/${REPO}` },
      keywords: ["ai", "agents", "claude-code", "codex", "opencode", "tui", "multi-agent", "mcp", "acp", "a2a"],
      bin: { baton: "bin/baton.js" },
      files: ["bin", "README.md", "LICENSE"],
      engines: { node: ">=18" },
      optionalDependencies: Object.fromEntries(built.map((t) => [`@batonsh/cli-${t}`, V])),
    },
    null,
    2,
  )}\n`,
)
copyFileSync("README.md", join(main, "README.md"))
copyFileSync("LICENSE", join(main, "LICENSE"))
writeFileSync(
  join(main, "bin", "baton.js"),
  `#!/usr/bin/env node
// Runs the native baton binary from the platform package npm installed alongside this one.
"use strict"
const { spawnSync } = require("node:child_process")
const { platform, arch } = process
function musl() {
  if (platform !== "linux") return false
  try {
    return !process.report.getReport().header.glibcVersionRuntime
  } catch {
    return false
  }
}
const os = platform === "win32" ? "windows" : platform
const target = \`\${os}-\${arch}\${musl() ? "-musl" : ""}\`
let bin
try {
  bin = require.resolve(\`@batonsh/cli-\${target}/bin/baton\${platform === "win32" ? ".exe" : ""}\`)
} catch {
  console.error(\`baton: no prebuilt binary for \${target}. Supported: ${built.join(", ")}.\\nInstall from source: https://github.com/${REPO}#install\`)
  process.exit(1)
}
const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, BATON_INSTALL: "npm" } })
if (r.error) {
  console.error(\`baton: \${r.error.message}\`)
  process.exit(1)
}
if (r.signal) process.kill(process.pid, r.signal)
process.exit(r.status ?? 1)
`,
)
chmodSync(join(main, "bin", "baton.js"), 0o755)

// Homebrew formula (for the tap: <owner>/homebrew-tap, Formula/baton.rb)
const sumOf = (target: string) => sums.find((l) => l.endsWith(` baton-${target}.tar.gz`))?.split(" ")[0] ?? ""
const url = (target: string) => `https://github.com/${REPO}/releases/download/v${V}/baton-${target}.tar.gz`
const block = (target: string) => `      url "${url(target)}"\n      sha256 "${sumOf(target)}"`
writeFileSync(
  join(OUT, "baton.rb"),
  `class Baton < Formula
  desc "One terminal for all your coding agents, working as a team"
  homepage "https://github.com/${REPO}"
  version "${V}"
  license "MIT"

  on_macos do
    on_arm do
${block("darwin-arm64")}
    end
    on_intel do
${block("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${block("linux-arm64")}
    end
    on_intel do
${block("linux-x64")}
    end
  end

  def install
    bin.install "baton"
  end

  def caveats
    <<~EOS
      Baton runs the coding agents you already have (Claude Code, Codex, OpenCode, …).
      Check what it found with: baton doctor
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/baton --version")
  end
end
`,
)

console.log(`release ${V}: ${built.length} platforms → ${OUT} (archives, SHA256SUMS, baton.rb), ${NPM} (${built.length + 1} npm packages)`)
