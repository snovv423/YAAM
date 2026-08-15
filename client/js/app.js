let curRest=null, cart={}, selectedCity='Грозный';
const SOLD_OUT={'2_0':true}; // демо: блюдо в стоп-листе (актуально только без бэкенда)

// Именованные тайминги/пороги — вместо магических чисел по всему файлу.
const RATING_MIN_VOTES=5;       // рейтинг на карточке показываем только от стольки оценок
// YAAM HQ Stage 1: бейдж NEW показываем, пока у ресторана меньше этого числа
// реально завершённых (delivered) заказов; начиная с этого числа — вместо
// NEW показываем счётчик заказов (см. formatOrdersCount ниже).
const NEW_BADGE_MAX_ORDERS=10;
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
const SHARE_TOKEN_PREFIX='yaam_shr_v1_';
const SHARE_TOKENS_STORAGE_KEY='yaam_order_share_tokens';
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
// YAAM HQ Stage 5B — публичный DTO (routes/postgresql/api.js) уже отдаёт
// primary_photo/gallery с готовыми URL трёх вариантов (thumb/card/full) и
// сам заботится о fallback на legacy photo_url, если владелец ещё не
// загрузил ни одной настоящей фотографии (задание, раздел 13) — здесь
// только приводим форму объекта к тому, что ждут render-функции ниже.
function normalizePhotoGallery(apiGallery){
  return (apiGallery||[]).map(p=>({thumb:p.urls.thumb,card:p.urls.card,full:p.urls.full,alt:p.alt||''}));
}
function normalizeRestaurant(r){
  return{
    id:r.id, name:r.name, cui:r.cuisine||'', photoUrl:r.primary_photo?r.primary_photo.urls.card:'', phone:r.phone||'', address:r.address||'',
    g:'linear-gradient(135deg,#3d6b4e,#1e4630)', im:null, gallery:normalizePhotoGallery(r.gallery),
    rate:r.rating||0, votes:r.rating_count||0, ordersCount:r.orders_count??null,
    hours:r.hours||'', deliv:r.delivery_price||0, min:r.min_order||0,
    open:!!r.is_open, isNew:!!r.is_new, cities:r.cities||[],
    menu:(r.menu||[]).map(cat=>({
      cat:cat.name,
      items:cat.items.map(it=>({
        id:it.id, n:it.name, d:it.description||'', p:it.price,
        g:'linear-gradient(135deg,#3d6b4e,#1e4630)', im:null, photoUrl:it.primary_photo?it.primary_photo.urls.card:'',
        gallery:normalizePhotoGallery(it.gallery),
        pop:!!it.is_popular, available:it.is_available!==0,
        w:it.weight_g, kcal:it.kcal, prot:it.protein_g, fat:it.fat_g, carb:it.carbs_g, s:it.composition,
      })),
    })),
  };
}
let restaurantsCache=[];

let cityRenderSeq=0;
async function selectCity(c){
  if(c===selectedCity)return;
  selectedCity=c;
  const renderSeq=++cityRenderSeq;
  document.querySelectorAll('#cities .citychip').forEach(ch=>ch.classList.toggle('sel',ch.textContent===c));
  const list=document.getElementById('list');
  // Старая карточка относится к предыдущему городу: убираем её сразу,
  // чтобы она не просвечивала под уже выбранным названием нового города.
  list.style.transition='none';
  list.style.opacity='0';
  list.innerHTML='';
  list.setAttribute('aria-busy','true');
  const rendered=await renderList(true,c,renderSeq);
  if(!rendered||renderSeq!==cityRenderSeq)return;
  list.removeAttribute('aria-busy');
  requestAnimationFrame(()=>{
    if(renderSeq!==cityRenderSeq)return;
    list.style.transition='opacity .18s ease';
    list.style.opacity='1';
  });
}

