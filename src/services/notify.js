const supabase = require('../lib/supabase');
const { sendNotificationEmail } = require('./email');
const { HIM_ROLES } = require('../lib/roles');

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
    let recipientEmails = [];

    if (target_role && (HIM_ROLES.includes(target_role) || target_role === 'admin')) {
      // Send to all HIM / Regional Manager accounts
      const { data: users } = await supabase
        .from('users')
        .select('email')
        .in('role', ['regional_manager', 'him', 'admin']);
      recipientEmails = (users || []).map(u => u.email).filter(Boolean);

    } else if (target_store_id) {
      // Send to IM and GM of that specific store
      const { data: users } = await supabase
        .from('users')
        .select('email')
        .eq('store_id', target_store_id)
        .in('role', ['store_user', 'gm']);
      recipientEmails = (users || []).map(u => u.email).filter(Boolean);
    }

    if (recipientEmails.length) {
      await sendNotificationEmail({ recipients: recipientEmails, title, message, link });
    }
  } catch (err) {
    console.error('notify() error:', err.message);
  }
}

// Record an entry in the admin activity log.
async function logActivity({ actor, action, description, store_id = null, metadata = null }) {
  try {
    await supabase.from('activity_log').insert([{
      actor_name: actor?.name || actor?.email || 'System',
      actor_email: actor?.email || null,
      actor_role: actor?.role || null,
      action,
      description,
      store_id,
      metadata
    }]);
  } catch (err) {
    console.error('logActivity() error:', err.message);
  }
}

module.exports = { notify, logActivity };
