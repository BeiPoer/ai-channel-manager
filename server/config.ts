import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  accessPassword: string;
  sessionSecret: string;
  sessionTtlHours: number;
  secureCookies: boolean;
}

const defaultConfigPath = path.join(process.cwd(), 'config.json');

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(configPath = process.env.APP_CONFIG_PATH || defaultConfigPath): AppConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`缺少配置文件：${configPath}。请复制 config.example.json 为 config.json 并设置 accessPassword。`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件读取失败：${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('配置文件格式无效：根节点必须是 JSON 对象。');
  }

  const record = parsed as Record<string, unknown>;
  const accessPassword = readString(record.accessPassword) || readString(record.password);
  const sessionSecret = readString(record.sessionSecret);
  if (!accessPassword) throw new Error('配置文件缺少 accessPassword。');
  if (!sessionSecret) throw new Error('配置文件缺少 sessionSecret。');

  return {
    accessPassword,
    sessionSecret,
    sessionTtlHours: readNumber(record.sessionTtlHours, 24),
    secureCookies: Boolean(record.secureCookies)
  };
}
