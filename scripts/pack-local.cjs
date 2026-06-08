#!/usr/bin/env node

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const packageRoot = path.resolve(__dirname, "..")
const args = new Set(process.argv.slice(2))
const outDirArg = getArgValue("--out-dir")
const outDir = path.resolve(outDirArg || fs.mkdtempSync(path.join(os.tmpdir(), "ast-lsp-pack-")))
const shouldBuild = !args.has("--no-build")
const json = args.has("--json")

if (shouldBuild) {
  run("bun", ["run", "build"], packageRoot, "build package")
}

fs.mkdirSync(outDir, { recursive: true })

const packageJson = readJson(path.join(packageRoot, "package.json"))
const pack = run("npm", ["pack", packageRoot, "--pack-destination", outDir, "--json"], outDir, "pack package")
const records = JSON.parse(pack.stdout)
const filename = records[0] && records[0].filename
if (!filename) {
  throw new Error(`npm pack did not report a tarball filename:\n${pack.stdout}`)
}

const tarballPath = path.join(outDir, filename)
if (!fs.existsSync(tarballPath)) {
  throw new Error(`Packed tarball not found: ${tarballPath}`)
}

const result = {
  tarballPath,
  packageName: packageJson.name,
  version: packageJson.version,
}

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} else {
  process.stdout.write(`${tarballPath}\n`)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"))
}

function run(command, commandArgs, cwd, action) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf-8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      npm_config_registry: process.env.npm_config_registry || "https://registry.npmjs.org/",
    },
  })
  if (result.status === 0) return { stdout: result.stdout || "" }
  throw new Error(`Failed to ${action}:\n${result.stderr || result.stdout}`)
}

function getArgValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  return process.argv[index + 1]
}
