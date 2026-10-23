# Podman VPS Deployment

The Quadlet unit in this directory runs the application as a system service on
Podman 5. It uses `/opt/v2ex-checkin-vps/.env`, the named volume
`v2ex-checkin-data`, and the loopback address `127.0.0.1:3001`.

```bash
cd /opt/v2ex-checkin-vps
node scripts/setup.mjs
podman build -t localhost/v2ex-checkin-vps:local .
install -m 0644 deploy/v2ex-checkin.container /etc/containers/systemd/v2ex-checkin.container
systemctl daemon-reload
systemctl start v2ex-checkin.service
```

The `[Install]` section of the Quadlet unit adds the generated service to
`multi-user.target` at boot. Do not run `systemctl enable` on a generated unit.

Checks:

```bash
systemctl status v2ex-checkin.service
systemctl list-dependencies multi-user.target | grep v2ex-checkin
curl --fail http://127.0.0.1:3001/health
podman exec v2ex-checkin-vps npm run doctor
journalctl -u v2ex-checkin.service -n 50 --no-pager
```

Update the image, then run `systemctl restart v2ex-checkin.service`.
The container is replaced while the named data volume and `.env` remain intact.
The application waits up to 75 seconds for active check-ins to finish when
stopping. Podman's 90-second stop timeout allows that drain to complete.
Back up the volume's encrypted `store.enc` together with `.env`.

Without a domain and HTTPS reverse proxy, access the admin UI through an SSH
tunnel bound to your local machine only:

```bash
ssh -N -L 127.0.0.1:39873:127.0.0.1:3001 root@62.72.46.207
```

Open `http://localhost:39873` in Chrome. Retrieve the generated admin password
from `/opt/v2ex-checkin-vps/.env` over SSH. The service's container port is not
published to the public network.

## HTTPS With Cloudflare Proxy

`nginx-v2ex-acme.conf` bootstraps HTTP-01 certificate validation for
`v2ex.taotao.dev`. It serves only the ACME challenge directory; other requests
are unavailable until HTTPS is installed. Use `/var/lib/v2ex-acme` as Certbot's
webroot. On SELinux hosts label that directory `httpd_sys_content_t` with a
persistent `semanage fcontext` rule and `restorecon`.

After issuing the certificate, install `nginx-v2ex.conf` as
`/etc/nginx/conf.d/v2ex-checkin.conf`. Run `nginx -t` before reloading. It proxies
HTTPS to the existing loopback-only application and redirects HTTP to HTTPS,
except for ACME challenges. It replaces forwarded client headers instead of
trusting arbitrary incoming values. Behind Cloudflare the rate limiter sees
the edge proxy IP, so some visitors can share a login attempt limit.

Cloudflare orange-cloud proxying can remain enabled. Set SSL to **Full (strict)**
for this hostname using a Configuration Rule matching
`http.host eq "v2ex.taotao.dev"`. Do not change the zone-wide SSL mode without
checking other subdomains. Flexible mode causes a redirect loop with this
configuration; never work around it by sending admin credentials over HTTP.
Bypass caching for the admin hostname and do not enable a Cache Everything rule.

Install `v2ex-cert-reload.sh` as an executable in
`/etc/letsencrypt/renewal-hooks/deploy/` and enable `certbot-renew.timer`. The hook
reloads Nginx only after this certificate renews and the configuration validates.
Verify renewal with `certbot renew --cert-name v2ex.taotao.dev --dry-run`.
Nginx configuration before domain setup is backed up under
`/var/backups/v2ex-checkin/nginx-before-domain-20261023` on this VPS.

## Daily Backups

The backup service and timer target this VPS's rootful Podman volume location
and a private copy of the installed Node.js 22 runtime under
`/usr/local/libexec/v2ex-checkin/node`. Adjust `ExecStart` when using another host.
Build with `npm run build`, or deploy the compiled `backup.js` and `security.js`
to `/opt/v2ex-checkin-vps/dist/src/`. The backup tool uses only Node built-ins.

```bash
install -d -m 0700 /var/backups/v2ex-checkin
install -d -m 0755 /usr/local/libexec/v2ex-checkin
install -m 0755 /root/.nvm/versions/node/v22.22.1/bin/node /usr/local/libexec/v2ex-checkin/node
restorecon -RF /usr/local/libexec/v2ex-checkin
install -m 0644 deploy/v2ex-checkin-backup.service deploy/v2ex-checkin-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now v2ex-checkin-backup.timer
systemctl start v2ex-checkin-backup.service
systemctl list-timers v2ex-checkin-backup.timer
journalctl -u v2ex-checkin-backup.service -n 10 --no-pager
```

Backups run at 03:30 Asia/Hong_Kong, with a catch-up run after downtime. The
latest 14 snapshots are retained. Creation verifies that the encrypted store can
be decrypted by the matching `.env` before saving and pruning. Failed backups
do not prune older copies. The backup directory is `0700` and files are `0600`.

**A backup contains the raw `.env`, including the password and encryption key.**
Treat the entire `.backup` file as a secret, not as an encrypted archive. Never
commit or publicly share it. These are same-host backups, not protection against
loss of the whole VPS; copy them off-host only through a secure private channel.

Verify or restore to a new private directory without changing the live service:

```bash
NODE=/usr/local/libexec/v2ex-checkin/node
"$NODE" /opt/v2ex-checkin-vps/dist/src/backup.js verify /var/backups/v2ex-checkin/<snapshot>.backup
"$NODE" /opt/v2ex-checkin-vps/dist/src/backup.js restore /var/backups/v2ex-checkin/<snapshot>.backup /root/v2ex-restore-new
```

Restoration refuses any existing destination. The restored `.env` and
`store.enc` are a matched pair. To apply a restore, stop the live service first,
preserve its current files separately, and install the pair with appropriate
ownership for the container's `pwuser`. Do not replace only one of the two files.
Update the private Node runtime copy when upgrading the host's Node.js version.
