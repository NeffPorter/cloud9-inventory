/**
 * Platform analytics service.
 * Handles Google Business Profile, Apple Business Connect, and Facebook Graph API.
 * All credentials come from Railway environment variables.
 */

const https = require('https');
const crypto = require('crypto');

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Google Business Profile ───────────────────────────────────────────────────
// Docs: https://developers.google.com/my-business/reference/businessprofileperformance/rest
// Env:  GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_LOCATION_IDS (comma-sep, e.g. "locations/123,locations/456")

function makeGoogleJWT() {
  const key   = (process.env.GOOGLE_PRIVATE_KEY  || '').replace(/\\n/g, '\n');
  const email = (process.env.GOOGLE_CLIENT_EMAIL || '');
  if (!key || !email) return null;
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now     = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss:   email,
    scope: 'https://www.googleapis.com/auth/business.manage',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  })).toString('base64url');
  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    return `${header}.${payload}.${sign.sign(key, 'base64url')}`;
  } catch (e) {
    console.error('[Google JWT error]', e.message);
    return null;
  }
}

async function getGoogleToken() {
  const jwt = makeGoogleJWT();
  if (!jwt) return null;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const r = await httpsRequest('POST', 'oauth2.googleapis.com', '/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  }, body);
  try {
    const json = JSON.parse(r.body);
    return json.access_token || null;
  } catch (e) { return null; }
}

async function fetchGoogleInsights(start, end) {
  const configured = !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_LOCATION_IDS);
  if (!configured) return { configured: false };

  try {
    const token = await getGoogleToken();
    if (!token) return { configured: true, error: 'Authentication failed — check GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY' };

    const locationIds = process.env.GOOGLE_LOCATION_IDS.split(',').map(s => s.trim()).filter(Boolean);
    const startDate = start ? new Date(start) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const endDate   = end   ? new Date(end)   : new Date();

    const METRICS = [
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'CALL_CLICKS',
      'BUSINESS_DIRECTION_REQUESTS',
      'WEBSITE_CLICKS'
    ];

    const sd = startDate, ed = endDate;
    const dateQS = [
      `dailyRange.startDate.year=${sd.getFullYear()}`,
      `dailyRange.startDate.month=${sd.getMonth() + 1}`,
      `dailyRange.startDate.day=${sd.getDate()}`,
      `dailyRange.endDate.year=${ed.getFullYear()}`,
      `dailyRange.endDate.month=${ed.getMonth() + 1}`,
      `dailyRange.endDate.day=${ed.getDate()}`
    ].join('&');
    const metricQS = METRICS.map(m => `dailyMetric=${m}`).join('&');

    const locations = await Promise.all(locationIds.map(async (locId) => {
      const cleanId = locId.startsWith('locations/') ? locId : `locations/${locId}`;
      const path = `/v1/${encodeURIComponent(cleanId)}:fetchMultiDailyMetricsTimeSeries?${metricQS}&${dateQS}`;
      const r = await httpsRequest('GET', 'businessprofileperformance.googleapis.com', path, {
        'Authorization': `Bearer ${token}`
      });

      if (r.status !== 200) {
        console.error(`[Google] ${cleanId} status ${r.status}:`, r.body.slice(0, 200));
        return { locationId: cleanId, error: `API returned ${r.status}` };
      }

      const data = JSON.parse(r.body);
      const totals = {};
      (data.multiDailyMetricTimeSeries || []).forEach(series => {
        const metric = series.dailyMetric;
        // Handle both direct timeSeries and per-subEntity data
        const datedValues = series.timeSeries?.datedValues ||
          (series.dailySubEntityData || []).flatMap(d => d.timeSeries?.datedValues || []);
        totals[metric] = (datedValues || []).reduce((sum, v) => sum + (parseInt(v.value) || 0), 0);
      });

      return {
        locationId: cleanId,
        impressions: (totals.BUSINESS_IMPRESSIONS_DESKTOP_MAPS    || 0)
                   + (totals.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH  || 0)
                   + (totals.BUSINESS_IMPRESSIONS_MOBILE_MAPS     || 0)
                   + (totals.BUSINESS_IMPRESSIONS_MOBILE_SEARCH   || 0),
        calls:       totals.CALL_CLICKS                 || 0,
        directions:  totals.BUSINESS_DIRECTION_REQUESTS || 0,
        websiteClicks: totals.WEBSITE_CLICKS            || 0
      };
    }));

    const totals = {
      impressions:   locations.reduce((s, l) => s + (l.impressions   || 0), 0),
      calls:         locations.reduce((s, l) => s + (l.calls         || 0), 0),
      directions:    locations.reduce((s, l) => s + (l.directions    || 0), 0),
      websiteClicks: locations.reduce((s, l) => s + (l.websiteClicks || 0), 0)
    };

    return { configured: true, locations, totals };
  } catch (err) {
    console.error('[Google insights error]', err.message);
    return { configured: true, error: err.message };
  }
}