// Русское склонение слова "заказ" по числу — 1 заказ, 2 заказа, 5 заказов,
// 11 заказов, 21 заказ, 24 заказа, 25 заказов (стандартное правило: последняя
// цифра решает, ЕСЛИ предпоследние две не попадают в исключение 11-14).
function pluralOrders(n){
  const mod10=n%10, mod100=n%100;
  if(mod100>=11&&mod100<=14)return'заказов';
  if(mod10===1)return'заказ';
  if(mod10>=2&&mod10<=4)return'заказа';
  return'заказов';
}
// Компактное ru-RU форматирование счётчика заказов на публичной карточке.
// До 1000 — точное число со склонением ("219 заказов"). От 1000 — округление
// до тысяч с максимум одним знаком после запятой, и только если он не нулевой
// ("12,4 тыс. заказов", но "100 тыс. заказов", не "100,0 тыс. заказов") —
// осознанно не показываем бессмысленную точность вида "12,43 тыс.".
function formatOrdersCount(n){
  if(n<1000)return`${n} ${pluralOrders(n)}`;
  const thousands=Math.round(n/100)/10;
  const str=Number.isInteger(thousands)?String(thousands):String(thousands).replace('.',',');
  return`${str} тыс. заказов`;
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
      <div class="info"><div class="itop"><div class="cname">${r.name}${r.open&&(r.ordersCount||0)<NEW_BADGE_MAX_ORDERS?' <span class="newtag">NEW</span>':''}</div>${(r.ordersCount||0)>=NEW_BADGE_MAX_ORDERS?`<div class="ordcnt">${formatOrdersCount(r.ordersCount)}</div>`:''}</div><div class="ccui">${r.cui}</div>
        <div class="cmeta"><span><b>мин.</b> ${r.min} ₽</span><span>${r.hours}</span></div></div>
    </div></div>`;
}

async function renderList(instant,city=selectedCity,renderSeq=null){
  let base;
  let loadFailed=false;
  if(USE_API){
    try{
      const response=await api.getRestaurants(city);
      if(renderSeq!==null&&renderSeq!==cityRenderSeq)return false;
      base=response.map(normalizeRestaurant);
    }catch(err){
      if(renderSeq!==null&&renderSeq!==cityRenderSeq)return false;
      showToast('Не удалось загрузить рестораны — проверьте соединение');
      base=[];
      loadFailed=true;
    }
  }else{
    base=restaurants.filter(r=>r.cities.includes(city));
  }
  if(renderSeq!==null&&renderSeq!==cityRenderSeq)return false;
  restaurantsCache=base;
  const openR=base.filter(r=>r.open).sort((a,b)=>(b.isNew?1:0)-(a.isNew?1:0)||b.rate-a.rate);
  const closedR=base.filter(r=>!r.open);
  const el=document.getElementById('list');
  if(!base.length){
    el.innerHTML=loadFailed
      ? '<div class="empty">Не удалось загрузить рестораны.<br>Проверьте соединение и попробуйте ещё раз.</div>'
      : '<div class="empty">В этом городе пока нет ресторанов.<br>Скоро появятся — проголосуйте за свой город наверху!</div>';
    return true;
  }
  let html='';
  if(!openR.length){html+=`<div class="sleep"><h3>Город спит</h3><p>Сейчас всё закрыто — рестораны откроются позже.</p></div>`;}
  html+=openR.map(cardHTML).join('');
  if(closedR.length) html+=`<div class="grouplbl">Закрыты сейчас</div>`+closedR.map(cardHTML).join('');
  el.innerHTML=html;
  if(instant){return true;}      // смена города — сразу видимы, без анимации
  setTimeout(applyStagger,10);
  return true;
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
    // Stage 33 — вставлен новый шаг "Готов" между "Готовится" и "В пути":
    // ресторан закончил готовить, но курьер ещё не забрал заказ. Иконка
    // "clock" (та же, что и у ожидания ответа ресторана) — переиспользована,
    // не заведена новая (см. правило "единым SVG-набором" в CLAUDE.md).
    steps:['Принят','Готовится','Готов','В пути','Доставлен'],
    icons:['order','preparing','clock','delivery','check'],
    anims:['iconpop .5s cubic-bezier(.3,1.4,.4,1), pulse-glow 2s ease-in-out .5s infinite','iconpop .5s cubic-bezier(.3,1.4,.4,1), cooking 1s ease-in-out .5s infinite','iconpop .5s cubic-bezier(.3,1.4,.4,1), pulse-glow 2s ease-in-out .5s infinite','iconpop .5s cubic-bezier(.3,1.4,.4,1), riding .65s ease-in-out .5s infinite','delivered .65s cubic-bezier(.3,1.6,.4,1)'],
    statusToStep:{accepted:0,preparing:1,ready:2,courier:3,delivered:4},
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
// Серверный срок готовности (orders.preparation_deadline, ISO-строка). Клиент
// ТОЛЬКО читает его и считает остаток — собственный дедлайн не создаётся
// никогда, поэтому обновление страницы, закрытие браузера и открытие заказа
// на другом устройстве дают один и тот же отсчёт (docs/HQ-PRODUCT-SPEC.md,
// раздел «Таймер приготовления»).
let prepDeadlineMs=null;
let prepTimerId=null;
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

// Stage 33 — «Заказ получен»: courier -> delivered ТОЛЬКО по нажатию клиента
// (или серверным auto-complete, если клиент забыл — см. STAGE33 отчёт).
// "Заказ получен." — намеренно ТОЛЬКО toast (эфемерный, не сохраняется в
// order-состоянии): после hard reload/на другом устройстве заказ обязан
// показывать один и тот же нейтральный "Доставлен" независимо от того, кто
// именно нажал кнопку — тот же принцип, что уже защищает автозакрытые
// заказы от ложного "вы подтвердили получение" (задание, раздел 7).
async function confirmOrderReceipt(){
  const btn=document.getElementById('st-confirm-btn');
  if(btn)btn.disabled=true;
  try{
    if(USE_API&&currentOrderCode)await api.confirmOrderReceipt(currentOrderCode,currentOrderAccessToken);
    showToast('Заказ получен.');
    // Немедленный ре-опрос вместо ожидания следующего тика POLL_INTERVAL_MS —
    // тот же принцип мгновенной обратной связи, что и у submitRating() выше
    // (рейтинг обновляется отдельным сохранением состояния, здесь источник
    // истины — сам сервер, поэтому просто форсируем один внеочередной poll).
    if(USE_API&&currentOrderCode)await pollOrderOnce();
  }catch(err){
    showToast(err.message||'Не удалось подтвердить получение заказа');
  }finally{
    if(btn)btn.disabled=false;
  }
}

// Обратный отсчёт до готовности. Считается ОТ СЕРВЕРНОГО prepDeadlineMs, а
// не от локально запомненной длительности — именно поэтому refresh его не
// сбрасывает (ранее исправленный дефект pre-status таймера; не повторяем).
// Когда срок вышел — статус НЕ меняется и заказ НЕ отменяется, показывается
// только спокойное «Дольше ожидаемого» (спецификация).
function renderPrepTimer(){
  const sub=document.getElementById('st-substate');
  if(!sub)return;
  if(!prepDeadlineMs){
    sub.textContent=curEstimatedMinutes?`Готовится примерно ${curEstimatedMinutes} мин`:'Готовится';
    return;
  }
  const leftSec=Math.floor((prepDeadlineMs-Date.now())/1000);
  if(leftSec<=0){
    sub.textContent='Дольше ожидаемого';
    stopPrepTimer();
    return;
  }
  const m=Math.floor(leftSec/60),sec=leftSec%60;
  sub.textContent=`До готовности: ${m}:${sec<10?'0':''}${sec}`;
  if(!prepTimerId)prepTimerId=setInterval(renderPrepTimer,1000);
}

function stopPrepTimer(){
  if(prepTimerId){clearInterval(prepTimerId);prepTimerId=null;}
}

// Stage 27 — единственное место, разбирающее timestamp с backend, кем бы он
// ни был отправлен. Раньше в файле было ТРИ независимых попытки сделать это
// (эта функция, parseServerDeadline, parseServerCreatedAt) и один прямой
// Date.parse() без какой-либо защиты вообще (pollOrderOnce,
// status_updated_at) — именно четвёртое место дало Stage 26 H-1: PostgreSQL
// уже отдаёт полный ISO8601 со своим "Z" на конце ("...715Z"), а код
// БЕЗУСЛОВНО дописывал ЕЩЁ ОДИН "Z" (наследие SQLite-формата "YYYY-MM-DD
// HH:mm:ss" без пояса, где дописывание было необходимо) — результат
// "...715ZZ" не является датой, Date.parse() молча возвращает NaN.
//
// Правило одно: строка УЖЕ содержит 'T' -> это уже ISO8601 (с 'Z' или с
// числовым offset, с миллисекундами или без) -> передаём как есть, ничего
// не дописываем. Строки без 'T' — только legacy SQLite-формат, всегда UTC по
// соглашению этого проекта — дописываем 'T'/'Z' один раз. Также прозрачно
// принимает уже готовый Date и число (мс с эпохи).
function parseServerTimestamp(value){
  if(value instanceof Date){
    const t=value.getTime();
    return Number.isFinite(t)?t:null;
  }
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!value)return null;
  const normalized=value.includes('T')?value:value.replace(' ','T')+'Z';
  const parsed=Date.parse(normalized);
  return Number.isFinite(parsed)?parsed:null;
}

// Применяет серверное значение к клиентскому состоянию. NULL с сервера
// (заказ ещё не готовится либо уже передан курьеру) гасит таймер.
function applyPreparationDeadline(order){
  const iso=order&&order.preparation_deadline;
  if(!iso){prepDeadlineMs=null;stopPrepTimer();return;}
  prepDeadlineMs=parseServerTimestamp(iso);
}

function renderStatus(){
  const{steps,icons,anims}=stepSet();
  document.getElementById('st-progress').innerHTML=steps.map((s,i)=>`<div class="pstep ${i<statusStep?'done':''} ${i===statusStep?'cur':''}"><div class="pline"></div><div class="pdot">${i<statusStep?'✓':i+1}</div><div class="plbl">${s}</div></div>`).join('');
  document.getElementById('st-state').textContent=steps[statusStep];
  // Stage 33 — у delivery появился шаг "Готов" (индекс 2) между "Готовится"
  // (1) и "В пути"/курьер (сдвинулся с 2 на 3). У pickup своего "ready" нет
  // (там всего 3 шага), поэтому оба условия проверяют currentFulfillment.
  const isReadyStep=currentFulfillment==='delivery'&&statusStep===2;
  const isCourierStep=currentFulfillment==='delivery'&&statusStep===3;
  // время готовки от ресторана — на шаге «Готовится»; статичные пояснения —
  // на «Готов» (ждём курьера) и «В пути» (курьер уже забрал).
  const sub=document.getElementById('st-substate');
  if(sub){
    if(statusStep===1){renderPrepTimer();sub.style.display='block';}
    else if(isReadyStep){stopPrepTimer();sub.textContent='Ожидаем курьера.';sub.style.display='block';}
    else if(isCourierStep){stopPrepTimer();sub.textContent='Курьер забрал заказ из ресторана.';sub.style.display='block';}
    else{stopPrepTimer();sub.style.display='none';}
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
  const mGallery=curRest.gallery||[];
  const heroHasSrc=!!(mGallery.length||curRest.photoUrl||curRest.im);
  h.classList.toggle('nophoto',!heroHasSrc);
  h.style.background=curRest.g;
  if(heroHasSrc){
    const heroSrc=mGallery.length?mGallery[0].full:(curRest.photoUrl||U(curRest.im,900));
    const img=new Image();img.src=heroSrc;img.alt=mGallery.length?(mGallery[0].alt||''):'';img.onerror=function(){h.classList.add('nophoto');this.remove()};h.insertBefore(img,h.firstChild);
  }
  renderGallery('m',mGallery,false);
  document.getElementById('m-name').textContent=curRest.name;
  const showRating=curRest.votes>=RATING_MIN_VOTES;
  document.getElementById('m-meta').innerHTML=`${showRating?`<span>★ ${curRest.rate} · ${curRest.votes}</span>`:''}<span>Часы: ${curRest.hours}</span>`;
  document.getElementById('msb-name').textContent=curRest.name;
  document.getElementById('msb-rate').textContent=showRating?`★ ${curRest.rate}`:'';
  const tabs=curRest.menu.map(c=>c.cat);
  document.getElementById('m-tabs').innerHTML=tabs.map((t,i)=>`<button type="button" class="mtab ${i===0?'on':''}" onclick="scrollToMenuSection(${i})">${esc(t)}</button>`).join('');
  renderMenuBody(); go('menu'); updateBar();
  window.scrollTo(0,0);
  initMenuScrollFX();
}

// Компактная плашка ресторана при скролле меню + подсветка активной категории
// + лёгкий скролл-параллакс на фото ресторана (transform-only, работает и на тач-устройствах,
// в отличие от прежнего hover-параллакса на главной, который на мобильном просто не срабатывал).
let catObserver=null, menuScrollHandler=null, menuCategoryScrollLockUntil=0;
function centerMenuTab(tab){
  const strip=document.getElementById('m-tabs');
  if(!strip||!tab)return;
  const target=tab.offsetLeft-(strip.clientWidth-tab.offsetWidth)/2;
  strip.scrollTo({left:Math.max(0,target),behavior:'smooth'});
}
function setActiveMenuTab(idx){
  const tabs=[...document.querySelectorAll('#m-tabs .mtab')];
  tabs.forEach((tab,i)=>tab.classList.toggle('on',i===idx));
  centerMenuTab(tabs[idx]);
}
function menuScrollBehavior(from,to,viewportHeight){
  return Math.abs(to-from)>Math.max(viewportHeight*2,1400)?'auto':'smooth';
}
function scrollToMenuSection(idx){
  const section=document.getElementById('sec'+idx);
  if(!section)return;
  const sticky=document.querySelector('.menu-sticky-group');
  const tabsStrip=document.getElementById('m-tabs');
  // При прыжке с самого верха компактная 44px-плашка ещё скрыта, но после
  // прокрутки появится. Сразу резервируем её будущую высоту, чтобы заголовок
  // далёкой категории не оказался под sticky-группой.
  const offset=Math.max(sticky?sticky.offsetHeight:0,(tabsStrip?tabsStrip.offsetHeight:0)+44)+8;
  const top=window.scrollY+section.getBoundingClientRect().top-offset;
  const target=Math.max(0,top);
  const behavior=menuScrollBehavior(window.scrollY,target,window.innerHeight);
  menuCategoryScrollLockUntil=Date.now()+(behavior==='smooth'?900:150);
  setActiveMenuTab(idx);
  window.scrollTo({top:target,behavior});
}
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
    if(Date.now()<menuCategoryScrollLockUntil)return;
    entries.forEach(en=>{
      if(!en.isIntersecting)return;
      const idx=sections.indexOf(en.target);
      setActiveMenuTab(idx);
    });
  },{rootMargin:'-96px 0px -75% 0px'});
  sections.forEach(s=>catObserver.observe(s));
}
// Название/описание блюда и название категории теперь свободный текст,
// вводимый владельцем ресторана в YAAM HQ (Stage 5A) — экранирование перед
// вставкой в innerHTML обязательно (задание, раздел 17: "любой
// пользовательский текст должен escaping-иться... при public client
// render"). d-name/d-sostav используют .textContent (безопасно сами по
// себе) — esc() нужен именно там, где текст идёт через innerHTML-шаблоны.
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function key(ci,ii){return ci+'_'+ii;}
function findItem(k){const[ci,ii]=k.split('_').map(Number);const d=curRest.menu[ci].items[ii];return{n:d.n.replace(/'/g,''),p:d.p,id:d.id||null};}
function dishCard(d,ci,ii){
  const k=key(ci,ii);const q=cart[k]?cart[k].q:0;const so=SOLD_OUT[k]||d.available===false;
  const hasSrc=!!(d.photoUrl||d.im);
  const photoSrc=hasSrc?(d.photoUrl||U(d.im,700)):'';
  const safePhotoSrc=esc(photoSrc);
  const photo=hasSrc?`<img data-src="${safePhotoSrc}" loading="lazy" decoding="async" onerror="this.dataset.failed='1';this.closest('.dphoto').classList.add('nophoto');this.removeAttribute('src')">`:'';
  return `<div class="dish ${so?'dis':''}" ${so?'':`onclick="openDish('${k}')"`}>
    <div class="dphoto ${hasSrc?'':'nophoto'}" style="background:${d.g}">${photo}
    <div class="dplate"><div class="dname">${esc(d.n)}${d.pop?' <span class="hit">Хит</span>':''}</div><div class="ddesc">${esc(d.d)}</div></div>
    <div class="dactions"><div class="dprice">${d.p} ₽</div>${so?'<span class="soldout">Нет в наличии</span>':`<div data-ctrl-key="${k}" onclick="event.stopPropagation()">${q>0?qtyHtml(k,q):`<button class="add" onclick="addItem('${k}',event)">+</button>`}</div>`}</div></div></div>`;
}
function renderMenuBody(){
  let html='';
  curRest.menu.forEach((c,ci)=>{html+=`<div class="cat-h" id="sec${ci}">${esc(c.cat)}</div>`+c.items.map((d,ii)=>dishCard(d,ci,ii)).join('');});
  document.getElementById('m-body').innerHTML=html;
  initDishImageVirtualization();
}
let dishImageObserver=null;
function initDishImageVirtualization(){
  if(dishImageObserver)dishImageObserver.disconnect();
  const photos=[...document.querySelectorAll('#m-body .dphoto')];
  dishImageObserver=new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      const img=entry.target.querySelector('img[data-src]');
      if(!img||img.dataset.failed==='1')return;
      if(entry.isIntersecting){
        if(!img.getAttribute('src'))img.src=img.dataset.src;
      }else{
        img.removeAttribute('src');
      }
    });
  },{rootMargin:'1200px 0px'});
  photos.forEach(photo=>dishImageObserver.observe(photo));
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
        address:currentOrderAddress,comment:currentOrderComment,
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
// Stage 11A follow-up: серверный payment_expires_at/paymentExpiresAt —
// абсолютный ISO-timestamp, всегда UTC (см. orderService.js на бэкенде).
// Возвращает null, а не Date.now()-fallback: отсутствие серверного значения
// (старый backend без этого поля, либо заказ не в awaiting_payment) должно
// оставлять qrDeadline как есть — ЕДИНСТВЕННЫЙ fallback на клиентский
// QR_TIMER_SEC остаётся в startQRTimer() ниже, только если дедлайна вообще
// никогда не было.
function parseServerDeadline(value){
  return parseServerTimestamp(value);
}
function parseServerCreatedAt(value,fallback){
  const parsed=parseServerTimestamp(value);
  return parsed!==null?parsed:(Number(fallback)||Date.now());
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
  currentOrderAddress=typeof savedOrder.address==='string'?savedOrder.address:'';
  currentOrderComment=typeof savedOrder.comment==='string'?savedOrder.comment:'';
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
  // Stage 35.1 — order (реальный ответ createOrder/recoverOrder, тот же
  // owner-protected toPublicOrderDTO, что и polling) теперь САМ возвращает
  // address/comment — авторитетный источник, переживающий потерю
  // localStorage/открытие на другом устройстве. safeContext
  // (fallbackContext из Stage 35) остаётся только переходным fallback'ом —
  // на случай если по какой-то причине order их не содержит (например,
  // recoverOrder() ответ старого формата). typeof-проверка на обоих
  // уровнях: легитимная пустая строка "нет адреса/комментария" не должна
  // подменяться ни устаревшим fallback, ни считаться "не пришло".
  currentOrderAddress=typeof order.address==='string'?order.address
    :(typeof safeContext.address==='string'?safeContext.address:'');
  currentOrderComment=typeof order.comment==='string'?order.comment
    :(typeof safeContext.comment==='string'?safeContext.comment:'');
  const fulfillmentSource=order.fulfillment_type||safeContext.fulfillmentType;
  if(fulfillmentSource)currentFulfillment=fulfillmentSource==='pickup'?'pickup':'delivery';
  orderCreatedAtMs=parseServerCreatedAt(safeContext.createdAt,credentials.submittedAt||credentials.createdAt);
  // Единая точка входа и для СВЕЖЕГО заказа (createOrder), и для recover/exact
  // replay — оба пути проходят через applyRecoveredOrder(). Дедлайн приходит
  // от сервера (payment.paymentExpiresAt) и должен браться отсюда ОДИНАКОВО в
  // обоих случаях: recover/replay не создаёт новый дедлайн просто потому, что
  // сервер сам никогда не меняет уже выданный (см. Stage 11A follow-up ADR).
  if(payment?.paymentExpiresAt)qrDeadline=parseServerDeadline(payment.paymentExpiresAt);
  const activeStateSaved=saveOrderState();
  // Только после надёжного active snapshot удаляем recovery capability.
  if(activeStateSaved)clearPendingOrderCredentials(credentials);
  initialRecoveryBlocked=false;
  currentCreateIdempotencyKey=null;
  await loadOrderRestaurant(currentOrderRestaurantId);
  return order;
}
function showRecoveredOrder(order){
  if(order.status!=='awaiting_payment'){
    startOrderPolling();
    return;
  }
  document.getElementById('qr-amt').textContent=(currentOrderAmount||0)+' ₽';
  document.getElementById('cartbar').style.display='none';
  renderQRPaymentOptions();
  // startQRTimer() (не startNewQRTimer()) — qrDeadline уже выставлен в
  // applyRecoveredOrder() из серверного payment.paymentExpiresAt, здесь его
  // нельзя перезатирать свежим клиентским Date.now()+QR_TIMER_SEC: и для
  // реально нового заказа, и для recover/replay значение уже верное.
  drawQR();startQRTimer();go('qr');startOrderPollingQuiet();
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
  document.getElementById('st-items').innerHTML=orderItemsHTML()+orderTotalHTML()+orderDeliveryHTML();
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

let curDishKey=null,curDishPrice=0,dishQty=1,menuReturnScrollY=0;
function rememberMenuPosition(){
  if(!cur('menu'))return;
  menuReturnScrollY=Math.max(0,Number(window.scrollY)||0);
  try{
    history.replaceState({...history.state,screen:'menu',menuScrollY:menuReturnScrollY},'');
  }catch(e){}
}
function restoreMenuPosition(value=menuReturnScrollY){
  const target=Math.max(0,Number(value)||0);
  menuReturnScrollY=target;
  // Два кадра дают Safari закончить переключение .screen до восстановления
  // прокрутки; фиксированная высота карточек делает позицию стабильной.
  requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo(0,target)));
}
function backFromDish(){
  if(typeof history.back==='function'){
    history.back();
    return;
  }
  go('menu');
  restoreMenuPosition();
}
function openDish(k){
  rememberMenuPosition();
  curDishKey=k;const[ci,ii]=k.split('_').map(Number);const d=curRest.menu[ci].items[ii];
  // из API приходят реальные значения (могут быть пустыми, если владелец
  // ресторана их не заполнил в YAAM HQ — Stage 5A позволяет создать блюдо
  // вовсе без БЖУ); в демо-режиме — из локального справочника DETAILS.
  // Признак режима — USE_API, а не "есть ли конкретно у этого блюда kcal":
  // раньше здесь стояло d.kcal!=null, из-за чего РЕАЛЬНОЕ блюдо с полностью
  // пустой пищевой ценностью (валидный сценарий, задание Stage 5A: "БЖУ не
  // обязательны") тихо получало ПОДДЕЛЬНЫЕ демо-цифры (300г/450 ккал/...)
  // вместо честного "—" — ровно то, что задание запрещает ("никаких
  // hardcoded demo values").
  const fromApi=USE_API;
  const det=fromApi
    ? {w:d.w||'—',kcal:d.kcal??'—',p:d.prot??'—',f:d.fat??'—',c:d.carb??'—',s:d.s||'Состав не указан'}
    : (DETAILS[d.n]||{w:300,kcal:450,p:20,f:20,c:40,s:'Натуральные ингредиенты'});
  const h=document.getElementById('d-hero');h.querySelectorAll('img').forEach(x=>x.remove());
  // Реальная галерея (Stage 5B) приходит только из API — d.gallery всегда
  // непустая, если у блюда есть хоть одно фото (сервер сам заворачивает
  // legacy photo_url в gallery из одного элемента — см. buildPhotoFields в
  // routes/postgresql/api.js), поэтому demo-режим (POOL-заглушки) ниже
  // остаётся полностью нетронутым отдельной веткой.
  const dGallery=fromApi?(d.gallery||[]):[];
  const dishHasSrc=!!(dGallery.length||d.photoUrl||d.im);
  h.classList.toggle('nophoto',!dishHasSrc);
  h.style.background=d.g;
  if(dishHasSrc){
    const heroSrc=dGallery.length?dGallery[0].full:(d.photoUrl||U(d.im,1000));
    const img=new Image();img.src=heroSrc;img.alt=dGallery.length?(dGallery[0].alt||''):'';img.onerror=function(){h.classList.add('nophoto');this.remove()};h.insertBefore(img,h.firstChild);
    h.style.setProperty('--dhero-bg','url("'+heroSrc+'")');
  }
  renderGallery('d',dGallery);
  if(!dGallery.length){
    const gallery=document.getElementById('d-gallery');
    if(dishHasSrc){
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
function addFromDish(){const it=findItem(curDishKey);cart[curDishKey]={n:it.n,p:it.p,q:dishQty,menuItemId:it.id};refreshAll(curDishKey);backFromDish();}
function swapHero(id,i){
  const src=U(id,1000);
  const img=document.querySelector('#d-hero img');if(img)img.src=src;
  const heroEl=document.getElementById('d-hero');if(heroEl)heroEl.style.setProperty('--dhero-bg','url("'+src+'")');
  document.querySelectorAll('#d-gallery .thumb').forEach((t,j)=>t.classList.toggle('on',j===i));
}

// YAAM HQ Stage 5B — реальная многофотографийная галерея (ресторан/блюдо),
// без сторонних библиотек: тумб-стрип с горизонтальным нативным скроллом
// (свайп на мобильном "бесплатно"), плюс явные кнопки-стрелки и счётчик
// поверх hero (задание, раздел 9/10 — swipe не единственный способ листать,
// стрелки/счётчик обязательны, ничего из этого не показывается при одной
// фотографии). prefix — 'm' (ресторан, #m-hero/#m-gallery/#m-gprev/...) или
// 'd' (блюдо, #d-hero/#d-gallery/...). Кнопки-тумбы — реальные <button>, а
// не <div onclick>, ради клавиатурной доступности (задание, раздел 10).
let galleryState={};
// showArrows=false для 'm' (шапка ресторана): там поверх hero уже лежит
// название переменной высоты (.hero-info, до 2 строк) — стрелки поверх
// низкого 190px-hero рисковали бы перекрывать длинные названия. Тумб-стрип
// под hero уже даёт равноценную не-swipe навигацию (клик по любой миниатюре),
// поэтому явные стрелки для 'm' не показываются, только счётчик (он в
// верхнем углу, вне зоны заголовка). У 'd' (блюдо) своего наложенного
// текста на hero нет — стрелки включены.
function renderGallery(prefix,photos,showArrows){
  galleryState[prefix]={photos:photos||[],index:0};
  const stripEl=document.getElementById(prefix+'-gallery');
  const prevBtn=document.getElementById(prefix+'-gprev');
  const nextBtn=document.getElementById(prefix+'-gnext');
  const countEl=document.getElementById(prefix+'-gcount');
  const multi=galleryState[prefix].photos.length>1;
  const arrowsOn=multi&&showArrows!==false;
  if(prevBtn)prevBtn.style.display=arrowsOn?'flex':'none';
  if(nextBtn)nextBtn.style.display=arrowsOn?'flex':'none';
  if(countEl)countEl.style.display=multi?'block':'none';
  if(stripEl){
    stripEl.innerHTML=multi?galleryState[prefix].photos.map((p,i)=>
      `<button type="button" class="thumb ${i===0?'on':''}" aria-label="Фото ${i+1} из ${galleryState[prefix].photos.length}" onclick="gallerySet('${prefix}',${i})"><img src="${p.thumb}" alt="${esc(p.alt)}" loading="lazy"></button>`
    ).join(''):'';
  }
  gallerySet(prefix,0);
}
function gallerySet(prefix,i){
  const st=galleryState[prefix];
  const n=st?st.photos.length:0;
  if(!n)return;
  const idx=((i%n)+n)%n;
  st.index=idx;
  const photo=st.photos[idx];
  const heroImg=document.querySelector('#'+prefix+'-hero img');
  if(heroImg){heroImg.src=photo.full;heroImg.alt=photo.alt||'';}
  // Размытый фон "большой галереи" (только у блюда — #d-hero, задание:
  // "фон галереи должен выглядеть аккуратно при несовпадении пропорций") —
  // тот же URL, что и сам <img>, через CSS custom property (см. .dhero::before).
  const heroEl=document.getElementById(prefix+'-hero');
  if(heroEl)heroEl.style.setProperty('--dhero-bg','url("'+photo.full+'")');
  const stripEl=document.getElementById(prefix+'-gallery');
  if(stripEl)stripEl.querySelectorAll('.thumb').forEach((t,j)=>t.classList.toggle('on',j===idx));
  const countEl=document.getElementById(prefix+'-gcount');
  if(countEl&&n>1)countEl.textContent=(idx+1)+' / '+n;
}
function galleryStep(prefix,delta){const st=galleryState[prefix];if(st)gallerySet(prefix,st.index+delta);}

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
// Stage 35, раздел 3.2 — quantity/name/price раздельными DOM-элементами
// (не одна строка "${qty} × ${name} ${price} ₽"), чтобы длинное название
// блюда переносилось само по себе, никогда не задевая цену. ₽ остаётся
// приклеен к сумме через white-space:nowrap на .oi-price (см. css/style.css).
// nameHtml принимается уже готовым (esc()/без esc() — на усмотрение
// вызывающей стороны, тот же принцип, что был у соответствующих строк раньше).
function orderItemRowHTML(qty,nameHtml,priceTotal){
  return `<div class="order-item"><span class="oi-qty">${qty}×</span><span class="oi-name">${nameHtml}</span><span class="oi-price">${priceTotal} ₽</span></div>`;
}
// Строки заказа — используются в корзине и на двух экранах статуса.
function orderItemsHTML(){
  const items=currentOrderCode&&currentOrderItems.length?currentOrderItems:Object.values(cart);
  return items.map(c=>orderItemRowHTML(c.q,c.n,c.p*c.q)).join('');
}
// Stage 35, раздел 3.4 — «Итого» отдельным визуальным блоком под составом,
// не смешанным с ценами позиций (переиспользует уже существующий класс
// .sumrow.total — тот же, что и в корзине оформления). currentOrderAmount —
// уже авторитетное серверное значение (order.items_total из applyRecoveredOrder/
// pollOrderOnce), НЕ пересчитывается заново на клиенте.
function orderTotalHTML(){
  if(!Number.isFinite(currentOrderAmount))return'';
  return `<div class="sumrow total"><span>Итого</span><span>${currentOrderAmount} ₽</span></div>`;
}
// Stage 35, раздел 3.5 — адрес отдельным структурированным блоком, не частью
// длинного текста. Только delivery (у pickup адрес — это адрес РЕСТОРАНА,
// уже показанный при оформлении, здесь новых полей не изобретаем — задание:
// "не придумывать новые поля, которых нет в модели"). Только собственный
// статус-экран владельца заказа — НЕ sharedOrderItemsHTML(): чужая read-only
// ссылка "Поделиться" не должна раскрывать домашний адрес клиента постороннему.
function orderDeliveryHTML(){
  if(currentFulfillment!=='delivery'||!currentOrderAddress)return'';
  const commentHtml=currentOrderComment
    ?`<div class="order-delivery-comment">${esc(currentOrderComment)}</div>`:'';
  return `<div class="order-delivery"><div class="order-delivery-title">Доставка</div><div class="order-delivery-addr">${esc(currentOrderAddress)}</div>${commentHtml}</div>`;
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
// Stage 35 — адрес/комментарий заказа для структурированного блока «Доставка»
// на статус-экране (задание, раздел 3.5). Тот же принцип, что и currentOrderItems
// выше: захватываются ОДИН РАЗ в момент оформления (из чекаут-формы), кэшируются
// в localStorage (saveOrderState/hydrateStoredOrder), сервер их НЕ возвращает
// через toPublicOrderDTO — это чисто клиентское эхо собственного ввода
// владельца заказа, поэтому НЕ используется в sharedOrderItemsHTML() (чужая
// read-only ссылка не должна получать домашний адрес клиента).
let currentOrderAddress=null, currentOrderComment=null;
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
        // Stage 35 — только для локального эха в active-order snapshot этого
        // же браузера (см. applyRecoveredOrder/saveOrderState ниже), НЕ для
        // pending-credentials localStorage (та хранит только две capability,
        // см. комментарий выше) — тот же trust boundary, что и items.
        address:apiPayload.address,fulfillmentType:apiPayload.fulfillmentType,comment:apiPayload.comment,
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
      currentOrderAddress=payload.address||'';
      currentOrderComment=payload.comment||'';
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
// на проде), затем единственный реальный шаг ожидания: ответ ресторана (окно 7 мин).
// Stage 31, раздел 4 — было 300 (5 мин), синхронизировано с PostgreSQL-стороной
// (RESTAURANT_RESPONSE_WINDOW_SEC в server/services/postgresql/orderService.js).
// Клиент — статический файл без доступа к серверному модулю, поэтому
// значение здесь ручное, а не импортированное; при демо (USE_API=false) это
// единственный источник истины (нет backend вовсе), при реальном API —
// только для отображения (сервер проверяет независимо, sweepTimeouts).
const RESTAURANT_RESPONSE_WINDOW_SEC=420;
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
  statusStep=0;inPreStatus=true;curEstimatedMinutes=null;prepDeadlineMs=null;stopPrepTimer();ratingSubmitted=false;ratingJustNow=false;setOrderTime(orderCreatedAtMs);
  document.getElementById('st-num').textContent=currentOrderCode; // и demo (openStatus), и API (startOrderPolling/pollOrderOnce) — один и тот же реальный код, не HTML-заглушка
  document.getElementById('st-items').innerHTML=orderItemsHTML()+orderTotalHTML()+orderDeliveryHTML();
  document.getElementById('statusbg').style.display='block';
  showStatusSpinner(true);
  // Кнопка «Поделиться» скрыта по умолчанию здесь — до первого реального
  // ответа сервера ЕЩЁ НЕИЗВЕСТНО, оплачен ли заказ (см. pollOrderOnce(),
  // которая и включает её, только когда статус подтверждённо "после оплаты":
  // awaiting_restaurant/accepted/preparing/courier/delivered). Показывать
  // её здесь безусловно означало бы делиться и заказом, ожидающим оплаты
  // (см. renderAwaitingPayment() — тот же экран #status).
  const shareBtn=document.getElementById('st-share-btn');
  if(shareBtn)shareBtn.style.display='none';
}
// Единая точка включения/выключения «Поделиться» — вызывается ТОЛЬКО из
// pollOrderOnce() по подтверждённому серверному статусу (awaiting_restaurant/
// accepted/preparing/courier/delivered = оплата подтверждена), никогда по
// предположению или локальному состоянию. USE_API — тот же гейт, что и
// раньше (без бэкенда ссылку некому обслужить на другом устройстве).
function setShareButtonVisible(visible){
  const shareBtn=document.getElementById('st-share-btn');
  if(shareBtn)shareBtn.style.display=(visible&&USE_API)?'inline-flex':'none';
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
  currentOrderCode=null;currentOrderAccessToken=null;currentCreateIdempotencyKey=null;currentRetryIdempotencyKey=null;currentPaymentUrl=null;currentOrderAmount=null;currentOrderRestaurantId=null;currentOrderItems=[];currentOrderAddress=null;currentOrderComment=null;orderCreatedAtMs=null;
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
    // retry — явно утверждённая новая платёжная попытка (новый providerPaymentId),
    // сервер выдаёт под неё СВОЙ новый payment.paymentExpiresAt (см. Stage 11A
    // follow-up) — используем его, а не старый qrDeadline. Fallback на свежий
    // клиентский дедлайн — только если backend почему-то не прислал значение
    // (совместимость со старой версией сервера), это ВСЁ РАВНО новая попытка.
    qrDeadline=parseServerDeadline(payment?.paymentExpiresAt)||(Date.now()+QR_TIMER_SEC*1000);
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
    drawQR();startQRTimer();go('qr');
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
      // Тот же provider_idempotency_key (recoveryKey) — это восстановление
      // УЖЕ существующей попытки после потерянного HTTP-ответа, а не новая
      // попытка (см. Stage 11A follow-up: сервер финализирует retry ровно
      // один раз и возвращает тот же payment.paymentExpiresAt при повторном
      // вызове с тем же ключом). Использовать серверное значение — обязательно,
      // придумывать новый клиентский дедлайн здесь нельзя: иначе именно
      // потеря HTTP-ответа обнуляла бы уже идущий отсчёт.
      qrDeadline=parseServerDeadline(payment?.paymentExpiresAt)||qrDeadline||(Date.now()+QR_TIMER_SEC*1000);
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
const KNOWN_ORDER_STATUSES=['awaiting_payment','awaiting_restaurant','accepted','preparing','ready','courier','delivered','declined','timed_out','cancelled','payment_failed'];
let unknownOrderStatusNoticeShown=false; // не спамить тем же тостом каждые POLL_INTERVAL_MS, пока статус остаётся нераспознанным
// order.refund_status (см. GET /api/orders/:code) — публичный, уже суженный
// словарь: none | processing | done | failed. Внутренние состояния
// (requested/processing на сервере) сюда никогда не попадают.
function refundStatusMessage(refundStatus,amount){
  const sumHtml=amount?`<b>${amount.toLocaleString('ru-RU')} ₽</b> `:'';
  if(refundStatus==='processing')return `Возврат ${sumHtml}обрабатывается. Деньги будут возвращены после подтверждения платёжного сервиса.`;
  if(refundStatus==='done')return `Возврат ${sumHtml}подтверждён. Срок зачисления зависит от банка.`;
  // Stage 31, раздел 7 — ссылка на поддержку была текстовой ("Обратитесь в
  // поддержку YAAM"), без реальной ссылки: пользователю в ошибке возврата
  // нечего было нажать. renderRefundLine() пишет через innerHTML — здесь
  // безопасно вставить <a>, разметка постоянная (без пользовательского
  // ввода внутри), тот же href, что уже используется в футере/юридических
  // страницах (client/index.html).
  if(refundStatus==='failed')return 'Возврат не завершён автоматически. Обратитесь в <a href="https://t.me/YAAMHELP" target="_blank" rel="noopener">поддержку YAAM</a>.';
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
  // Каждый polling-тик подтверждает актуальный серверный дедлайн этой же
  // попытки (сервер его никогда не меняет — см. Stage 11A follow-up), это не
  // "продление": значение либо совпадает с уже известным, либо заполняет
  // qrDeadline, если он ещё не был известен в этой вкладке.
  if(order.payment_expires_at){
    const parsed=parseServerDeadline(order.payment_expires_at);
    if(parsed)qrDeadline=parsed;
  }
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
  currentOrderCode=null;currentOrderAccessToken=null;currentCreateIdempotencyKey=null;currentRetryIdempotencyKey=null;currentPaymentUrl=null;currentOrderAmount=null;currentOrderRestaurantId=null;currentOrderItems=[];currentOrderAddress=null;currentOrderComment=null;orderCreatedAtMs=null;
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
  // Stage 35.1 — сервер (owner-protected toPublicOrderDTO, требует order
  // access token) теперь тоже возвращает address/comment — единственный
  // источник истины, переживающий потерю localStorage/открытие заказа на
  // другом устройстве. currentOrderAddress/currentOrderComment (Stage 35,
  // из fallbackContext/yaam_active_order) остаются только переходным
  // fallback'ом до этого момента — как только пришёл реальный ответ
  // сервера, он побеждает безусловно (typeof-проверка, а не ||, чтобы
  // легитимная пустая строка "нет комментария" не подменялась устаревшим
  // client-side значением). Полный state заказа локально не хранит
  // "адрес ещё не пришёл" отдельным флагом — просто перезаписываем на
  // каждом poll-тике тем, что реально пришло, тем же принципом, что и
  // currentOrderAmount/ratingSubmitted выше.
  if(typeof order.address==='string')currentOrderAddress=order.address;
  if(typeof order.comment==='string')currentOrderComment=order.comment;
  // #st-items уже мог быть заполнен initStatusScreen() ДО этого поля (или
  // вообще без localStorage — путой строкой) — пересобираем целиком тем же
  // набором функций, что и initStatusScreen(), теперь уже с авторитетными
  // данными. Дёшево (несколько span/div), идемпотентно.
  document.getElementById('st-items').innerHTML=orderItemsHTML()+orderTotalHTML()+orderDeliveryHTML();
  document.getElementById('st-num').textContent=order.public_code;
  if(order.estimated_ready_minutes)curEstimatedMinutes=order.estimated_ready_minutes;
  applyPreparationDeadline(order);
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
    setShareButtonVisible(false); // не даём делиться неоплаченным заказом (см. renderAwaitingPayment ниже — тот же #status экран)
    renderAwaitingPayment(order);
  }else if(order.status==='awaiting_restaurant'){
    // Реальный статус подтверждён сервером — с этого момента #st-substate
    // ведёт ТОЛЬКО этот блок (пересчитывается заново на каждом poll-тике из
    // order.status_updated_at, серверной правды). До Stage 27 preTimer
    // (клиентская догадка о дедлайне из renderWaitForRestaurant/
    // restoreDemoOrder) не останавливался здесь и мог продолжать писать в
    // тот же элемент раз в секунду поверх/вперемешку с этим блоком — второй
    // независимый таймер на один и тот же экран, который и обнажил Stage 26
    // H-1 сложнее, чем просто "одна невалидная дата".
    clearInterval(preTimer);preTimer=null;clearTimeout(preAutoTimer);preDeadline=null;
    inPreStatus=false;
    showOrderDot(true); // оплата подтверждена, заказ реально пошёл в работу
    setShareButtonVisible(true);
    showStatusSpinner(false);
    document.getElementById('st-progress').style.display='none';
    document.getElementById('st-state').textContent='Заказ отправлен, ждём ответа ресторана';
    // Stage 31.1, Issue 3 — раньше здесь пересчитывался НЕЗАВИСИМЫЙ дедлайн
    // (status_updated_at + локальная RESTAURANT_RESPONSE_WINDOW_SEC), той
    // же формулой, которой sweepTimeouts() пользовался ДО Stage 31, раздела
    // 1.3. После того как backend стал честно считать окно от факта
    // ДОСТАВКИ Telegram-уведомления (COALESCE(bot_notifications.sent_at,
    // status_updated_at)), клиент с этой независимой формулой начал
    // расходиться с backend при задержанной доставке — показывал бы "0:00"
    // раньше, чем заказ реально просрочится на сервере. order.
    // restaurant_response_deadline_at — тот же авторитетный ISO-timestamp,
    // вычисленный СЕРВЕРОМ той же формулой, что и sweepTimeouts (см.
    // orderService.js RESTAURANT_RESPONSE_DEADLINE_SUBQUERY) — тот же
    // принцип, что уже доказан для preparation_deadline/payment_expires_at.
    const deadlineMs=parseServerTimestamp(order.restaurant_response_deadline_at);
    if(deadlineMs===null){
      // Невалидная/отсутствующая дата с backend — не выдумываем таймер и не
      // показываем NaN:NaN, честно показываем состояние без обратного отсчёта.
      document.getElementById('st-substate').textContent='Ждём ответа ресторана';
    }else{
      const left=Math.max(0,Math.floor((deadlineMs-Date.now())/1000));
      const m=Math.floor(left/60),s=left%60;
      document.getElementById('st-substate').textContent=`Ответ ресторана в течение ${m}:${s<10?'0':''}${s}`;
    }
    document.getElementById('st-substate').style.display='block';
    const ic=document.getElementById('st-icon');ic.innerHTML=uiIcon('clock');
    document.getElementById('st-next').style.display='none';
    document.getElementById('st-demowrap').style.display='none';
    document.getElementById('st-cancel-wrap').style.display='block';
  }else if(stepSet().statusToStep[order.status]!==undefined){
    inPreStatus=false;
    statusStep=stepSet().statusToStep[order.status];
    // Stage 28 HIGH-1: восстановление заказа (refresh/переоткрытие вкладки),
    // чей ПЕРВЫЙ реальный poll после initStatusScreen()'s showStatusSpinner(true)
    // уже не awaiting_restaurant (тот единственный сосед по if/else явно снимал
    // спиннер, эта ветка — нет), оставляло спиннер крутиться навсегда поверх
    // корректно отрисованных ниже данных (accepted/preparing/courier/delivered),
    // включая форму оценки на уже доставленном заказе. showStatusSpinner(false)
    // должен быть здесь безусловно — по тому же принципу, что и в соседней
    // ветке awaiting_restaurant, а не только когда статус впервые дошёл сюда
    // через живой poll в открытой вкладке.
    showStatusSpinner(false);
    document.getElementById('st-progress').style.display='flex';
    document.getElementById('st-next').style.display='none'; // статус двигает ресторан по-настоящему, не демо-кнопка
    document.getElementById('st-demowrap').style.display='none';
    document.getElementById('st-cancel-wrap').style.display='none';
    // Stage 33 — «Заказ получен» видна ТОЛЬКО пока курьер везёт заказ.
    // Источник истины — серверный order.status на каждом poll-тике, не
    // локальный statusStep (тот же принцип, что и у остальных wrap-блоков
    // на этом экране) — переживает hard reload/другое устройство/restart.
    document.getElementById('st-confirm-wrap').style.display=order.status==='courier'?'block':'none';
    showOrderDot(true); // accepted/preparing/ready/courier — renderStatus сам выключит на delivered
    setShareButtonVisible(true);
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

// ---------------------------------------------------------------------------
// Фича «Поделиться заказом» (Web Share API).
//
// Отдельная read-only capability (SHARE_TOKEN_PREFIX), НЕ access_token
// владельца — сервер регистрирует её через POST /orders/:code/share и
// принимает только на GET /orders/:code/shared (см. requireOrderShareAccess
// в routes/postgresql/api.js). Эта ссылка физически не может отменить заказ,
// повторить оплату или поставить оценку — даже если получатель перешлёт её
// дальше или откроет с чужого устройства.
//
// Кэш share-токенов — отдельный localStorage-ключ, НЕ часть yaam_active_order
// и не проходит через Web Lock критическую секцию владельческого состояния:
// это независимая, гораздо менее критичная capability (потеря/рассинхрон
// максимум означает генерацию новой ссылки, не порчу заказа).
// ---------------------------------------------------------------------------
function readShareTokenCache(){
  try{return JSON.parse(localStorage.getItem(SHARE_TOKENS_STORAGE_KEY)||'{}');}catch(e){return{};}
}
function cacheShareToken(code,token){
  const map=readShareTokenCache();
  map[code]=token;
  try{localStorage.setItem(SHARE_TOKENS_STORAGE_KEY,JSON.stringify(map));}catch(e){/* не критично — просто перегенерируем при следующем нажатии */}
}
async function ensureShareToken(code,accessToken){
  const cached=readShareTokenCache()[code];
  if(validCapability(cached,SHARE_TOKEN_PREFIX))return cached;
  const fresh=randomCapability(SHARE_TOKEN_PREFIX);
  await api.createShareLink(code,accessToken,fresh);
  cacheShareToken(code,fresh);
  return fresh;
}
function buildShareUrl(code,token){
  return `${location.origin}${location.pathname}#shared=${encodeURIComponent(code)}:${encodeURIComponent(token)}`;
}
async function copyShareUrl(url){
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText){
      await navigator.clipboard.writeText(url);
    }else{
      const ta=document.createElement('textarea');
      ta.value=url;ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();
      try{document.execCommand('copy');}finally{ta.remove();}
    }
    showToast('Ссылка скопирована');
  }catch(e){
    showToast('Не удалось скопировать ссылку');
  }
}
// Вызывается кнопкой «Поделиться» на статус-экране владельца (см.
// initStatusScreen(), #st-share-btn). Без бэкенда (demo) ссылку некому
// обслужить на другом устройстве — честно сообщаем об этом, а не создаём
// нерабочую ссылку.
async function shareOrder(){
  if(!USE_API||!currentOrderCode||!currentOrderAccessToken){
    showToast('Ссылка «Поделиться» доступна только для заказов, оформленных через сервер');
    return;
  }
  const btn=document.getElementById('st-share-btn');
  if(btn)btn.disabled=true;
  try{
    const token=await ensureShareToken(currentOrderCode,currentOrderAccessToken);
    const url=buildShareUrl(currentOrderCode,token);
    if(navigator.share){
      try{
        await navigator.share({title:'YAAM — статус заказа',text:`Заказ ${currentOrderCode}`,url});
      }catch(err){
        // Пользователь сам закрыл системный лист «Поделиться» — это не
        // ошибка, ничего не копируем и не показываем (не навязываем
        // альтернативу тому, кто явно отказался делиться).
        if(err&&err.name==='AbortError')return;
        // Реальная техническая ошибка Web Share (нет доступных приложений,
        // платформа не поддерживает конкретный тип данных и т.п.) — НЕ
        // копируем молча: предлагаем явное действие, которое пользователь
        // должен подтвердить сам.
        yaamConfirm(
          'Не удалось поделиться через приложения. Скопировать ссылку вместо этого?',
          ()=>{copyShareUrl(url);},
          {yes:'Скопировать ссылку',no:'Отмена'},
        );
      }
    }else{
      await copyShareUrl(url);
    }
  }catch(err){
    showToast('Не удалось создать ссылку — проверьте соединение');
  }finally{
    if(btn)btn.disabled=false;
  }
}

