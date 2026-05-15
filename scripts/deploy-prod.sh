#!/usr/bin/env bash
# Прод на Vercel (тот же проект, что photoedit-portrait.vercel.app)
set -euo pipefail
cd "$(dirname "$0")/.."
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/tmp/npm-cache-photoedit}"
exec npx --yes vercel@latest deploy --prod --yes
