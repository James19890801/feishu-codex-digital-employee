#!/usr/bin/env bash
set -euo pipefail

# Certbot executes this only after a successful renewal.
[[ "${RENEWED_LINEAGE:-}" == /etc/letsencrypt/live/wxrelay.e2eskill.cn ]] || exit 0
nginx -t
systemctl reload nginx
