// Простой HTML-layout без шаблонизатора — тот же принцип минимализма, что и в client/.
function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — YAAM Admin</title>
<style>
  :root{--bg:#0A2417;--panel:#123322;--txt:#F1F7F2;--txt2:rgba(241,247,242,.62);--amber:#FF9A2E;--bord:rgba(255,255,255,.14)}
  *{box-sizing:border-box}
  body{font-family:-apple-system,Manrope,sans-serif;background:var(--bg);color:var(--txt);margin:0;padding:0}
  nav{display:flex;gap:18px;padding:16px 24px;border-bottom:1px solid var(--bord);align-items:center}
  nav a{color:var(--txt2);text-decoration:none;font-weight:600;font-size:14px}
  nav a.on,nav a:hover{color:var(--amber)}
  nav .brand{font-weight:800;color:var(--txt);margin-right:12px}
  main{max-width:920px;margin:0 auto;padding:24px}
  h1{font-size:22px;margin:0 0 18px}
  table{width:100%;border-collapse:collapse;margin-bottom:24px}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--bord);font-size:14px}
  th{color:var(--txt2);font-weight:600;font-size:12px;text-transform:uppercase}
  .panel{background:var(--panel);border:1px solid var(--bord);border-radius:14px;padding:20px;margin-bottom:20px}
  label{display:block;font-size:12px;color:var(--txt2);font-weight:700;margin:12px 0 4px;text-transform:uppercase}
  input,select,textarea{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--bord);background:rgba(255,255,255,.05);color:var(--txt);font-size:14px;font-family:inherit}
  button{background:var(--amber);color:#3a1c00;border:none;border-radius:10px;padding:11px 18px;font-weight:800;cursor:pointer;font-size:14px;margin-top:16px}
  button.ghost{background:rgba(255,255,255,.08);color:var(--txt)}
  button.danger{background:#c0303c;color:#fff}
  a.btn{display:inline-block;background:var(--amber);color:#3a1c00;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
  .badge.open{background:rgba(52,211,140,.18);color:#34D38C}
  .badge.closed{background:rgba(255,112,89,.18);color:#FF7059}
  .badge.paused{background:rgba(255,154,46,.18);color:var(--amber)}
  .row{display:flex;gap:12px}
  .row>*{flex:1}
</style>
</head>
<body>
<nav>
  <span class="brand">YAAM Admin</span>
  <a href="/admin">Сегодня</a>
  <a href="/admin/restaurants">Рестораны</a>
  <a href="/admin/orders">Заказы</a>
  <a href="/admin/ratings">Оценки</a>
</nav>
<main>${body}</main>
</body>
</html>`;
}

module.exports = { layout };
