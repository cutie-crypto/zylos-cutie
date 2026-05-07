/**
 * api — 调 Cutie Server 的 HTTP endpoint。
 *
 * **从 connector-core 复用 typed `register()`**——core 自己已经实现了完整的 form 字段
 * 组装（含 server 必填 `platform: os.platform()`、可选 `capabilities` JSON 编码、
 * `protocol_version` 注入）。zylos-cutie 不要自写 register HTTP 调用——review
 * HIGH-1 教训：自写漏字段（缺 `platform`）会让 cutie-pair 直接被 server 422 拒掉，
 * 而 spike 用 mock register response 跑根本捕获不到这个契约 break。
 */

import os from 'node:os';
import {
  register as coreRegister,
  type RegisterParams,
  type RegisterResult,
} from '@cutie-crypto/connector-core';
import { COMPONENT_VERSION } from './version.js';

export interface ZylosRegisterInput {
  server_url: string;
  pair_token: string;
  /** 不传则用 hostname */
  device_name?: string;
  /** zylos-cutie capabilities，server 当前不读，留作 future-proof */
  capabilities?: string[];
}

export async function register(input: ZylosRegisterInput): Promise<RegisterResult> {
  const params: RegisterParams = {
    pairToken: input.pair_token,
    platform: os.platform(),
    deviceName: input.device_name ?? defaultDeviceName(),
    connectorVersion: COMPONENT_VERSION,
    agentPlatform: 'zylos',
    agentVersion: COMPONENT_VERSION,
    ...(input.capabilities !== undefined && { capabilities: input.capabilities }),
  };
  return coreRegister(input.server_url, params);
}

function defaultDeviceName(): string {
  return `${os.hostname()}-zylos-cutie`;
}

export type { RegisterResult };
