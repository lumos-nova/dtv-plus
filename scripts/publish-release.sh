#!/usr/bin/env bash
# Publish a GitHub Release with the GitHub CLI (mirrors publish-release.ps1).
#
# 1. Find or create the release; re-check after a failed create because the
#    other platform workflow may have created it concurrently.
# 2. Upload assets ONE BY ONE, each with its own retry loop. Delete a stale
#    same-named asset first (clobber alone is unreliable under 5xx / races).
#    A failure on one asset never blocks the remaining assets.
# 3. Force the release out of draft state (gh release edit --draft=false).
# 4. Verify every expected asset is present; any missing asset or draft state
#    fails the job with an ::error:: annotation (no false green CI).
set -uo pipefail

TAG="$1"
VERSION="$2"
shift 2

FILES=()
for asset in "$@"; do
  [ -e "$asset" ] && FILES+=("$asset")
done
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "::warning::没有可发布的产物，跳过 Release"
  exit 0
fi

MAX_ATTEMPTS=5

backoff() {
  local attempt="$1" message="$2"
  echo "::warning::$message"
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    local delay=$((5 * 2 ** (attempt - 1)))
    [ "$delay" -gt 30 ] && delay=30
    sleep "$delay"
  fi
}

release_exists() {
  gh release view "$TAG" --json tagName >/dev/null 2>&1
}

asset_names() {
  gh release view "$TAG" --json assets --jq '.assets[].name' 2>/dev/null || true
}

# --- 1. Ensure release exists -------------------------------------------------
release_ready=0
for attempt in 1 2 3 4 5; do
  if release_exists; then release_ready=1; break; fi
  if [ "$attempt" -le 3 ]; then
    gh release create "$TAG" --title "DTV $VERSION" --generate-notes --verify-tag >/dev/null 2>&1
  else
    gh release create "$TAG" --title "DTV $VERSION" --notes "DTV $VERSION" --verify-tag >/dev/null 2>&1
  fi
  if [ $? -eq 0 ]; then release_ready=1; break; fi
  # The other workflow might have won the race; re-check before retrying.
  if release_exists; then release_ready=1; break; fi
  backoff "$attempt" "确保 Release 存在失败（第 $attempt/$MAX_ATTEMPTS 次）"
done
if [ "$release_ready" -ne 1 ]; then
  echo "::error::无法创建或找到 GitHub Release：$TAG"
  exit 1
fi

# --- 2. Per-asset upload with per-asset retry ---------------------------------
failed=0
for file in "${FILES[@]}"; do
  name=$(basename "$file")
  uploaded=0
  for attempt in 1 2 3 4 5; do
    if asset_names | grep -Fxq "$name"; then
      if ! gh release delete-asset "$TAG" "$name" --yes >/dev/null 2>&1; then
        backoff "$attempt" "删除同名资产 $name 失败（第 $attempt/$MAX_ATTEMPTS 次）"
        continue
      fi
    fi
    if gh release upload "$TAG" "$file" >/dev/null 2>&1; then
      echo "已上传资产：$name"
      uploaded=1
      break
    fi
    backoff "$attempt" "上传 $name 失败（第 $attempt/$MAX_ATTEMPTS 次）"
  done
  if [ "$uploaded" -ne 1 ]; then
    echo "::error::资产上传失败：$name"
    failed=1
  fi
done

# --- 3. Ensure release is published (not a draft) -----------------------------
published=0
for attempt in 1 2 3 4 5; do
  if gh release edit "$TAG" --draft=false >/dev/null 2>&1; then
    draft=$(gh release view "$TAG" --json isDraft --jq .isDraft 2>/dev/null)
    if [ "$draft" = "false" ]; then published=1; break; fi
  fi
  backoff "$attempt" "发布 Release 失败（第 $attempt/$MAX_ATTEMPTS 次）"
done
if [ "$published" -ne 1 ]; then
  echo "::error::Release $TAG 仍是草稿"
  failed=1
fi

# --- 4. Post-publish verification ---------------------------------------------
final_names=$(asset_names)
for file in "${FILES[@]}"; do
  name=$(basename "$file")
  if ! printf '%s\n' "$final_names" | grep -Fxq "$name"; then
    echo "::error::发布后校验失败，缺少资产：$name"
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  echo "::error::GitHub Release $TAG 不完整，详见上方失败项"
  exit 1
fi

echo "GitHub Release 已发布并校验通过：$TAG（${#FILES[@]} 个资产）"
exit 0
