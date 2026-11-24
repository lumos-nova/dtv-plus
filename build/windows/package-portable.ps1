# 打 Windows 便携版 zip：dtv.exe + README.txt，解压即用，无需安装。
#
# 由 `wails3 task windows:package:portable` 调用（先构建/签名，再执行本脚本），
# 也可以对已构建好的 bin\dtv.exe 手动运行：
#   powershell -File build/windows/package-portable.ps1
#
# 数据目录说明：应用会把配置/WebView2 存储写到 exe 同级的 data\ 目录
# （见 internal/appdirs/portable.go），所以 zip 里不需要预建任何目录。
param(
    [string]$ExePath = "bin/dtv.exe",
    [string]$OutDir = "bin",
    [string]$Arch = "amd64"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ExePath)) {
    throw "找不到 $ExePath，请先运行 wails3 build"
}

# 版本号唯一来源是 build/config.yml 的 info.version（与 sync-info-version.mjs 同款解析）
$config = Get-Content "build/config.yml" -Raw
if ($config -match '(?ms)^info:.*?^\s+version:\s*["'']?([0-9][0-9.]+)["'']?') {
    $version = $Matches[1]
} else {
    throw "没能从 build/config.yml 读到 info.version"
}

$archLabel = if ($Arch -eq "arm64") { "arm64" } else { "x64" }
$zipName = "DTV-$version-win-$archLabel-portable.zip"
$staging = Join-Path $OutDir "portable-staging"

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

Copy-Item $ExePath (Join-Path $staging "dtv.exe")

$readme = @"
DTV v$version 便携版（Windows $archLabel）
==========================================

使用方法
--------
1. 把本压缩包解压到任意可写目录（如 D:\Tools\DTV）。
2. 双击 dtv.exe 即可运行，无需安装。

运行环境
--------
- 需要 Microsoft Edge WebView2 运行时。Windows 11 和更新过的
  Windows 10 已自带；若启动报错或白屏，请从微软官方下载安装：
  https://developer.microsoft.com/microsoft-edge/webview2/
  （选择「常青版引导程序 / Evergreen Bootstrapper」）

数据存放
--------
- 所有数据（配置、登录状态、图片缓存、日志、录像）都保存在
  dtv.exe 同级的 data\ 目录中，不占用 C 盘用户目录。
- 迁移/备份：整个文件夹一起拷走即可。
- 若 exe 所在目录不可写（例如放在 Program Files 且无管理员权限），
  应用会自动回退到 %APPDATA%\DTV 与 %LOCALAPPDATA%\DTV 存放数据。
- 首次运行时，若检测到旧版本存放在 %APPDATA%\DTV 的配置和登录
  数据，会自动复制一份到 data\ 目录（旧数据保留不删除）。
"@
# 带 BOM 的 UTF-8，保证老版记事本也能正确显示中文
[System.IO.File]::WriteAllText((Join-Path $staging "README.txt"), $readme, (New-Object System.Text.UTF8Encoding $true))

$zipPath = Join-Path $OutDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath
Remove-Item $staging -Recurse -Force

$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "[portable] $zipPath ($sizeMB MB)"