// ---------------------------------------------------------------------------
// Read-only просмотр статуса ПО ЧУЖОЙ ссылке «Поделиться» (#shared=CODE:TOKEN).
//
// Намеренно НЕ трогает currentOrderCode/currentOrderAccessToken/
// yaam_active_order/saveOrderState — получатель ссылки может открыть её на
// устройстве, где уже есть СВОЙ активный заказ, и это не должно его затереть
// или подменить. Собственный, отдельный от pollOrderOnce() рендер: то же
// самое DOM (#status), но без единого владельческого действия (cancel/
// retry-payment/rate/«На главную»/демо-кнопки) — они либо скрыты, либо явно
// заменены нейтральным read-only текстом.
// ---------------------------------------------------------------------------
let sharedViewPollTimer=null;
function parseSharedHash(){
  const h=location.hash;
  if(!h||!h.startsWith('#shared='))return null;
  const raw=h.slice('#shared='.length);
  const sep=raw.indexOf(':');
  if(sep<0)return null;
  let code,token;
  try{code=decodeURIComponent(raw.slice(0,sep));token=decodeURIComponent(raw.slice(sep+1));}catch(e){return null;}
  if(!/^YAAM-\d+$/.test(code)||!validCapability(token,SHARE_TOKEN_PREFIX))return null;
  return{code,token};
}
// Строит state состава заказа для read-only просмотра ИЗ ответа сервера
// (toSharedOrderDTO), не из currentOrderItems/cart — та же экранирование
// названий блюд, что и остальной пользовательский текст (esc()), в отличие
// от orderItemsHTML() (владельческий экран, отдельная функция, не трогаем).
function sharedOrderItemsHTML(order){
  const rows=(order.items||[]).map(i=>orderItemRowHTML(i.qty,esc(i.name),i.price*i.qty)).join('');
  const total=Number.isFinite(order.items_total)?`<div class="sumrow total"><span>Итого</span><span>${order.items_total} ₽</span></div>`:'';
  return rows+total;
}
function applySharedOrderToDom(order){
  document.getElementById('st-num').textContent=order.public_code;
  // is_paid — безопасный boolean из toSharedOrderDTO (сервер), не сырой
  // payment_status и не провайдерский код. #st-time здесь уже не занят
  // владельческим "заказ оформлен в HH:MM" (openSharedOrder() очищает его),
  // поэтому переиспользуем то же место для понятного read-only индикатора.
  document.getElementById('st-time').textContent=order.is_paid?'Заказ оплачен':'';
  document.getElementById('st-items').innerHTML=sharedOrderItemsHTML(order);
  document.getElementById('statusbg').style.display='block';
  showStatusSpinner(false);
  currentFulfillment=order.fulfillment_type==='pickup'?'pickup':'delivery';
  showRestaurantPhone(order.restaurant_phone);

  const REJECTED_LABELS={declined:'Ресторан отклонил заказ',timed_out:'Время ожидания истекло',cancelled:'Заказ отменён',payment_failed:'Оплата не прошла'};
  if(order.status==='awaiting_payment'){
    document.getElementById('st-progress').style.display='none';
    document.getElementById('st-state').textContent='Ожидает оплаты';
    document.getElementById('st-substate').style.display='none';
    const ic=document.getElementById('st-icon');if(ic)ic.innerHTML=uiIcon('payment');
  }else if(order.status==='awaiting_restaurant'){
    document.getElementById('st-progress').style.display='none';
    document.getElementById('st-state').textContent='Заказ отправлен, ждём ответа ресторана';
    document.getElementById('st-substate').style.display='none';
    const ic=document.getElementById('st-icon');if(ic)ic.innerHTML=uiIcon('clock');
  }else if(stepSet().statusToStep[order.status]!==undefined){
    statusStep=stepSet().statusToStep[order.status];
    if(order.estimated_ready_minutes)curEstimatedMinutes=order.estimated_ready_minutes;
    ratingSubmitted=true; // читатель чужой ссылки никогда не видит форму оценки
    document.getElementById('st-progress').style.display='flex';
    renderStatus();
    if(statusStep===stepSet().steps.length-1){
      document.getElementById('st-rating-wrap').innerHTML='<p class="rating-thanks">Это ссылка «Поделиться» — только просмотр статуса.</p>';
    }
  }else{
    document.getElementById('st-progress').style.display='none';
    document.getElementById('st-state').textContent=REJECTED_LABELS[order.status]||'Статус временно недоступен';
    document.getElementById('st-substate').style.display='none';
  }
  // Read-only просмотр — ни одного владельческого действия. Выполняется
  // ПОСЛЕДНИМ: renderStatus() выше сама переключает st-next/st-demowrap/
  // st-final по statusStep (последний шаг vs нет) — эта правка должна
  // побеждать после неё, иначе владельческие demo-кнопки снова появятся.
  document.getElementById('st-next').style.display='none';
  document.getElementById('st-demowrap').style.display='none';
  document.getElementById('st-cancel-wrap').style.display='none';
  document.getElementById('st-pending-pay-wrap').style.display='none';
  document.getElementById('st-final').style.display='none';
  // Stage 33 — «Заказ получен» тоже владельческое действие (требует
  // orderAccessToken, не share-токена) — читатель чужой ссылки его не видит.
  document.getElementById('st-confirm-wrap').style.display='none';
}
async function pollSharedOrderOnce(code,token){
  let order;
  try{order=await api.getSharedOrder(code,token);}
  catch(err){
    clearInterval(sharedViewPollTimer);
    document.getElementById('st-progress').innerHTML='';
    document.getElementById('st-state').textContent='Ссылка недействительна или устарела';
    document.getElementById('st-substate').style.display='none';
    return;
  }
  applySharedOrderToDom(order);
  if(['delivered','declined','timed_out','cancelled'].includes(order.status))clearInterval(sharedViewPollTimer);
}
async function openSharedOrder(code,token){
  document.getElementById('st-num').textContent=code;
  document.getElementById('st-items').innerHTML='';
  document.getElementById('st-time').textContent='';
  document.getElementById('statusbg').style.display='block';
  showStatusSpinner(true);
  go('status');
  await pollSharedOrderOnce(code,token);
  clearInterval(sharedViewPollTimer);
  sharedViewPollTimer=setInterval(()=>pollSharedOrderOnce(code,token),POLL_INTERVAL_MS);
}

