function loadNavbar() {
  const token = localStorage.getItem('token');
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  
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
        <h1 style="color:white;font-size:20px;font-weight:800;margin-right:16px;cursor:pointer" onclick="window.location.href='/dashboard'">☁️ Cloud 9</h1>
        <div style="display:flex;align-items:center;gap:4px;">

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
            </div>
          </div>
          ` : ''}

        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
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
  `;
  document.head.appendChild(style);

  loadNavbarStores();

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-item')) closeAllDropdowns();
  });
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

      document.getElementById('inventoryStoreList').innerHTML = inventoryLinks;
      document.getElementById('poStoreList').innerHTML = poLinks;
      document.getElementById('suggestedStoreList').innerHTML = suggestedLinks;
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