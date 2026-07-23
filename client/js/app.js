let curRest=null, cart={}, selectedCity='Грозный';
const SOLD_OUT={'2_0':true}; // демо: блюдо в стоп-листе (актуально только без бэкенда)

// Именованные тайминги/пороги — вместо магических чисел по всему файлу.
const RATING_MIN_VOTES=5;       // рейтинг на карточке показываем только от стольки оценок
const POLL_INTERVAL_MS=4000;    // как часто опрашиваем реальный статус заказа
const QR_TIMER_SEC=600;         // на сколько даём времени на оплату по QR
const CART_TTL_MS=30*60*1000;   // корзина без оформления заказа считается устаревшей через столько простоя
const TOAST_DURATION_MS=2600;
const FLY_ANIM_MS=750;
const CART_STORAGE_KEY='yaam_cart_state';
const ORDER_STORAGE_KEY='yaam_active_order';
const PENDING_ORDER_CREDENTIALS_KEY='yaam_pending_order_credentials';
const DEMO_SEQ_KEY='yaam_demo_order_seq';
const ORDER_TOKEN_PREFIX='yaam_ord_v1_';
const CREATE_KEY_PREFIX='yaam_create_v1_';
const RETRY_KEY_PREFIX='yaam_retry_v1_';
const CREATE_ORDER_LOCK_NAME='yaam-create-order-v1';
const UI_ICON_PATHS={
  order:'<rect x="6" y="3.5" width="12" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  preparing:'<path d="M5 11h14v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-3Z"/><path d="M8 8c0-1 1-1.5 1-2.5S8 4 8 3m4 5c0-1 1-1.5 1-2.5S12 4 12 3m4 5c0-1 1-1.5 1-2.5S16 4 16 3"/>',
  delivery:'<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  payment:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 15h4"/>',
};
function uiIcon(name){
  const paths=UI_ICON_PATHS[name]||UI_ICON_PATHS.order;
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" focusable="false">${paths}</svg>`;
}
// Все изменения двух order-scoped localStorage ключей в API-режиме проходят
// через один Web Lock. Счётчик нужен, чтобы низкоуровневые helpers могли
// fail-closed отклонить случайную запись вне критической секции.
let createOrderLockDepth=0;
// TTL относится только к паре, которую ещё не отправляли. После POST результат
// может оставаться неизвестным: такую пару продолжаем через recovery endpoint.
const CAPABILITY_TTL_MS=15*60*1000;

function randomCapability(prefix){
  if(!globalThis.crypto||typeof globalThis.crypto.getRandomValues!=='function'){
    throw new Error('Безопасное создание заказа не поддерживается этим браузером');
  }
  const bytes=new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary='';
  bytes.forEach(b=>{binary+=String.fromCharCode(b);});
  return prefix+btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function validCapability(value,prefix){
  return typeof value==='string'&&value.startsWith(prefix)&&value.length===prefix.length+43&&/^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length));
}
function sanitizePendingOrderCredentials(saved){
  if(!saved||!validCapability(saved.orderAccessToken,ORDER_TOKEN_PREFIX)
    ||!validCapability(saved.createIdempotencyKey,CREATE_KEY_PREFIX))return null;
  const parsedCreatedAt=Number(saved.createdAt);
  const createdAt=Number.isFinite(parsedCreatedAt)?parsedCreatedAt:Date.now();
  // Миграция legacy-формата: requestPayload означал возможный POST. ПДн из него
  // немедленно удаляем; точный заказ теперь восстанавливает сервер по capability.
  const parsedSubmittedAt=Number(saved.submittedAt);
  const submittedAt=parsedSubmittedAt>0
    ?parsedSubmittedAt
    :(saved.requestPayload?(createdAt>0?createdAt:Date.now()):null);
  return{
    orderAccessToken:saved.orderAccessToken,
    createIdempotencyKey:saved.createIdempotencyKey,
    createdAt,
    submittedAt,
  };
}
function readPendingOrderCredentials({persistSanitized=false}={}){
  let saved=null;
  try{saved=JSON.parse(localStorage.getItem(PENDING_ORDER_CREDENTIALS_KEY)||'null');}catch(e){}
  const clean=sanitizePendingOrderCredentials(saved);
  if(!clean)return null;
  // Миграцию legacy payload выполняем только внутри Web Lock (вызывающая
  // функция передаёт persistSanitized=true). Обычное read не должно записать
  // назад старую пару поверх более новой операции другой вкладки.
  if(persistSanitized&&(!USE_API||createOrderLockDepth>0)){
    try{localStorage.setItem(PENDING_ORDER_CREDENTIALS_KEY,JSON.stringify(clean));}catch(e){}
  }
  return clean;
}
function savePendingOrderCredentials(value){
  if(USE_API&&createOrderLockDepth===0)return false;
  const clean=sanitizePendingOrderCredentials(value);
  if(!clean)return false;
  try{localStorage.setItem(PENDING_ORDER_CREDENTIALS_KEY,JSON.stringify(clean));return true;}
  catch(e){return false;}
}
function pendingOrderCredentials(){
  const saved=readPendingOrderCredentials({persistSanitized:true});
  if(saved&&(saved.submittedAt||Date.now()-saved.createdAt<=CAPABILITY_TTL_MS))return saved;
  const fresh={
    orderAccessToken:randomCapability(ORDER_TOKEN_PREFIX),
    createIdempotencyKey:randomCapability(CREATE_KEY_PREFIX),
    createdAt:Date.now(),
    submittedAt:null,
  };
  if(!savePendingOrderCredentials(fresh))throw new Error('Не удалось безопасно сохранить создание заказа — освободите место в браузере и повторите');
  return fresh;
}
function markPendingOrderSubmitted(credentials){
  const submitted={...credentials,submittedAt:credentials.submittedAt||Date.now()};
  if(!savePendingOrderCredentials(submitted))throw new Error('Не удалось безопасно сохранить попытку заказа — освободите место в браузере и повторите');
  return submitted;
}
function clearPendingOrderCredentials(expected,{allowSubmitted=true}={}){
  if(USE_API&&createOrderLockDepth===0)return false;
  if(!expected)return false;
  const saved=readPendingOrderCredentials();
  if(!saved||saved.orderAccessToken!==expected.orderAccessToken
    ||saved.createIdempotencyKey!==expected.createIdempotencyKey)return false;
  if(saved.submittedAt&&!allowSubmitted)return false;
  try{localStorage.removeItem(PENDING_ORDER_CREDENTIALS_KEY);return true;}catch(e){return false;}
}
function readStoredActiveOrder(){
  try{return JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY)||'null');}catch(e){return null;}
}
function sameStoredOrder(saved,orderCode,orderAccessToken){
  if(!saved||saved.orderCode!==orderCode)return false;
  if(orderAccessToken)return saved.orderAccessToken===orderAccessToken;
  return !saved.orderAccessToken; // demo-заказ не может удалить API-заказ с тем же кодом
}
function clearStoredOrderState(orderCode,orderAccessToken){
  if(USE_API&&createOrderLockDepth===0)return false;
  const saved=readStoredActiveOrder();
  if(!sameStoredOrder(saved,orderCode,orderAccessToken))return false;
  try{localStorage.removeItem(ORDER_STORAGE_KEY);return true;}catch(e){return false;}
}
function validStoredApiOrder(saved){
  return !!(saved&&saved.orderCode&&validCapability(saved.orderAccessToken,ORDER_TOKEN_PREFIX));
}
function withCreateOrderLock(task){
  if(navigator?.locks&&typeof navigator.locks.request==='function'){
    return navigator.locks.request(CREATE_ORDER_LOCK_NAME,{mode:'exclusive'},async()=>{
      createOrderLockDepth+=1;
      try{return await task();}
      finally{createOrderLockDepth-=1;}
    });
  }
  // localStorage не предоставляет атомарной compare-and-set операции, поэтому
  // корректный межвкладочный mutex на нём построить нельзя. Для старого
  // браузера безопаснее не отправить финансовую операцию, чем рискнуть двумя.
  return Promise.reject(new Error('Для безопасного оформления заказа обновите браузер до актуальной версии'));
}

// Без бэкенда (USE_API=false, как сейчас на проде — сервер ещё не задеплоен)
// номер заказа неоткуда взять от сервера, но активный заказ всё равно должен
// переживать refresh/закрытие вкладки так же, как в реальном режиме — поэтому
// у демо-режима есть свой локальный аналог: последовательный номер в
// localStorage вместо БД, и demoStage вместо статуса с бэкенда.
function nextDemoOrderCode(){
  let seq=1;
  try{seq=(parseInt(localStorage.getItem(DEMO_SEQ_KEY)||'0',10)||0)+1;localStorage.setItem(DEMO_SEQ_KEY,String(seq));}catch(e){}
  return 'YAAM-'+String(seq).padStart(5,'0');
}
let demoStage='qr'; // 'qr' — создан, ждёт демо-оплаты; 'status' — оплачен, идут статусы

// Приводим ответ бэкенда к той же форме, в которой всегда жили демо-данные
// из data.js — это позволяет всем render-функциям ниже не знать, откуда
// пришли данные (demo-массив или API), и не дублировать логику отрисовки.
function normalizeRestaurant(r){
  return{
    id:r.id, name:r.name, cui:r.cuisine||'', photoUrl:r.photo_url||'', phone:r.phone||'', address:r.address||'',
    g:'linear-gradient(135deg,#3d6b4e,#1e4630)', im:null,
    rate:r.rating||0, votes:r.rating_count||0, ordersCount:r.orders_count??null,
    hours:r.hours||'', deliv:r.delivery_price||0, min:r.min_order||0,
    open:!!r.is_open, isNew:!!r.is_new, cities:r.cities||[],
    menu:(r.menu||[]).map(cat=>({
      cat:cat.name,
      items:cat.items.map(it=>({
        id:it.id, n:it.name, d:it.description||'', p:it.price,
        g:'linear-gradient(135deg,#3d6b4e,#1e4630)', im:null, photoUrl:it.photo_url||'',
        pop:!!it.is_popular, available:it.is_available!==0,
        w:it.weight_g, kcal:it.kcal, prot:it.protein_g, fat:it.fat_g, carb:it.carbs_g, s:it.composition,
      })),
    })),
  };
}
let restaurantsCache=[];

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

function cardHTML(r){
  const hasSrc=!!(r.photoUrl||r.im);
  const photo=hasSrc?`<img src="${r.photoUrl||U(r.im,900)}" loading="lazy" onerror="this.closest('.photo').classList.add('nophoto');this.remove()">`:'';
  return `
  <div class="card ${r.open?'':'closed'}" onclick="${r.open?`openRest(${r.id},event)`:`shut('${r.name}')`}">
    <div class="photo ${hasSrc?'':'nophoto'}" style="background:${r.g}">
      ${photo}
      <div class="chip st ${r.open?'open':'shut'}"><span class="bdot"></span>${r.open?'Открыто':'Закрыто'}</div>
      ${r.votes>=RATING_MIN_VOTES?`<div class="chip rt">★ ${r.rate} · ${r.votes}</div>`:''}
      <div class="info"><div class="itop"><div class="cname">${r.name}${r.open&&r.isNew?' <span class="newtag">NEW</span>':''}</div>${r.ordersCount?`<div class="ordcnt">уже заказали ${r.ordersCount} раз</div>`:''}</div><div class="ccui">${r.cui}</div>
        <div class="cmeta"><span><b>мин.</b> ${r.min} ₽</span><span>${r.hours}</span></div></div>
    </div></div>`;
}

async function renderList(instant){
  let base;
  if(USE_API){
    try{
      base=(await api.getRestaurants(selectedCity)).map(normalizeRestaurant);
    }catch(err){
      showToast('Не удалось загрузить рестораны — проверьте соединение');
      base=[];
    }
  }else{
    base=restaurants.filter(r=>r.cities.includes(selectedCity));
  }
  restaurantsCache=base;
  const openR=base.filter(r=>r.open).sort((a,b)=>(b.isNew?1:0)-(a.isNew?1:0)||b.rate-a.rate);
  const closedR=base.filter(r=>!r.open);
  const el=document.getElementById('list');
  if(!base.length){
    el.innerHTML='<div class="empty">В этом городе пока нет ресторанов.<br>Скоро появятся — проголосуйте за свой город наверху!</div>';
    return;
  }
  let html='';
  if(!openR.length){html+=`<div class="sleep"><h3>Город спит</h3><p>Сейчас всё закрыто — рестораны откроются позже.</p></div>`;}
  html+=openR.map(cardHTML).join('');
  if(closedR.length) html+=`<div class="grouplbl">Закрыты сейчас</div>`+closedR.map(cardHTML).join('');
  el.innerHTML=html;
  if(instant){return;}           // смена города — сразу видимы, без анимации
  setTimeout(applyStagger,10);
}
function shut(n){showToast(n+' сейчас закрыт — загляните позже');}
function showToast(msg){
  let t=document.getElementById('toast');
  if(!t){t=document.createElement('div');t.id='toast';t.className='toast';document.body.appendChild(t);}
  t.textContent=msg;
  t.classList.remove('show');void t.offsetWidth;t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer=setTimeout(()=>t.classList.remove('show'),TOAST_DURATION_MS);
}

