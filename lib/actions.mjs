// What members do, shared by the site and by email replies so both follow
// exactly the same rules. Each returns {ok: true, ...} or {error, status}.
import {commentEmail, postEmail} from './email.mjs';
import {enqueue} from './outbox.mjs';
import {replyAddress, replyKey} from './replies.mjs';

const fail = (error, status = 400) => ({error, status});
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';

export async function castVote(db, memberId, topicId, value) {
  if (![1, 0, -1].includes(value)) return fail('Invalid vote.');
  const topic = await db.prepare(`SELECT t.id,t.author,t.meeting,m.phase FROM topics t JOIN meetings m ON m.id=t.meeting WHERE t.id=? AND t.hidden=false`).bind(topicId).first();
  if (!topic) return fail('That topic is unavailable.', 409);
  if (topic.phase === 'agenda') return fail('Voting is closed.', 409);
  const voter = 'm:' + memberId;
  if (topic.author === voter) return fail('You can’t vote on your own topic.', 403);
  if (value === 0) await db.prepare('DELETE FROM ballots WHERE topic=? AND voter=?').bind(topic.id, voter).run();
  else await db.prepare(`INSERT INTO ballots (topic,meeting,voter,value) VALUES (?,?,?,?) ON CONFLICT (topic,voter) DO UPDATE SET value=excluded.value`)
    .bind(topic.id, topic.meeting, voter, value).run();
  return {ok: true};
}

export async function setRsvp(db, memberId, meetingId, status, reason, now = Date.now()) {
  if (!['yes', 'maybe', 'no'].includes(status)) return fail('Choose Going, Maybe or Can’t make it.');
  reason = clean(reason, 500);
  if (status === 'no' && reason.length < 3) return fail('Please say why you can’t make it.');
  const meeting = await db.prepare('SELECT id FROM meetings WHERE id=?').bind(meetingId).first();
  if (!meeting) return fail('Meeting not found.', 404);
  await db.prepare(`INSERT INTO rsvps (meeting,member,status,reason,updated) VALUES (?,?,?,?,?)
    ON CONFLICT (meeting,member) DO UPDATE SET status=excluded.status, reason=excluded.reason, updated=excluded.updated`)
    .bind(meetingId, memberId, status, status === 'yes' ? '' : reason, now).run();
  return {ok: true};
}

export async function addTopic(db, memberId, meetingId, {label, detail, kind}, now = Date.now()) {
  label = clean(label, 120);
  if (!label) return fail('Enter a topic.');
  kind = ['Discussion', 'Decision', 'Update'].includes(kind) ? kind : 'Discussion';
  const result = await db.prepare(`INSERT INTO topics (id,meeting,label,detail,kind,created,announced,author) SELECT ?,id,?,?,?,?,false,? FROM meetings WHERE id=? AND phase='collect'`)
    .bind(crypto.randomUUID(), label, clean(detail, 650), kind, now, 'm:' + memberId, meetingId).run();
  if (!result.meta.changes) return fail('Topic submissions are closed.', 409);
  return {ok: true};
}

// What a comment is about: its title and the page it lives on.
export async function threadOf(db, kind, target) {
  if (kind === 'post') {
    const post = await db.prepare('SELECT id,title,author FROM posts WHERE id=? AND hidden=false').bind(target).first();
    return post && {title: post.title, path: '#post/' + post.id, author: post.author};
  }
  if (kind === 'meeting') {
    const meeting = await db.prepare('SELECT id,title FROM meetings WHERE id=?').bind(target).first();
    return meeting && {title: meeting.title, path: '#' + meeting.id};
  }
  if (kind === 'topic') {
    const topic = await db.prepare('SELECT t.id,t.label,t.meeting,t.author FROM topics t WHERE t.id=? AND t.hidden=false').bind(target).first();
    return topic && {title: topic.label, path: '#' + topic.meeting, author: topic.author?.replace(/^m:/, '')};
  }
  return null;
}

// Members who want everything right away, except the person who wrote it.
async function instantMembers(db, except) {
  return (await db.prepare(`SELECT id,email,name,token,'m:'||id AS voter FROM members
    WHERE status='active' AND emails='all' AND digest='instant' AND id<>? ORDER BY email`).bind(except).all()).results;
}

export async function addComment(db, memberId, {kind, target, body, via = 'web'}, {mailer, base, now = Date.now()} = {}) {
  if (!['post', 'meeting', 'topic'].includes(kind)) return fail('Invalid comment.');
  body = clean(body, 3000);
  if (!body) return fail('Write something first.');
  const thread = await threadOf(db, kind, target);
  if (!thread) return fail('That conversation is unavailable.', 404);
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO comments (id,kind,target,author,body,via,created) VALUES (?,?,?,?,?,?,?)').bind(id, kind, target, memberId, body, via, now).run();
  let queued = 0;
  if (mailer && base) {
    const author = await db.prepare('SELECT name,email FROM members WHERE id=?').bind(memberId).first();
    const messages = [];
    for (const sub of await instantMembers(db, memberId)) {
      const key = await replyKey(db, sub.id, kind, target, now);
      messages.push(commentEmail({sub, base, thread, author, body, replyTo: replyAddress(key)}));
    }
    queued = await enqueue(db, '', messages, now);
  }
  return {ok: true, id, queued};
}

export async function addPost(db, memberId, {title, body}, {mailer, base, now = Date.now()} = {}) {
  title = clean(title, 140); body = clean(body, 6000);
  if (!title) return fail('Give your post a title.');
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO posts (id,author,title,body,created) VALUES (?,?,?,?,?)').bind(id, memberId, title, body, now).run();
  let queued = 0;
  if (mailer && base) {
    const author = await db.prepare('SELECT name,email FROM members WHERE id=?').bind(memberId).first();
    const messages = [];
    for (const sub of await instantMembers(db, memberId)) {
      const key = await replyKey(db, sub.id, 'post', id, now);
      messages.push(postEmail({sub, base, post: {id, title, body}, author, replyTo: replyAddress(key)}));
    }
    queued = await enqueue(db, '', messages, now);
  }
  return {ok: true, id, queued};
}

// Carries out an email reply (see replies.mjs) with the rules above.
export function emailActions(db, {mailer, base} = {}) {
  return async ({member, kind, target, vote, rsvp, reason, topic, comment}) => {
    const done = [];
    const say = (what, result) => done.push(what + ': ' + (result.error ?? 'ok'));
    if (vote !== undefined && kind === 'topic') say('vote', await castVote(db, member, target, vote));
    if (rsvp && kind === 'meeting') say('rsvp', await setRsvp(db, member, target, rsvp, reason));
    if (topic && kind === 'meeting') say('topic', await addTopic(db, member, target, topic));
    if (comment) say('comment', await addComment(db, member, {kind, target, body: comment, via: 'email'}, {mailer, base}));
    return done.join(', ') || 'nothing to do';
  };
}
