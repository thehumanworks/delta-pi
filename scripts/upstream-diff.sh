#!/usr/bin/env bash
# Compare the delta-claude commit pinned in UPSTREAM with the head of its branch, and show what changed.
#
#   scripts/upstream-diff.sh                 report drift; write the full diff to .upstream/diff.patch
#   scripts/upstream-diff.sh --sync-fixtures also copy upstream's CLI fixtures over test/fixtures/cli
#
# Exit status: 0 when upstream is still at the pinned commit, 1 when it has moved, anything else on error.
# The clone lives in .upstream/ (ignored by Git) and is reused. Nothing here touches a Delta account.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
pin="$root/UPSTREAM"
cache="$root/.upstream"
clone="$cache/delta-claude"

read_pin() {
  local key=$1
  local value
  value=$(sed -n "s/^$key=//p" "$pin" | head -n 1)
  if [[ -z $value ]]; then
    echo "UPSTREAM has no $key" >&2
    exit 2
  fi
  printf '%s' "$value"
}

# The upstream repository is public: read it over HTTPS regardless of the user's URL rewrites.
upstream_git() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git "$@"
}

sync_fixtures=false
for argument in "$@"; do
  case $argument in
    --sync-fixtures) sync_fixtures=true ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

repository=$(read_pin repository)
branch=$(read_pin branch)
commit=$(read_pin commit)
version=$(read_pin version)

head=$(upstream_git ls-remote "$repository" "refs/heads/$branch" | cut -f1)
if [[ -z $head ]]; then
  echo "could not read $repository $branch" >&2
  exit 2
fi

mkdir -p "$cache"
if [[ -d $clone/.git ]]; then
  upstream_git -C "$clone" fetch -q origin "$branch"
else
  upstream_git clone -q "$repository" "$clone"
fi

if $sync_fixtures; then
  mkdir -p "$root/test/fixtures/cli"
  for file in "$clone"/hooks/testing/fixtures/cli/*; do
    cp "$file" "$root/test/fixtures/cli/$(basename "$file")"
  done
  echo "fixtures: copied upstream's hooks/testing/fixtures/cli at $head into test/fixtures/cli"
fi

if [[ $head == "$commit" ]]; then
  echo "up to date: $repository $branch is at the pinned commit $commit (plugin $version)"
  exit 0
fi

head_version=$(upstream_git -C "$clone" show "$head:.claude-plugin/plugin.json" | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p')
echo "upstream moved: $branch is at $head (plugin ${head_version:-unknown}); pinned $commit (plugin $version)"
echo
echo "commits:"
upstream_git -C "$clone" log --oneline "$commit..$head"
echo
echo "files:"
upstream_git -C "$clone" diff --stat "$commit" "$head"
echo
fixtures=$(upstream_git -C "$clone" diff --name-only "$commit" "$head" -- hooks/testing/fixtures/cli)
if [[ -n $fixtures ]]; then
  echo "CLI fixtures changed (run with --sync-fixtures to copy them):"
  echo "$fixtures"
  echo
fi
notes=$(upstream_git -C "$clone" diff --name-only --diff-filter=A "$commit" "$head" -- release-notes)
if [[ -n $notes ]]; then
  echo "release notes added:"
  echo "$notes"
  echo
fi
upstream_git -C "$clone" diff "$commit" "$head" >"$cache/diff.patch"
echo "full diff: $cache/diff.patch"
echo "clone: $clone (checkout $commit or $head there to read either side)"
exit 1
