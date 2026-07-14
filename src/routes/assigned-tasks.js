const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../lib/supabase');
const { sendEmail } = require('../services/email');

const CREATOR_ROLES = ['regional_manager', 'him', 'admin'];

function requireCreator(req, res, next) {
  if (!CREATOR_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Notify a specific user in their notification bell + email
async function notifyUser({ userId, userEmail, userName, title, message, link }) {
  // In-app notification (target_user_id)
  try {
    await supabase.from('notifications').insert([{
      type: 'assigned_task',
      title,
      message,
      link: link || null,
      target_user_id: userId,
      read: false
    }]);
  } catch (err) {
    console.error('[assigned-tasks] notify insert error:', err.message);
  }

  // Email
  try {
    if (userEmail) {
      await sendEmail({
        to: userEmail,
        subject: title,
        html: `<p>Hi ${userName || 'there'},</p><p>${message}</p>${link ? `<p><a href="${link}">View Task</a></p>` : ''}<p>— Cloud 9 Systems</p>`,
        text: message
      });
    }
  } catch (err) {
    console.error('[assigned-tasks] email error:', err.message);
  }
}

// Notify all HIM/admin/rm roles about a completion
async function notifyManagers({ title, message, link, excludeUserId }) {
  try {
    const { data: managers } = await supabase
      .from('users')
      .select('id, email, name')
      .in('role', ['regional_manager', 'him', 'admin']);

    for (const mgr of managers || []) {
      if (mgr.id === excludeUserId) continue;
      await supabase.from('notifications').insert([{
        type: 'assigned_task_complete',
        title,
        message,
        link: link || null,
        target_user_id: mgr.id,
        read: false
      }]);
      if (mgr.email) {
        await sendEmail({
          to: mgr.email,
          subject: title,
          html: `<p>${message}</p>${link ? `<p><a href="${link}">View in Task Manager</a></p>` : ''}<p>— Cloud 9 Systems</p>`,
          text: message
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[assigned-tasks] notifyManagers error:', err.message);
  }
}

// ── POST /api/assigned-tasks — create a task ──────────────────────────────────
router.post('/', auth, requireCreator, async (req, res) => {
  try {
    const { title, description, due_date, assigned_to, store_id } = req.body;
    if (!title || !assigned_to) return res.status(400).json({ error: 'title and assigned_to required' });

    // Lookup assignee
    const { data: assignee } = await supabase
      .from('users')
      .select('id, name, email, store_id')
      .eq('id', assigned_to)
      .single();
    if (!assignee) return res.status(404).json({ error: 'Assignee not found' });

    const { data: task, error } = await supabase
      .from('assigned_tasks')
      .insert([{
        title,
        description: description || null,
        due_date: due_date || null,
        assigned_to,
        assigned_by: req.user.id,
        store_id: store_id || assignee.store_id || null,
        status: 'pending'
      }])
      .select()
      .single();

    if (error) throw error;

    const creatorName = req.user.name || req.user.email;
    const dueStr = due_date ? ` Due: ${due_date}.` : '';
    await notifyUser({
      userId: assignee.id,
      userEmail: assignee.email,
      userName: assignee.name,
      title: `📋 New task assigned: ${title}`,
      message: `${creatorName} assigned you a task: "${title}".${dueStr}${description ? ' ' + description : ''}`,
      link: '/task-manager'
    });

    res.json({ task });
  } catch (err) {
    console.error('Create assigned task error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/assigned-tasks — list tasks ─────────────────────────────────────
// Creators see tasks they assigned. Assignees see tasks assigned to them.
router.get('/', auth, async (req, res) => {
  try {
    const isCreator = CREATOR_ROLES.includes(req.user.role);

    let query = supabase
      .from('assigned_tasks')
      .select(`
        *,
        assignee:assigned_to(id, name, email, role),
        creator:assigned_by(id, name, email, role)
      `)
      .order('created_at', { ascending: false });

    if (isCreator) {
      // Admins/HIM/RM see everything they created; HIM/RM see all tasks
      if (req.user.role === 'admin') {
        query = query.eq('assigned_by', req.user.id);
      }
      // him/regional_manager see all tasks
    } else {
      // Regular users see only their own assigned tasks
      query = query.eq('assigned_to', req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ tasks: data || [] });
  } catch (err) {
    console.error('List assigned tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/assigned-tasks/mine — tasks assigned to me (for bell) ────────────
router.get('/mine', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('assigned_tasks')
      .select(`*, creator:assigned_by(id, name, email)`)
      .eq('assigned_to', req.user.id)
      .eq('status', 'pending')
      .order('due_date', { ascending: true, nullsFirst: false });

    if (error) throw error;
    res.json({ tasks: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/assigned-tasks/:id/complete — mark complete ─────────────────────
router.put('/:id/complete', auth, async (req, res) => {
  try {
    const { data: task, error: fetchErr } = await supabase
      .from('assigned_tasks')
      .select(`*, assignee:assigned_to(id, name, email), creator:assigned_by(id, name, email)`)
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !task) return res.status(404).json({ error: 'Task not found' });

    // Only assignee or creator/manager can mark complete
    const isAssignee = task.assigned_to === req.user.id;
    const isManager = CREATOR_ROLES.includes(req.user.role);
    if (!isAssignee && !isManager) return res.status(403).json({ error: 'Forbidden' });

    const { error } = await supabase
      .from('assigned_tasks')
      .update({ status: 'complete', completed_at: new Date().toISOString() })
      .eq('id', req.params.id);

    if (error) throw error;

    // Notify all managers
    const completedBy = req.user.name || req.user.email;
    const assigneeName = task.assignee?.name || task.assignee?.email || 'User';
    await notifyManagers({
      title: `✅ Task completed: ${task.title}`,
      message: `"${task.title}" was marked complete by ${completedBy} (assigned to ${assigneeName}).`,
      link: '/task-manager',
      excludeUserId: req.user.id
    });

    // Also notify the original creator if they're not a manager
    if (!CREATOR_ROLES.includes('gm') && task.creator && task.creator.id !== req.user.id) {
      if (!CREATOR_ROLES.includes(task.creator.role || '')) {
        // creator is not already getting manager notification
        await notifyUser({
          userId: task.creator.id,
          userEmail: task.creator.email,
          userName: task.creator.name,
          title: `✅ Task completed: ${task.title}`,
          message: `"${task.title}" was marked complete by ${completedBy}.`,
          link: '/task-manager'
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Complete assigned task error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/assigned-tasks/:id — delete a task ───────────────────────────
router.delete('/:id', auth, requireCreator, async (req, res) => {
  try {
    const { error } = await supabase
      .from('assigned_tasks')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
