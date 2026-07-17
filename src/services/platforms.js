/**
 * Platform analytics service.
 * Google uses OAuth2 refresh token stored in platform_credentials table.
 * Per-store identifiers (location IDs, Facebook tokens) live in the stores DB table.
 */

const https   = require('https');
const crypto  = require('crypto');
const supabase = require('../lib/supabase');

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
// Shared env: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY
// Per-store DB: google_location_id (e.g. "accounts/123/locations/456" or just "locations/456")

function makeGoogleJWT() {
  const key   = (process.env.GOOGLE_PRIVATE_KEY  || '').replace(/\\n/g, '\n');
  const email =  process.env.GOOGLE_CLIENT_EMAIL  || '';
  if (!key || !email) return null;
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now     = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/business.manage',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })).toString('base64url');
  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    return `${header}.${payload}.${sign.sign(key, 'base64url')}`;
  } catch (e) { console.error('[Google JWT]', e.message); return null; }
}

async function getGoogleToken() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (clientId && clientSecret) {
    // Load refresh token from DB
    const { data } = await supabase.from('platform_credentials').select('refresh_token').eq('platform', 'google').single();
    const refreshToken = data?.refresh_token;
    if (refreshToken) {
      const body = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token`;
      const r = await httpsRequest('POST', 'oauth2.googleapis.com', '/token', {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }, body);
      try {
        const d = JSON.parse(r.body);
        if (d.access_token) return d.access_token;
        console.error('[Google token] refresh failed:', d.error_description || d.error);
      } catch (e) { console.error('[Google token] parse error:', e.message); }
    }
  }

  // Fallback: service account JWT
  const jwt = makeGoogleJWT();
  if (!jwt) return null;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const r = await httpsRequest('POST', 'oauth2.googleapis.com', '/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  }, body);
  try { return JSON.parse(r.body).access_token || null; } catch { return null; }
}

async function fetchGoogleInsights(start, end, stores = []) {
  const hasAuth = !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
  const activeStores = stores.filter(s => s.google_location_id);
  if (!hasAuth || !activeStores.length) return { configured: false };

  try {
    const token = await getGoogleToken();
    if (!token) return { configured: true, error: 'Auth failed — check GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY' };

    const sd = start ? new Date(start) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const ed = end   ? new Date(end)   : new Date();
    const METRICS = [
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS','BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'CALL_CLICKS','BUSINESS_DIRECTION_REQUESTS','WEBSITE_CLICKS'
    ];
    const dateQS = [
      `dailyRange.startDate.year=${sd.getFullYear()}`,`dailyRange.startDate.month=${sd.getMonth()+1}`,`dailyRange.startDate.day=${sd.getDate()}`,
      `dailyRange.endDate.year=${ed.getFullYear()}`,  `dailyRange.endDate.month=${ed.getMonth()+1}`,  `dailyRange.endDate.day=${ed.getDate()}`
    ].join('&');
    const metricQS = METRICS.map(m => `dailyMetric=${m}`).join('&');

    const locations = await Promise.all(activeStores.map(async (store) => {
      const locId = store.google_location_id.startsWith('locations/') ? store.google_location_id : `locations/${store.google_location_id}`;
      const path = `/v1/${encodeURIComponent(locId)}:fetchMultiDailyMetricsTimeSeries?${metricQS}&${dateQS}`;
      const r = await httpsRequest('GET', 'businessprofileperformance.googleapis.com', path, { 'Authorization': `Bearer ${token}` });
      if (r.status !== 200) return { locationId: locId, name: store.name, error: `API ${r.status}` };
      const data = JSON.parse(r.body);
      const t = {};
      (data.multiDailyMetricTimeSeries || []).forEach(s => {
        const dv = s.timeSeries?.datedValues || (s.dailySubEntityData || []).flatMap(d => d.timeSeries?.datedValues || []);
        t[s.dailyMetric] = (dv || []).reduce((sum, v) => sum + (parseInt(v.value) || 0), 0);
      });
      return {
        locationId: locId, name: store.name,
        impressions:   (t.BUSINESS_IMPRESSIONS_DESKTOP_MAPS||0)+(t.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH||0)+(t.BUSINESS_IMPRESSIONS_MOBILE_MAPS||0)+(t.BUSINESS_IMPRESSIONS_MOBILE_SEARCH||0),
        calls:         t.CALL_CLICKS||0,
        directions:    t.BUSINESS_DIRECTION_REQUESTS||0,
        websiteClicks: t.WEBSITE_CLICKS||0
      };
    }));

    const totals = {
      impressions:   locations.reduce((s,l)=>s+(l.impressions||0),0),
      calls:         locations.reduce((s,l)=>s+(l.calls||0),0),
      directions:    locations.reduce((s,l)=>s+(l.directions||0),0),
      websiteClicks: locations.reduce((s,l)=>s+(l.websiteClicks||0),0)
    };
    return { configured: true, locations, totals };
  } catch (err) { console.error('[Google]', err.message); return { configured: true, error: err.message }; }
}

// ── Apple Business Connect ────────────────────────────────────────────────────
// Shared env: APPLE_ABC_KEY_ID, APPLE_ABC_TEAM_ID, APPLE_ABC_PRIVATE_KEY
// Per-store DB: apple_location_id

function makeAppleJWT() {
  const key    = (process.env.APPLE_ABC_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const keyId  =  process.env.APPLE_ABC_KEY_ID;
  const teamId =  process.env.APPLE_ABC_TEAM_ID;
  if (!key || !keyId || !teamId) return null;
  const header  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const now     = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now, exp: now + 3600 })).toString('base64url');
  try {
    const sign = crypto.createSign('SHA256');
    sign.update(`${header}.${payload}`);
    return `${header}.${payload}.${sign.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url')}`;
  } catch (e) { console.error('[Apple JWT]', e.message); return null; }
}

async function fetchAppleInsights(start, end, stores = []) {
  const hasAuth = !!(process.env.APPLE_ABC_KEY_ID && process.env.APPLE_ABC_TEAM_ID && process.env.APPLE_ABC_PRIVATE_KEY);
  const activeStores = stores.filter(s => s.apple_location_id);
  if (!hasAuth || !activeStores.length) return { configured: false };

  try {
    const jwt = makeAppleJWT();
    if (!jwt) return { configured: true, error: 'Could not create Apple JWT — check key credentials' };
    const startStr = start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const endStr   = end   || new Date().toISOString().slice(0,10);

    const locations = await Promise.all(activeStores.map(async (store) => {
      const qs = `startDate=${startStr}&endDate=${endStr}&granularity=DAILY`;
      const path = `/api/v1/businessconnect/locations/${encodeURIComponent(store.apple_location_id)}/insights?${qs}`;
      const r = await httpsRequest('GET', 'businessconnect.apple.com', path, {
        'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json'
      });
      if (r.status !== 200) return { locationId: store.apple_location_id, name: store.name, error: `API ${r.status}` };
      const data = JSON.parse(r.body);
      const metrics = data.metrics || data.data || {};
      return {
        locationId: store.apple_location_id, name: store.name,
        impressions:   sumMetric(metrics, 'impressions'),
        taps:          sumMetric(metrics, 'taps'),
        calls:         sumMetric(metrics, 'phoneCalls') || sumMetric(metrics, 'calls'),
        directions:    sumMetric(metrics, 'drivingDirections') || sumMetric(metrics, 'directions'),
        websiteClicks: sumMetric(metrics, 'websiteVisits') || sumMetric(metrics, 'websiteClicks')
      };
    }));

    const totals = {
      impressions:   locations.reduce((s,l)=>s+(l.impressions||0),0),
      taps:          locations.reduce((s,l)=>s+(l.taps||0),0),
      calls:         locations.reduce((s,l)=>s+(l.calls||0),0),
      directions:    locations.reduce((s,l)=>s+(l.directions||0),0),
      websiteClicks: locations.reduce((s,l)=>s+(l.websiteClicks||0),0)
    };
    return { configured: true, locations, totals };
  } catch (err) { console.error('[Apple]', err.message); return { configured: true, error: err.message }; }
}

function sumMetric(metrics, key) {
  if (Array.isArray(metrics)) {
    const found = metrics.find(m => m.metricType === key || m.name === key);
    if (!found) return 0;
    return (found.values || found.data || []).reduce((s,v) => s+(typeof v==='number'?v:(v.value||0)),0);
  }
  const val = metrics[key];
  if (Array.isArray(val)) return val.reduce((s,v) => s+(typeof v==='number'?v:(v.value||0)),0);
  return typeof val === 'number' ? val : 0;
}

// ── Facebook Graph API ────────────────────────────────────────────────────────
// Per-store DB: facebook_page_id, facebook_page_token

async function fetchFacebookInsights(start, end, stores = []) {
  const activeStores = stores.filter(s => s.facebook_page_id && s.facebook_page_token);
  if (!activeStores.length) return { configured: false };

  try {
    const startTs = start ? Math.floor(new Date(start).getTime()/1000) : Math.floor(new Date(new Date().getFullYear(),new Date().getMonth(),1).getTime()/1000);
    const endTs   = end   ? Math.floor(new Date(end+'T23:59:59').getTime()/1000) : Math.floor(Date.now()/1000);
    const METRICS = 'page_impressions';

    const pages = await Promise.all(activeStores.map(async (store) => {
      const token = store.facebook_page_token;
      const pageId = store.facebook_page_id;

      // Page info (fans, followers, star rating, new likes)
      const pageRes = await httpsRequest('GET', 'graph.facebook.com',
        `/v21.0/${pageId}?fields=name,fan_count,followers_count,overall_star_rating,rating_count,new_like_count&access_token=${encodeURIComponent(token)}`, {});
      const pageData = JSON.parse(pageRes.body);
      if (pageData.error) throw new Error(`Page ${pageId}: ${pageData.error.message}`);

      return {
        pageId, name: store.name,
        fans:        pageData.fan_count         || 0,
        followers:   pageData.followers_count   || 0,
        starRating:  pageData.overall_star_rating || 0,
        ratingCount: pageData.rating_count      || 0,
        newLikes:    pageData.new_like_count     || 0,
      };
    }));

    const totals = {
      fans:        pages.reduce((s,p)=>s+(p.fans||0),0),
      followers:   pages.reduce((s,p)=>s+(p.followers||0),0),
      newLikes:    pages.reduce((s,p)=>s+(p.newLikes||0),0),
      ratingCount: pages.reduce((s,p)=>s+(p.ratingCount||0),0),
      // average star rating across pages that have a rating
      starRating: (() => {
        const rated = pages.filter(p => p.starRating > 0);
        if (!rated.length) return 0;
        return Math.round((rated.reduce((s,p) => s + p.starRating, 0) / rated.length) * 10) / 10;
      })(),
    };
    return { configured: true, pages, totals };
  } catch (err) { console.error('[Facebook]', err.message); return { configured: true, error: err.message }; }
}



// ── Instagram (via Facebook Graph API) ─────────────────────────────────────────────
// Per-store DB: facebook_page_id + facebook_page_token (same as Facebook)

async function fetchInstagramInsights(start, end, stores = []) {
  const activeStores = stores.filter(s => s.facebook_page_id && s.facebook_page_token);
  if (!activeStores.length) return { configured: false };

  try {
    const startTs = start ? Math.floor(new Date(start).getTime()/1000)
      : Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()/1000);
    const endTs = end ? Math.floor(new Date(end + 'T23:59:59').getTime()/1000)
      : Math.floor(Date.now()/1000);

    const accounts = await Promise.all(activeStores.map(async (store) => {
      const token = store.facebook_page_token;
      const pageId = store.facebook_page_id;

      // Step 1: get Instagram account ID only (just needs pages_read_engagement)
      const igRes = await httpsRequest('GET', 'graph.facebook.com',
        `/v21.0/me?fields=instagram_business_account{id},connected_instagram_account{id}&access_token=${encodeURIComponent(token)}`, {});
      const igData = JSON.parse(igRes.body);
      if (igData.error) throw new Error(`Page ${pageId}: ${igData.error.message}`);
      console.log(`[Instagram] Page ${pageId} lookup:`, JSON.stringify(igData));

      const igAccount = igData.instagram_business_account || igData.connected_instagram_account;
      if (!igAccount) {
        console.error(`[Instagram] Page ${pageId} no linked IG account. Page fields:`, Object.keys(igData).join(', '));
        return { pageId, name: store.name, followers: 0, impressions: 0, reach: 0, profileViews: 0, error: 'No Instagram account linked' };
      }

      const igUserId = igAccount.id;

      // Step 2: get Instagram account details (followers, username, post count)
      const igDetailRes = await httpsRequest('GET', 'graph.facebook.com',
        `/v21.0/${igUserId}?fields=username,followers_count,name,media_count&access_token=${encodeURIComponent(token)}`, {});
      const igDetail = JSON.parse(igDetailRes.body);
      console.log(`[Instagram] IG account ${igUserId} details:`, JSON.stringify(igDetail));

      const followers  = igDetail.followers_count || 0;
      const mediaCount = igDetail.media_count     || 0;

      // Fetch insights
      const insightRes = await httpsRequest('GET', 'graph.facebook.com',
        `/v21.0/${igUserId}/insights?metric=impressions,reach,profile_views&period=day&since=${startTs}&until=${endTs}&access_token=${encodeURIComponent(token)}`, {});
      const insightData = JSON.parse(insightRes.body);
      if (insightData.error) console.error(`[Instagram] IG insights ${igUserId}:`, insightData.error.message);

      const m = {};
      (insightData.data || []).forEach(item => {
        m[item.name] = (item.values || []).reduce((s, v) => s + (typeof v.value === 'number' ? v.value : 0), 0);
      });

      return {
        pageId, igUserId, name: store.name,
        username:   igDetail.username || igDetail.name || '',
        followers,
        mediaCount,
      };
    }));

    const totals = {
      followers:  accounts.reduce((s, a) => s + (a.followers  || 0), 0),
      mediaCount: accounts.reduce((s, a) => s + (a.mediaCount || 0), 0),
    };
    return { configured: true, accounts, totals };
  } catch (err) { console.error('[Instagram]', err.message); return { configured: true, error: err.message }; }
}

