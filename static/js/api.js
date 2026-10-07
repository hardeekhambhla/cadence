const j = async (r) => {
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || r.statusText);
  return r.json();
};
const body = (b) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
export const api = {
  projects: () => fetch('/api/projects').then(j),
  create: (name) => fetch('/api/projects', body({ name })).then(j),
  get: (id) => fetch(`/api/projects/${id}`).then(j),
  save: (id, data) => fetch(`/api/projects/${id}`, { ...body(data), method: 'PUT' }).then(j),
  remove: (id) => fetch(`/api/projects/${id}`, { method: 'DELETE' }).then(j),
  delSong: (id, sid) => fetch(`/api/projects/${id}/songs/${sid}`, { method: 'DELETE' }).then(j),
  delMedia: (id, mid) => fetch(`/api/projects/${id}/media/${mid}`, { method: 'DELETE' }).then(j),
  plan: (id, opts) => fetch(`/api/projects/${id}/plan`, body(opts)).then(j),
  pick: (id, media, dur, avoid) => fetch(`/api/projects/${id}/pick`, body({ media, dur, avoid })).then(j),
  exportVideo: (id, quality) => fetch(`/api/projects/${id}/export`, body({ quality })).then(j),
  job: (jid) => fetch(`/api/jobs/${jid}`).then(j),
};

// multipart upload with progress (fetch can't report upload progress)
export function upload(url, file, extra = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(x.responseText.slice(0, 200))));
    x.onerror = () => reject(new Error('Upload failed'));
    x.send(fd);
  });
}

export const mediaUrl = (pid, m, name) => `/api/projects/${pid}/media/${m.id || m}/${name || m.proxy}`;
export const thumbUrl = (pid, m) => `/api/projects/${pid}/media/${m.id}/thumb.jpg`;
export const frameUrl = (pid, m, t, w = 160) => (m.kind === 'image' ? thumbUrl(pid, m) : `/api/projects/${pid}/media/${m.id}/frame.jpg?t=${t.toFixed(1)}&w=${w}`);
export const RATIOS = {
  '9:16': { w: 9, h: 16, label: 'Reels & TikTok' },
  '4:5': { w: 4, h: 5, label: 'Feed post' },
  '1:1': { w: 1, h: 1, label: 'Square' },
  '16:9': { w: 16, h: 9, label: 'Landscape' },
};
export const ratioAR = (r) => RATIOS[r].w / RATIOS[r].h;
export const cropLoss = (m, ratio) => { const am = m.w / m.h, at = ratioAR(ratio); return 1 - (am > at ? at / am : am / at); };
