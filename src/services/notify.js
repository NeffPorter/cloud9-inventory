const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Create a notification for admins (or a specific store's managers, if store_id given
// and target_role is 'manager'). type/title/message/link are free-form.
async function notify({ type, title, message, link = null, store_id = null, target_role = 'admin' }) {
  try {
    await supabase.from('notifications').insert([{
      type, title, message, link, store_id, target_role, read: false
    }]);
  } catch (err) {
    console.error('notify() error:', err.message);
  }
}

// Record an entry in the admin activity log.
// actor: the req.user object (has name/email/role)
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
