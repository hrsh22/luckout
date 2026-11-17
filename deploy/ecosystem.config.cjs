// pm2 config for the VM (see deploy/README.md). Start from the repo root: pm2 start deploy/ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "luckout-api",
    cwd: `${__dirname}/../apps/server`,
    // Run node directly so pm2 doesn't pick an interpreter from the .ts extension.
    script: "node",
    args: "--env-file=../../.env src/main.ts",
    interpreter: "none",
    // Exactly one process: Telegram long polling, pending confirmations, rate limits and
    // the operator's transaction nonce all live in this process.
    instances: 1,
    exec_mode: "fork",
    env: { HOST: "127.0.0.1" },
    max_memory_restart: "512M",
    // On stop or reload, purchases in progress finish first (each takes seconds, at worst a
    // few minutes); pm2 must not kill the process mid-purchase.
    kill_timeout: 180000,
    // A server that dies while starting (a failed migration, a bad .env) is started again after 1 s, then
    // 1.5 s, 2.25 s and so on up to 15 s (pm2's ceiling), not at once in a tight loop that can call Telegram,
    // Bitrefill and NEAR each time and fills the log. pm2 resets the delay once the server stays up 30 s.
    // No max_restarts: after a reboot Postgres can come up after the server, and a pm2 that had given up
    // would leave the site down until someone noticed.
    exp_backoff_restart_delay: 1000
  }]
}
