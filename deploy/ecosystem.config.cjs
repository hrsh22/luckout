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
    kill_timeout: 180000
  }]
}
