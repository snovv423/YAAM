# YAAM hqtest media off-site backup and restore

## Safety contract

- Bucket: `yaam-backups-s4mur4-20260813`, private STANDARD, maximum 1 GB.
- Real objects: `hqtest/media/YYYY/MM/DD/`; lifecycle expiration after 35 days.
- Synthetic objects: `hqtest/synthetic/<test-id>/`.
- The uploader never uses `sync`, `--delete`, or any object-delete API.
- The service account has only `PutObject` and `GetObject` on the allowed prefixes.
- A remote failure never removes the local archive.
- The timer must remain disabled until the first real upload is separately approved.

## Installation

```sh
sudo install -o root -g root -m 0750 server/deploy/yaam-media-offsite-backup \
  /usr/local/sbin/yaam-media-offsite-backup
sudo install -o root -g root -m 0644 server/deploy/yaam-media-offsite-backup-hqtest.service \
  /etc/systemd/system/yaam-media-offsite-backup-hqtest.service
sudo install -o root -g root -m 0644 server/deploy/yaam-media-offsite-backup-hqtest.timer \
  /etc/systemd/system/yaam-media-offsite-backup-hqtest.timer
sudo systemctl daemon-reload
sudo systemctl disable yaam-media-offsite-backup-hqtest.timer
```

Credentials live only in `/etc/yaam/media-offsite-backup.env` with owner
`root:root` and mode `0600`.

## Manual restore verification

Use a root-only temporary directory. Never restore directly over live media.

```sh
sudo -i
set -a; . /etc/yaam/media-offsite-backup.env; set +a
tmp=$(mktemp -d /var/lib/yaam/media-offsite-restore.XXXXXXXX)
trap 'rm -rf -- "$tmp"' EXIT
key='hqtest/media/YYYY/MM/DD/yaam_media_hqtest_TIMESTAMP.tar.gz'
aws --endpoint-url https://storage.yandexcloud.net s3api get-object \
  --bucket "$S3_BUCKET" --key "$key" "$tmp/archive.tar.gz"
aws --endpoint-url https://storage.yandexcloud.net s3api get-object \
  --bucket "$S3_BUCKET" --key "${key}.sha256" "$tmp/archive.tar.gz.sha256"
sed -i 's#  .*#  archive.tar.gz#' "$tmp/archive.tar.gz.sha256"
(cd "$tmp" && sha256sum -c archive.tar.gz.sha256)
mkdir "$tmp/extracted"
tar -xzf "$tmp/archive.tar.gz" -C "$tmp/extracted"
find "$tmp/extracted" -maxdepth 3 -type f -print
```

Only after inspection and a separate change window may files be copied into
`/opt/yaam-hqtest/media`. This runbook does not stop services or modify live media.
