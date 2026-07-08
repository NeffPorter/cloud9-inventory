const express = require('express');
const router = express.Router();
const https = require('https');
const auth = require('../middleware/auth');
const { requireHim } = require('../lib/roles');

const RAILWAY_TOKEN   = process.env.RAILWAY_TOKEN;
const RAILWAY_PROJECT = process.env.RAILWAY_PROJECT_ID;
const GQL_ENDPOINT    = 'https://backboard.railway.app/graphql/v2';

function gqlRequest(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const options = {
      hostname: 'backboard.railway.app',
      path: '/graphql/v2',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RAILWAY_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from Railway API')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// GET /api/system/status — admin only
router.get('/status', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  if (!RAILWAY_TOKEN || !RAILWAY_PROJECT) {
    return res.status(500).json({ error: 'Railway credentials not configured' });
  }

  try {
    const result = await gqlRequest(`
      query ProjectStatus($projectId: String!) {
        project(id: $projectId) {
          name
          createdAt
          updatedAt
          services {
            edges {
              node {
                id
                name
                deployments(first: 10) {
                  edges {
                    node {
                      id
                      status
                      createdAt
                      updatedAt
                      meta
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { projectId: RAILWAY_PROJECT });

    if (result.errors) {
      return res.status(502).json({ error: result.errors[0]?.message || 'Railway API error' });
    }

    res.json(result.data);
  } catch (err) {
    console.error('Railway status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Railway status' });
  }
});

// GET /api/system/logs/:deploymentId — admin only
router.get('/logs/:deploymentId', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  if (!RAILWAY_TOKEN) {
    return res.status(500).json({ error: 'Railway credentials not configured' });
  }

  try {
    const result = await gqlRequest(`
      query DeploymentLogs($deploymentId: String!) {
        deploymentLogs(deploymentId: $deploymentId) {
          timestamp
          message
          severity
        }
      }
    `, { deploymentId: req.params.deploymentId });

    if (result.errors) {
      return res.status(502).json({ error: result.errors[0]?.message || 'Railway API error' });
    }

    res.json(result.data);
  } catch (err) {
    console.error('Railway logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

module.exports = router;
