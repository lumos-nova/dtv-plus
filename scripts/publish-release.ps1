param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string[]]$Assets
)

# Publish a GitHub Release with the GitHub CLI.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#
# Behaviour (mirrored in publish-release.sh):
#   1. Find or create the release; re-check after a failed create because the
#      other platform workflow may have created it concurrently.
#   2. Upload assets ONE BY ONE, each with its own retry loop. Delete a stale
#      same-named asset first (clobber alone is unreliable under 5xx / races).
#      A failure on one asset never blocks the remaining assets.
#   3. Force the release out of draft state (gh release edit --draft=false).
#   4. Verify every expected asset is present; any missing asset or draft state
#      fails the job with an ::error:: annotation (no false green CI).

$ErrorActionPreference = "Continue"
$MaxAttempts = 5
$files = @($Assets | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($files.Count -eq 0) {
    Write-Warning "No release assets found; skipping GitHub Release"
    exit 0
}

function Get-BackoffSeconds {
    param([int]$Attempt)
    return [math]::Min(30, 5 * [math]::Pow(2, $Attempt - 1))
}

function Invoke-Backoff {
    param([int]$Attempt, [string]$Message)
    Write-Warning $Message
    if ($Attempt -lt $MaxAttempts) {
        Start-Sleep -Seconds (Get-BackoffSeconds -Attempt $Attempt)
    }
}

function Test-ReleaseExists {
    $null = & gh release view $Tag --json tagName 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Get-AssetNames {
    $names = @(& gh release view $Tag --json assets --jq '.assets[].name' 2>$null)
    return @($names | Where-Object { $_ })
}

# --- 1. Ensure release exists -------------------------------------------------
$releaseReady = $false
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (Test-ReleaseExists) { $releaseReady = $true; break }

    if ($attempt -le 3) {
        & gh release create $Tag --title "DTV $Version" --generate-notes --verify-tag 2>$null
    } else {
        & gh release create $Tag --title "DTV $Version" --notes "DTV $Version" --verify-tag 2>$null
    }
    if ($LASTEXITCODE -eq 0) { $releaseReady = $true; break }

    # The other workflow might have won the race; re-check before retrying.
    if (Test-ReleaseExists) { $releaseReady = $true; break }
    Invoke-Backoff -Attempt $attempt -Message "Ensure release attempt $attempt/$MaxAttempts failed"
}
if (-not $releaseReady) {
    Write-Host "::error::Cannot create or find GitHub Release for $Tag"
    exit 1
}

# --- 2. Per-asset upload with per-asset retry ---------------------------------
$failed = $false
foreach ($file in $files) {
    $name = [System.IO.Path]::GetFileName($file)
    $uploaded = $false
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        if ((Get-AssetNames) -contains $name) {
            & gh release delete-asset $Tag $name --yes 2>$null
            if ($LASTEXITCODE -ne 0) {
                Invoke-Backoff -Attempt $attempt -Message "Cannot remove stale asset $name (attempt $attempt/$MaxAttempts)"
                continue
            }
        }
        & gh release upload $Tag $file 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Uploaded asset: $name"
            $uploaded = $true
            break
        }
        Invoke-Backoff -Attempt $attempt -Message "Upload $name failed (attempt $attempt/$MaxAttempts)"
    }
    if (-not $uploaded) {
        Write-Host "::error::Asset upload failed: $name"
        $failed = $true
    }
}

# --- 3. Ensure release is published (not a draft) -----------------------------
$published = $false
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    & gh release edit $Tag --draft=false 2>$null
    if ($LASTEXITCODE -eq 0) {
        $isDraft = (& gh release view $Tag --json isDraft --jq .isDraft 2>$null | Out-String).Trim()
        if ($isDraft -eq "false") { $published = $true; break }
    }
    Invoke-Backoff -Attempt $attempt -Message "Publish release attempt $attempt/$MaxAttempts failed"
}
if (-not $published) {
    Write-Host "::error::Release $Tag is still a draft"
    $failed = $true
}

# --- 4. Post-publish verification ---------------------------------------------
$finalNames = Get-AssetNames
foreach ($file in $files) {
    $name = [System.IO.Path]::GetFileName($file)
    if ($finalNames -notcontains $name) {
        Write-Host "::error::Release verification failed; missing asset: $name"
        $failed = $true
    }
}
if ($failed) {
    Write-Host "::error::GitHub Release for $Tag is incomplete; see failed assets above"
    exit 1
}

Write-Host "GitHub Release published and verified: $Tag ($($files.Count) assets)"
exit 0