// ── Google Reviews ──────────────────────────────────────────────────────────────
// Uses same service account as Google Business Profile
// Per-store DB: google_location_id

async function fetchGoogleReviews(stores = []) {
  const hasAuth = !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
  const activeStores = stores.filter(s => s.google_location_id);
  if (!hasAuth || !activeStores.length) return { configured: false };

  try {
    const token = await getGoogleToken();
    if (!token) return { configured: true, error: 'Auth failed' };

    const locations = await Promise.all(activeStores.map(async (store) => {
      const locId = store.google_location_id.startsWith('locations/')
        ? store.google_location_id : `locations/${store.google_location_id}`;
      const r = await httpsRequest('GET', 'mybusiness.googleapis.com',
        `/v4/${locId}/reviews?pageSize=1`,
        { 'Authorization': `Bearer ${token}` });
      if (r.status !== 200) return { locationId: locId, name: store.name, error: `API ${r.status}` };
      const data = JSON.parse(r.body);
      return {
        locationId: locId, name: store.name,
        averageRating:    data.averageRating    || 0,
        totalReviewCount: data.totalReviewCount || 0
      };
    }));

    return { configured: true, locations };
  } catch (err) { console.error('[GoogleReviews]', err.message); return { configured: true, error: err.message }; }
}

// ── GA4 (Google Analytics Data API) ──────────────────────────────────────────────
// Same service account creds — ensure analytics.readonly scope granted
// Per-store DB: ga4_property_id  (e.g. "properties/123456789" or just "123456789")

