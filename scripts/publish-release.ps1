param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string[]]$Assets
)

# Publish a GitHub Release with the GitHub CLI instead of softprops/action-gh-release.
#
# Why: the Windows and macOS workflows are both triggered by the same tag. When
# both call "create release" at the same time, GitHub may answer HTTP 500; the
# API also has occasional 5xx blips. This script checks for an existing release
# first (upload assets there instead), retries with exponential backoff, and
# drops auto-generated release notes after 3 failed attempts. A final failure is
# only a warning: installers remain available as Actions artifacts.

$ErrorActionPreference = "Continue"
$files = @($Assets | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($files.Count -eq 0) {
    Write-Warning "No release assets found; skipping GitHub Release"
    exit 0
}

function Publish-Once {
    param([bool]$WithNotes)

    # The other workflow may have created the release already; just upload.
    $null = & gh release view $Tag --json tagName 2>$null
    if ($LASTEXITCODE -eq 0) {
        & gh release upload $Tag @files --clobber
        return $LASTEXITCODE
    }

    if ($WithNotes) {
        & gh release create $Tag @files --title "DTV $Version" --generate-notes --verify-tag
    } else {
        & gh release create $Tag @files --title "DTV $Version" --notes "DTV $Version" --verify-tag
    }
    return $LASTEXITCODE
}

for ($attempt = 1; $attempt -le 5; $attempt++) {
    $withNotes = $attempt -le 3
    try {
        $code = Publish-Once -WithNotes $withNotes
        if ($code -eq 0) {
            Write-Host "GitHub Release published: $Tag"
            exit 0
        }
        throw "gh exited with code $code"
    } catch {
        Write-Warning "Release attempt $attempt/5 failed: $($_.Exception.Message)"
        if ($attempt -lt 5) {
            $delay = [math]::Min(30, 5 * [math]::Pow(2, $attempt - 1))
            Start-Sleep -Seconds $delay
        }
    }
}

Write-Warning "GitHub Release not published; installers are still available as Actions artifacts"
exit 0
