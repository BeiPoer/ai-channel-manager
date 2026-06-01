export type ChannelTabKey = 'overview' | 'automation' | 'alerts';
export type OwnedSiteTabKey = 'overview' | 'groups' | 'accounts' | 'automation' | 'alerts';

export type AppRoute =
  | { module: 'home' }
  | { module: 'channels'; channelId?: number; tab: ChannelTabKey }
  | { module: 'owned-sites'; siteId?: number; tab: OwnedSiteTabKey };

export type NavigationMode = 'push' | 'replace';

const channelTabs = new Set<ChannelTabKey>(['overview', 'automation', 'alerts']);
const ownedSiteTabs = new Set<OwnedSiteTabKey>(['overview', 'groups', 'accounts', 'automation', 'alerts']);

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function cleanPath(pathname: string): string[] {
  return pathname
    .split('?')[0]
    .split('#')[0]
    .split('/')
    .map((part) => decodeURIComponent(part.trim()))
    .filter(Boolean);
}

function isChannelTab(value: string | undefined): value is ChannelTabKey {
  return Boolean(value && channelTabs.has(value as ChannelTabKey));
}

function isOwnedSiteTab(value: string | undefined): value is OwnedSiteTabKey {
  return Boolean(value && ownedSiteTabs.has(value as OwnedSiteTabKey));
}

export function normalizeRoute(route: AppRoute): AppRoute {
  if (route.module === 'home') return { module: 'home' };
  if (route.module === 'channels') {
    return {
      module: 'channels',
      channelId: route.channelId && route.channelId > 0 ? Math.floor(route.channelId) : undefined,
      tab: isChannelTab(route.tab) ? route.tab : 'overview'
    };
  }
  return {
    module: 'owned-sites',
    siteId: route.siteId && route.siteId > 0 ? Math.floor(route.siteId) : undefined,
    tab: isOwnedSiteTab(route.tab) ? route.tab : 'overview'
  };
}

export function parseAppRoute(pathname: string): AppRoute {
  const parts = cleanPath(pathname);
  if (parts.length === 0) return { module: 'home' };

  const [section, idSegment, tabSegment] = parts;
  if (section === 'channels') {
    if (parts.length === 1) return { module: 'channels', tab: 'overview' };
    if (parts.length > 3) return { module: 'home' };
    const channelId = positiveInteger(idSegment);
    if (!channelId) return { module: 'home' };
    return {
      module: 'channels',
      channelId,
      tab: isChannelTab(tabSegment) ? tabSegment : 'overview'
    };
  }

  if (section === 'owned-sites') {
    if (parts.length === 1) return { module: 'owned-sites', tab: 'overview' };
    if (parts.length > 3) return { module: 'home' };
    const siteId = positiveInteger(idSegment);
    if (!siteId) return { module: 'home' };
    return {
      module: 'owned-sites',
      siteId,
      tab: isOwnedSiteTab(tabSegment) ? tabSegment : 'overview'
    };
  }

  return { module: 'home' };
}

export function buildAppPath(route: AppRoute): string {
  const normalized = normalizeRoute(route);
  if (normalized.module === 'home') return '/';
  if (normalized.module === 'channels') {
    return normalized.channelId ? `/channels/${normalized.channelId}/${normalized.tab}` : '/channels';
  }
  return normalized.siteId ? `/owned-sites/${normalized.siteId}/${normalized.tab}` : '/owned-sites';
}