function cur(id){return document.getElementById(id).classList.contains('active');}
function go(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');document.querySelector('.dish-add').style.display=(id==='dish')?'block':'none';if(id!=='status'&&id!=='rejected')document.getElementById('statusbg').style.display='none';window.scrollTo(0,0);updateBar();if(id==='home'&&introFadeHandler)introFadeHandler();try{if(id!=='home')history.pushState({screen:id},'');else history.replaceState({screen:'home'},'');}catch(e){}}
function resetAll(){
  const orderCodeForClear=currentOrderCode,orderTokenForClear=currentOrderAccessToken;
  clearInterval(preTimer);clearTimeout(preAutoTimer);preDeadline=null;stopQRTimer();qrDeadline=null;stopOrderPolling();showRestaurantPhone(null);showOrderDot(false);cart={};curRest=null;currentOrderCode=null;currentOrderAccessToken=null;currentCreateIdempotencyKey=null;currentRetryIdempotencyKey=null;currentPaymentUrl=null;currentOrderAmount=null;currentOrderRestaurantId=null;currentOrderItems=[];currentOrderAddress=null;currentOrderComment=null;orderCreatedAtMs=null;initialRecoveryBlocked=false;demoStage='qr';
  // Stage 27 (L-1) — cart={} выше уже верно сбрасывает СОСТОЯНИЕ, но штора
  // корзины (#sheet/#sheet-overlay) — независимый оверлей, а не .screen:
  // go('home') ниже прячет только нижнюю сумму-кнопку (updateBar() внутри
  // go()), но НЕ трогает уже открытую штору. Если пользователь отменял заказ
  // прямо с открытой шторой корзины (например, только что вернулся с экрана
  // оформления), она оставалась видимой со старыми позициями и активной
  // кнопкой «Оформить заказ» до следующего открытия — притом что диалог
  // отмены прямо обещает "корзина будет очищена". closeSheet() + очистка её
  // innerHTML устраняют оба симптома сразу: штора не просто скрыта классом,
  // старых позиций/суммы не остаётся и в самом DOM.
  closeSheet();
  const si=document.getElementById('sheet-items');if(si)si.innerHTML='';
  const stw=document.getElementById('sheet-total-wrap');if(stw)stw.innerHTML='';
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
  const menuScrollY=s==='menu'?(e.state&&e.state.menuScrollY!=null?e.state.menuScrollY:menuReturnScrollY):0;
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
  if(s==='menu')restoreMenuPosition(menuScrollY);
}catch(err){}});

