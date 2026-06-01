import { describe, expect, it } from 'vitest';
import { buildAppPath, parseAppRoute } from '../src/routing.js';

describe('frontend route helpers', () => {
  it('parses home route', () => {
    expect(parseAppRoute('/')).toEqual({ module: 'home' });
  });

  it('parses channel route with id and tab', () => {
    expect(parseAppRoute('/channels/12/automation')).toEqual({
      module: 'channels',
      channelId: 12,
      tab: 'automation'
    });
  });

  it('parses owned site route with id and tab', () => {
    expect(parseAppRoute('/owned-sites/3/accounts')).toEqual({
      module: 'owned-sites',
      siteId: 3,
      tab: 'accounts'
    });
  });

  it('normalizes invalid tabs to overview', () => {
    expect(parseAppRoute('/owned-sites/3/bad')).toEqual({
      module: 'owned-sites',
      siteId: 3,
      tab: 'overview'
    });
  });

  it('normalizes unknown paths to home', () => {
    expect(parseAppRoute('/unknown/3/accounts')).toEqual({ module: 'home' });
  });

  it('builds paths from route state', () => {
    expect(buildAppPath({ module: 'channels', channelId: 12, tab: 'alerts' })).toBe('/channels/12/alerts');
    expect(buildAppPath({ module: 'owned-sites', siteId: 3, tab: 'accounts' })).toBe('/owned-sites/3/accounts');
    expect(buildAppPath({ module: 'home' })).toBe('/');
  });
});
