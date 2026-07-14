function buildNavItems(user) {
  const role    = user.role     || '';
  const storeId = user.store_id || '';

  const isHimRole = ['him', 'admin', 'regional_manager'].includes(role);
  const isMedia   = role === 'marketing';
  const isSingle  = role === 'gm' || role === 'store_user';

  // Paths that carry a ?store= param for single-store users
  const STORE_PATHS = new Set([
    '/sales', '/inventory', '/stocktake', '/suggested',
    '/pos', '/budgets', '/schedules', '/store-tasks',
    '/owner-pl', '/gm-expenses'
  ]);

  // Build a dropdown button — single-store users get ?store= appended, multi-store navigate to the page directly
  function item(path, emoji, label) {
    const href = (isSingle && STORE_PATHS.has(path) && storeId) ? `${path}?store=${storeId}` : path;
    return `<button class="dropdown-item" onclick="window.location.href='${href}'">${emoji} ${label}</button>`;
  }

  // To-Do direct link
  const todoHref = (isSingle && storeId) ? `/store-tasks?store=${storeId}` : '/store-tasks';

  // Admin section — conditional on role
  let adminItems = '';
  if (isHimRole) {
    adminItems += `
      <button class="dropdown-item" onclick="window.location.href='/stores'">🏪 Stores</button>
      <button class="dropdown-item" onclick="window.location.href='/users'">👥 Users</button>`;
  }
  if (isHimRole || role === 'owner') {
    adminItems += `<button class="dropdown-item" onclick="window.location.href='/activity-log'">📜 Activity Log</button>`;
  }
  if (role === 'admin') {
    adminItems += `<button class="dropdown-item" onclick="window.location.href='/system-status'">🛰️ System Status</button>`;
  }
  const adminSection = adminItems ? `
    <div class="nav-item" style="position:relative">
      <button class="nav-btn" onclick="toggleDropdown('adminDropdown', this)">⚙️ Admin <span style="font-size:10px">▼</span></button>
      <div class="dropdown" id="adminDropdown">
        <div class="dropdown-header">Admin</div>
        ${adminItems}
      </div>
    </div>` : '';

  // Media role gets its own simplified nav
  if (isMedia) {
    return `
      <div class="nav-item" style="position:relative">
        <button class="nav-btn" onclick="toggleDropdown('mediaDropdown', this)">📊 Analytics <span style="font-size:10px">▼</span></button>
        <div class="dropdown" id="mediaDropdown">
          <div class="dropdown-header">Analytics</div>
            <button class="dropdown-item" onclick="window.location.href='/analytics'">📊 Analytics Dashboard</button>
        </div>
      </div>
      <div class="nav-item" style="position:relative">
        <button class="nav-btn" onclick="toggleDropdown('mediaPromoDropdown', this)">🎯 Promotions <span style="font-size:10px">▼</span></button>
        <div class="dropdown" id="mediaPromoDropdown">
          <div class="dropdown-header">Promotions</div>
          <button class="dropdown-item" onclick="window.location.href='/products-feed'">🆕 Products Feed</button>
          <button class="dropdown-item" onclick="window.location.href='/promotions'">📅 Sale Events</button>
        </div>
      </div>
      <button class="nav-btn" onclick="window.location.href='/owner-inventory'">🔍 Inventory Lookup</button>
      <button class="nav-btn" onclick="window.location.href='/gm-expenses'">💼 Expenses</button>
      <div class="nav-item">
        <button class="nav-btn" onclick="window.location.href='${todoHref}'">✅ To-Do</button>
      </div>`;
  }

  return `
    <!-- Reports -->
    <div class="nav-item" style="position:relative">
      <button class="nav-btn" onclick="toggleDropdown('reportsDropdown', this)">📊 Reports <span style="font-size:10px">▼</span></button>
      <div class="dropdown" id="reportsDropdown">
        <div class="dropdown-header">Reports</div>
        ${item('/sales',    '💰', 'Sales')}
        ${item('/owner-pl', '📊', 'P&L Statement')}
        <button class="dropdown-item" onclick="window.location.href='/analytics'">📊 Analytics Dashboard</button>
      </div>
    </div>


    <!-- Inventory Management -->
    <div class="nav-item" style="position:relative">
      <button class="nav-btn" onclick="toggleDropdown('invMgmtDropdown', this)">📦 Inventory <span style="font-size:10px">▼</span></button>
      <div class="dropdown" id="invMgmtDropdown">
        <div class="dropdown-header">Inventory</div>
        ${item('/inventory',       '📦', 'Inventory')}
        ${item('/stocktake',       '📋', 'Stock Take')}
        ${item('/suggested',       '📋', 'Purchase Planner')}
        <button class="dropdown-item" onclick="window.location.href='/owner-inventory'">🔍 Inventory Lookup</button>
      </div>
    </div>

    <!-- Promotions -->
    <div class="nav-item" style="position:relative">
      <button class="nav-btn" onclick="toggleDropdown('promotionsDropdown', this)">🎯 Promotions <span style="font-size:10px">▼</span></button>
      <div class="dropdown" id="promotionsDropdown">
        <div class="dropdown-header">Promotions</div>
        <button class="dropdown-item" onclick="window.location.href='/products-feed'">🆕 Products Feed</button>
        <button class="dropdown-item" onclick="window.location.href='/promotions'">📅 Sale Events &amp; Discounts</button>
      </div>
    </div>

    <!-- Purchases -->
    <div class="nav-item" style="position:relative">
      <button class="nav-btn" onclick="toggleDropdown('purchasesDropdown', this)">🛒 Purchases <span style="font-size:10px">▼</span></button>
      <div class="dropdown" id="purchasesDropdown">
        <div class="dropdown-header">Purchases</div>
        ${item('/pos',         '🛒', 'Purchase Orders')}
        ${item('/budgets',     '📒', 'Budget Report')}
        ${item('/gm-expenses', '💼', 'Expenses')}
        ${isHimRole ? `
        <div class="dropdown-header" style="margin-top:4px">Suppliers</div>
        <button class="dropdown-item" onclick="window.location.href='/distributor-prices'">🏭 Distributors & Prices</button>` : ''}
      </div>
    </div>

    <!-- To-Do / Task Manager -->
    ${isHimRole ? `
    <div class="nav-item" style="position:relative">
      <button class="nav-btn" onclick="toggleDropdown('todoDropdown', this)">✅ To-Do <span style="font-size:10px">▼</span></button>
      <div class="dropdown" id="todoDropdown">
        <div class="dropdown-header">Tasks</div>
        <button class="dropdown-item" onclick="window.location.href='${todoHref}'">✅ My To-Do</button>
        <button class="dropdown-item" onclick="window.location.href='/task-manager'">📋 Task Manager</button>
      </div>
    </div>` : `
    <div class="nav-item">
      <button class="nav-btn" onclick="window.location.href='${todoHref}'">✅ To-Do</button>
    </div>`}

    ${adminSection}`;
}

