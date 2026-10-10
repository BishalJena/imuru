<?php
// Registers the Helm-generated REST key for woo-mcp. WooCommerce stores the
// consumer key as an HMAC (wc_api_hash) and the secret in plain text, exactly
// as it does for keys created in wp-admin.
global $wpdb;

$ck   = getenv('WOO_CONSUMER_KEY');
$cs   = getenv('WOO_CONSUMER_SECRET');
$user = get_user_by('login', getenv('ADMIN_USER'));
if (!$ck || !$cs || !$user) {
    WP_CLI::error('missing consumer key, secret or admin user');
}

$table       = $wpdb->prefix . 'woocommerce_api_keys';
$description = 'woo-mcp (managed by Helm)';

$wpdb->delete($table, ['description' => $description]);
$wpdb->insert($table, [
    'user_id'         => $user->ID,
    'description'     => $description,
    'permissions'     => 'read_write',
    'consumer_key'    => wc_api_hash($ck),
    'consumer_secret' => $cs,
    'truncated_key'   => substr($ck, -7),
]);
WP_CLI::success('REST key registered for user ' . $user->user_login);