async function getGA4Token() {
  const key   = (process.env.GOOGLE_PRIVATE_KEY  || '').replace(/\\n/g, '\n');
  const email =  process.env.GOOGLE_CLIENT_EMAIL  || '';
  if (!key || !email) return null;
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now     = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  })).toString('base64url');
  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const jwt = `${header}.${payload}.${sign.sign(key, 'base64url')}`;
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const r = await httpsRequest('POST', 'oauth2.googleapis.com', '/token', {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }, body);
    return JSON.parse(r.body).access_token || null;
  } catch { return null; }
}

async function fetchGA4Insights(start, end, stores = []) {
  const hasAuth = !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
  const activeStores = stores.filter(s => s.ga4_property_id);
  if (!hasAuth || !activeStores.length) return { configured: false };

  try {
    const token = await getGA4Token();
    if (!token) return { configured: true, error: 'GA4 auth failed — ensure service account has Analytics access' };

    const startDate = start ? start.slice(0, 10)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const endDate = end ? end.slice(0, 10) : new Date().toISOString().slice(0, 10);

    const properties = await Promise.all(activeStores.map(async (store) => {
      const propId = store.ga4_property_id.startsWith('properties/')
        ? store.ga4_property_id : `properties/${store.ga4_property_id}`;
      const reportBody = JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' },
          { name: 'activeUsers' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' }
        ]
      });
      const r = await httpsRequest('POST', 'analyticsdata.googleapis.com',
        `/v1beta/${propId}:runReport`,
        {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(reportBody)
        }, reportBody);
      if (r.status !== 200) {
        return { propertyId: propId, name: store.name, error: `API ${r.status}` };
      }
      const data = JSON.parse(r.body);
      const row = (data.rows || [])[0];
      const vals = row ? row.metricValues.map(v => parseFloat(v.value) || 0) : [0, 0, 0, 0];
      return {
        propertyId: propId, name: store.name,
        sessions:   vals[0],
        users:      vals[1],
        pageViews:  vals[2],
        bounceRate: vals[3]
      };
    }));

    const totals = {
      sessions:   properties.reduce((s, p) => s + (p.sessions  || 0), 0),
      users:      properties.reduce((s, p) => s + (p.users     || 0), 0),
      pageViews:  properties.reduce((s, p) => s + (p.pageViews || 0), 0),
      bounceRate: properties.length
        ? properties.reduce((s, p) => s + (p.bounceRate || 0), 0) / properties.length
        : 0
    };
    return { configured: true, properties, totals };
  } catch (err) { console.error('[GA4]', err.message); return { configured: true, error: err.message }; }
}

module.exports = {
  fetchGoogleInsights, fetchAppleInsights, fetchFacebookInsights,
  fetchInstagramInsights, fetchGoogleReviews, fetchGA4Insights
};
