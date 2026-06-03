import type { MaintenanceCommand, MaintenanceReport, MaintenanceReportDelivery, CoreMaintenanceExecutor } from '@cutie-crypto/connector-core';
export interface ZylosMaintenanceExecutorDeps {
    config: {
        server_url: string;
        connector_id?: string;
        connector_token?: string;
    };
    connectorVersion: string;
    exit?: (code: number) => never | void;
}
export declare function redact(value: string): string;
export declare class ZylosMaintenanceExecutor implements CoreMaintenanceExecutor {
    private config;
    private connectorVersion;
    private exit;
    constructor(deps: ZylosMaintenanceExecutorDeps);
    execute(command: MaintenanceCommand, report: (report: MaintenanceReport) => MaintenanceReportDelivery | Promise<MaintenanceReportDelivery>): Promise<Record<string, unknown> | void>;
    private diagnose;
    private reinstall;
    private restart;
    private resetConfig;
    private scheduleExitAfterAck;
    private exitDelayAfterAck;
}
//# sourceMappingURL=maintenance.d.ts.map