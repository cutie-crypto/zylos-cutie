import fs from 'node:fs';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { CONFIG_FILE, LOGS_DIR } from './paths.js';
import { deleteConfig } from './config.js';
import { COMPONENT_VERSION } from './version.js';
const EXIT_AFTER_SENT_MS = 500;
const SECRET_PATTERNS = [
    /(connector_token["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
    /(pair_token["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
    /(Authorization:\s*Bearer\s+)[^\s]+/gi,
    /(api[_-]?key["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
    /(OPENAI_API_KEY\s*=\s*)[^\s]+/g,
    /(CODEX_API_KEY\s*=\s*)[^\s]+/g,
];
export function redact(value) {
    return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '$1[REDACTED]'), value);
}
function isSemver(value) {
    return /^\d+\.\d+\.\d+$/.test(value);
}
function commandVersion(command) {
    const payloadVersion = command.payload?.['version'];
    return String(command.requested_version || payloadVersion || 'latest');
}
function execText(command) {
    try {
        return execSync(command, { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
    }
    catch {
        return '';
    }
}
export class ZylosMaintenanceExecutor {
    config;
    connectorVersion;
    exit;
    constructor(deps) {
        this.config = deps.config;
        this.connectorVersion = deps.connectorVersion;
        this.exit = deps.exit ?? ((code) => process.exit(code));
    }
    async execute(command, report) {
        switch (command.command_type) {
            case 'diagnose':
                await report({ status: 'preflight_ok' });
                await report({ status: 'executing' });
                return this.diagnose(Boolean(command.payload?.['include_logs_tail']));
            case 'self_reinstall':
                return this.reinstall(command, report, false);
            case 'rollback':
                return this.reinstall(command, report, true);
            case 'restart':
                return this.restart(report);
            case 'reset_config':
                return this.resetConfig(command, report);
            default:
                throw new Error(`unknown maintenance command: ${command.command_type}`);
        }
    }
    diagnose(includeLogsTail) {
        const pm2Status = execText('pm2 describe zylos-cutie --silent 2>/dev/null');
        const zylosList = execText('zylos list --json 2>/dev/null');
        let logsTail = [];
        if (includeLogsTail) {
            const logPath = `${LOGS_DIR}/out.log`;
            if (fs.existsSync(logPath)) {
                const lines = fs.readFileSync(logPath, 'utf-8').split('\n').slice(-20);
                logsTail = lines.map((line) => redact(line)).filter(Boolean);
            }
        }
        return {
            connector_version: this.connectorVersion,
            component_version: COMPONENT_VERSION,
            node_version: process.version,
            os: os.platform(),
            arch: os.arch(),
            config: {
                has_connector_id: Boolean(this.config.connector_id),
                has_connector_token: Boolean(this.config.connector_token),
                server_url: this.config.server_url,
            },
            runtime: {
                manager: 'pm2',
                pm2_status: pm2Status ? 'available' : 'unavailable',
                zylos_components: zylosList || 'unavailable',
            },
            logs_tail: logsTail,
        };
    }
    async reinstall(command, report, rollback) {
        const version = commandVersion(command);
        if (rollback && !isSemver(version)) {
            throw new Error('rollback version must be semver');
        }
        if (!rollback && version !== 'latest' && !isSemver(version)) {
            throw new Error('self_reinstall version must be latest or semver');
        }
        await report({ status: 'preflight_ok', result: { version } });
        await report({ status: 'executing', result: { version } });
        // Report success BEFORE spawning — zylos CLI step [1/8] stop_service will
        // pm2 stop this process, so status must be reported while WS is still alive.
        const delivery = await report({
            status: 'success',
            result: { version, install_method: 'zylos_upgrade', restart_scheduled: true },
        });
        await this.scheduleExitAfterAck(delivery);
        // Spawn detached: survives parent being killed by zylos stop_service.
        const zylosArgs = ['upgrade', 'cutie', '--yes', '--skip-eval', '--json'];
        if (version !== 'latest') {
            zylosArgs.push('--version', version);
        }
        const child = spawn('zylos', zylosArgs, {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, CUTIE_SELF_UPGRADE: '1' },
        });
        child.unref();
    }
    async restart(report) {
        await report({ status: 'preflight_ok', result: { autostart: 'pm2' } });
        await report({ status: 'executing' });
        const delivery = await report({ status: 'success', result: { restart_scheduled: true } });
        await this.scheduleExitAfterAck(delivery);
    }
    async resetConfig(command, report) {
        if (!fs.existsSync(CONFIG_FILE)) {
            throw new Error('connector config file does not exist');
        }
        await report({ status: 'preflight_ok', result: { config_path: CONFIG_FILE } });
        await report({ status: 'executing' });
        const revokeToken = Boolean(command.payload?.['revoke_token']);
        const delivery = await report({
            status: 'success',
            result: { config_deleted: true, restart_required: true, revoke_token: revokeToken },
        });
        const delay = await this.exitDelayAfterAck(delivery);
        setTimeout(() => {
            deleteConfig();
            this.exit(0);
        }, delay);
    }
    async scheduleExitAfterAck(delivery) {
        const delay = await this.exitDelayAfterAck(delivery);
        setTimeout(() => this.exit(0), delay);
    }
    async exitDelayAfterAck(delivery) {
        const ack = await delivery.ack;
        if (ack === 'acked' || ack === 'timeout') {
            return EXIT_AFTER_SENT_MS;
        }
        throw new Error(`maintenance terminal status was not acknowledged by server: ${ack.replace('_', ' ')}`);
    }
}
//# sourceMappingURL=maintenance.js.map