// Голосование за рестораны, которых ещё нет в YAAM. Источник данных (после
// Stage 28, раздел 2): USE_API=true -> HQ-управляемый список через
// api.getRestaurantCandidates() (единственный источник истины — HQ "Кого
// ждём"); USE_API=false (demo-режим, backend не задеплоен) -> локальный
// CANDIDATE_RESTAURANTS из data.js, как и раньше. voteCandidates — рабочая
// копия (не мутируем сам CANDIDATE_RESTAURANTS/ответ сервера напрямую).
//
// Stage 29.1, п.3 — реальный, персистентный голос в USE_API-режиме:
// api.voteRestaurantCandidate() пишет в PostgreSQL (один голос с устройства
// на кандидата — сервер идемпотентен сам по себе, см.
// services/hq/restaurantCandidateService.js), а не только в памяти вкладки.
// deviceId — случайный localStorage-идентификатор, НЕ персональные данные
// (не логин, не имя, не телефон — просто "тот же браузер уже голосовал").
// demo-режим (USE_API=false) сохраняет прежнее клиент-локальное поведение —
// backend в demo нет физически, писать голос некуда.
let myVote=null; // только demo-режим
let voteCandidates=null;
const VOTER_DEVICE_ID_KEY='yaam_voter_device_id';
const VOTED_CANDIDATES_KEY='yaam_voted_candidate_ids';
function getVoterDeviceId(){
  try{
    let id=localStorage.getItem(VOTER_DEVICE_ID_KEY);
    if(!id){
      id=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():('dev_'+Date.now()+'_'+Math.random().toString(36).slice(2));
      localStorage.setItem(VOTER_DEVICE_ID_KEY,id);
    }
    return id;
  }catch(e){return 'dev_fallback_'+Math.random().toString(36).slice(2);} // приватный режим браузера без localStorage — голос всё равно уйдёт, просто не запомнится локально
}
function getVotedCandidateIds(){
  try{return new Set(JSON.parse(localStorage.getItem(VOTED_CANDIDATES_KEY)||'[]'));}catch(e){return new Set();}
}
function markCandidateVoted(id){
  try{
    const ids=getVotedCandidateIds();ids.add(id);
    localStorage.setItem(VOTED_CANDIDATES_KEY,JSON.stringify([...ids]));
  }catch(e){/* не критично — сервер всё равно не даст переголосовать этим же deviceId */}
}
function renderVote(){
  const list=voteCandidates||[];
  if(!list.length){
    document.getElementById('vote-list').innerHTML='<div class="empty">Пока нет кандидатов на голосование.</div>';
    return;
  }
  list.sort((a,b)=>b.votes-a.votes);
  const max=Math.max(...list.map(v=>v.votes),1);
  const votedIds=USE_API?getVotedCandidateIds():null;
  document.getElementById('vote-list').innerHTML=list.map(v=>{
    const key=USE_API?v.id:v.name;
    const voted=USE_API?votedIds.has(v.id):myVote===v.name;
    return `
    <div class="vote-item">
      <div class="vote-row">
        <span class="vote-name">${esc(v.name)}</span>
        <span class="vote-count">${v.votes} голосов</span>
        <button class="vbtn ${voted?'voted':''}"${voted?' disabled':''} onclick="castVote(${JSON.stringify(key)})">${voted?'✓':'+'}</button>
      </div>
      <div class="vbar"><i style="width:${Math.round(v.votes/max*100)}%"></i></div>
    </div>`;
  }).join('');
}
async function castVote(key){
  if(!voteCandidates)return;
  if(!USE_API){
    // demo-режим — прежнее клиент-локальное single-choice поведение
    // (переключение голоса между кандидатами), backend не существует.
    if(myVote===key)return;
    if(myVote){const prev=voteCandidates.find(v=>v.name===myVote);if(prev)prev.votes--;}
    const chosen=voteCandidates.find(v=>v.name===key);if(chosen)chosen.votes++;
    myVote=key;
    try{if(navigator.vibrate)navigator.vibrate(40);}catch(e){}
    renderVote();
    return;
  }
  const candidate=voteCandidates.find(v=>v.id===key);
  if(!candidate||getVotedCandidateIds().has(key))return; // защита от двойного клика до ответа сервера — сам сервер тоже идемпотентен
  markCandidateVoted(key); // оптимистично — блокирует повторный клик немедленно, сервер ниже подтвердит/поправит счётчик
  renderVote();
  try{
    const result=await api.voteRestaurantCandidate(key,getVoterDeviceId());
    candidate.votes=result.votes; // источник истины — ответ сервера, не локальный инкремент
    try{if(navigator.vibrate)navigator.vibrate(40);}catch(e){}
  }catch(err){
    if(err.status===404){
      // Кандидат удалён владельцем, пока лист был открыт — честно убираем.
      voteCandidates=voteCandidates.filter(v=>v.id!==key);
      showToast('Этот кандидат больше не участвует в голосовании');
    }else{
      showToast(err.message||'Не удалось отправить голос — проверьте соединение');
    }
  }
  renderVote();
}
async function openVote(){
  document.getElementById('vote-overlay').classList.add('on');document.getElementById('vote-sheet').classList.add('on');document.getElementById('vote-chip').classList.add('lit');document.body.style.overflow='hidden';
  if(USE_API){
    try{voteCandidates=await api.getRestaurantCandidates();}
    catch(err){voteCandidates=voteCandidates||[];showToast('Не удалось загрузить список — проверьте соединение');}
  }else if(!voteCandidates){
    voteCandidates=CANDIDATE_RESTAURANTS.map(v=>({...v}));
  }
  renderVote();
}
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

// Production frontend не показывает прежний staging-индикатор. Условие
// сохранено как безопасный guard для совместимости разметки.
if(typeof IS_STAGING_MODE!=='undefined'&&IS_STAGING_MODE){
  const stgBadge=document.getElementById('stgBadge');
  if(stgBadge)stgBadge.hidden=false;
}

renderList();
// Ссылка «Поделиться» (#shared=CODE:TOKEN) обрабатывается ДО восстановления
// собственной сессии посетителя — иначе tryRestoreSession() перехватила бы
// экран своим активным заказом. Без бэкенда (USE_API=false, demo-режим)
// такую ссылку обслуживать нечем — тихо игнорируем хэш, как обычную загрузку.
const sharedLink=USE_API?parseSharedHash():null;
if(sharedLink){
  try{history.replaceState(history.state||{},'',location.pathname+location.search);}catch(e){/* не критично */}
  openSharedOrder(sharedLink.code,sharedLink.token);
}else{
  tryRestoreSession();
}
initIntroLayerFX();