function openRest(id){
  const cnt=Object.keys(cart).length;
  if(cnt>0 && curRest && curRest.id!==id){
    const other=restaurantsCache.find(r=>r.id===id)||{name:'другого ресторана'};
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

// Слойный эффект intro-блока (замена поиска): при скролле главной страницы
// слоган мягко приглушается и чуть сдвигается вверх — уходит под шапку
// (которая и так sticky+непрозрачная) и к моменту, когда снизу подъезжают
// карточки ресторанов, уже почти неразличим. Только opacity/translateY —
// плоско, без scale/3D, дёшево для composited-слоя, без лагов.
let introEl=null, introFadeHandler=null;
function initIntroLayerFX(){
  introEl=document.getElementById('intro');
  if(!introEl)return;
  const onScroll=()=>{
    if(!cur('home'))return;
    const top=document.querySelector('.top');
    const topH=top?top.offsetHeight:0;
    const rect=introEl.getBoundingClientRect();
    const progress=Math.max(0,Math.min(1,(topH-rect.top)/rect.height));
    introEl.style.opacity=String(1-progress*0.95);
    introEl.style.transform=`translateY(${-progress*14}px)`;
  };
  window.removeEventListener('scroll',introFadeHandler);
  introFadeHandler=onScroll;
  window.addEventListener('scroll',introFadeHandler,{passive:true});
  onScroll();
}

// Точка активного заказа
function showOrderDot(on){const d=document.getElementById('orderdot');if(d)d.classList.toggle('on',on);}
function dotTap(){if(document.getElementById('orderdot').classList.contains('on'))go('status');}

// Шаги статуса зависят от способа получения: у самовывоза нет курьера,
// поэтому у него на один шаг меньше ("В пути" просто отсутствует).
// currentFulfillment выставляется в openStatus() (демо) и pollOrderOnce()
// (реальный бэкенд, из order.fulfillment_type) до первого renderStatus().
const STEP_SETS={
  delivery:{
    steps:['Принят','Готовится','В пути','Доставлен'],
    icons:['order','preparing','delivery','check'],
    anims:['iconpop .5s cubic-bezier(.3,1.4,.4,1), pulse-glow 2s ease-in-out .5s infinite','iconpop .5s cubic-bezier(.3,1.4,.4,1), cooking 1s ease-in-out .5s infinite','iconpop .5s cubic-bezier(.3,1.4,.4,1), riding .65s ease-in-out .5s infinite','delivered .65s cubic-bezier(.3,1.6,.4,1)'],
    statusToStep:{accepted:0,preparing:1,courier:2,delivered:3},
  },
  pickup:{
    steps:['Принят','Готовится','Готово'],
    icons:['order','preparing','check'],
    anims:['iconpop .5s cubic-bezier(.3,1.4,.4,1), pulse-glow 2s ease-in-out .5s infinite','iconpop .5s cubic-bezier(.3,1.4,.4,1), cooking 1s ease-in-out .5s infinite','delivered .65s cubic-bezier(.3,1.6,.4,1)'],
    statusToStep:{accepted:0,preparing:1,delivered:2},
  },
};
let currentFulfillment='delivery';
function stepSet(){return STEP_SETS[currentFulfillment]||STEP_SETS.delivery;}
// Телефон ресторана — только на этом экране, после оформления заказа
// (не на карточке ресторана заранее — см. docs/data-flow.md).
function showRestaurantPhone(phone){
  const wrap=document.getElementById('st-phone-wrap');
  if(!phone){wrap.style.display='none';return;}
  document.getElementById('st-phone-link').href='tel:'+phone.replace(/[^\d+]/g,'');
  wrap.style.display='block';
}

// Реальное время готовки приходит с бэкенда (ресторан выбирает в боте);
// в демо-режиме — фиксированная заглушка.
let curEstimatedMinutes=null;
// ratingSubmitted — источник истины "у этого заказа уже есть оценка" (синхронизируется
// с order.rating с бэкенда при каждом пуле, см. pollOrderOnce). ratingJustNow — только
// для текста: отличаем "только что поставили" от "оценка была раньше" после восстановления сессии.
let ratingSubmitted=false;
let ratingJustNow=false;

function renderRatingStars(){
  const el=document.getElementById('st-rating-wrap');
  if(!el)return;
  if(ratingSubmitted){el.innerHTML=`<p class="rating-thanks">${ratingJustNow?'Спасибо. Оценка учтена.':'Вы уже оценили этот заказ.'}</p>`;return;}
  el.innerHTML=`<div class="rating-wrap"><p>Как вам заказ?</p><div class="rating-stars" id="rating-stars">${[1,2,3,4,5].map(n=>`<button class="rating-star" data-n="${n}" aria-label="Оценить на ${n} ${plural(n,'звезду','звезды','звёзд')}" onclick="submitRating(${n})">★</button>`).join('')}</div></div>`;
}
async function submitRating(n){
  document.querySelectorAll('#rating-stars .rating-star').forEach(b=>b.classList.toggle('on',Number(b.dataset.n)<=n));
  try{
    if(USE_API&&currentOrderCode)await api.rateOrder(currentOrderCode,currentOrderAccessToken,n);
    ratingSubmitted=true;ratingJustNow=true;
    await saveOrderStateSafely(); // демо/API: после refresh снова не показываем форму оценки
    setTimeout(renderRatingStars,350); // короткая пауза, чтобы увидеть подсветку звёзд перед "спасибо"
  }catch(err){
    showToast(err.message||'Не удалось сохранить оценку');
  }
}

function renderStatus(){
  const{steps,icons,anims}=stepSet();
  document.getElementById('st-progress').innerHTML=steps.map((s,i)=>`<div class="pstep ${i<statusStep?'done':''} ${i===statusStep?'cur':''}"><div class="pline"></div><div class="pdot">${i<statusStep?'✓':i+1}</div><div class="plbl">${s}</div></div>`).join('');
  document.getElementById('st-state').textContent=steps[statusStep];
  // время готовки от ресторана — на шаге «Готовится»
  const sub=document.getElementById('st-substate');
  if(sub){
    if(statusStep===1){sub.textContent=`будет готово примерно через ${curEstimatedMinutes||30} мин`;sub.style.display='block';}
    else{sub.style.display='none';}
  }
  const ic=document.getElementById('st-icon');
  if(ic){
    ic.innerHTML=uiIcon(icons[statusStep]);
    ic.style.animation='none';
    requestAnimationFrame(()=>{ic.style.animation=anims[statusStep];});
  }
  const bgGreen='radial-gradient(880px circle at 8% -2%,#1B5639,transparent 54%),radial-gradient(680px circle at 98% 8%,#13674A,transparent 50%),linear-gradient(165deg,#0A2417,#08301E)';
  const bgAmber='radial-gradient(880px circle at 10% 0%,#7a4a12,transparent 54%),radial-gradient(680px circle at 95% 10%,#8a5410,transparent 50%),linear-gradient(165deg,#241405,#2e1a08)';
  // Янтарный фон — только на шаге "В пути" (курьер), которого у самовывоза нет вообще.
  const isCourierStep=currentFulfillment==='delivery'&&statusStep===2;
  document.getElementById('statusbg').style.background=isCourierStep?bgAmber:bgGreen;
  const last=statusStep===steps.length-1;
  document.getElementById('st-next').style.display=last?'none':'block';
  document.getElementById('st-final').style.display=last?'block':'none';
  document.getElementById('st-demowrap').style.display=last?'none':'block';
  if(last){showOrderDot(false);renderRatingStars();}
}

// Размытие при входе в ресторан
async function doOpenRest(id){
  const same=curRest&&curRest.id===id;
  if(USE_API){
    try{
      curRest=normalizeRestaurant(await api.getRestaurant(id));
    }catch(err){
      showToast('Не удалось открыть ресторан — проверьте соединение');
      return;
    }
  }else{
    curRest=restaurants.find(r=>r.id===id);
  }
  if(!same){cart={};saveCartState();}
  const h=document.getElementById('m-hero');h.querySelectorAll('img').forEach(x=>x.remove());
  const heroHasSrc=!!(curRest.photoUrl||curRest.im);
  h.classList.toggle('nophoto',!heroHasSrc);
  h.style.background=curRest.g;
  if(heroHasSrc){
    const heroSrc=curRest.photoUrl||U(curRest.im,900);
    const img=new Image();img.src=heroSrc;img.onerror=function(){h.classList.add('nophoto');this.remove()};h.insertBefore(img,h.firstChild);
  }
  document.getElementById('m-name').textContent=curRest.name;
  const showRating=curRest.votes>=RATING_MIN_VOTES;
  document.getElementById('m-meta').innerHTML=`${showRating?`<span>★ ${curRest.rate} · ${curRest.votes}</span>`:''}<span>Часы: ${curRest.hours}</span>`;
  document.getElementById('msb-name').textContent=curRest.name;
  document.getElementById('msb-rate').textContent=showRating?`★ ${curRest.rate}`:'';
  const tabs=curRest.menu.map(c=>c.cat);
  document.getElementById('m-tabs').innerHTML=tabs.map((t,i)=>`<div class="mtab ${i===0?'on':''}" onclick="document.getElementById('sec${i}').scrollIntoView({behavior:'smooth'})">${t}</div>`).join('');
  renderMenuBody(); go('menu'); updateBar();
  window.scrollTo(0,0);
  initMenuScrollFX();
}

// Компактная плашка ресторана при скролле меню + подсветка активной категории
// + лёгкий скролл-параллакс на фото ресторана (transform-only, работает и на тач-устройствах,
// в отличие от прежнего hover-параллакса на главной, который на мобильном просто не срабатывал).
let catObserver=null, menuScrollHandler=null;
function initMenuScrollFX(){
  const hero=document.querySelector('#m-hero img');
  const stickybar=document.getElementById('menu-stickybar');
  const heroHeight=document.getElementById('m-hero').offsetHeight;

  const onScroll=()=>{
    if(!cur('menu'))return;
    const y=window.scrollY;
    stickybar.classList.toggle('show',y>heroHeight*0.6);
    if(hero)hero.style.transform=`translateY(${Math.min(y*0.25,40)}px)`;
  };
  window.removeEventListener('scroll',menuScrollHandler);
  menuScrollHandler=onScroll;
  window.addEventListener('scroll',menuScrollHandler,{passive:true});
  onScroll();

  if(catObserver)catObserver.disconnect();
  const sections=[...document.querySelectorAll('#m-body .cat-h')];
  const tabs=[...document.querySelectorAll('#m-tabs .mtab')];
  catObserver=new IntersectionObserver((entries)=>{
    entries.forEach(en=>{
      if(!en.isIntersecting)return;
      const idx=sections.indexOf(en.target);
      tabs.forEach((t,i)=>t.classList.toggle('on',i===idx));
      if(tabs[idx])tabs[idx].scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'});
    });
  },{rootMargin:'-96px 0px -75% 0px'});
  sections.forEach(s=>catObserver.observe(s));
}
function key(ci,ii){return ci+'_'+ii;}
function findItem(k){const[ci,ii]=k.split('_').map(Number);const d=curRest.menu[ci].items[ii];return{n:d.n.replace(/'/g,''),p:d.p,id:d.id||null};}
function dishCard(d,ci,ii){
  const k=key(ci,ii);const q=cart[k]?cart[k].q:0;const so=SOLD_OUT[k]||d.available===false;
  const hasSrc=!!(d.photoUrl||d.im);
  const photo=hasSrc?`<img src="${d.photoUrl||U(d.im,700)}" loading="lazy" onerror="this.closest('.dphoto').classList.add('nophoto');this.remove()">`:'';
  return `<div class="dish ${so?'dis':''}" ${so?'':`onclick="openDish('${k}')"`}>
    <div class="dphoto ${hasSrc?'':'nophoto'}" style="background:${d.g}">${photo}
    <div class="dplate"><div class="dname">${d.n}${d.pop?' <span class="hit">Хит</span>':''}</div><div class="ddesc">${d.d}</div></div>
    <div class="dactions"><div class="dprice">${d.p} ₽</div>${so?'<span class="soldout">Нет в наличии</span>':`<div data-ctrl-key="${k}" onclick="event.stopPropagation()">${q>0?qtyHtml(k,q):`<button class="add" onclick="addItem('${k}',event)">+</button>`}</div>`}</div></div></div>`;
}
function renderMenuBody(){
  let html='';
  curRest.menu.forEach((c,ci)=>{html+=`<div class="cat-h" id="sec${ci}">${c.cat}</div>`+c.items.map((d,ii)=>dishCard(d,ci,ii)).join('');});
  document.getElementById('m-body').innerHTML=html;
}
function qtyHtml(k,q){return `<div class="qty"><button onclick="dec('${k}')">−</button><span>${q}</span><button onclick="inc('${k}',event)">+</button></div>`;}
function addItem(k,e){const it=findItem(k);cart[k]={n:it.n,p:it.p,q:1,menuItemId:it.id};refreshAll(k);if(e)flyAnim(e);}
function inc(k,e){cart[k].q++;refreshAll(k);if(e)flyAnim(e);}
function dec(k){cart[k].q--;if(cart[k].q<=0)delete cart[k];refreshAll(k);}
function refreshAll(k){document.querySelectorAll('[data-ctrl-key="'+k+'"]').forEach(el=>{const c=cart[k];el.innerHTML=(c&&c.q>0)?qtyHtml(k,c.q):`<button class="add" onclick="addItem('${k}',event)">+</button>`;});updateBar();saveCartState();}

// Персист корзины — переживает обновление/закрытие вкладки (см. tryRestoreSession).
// Заодно сохраняем черновик оформления (способ получения/адрес/телефон/
// комментарий) — если ещё не дошли до оплаты, эти поля не должны стираться
// при случайном refresh/закрытии вкладки.
function saveCartState(){
  try{
    if(curRest&&Object.keys(cart).length){
      localStorage.setItem(CART_STORAGE_KEY,JSON.stringify({
        restId:curRest.id,city:selectedCity,cart,
        fulfillmentType,
        address:document.getElementById('c-addr')?.value||'',
        phone:document.getElementById('c-phone')?.value||'',
        comment:document.getElementById('c-comment')?.value||'',
        savedAt:Date.now(), // см. CART_TTL_MS в tryRestoreSession — корзина без оформления не должна жить вечно
      }));
    }else{
      localStorage.removeItem(CART_STORAGE_KEY);
    }
  }catch(e){}
}
function saveOrderState(){
  if(USE_API&&createOrderLockDepth===0)return false;
  try{
    if(currentOrderCode){
      // qrDeadline — абсолютный дедлайн платёжного окна (см. "Таймер QR" ниже).
      // Сохраняется всегда, не только в demo: и API-, и demo-режим показывают
      // один и тот же QR-экран с одним и тем же отсчётом — без этого поля
      // refresh/restore каждый раз создавал бы новые 10 минут вместо того,
      // чтобы продолжить уже идущий отсчёт.
      // preDeadline — тот же принцип, что и qrDeadline: абсолютный дедлайн окна
      // ожидания ответа ресторана, сохраняется всегда, иначе refresh на этом
      // экране каждый раз показывал бы заново почти полные 3:00.
      const state={
        orderCode:currentOrderCode,
        orderAccessToken:currentOrderAccessToken,
        retryIdempotencyKey:currentRetryIdempotencyKey,
        paymentUrl:currentPaymentUrl,
        amount:currentOrderAmount,
        restId:currentOrderRestaurantId||(curRest?curRest.id:null),
        orderItems:currentOrderItems,
        qrDeadline,preDeadline,orderCreatedAtMs,
      };
      if(!USE_API){
        // Демо-режим сам себе бэкенд — сохраняем всё, что понадобится для
        // восстановления экрана без единого сетевого запроса (см. restoreDemoOrder).
        state.demo=true;
        state.demoStage=demoStage;
        state.statusStep=statusStep;
        state.inPreStatus=inPreStatus;
        state.currentFulfillment=currentFulfillment;
        state.ratingSubmitted=ratingSubmitted; // ratingJustNow не сохраняем — верно только в рамках текущей загрузки страницы
        state.curEstimatedMinutes=curEstimatedMinutes;
        state.cartSnapshot=cart;
      }
      const stored=readStoredActiveOrder();
      if(stored&&!sameStoredOrder(stored,currentOrderCode,currentOrderAccessToken)){
        const storedCreatedAt=Number(stored.orderCreatedAtMs);
        const currentCreatedAt=Number(orderCreatedAtMs);
        const storedHasCreatedAt=stored.orderCreatedAtMs!=null&&Number.isFinite(storedCreatedAt);
        const currentHasCreatedAt=orderCreatedAtMs!=null&&Number.isFinite(currentCreatedAt);
        // Старая вкладка не имеет права затирать другой, более новый заказ.
        // Заменяем отличающийся snapshot только когда оба времени известны и
        // текущий заказ доказанно новее сохранённого.
        if(!storedHasCreatedAt||!currentHasCreatedAt
          ||currentCreatedAt<=storedCreatedAt)return false;
      }
      localStorage.setItem(ORDER_STORAGE_KEY,JSON.stringify(state));
    }else{
      return false; // удаление требует compare-and-delete через clearStoredOrderState()
    }
    return true;
  }catch(e){return false;}
}
async function saveOrderStateSafely(){
  if(!USE_API||createOrderLockDepth>0)return saveOrderState();
  return withCreateOrderLock(()=>saveOrderState());
}
async function clearStoredOrderStateSafely(orderCode,orderAccessToken){
  if(!USE_API||createOrderLockDepth>0)return clearStoredOrderState(orderCode,orderAccessToken);
  return withCreateOrderLock(()=>clearStoredOrderState(orderCode,orderAccessToken));
}

function normalizeOrderSnapshotItems(items){
  if(!Array.isArray(items))return[];
  return items.map(item=>({
    n:String(item?.name??item?.n??''),
    p:Number(item?.price??item?.p??0),
    q:Number(item?.qty??item?.q??0),
  })).filter(item=>item.n&&Number.isFinite(item.p)&&Number.isInteger(item.q)&&item.q>0);
}
function parseServerCreatedAt(value,fallback){
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value==='string'){
    const normalized=value.includes('T')?value:value.replace(' ','T')+'Z';
    const parsed=Date.parse(normalized);
    if(Number.isFinite(parsed))return parsed;
  }
  return Number(fallback)||Date.now();
}
function loadOrderRestaurant(restId){
  if(!restId)return;
  currentOrderRestaurantId=Number(restId)||restId;
  if(curRest&&String(curRest.id)===String(restId))return;
  if(USE_API){
    return api.getRestaurant(restId)
      .then(rest=>{curRest=normalizeRestaurant(rest);})
      .catch(()=>{curRest=null;});
  }else{
    curRest=restaurants.find(r=>String(r.id)===String(restId))||null;
  }
}
function hydrateStoredOrder(savedOrder){
  currentOrderCode=savedOrder.orderCode;
  currentOrderAccessToken=savedOrder.orderAccessToken||null;
  currentRetryIdempotencyKey=validCapability(savedOrder.retryIdempotencyKey,RETRY_KEY_PREFIX)?savedOrder.retryIdempotencyKey:null;
  currentPaymentUrl=savedOrder.paymentUrl||null;
  currentOrderAmount=savedOrder.amount||null;
  currentOrderRestaurantId=savedOrder.restId||null;
  currentOrderItems=normalizeOrderSnapshotItems(savedOrder.orderItems);
  qrDeadline=savedOrder.qrDeadline||null;
  preDeadline=savedOrder.preDeadline||null;
  orderCreatedAtMs=savedOrder.orderCreatedAtMs||null;
}
async function applyStoredOrder(savedOrder){
  hydrateStoredOrder(savedOrder);
  if(savedOrder.restId)await loadOrderRestaurant(savedOrder.restId);
}
async function applyRecoveredOrder(result,credentials,{fallbackContext}={}){
  const{order,payment,context}=result||{};
  if(!order?.public_code)throw new Error('Сервер не вернул созданный заказ');
  const safeContext=context||fallbackContext||{};
  currentOrderCode=order.public_code;
  currentOrderAccessToken=credentials.orderAccessToken;
  currentCreateIdempotencyKey=credentials.createIdempotencyKey;
  currentPaymentUrl=payment?.paymentUrl||null;
  currentOrderAmount=Number(order.items_total)||null;
  currentOrderRestaurantId=safeContext.restaurantId||null;
  currentOrderItems=normalizeOrderSnapshotItems(safeContext.items);
  orderCreatedAtMs=parseServerCreatedAt(safeContext.createdAt,credentials.submittedAt||credentials.createdAt);
  const activeStateSaved=saveOrderState();
  // Только после надёжного active snapshot удаляем recovery capability.
  if(activeStateSaved)clearPendingOrderCredentials(credentials);
  initialRecoveryBlocked=false;
  currentCreateIdempotencyKey=null;
  await loadOrderRestaurant(currentOrderRestaurantId);
  return order;
}
async function showRecoveredOrder(order){
  if(order.status!=='awaiting_payment'){
    startOrderPolling();
    return;
  }
  document.getElementById('qr-amt').textContent=(currentOrderAmount||0)+' ₽';
  document.getElementById('cartbar').style.display='none';
  renderQRPaymentOptions();
  drawQR();await startNewQRTimer();go('qr');startOrderPollingQuiet();
}

async function recoverSubmittedOrder(credentials){
  return api.recoverOrder(credentials.orderAccessToken,credentials.createIdempotencyKey);
}
async function resolveInitialOrder({allowCreate=false,apiPayload=null,fallbackContext=null}={}){
  return withCreateOrderLock(async()=>{
    // Другая вкладка могла завершить операцию, пока эта ждала lock.
    const active=readStoredActiveOrder();
    if(validStoredApiOrder(active)){
      await applyStoredOrder(active);
      return{kind:'active'};
    }

    let credentials=readPendingOrderCredentials({persistSanitized:true});
    if(credentials?.submittedAt){
      try{
        const recovered=await recoverSubmittedOrder(credentials);
        const order=await applyRecoveredOrder(recovered,credentials);
        return{kind:'resolved',order,source:'recover'};
      }catch(err){
        if(err.status!==404)throw err;
        // 404 — сервер однозначно не знает эту пару: финансовой операции нет.
        clearPendingOrderCredentials(credentials);
        credentials=null;
      }
    }
    if(!allowCreate)return{kind:'none'};

    credentials=pendingOrderCredentials();
    credentials=markPendingOrderSubmitted(credentials);
    currentOrderAccessToken=credentials.orderAccessToken;
    currentCreateIdempotencyKey=credentials.createIdempotencyKey;
    let created;
    try{
      created=await api.createOrder(apiPayload,credentials.orderAccessToken,credentials.createIdempotencyKey);
    }catch(err){
      // Валидный клиентский отказ, включая fresh 409, закрывает эту пару.
      // Timeout/rate-limit могут прийти от промежуточного слоя после отправки,
      // поэтому 408/429, как сеть/5xx, остаются submitted и идут через recover.
      if(Number.isInteger(err.status)&&err.status>=400&&err.status<500
        &&err.status!==408&&err.status!==429){
        clearPendingOrderCredentials(credentials);
        currentOrderAccessToken=null;currentCreateIdempotencyKey=null;
      }
      throw err;
    }
    const order=await applyRecoveredOrder(created,credentials,{fallbackContext});
    return{kind:'resolved',order,source:'create'};
  });
}

let initialRecoveryInFlight=null,initialRecoveryBlocked=false;
function showInitialOrderRecoveryPending(waiting=false){
  initialRecoveryBlocked=true;
  showOrderDot(false);showRestaurantPhone(null);setRejOrderCode(null);
  document.getElementById('rej-title').textContent='Проверяем созданный заказ';
  document.getElementById('rej-explain').textContent=waiting
    ?'Уточняем результат предыдущей попытки. Не закрывайте страницу и не оформляйте заказ повторно.'
    :'Ответ сервера не получен. Не оформляйте заказ повторно — безопасно проверим предыдущую попытку.';
  document.getElementById('rej-refund-line').style.display='none';
  const btn=document.getElementById('rej-action-btn');
  btn.textContent=waiting?'Проверяем…':'Проверить снова';btn.onclick=retryInitialOrderRecovery;
  document.getElementById('statusbg').style.display='none';
  if(!cur('rejected'))go('rejected');
}
async function recoverPendingInitialOrder({showFailure=true}={}){
  if(!USE_API||currentOrderCode)return false;
  const pending=readPendingOrderCredentials();
  if(!pending?.submittedAt)return false;
  if(initialRecoveryInFlight)return initialRecoveryInFlight;
  if(showFailure)showInitialOrderRecoveryPending(true);
  const operation=(async()=>{
    try{
      const outcome=await resolveInitialOrder();
      if(outcome.kind==='active'){
        initialRecoveryBlocked=false;startOrderPolling();return true;
      }
      if(outcome.kind==='resolved'){
        initialRecoveryBlocked=false;await showRecoveredOrder(outcome.order);return true;
      }
      initialRecoveryBlocked=false;
      return false; // recover вернул однозначный 404 и capability уже удалена
    }catch(err){
      if(showFailure)showInitialOrderRecoveryPending(false);
      return true; // судьба POST неизвестна: корзину/новое оформление не показываем
    }
  })();
  initialRecoveryInFlight=operation;
  try{return await operation;}
  finally{if(initialRecoveryInFlight===operation)initialRecoveryInFlight=null;}
}
async function retryInitialOrderRecovery(){
  const btn=document.getElementById('rej-action-btn');
  if(initialRecoveryInFlight)return;
  btn.disabled=true;btn.style.opacity='.6';btn.textContent='Проверяем…';
  try{
    const handled=await recoverPendingInitialOrder({showFailure:true});
    if(!handled){go('home');await tryRestoreSession();}
  }finally{
    btn.disabled=false;btn.style.opacity='';
    if(initialRecoveryBlocked)btn.textContent='Проверить снова';
  }
}

// Восстановление после обновления/закрытия вкладки. Активный оплаченный заказ
// важнее корзины — если он есть, сразу возвращаемся на экран статуса и продолжаем
// поллинг (актуально только в режиме реального бэкенда: у демо-статуса нет
// серверного заказа, который имело бы смысл возобновлять).
// Восстановление демо-заказа (без бэкенда) из localStorage — тот же приоритет,
// что и у реального: экран заказа важнее корзины/ресторана. Не дёргает сеть,
// просто напрямую ставит live-переменные из сохранённого снимка и рисует
// тот же экран, на котором пользователь был до refresh/закрытия вкладки.
function restoreDemoOrder(saved){
  cart=saved.cartSnapshot||{};
  currentFulfillment=saved.currentFulfillment||'delivery';
  fulfillmentType=currentFulfillment;
  demoStage=saved.demoStage||'status';
  if(demoStage==='qr'){
    // Оплата ещё не подтверждена (демо-эквивалент pending_payment) — точка
    // активного заказа означает только "оплачен и в работе", здесь рано.
    showOrderDot(false);
    const{sum}=totals();
    document.getElementById('qr-amt').textContent=sum+' ₽';
    document.getElementById('cartbar').style.display='none';
    renderQRPaymentOptions();
    drawQR();startQRTimer();go('qr');
    return;
  }
  statusStep=saved.statusStep||0;
  inPreStatus=!!saved.inPreStatus;
  ratingSubmitted=!!saved.ratingSubmitted;
  ratingJustNow=false; // "только что" — только пока не было перезагрузки, см. ту же логику в pollOrderOnce
  curEstimatedMinutes=saved.curEstimatedMinutes||null;
  setOrderTime(orderCreatedAtMs);showOrderDot(true);
  document.getElementById('st-items').innerHTML=orderItemsHTML();
  document.getElementById('st-num').textContent=currentOrderCode;
  document.getElementById('statusbg').style.display='block';
  showStatusSpinner(false);
  showRestaurantPhone(curRest?curRest.phone:null);
  document.getElementById('st-cancel-wrap').style.display=inPreStatus?'block':'none';
  document.getElementById('st-demowrap').style.display=inPreStatus?'block':'none';
  if(inPreStatus){renderWaitForRestaurant();}
  else{document.getElementById('st-progress').style.display='flex';renderStatus();}
  go('status');
}
async function tryRestoreSession(){
  let savedOrder=readStoredActiveOrder();
  // Заказы, сохранённые до появления capability, нельзя восстанавливать через
  // один перебираемый public_code. Это pre-production legacy: удаляем только
  // локальную ссылку, сам внутренний заказ остаётся доступен поддержке/админке.
  if(USE_API&&savedOrder&&savedOrder.orderCode&&!validCapability(savedOrder.orderAccessToken,ORDER_TOKEN_PREFIX)){
    await clearStoredOrderStateSafely(savedOrder.orderCode,null);
    savedOrder=null;
  }
  if(savedOrder&&savedOrder.orderCode){
    if(USE_API){
      await applyStoredOrder(savedOrder);
      startOrderPolling();
    }else if(savedOrder.demo){
      // Локальный demo restore не требует сети: гидратируем и рисуем его в том
      // же event-loop, без промежуточного пустого экрана после refresh.
      hydrateStoredOrder(savedOrder);
      if(savedOrder.restId)loadOrderRestaurant(savedOrder.restId);
      restoreDemoOrder(savedOrder);
    }
    return true;
  }
  // Потерянный ответ восстанавливаем по capability до корзины, не собирая
  // новый POST из потенциально уже изменённой формы.
  if(USE_API){
    if(await recoverPendingInitialOrder({showFailure:true}))return true;
  }
  let savedCart=null;
  try{savedCart=JSON.parse(localStorage.getItem(CART_STORAGE_KEY)||'null');}catch(e){}
  // Корзину без оформления заказа не тащим бесконечно — если человек оставил
  // её и не вернулся дольше CART_TTL_MS, при следующем заходе считаем пустой.
  if(savedCart&&savedCart.savedAt&&(Date.now()-savedCart.savedAt>CART_TTL_MS)){
    localStorage.removeItem(CART_STORAGE_KEY);
    savedCart=null;
  }
  if(savedCart&&savedCart.restId){
    let rest=null;
    if(USE_API){
      try{rest=normalizeRestaurant(await api.getRestaurant(savedCart.restId));}catch(e){return false;}
    }else{
      rest=restaurants.find(r=>r.id===savedCart.restId);
    }
    if(!rest)return false;
    if(savedCart.city)selectedCity=savedCart.city;
    // Корзина восстанавливается в память (и как нижняя панель "продолжить
    // заказ" на главной), но экран ресторана НЕ открывается автоматически —
    // ручной вход на yaam.su без активного заказа всегда ведёт на главную.
    // curRest выставляем заранее без навигации: клик по нижней панели
    // (openCartBar) или обычный тап по карточке этого же ресторана попадут
    // в "тот же ресторан" (см. doOpenRest/openRest) и не сотрут корзину.
    curRest=rest;
    cart=savedCart.cart||{};
    // Черновик оформления — поля пока не видны (мы на главной, не в корзине),
    // но openCart() их не тронет: она только дозаполняет пустые поля (см. её код).
    if(savedCart.fulfillmentType)fulfillmentType=savedCart.fulfillmentType;
    if(savedCart.address)document.getElementById('c-addr').value=savedCart.address;
    if(savedCart.phone)document.getElementById('c-phone').value=savedCart.phone;
    if(savedCart.comment)document.getElementById('c-comment').value=savedCart.comment;
    updateBar();
    return true;
  }
  return false;
}

let curDishKey=null,curDishPrice=0,dishQty=1;
function openDish(k){
  curDishKey=k;const[ci,ii]=k.split('_').map(Number);const d=curRest.menu[ci].items[ii];
  // из API приходят реальные значения (могут быть пустыми, если админ их не заполнил);
  // в демо-режиме — из локального справочника DETAILS.
  const fromApi=d.kcal!=null;
  const det=fromApi
    ? {w:d.w||'—',kcal:d.kcal??'—',p:d.prot??'—',f:d.fat??'—',c:d.carb??'—',s:d.s||'Состав не указан'}
    : (DETAILS[d.n]||{w:300,kcal:450,p:20,f:20,c:40,s:'Натуральные ингредиенты'});
  const h=document.getElementById('d-hero');h.querySelectorAll('img').forEach(x=>x.remove());
  const dishHasSrc=!!(d.photoUrl||d.im);
  h.classList.toggle('nophoto',!dishHasSrc);
  h.style.background=d.g;
  const gallery=document.getElementById('d-gallery');
  if(dishHasSrc){
    const heroSrc=d.photoUrl||U(d.im,1000);
    const img=new Image();img.src=heroSrc;img.onerror=function(){h.classList.add('nophoto');this.remove()};h.insertBefore(img,h.firstChild);
    if(d.photoUrl){
      gallery.innerHTML=`<div class="thumb on"><img src="${d.photoUrl}" onerror="this.parentNode.style.display='none'"></div>`;
    }else{
      const ids=[d.im,...POOL.filter(x=>x!==d.im)].slice(0,4);
      gallery.innerHTML=ids.map((id,i)=>`<div class="thumb ${i===0?'on':''}" onclick="swapHero('${id}',${i})"><img src="${U(id,200)}" onerror="this.parentNode.style.display='none'"></div>`).join('');
    }
    gallery.style.display='';
  }else{
    gallery.innerHTML='';
    gallery.style.display='none';
  }
  document.getElementById('d-name').textContent=d.n;
  document.getElementById('d-sub').textContent=`${det.w} г · ${d.p} ₽`;
  document.getElementById('d-kbju').innerHTML=`<div class="kc"><b>${det.kcal}</b><span>ккал</span></div><div class="kc"><b>${det.p} г</b><span>белки</span></div><div class="kc"><b>${det.f} г</b><span>жиры</span></div><div class="kc"><b>${det.c} г</b><span>углеводы</span></div>`;
  document.getElementById('d-sostav').textContent=det.s;
  curDishPrice=d.p;dishQty=(cart[k]&&cart[k].q)?cart[k].q:1;renderDishAdd();go('dish');
}
function renderDishAdd(){document.getElementById('d-qty').textContent=dishQty;document.getElementById('d-add').textContent=`Добавить · ${curDishPrice*dishQty} ₽`;}
function dishQtyPlus(){dishQty++;renderDishAdd();}
function dishQtyMinus(){if(dishQty>1){dishQty--;renderDishAdd();}}
function addFromDish(){const it=findItem(curDishKey);cart[curDishKey]={n:it.n,p:it.p,q:dishQty,menuItemId:it.id};refreshAll(curDishKey);go('menu');}
function swapHero(id,i){const img=document.querySelector('#d-hero img');if(img)img.src=U(id,1000);document.querySelectorAll('#d-gallery .thumb').forEach((t,j)=>t.classList.toggle('on',j===i));}

function totals(){let sum=0,cnt=0;for(const k in cart){sum+=cart[k].p*cart[k].q;cnt+=cart[k].q;}return{sum,cnt};}
function plural(n,a,b,c){n=Math.abs(n)%100;const n1=n%10;if(n>10&&n<20)return c;if(n1>1&&n1<5)return b;if(n1===1)return a;return c;}
// Нижняя панель корзины не должна звать оформить ЕЩЁ заказ, пока есть
// незавершённый активный — иначе это выглядит как приглашение создать дубль.
function updateBar(){const{sum,cnt}=totals();const bar=document.getElementById('cartbar');
  if(cnt>0&&(cur('menu')||cur('home'))&&!currentOrderCode){bar.style.display='block';document.getElementById('cb-count').textContent=cnt+' '+plural(cnt,'блюдо','блюда','блюд');document.getElementById('cb-sum').textContent=sum+' ₽';}else bar.style.display='none';}
// Нижняя панель — единственное место, откуда восстановленная (но ещё не
// открытая) корзина превращается в открытый экран ресторана. На экране меню
// просто открывает мини-корзину как раньше; на главной сперва открывает
// ресторан этой корзины (doOpenRest увидит "тот же ресторан" и не сотрёт её).
async function openCartBar(){
  if(!cur('menu')&&curRest)await doOpenRest(curRest.id);
  openSheet();
}
// Строки заказа "N × Блюдо — сумма" — используются в корзине и на двух экранах статуса.
function orderItemsHTML(){
  const items=currentOrderCode&&currentOrderItems.length?currentOrderItems:Object.values(cart);
  return items.map(c=>`<div class="sumrow"><span>${c.q} × ${c.n}</span><span>${c.p*c.q} ₽</span></div>`).join('');
}
// Доставка/самовывоз — выбор клиента при оформлении. По умолчанию доставка,
// но дальше сохраняется между открытиями корзины (openCart передаёт текущее
// значение, а не сбрасывает на 'delivery') и переживает refresh/закрытие
// вкладки — см. saveCartState/tryRestoreSession.
let fulfillmentType='delivery';
function setFulfillment(type){
  fulfillmentType=type;
  const d=document.getElementById('fulfill-delivery'), p=document.getElementById('fulfill-pickup');
  d.classList.toggle('fulfill-on',type==='delivery');d.classList.toggle('fulfill-off',type!=='delivery');
  p.classList.toggle('fulfill-on',type==='pickup');p.classList.toggle('fulfill-off',type!=='pickup');
  document.getElementById('field-addr').style.display=type==='delivery'?'':'none';
  document.getElementById('field-pickup-addr').style.display=type==='pickup'?'':'none';
  document.getElementById('delivery-note').style.display=type==='delivery'?'':'none';
  saveCartState();
}
function openCart(){
  const{sum}=totals();
  document.getElementById('c-rest').textContent=curRest.name;
  document.getElementById('c-city').textContent=selectedCity;
  const addrField=document.getElementById('c-addr');
  if(!addrField.value.trim())addrField.value=`г. ${selectedCity}, ул. Маяковского, 18, кв. 7`;
  document.getElementById('c-pickup-addr').textContent=curRest.address||'Адрес уточняется';
  setFulfillment(fulfillmentType);
  document.getElementById('c-items').innerHTML=
    orderItemsHTML()
    +`<div class="sumrow total"><span>К оплате сейчас (СБП)</span><span>${sum} ₽</span></div>`;
  document.getElementById('c-total').textContent=sum+' ₽';
  renderLegalConsent();
  go('cart');updateBar();
}
function backToMenu(){go('menu');updateBar();}

// Зеркало normalizeRuPhone() из server/services/orderService.js — общего
// бандлера между клиентом и сервером нет, логика продублирована; при правке
// одной стороны обязательно поправить и вторую. Приводит российский номер
// к виду "+7XXXXXXXXXX"; null — если номер битый/пустой/слишком короткий.
function normalizeRuPhone(raw){
  let d=String(raw||'').replace(/\D/g,'');
  if(d.length===11&&d[0]==='8')d='7'+d.slice(1);
  else if(d.length===10)d='7'+d;
  if(d.length!==11||d[0]!=='7')return null;
  return '+'+d;
}
function validateCheckout(){
  const nameField=document.getElementById('c-name');
  const nameWrap=nameField.closest('.field');
  if(!nameField.value.trim()){
    nameWrap.classList.remove('err');void nameWrap.offsetWidth;nameWrap.classList.add('err');
    nameField.focus();
    return false;
  }
  nameWrap.classList.remove('err');
  const phoneField=document.getElementById('c-phone');
  const phoneWrap=phoneField.closest('.field');
  if(!normalizeRuPhone(phoneField.value)){
    phoneWrap.classList.remove('err');void phoneWrap.offsetWidth;phoneWrap.classList.add('err');
    phoneField.focus();
    return false;
  }
  phoneWrap.classList.remove('err');
  return true;
}

// Согласие на обработку персональных данных — отдельный чекбокс, обязателен.
// Оферта отдельного чекбокса не имеет — её акцепт происходит самим нажатием
// «Оплатить» (см. текст под кнопкой), поэтому версию оферты тут не храним.
const CONSENT_VERSION='1.0', PRIVACY_VERSION='1.0';
function getLegalAcceptance(){
  try{return JSON.parse(localStorage.getItem('yaam_legal')||'null');}catch{return null;}
}
function isLegalAccepted(){
  const a=getLegalAcceptance();
  return !!(a&&a.acceptedPersonalData&&a.consentVersion===CONSENT_VERSION&&a.privacyVersion===PRIVACY_VERSION);
}
function saveLegalAcceptance(){
  localStorage.setItem('yaam_legal',JSON.stringify({
    acceptedPersonalData:true,
    consentVersion:CONSENT_VERSION,privacyVersion:PRIVACY_VERSION,
    acceptedAt:new Date().toISOString(),
  }));
}
function renderLegalConsent(){
  const el=document.getElementById('legal-consent');
  if(isLegalAccepted()){
    el.innerHTML=`<p class="legal-ok">Вы уже дали согласие на обработку данных для оформления заказа.</p>`;
  }else{
    el.innerHTML=
      `<label class="legal-check"><input type="checkbox" id="chk-pdn"><span>Я даю <a href="legal/personal-data-consent.html" target="_blank" rel="noopener">согласие</a> на обработку персональных данных согласно <a href="legal/privacy.html" target="_blank" rel="noopener">политике обработки данных</a></span></label>`;
  }
}
function validateLegalConsent(){
  if(isLegalAccepted())return true;
  const pdnOk=document.getElementById('chk-pdn')?.checked;
  if(!pdnOk){
    showToast('Чтобы оформить заказ, нужно дать согласие на обработку персональных данных.');
    return false;
  }
  saveLegalAcceptance();
  return true;
}
// Собранные данные оформления заказа. Без бэкенда (USE_API=false) остаются
// только в браузере — ровно то же самое, что отправится в API, когда он появится.
// currentPaymentUrl — ссылка провайдера на оплату (paymentUrl/confirmationUrl),
// одна и та же для кнопки "Оплата с этого устройства" и для QR. У mock-провайдера
// (сейчас) её нет — null; когда подключится реальный провайдер (ЮKassa и т.п.),
// он будет отдавать её в payment.paymentUrl, и кнопка сама начнёт вести на неё
// вместо demo-оплаты, без правок здесь (см. payFromThisPhone).
// currentOrderAmount — сумма ЗАКАЗА (не текущей корзины!), источник истины
// для любого экрана, где нужно показать сумму уже оформленного заказа (см.
// openRejected). Клиентская cart к моменту показа может быть уже пустой
// (например, после refresh с активным заказом — см. tryRestoreSession), так
// что брать сумму оттуда небезопасно. Обновляется из order.items_total в
// pollOrderOnce() (API-режим) — это и есть backend-данные заказа.
let currentOrderCode=null, currentOrderAccessToken=null, currentCreateIdempotencyKey=null, currentRetryIdempotencyKey=null;
let currentPaymentUrl=null, currentOrderAmount=null, currentOrderRestaurantId=null, currentOrderItems=[];
// orderCreatedAtMs — момент фактического создания заказа (не оплаты), один раз
// зафиксированный в openQR(). Персистится и восстанавливается тем же принципом,
// что qrDeadline/preDeadline, но не очищается на nextStatus()/переходах статуса —
// это ORDER-scoped значение, живёт весь жизненный цикл заказа, а не только
// платёжное окно или фазу ожидания ответа ресторана.
let orderCreatedAtMs=null;
// Показывает реальную кнопку оплаты, если у платежа есть настоящая ссылка
// провайдера, иначе — явно подписанный demo-блок. Никогда не показывает кнопку,
// которая выглядит как реальная оплата, если paymentUrl на самом деле нет.
function renderQRPaymentOptions(){
  document.getElementById('qr-order-code').textContent=currentOrderCode||'';
  // Основная кнопка оплаты видна всегда — единственное, что меняется, это
  // куда она ведёт (см. payFromThisPhone) и есть ли рядом DEMO-тег.
  document.getElementById('qr-demo-tag-wrap').style.display=currentPaymentUrl?'none':'block';
}
function payFromThisPhone(){
  if(currentPaymentUrl){window.location.href=currentPaymentUrl;return;}
  afterPay(); // demo — реальной ссылки нет, кнопка сама завершает demo-оплату
}
function buildOrderPayload(){
  const{sum}=totals();
  return{
    name:document.getElementById('c-name').value.trim(),
    // validateCheckout() уже гарантировал валидный номер до вызова этой функции
    phone:normalizeRuPhone(document.getElementById('c-phone').value),
    address:fulfillmentType==='pickup'?(curRest.address||''):document.getElementById('c-addr').value.trim(),
    fulfillmentType,
    comment:document.getElementById('c-comment').value.trim(),
    city:selectedCity,
    restaurant:curRest.name,
    items:Object.values(cart).map(c=>({name:c.n,qty:c.q,price:c.p,menuItemId:c.menuItemId||null})),
    total:sum
  };
}
// Заказ этого чекаута уже существует (например, вернулись назад на форму,
// пока заказ ждёт оплаты) — не плодим второй, просто продолжаем существующий,
// с того же места (демо: QR, если ещё не "оплачен", иначе статус).
function resumeExistingOrderFlow(){
  if(USE_API){startOrderPolling();return;}
  if(demoStage==='qr'){
    const{sum}=totals();
    document.getElementById('qr-amt').textContent=sum+' ₽';
    document.getElementById('cartbar').style.display='none';
    renderQRPaymentOptions();
    drawQR();startQRTimer();go('qr');
  }else{
    go('status');
  }
}
let checkoutInFlight=false;
async function openQR(){
  if(currentOrderCode)return resumeExistingOrderFlow();
  if(checkoutInFlight)return; // защита от двойного тапа/клика по "Оплатить"
  if(!validateCheckout())return;
  if(!validateLegalConsent())return;
  checkoutInFlight=true;
  const payBtn=document.querySelector('#cart .pay');
  const payBtnHTML=payBtn?payBtn.innerHTML:'';
  if(payBtn){payBtn.disabled=true;payBtn.style.opacity='.6';payBtn.textContent='Оформляем заказ…';}
  const payload=buildOrderPayload();
  const{sum}=totals();
  try{
    // Единственная точка создания orderCreatedAtMs — сюда попадаем только для
    // ГЕНУИННО нового заказа (currentOrderCode гарантированно null, см. guard
    // выше), одинаково для demo и API — момент реального оформления заказа,
    // не оплаты.
    orderCreatedAtMs=Date.now();
    if(USE_API){
      const apiPayload={
        restaurantId:curRest.id, city:selectedCity,
        customerName:payload.name, customerPhone:payload.phone,
        address:payload.address, fulfillmentType:payload.fulfillmentType, comment:payload.comment,
        items:payload.items.map(i=>({name:i.name,price:i.price,qty:i.qty,menuItemId:i.menuItemId})),
      };
      // В pending localStorage остаются только две capability и метаданные без
      // ПДн. После неизвестного POST payload больше не переигрывается: заказ
      // восстанавливает сервер по той же паре, а его context становится
      // источником истины для ресторана и состава заказа.
      const fallbackContext={
        restaurantId:apiPayload.restaurantId,
        createdAt:orderCreatedAtMs,
        items:apiPayload.items.map(({name,price,qty})=>({name,price,qty})),
      };
      const outcome=await resolveInitialOrder({allowCreate:true,apiPayload,fallbackContext});
      if(outcome.kind==='active'){
        startOrderPolling();
        return;
      }
      if(outcome.kind==='resolved'){
        await showRecoveredOrder(outcome.order);
        return;
      }
      throw new Error('Не удалось подтвердить создание заказа');
    }else{
      // Демо-режим — своя "БД" в localStorage вместо реального бэкенда (см.
      // nextDemoOrderCode/saveOrderState) — активный заказ должен переживать
      // refresh/закрытие вкладки точно так же, как в реальном API-режиме.
      currentOrderCode=nextDemoOrderCode();
      currentPaymentUrl=null; // demo — реальной ссылки на оплату нет и не будет
      currentOrderAmount=sum;
      currentOrderRestaurantId=curRest?.id||null;
      currentOrderItems=normalizeOrderSnapshotItems(Object.values(cart));
      demoStage='qr';
      saveOrderState();
    }
    // Точка активного заказа означает "оплачен и в работе" — заказ только что
    // создан и ещё не оплачен (pending_payment/QR), поэтому здесь точка не
    // включается; см. openStatus()/pollOrderOnce() — включается только после
    // подтверждённой оплаты.
    document.getElementById('qr-amt').textContent=(currentOrderAmount??sum)+' ₽';
    document.getElementById('cartbar').style.display='none';
    renderQRPaymentOptions();
    // USE_API-ветка выше всегда return'ится раньше (outcome.kind — 'active'
    // через startOrderPolling(), либо 'resolved' через showRecoveredOrder(),
    // которая для свежего заказа сама поднимает startOrderPollingQuiet() —
    // см. FIX 5). Сюда доходит только demo-режим, где реального backend для
    // поллинга нет.
    drawQR();await startNewQRTimer();go('qr');
  }catch(err){
    // resolveInitialOrder различает fresh HTTP 4xx и неизвестный результат:
    // первый очищает capability, второй сохраняет её только для recover.
    if(USE_API&&readPendingOrderCredentials()?.submittedAt){
      // POST мог дойти до сервера. Не оставляем пользователя на редактируемой
      // корзине: повторный тап обязан сначала выяснить судьбу заказа A.
      showInitialOrderRecoveryPending(false);
    }else{
      showToast(err.message||'Не удалось оформить заказ');
    }
  }finally{
    checkoutInFlight=false;
    if(payBtn){payBtn.disabled=false;payBtn.style.opacity='';payBtn.innerHTML=payBtnHTML;}
  }
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

let statusStep=0;

// После оплаты — короткий спиннер (банк/PSP подтверждает платёж, доли секунды-пара секунд
// на проде), затем единственный реальный шаг ожидания: ответ ресторана (окно 3 мин).
const RESTAURANT_RESPONSE_WINDOW_SEC=180;
const BANK_CONFIRM_DELAY_MS=1400;
let inPreStatus=true,preTimer=null,preAutoTimer=null,preDeadline=null;
// Общий расчёт остатка секунд от абсолютного дедлайна, а не декрементом счётчика —
// декремент "теряет" время, пока setInterval заморожен/затроттлен браузером
// (свёрнутая вкладка, bfcache, блокировка телефона), и после возврата показывает
// больше времени, чем реально осталось. От Date.now() таймер всегда самокорректируется.
function remainingSecs(deadline){return Math.max(0,Math.ceil((deadline-Date.now())/1000));}

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
  ic.innerHTML=uiIcon('clock');ic.style.animation='none';
  requestAnimationFrame(()=>{ic.style.animation='iconpop .5s cubic-bezier(.3,1.4,.4,1), pulse-glow 1.4s ease-in-out .5s infinite';});
  document.getElementById('statusbg').style.background='';
  document.getElementById('st-next').style.display='block';
  document.getElementById('st-final').style.display='none';
  document.getElementById('st-demowrap').style.display='block';
}
function responseTimerTick(){
  const sub=document.getElementById('st-substate');
  const secs=remainingSecs(preDeadline);
  const m=Math.floor(secs/60),s=secs%60;
  if(sub)sub.textContent=`Ответ ресторана в течение ${m}:${s<10?'0':''}${s}`;
  if(secs<=0){clearInterval(preTimer);preTimer=null;openRejected('timeout');}
}
// Единственная точка входа и для нового ожидания (openStatus() -> preAutoTimer
// -> renderWaitForRestaurant()), и для восстановления после refresh
// (restoreDemoOrder() -> renderWaitForRestaurant()) — поэтому дедлайн создаётся
// только если его ещё нет (guard), иначе просто переиспользуется и
// продолжается. preDeadline гарантированно null к моменту нового заказа —
// см. очистку в nextStatus()/openRejected()/resetAll().
function startResponseTimer(){
  clearInterval(preTimer);
  if(!preDeadline){preDeadline=Date.now()+RESTAURANT_RESPONSE_WINDOW_SEC*1000;saveOrderState();}
  responseTimerTick();
  preTimer=setInterval(responseTimerTick,1000);
}
// Общий пролог обоих режимов статус-экрана (демо-шаги и реальный поллинг),
// расходятся только после него — демо крутит статусы кнопкой, реальный ждёт сервер.
// Точку активного заказа здесь НЕ включаем: initStatusScreen вызывается и из
// startOrderPolling() при restore на refresh, когда реальный статус заказа
// (может оказаться ещё awaiting_payment) неизвестен до ответа сервера — см.
// pollOrderOnce(), которая включает/выключает точку по факту оплаты.
function initStatusScreen(){
  statusStep=0;inPreStatus=true;curEstimatedMinutes=null;ratingSubmitted=false;ratingJustNow=false;setOrderTime(orderCreatedAtMs);
  document.getElementById('st-num').textContent=currentOrderCode; // и demo (openStatus), и API (startOrderPolling/pollOrderOnce) — один и тот же реальный код, не HTML-заглушка
  document.getElementById('st-items').innerHTML=orderItemsHTML();
  document.getElementById('statusbg').style.display='block';
  showStatusSpinner(true);
}
function openStatus(){
  currentFulfillment=fulfillmentType;
  demoStage='status';saveOrderState(); // демо "оплачен" — дальше опрашивать нечего, но состояние переживает refresh
  initStatusScreen();
  showOrderDot(true); // демо-оплата уже подтверждена (мы прошли QR) — заказ реально в работе
  showRestaurantPhone(curRest.phone);
  go('status');
  clearTimeout(preAutoTimer);
  preAutoTimer=setTimeout(renderWaitForRestaurant,BANK_CONFIRM_DELAY_MS);
}
function nextStatus(){
  if(inPreStatus){
    clearInterval(preTimer);clearTimeout(preAutoTimer);preDeadline=null; // ресторан принял — окно ожидания больше не актуально, не даём его случайно переиспользовать
    inPreStatus=false;
    document.getElementById('st-progress').style.display='flex';
    renderStatus();
    saveOrderState();
    return;
  }
  if(statusStep<stepSet().steps.length-1){statusStep++;renderStatus();saveOrderState();}
}

// Реальный номер заказа на экране отказа/ошибки — раньше тут был захардкожен
// статичный "YAAM-00001", который никогда не обновлялся и показывался на
// любой реальной ошибке. Показываем код, только если он реально есть.
function setRejOrderCode(code){
  const wrap=document.getElementById('rej-order-id-wrap');
  if(code){document.getElementById('rej-order-code').textContent=code;wrap.style.display='block';}
  else{wrap.style.display='none';}
}
// reason: 'declined' | 'timeout' | 'cancelled'. order — актуальный снимок с
// backend (нужен order.refund_status — публичный none|processing|done|failed,
// см. GET /api/orders/:code). Терминальный СТАТУС ЗАКАЗА (declined/timed_out/
// cancelled) не означает, что возврат уже подтверждён — он резервируется
// атомарно с переходом статуса, но реальный ответ провайдера приходит позже
// (см. server/docs/refund-architecture-review.md). Поэтому эта функция
// вызывается на КАЖДОМ poll-тике, пока заказ терминален, и должна быть
// идемпотентна: повторный вызов для уже открытого экрана этого же заказа не
// перенавигирует повторно (не дублирует history.pushState, не сбрасывает
// scroll), только обновляет строку возврата.
// Кнопка на экране #rejected раньше была БЕЗУСЛОВНО привязана к resetAll() —
// единственная независимая проверка (Frontend/QA review) нашла в этом
// Critical-дефект: resetAll() безусловно останавливает polling и стирает
// currentOrderCode/credentials/localStorage, а это ЕДИНСТВЕННАЯ кнопка на
// экране, где мы только что обещали пользователю "возврат обрабатывается,
// продолжаем следить". Реальный пользователь, тапнувший её, необратимо терял
// единственный способ узнать судьбу своего возврата — ни в этой вкладке
// (interval убит), ни после refresh (localStorage запись уже стёрта).
// Вызывается на КАЖДОМ вызове openRejected(), не только при первом входе на
// экран — refund_status мог стать терминальным уже ПОСЛЕ того, как экран был
// показан (пока пользователь на нём же и остаётся).
function updateRejectedActionButton(refundStatus){
  const btn=document.getElementById('rej-action-btn');
  if(refundStatus==='processing'){
    btn.textContent='Возврат ещё обрабатывается…';
    btn.disabled=true;
    btn.onclick=null;
  }else{
    btn.textContent='Выбрать другой ресторан';
    btn.disabled=false;
    btn.onclick=resetAll;
  }
}
let rejOrderCodeShown=null;
function openRejected(reason,order){
  const refundStatus=order?order.refund_status:'none';
  const alreadyShown=cur('rejected')&&rejOrderCodeShown===currentOrderCode;
  renderRefundLine(refundStatus,currentOrderAmount);
  updateRejectedActionButton(refundStatus);

  if(!alreadyShown){
    // Заказ окончен — это терминальное состояние без пути назад, поэтому
    // окно ожидания ответа ресторана больше не актуально ни при каком reason.
    clearInterval(preTimer);clearTimeout(preAutoTimer);preDeadline=null;
    showStatusSpinner(false);
    showOrderDot(false);
    showRestaurantPhone(null);
    setRejOrderCode(currentOrderCode);
    document.getElementById('rej-explain').style.display='';
    if(reason==='cancelled'){
      document.getElementById('rej-title').textContent='Заказ отменён';
      document.getElementById('rej-explain').textContent='Вы отменили заказ.';
    }else if(curRest){
      document.getElementById('rej-title').textContent=(reason==='timeout')?`«${curRest.name}» не ответил вовремя`:`«${curRest.name}» не смог принять заказ`;
    }
    document.getElementById('statusbg').style.display='none';
    rejOrderCodeShown=currentOrderCode;
    go('rejected');
  }

  if(refundStatus==='processing')return; // ждём терминального refund_status — polling и credentials остаются активными, см. FIX 5
  // Возврата не было ('none'), либо он уже завершён ('done'/'failed') —
  // возвращаться в этот заказ больше некуда, теперь можно безопасно
  // остановить polling и очистить credentials (как и раньше делала эта функция).
  stopOrderPolling();
  const orderCodeForClear=currentOrderCode;
  const orderTokenForClear=currentOrderAccessToken;
  currentOrderCode=null;currentOrderAccessToken=null;currentCreateIdempotencyKey=null;currentRetryIdempotencyKey=null;currentPaymentUrl=null;currentOrderAmount=null;currentOrderRestaurantId=null;currentOrderItems=[];orderCreatedAtMs=null;
  void clearStoredOrderStateSafely(orderCodeForClear,orderTokenForClear);
}

// Оплата не прошла (ошибка провайдера/банка) — отдельный экран-состояние,
// в отличие от отказа ресторана деньги тут не возвращаются, их и не списывали.
function openPaymentFailed(){
  stopOrderPolling();showStatusSpinner(false);showOrderDot(false);showRestaurantPhone(null);
  setRejOrderCode(currentOrderCode); // не очищаем currentOrderCode здесь — payment_failed можно повторить
  document.getElementById('rej-title').textContent='Оплата не прошла';
  document.getElementById('rej-explain').textContent='Банк отклонил платёж или соединение прервалось — деньги не списаны.';
  document.getElementById('rej-refund-line').style.display='none';
  const btn=document.getElementById('rej-action-btn');
  btn.textContent='Попробовать снова';btn.onclick=retryPaymentFlow;
  document.getElementById('statusbg').style.display='none';
  go('rejected');
}
let retryPaymentInFlight=false;
function syncRetryKeyFromStoredOrder(){
  try{
    const stored=JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY)||'null');
    if(stored?.orderCode===currentOrderCode&&validCapability(stored.retryIdempotencyKey,RETRY_KEY_PREFIX)){
      currentRetryIdempotencyKey=stored.retryIdempotencyKey;
    }
  }catch(e){}
}
async function retryPaymentFlow(){
  if(retryPaymentInFlight)return;
  const btn=document.getElementById('rej-action-btn');
  const previousText=btn?btn.textContent:'';
  retryPaymentInFlight=true;
  if(btn){btn.disabled=true;btn.style.opacity='.6';btn.textContent='Создаём платёж…';btn.setAttribute('aria-busy','true');}
  try{
    // Две уже открытые вкладки имеют разные JS-heaps, но общий localStorage.
    // Перед генерацией читаем ключ ещё раз, чтобы вторая вкладка подхватила
    // ключ первой, а не затёрла его своим значением.
    syncRetryKeyFromStoredOrder();
    if(!validCapability(currentRetryIdempotencyKey,RETRY_KEY_PREFIX)){
      currentRetryIdempotencyKey=randomCapability(RETRY_KEY_PREFIX);
      // Ключ должен пережить потерянный HTTP-ответ. Если браузер не может
      // сохранить его до POST, безопаснее не начинать финансовую операцию.
      if(!await saveOrderStateSafely()){
        currentRetryIdempotencyKey=null;
        throw new Error('Не удалось безопасно сохранить попытку оплаты — освободите место в браузере и повторите');
      }
    }
    const completedKey=currentRetryIdempotencyKey;
    const{payment}=await api.retryPayment(currentOrderCode,currentOrderAccessToken,completedKey);
    currentPaymentUrl=payment?.paymentUrl||null;
    currentRetryIdempotencyKey=null;
    if(!await saveOrderStateSafely()){
      // Сервер уже мог создать платёж. Сохраняем ключ хотя бы в памяти, чтобы
      // повтор текущей вкладки запросил ту же попытку, а не новую.
      currentRetryIdempotencyKey=completedKey;
      throw new Error('Платёж создан, но браузер не сохранил его состояние — не закрывайте вкладку и повторите');
    }
    const sum=currentOrderAmount||totals().sum;
    document.getElementById('qr-amt').textContent=sum+' ₽';
    renderQRPaymentOptions();
    drawQR();await startNewQRTimer();go('qr'); // новая попытка оплаты после payment_failed — новый providerPaymentId, значит и новый дедлайн
  }catch(err){
    // 4xx (кроме rate limit) — сервер однозначно отклонил этот ключ; следующий
    // ручной тап получает новый. При сети/429/5xx исход неизвестен, поэтому
    // сохраняем прежний ключ и безопасно повторяем ту же попытку.
    if(err.status>=400&&err.status<500&&err.status!==429){
      currentRetryIdempotencyKey=null;
      await saveOrderStateSafely();
    }
    showToast(err.message||'Не удалось создать новый платёж');
  }finally{
    retryPaymentInFlight=false;
    if(btn){btn.disabled=false;btn.style.opacity='';btn.textContent=previousText||'Попробовать снова';btn.removeAttribute('aria-busy');}
  }
}

let retryRecoveryInFlight=null;
async function recoverRetryPaymentPresentation(notifyUser=false){
  if(!validCapability(currentRetryIdempotencyKey,RETRY_KEY_PREFIX))return true;
  if(retryRecoveryInFlight)return retryRecoveryInFlight;
  const recoveryKey=currentRetryIdempotencyKey;
  retryRecoveryInFlight=(async()=>{
    try{
      const{payment}=await api.retryPayment(currentOrderCode,currentOrderAccessToken,recoveryKey);
      currentPaymentUrl=payment?.paymentUrl||null;
      // Ответ исходного retry мог потеряться до создания нового клиентского
      // дедлайна. Серверного payment_expires_at пока нет, поэтому для
      // восстановленной demo/pre-production попытки начинаем окно заново.
      qrDeadline=Date.now()+QR_TIMER_SEC*1000;
      currentRetryIdempotencyKey=null;
      if(!await saveOrderStateSafely()){
        currentRetryIdempotencyKey=recoveryKey;
        if(notifyUser)showToast('Не удалось сохранить восстановленный платёж — не закрывайте вкладку');
        return false;
      }
      return true;
    }catch(err){
      if(err.status>=400&&err.status<500&&err.status!==429){
        currentRetryIdempotencyKey=null;
        await saveOrderStateSafely();
      }
      if(notifyUser)showToast(err.message||'Не удалось восстановить платёж');
      return false;
    }finally{
      retryRecoveryInFlight=null;
    }
  })();
  return retryRecoveryInFlight;
}
// unpaid=true — вызов с экрана QR или "оплата не завершена" (awaiting_payment,
// см. #qr и #st-pending-pay-wrap в index.html): деньги ещё не списаны, и
// backend (cancelByCustomer()) для этого статуса не вызывает refund вообще —
// текст не должен обещать возврат того, чего не было. unpaid=false/не задан —
// вызов из #st-cancel-wrap (реальная отмена уже оплаченного заказа, ожидание
// ответа ресторана) — там возврат резервируется реально, поэтому дальше
// показываем настоящий order.refund_status (см. openRejected), а не
// безусловное "деньги вернутся автоматически" — возврат может занять время
// или (в редком случае) не пройти автоматически вовсе.
function cancelOrderFlow(unpaid){
  const confirmText=unpaid
    ?'Отменить неоплаченный заказ?\nКорзина будет очищена, и вы вернётесь на главный экран.'
    :'Отменить заказ?';
  const labels=unpaid?{yes:'Да, отменить',no:'Не отменять'}:undefined;
  yaamConfirm(confirmText,async()=>{
    if(!USE_API){ // демо — нечего отменять на сервере, просто сбрасываем локально
      showToast('Заказ отменён');
      resetAll();
      return;
    }
    try{
      const updated=await api.cancelOrder(currentOrderCode,currentOrderAccessToken);
      showToast('Заказ отменён');
      if(unpaid){
        // Оплаты не было — возврата не будет и нечего отслеживать (см.
        // docs/PROJECT_BACKLOG.md Decisions: "UI не сообщает о возврате денег"
        // для отмены неоплаченного заказа).
        stopOrderPolling();
        resetAll();
      }else{
        // Заказ уже был оплачен — сервер атомарно зарезервировал возврат
        // вместе с переходом в cancelled. Показываем актуальный
        // order.refund_status вместо безусловного обещания и продолжаем
        // polling, пока он не станет терминальным (см. openRejected).
        openRejected('cancelled',updated);
      }
    }catch(err){
      showToast(err.message||'Не удалось отменить заказ');
    }
  },labels);
}

// --- Поллинг реального статуса заказа (только в режиме API) ---
let orderPollTimer=null;
let pollInFlight=false; // защита от наложения: visibilitychange/pageshow/setInterval могут вызвать pollOrderOnce() почти одновременно (особенно при возврате из фона на мобильном Safari) — без гейта два параллельных запроса могут прийти не по порядку и откатить UI на более старый статус
let lastKnownOrder=null; // нужен resumeExistingPayment() — сумма/код заказа без обращения к (возможно уже пустой после reload) корзине
function stopOrderPolling(){clearInterval(orderPollTimer);orderPollTimer=null;}
// Полный список статусов заказа, которые реально умеет обрабатывать backend
// (см. server/db/schema.sql CHECK-ограничение на orders.status — тот же
// список). Если когда-нибудь придёт что-то за его пределами (битые данные,
// будущая рассинхронизация версий клиент/сервер), pollOrderOnce() не должен
// молча ничего не делать — см. FALLBACK ниже.
const KNOWN_ORDER_STATUSES=['awaiting_payment','awaiting_restaurant','accepted','preparing','courier','delivered','declined','timed_out','cancelled','payment_failed'];
let unknownOrderStatusNoticeShown=false; // не спамить тем же тостом каждые POLL_INTERVAL_MS, пока статус остаётся нераспознанным
// order.refund_status (см. GET /api/orders/:code) — публичный, уже суженный
// словарь: none | processing | done | failed. Внутренние состояния
// (requested/processing на сервере) сюда никогда не попадают.
function refundStatusMessage(refundStatus,amount){
  const sumHtml=amount?`<b>${amount.toLocaleString('ru-RU')} ₽</b> `:'';
  if(refundStatus==='processing')return `Возврат ${sumHtml}обрабатывается. Деньги будут возвращены после подтверждения платёжного сервиса.`;
  if(refundStatus==='done')return `Возврат ${sumHtml}подтверждён. Срок зачисления зависит от банка.`;
  if(refundStatus==='failed')return 'Возврат не завершён автоматически. Обратитесь в поддержку YAAM.';
  return null; // 'none' — возврата не было и не будет (неоплаченная отмена) — молчим, как и раньше
}
function renderRefundLine(refundStatus,amount){
  const line=document.getElementById('rej-refund-line');
  const html=refundStatusMessage(refundStatus,amount);
  if(html){line.innerHTML=html;line.style.display='';}
  else{line.style.display='none';}
}
// Заказ создан, но оплата ещё не подтверждена — например, вернулись назад с
// экрана QR, обновили страницу или закрыли вкладку и открыли снова. Отдельное
// явное состояние вместо неопределённого экрана (раньше этот статус вообще
// не обрабатывался ни одной веткой ниже).
function renderAwaitingPayment(order){
  showStatusSpinner(false);
  document.getElementById('st-progress').style.display='none';
  document.getElementById('st-state').textContent=`Заказ ${order.public_code} создан`;
  document.getElementById('st-substate').textContent='Оплата пока не завершена.';
  document.getElementById('st-substate').style.display='block';
  const ic=document.getElementById('st-icon');ic.innerHTML=uiIcon('payment');ic.style.animation='none';
  document.getElementById('st-next').style.display='none';
  document.getElementById('st-demowrap').style.display='none';
  document.getElementById('st-cancel-wrap').style.display='none';
  document.getElementById('st-final').style.display='none';
  document.getElementById('st-pending-pay-wrap').style.display='flex';
}
async function resumeExistingPayment(){
  if(validCapability(currentRetryIdempotencyKey,RETRY_KEY_PREFIX)){
    const recovered=await recoverRetryPaymentPresentation(true);
    if(!recovered)return;
  }
  stopOrderPolling();
  const amt=lastKnownOrder?lastKnownOrder.items_total:totals().sum;
  document.getElementById('qr-amt').textContent=amt+' ₽';
  document.getElementById('cartbar').style.display='none';
  renderQRPaymentOptions();
  drawQR();startQRTimer();go('qr');
}
// Заказ пропал с бэкенда (устаревшая ссылка, БД пересоздана и т.п.) — явно
// объясняем и даём вернуться, вместо того чтобы вечно опрашивать 404 молча.
function openOrderNotFound(){
  const orderCodeForDisplay=currentOrderCode; // захватываем до очистки ниже
  const orderTokenForClear=currentOrderAccessToken;
  stopOrderPolling();
  showStatusSpinner(false);showOrderDot(false);showRestaurantPhone(null);
  currentOrderCode=null;currentOrderAccessToken=null;currentCreateIdempotencyKey=null;currentRetryIdempotencyKey=null;currentPaymentUrl=null;currentOrderAmount=null;currentOrderRestaurantId=null;currentOrderItems=[];orderCreatedAtMs=null;
  void clearStoredOrderStateSafely(orderCodeForDisplay,orderTokenForClear);
  setRejOrderCode(orderCodeForDisplay);
  document.getElementById('rej-title').textContent='Не удалось найти заказ';
  document.getElementById('rej-explain').textContent='Возможно, он отменён или устарел. Если это ошибка — напишите в поддержку.';
  document.getElementById('rej-refund-line').style.display='none';
  const btn=document.getElementById('rej-action-btn');
  btn.textContent='На главную';btn.onclick=resetAll;
  document.getElementById('statusbg').style.display='none';
  go('rejected');
}
async function pollOrderOnce(){
  if(pollInFlight)return; // уже есть запрос в полёте — не дублируем, следующий тик/событие подхватит
  pollInFlight=true;
  try{
  let order;
  try{order=await api.getOrder(currentOrderCode,currentOrderAccessToken);}catch(err){
    if(err.status===404){openOrderNotFound();return;}
    return; // сеть моргнула — попробуем на следующем тике
  }
  lastKnownOrder=order;
  if(KNOWN_ORDER_STATUSES.includes(order.status))unknownOrderStatusNoticeShown=false;
  // Свежесозданный заказ стартует polling ещё на экране QR (см.
  // startOrderPollingQuiet(), FIX 5) — как только статус реально ушёл дальше
  // awaiting_payment (оплата подтверждена с этого ЖЕ или ДРУГОГО устройства,
  // например по QR со второго телефона), пользователь должен увидеть это без
  // ручного refresh, а не остаться смотреть на статичный QR-код.
  // initStatusScreen() обязателен здесь, а не только go('status') — иначе
  // #statusbg/#st-items/#st-num остаются пустыми/скрытыми до ручного refresh
  // (независимая проверка Frontend polling/UX это воспроизвела: тихий переход
  // с QR оставлял пустой статус-экран). cur('qr') истинен только на первом
  // тике после реального перехода за awaiting_payment — go('status') снимает
  // .active с #qr, так что повторные тики этот блок больше не выполняют и не
  // затирают statusStep/inPreStatus, уже выставленные веткой ниже.
  if(order.status!=='awaiting_payment'&&cur('qr')){initStatusScreen();go('status');}
  currentOrderAmount=order.items_total; // backend — источник истины для суммы заказа, не клиентская корзина
  // Источник истины для "уже оценено" — order.rating с бэкенда, а не локальный
  // флаг: после обновления страницы ratingSubmitted сбрасывается в false
  // (initStatusScreen), и без этой синхронизации звёзды показались бы снова
  // для уже оценённого заказа, хотя повторная отправка всё равно отклонится сервером.
  ratingSubmitted=order.rating!=null;
  currentFulfillment=order.fulfillment_type==='pickup'?'pickup':'delivery';
  document.getElementById('st-num').textContent=order.public_code;
  if(order.estimated_ready_minutes)curEstimatedMinutes=order.estimated_ready_minutes;
  showRestaurantPhone(order.restaurant_phone);
  document.getElementById('st-pending-pay-wrap').style.display='none';
  if(validCapability(currentRetryIdempotencyKey,RETRY_KEY_PREFIX)
    &&(order.status==='payment_failed'||order.status==='awaiting_payment')){
    const recovered=await recoverRetryPaymentPresentation(false);
    // payment_failed мог атомарно перейти в awaiting_payment во время recovery;
    // не рисуем поверх него устаревший экран, следующий poll сразу возьмёт
    // подтверждённое состояние сервера.
    if(recovered&&order.status==='payment_failed')return;
  }else if(currentRetryIdempotencyKey&&order.status!=='payment_failed'&&order.status!=='awaiting_payment'){
    currentRetryIdempotencyKey=null;
    await saveOrderStateSafely();
  }

  if(order.status==='awaiting_payment'){
    showOrderDot(false); // ещё не оплачен — точка "оплачен и в работе" здесь не показывается
    renderAwaitingPayment(order);
  }else if(order.status==='awaiting_restaurant'){
    showOrderDot(true); // оплата подтверждена, заказ реально пошёл в работу
    showStatusSpinner(false);
    document.getElementById('st-progress').style.display='none';
    document.getElementById('st-state').textContent='Заказ отправлен, ждём ответа ресторана';
    const updatedMs=Date.parse(order.status_updated_at.replace(' ','T')+'Z');
    const left=Math.max(0,RESTAURANT_RESPONSE_WINDOW_SEC-Math.floor((Date.now()-updatedMs)/1000));
    const m=Math.floor(left/60),s=left%60;
    document.getElementById('st-substate').textContent=`Ответ ресторана в течение ${m}:${s<10?'0':''}${s}`;
    document.getElementById('st-substate').style.display='block';
    const ic=document.getElementById('st-icon');ic.innerHTML=uiIcon('clock');
    document.getElementById('st-next').style.display='none';
    document.getElementById('st-demowrap').style.display='none';
    document.getElementById('st-cancel-wrap').style.display='block';
  }else if(stepSet().statusToStep[order.status]!==undefined){
    inPreStatus=false;
    statusStep=stepSet().statusToStep[order.status];
    document.getElementById('st-progress').style.display='flex';
    document.getElementById('st-next').style.display='none'; // статус двигает ресторан по-настоящему, не демо-кнопка
    document.getElementById('st-demowrap').style.display='none';
    document.getElementById('st-cancel-wrap').style.display='none';
    showOrderDot(true); // accepted/preparing/courier — renderStatus сам выключит на delivered
    renderStatus();
    if(order.status==='delivered')stopOrderPolling();
  }else if(order.status==='declined'){
    openRejected('declined',order);
  }else if(order.status==='timed_out'){
    openRejected('timeout',order);
  }else if(order.status==='cancelled'){
    openRejected('cancelled',order);
  }else if(order.status==='payment_failed'){
    openPaymentFailed();
  }else{
    // Нераспознанный статус — backend уже гарантирует CHECK-ограничением на
    // orders.status (см. server/db/schema.sql), но контракт клиент/сервер
    // может разойтись версиями в будущем. Не угадываем новый экран, не трогаем
    // credentials, не отменяем заказ — оставляем как есть и продолжаем polling
    // (см. независимый аудит State Machine, Finding 3).
    console.error(`[YAAM] poll: заказ ${order.public_code} вернул нераспознанный статус`);
    if(!unknownOrderStatusNoticeShown){
      showToast('Статус заказа временно недоступен. Обновите страницу или обратитесь в поддержку.');
      unknownOrderStatusNoticeShown=true;
    }
  }
  }finally{pollInFlight=false;}
}
// Идемпотентна: stopOrderPolling() внутри гарантирует, что повторный вызов
// (restore после refresh, resumeExistingOrderFlow, visibilitychange и т.п.)
// всегда заменяет старый interval, а не плодит второй — второго "тикающего"
// setInterval на один и тот же заказ быть не может.
function startOrderPollingQuiet(){
  stopOrderPolling();
  pollOrderOnce();
  orderPollTimer=setInterval(pollOrderOnce,POLL_INTERVAL_MS);
}
function startOrderPolling(){
  initStatusScreen();
  document.getElementById('st-cancel-wrap').style.display='none';
  go('status');
  startOrderPollingQuiet();
}
// Возврат из фона/bfcache (свернули браузер, переключили вкладку, iOS
// заморозил и разморозил страницу) — статус мог устареть за это время сильнее,
// чем за один обычный интервал поллинга (мобильный Safari троттлит таймеры
// неактивных вкладок). Форсируем один немедленный опрос, не трогая сам
// интервал/экран — pollOrderOnce() лишь безопасно перерисовывает то, что
// реально пришло с сервера. Гейт на orderPollTimer: если поллинг уже не идёт
// (заказ доставлен/отменён/его нет вовсе), лишний сетевой запрос не нужен.
function refreshActiveOrderIfVisible(){
  if(USE_API&&currentOrderCode&&orderPollTimer)pollOrderOnce();
}
function refreshPendingInitialOrderIfVisible(){
  if(USE_API&&!currentOrderCode&&readPendingOrderCredentials()?.submittedAt){
    return recoverPendingInitialOrder({showFailure:true});
  }
  return null;
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshActiveOrderIfVisible();refreshPendingInitialOrderIfVisible();resyncVisibleTimers();}});
window.addEventListener('pageshow',(e)=>{if(e.persisted){refreshActiveOrderIfVisible();refreshPendingInitialOrderIfVisible();resyncVisibleTimers();}});

