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

          <div class="nav-item" style="position:relative">
            <button class="nav-btn" onclick="toggleDropdown('inventoryDropdown', this)">📦 Inventory <span style="font-size:10px">▼</span></button>
            <div class="dropdown" id="inventoryDropdown">
              <div class="dropdown-header">By Store</div>
              <div id="inventoryStoreList"><div style="padding:12px 16px;color:#999;font-size:13px">Loading...</div></div>
            </div>
          </div>

          <div class="nav-item" style="position:relative">
            <button class="nav-btn" onclick="toggleDropdown('poDropdown', this)">🛒 Purchase Orders <span style="font-size:10px">▼</span></button>
            <div class="dropdown" id="poDropdown">
              <div class="dropdown-header">By Store</div>
              <div id="poStoreList"><div style="padding:12px 16px;color:#999;font-size:13px">Loading...</div></div>
            </div>
          </div>

          <div class="nav-item" style="position:relative">
            <button class="nav-btn" onclick="toggleDropdown('suggestedDropdown', this)">📋 Purchase Planner <span style="font-size:10px">▼</span></button>
            <div class="dropdown" id="suggestedDropdown">
              <div class="dropdown-header">By Store</div>
              <div id="suggestedStoreList"><div style="padding:12px 16px;color:#999;font-size:13px">Loading...</div></div>
            </div>
          </div>

          <div class="nav-item" style="position:relative">
            <button class="nav-btn" onclick="toggleDropdown('budgetDropdown', this)">💰 Budget Reports <span style="font-size:10px">▼</span></button>
            <div class="dropdown" id="budgetDropdown">
              <div class="dropdown-header">By Store</div>
              <div id="budgetStoreList"><div style="padding:12px 16px;color:#999;font-size:13px">Loading...</div></div>
            </div>
          </div>

          <div class="nav-item" style="position:relative">
            <button class="nav-btn" onclick="window.location.href='/stocktake'">📋 Stock Take</button>
          </div>
          <div class="nav-item" style="position:relative">
            <button class="nav-btn" onclick="window.location.href='/sales'">📊 Sales</button>
          </div>
          ${user.role === 'admin' ? `
          <div class="nav-item" style="position:relative">
            <button class="nav-btn" onclick="toggleDropdown('adminDropdown', this)">⚙️ Admin <span style="font-size:10px">▼</span></button>
            <div class="dropdown" id="adminDropdown">
              <div class="dropdown-header">Management</div>
              <button class="dropdown-item" onclick="window.location.href='/stores'">🏪 Manage Stores</button>
              <button class="dropdown-item" onclick="window.location.href='/users'">👥 Manage Users</button>
              <button class="dropdown-item" onclick="window.location.href='/distributors'">🏭 Distributors & Prices</button>
              <button class="dropdown-item" onclick="window.location.href='/activity-log'">📜 Activity Log</button>
            </div>
          </div>
          ` : ''}

        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        ${user.role === 'admin' ? `
        <div class="nav-item" style="position:relative">
          <button class="nav-btn" id="notifBellBtn" onclick="toggleDropdown('notifDropdown', this)" style="position:relative;font-size:18px;padding:8px 12px;">
            🔔
            <span id="notifBadge" style="display:none;position:absolute;top:2px;right:2px;background:#e74c3c;color:white;font-size:10px;font-weight:700;border-radius:10px;min-width:16px;height:16px;line-height:16px;text-align:center;padding:0 3px;"></span>
          </button>
          <div class="dropdown" id="notifDropdown" style="right:0;left:auto;min-width:340px;max-width:380px;">
            <div class="dropdown-header" style="display:flex;justify-content:space-between;align-items:center;">
              <span>Notifications</span>
              <button onclick="markAllNotificationsRead(event)" style="background:none;border:none;color:#2f5597;font-size:11px;font-weight:700;cursor:pointer;text-transform:none;letter-spacing:normal;">Mark all read</button>
            </div>
            <div id="notifList" style="max-height:360px;overflow-y:auto;"><div style="padding:12px 16px;color:#999;font-size:13px">Loading...</div></div>
          </div>
        </div>
        ` : ''}
        <span style="background:#2f5597;color:white;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:600;">${user.name || user.email}</span>
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
      min-width: 200px;
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

  loadNavbarStores();

  if (user.role === 'admin') {
    loadNotifications();
    if (window.__notifPollInterval) clearInterval(window.__notifPollInterval);
    window.__notifPollInterval = setInterval(loadNotifications, 30000);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-item')) closeAllDropdowns();
  });
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
  if (items) items.classList.toggle('open');
}

function toggleDropdown(id, btn) {
  const dropdown = document.getElementById(id);
  const isOpen = dropdown.classList.contains('open');
  closeAllDropdowns();
  if (!isOpen) {
    dropdown.classList.add('open');
    btn.classList.add('active');
  }
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
}

async function loadNavbarStores() {
  const token = localStorage.getItem('token');
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  try {
    const res = await fetch('/api/inventory/stores', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    const stores = data.stores || [];

    if (stores.length === 1) {
      const store = stores[0];

      document.getElementById('inventoryStoreList').closest('.nav-item').outerHTML = `
        <div class="nav-item" style="position:relative">
          <button class="nav-btn" onclick="window.location.href='/inventory?store=${store.id}'">📦 Inventory</button>
        </div>`;

      document.getElementById('poStoreList').closest('.nav-item').outerHTML = `
        <div class="nav-item" style="position:relative">
          <button class="nav-btn" onclick="window.location.href='/pos?store=${store.id}'">🛒 Purchase Orders</button>
        </div>`;

      document.getElementById('suggestedStoreList').closest('.nav-item').outerHTML = `
        <div class="nav-item" style="position:relative">
          <button class="nav-btn" onclick="window.location.href='/suggested?store=${store.id}'">📋 Purchase Planner</button>
        </div>`;

      document.getElementById('budgetStoreList').closest('.nav-item').outerHTML = `
        <div class="nav-item" style="position:relative">
          <button class="nav-btn" onclick="window.location.href='/budgets?store=${store.id}'">💰 Budget Reports</button>
        </div>`;

    } else {
      const inventoryLinks = stores.map(s =>
        `<button class="dropdown-item" onclick="window.location.href='/inventory?store=${s.id}'">${s.name}</button>`
      ).join('') || '<div style="padding:12px 16px;color:#999;font-size:13px">No stores yet</div>';

      const poLinks = stores.map(s =>
        `<button class="dropdown-item" onclick="window.location.href='/pos?store=${s.id}'">${s.name}</button>`
      ).join('') || '<div style="padding:12px 16px;color:#999;font-size:13px">No stores yet</div>';

      const suggestedLinks = stores.map(s =>
        `<button class="dropdown-item" onclick="window.location.href='/suggested?store=${s.id}'">${s.name}</button>`
      ).join('') || '<div style="padding:12px 16px;color:#999;font-size:13px">No stores yet</div>';

      const budgetLinks = stores.map(s =>
        `<button class="dropdown-item" onclick="window.location.href='/budgets?store=${s.id}'">${s.name}</button>`
      ).join('') || '<div style="padding:12px 16px;color:#999;font-size:13px">No stores yet</div>';

      document.getElementById('inventoryStoreList').innerHTML = inventoryLinks;
      document.getElementById('poStoreList').innerHTML = poLinks;
      document.getElementById('suggestedStoreList').innerHTML = suggestedLinks;
      document.getElementById('budgetStoreList').innerHTML = budgetLinks;
    }
  } catch (err) {
    console.error('Navbar stores error:', err);
  }
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/';
}