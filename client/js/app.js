let curRest=null, cart={}, selectedCity='Грозный';
const SOLD_OUT={'2_0':true}; // демо: блюдо в стоп-листе

let cityAnimTimer=null;
function selectCity(c){
  if(c===selectedCity)return;
  selectedCity=c;
  document.querySelectorAll('#cities .citychip').forEach(ch=>ch.classList.toggle('sel',ch.textContent===c));
  const list=document.getElementById('list');
  clearTimeout(cityAnimTimer);
  list.style.transition='opacity .2s ease';
  list.style.opacity='0';
  cityAnimTimer=setTimeout(()=>{
    renderList(true);           // true = без каскада, сразу видимы
    list.style.opacity='1';
  },200);
}

function cardHTML(r){return `
  <div class="card ${r.open?'':'closed'}" onclick="${r.open?`openRest(${r.id},event)`:`shut('${r.name}')`}">
    <div class="photo" style="background:${r.g}">
      <span class="mj">${r.e}</span><img src="${U(r.im,900)}" loading="lazy" onerror="this.remove()">
      <div class="chip st ${r.open?'open':'shut'}"><span class="bdot"></span>${r.open?'Открыто':'Закрыто'}</div>
      <div class="chip rt">★ ${r.rate} · ${r.votes}</div>
      <div class="info"><div class="cname">${r.name}${r.open&&r.isNew?' <span class="newtag">NEW</span>':''}</div><div class="ccui">${r.cui}</div>
        <div class="ordcnt">уже заказали ${r.votes*3} раз</div>
        <div class="cmeta"><span>🕑 ${r.time}</span><span>🛵 ${r.deliv} ₽</span><span><b>мин.</b> ${r.min} ₽</span><span>🕐 ${r.hours}</span></div></div>
    </div></div>`;}

function renderList(instant){
  const q=(document.getElementById('q').value||'').toLowerCase().trim();
  let base=restaurants.filter(r=>r.cities.includes(selectedCity)).filter(r=>!q||r.name.toLowerCase().includes(q)||r.cui.toLowerCase().includes(q));
  const openR=base.filter(r=>r.open).sort((a,b)=>(b.isNew?1:0)-(a.isNew?1:0)||b.rate-a.rate);
  const closedR=base.filter(r=>!r.open);
  document.getElementById('new-sec').innerHTML='';
  const el=document.getElementById('list');
  if(!base.length){
    if(q){el.innerHTML='<div class="empty">Ничего не нашлось</div>';}
    else{el.innerHTML='<div class="empty">В этом городе пока нет ресторанов.<br>Скоро появятся — проголосуйте за свой город наверху!</div>';}
    return;
  }
  let html='';
  if(!openR.length){html+=`<div class="sleep"><div class="moon">🌙</div><h3>Город спит</h3><p>Сейчас всё закрыто — рестораны откроются позже.</p></div>`;}
  html+=openR.map(cardHTML).join('');
  if(closedR.length) html+=`<div class="grouplbl">Закрыты сейчас</div>`+closedR.map(cardHTML).join('');
  el.innerHTML=html;
  if(instant){return;}           // смена города — сразу видимы, без анимации
  if(!q)setTimeout(applyStagger,10);
}
function shut(n){showToast(n+' сейчас закрыт — загляните позже 🙂');}
function showToast(msg){
  let t=document.getElementById('toast');
  if(!t){t=document.createElement('div');t.id='toast';t.className='toast';document.body.appendChild(t);}
  t.textContent=msg;
  t.classList.remove('show');void t.offsetWidth;t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer=setTimeout(()=>t.classList.remove('show'),2600);
}

function openRest(id){
  const cnt=Object.keys(cart).length;
  if(cnt>0 && curRest && curRest.id!==id){
    const other=restaurants.find(r=>r.id===id);
    yaamConfirm(`В корзине блюда из «${curRest.name}». Очистить корзину и заказать из «${other.name}»?`,()=>doOpenRest(id));
    return;
  }
  doOpenRest(id);
}
// Адаптивный фон
function adaptBg(){const h=new Date().getHours();if(h>=7&&h<19)document.documentElement.classList.add('daytime');else document.documentElement.classList.remove('daytime');}
adaptBg();

