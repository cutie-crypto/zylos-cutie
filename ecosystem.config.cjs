const path = require('node:path');
const os = require('node:os');

module.exports = {
  apps: [{
    name: 'zylos-cutie',
    script: 'dist/index.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/cutie'),
    env: {
      NODE_ENV: 'production',
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/cutie/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/cutie/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