function cur(id){return document.getElementById(id).classList.contains('active');}
function go(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');document.querySelector('.dish-add').style.display=(id==='dish')?'block':'none';if(id!=='status'&&id!=='rejected')document.getElementById('statusbg').style.display='none';window.scrollTo(0,0);updateBar();if(id==='home'&&introFadeHandler)introFadeHandler();try{if(id!=='home')history.pushState({screen:id},'');else history.replaceState({screen:'home'},'');}catch(e){}}
function resetAll(){
  const orderCodeForClear=currentOrderCode,orderTokenForClear=currentOrderAccessToken;
  clearInterval(preTimer);clearTimeout(preAutoTimer);preDeadline=null;stopQRTimer();qrDeadline=null;stopOrderPolling();showRestaurantPhone(null);showOrderDot(false);cart={};curRest=null;currentOrderCode=null;currentOrderAccessToken=null;currentCreateIdempotencyKey=null;currentRetryIdempotencyKey=null;currentPaymentUrl=null;currentOrderAmount=null;currentOrderRestaurantId=null;currentOrderItems=[];orderCreatedAtMs=null;initialRecoveryBlocked=false;demoStage='qr';
  if(orderCodeForClear)void clearStoredOrderStateSafely(orderCodeForClear,orderTokenForClear);
  saveCartState();document.getElementById('statusbg').style.display='none';go('home');renderList();
}
// Своё окно подтверждения (замена заблокированного confirm)
function yaamConfirm(text,onYes,labels){
  const ov=document.getElementById('confirm-overlay');
  document.getElementById('confirm-text').textContent=text;
  ov.classList.add('on');
  const yes=document.getElementById('confirm-yes');
  const no=document.getElementById('confirm-no');
  // labels — необязательный override подписей кнопок для конкретного вызова
  // (например, "Да, отменить"/"Не отменять" для отмены заказа); без него —
  // обычные "Да"/"Отмена", как и раньше для смены ресторана/очистки корзины.
  yes.textContent=labels?.yes||'Да';
  no.textContent=labels?.no||'Отмена';
  const close=()=>{ov.classList.remove('on');yes.onclick=null;no.onclick=null;};
  yes.onclick=()=>{close();onYes&&onYes();};
  no.onclick=close;
  ov.onclick=(e)=>{if(e.target===ov)close();};
}

function clearCart(){yaamConfirm('Очистить корзину?',()=>{cart={};closeSheet();refreshAllVisible();backToMenu();});}
function refreshAllVisible(){document.querySelectorAll('[data-ctrl-key]').forEach(el=>{const k=el.dataset.ctrlKey;const c=cart[k];el.innerHTML=(c&&c.q>0)?qtyHtml(k,c.q):`<button class="add" onclick="addItem('${k}',event)">+</button>`;});updateBar();saveCartState();}
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

// После оплаты — сразу к статусу
async function afterPay(){
  stopQRTimer();qrDeadline=null; // оплата подтверждена — платёжное окно больше не актуально, не даём его случайно переиспользовать
  if(USE_API){
    try{await api.devMarkPaid(currentOrderCode,currentOrderAccessToken);}
    catch(err){showToast(err.message||'Оплата не прошла');return;}
    startOrderPolling();
  }else{
    openStatus();
  }
}
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
  document.body.appendChild(fly);setTimeout(()=>fly.remove(),FLY_ANIM_MS);
  try{if(navigator.vibrate)navigator.vibrate(40);}catch(e){}
}