// Скрытие шапки — вниз прячем, любой скролл вверх показываем
let lastY=0;
window.addEventListener('scroll',()=>{
  const y=window.scrollY;
  const dy=y-lastY;
  const top=document.querySelector('.top');
  if(!top){lastY=y;return;}
  if(dy>4&&y>80){top.classList.add('hidden');}
  else if(dy<0){top.classList.remove('hidden');}
  lastY=y;
},{passive:true});

// Стаггер карточек
let firstLoad=true;
let revealObserver=null;
function applyStagger(){
  const cards=[...document.querySelectorAll('#list .card')];
  // первые видимые карточки — мягкий каскад при загрузке
  if(!revealObserver){
    revealObserver=new IntersectionObserver((entries)=>{
      entries.forEach(en=>{if(en.isIntersecting){en.target.classList.add('revealed');revealObserver.unobserve(en.target);}});
    },{threshold:0.12,rootMargin:'0px 0px -40px 0px'});
  }
  cards.forEach((c,i)=>{
    c.classList.add('reveal');
    if(i<3&&firstLoad){
      // верхние — каскадом сразу
      setTimeout(()=>c.classList.add('revealed'),i*120+60);
    } else {
      revealObserver.observe(c);
    }
  });
  firstLoad=false;
}

// Параллакс на карточках
function initParallax(){document.querySelectorAll('.photo img').forEach(img=>{img.classList.add('parallax-img');const card=img.closest('.card');if(!card)return;card.addEventListener('mousemove',e=>{const r=card.getBoundingClientRect();const dy=(e.clientY-r.top-r.height/2)/r.height;img.style.transform=`translateY(${dy*14}px)`;},{passive:true});card.addEventListener('mouseleave',()=>{img.style.transform='';});});}

// Точка активного заказа
function showOrderDot(on){const d=document.getElementById('orderdot');if(d)d.classList.toggle('on',on);}
function dotTap(){if(document.getElementById('orderdot').classList.contains('on'))go('status');}

// Иконки статуса
const STICONS=['📋','👨‍🍳','🛵','✅'];
const STANIMS=['iconpop .5s cubic-bezier(.3,1.4,.4,1), pulse-glow 2s ease-in-out .5s infinite','iconpop .5s cubic-bezier(.3,1.4,.4,1), cooking 1s ease-in-out .5s infinite','iconpop .5s cubic-bezier(.3,1.4,.4,1), riding .65s ease-in-out .5s infinite','delivered .65s cubic-bezier(.3,1.6,.4,1)'];
function renderStatus(){
  document.getElementById('st-progress').innerHTML=STEPS.map((s,i)=>`<div class="pstep ${i<statusStep?'done':''} ${i===statusStep?'cur':''}"><div class="pline"></div><div class="pdot">${i<statusStep?'✓':i+1}</div><div class="plbl">${s}</div></div>`).join('');
  document.getElementById('st-state').textContent=STEPS[statusStep];
  // время готовки от ресторана — на шаге «Готовится»
  const sub=document.getElementById('st-substate');
  if(sub){
    if(statusStep===1){sub.textContent='будет готово примерно через 30 мин';sub.style.display='block';}
    else{sub.style.display='none';}
  }
  const ic=document.getElementById('st-icon');
  if(ic){
    ic.textContent=STICONS[statusStep];
    ic.style.animation='none';
    requestAnimationFrame(()=>{ic.style.animation=STANIMS[statusStep];});
  }
  const bgGreen='radial-gradient(880px circle at 8% -2%,#1B5639,transparent 54%),radial-gradient(680px circle at 98% 8%,#13674A,transparent 50%),linear-gradient(165deg,#0A2417,#08301E)';
  const bgAmber='radial-gradient(880px circle at 10% 0%,#7a4a12,transparent 54%),radial-gradient(680px circle at 95% 10%,#8a5410,transparent 50%),linear-gradient(165deg,#241405,#2e1a08)';
  document.getElementById('statusbg').style.background=(statusStep===2)?bgAmber:bgGreen;
  const last=statusStep===STEPS.length-1;
  document.getElementById('st-next').style.display=last?'none':'block';
  document.getElementById('st-final').style.display=last?'block':'none';
  document.getElementById('st-demowrap').style.display=last?'none':'block';
  if(last)showOrderDot(false);
}

