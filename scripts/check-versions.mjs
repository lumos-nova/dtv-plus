/**
 * 校验所有随构建发布的版本号与唯一来源 `build/config.yml` 的 `info.version` 一致。
 *
 * 这个脚本只读、不写文件，CI 与本地都可运行：
 *   node scripts/check-versions.mjs
 *
 * 涉及的地方：
 *   - frontend/package.json（前端包版本，展示/依赖管理）
 *   - build/windows/info.json（PE 版本资源，由 sync-info-version.mjs 同步）
 *   - build/darwin/Info.plist / Info.dev.plist（macOS 构建直接拷贝，CI 也会再同步一次）
 *   - CHANGELOG.md 顶部的当前版本说明
 *
 * 不检查 build/windows/msix/*.xml：那是 Wails MSIX 工具的模板，
 * wails3 tool msix 会用 config.yml 覆盖其中的 Version，不属于发布版本来源。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");

function appVersion() {
  const yaml = read("build/config.yml");
  const infoBlock = yaml.split(/^info:/m)[1] ?? "";
  const version = infoBlock.match(/^\s+version:\s*["']?([^"'\s#]+)["']?/m)?.[1];
  if (!version) {
    console.error("[check:versions] 无法从 build/config.yml 的 info.version 读取版本号");
    process.exit(1);
  }
  if (!/^\d+(\.\d+){1,3}$/.test(version)) {
    console.error(`[check:versions] 版本号 "${version}" 不是点分数字`);
    process.exit(1);
  }
  return version;
}

function plistValue(text, key) {
  return text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1]?.trim();
}

const version = appVersion();
const problems = [];

function expect(label, actual, wanted = version) {
  if (actual !== wanted) {
    problems.push(`${label}: 期望 ${wanted}，实际 ${actual ?? "<缺失>"}`);
  }
}

const frontendPackage = JSON.parse(read("frontend/package.json"));
expect("frontend/package.json version", frontendPackage.version);

const windowsInfo = JSON.parse(read("build/windows/info.json"));
expect("build/windows/info.json fixed.file_version", windowsInfo.fixed?.file_version);
expect("build/windows/info.json fixed.product_version", windowsInfo.fixed?.product_version);
for (const [locale, table] of Object.entries(windowsInfo.info ?? {})) {
  if (!table || typeof table !== "object") continue;
  expect(`build/windows/info.json info.${locale}.FileVersion`, table.FileVersion);
  expect(`build/windows/info.json info.${locale}.ProductVersion`, table.ProductVersion);
}

for (const plistPath of ["build/darwin/Info.plist", "build/darwin/Info.dev.plist"]) {
  const text = read(plistPath);
  expect(`${plistPath} CFBundleVersion`, plistValue(text, "CFBundleVersion"));
  expect(
    `${plistPath} CFBundleShortVersionString`,
    plistValue(text, "CFBundleShortVersionString"),
  );
}

const changelog = read("CHANGELOG.md");
const noteVersion = changelog.match(/^>\s*当前版本\s*\*\*([^*]+)\*\*/m)?.[1]?.trim();
expect("CHANGELOG.md 顶部当前版本", noteVersion);

if (problems.length > 0) {
  console.error(`[check:versions] 版本号不一致（唯一来源 ${version}）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[check:versions] 所有版本号一致：${version}`);