// ── Apple Business Connect ────────────────────────────────────────────────────
// Docs: https://developer.apple.com/documentation/apple_business_connect_api
// Env:  APPLE_ABC_KEY_ID, APPLE_ABC_TEAM_ID, APPLE_ABC_PRIVATE_KEY (.p8 content), APPLE_ABC_LOCATION_IDS (comma-sep)

function makeAppleJWT() {
  const key    = (process.env.APPLE_ABC_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const keyId  = process.env.APPLE_ABC_KEY_ID;
  const teamId = process.env.APPLE_ABC_TEAM_ID;
  if (!key || !keyId || !teamId) return null;
  const header  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const now     = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now, exp: now + 3600 })).toString('base64url');
  try {
    const sign = crypto.createSign('SHA256');
    sign.update(`${header}.${payload}`);
    // Apple uses P-256 (ES256) — ieee-p1363 encoding produces the 64-byte R||S signature JWT needs
    const sig = sign.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');
    return `${header}.${payload}.${sig}`;
  } catch (e) {
    console.error('[Apple JWT error]', e.message);
    return null;
  }
}

async function fetchAppleInsights(start, end) {
  const configured = !!(process.env.APPLE_ABC_KEY_ID && process.env.APPLE_ABC_TEAM_ID && process.env.APPLE_ABC_PRIVATE_KEY && process.env.APPLE_ABC_LOCATION_IDS);
  if (!configured) return { configured: false };

  try {
    const jwt = makeAppleJWT();
    if (!jwt) return { configured: true, error: 'Could not create Apple JWT — check key credentials' };

    const locationIds = process.env.APPLE_ABC_LOCATION_IDS.split(',').map(s => s.trim()).filter(Boolean);
    const startStr = start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const endStr   = end   || new Date().toISOString().slice(0, 10);

    const locations = await Promise.all(locationIds.map(async (locId) => {
      // Apple Business Connect insights endpoint
      // NOTE: Apple's analytics API endpoints are subject to change — verify against latest docs
      const qs = `startDate=${startStr}&endDate=${endStr}&granularity=DAILY`;
      const path = `/api/v1/businessconnect/locations/${encodeURIComponent(locId)}/insights?${qs}`;
      const r = await httpsRequest('GET', 'businessconnect.apple.com', path, {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      });

      if (r.status !== 200) {
        console.error(`[Apple] ${locId} status ${r.status}:`, r.body.slice(0, 300));
        return { locationId: locId, error: `API returned ${r.status}: ${r.body.slice(0, 100)}` };
      }

      const data = JSON.parse(r.body);
      // Map Apple's response — structure may vary, adjust keys to match actual response
      const metrics = data.metrics || data.data || {};
      return {
        locationId: locId,
        impressions:  sumMetric(metrics, 'impressions'),
        taps:         sumMetric(metrics, 'taps'),
        calls:        sumMetric(metrics, 'phoneCalls') || sumMetric(metrics, 'calls'),
        directions:   sumMetric(metrics, 'drivingDirections') || sumMetric(metrics, 'directions'),
        websiteClicks: sumMetric(metrics, 'websiteVisits') || sumMetric(metrics, 'websiteClicks')
      };
    }));

    const totals = {
      impressions:   locations.reduce((s, l) => s + (l.impressions   || 0), 0),
      taps:          locations.reduce((s, l) => s + (l.taps          || 0), 0),
      calls:         locations.reduce((s, l) => s + (l.calls         || 0), 0),
      directions:    locations.reduce((s, l) => s + (l.directions    || 0), 0),
      websiteClicks: locations.reduce((s, l) => s + (l.websiteClicks || 0), 0)
    };

    return { configured: true, locations, totals };
  } catch (err) {
    console.error('[Apple insights error]', err.message);
    return { configured: true, error: err.message };
  }
}

