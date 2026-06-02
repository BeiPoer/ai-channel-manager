import type { ChannelType } from './types.js';

export interface GroupInfo {
  key: string;
  label: string;
  ratio: number | null;
  raw: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function addIdentifier(identifiers: Set<string>, value: unknown): void {
  const text = stringValue(value);
  if (text) identifiers.add(text);
}

function mergeIdentifiers(target: Set<string>, values: Iterable<string>): void {
  for (const value of values) target.add(value);
}

function itemsFromGroups(groups: unknown): unknown[] {
  return Array.isArray(groups)
    ? groups
    : isRecord(groups)
      ? Object.entries(groups).map(([name, value]) => ({ name, ...(isRecord(value) ? value : { value }) }))
      : [];
}

function groupIdentifiers(group: unknown): Set<string> {
  const identifiers = new Set<string>();
  if (!isRecord(group)) {
    addIdentifier(identifiers, group);
    return identifiers;
  }
  const identifierFields = [
    'id',
    'ID',
    'group_id',
    'groupId',
    'groupID',
    'name',
    'Name',
    'group',
    'Group',
    'key',
    'code',
    'group_name',
    'groupName',
    'display_name',
    'displayName',
    'title'
  ];
  for (const field of identifierFields) {
    const value = group[field];
    if (isRecord(value)) {
      mergeIdentifiers(identifiers, groupIdentifiers(value));
    } else {
      addIdentifier(identifiers, value);
    }
  }
  return identifiers;
}

function tokenGroupIdentifiers(token: unknown, channelType: ChannelType): Set<string> {
  const identifiers = new Set<string>();
  if (!isRecord(token)) return identifiers;

  for (const field of ['group_id', 'groupId', 'groupID', 'group_name', 'groupName']) {
    addIdentifier(identifiers, token[field]);
  }

  const group = token.group ?? token.Group;
  if (isRecord(group)) {
    mergeIdentifiers(identifiers, groupIdentifiers(group));
  } else {
    addIdentifier(identifiers, group);
    if (channelType === 'newapi' && group !== undefined && group !== null && String(group).trim() === '') {
      identifiers.add('default');
    }
  }

  return identifiers;
}

function expandIdentifiersWithGroups(groups: unknown, identifiers: Set<string>): Set<string> {
  if (!identifiers.size) return identifiers;
  const expanded = new Set(identifiers);
  for (const group of itemsFromGroups(groups)) {
    const groupIds = groupIdentifiers(group);
    if (Array.from(groupIds).some((id) => identifiers.has(id))) {
      mergeIdentifiers(expanded, groupIds);
    }
  }
  return expanded;
}

function groupKey(group: unknown): string {
  if (!isRecord(group)) return stringValue(group) || JSON.stringify(group);
  const record = group as Record<string, unknown>;
  const keyFields = ['name', 'group', 'key', 'code', 'id', 'group_id', 'group_name', 'display_name'];
  for (const field of keyFields) {
    const value = stringValue(record[field]);
    if (value) return value;
  }
  return JSON.stringify(record);
}

function groupRatio(group: unknown): number | null {
  if (typeof group === 'number' && Number.isFinite(group)) return group;
  if (!isRecord(group)) return null;
  const ratioFields = ['ratio', 'rate', 'multiplier', 'rate_multiplier', 'rateMultiplier', 'group_ratio', 'model_ratio', '倍率', 'value'];
  for (const field of ratioFields) {
    const value = group[field];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalizeGroups(groups: unknown): Map<string, GroupInfo> {
  const map = new Map<string, GroupInfo>();
  for (const item of itemsFromGroups(groups)) {
    const key = groupKey(item);
    map.set(key, {
      key,
      label: key,
      ratio: groupRatio(item),
      raw: item
    });
  }
  return map;
}

export function groupList(groups: Iterable<GroupInfo>): string {
  return Array.from(groups)
    .map((group) => (group.ratio === null ? group.label : `${group.label}(${group.ratio})`))
    .join('、');
}

export function watchedGroupIdentifiers(groups: unknown, tokens: unknown, channelType: ChannelType): Set<string> {
  const identifiers = new Set<string>();
  if (Array.isArray(tokens)) {
    for (const token of tokens) {
      mergeIdentifiers(identifiers, tokenGroupIdentifiers(token, channelType));
    }
  }
  return expandIdentifiersWithGroups(groups, identifiers);
}

export function filterGroupsByIdentifiers(groups: unknown, identifiers: Set<string>): unknown[] {
  if (!identifiers.size) return [];
  return itemsFromGroups(groups).filter((group) => Array.from(groupIdentifiers(group)).some((id) => identifiers.has(id)));
}

export function filterGroupsByTokenUsage(groups: unknown, tokens: unknown, channelType: ChannelType): unknown[] {
  return filterGroupsByIdentifiers(groups, watchedGroupIdentifiers(groups, tokens, channelType));
}