function loadNavbar() {
  const token = localStorage.getItem('token');
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  if (!document.querySelector('link[rel="icon"]')) {
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/png';
    favicon.href = '/logo-icon.png';
    document.head.appendChild(favicon);
  }

  if (!token) return;

  const navbarHTML = `
    <nav style="
      background: #1a1a2e;
      padding: 0 24px;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    ">
      <div style="display:flex;align-items:center;gap:8px;">
        <img src="/logo-wordmark.png" alt="Cloud 9 Vapor" style="height:34px;margin-right:16px;cursor:pointer" onclick="window.location.href='/dashboard'">
        <button class="nav-hamburger" id="navHamburger" onclick="toggleMobileMenu()" aria-label="Menu">☰</button>
        <div style="display:flex;align-items:center;gap:4px;" class="nav-items" id="navItems">
          ${buildNavItems(user)}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div class="nav-item" style="position:relative">
          <button class="nav-btn" id="notifBellBtn" onclick="toggleDropdown('notifDropdown', this)" style="position:relative;font-size:18px;padding:8px 12px;">
            🔔
            <span id="notifBadge" style="display:none;position:absolute;top:2px;right:2px;background:#e74c3c;color:white;font-size:10px;font-weight:700;border-radius:10px;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 3px;"></span>
          </button>
          <div class="dropdown" id="notifDropdown" style="right:0;left:auto;min-width:340px;max-width:380px;">
            <div class="dropdown-header" style="display:flex;justify-content:space-between;align-items:center;">
              <span>${['store_user', 'gm'].includes(user.role) ? 'My To-Do' : 'Notifications'}</span>
              <button onclick="markAllNotificationsRead(event)" style="background:none;border:none;color:#2f5597;font-size:11px;font-weight:700;cursor:pointer;text-transform:none;letter-spacing:normal;">Mark all read</button>
            </div>
            <div id="notifList" style="max-height:380px;overflow-y:auto;"><div style="padding:12px 16px;color:#999;font-size:13px">Loading...</div></div>
          </div>
        </div>
        <span style="background:#2f5597;color:white;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;">${user.name || user.email}</span>
        <button onclick="window.location.href='/settings'" style="background:transparent;color:#aaa;border:1px solid #444;padding:6px 14px;border-radius:20px;font-size:13px;cursor:pointer;">⚙️ Settings</button>
        <button onclick="logout()" style="background:transparent;color:#aaa;border:1px solid #444;padding:6px 14px;border-radius:20px;font-size:13px;cursor:pointer;">Logout</button>
      </div>
    </nav>
  `;

  document.body.insertAdjacentHTML('afterbegin', navbarHTML);

  const style = document.createElement('style');
  style.textContent = `
    .nav-btn {
      background: transparent;
      color: #ccc;
      border: none;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .nav-btn:hover, .nav-btn.active {
      background: rgba(255,255,255,0.1);
      color: white;
    }
    .dropdown {
      display: none;
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      background: white;
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      min-width: 210px;
      overflow: hidden;
      z-index: 200;
    }
    .dropdown.open { display: block; }
    .dropdown-header {
      padding: 10px 16px;
      font-size: 11px;
      font-weight: 700;
      color: #999;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: #f8f9fa;
      border-bottom: 1px solid #f0f0f0;
    }
    .dropdown-item {
      display: block;
      padding: 12px 16px;
      font-size: 13px;
      font-weight: 500;
      color: #333;
      cursor: pointer;
      transition: background 0.15s;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }
    .dropdown-item:hover { background: #f0f4ff; color: #2f5597; }

    .nav-hamburger {
      display: none;
      background: transparent;
      color: #ccc;
      border: 1px solid #444;
      border-radius: 8px;
      font-size: 18px;
      padding: 6px 10px;
      cursor: pointer;
      margin-right: 4px;
    }
    .nav-hamburger:hover { background: rgba(255,255,255,0.1); color: white; }

    @media (max-width: 1024px) {
      .nav-hamburger { display: inline-block; }
      .nav-items {
        display: none !important;
        position: fixed;
        top: 60px;
        left: 0;
        right: 0;
        background: #1a1a2e;
        flex-direction: column !important;
        align-items: stretch !important;
        padding: 8px 16px 16px;
        gap: 4px !important;
        max-height: calc(100vh - 60px);
        overflow-y: auto;
        box-shadow: 0 8px 16px rgba(0,0,0,0.2);
        z-index: 150;
      }
      .nav-items.open { display: flex !important; }
      .nav-items .nav-item { width: 100%; }
      .nav-items .nav-btn { width: 100%; text-align: left; }
      .nav-items .dropdown {
        position: static;
        box-shadow: none;
        width: 100%;
        margin-top: 4px;
        border: 1px solid #f0f0f0;
      }
    }

    /* Global responsive helpers */
    @media (max-width: 1024px) {
      .card table { display: block; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; }
      .perf-grid { grid-template-columns: 1fr !important; }
    }
    @media (max-width: 700px) {
      .card { padding: 12px !important; }
      h1 { font-size: 18px !important; }
    }
  `;
  document.head.appendChild(style);

  // Notifications / tasks polling
  if (['admin', 'him', 'regional_manager', 'owner', 'marketing'].includes(user.role)) {
    loadNotifications();
    if (window.__notifPollInterval) clearInterval(window.__notifPollInterval);
    window.__notifPollInterval = setInterval(loadNotifications, 30000);
  } else if (user.store_id) {
    loadStoreTasks(user.store_id);
    if (window.__tasksPollInterval) clearInterval(window.__tasksPollInterval);
    window.__tasksPollInterval = setInterval(() => loadStoreTasks(user.store_id), 60000);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-item')) closeAllDropdowns();
  });

  // Presence heartbeat — ping every 60s, track idle after 5min inactivity
  if (token) {
    let lastActivity = Date.now();
    const trackActivity = () => { lastActivity = Date.now(); };
    document.addEventListener('mousemove', trackActivity, { passive: true });
    document.addEventListener('keydown', trackActivity, { passive: true });
    document.addEventListener('click', trackActivity, { passive: true });

    function sendHeartbeat() {
      const idleMs = Date.now() - lastActivity;
      if (idleMs > 5 * 60 * 1000) return; // idle — skip, server will age out naturally
      fetch('/api/auth/heartbeat', {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + token }
      }).catch(() => {});
    }

    sendHeartbeat();
    if (window.__heartbeatInterval) clearInterval(window.__heartbeatInterval);
    window.__heartbeatInterval = setInterval(sendHeartbeat, 60000);
  }
}

function timeAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

async function loadNotifications() {
  const token = localStorage.getItem('token');
  try {
    const res = await fetch('/api/notifications', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return;
    const data = await res.json();
    const notifs = data.notifications || [];
    const badge = document.getElementById('notifBadge');
    const list = document.getElementById('notifList');
    if (!badge || !list) return;

    if (data.unread_count > 0) {
      badge.style.display = 'block';
      badge.textContent = data.unread_count > 99 ? '99+' : data.unread_count;
    } else {
      badge.style.display = 'none';
    }

    if (!notifs.length) {
      list.innerHTML = '<div style="padding:16px;color:#999;font-size:13px;text-align:center;">No notifications yet</div>';
      return;
    }

    list.innerHTML = notifs.map(n => `
      <div onclick="handleNotificationClick('${n.id}', ${n.link ? `'${n.link}'` : 'null'})" style="
        padding:12px 16px;
        border-bottom:1px solid #f0f0f0;
        cursor:pointer;
        background:${n.read ? 'white' : '#f0f4ff'};
        transition:background 0.15s;
      " onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='${n.read ? 'white' : '#f0f4ff'}'">
        <div style="font-size:13px;font-weight:700;color:#333;margin-bottom:2px;">${n.title}</div>
        <div style="font-size:12px;color:#666;line-height:1.4;">${n.message}</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px;">${timeAgo(n.created_at)}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Notifications error:', err);
  }
}

async function loadStoreTasks(storeId) {
  const token = localStorage.getItem('token');
  const badge = document.getElementById('notifBadge');
  const list = document.getElementById('notifList');
  if (!list) return;
  try {
    // Fetch store tasks + assigned tasks in parallel
    const [storeRes, assignedRes] = await Promise.all([
      fetch(`/api/store-tasks?store_id=${storeId}`, { headers: { 'Authorization': 'Bearer ' + token } }),
      fetch('/api/assigned-tasks/mine', { headers: { 'Authorization': 'Bearer ' + token } })
    ]);

    const storeTasks = storeRes.ok ? await storeRes.json() : [];
    const assignedData = assignedRes.ok ? await assignedRes.json() : { tasks: [] };
    const assignedTasks = assignedData.tasks || [];

    const totalCount = (Array.isArray(storeTasks) ? storeTasks.length : 0) + assignedTasks.length;

    if (totalCount === 0) {
      if (badge) badge.style.display = 'none';
      list.innerHTML = '<div style="padding:16px;color:#999;font-size:13px;text-align:center;">No pending tasks 🎉</div>';
      return;
    }
    if (badge) {
      badge.style.display = 'block';
      badge.textContent = totalCount > 99 ? '99+' : totalCount;
    }
    const today = new Date().toISOString().split('T')[0];

    // Render assigned tasks first (with 📋 tag)
    const assignedHtml = assignedTasks.map(t => {
      const isOverdue = t.due_date && t.due_date < today;
      const from = t.creator ? (t.creator.name || t.creator.email) : '';
      return `
        <div onclick="window.location.href='/task-manager'" style="
          padding:12px 16px;
          border-bottom:1px solid #f0f0f0;
          cursor:pointer;
          background:${isOverdue ? '#fff5f5' : '#f0f4ff'};
          transition:background 0.15s;
        " onmouseover="this.style.background='#e8efff'" onmouseout="this.style.background='${isOverdue ? '#fff5f5' : '#f0f4ff'}'">
          <div style="font-size:13px;font-weight:700;color:#333;margin-bottom:2px;">📋 ${t.title}</div>
          ${from ? `<div style="font-size:12px;color:#666;">From: ${from}</div>` : ''}
          ${t.due_date ? `<div style="font-size:11px;color:${isOverdue ? '#dc2626' : '#aaa'};margin-top:4px;">${isOverdue ? '⚠️ Overdue · ' : ''}Due ${t.due_date}</div>` : ''}
        </div>`;
    }).join('');
    // Render store tasks
    const storeHtml = (Array.isArray(storeTasks) ? storeTasks : []).map(t => {
      const isOverdue = t.due_date && t.due_date < today;
      const icon = t.task_type === 'sale_proposal' ? '\u{1f3af}' : '\u{1f4e6}';
      const link = t.task_type === 'sale_proposal' && t.reference_id
        ? `/sale-proposal?id=${t.reference_id}`
        : `/store-tasks?store=${storeId}`;
      return `
        <div onclick="window.location.href='${link}'" style="
          padding:12px 16px;
          border-bottom:1px solid #f0f0f0;
          cursor:pointer;
          background:${isOverdue ? '#fff5f5' : 'white'};
          transition:background 0.15s;
        " onmouseover="this.style.background='#f0f4ff'" onmouseout="this.style.background='${isOverdue ? '#fff5f5' : 'white'}'">
          <div style="font-size:13px;font-weight:700;color:#333;margin-bottom:2px;">${icon} ${t.title}</div>
          ${t.description ? `<div style="font-size:12px;color:#666;">${t.description}</div>` : ''}
          ${t.due_date ? `<div style="font-size:11px;color:${isOverdue ? '#dc2626' : '#aaa'};margin-top:4px;">${isOverdue ? '\u26a0\ufe0f Overdue \u00b7 ' : ''}Due ${t.due_date}</div>` : ''}
        </div>`;
    }).join('');

    list.innerHTML = assignedHtml + storeHtml;
  } catch (err) {
    console.error('Store tasks error:', err);
  }
}

async function handleNotificationClick(id, link) {
  const token = localStorage.getItem('token');
  try {
    await fetch(`/api/notifications/${id}/read`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token }
    });
  } catch (err) {
    console.error('Mark read error:', err);
  }
  if (link) {
    window.location.href = link;
  } else {
    loadNotifications();
  }
}

async function markAllNotificationsRead(event) {
  if (event) event.stopPropagation();
  const token = localStorage.getItem('token');
  try {
    await fetch('/api/notifications/read-all', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    loadNotifications();
  } catch (err) {
    console.error('Mark all read error:', err);
  }
}

function toggleMobileMenu() {
  const items = document.getElementById('navItems');
  if (items) items