function sumMetric(metrics, key) {
  // Handle both array-of-objects and flat-object formats
  if (Array.isArray(metrics)) {
    const found = metrics.find(m => m.metricType === key || m.name === key);
    if (!found) return 0;
    const values = found.values || found.data || [];
    return values.reduce((s, v) => s + (typeof v === 'number' ? v : (v.value || 0)), 0);
  }
  const val = metrics[key];
  if (Array.isArray(val)) return val.reduce((s, v) => s + (typeof v === 'number' ? v : (v.value || 0)), 0);
  return typeof val === 'number' ? val : 0;
}

// ── Facebook Graph API ────────────────────────────────────────────────────────
// Docs: https://developers.facebook.com/docs/graph-api/reference/v18.0/insights
// Env:  FACEBOOK_PAGE_TOKENS = "pageId1:accessToken1,pageId2:accessToken2" (one per store)

async function fetchFacebookInsights(start, end) {
  const raw = process.env.FACEBOOK_PAGE_TOKENS || '';
  const configured = raw.length > 0;
  if (!configured) return { configured: false };

  try {
    const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!entries.length) return { configured: false };

    const startTs = start ? Math.floor(new Date(start).getTime() / 1000) : Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
    const endTs   = end   ? Math.floor(new Date(end + 'T23:59:59').getTime() / 1000) : Math.floor(Date.now() / 1000);

    const INSIGHT_METRICS = [
      'page_impressions',
      'page_engaged_users',
      'page_views_total',
      'page_calls_total'
    ];

    const pages = await Promise.all(entries.map(async (entry) => {
      const colonIdx = entry.lastIndexOf(':');
      if (colonIdx < 1) return { error: 'Bad FACEBOOK_PAGE_TOKENS format — expected pageId:token' };
      const pageId = entry.slice(0, colonIdx);
      const token  = entry.slice(colonIdx + 1);

      // Fetch page name + fan count
      const pageRes = await httpsRequest('GET', 'graph.facebook.com',
        `/v18.0/${pageId}?fields=name,fan_count,followers_count&access_token=${encodeURIComponent(token)}`,
        {}
      );
      const pageData = JSON.parse(pageRes.body);
      if (pageData.error) throw new Error(`Page ${pageId}: ${pageData.error.message}`);

      // Fetch insights (period=total_over_range aggregates across date span)
      const metricParam = INSIGHT_METRICS.join(',');
      const insightRes = await httpsRequest('GET', 'graph.facebook.com',
        `/v18.0/${pageId}/insights?metric=${metricParam}&period=total_over_range&since=${startTs}&until=${endTs}&access_token=${encodeURIComponent(token)}`,
        {}
      );
      const insightData = JSON.parse(insightRes.body);

      const metrics = {};
      (insightData.data || []).forEach(m => {
        const val = (m.values || []).reduce((s, v) => s + (typeof v.value === 'number' ? v.value : 0), 0);
        metrics[m.name] = val;
      });

      return {
        pageId,
        name:         pageData.name || pageId,
        fans:         pageData.fan_count || 0,
        followers:    pageData.followers_count || 0,
        impressions:  metrics.page_impressions       || 0,
        engaged:      metrics.page_engaged_users     || 0,
        views:        metrics.page_views_total       || 0,
        calls:        metrics.page_calls_total       || 0
      };
    }));

    const totals = {
      fans:        pages.reduce((s, p) => s + (p.fans        || 0), 0),
      followers:   pages.reduce((s, p) => s + (p.followers   || 0), 0),
      impressions: pages.reduce((s, p) => s + (p.impressions || 0), 0),
      engaged:     pages.reduce((s, p) => s + (p.engaged     || 0), 0),
      views:       pages.reduce((s, p) => s + (p.views       || 0), 0),
      calls:       pages.reduce((s, p) => s + (p.calls       || 0), 0)
    };

    return { configured: true, pages, totals };
  } catch (err) {
    console.error('[Facebook insights error]', err.message);
    return { configured: true, error: err.message };
  }
}

module.exports = { fetchGoogleInsights, fetchAppleInsights, fetchFacebookInsights };
