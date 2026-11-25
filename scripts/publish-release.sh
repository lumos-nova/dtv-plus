#!/usr/bin/env bash
# 用 GitHub CLI 发布 Release（与 publish-release.ps1 行为一致）。
#
# 处理两个问题：同一 tag 触发的 Windows / macOS 工作流并发创建 Release 时
# GitHub 返回 500，以及 GitHub API 偶发 5xx。先查已有 Release 再上传，
# 失败指数退避重试；第 4 次起跳过自动 release notes，最终失败只告警不失败构建。
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

publish_once() {
  local with_notes="$1"
  # 另一个工作流可能已建好 Release：补传资产即可。
  if gh release view "$TAG" --json tagName >/dev/null 2>&1; then
    gh release upload "$TAG" "${FILES[@]}" --clobber
    return $?
  fi
  if [ "$with_notes" = "1" ]; then
    gh release create "$TAG" "${FILES[@]}" --title "DTV $VERSION" --generate-notes --verify-tag
  else
    gh release create "$TAG" "${FILES[@]}" --title "DTV $VERSION" --notes "DTV $VERSION" --verify-tag
  fi
  return $?
}

for attempt in 1 2 3 4 5; do
  notes=1
  [ "$attempt" -gt 3 ] && notes=0
  if publish_once "$notes"; then
    echo "GitHub Release 已发布：$TAG"
    exit 0
  fi
  echo "::warning::发布失败（第 $attempt/5 次）"
  if [ "$attempt" -lt 5 ]; then
    delay=$((5 * 2 ** (attempt - 1)))
    [ "$delay" -gt 30 ] && delay=30
    sleep "$delay"
  fi
done

echo "::warning::GitHub Release 发布失败；安装包仍保留在 Actions 产物中，可稍后手动发布"
exit 0
