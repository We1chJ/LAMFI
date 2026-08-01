/**
 * Template for config.local.js.
 *
 *   cp config.example.js config.local.js
 *
 * then fill in your values. config.local.js is gitignored; this file is not,
 * so never put real credentials here.
 *
 * If you'd rather not keep a credentials file at all, delete
 * "config.local.js" from manifest.json and configure from the DevTools
 * console instead:
 *   LamfiSync.configure("<worker-url>", "<token>")
 */
const LAMFI_CONFIG = {
  url: "https://connection-stats.YOUR-SUBDOMAIN.workers.dev",
  token: "YOUR_TOKEN",
};