// Размытие при входе в ресторан
function doOpenRest(id){
  const same=curRest&&curRest.id===id;
  curRest=restaurants.find(r=>r.id===id); if(!same)cart={};
  const h=document.getElementById('m-hero');const old=h.querySelector('img');if(old)old.remove();
  h.style.background=curRest.g;
  const img=new Image();img.src=U(curRest.im,900);img.onerror=function(){this.remove()};h.insertBefore(img,h.firstChild);
  document.getElementById('m-name').textContent=curRest.name;
  document.getElementById('m-meta').innerHTML=`<span>★ ${curRest.rate} · ${curRest.votes}</span><span>🕑 ${curRest.time}</span><span>🛵 ${curRest.deliv} ₽</span><span>🕐 ${curRest.hours}</span>`;
  const tabs=['Популярное',...curRest.menu.map(c=>c.cat)];
  document.getElementById('m-tabs').innerHTML=tabs.map((t,i)=>`<div class="mtab ${i===0?'on':''}" onclick="document.getElementById('sec${i}').scrollIntoView({behavior:'smooth'})">${t}</div>`).join('');
  renderMenuBody(); go('menu'); updateBar();
}
function key(ci,ii){return ci+'_'+ii;}
function findItem(k){const[ci,ii]=k.split('_').map(Number);const d=curRest.menu[ci].items[ii];return{n:d.n.replace(/'/g,''),p:d.p};}
function dishCard(d,ci,ii){
  const k=key(ci,ii);const q=cart[k]?cart[k].q:0;const so=SOLD_OUT[k];
  return `<div class="dish ${so?'dis':''}" ${so?'':`onclick="openDish('${k}')"`}>
    <div class="dphoto" style="background:${d.g}"><span class="mj">${d.e}</span><img src="${U(d.im,700)}" loading="lazy" onerror="this.remove()">
    <div class="dplate"><div class="dname">${d.n}${d.pop?' <span class="hit">Хит</span>':''}</div><div class="ddesc">${d.d}</div>
    <div class="dbot"><div class="dprice">${d.p} ₽</div>${so?'<span class="soldout">Нет в наличии</span>':`<div id="ctrl_${k}" onclick="event.stopPropagation()">${q>0?qtyHtml(k,q):`<button class="add" onclick="addItem('${k}',event)">+</button>`}</div>`}</div></div></div></div>`;
}
function renderMenuBody(){
  let html='';
  // популярное
  const pops=[];curRest.menu.forEach((c,ci)=>c.items.forEach((d,ii)=>{if(d.pop)pops.push([d,ci,ii]);}));
  html+=`<div class="cat-h" id="sec0">Популярное</div>`+pops.map(([d,ci,ii])=>dishCard(d,ci,ii)).join('');
  curRest.menu.forEach((c,ci)=>{html+=`<div class="cat-h" id="sec${ci+1}">${c.cat}</div>`+c.items.map((d,ii)=>dishCard(d,ci,ii)).join('');});
  document.getElementById('m-body').innerHTML=html;
}
function qtyHtml(k,q){return `<div class="qty"><button onclick="dec('${k}')">−</button><span>${q}</span><button onclick="inc('${k}',event)">+</button></div>`;}
function addItem(k,e){const it=findItem(k);cart[k]={n:it.n,p:it.p,q:1};refreshAll(k);if(e)flyAnim(e);}
function inc(k,e){cart[k].q++;refreshAll(k);if(e)flyAnim(e);}
function dec(k){cart[k].q--;if(cart[k].q<=0)delete cart[k];refreshAll(k);}
function refreshAll(k){document.querySelectorAll('#ctrl_'+k).forEach(el=>{const c=cart[k];el.innerHTML=(c&&c.q>0)?qtyHtml(k,c.q):`<button class="add" onclick="addItem('${k}',event)">+</button>`;});updateBar();}

let curDishKey=null,curDishPrice=0,dishQty=1;
function openDish(k){
  curDishKey=k;const[ci,ii]=k.split('_').map(Number);const d=curRest.menu[ci].items[ii];
  const det=DETAILS[d.n]||{w:300,kcal:450,p:20,f:20,c:40,s:'Натуральные ингредиенты'};
  const h=document.getElementById('d-hero');h.querySelectorAll('.mj,img').forEach(x=>x.remove());h.style.background=d.g;
  const mj=document.createElement('span');mj.className='mj';mj.textContent=d.e;h.insertBefore(mj,h.firstChild);
  const img=new Image();img.src=U(d.im,1000);img.onerror=function(){this.remove()};h.insertBefore(img,h.firstChild);
  const ids=[d.im,...POOL.filter(x=>x!==d.im)].slice(0,4);
  document.getElementById('d-gallery').innerHTML=ids.map((id,i)=>`<div class="thumb ${i===0?'on':''}" onclick="swapHero('${id}',${i})"><img src="${U(id,200)}" onerror="this.parentNode.style.display='none'"></div>`).join('');
  document.getElementById('d-name').textContent=d.n;
  document.getElementById('d-sub').textContent=`${det.w} г · ${d.p} ₽`;
  document.getElementById('d-kbju').innerHTML=`<div class="kc"><b>${det.kcal}</b><span>ккал</span></div><div class="kc"><b>${det.p} г</b><span>белки</span></div><div class="kc"><b>${det.f} г</b><span>жиры</span></div><div class="kc"><b>${det.c} г</b><span>углеводы</span></div>`;
  document.getElementById('d-sostav').textContent=det.s;
  curDishPrice=d.p;dishQty=(cart[k]&&cart[k].q)?cart[k].q:1;renderDishAdd();go('dish');
}
function renderDishAdd(){document.getElementById('d-qty').textContent=dishQty;document.getElementById('d-add').textContent=`Добавить · ${curDishPrice*dishQty} ₽`;}
function dishQtyPlus(){dishQty++;renderDishAdd();}
function dishQtyMinus(){if(dishQty>1){dishQty--;renderDishAdd();}}
function addFromDish(){const it=findItem(curDishKey);cart[curDishKey]={n:it.n,p:it.p,q:dishQty};refreshAll(curDishKey);go('menu');}
function swapHero(id,i){const img=document.querySelector('#d-hero img');if(img)img.src=U(id,1000);document.querySelectorAll('#d-gallery .thumb').forEach((t,j)=>t.classList.toggle('on',j===i));}

function totals(){let sum=0,cnt=0;for(const k in cart){sum+=cart[k].p*cart[k].q;cnt+=cart[k].q;}return{sum,cnt};}
function plural(n,a,b,c){n=Math.abs(n)%100;const n1=n%10;if(n>10&&n<20)return c;if(n1>1&&n1<5)return b;if(n1===1)return a;return c;}
function updateBar(){const{sum,cnt}=totals();const bar=document.getElementById('cartbar');
  if(cnt>0&&cur('menu')){bar.style.display='block';document.getElementById('cb-count').textContent=cnt+' '+plural(cnt,'блюдо','блюда','блюд');document.getElementById('cb-sum').textContent=sum+' ₽';}else bar.style.display='none';}
function openCart(){
  const{sum}=totals();
  document.getElementById('c-rest').textContent=curRest.name;
  document.getElementById('c-city').textContent=selectedCity;
  document.getElementById('c-addr').value=`г. ${selectedCity}, ул. Маяковского, 18, кв. 7`;
  document.getElementById('c-items').innerHTML=
    Object.values(cart).map(c=>`<div class="sumrow"><span>${c.q} × ${c.n}</span><span>${c.p*c.q} ₽</span></div>`).join('')
    +`<div class="sumrow total"><span>К оплате сейчас (СБП)</span><span>${sum} ₽</span></div>`;
  document.getElementById('c-total').textContent=sum+' ₽';
  go('cart');updateBar();
}
function backToMenu(){go('menu');updateBar();}

function validateCheckout(){
  const nameField=document.getElementById('c-name');
  const wrap=nameField.closest('.field');
  if(!nameField.value.trim()){
    wrap.classList.remove('err');void wrap.offsetWidth;wrap.classList.add('err');
    nameField.focus();
    return false;
  }
  wrap.classList.remove('err');
  return true;
}
// Собранные данные оформления заказа — сюда подключится бот ресторана/бэкенд.
let lastOrder=null;
function buildOrderPayload(){
  const{sum}=totals();
  return{
    name:document.getElementById('c-name').value.trim(),
    phone:document.getElementById('c-phone').value.trim(),
    address:document.getElementById('c-addr').value.trim(),
    comment:document.getElementById('c-comment').value.trim(),
    city:selectedCity,
    restaurant:curRest.name,
    items:Object.values(cart).map(c=>({name:c.n,qty:c.q,price:c.p})),
    total:sum
  };
}
function openQR(){
  if(!validateCheckout())return;
  lastOrder=buildOrderPayload();
  const{sum}=totals();
  document.getElementById('qr-amt').textContent=sum+' ₽';
  document.getElementById('cartbar').style.display='none';
  drawQR();startQRTimer();go('qr');
}
function drawQR(){
  const box=document.getElementById('qrcode');const N=21;let html='';
  const finder=(r,c,R,C)=>{const dr=r-R,dc=c-C;if(dr<0||dr>6||dc<0||dc>6)return null;const edge=(dr===0||dr===6||dc===0||dc===6);const core=(dr>=2&&dr<=4&&dc>=2&&dc<=4);return (edge||core);};
  for(let r=0;r<N;r++)for(let c=0;c<N;c++){
    let b=finder(r,c,0,0);if(b===null)b=finder(r,c,0,14);if(b===null)b=finder(r,c,14,0);
    if(b===null)b=((r*31+c*17+(r%5)*(c%3))%3===0);
    html+=`<i style="background:${b?'#0d1a12':'transparent'}"></i>`;
  }
  box.innerHTML=html;
}

const STEPS=['Принят','Готовится','В пути','Доставлен'];
let statusStep=0;

// После оплаты — короткий спиннер (банк/PSP подтверждает платёж, доли секунды-пара секунд
// на проде), затем единственный реальный шаг ожидания: ответ ресторана (окно 3 мин).
const RESTAURANT_RESPONSE_WINDOW_SEC=180;
const BANK_CONFIRM_DELAY_MS=1400;
let inPreStatus=true,preTimer=null,preAutoTimer=null;

function showStatusSpinner(on){
  document.getElementById('st-spin').classList.toggle('on',on);
  document.getElementById('st-content').style.display=on?'none':'';
}
function renderWaitForRestaurant(){
  showStatusSpinner(false);
  document.getElementById('st-progress').style.display='none';
  document.getElementById('st-state').textContent='Заказ отправлен, ждём ответа ресторана';
  document.getElementById('st-substate').style.display='block';
  startResponseTimer();
  const ic=document.getElementById('st-icon');
  ic.textContent='⏳';ic.style.animation='none';
  requestAnimationFrame(()=>{ic.style.animation='iconpop .5s cubic-bezier(.3,1.4,.4,1), pulse-glow 1.4s ease-in-out .5s infinite';});
  document.getElementById('statusbg').style.background='';
  document.getElementById('st-next').style.display='block';
  document.getElementById('st-final').style.display='none';
  document.getElementById('st-demowrap').style.display='block';
}
function startResponseTimer(){
  clearInterval(preTimer);
  let secs=RESTAURANT_RESPONSE_WINDOW_SEC;
  const sub=document.getElementById('st-substate');
  const tick=()=>{const m=Math.floor(secs/60),s=secs%60;sub.textContent=`Ответ ресторана в течение ${m}:${s<10?'0':''}${s}`;};
  tick();
  preTimer=setInterval(()=>{
    secs--;
    if(secs<=0){clearInterval(preTimer);openRejected('timeout');return;}
    tick();
  },1000);
}
function openStatus(){
  statusStep=0;inPreStatus=true;setOrderTime();showOrderDot(true);
  document.getElementById('st-items').innerHTML=Object.values(cart).map(c=>`<div class="sumrow"><span>${c.q} × ${c.n}</span><span>${c.p*c.q} ₽</span></div>`).join('');
  document.getElementById('statusbg').style.display='block';
  showStatusSpinner(true);
  go('status');
  clearTimeout(preAutoTimer);
  preAutoTimer=setTimeout(renderWaitForRestaurant,BANK_CONFIRM_DELAY_MS);
}
function nextStatus(){
  if(inPreStatus){
    clearInterval(preTimer);clearTimeout(preAutoTimer);
    inPreStatus=false;
    document.getElementById('st-progress').style.display='flex';
    renderStatus();
    return;
  }
  if(statusStep<STEPS.length-1){statusStep++;renderStatus();}
}

function openRejected(reason){
  clearInterval(preTimer);clearTimeout(preAutoTimer);
  showStatusSpinner(false);
  showOrderDot(false);
  if(curRest){
    document.getElementById('rej-title').textContent=(reason==='timeout')?`«${curRest.name}» не ответил вовремя`:`«${curRest.name}» не смог принять заказ`;
    const{sum}=totals();if(sum>0)document.getElementById('rej-sum').textContent=sum.toLocaleString('ru-RU')+' ₽';
  }
  document.getElementById('statusbg').style.display='none';
  go('rejected');
}

function cur(id){return document.getElementById(id).classList.contains('active');}
function go(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');document.querySelector('.dish-add').style.display=(id==='dish')?'block':'none';if(id!=='status'&&id!=='rejected')document.getElementById('statusbg').style.display='none';const vh=document.getElementById('vote-handle');if(vh)vh.style.display=(id==='home')?'flex':'none';window.scrollTo(0,0);updateBar();try{if(id!=='home')history.pushState({screen:id},'');else history.replaceState({screen:'home'},'');}catch(e){}}
function resetAll(){clearInterval(preTimer);clearTimeout(preAutoTimer);cart={};curRest=null;document.getElementById('q').value='';document.getElementById('statusbg').style.display='none';go('home');renderList();}
// Своё окно подтверждения (замена заблокированного confirm)
function yaamConfirm(text,onYes){
  const ov=document.getElementById('confirm-overlay');
  document.getElementById('confirm-text').textContent=text;
  ov.classList.add('on');
  const yes=document.getElementById('confirm-yes');
  const no=document.getElementById('confirm-no');
  const close=()=>{ov.classList.remove('on');yes.onclick=null;no.onclick=null;};
  yes.onclick=()=>{close();onYes&&onYes();};
  no.onclick=close;
  ov.onclick=(e)=>{if(e.target===ov)close();};
}

function clearCart(){yaamConfirm('Очистить корзину?',()=>{cart={};closeSheet();refreshAllVisible();backToMenu();});}
function refreshAllVisible(){document.querySelectorAll('[id^="ctrl_"]').forEach(el=>{const k=el.id.replace('ctrl_','');const c=cart[k];el.innerHTML=(c&&c.q>0)?qtyHtml(k,c.q):`<button class="add" onclick="addItem('${k}',event)">+</button>`;});updateBar();}
// Штора корзины
let sheetStartY=0,sheetCurY=0;
function openSheet(){
  const{sum,cnt}=totals();if(cnt===0)return;
  const si=document.getElementById('sheet-items');
  si.innerHTML=Object.values(cart).map(c=>`<div class="sheet-item"><span class="sn">${c.q} × ${c.n}</span><span class="sp">${c.p*c.q} ₽</span><div class="qty" style="transform:scale(.85)"><button onclick="event.stopPropagation();sheetDec('${Object.keys(cart).find(k=>cart[k].n===c.n)}')">−</button><span>${c.q}</span><button onclick="event.stopPropagation();sheetInc('${Object.keys(cart).find(k=>cart[k].n===c.n)}')">+</button></div></div>`).join('');
  document.getElementById('sheet-total-wrap').innerHTML=`<div class="sheet-total"><span>Итого</span><span>${sum} ₽</span></div>`;
  const mw=document.getElementById('minwarn');
  if(curRest&&sum<curRest.min){mw.style.display='block';mw.textContent=`Минимальный заказ ${curRest.min} ₽ — добавьте ещё на ${curRest.min-sum} ₽`;document.getElementById('sheet-checkout').style.opacity='.45';document.getElementById('sheet-checkout').style.pointerEvents='none';}
  else{mw.style.display='none';document.getElementById('sheet-checkout').style.opacity='1';document.getElementById('sheet-checkout').style.pointerEvents='auto';}
  document.getElementById('sheet-overlay').classList.add('on');document.getElementById('sheet').classList.add('on');document.body.style.overflow='hidden';
}

// Автоподсказки поиска
function showSuggest(q){
  const el=document.getElementById('suggest');
  if(!q||q.length<1){el.classList.remove('on');return;}
  const matches=restaurants.filter(r=>r.cities.includes(selectedCity)&&r.name.toLowerCase().includes(q.toLowerCase())).slice(0,4);
  if(!matches.length){el.classList.remove('on');return;}
  el.innerHTML=matches.map(r=>`<div class="sug-item" onclick="pickSuggest('${r.name}')">🍽 ${r.name} <span style="color:var(--txt2);font-size:12px">· ${r.cui.split('·')[0].trim()}</span></div>`).join('');
  el.classList.add('on');
}
function hideSuggest(){document.getElementById('suggest').classList.remove('on');}
function pickSuggest(name){document.getElementById('q').value=name;hideSuggest();renderList();}

// После оплаты — сразу к статусу
function afterPay(){clearInterval(qrInterval);openStatus();}
function closeSheet(){document.getElementById('sheet-overlay').classList.remove('on');document.getElementById('sheet').classList.remove('on');document.body.style.overflow='';}
function sheetInc(k){inc(k);openSheet();}
function sheetDec(k){
  dec(k);if(totals().cnt===0){closeSheet();}else openSheet();
}
function sheetTouchStart(e){sheetStartY=e.touches[0].clientY;sheetCurY=0;}
function sheetTouchMove(e){sheetCurY=e.touches[0].clientY-sheetStartY;if(sheetCurY>0)document.getElementById('sheet').style.transform=`translateX(-50%) translateY(${sheetCurY}px)`;}
function sheetTouchEnd(){if(sheetCurY>80)closeSheet();document.getElementById('sheet').style.transform='';}

// Флай-анимация при добавлении
function flyAnim(e){
  const fly=document.createElement('div');fly.className='fly';fly.textContent='+ в корзину';
  fly.style.left=(e.clientX-60)+'px';fly.style.top=(e.clientY-20)+'px';
  document.body.appendChild(fly);setTimeout(()=>fly.remove(),750);
  try{if(navigator.vibrate)navigator.vibrate(40);}catch(e){}
}

// Таймер QR
let qrInterval=null;
function startQRTimer(){
  let secs=600;const el=document.getElementById('qr-time');
  clearInterval(qrInterval);
  qrInterval=setInterval(()=>{secs--;const m=Math.floor(secs/60),s=secs%60;el.textContent=m+':'+(s<10?'0':'')+s;if(secs<=0)clearInterval(qrInterval);},1000);
}

// Время заказа
function setOrderTime(){
  const now=new Date();const h=now.getHours(),m=now.getMinutes();
  document.getElementById('st-time').textContent='Заказ оформлен в '+h+':'+(m<10?'0':'')+m;
}

// Экран ошибки
function hideErr(){document.getElementById('errscreen').classList.remove('on');}

neonFlash=function(el){if(el.classList.contains('neon'))return;el.classList.add('neon');el.addEventListener('animationend',()=>el.classList.remove('neon'),{once:true});};

// Риппл на кнопке оплатить
document.addEventListener('click',e=>{
  const btn=e.target.closest('.pay');if(!btn)return;
  const r=document.createElement('span');r.className='ripple';
  const rect=btn.getBoundingClientRect(),size=Math.max(rect.width,rect.height);
  r.style.cssText=`width:${size}px;height:${size}px;left:${e.clientX-rect.left-size/2}px;top:${e.clientY-rect.top-size/2}px`;
  btn.appendChild(r);setTimeout(()=>r.remove(),700);
});

// Pull-to-refresh
let ptrY=0,ptrActive=false;
document.addEventListener('touchstart',e=>{if(window.scrollY===0)ptrY=e.touches[0].clientY;},{passive:true});
document.addEventListener('touchmove',e=>{if(window.scrollY===0&&e.touches[0].clientY-ptrY>60&&cur('home')){document.getElementById('ptr').classList.add('show');ptrActive=true;}},{passive:true});
document.addEventListener('touchend',()=>{if(ptrActive){renderList();setTimeout(()=>document.getElementById('ptr').classList.remove('show'),600);}ptrActive=false;});

// History API
window.addEventListener('popstate',e=>{try{
  const s=(e.state&&e.state.screen)||'home';
  document.querySelectorAll('.screen').forEach(x=>x.classList.remove('active'));
  document.getElementById(s).classList.add('active');
  document.querySelector('.dish-add').style.display=(s==='dish')?'block':'none';
  window.scrollTo(0,0);updateBar();
}catch(err){}});

// Голосование за рестораны, которых ещё нет в YAAM (данные — CANDIDATE_RESTAURANTS в data.js)
let myVote=null;
function renderVote(){
  const max=Math.max(...CANDIDATE_RESTAURANTS.map(v=>v.votes));
  CANDIDATE_RESTAURANTS.sort((a,b)=>b.votes-a.votes);
  document.getElementById('vote-list').innerHTML=CANDIDATE_RESTAURANTS.map(v=>`
    <div class="vote-item">
      <div class="vote-row">
        <span class="vote-name">${v.name}</span>
        <span class="vote-count">${v.votes} голосов</span>
        <button class="vbtn ${myVote===v.name?'voted':''}" onclick="castVote('${v.name}')">${myVote===v.name?'✓':'+'}</button>
      </div>
      <div class="vbar"><i style="width:${Math.round(v.votes/max*100)}%"></i></div>
    </div>`).join('');
}
function castVote(name){
  if(myVote===name)return;
  if(myVote){const prev=CANDIDATE_RESTAURANTS.find(v=>v.name===myVote);if(prev)prev.votes--;}
  const cur=CANDIDATE_RESTAURANTS.find(v=>v.name===name);if(cur)cur.votes++;
  myVote=name;
  try{if(navigator.vibrate)navigator.vibrate(40);}catch(e){}
  renderVote();
}
function openVote(){renderVote();document.getElementById('vote-overlay').classList.add('on');document.getElementById('vote-sheet').classList.add('on');document.getElementById('vote-handle').classList.add('hidden');document.body.style.overflow='hidden';}
function closeVote(){document.getElementById('vote-overlay').classList.remove('on');document.getElementById('vote-sheet').classList.remove('on');document.getElementById('vote-handle').classList.remove('hidden');document.body.style.overflow='';}
let voteStartY=0,voteCurY=0,voteDragging=false;
function voteTouchStart(e){voteStartY=e.touches[0].clientY;voteCurY=0;voteDragging=true;document.getElementById('vote-sheet').style.transition='none';}
function voteTouchMove(e){
  if(!voteDragging)return;
  e.preventDefault();
  voteCurY=e.touches[0].clientY-voteStartY;
  const sh=document.getElementById('vote-sheet');
  const y=voteCurY<0?voteCurY:voteCurY*0.3;
  sh.style.transform=`translateX(-50%) translateY(${y}px)`;
}
function voteTouchEnd(){
  const sh=document.getElementById('vote-sheet');sh.style.transition='';voteDragging=false;
  if(voteCurY<-55)closeVote();
  sh.style.transform='';
}

renderList();
setTimeout(initParallax,300);