// Таймер QR
let qrInterval=null,qrDeadline=null;
function stopQRTimer(){clearInterval(qrInterval);qrInterval=null;}
function qrTimerTick(){
  const el=document.getElementById('qr-time');
  const secs=remainingSecs(qrDeadline);
  const m=Math.floor(secs/60),s=secs%60;
  if(el)el.textContent=m+':'+(s<10?'0':'')+s;
  if(secs<=0)stopQRTimer();
}
// Возобновляет отсчёт от УЖЕ существующего qrDeadline (восстановлен из
// localStorage при refresh, или просто пережил SPA-навигацию в памяти) — не
// создаёт новый дедлайн. Используется при любом ПОВТОРНОМ показе экрана QR
// для уже существующего платежа: restoreDemoOrder(), resumeExistingOrderFlow(),
// resumeExistingPayment(). Fallback ниже — защита на случай, если дедлайна
// почему-то нет вовсе (не должно происходить в норме).
function startQRTimer(){
  stopQRTimer();
  if(!qrDeadline)qrDeadline=Date.now()+QR_TIMER_SEC*1000;
  qrTimerTick();
  qrInterval=setInterval(qrTimerTick,1000);
}
// Единственное место, где дедлайн платежа реально создаётся заново — только
// для действительно НОВОЙ платёжной попытки (новый заказ в openQR(), новый
// providerPaymentId после payment_failed в retryPaymentFlow()). Сразу
// сохраняет дедлайн вместе с состоянием заказа, чтобы следующий refresh/
// restore корректно восстановил именно его, а не начал заново с 10 минут.
function startNewQRTimer(){
  qrDeadline=Date.now()+QR_TIMER_SEC*1000;
  const persisted=saveOrderStateSafely();
  startQRTimer();
  return persisted;
}
// Уход с экрана QR кнопкой "Назад" — заказ и currentOrderCode НЕ трогаем (пользователь
// должен суметь вернуться к той же оплате), но фоновый таймер обязан остановиться,
// иначе он молча тикает и обновляет уже скрытый #qr-time до следующей точки очистки.
function backFromQR(){stopQRTimer();go('cart');}
// Возврат из фона/bfcache не должен ждать следующего тика setInterval, чтобы
// показать верный остаток — форсируем немедленный пересчёт видимых таймеров
// (гейт на сам interval: значит, экран/таймер сейчас реально активен).
function resyncVisibleTimers(){
  if(qrInterval)qrTimerTick();
  if(preTimer)responseTimerTick();
}

