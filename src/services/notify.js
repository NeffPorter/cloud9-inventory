const supabase = require('../lib/supabase');
const { sendNotificationEmail } = require('./email');
const { HIM_ROLES } = require('../lib/roles');

// Mandatory notification types — always send regardless of prefs
const MANDATORY_TYPES = new Set([
  'sale_proposal_assigned',
  'sale_proposal_revision',
  'sale_proposal_submitted',
  'po_approval_needed',
]);

// Map notification type → pref key (for optional types)
const TYPE_TO_PREF = {
  'low_stock':           'low_stock',
  'po_approved':         'po_approved',
  'budget_warning':      'budget_warning',
  'sale_event_starting': 'sale_event_starting',
  'stocktake_due':       'stocktake_due',
  'stocktake_complete':  'stocktake_complete',
  'budget_complete':     'budget_complete',
  'pl_monthly':          'pl_monthly',
  'pl_quarterly':        'pl_quarterly',
  'weekly_digest':       'weekly_digest',
};

// Create a notification and optionally email the relevant users.
async function notify({ type, title, message, link = null, store_id = null, target_role = null, target_store_id = null }) {
  try {
    await supabase.from('notifications').insert([{
      type, title, message, link, store_id,
      target_role,
      target_store_id: target_store_id || null,
      read: false
    }]);

    // --- Email delivery ---
    // Determine who should receive the email
    let users = [];

    if (target_role && (HIM_ROLES.includes(target_role) || target_role === 'admin')) {
      const { data } = await supabase
        .from('users')
        .select('email, notification_prefs')
        .in('role', ['regional_manager', 'him', 'admin']);
      users = data || [];

    } else if (target_store_id) {
      const { data } = await supabase
        .from('users')
        .select('email, notification_prefs')
        .eq('store_id', target_store_id)
        .in('role', ['store_user', 'gm']);
      users = data || [];
      console.log(`[notify] store=${target_store_id} found ${users.length} recipient(s):`, users.map(u => u.email));
    }

    // Filter by notification prefs (skip for mandatory types)
    const isMandatory = MANDATORY_TYPES.has(type);
    const prefKey = TYPE_TO_PREF[type];

    const recipientEmails = users
      .filter(u => {
        if (isMandatory) return true; // mandatory — always send
        if (!prefKey) return true;    // unknown type — defau