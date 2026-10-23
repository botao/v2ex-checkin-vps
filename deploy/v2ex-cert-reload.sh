#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/v2ex.taotao.dev ]; then
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
fi