// Время заказа — форматирует ПЕРЕДАННЫЙ момент создания заказа (orderCreatedAtMs),
// а не "сейчас": иначе каждый restore/render показывал бы время последнего
// открытия экрана вместо реального времени оформления. Fallback на Date.now()
// — защита на случай отсутствия значения (не должно происходить в норме, см.
// openQR()/tryRestoreSession()).
function setOrderTime(ms){
  const now=new Date(ms||Date.now());const h=now.getHours(),m=now.getMinutes();
  document.getElementById('st-time').textContent='Заказ оформлен в '+h+':'+(m<10?'0':'')+m;
}

function neonFlash(el){if(el.classList.contains('neon'))return;el.classList.add('neon');el.addEventListener('animationend',()=>el.classList.remove('neon'),{once:true});}
// Красный неон intro-блока — тумблер без анимации (см. .intro.lit в style.css).
function toggleIntroLight(el){el.classList.toggle('lit');}

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
  let s=(e.state&&e.state.screen)||'home';
  // Активный незавершённый заказ важнее истории браузера: "назад" не должен
  // возвращать к пустой форме чекаута/корзине, из которой можно случайно
  // создать дубль заказа (см. openQR/resumeExistingOrderFlow). Демо-заказ на
  // стадии "qr" (ещё не "оплачен") ведёт на экран QR, а не статуса — там
  // пока нечего показывать.
  if(initialRecoveryBlocked){
    s='rejected';
  }else if(currentOrderCode&&s!=='rejected'){
    const target=(!USE_API&&demoStage==='qr')?'qr':'status';
    if(s!==target){
      s=target;
      if(USE_API)pollOrderOnce();
      else if(target==='qr'){
        const{sum}=totals();
        document.getElementById('qr-amt').textContent=sum+' ₽';
        document.getElementById('cartbar').style.display='none';
      }
    }
  }
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
  const chosen=CANDIDATE_RESTAURANTS.find(v=>v.name===name);if(chosen)chosen.votes++;
  myVote=name;
  try{if(navigator.vibrate)navigator.vibrate(40);}catch(e){}
  renderVote();
}
function openVote(){renderVote();document.getElementById('vote-overlay').classList.add('on');document.getElementById('vote-sheet').classList.add('on');document.getElementById('vote-chip').classList.add('lit');document.body.style.overflow='hidden';}
function closeVote(){document.getElementById('vote-overlay').classList.remove('on');document.getElementById('vote-sheet').classList.remove('on');document.getElementById('vote-chip').classList.remove('lit');document.body.style.overflow='';}
let voteStartY=0,voteCurY=0,voteDragging=false;
function voteTouchStart(e){voteStartY=e.touches[0].clientY;voteCurY=0;voteDragging=true;document.getElementById('vote-sheet').style.transition='none';}
function voteTouchMove(e){
  if(!voteDragging)return;
  e.preventDefault();
  voteCurY=e.touches[0].clientY-voteStartY;
  const sh=document.getElementById('vote-sheet');
  // Штора висит сверху и полностью открыта в состоянии покоя — тянуть "вниз"
  // (в сторону, противоположную закрытию) её попросту некуда: раньше здесь был
  // лёгкий сдвиг вниз (voteCurY*0.3), который открывал щель у верхнего края.
  // Двигаем только вверх (закрытие), вниз — держим на месте.
  const y=Math.min(0,voteCurY);
  sh.style.transform=`translateX(-50%) translateY(${y}px)`;
}
function voteTouchEnd(){
  const sh=document.getElementById('vote-sheet');sh.style.transition='';voteDragging=false;
  if(voteCurY<-55)closeVote();
  sh.style.transform='';
}

// Черновик оформления (адрес/телефон/комментарий) — сохраняем по мере ввода,
// чтобы случайный refresh/закрытие вкладки до оплаты его не стирали.
['c-addr','c-phone','c-comment'].forEach(id=>{
  const el=document.getElementById(id);
  if(el)el.addEventListener('input',saveCartState);
});

renderList();
tryRestoreSession();
initIntroLayerFX();
