#!/bin/sh
# Makes a fresh WordPress install shop-ready. Every step checks current state
# first, so the Job is safe to run on every install and upgrade.
set -eu

log() { echo "[bootstrap] $*"; }
wp() { command wp --path=/var/www/html "$@"; }

deadline=$(( $(date +%s) + WAIT_TIMEOUT_SECONDS ))
log "waiting for wp-config.php and the database"
until [ -f /var/www/html/wp-config.php ] && wp db query "SELECT 1" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "timed out after ${WAIT_TIMEOUT_SECONDS}s waiting for WordPress files and database"
    exit 1
  fi
  sleep 5
done

if wp core is-installed; then
  log "core already installed"
else
  log "installing core"
  wp core install --url="$SITE_URL" --title="$SITE_TITLE" \
    --admin_user="$ADMIN_USER" --admin_password="$ADMIN_PASSWORD" \
    --admin_email="$ADMIN_EMAIL" --skip-email
fi

current=$(wp plugin get woocommerce --field=version 2>/dev/null || true)
if [ "$current" = "$WOO_VERSION" ]; then
  log "woocommerce $WOO_VERSION already installed"
else
  log "installing woocommerce $WOO_VERSION (found: ${current:-none})"
  wp plugin install woocommerce --version="$WOO_VERSION" --force
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce

# /wp-json/ routes need pretty permalinks; --hard writes Apache's .htaccess.
wp rewrite structure '/%postname%/' --hard

wp option update blogname "$SITE_TITLE"
wp option update timezone_string "$STORE_TIMEZONE"
wp option update woocommerce_default_country "$STORE_COUNTRY"
wp option update woocommerce_currency "$STORE_CURRENCY"
# New stores start in "coming soon" mode, which hides the shop from logged-out shoppers.
wp option update woocommerce_coming_soon no
wp option update woocommerce_email_from_address "$ADMIN_EMAIL"
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_cod_settings --format=json \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}'

wp wc tool run install_pages --user="$ADMIN_USER" >/dev/null
log "store pages ensured"

# Products from values are reconciled by SKU: created when missing, name and
# price updated when they differ, so upgrades and rollbacks reach them too.
# wp reads from /dev/null so it cannot consume the loop's input.
while IFS='|' read -r sku price name; do
  [ -n "$sku" ] || continue
  current=$(wp wc product list --sku="$sku" --user="$ADMIN_USER" --fields=id,name,regular_price --format=csv </dev/null | tail -n +2 | head -1)
  if [ -z "$current" ]; then
    wp wc product create --user="$ADMIN_USER" --name="$name" --sku="$sku" \
      --regular_price="$price" --status=publish </dev/null >/dev/null
    log "product $sku created"
    continue
  fi
  id=${current%%,*}
  if [ "$current" = "$id,$name,$price" ] || [ "$current" = "$id,\"$name\",$price" ]; then
    log "product $sku up to date"
  else
    wp wc product update "$id" --user="$ADMIN_USER" --name="$name" --regular_price="$price" </dev/null >/dev/null
    log "product $sku updated"
  fi
done < /bootstrap/products.txt

wp eval-file /bootstrap/rest-key.php
wp cache flush >/dev/null 2>&1 || true
log "done"
