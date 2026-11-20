import fs from 'node:fs';

const PUBLIC = 'bfipbf/SILENT-PBF';
const PRIVATE = 'bfipbf/PRIVATE-PBF';
const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const issue = ev.issue;
const n = issue?.number;
if (!Number.isInteger(n) || issue.pull_request) throw Error('Invalid issue event');
const actor = ev.sender?.login;
const allowed = new Set(['bfipbf', '098595', 'jimmytobing']);
if (!allowed.has(actor) || !allowed.has(issue.user?.login)) {
  throw Error('BLOCKED: actor or issue author is not allowlisted');
}
const pubToken = process.env.PUBLIC_TOKEN;
const privToken = process.env.PRIVATE_TOKEN;
if (!pubToken || !privToken) throw Error('BLOCKED: required token missing');
const marker = '<!-- silent-pbf-issue:' + n + ' -->';
const purl = 'https://github.com/' + PUBLIC + '/issues/' + n;
const safe = s => String(s ?? '').slice(0, 50000);
const header = 'Source: [' + PUBLIC + '#' + n + '](' + purl + ')\n\n' + marker;
async function api(repo, token, route, method='GET', body) {
  const res = await fetch('https://api.github.com/repos/' + repo + route, {
    method,
    headers: { Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'silent-pbf-mirror' },
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  if (!res.ok) {
    // Never print response bodies from private GitHub.
    throw Error('GitHub ' + repo + ' ' + method + ' ' + route.split('?')[0] + ' HTTP ' + res.status);
  }
  return res.status === 204 ? null : res.json();
}
async function pages(repo, token, route) {
  const all = [];
  for (let p=1; p<=20; p++) {
    const sep = route.includes('?') ? '&' : '?';
    const data = await api(repo, token, route + sep + 'per_page=100&page=' + p);
    if (!Array.isArray(data)) throw Error('Expected array response');
    all.push(...data);
    if (data.length<100) return all;
  }
  throw Error('Pagination limit exceeded; refusing duplicate');
}
const matches = (await pages(PRIVATE, privToken, '/issues?state=all'))
  .filter(x=>!x.pull_request && typeof x.body==='string' && x.body.includes(marker));
if(matches.length>1) throw Error('Duplicate private mirrors detected; manual intervention');
let target = matches[0];
const mirroredBody = header; // Keep request payload only in per-run evidence comments.
if (!target) {
  target = await api(PRIVATE,privToken,'/issues','POST',{
    title: '[SILENT #' + n + '] ' + safe(issue.title).slice(0,180),
    body: mirroredBody
  });
} else if (process.env.EVENT_NAME === 'issues') {
  await api(PRIVATE,privToken,'/issues/' + target.number,'PATCH',{
    title: '[SILENT #' + n + '] ' + safe(issue.title).slice(0,180),
    body: mirroredBody
  });
}
const targetUrl = 'https://github.com/' + PRIVATE + '/issues/' + target.number;
const backlinkMarker = '<!-- private-pbf-link:' + n + ' -->';
const pubComments = await pages(PUBLIC,pubToken,'/issues/' + n + '/comments');
const existingBacklinks = pubComments.filter(c=>c.body?.includes(backlinkMarker));
if(existingBacklinks.length > 1) throw Error('Duplicate public links detected');
if (!existingBacklinks.length) {
  await api(PUBLIC,pubToken,'/issues/' + n + '/comments','POST',{
    body:'Linked private RCA history: ' + targetUrl + '\n' + backlinkMarker
  });
}
if(process.env.EVENT_NAME === 'issue_comment') {
  const comment = ev.comment;
  if (!comment || !allowed.has(comment.user?.login)) {
    console.log('Comment ignored: author not allowlisted');
    process.exit(0);
  }
  if (comment.body?.includes(backlinkMarker)) process.exit(0);
  const cm = '<!-- silent-pbf-comment:' + comment.id + ' -->';
  const comments = await pages(PRIVATE,privToken,'/issues/' + target.number + '/comments');
  const found = comments.filter(x=>x.body?.includes(cm));
  if(found.length>1) throw Error('Duplicate comment mirror detected');
  const body = 'From: ' + comment.html_url + '\nBy: @' + comment.user.login +
    '\n' + cm + '\n\n' + safe(comment.body);
  if (found.length) {
    if (found[0].body !== body) await api(PRIVATE,privToken,
      '/issues/comments/' + found[0].id,'PATCH',{body});
  } else {
    await api(PRIVATE,privToken,'/issues/' + target.number + '/comments','POST',{body});
  }
}
console.log('Mirror synchronized: public #' + n + ', private #' + target.number);
