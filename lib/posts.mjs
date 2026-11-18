// Posts (announcements and questions) and comments, for signed-in members.
import {currentMember} from './auth.mjs';
import {addComment, addPost} from './actions.mjs';
import {appBase} from './email.mjs';
import {allow} from './limits.mjs';
import {flush} from './outbox.mjs';

const HOUR = 3600000;
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});
const uuid = value => /^[a-f0-9-]{36}$/.test(value ?? '');
const label = r => r.name || r.email.split('@')[0];

export async function posts(request, db, mailer = null, defer = null, now = Date.now()) {
  let queued = false;
  const response = await handle();
  if (queued && mailer && defer) defer(flush(db, mailer).catch(error => console.error('Outbox flush failed', error.code ?? error.name)));
  return response;

  async function handle() {
    const url = new URL(request.url), base = appBase(request), action = url.searchParams.get('action') || '';
    const run = (sql, ...args) => db.prepare(sql).bind(...args);
    const me = await currentMember(request, db, now);
    if (!me) return json({error: 'Sign in to see posts.'}, 401);
    const organizer = me.role === 'organizer';

    if (request.method === 'GET') {
      const postId = url.searchParams.get('post');
      if (postId) {
        if (!uuid(postId)) return json({error: 'Post not found.'}, 404);
        const p = await run('SELECT p.*,m.name,m.email FROM posts p JOIN members m ON m.id=p.author WHERE p.id=? AND (p.hidden=false OR ?)', postId, organizer).first();
        if (!p) return json({error: 'Post not found.'}, 404);
        const comments = (await run(`SELECT c.id,c.body,c.via,c.created,c.author,c.hidden,m.name,m.email FROM comments c JOIN members m ON m.id=c.author
          WHERE c.kind='post' AND c.target=? AND (c.hidden=false OR ?) ORDER BY c.created`, postId, organizer).all()).results;
        return json({me: {id: me.id, role: me.role}, post: {id: p.id, title: p.title, body: p.body, pinned: p.pinned, hidden: p.hidden, created: Number(p.created), author: label(p), mine: p.author === me.id,
          comments: comments.map(c => ({id: c.id, body: c.body, via: c.via, created: Number(c.created), author: label(c), mine: c.author === me.id, hidden: c.hidden}))}});
      }
      const list = (await run(`SELECT p.id,p.title,p.body,p.pinned,p.hidden,p.created,p.author,m.name,m.email,
          (SELECT COUNT(*)::integer FROM comments c WHERE c.kind='post' AND c.target=p.id AND c.hidden=false) AS replies,
          GREATEST(p.created, COALESCE((SELECT MAX(c.created) FROM comments c WHERE c.kind='post' AND c.target=p.id AND c.hidden=false), 0)) AS active
        FROM posts p JOIN members m ON m.id=p.author WHERE p.hidden=false OR ? ORDER BY p.pinned DESC, active DESC LIMIT 50`, organizer).all()).results;
      return json({posts: list.map(p => ({id: p.id, title: p.title, excerpt: p.body.slice(0, 240), pinned: p.pinned, hidden: p.hidden,
        created: Number(p.created), active: Number(p.active), author: label(p), replies: p.replies, mine: p.author === me.id}))});
    }

    if (request.method !== 'POST') return json({error: 'Method unavailable.'}, 405);
    if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) return json({error: 'Invalid request.'}, 403);
    const raw = await request.text();
    if (raw.length > 20000) return json({error: 'This is too long.'}, 413);
    let input;
    try { input = JSON.parse(raw) ?? {}; } catch { return json({error: 'Invalid entry.'}, 400); }

    if (action === 'create') {
      if (!await allow(db, 'post:' + me.id, 10, HOUR, now)) return json({error: 'Too many posts. Try again in an hour.'}, 429);
      const result = await addPost(db, me.id, input, {mailer, base, now});
      if (result.error) return json({error: result.error}, result.status);
      if (result.queued) queued = true;
      return json({ok: true, id: result.id}, 201);
    }
    if (action === 'comment') {
      if (!await allow(db, 'comment:' + me.id, 60, HOUR, now)) return json({error: 'Too many comments. Try again in an hour.'}, 429);
      if (!uuid(input.target)) return json({error: 'Invalid comment.'}, 400);
      const result = await addComment(db, me.id, {kind: input.kind, target: input.target, body: input.body}, {mailer, base, now});
      if (result.error) return json({error: result.error}, result.status);
      if (result.queued) queued = true;
      return json({ok: true, id: result.id}, 201);
    }
    if (action === 'delete-comment' || action === 'hide-comment') {
      if (!uuid(input.comment)) return json({error: 'Invalid comment.'}, 400);
      const c = await run('SELECT id,author FROM comments WHERE id=?', input.comment).first();
      if (!c) return json({error: 'Comment not found.'}, 404);
      if (action === 'hide-comment' ? !organizer : !(organizer || c.author === me.id)) return json({error: 'Only organizers or the author can do that.'}, 403);
      if (action === 'delete-comment') await run('DELETE FROM comments WHERE id=?', c.id).run();
      else await run('UPDATE comments SET hidden=? WHERE id=?', !!input.hidden, c.id).run();
      return json({ok: true});
    }
    if (!uuid(input.post)) return json({error: 'Post not found.'}, 404);
    const post = await run('SELECT id,author FROM posts WHERE id=?', input.post).first();
    if (!post) return json({error: 'Post not found.'}, 404);
    if (action === 'delete') {
      if (!(organizer || post.author === me.id)) return json({error: 'Only organizers or the author can delete a post.'}, 403);
      await run("DELETE FROM comments WHERE kind='post' AND target=?", post.id).run();
      await run("DELETE FROM reply_keys WHERE kind='post' AND target=?", post.id).run();
      await run('DELETE FROM posts WHERE id=?', post.id).run();
      return json({ok: true});
    }
    if (!organizer) return json({error: 'Only organizers can do that.'}, 403);
    if (action === 'pin') await run('UPDATE posts SET pinned=? WHERE id=?', !!input.pinned, post.id).run();
    else if (action === 'hide') await run('UPDATE posts SET hidden=? WHERE id=?', !!input.hidden, post.id).run();
    else return json({error: 'This action is unavailable.'}, 404);
    return json({ok: true});
  }
}

