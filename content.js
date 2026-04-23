// ================================================================
// SYNAPSE 2.0 — COMPLETE CONTENT SCRIPT
// Modes: Section Cards (AI-detected) | Full Page Reformat
// Features: Floating cards, dock navigation, feedback loop
// ================================================================

// ── State ────────────────────────────────────────────────────────
const S = {
  mode: 'cards',
  active: false,
  sections: [],
  currentSection: 0,
  originalHTML: null,
  fullpageActive: false,
  panelOpen: false,
  activeCard: null,
  activeCardIdx: null,
  observer: null,
  analysing: false,
};

const Z = {
  dock:  2147483641,
  card:  2147483642,
  panel: 2147483643,
  fab:   2147483644,
};

const C = {
  green:      '#1D9E75',
  greenDark:  '#0F6E56',
  greenLight: '#E1F5EE',
  greenMid:   '#9FE1CB',
  greenDeep:  '#085041',
  gold:       '#F5C842',
  white:      '#ffffff',
  g50:        '#fafafa',
  g100:       '#f4f4f4',
  g200:       '#e8e8e8',
  g400:       '#aaaaaa',
  g600:       '#666666',
  g900:       '#111111',
  red:        '#e74c3c',
};

// ================================================================
// STYLES
// ================================================================
function injectStyles() {
  if (document.getElementById('synapse-styles')) return;
  const s = document.createElement('style');
  s.id = 'synapse-styles';
  s.textContent = `
#synapse-fab,#synapse-panel,#synapse-dock,
.synapse-card,.synapse-badge,.synapse-section-wrap,
#synapse-fullpage-bar{all:initial;box-sizing:border-box;
font-family:-apple-system,'Segoe UI',system-ui,sans-serif}
*,*::before,*::after{box-sizing:inherit}

/* FAB */
#synapse-fab{position:fixed!important;bottom:28px!important;right:28px!important;
width:52px!important;height:52px!important;border-radius:50%!important;
background:${C.green}!important;border:none!important;cursor:pointer!important;
z-index:${Z.fab}!important;display:flex!important;align-items:center!important;
justify-content:center!important;
transition:transform .22s cubic-bezier(.16,1,.3,1),background .18s!important;
box-shadow:0 4px 20px rgba(29,158,117,.35)!important}
#synapse-fab:hover{background:${C.greenDark}!important;transform:scale(1.07)!important}
#synapse-fab.open{transform:rotate(45deg) scale(1.05)!important;background:${C.greenDark}!important}
#synapse-fab svg{width:24px!important;height:24px!important;fill:white!important;display:block!important}
#synapse-fab .s-dot{position:absolute!important;top:5px!important;right:5px!important;
width:11px!important;height:11px!important;border-radius:50%!important;
background:${C.gold}!important;border:2px solid white!important;display:none!important}
#synapse-fab.s-active .s-dot{display:block!important}
#synapse-fab.s-analysing{animation:synapse-fab-pulse 1.2s ease-in-out infinite!important}
@keyframes synapse-fab-pulse{0%,100%{box-shadow:0 4px 20px rgba(29,158,117,.35)}
50%{box-shadow:0 4px 32px rgba(29,158,117,.7)}}

/* PANEL */
#synapse-panel{position:fixed!important;bottom:92px!important;right:28px!important;
width:276px!important;background:${C.white}!important;
border:1px solid ${C.g200}!important;border-radius:18px!important;
z-index:${Z.panel}!important;overflow:hidden!important;
transform:scale(.88) translateY(16px)!important;opacity:0!important;
pointer-events:none!important;
transition:transform .24s cubic-bezier(.16,1,.3,1),opacity .18s ease!important;
box-shadow:0 8px 40px rgba(0,0,0,.12)!important}
#synapse-panel.s-visible{transform:scale(1) translateY(0)!important;
opacity:1!important;pointer-events:all!important}
.sp-head{padding:16px 18px 12px!important;border-bottom:1px solid ${C.g100}!important;
display:flex!important;align-items:center!important;gap:10px!important}
.sp-logo{font-size:14px!important;font-weight:700!important;color:${C.green}!important;
letter-spacing:-.02em!important;display:block!important;line-height:1!important}
.sp-sub{font-size:11px!important;color:${C.g400}!important;display:block!important;
margin-top:2px!important;line-height:1!important}
.sp-logo-dot{width:8px!important;height:8px!important;border-radius:50%!important;
background:${C.green}!important;flex-shrink:0!important;display:block!important;margin-left:auto!important}
.sp-mode-row{padding:12px 18px!important;border-bottom:1px solid ${C.g100}!important}
.sp-mode-label{font-size:10px!important;font-weight:600!important;letter-spacing:.08em!important;
text-transform:uppercase!important;color:${C.g400}!important;display:block!important;margin-bottom:8px!important}
.sp-mode-toggle{display:flex!important;border:1px solid ${C.g200}!important;
border-radius:10px!important;overflow:hidden!important}
.sp-mode-opt{flex:1!important;padding:7px 6px!important;font-size:11px!important;
font-weight:500!important;text-align:center!important;cursor:pointer!important;
background:transparent!important;border:none!important;color:${C.g600}!important;
transition:background .15s,color .15s!important;line-height:1.3!important;font-family:inherit!important}
.sp-mode-opt.s-on{background:${C.green}!important;color:white!important}
.sp-actions{padding:12px 18px 16px!important;display:flex!important;
flex-direction:column!important;gap:7px!important}
.sp-hint{font-size:11px!important;color:${C.g400}!important;line-height:1.5!important;
text-align:center!important;padding:0 4px!important;display:block!important}
.sp-hint.s-error{color:${C.red}!important}
.sp-btn{width:100%!important;padding:10px 14px!important;border-radius:10px!important;
font-size:12.5px!important;font-family:inherit!important;font-weight:600!important;
cursor:pointer!important;border:none!important;
transition:background .15s,transform .1s!important;text-align:center!important;
display:block!important;line-height:1!important}
.sp-btn:active{transform:scale(.97)!important}
.sp-btn.primary{background:${C.green}!important;color:white!important}
.sp-btn.primary:hover{background:${C.greenDark}!important}
.sp-btn.primary:disabled{background:${C.greenMid}!important;cursor:not-allowed!important}
.sp-btn.ghost{background:${C.g100}!important;color:${C.g600}!important}
.sp-btn.ghost:hover{background:${C.g200}!important}

/* SECTION WRAPPERS */
.synapse-section-wrap{position:relative!important;display:block!important;
border-radius:8px!important;transition:box-shadow .2s,outline .2s!important;
outline:2px solid transparent!important;outline-offset:6px!important}
.synapse-section-wrap.s-highlighted{outline:2px solid ${C.greenMid}!important;
box-shadow:0 0 0 6px rgba(29,158,117,.04)!important}
.synapse-section-wrap.s-active{outline:2.5px solid ${C.green}!important;
box-shadow:0 0 0 6px rgba(29,158,117,.08)!important}

/* BADGES */
.synapse-badge{position:absolute!important;top:-10px!important;left:-10px!important;
width:24px!important;height:24px!important;border-radius:50%!important;
background:${C.green}!important;color:white!important;font-size:11px!important;
font-weight:700!important;display:flex!important;align-items:center!important;
justify-content:center!important;cursor:pointer!important;z-index:10!important;
border:2px solid white!important;transition:transform .18s,background .15s!important;
box-shadow:0 2px 8px rgba(29,158,117,.3)!important;line-height:1!important}
.synapse-badge:hover{transform:scale(1.18)!important;background:${C.greenDark}!important}
.synapse-badge.s-loading{background:${C.greenMid}!important}
.synapse-badge.s-done{background:${C.greenDark}!important}
.synapse-badge svg.s-ring{position:absolute!important;top:-3px!important;left:-3px!important;
width:30px!important;height:30px!important;transform:rotate(-90deg)!important;display:block!important}
.s-ring circle{fill:none!important;stroke:${C.gold}!important;stroke-width:2.5!important;
stroke-linecap:round!important;stroke-dasharray:75.4!important;stroke-dashoffset:75.4!important;
transition:stroke-dashoffset .6s ease!important}

/* BADGE TOOLTIP */
.synapse-badge-tooltip{position:absolute!important;bottom:calc(100% + 10px)!important;
left:50%!important;transform:translateX(-50%)!important;
background:rgba(17,17,17,.92)!important;color:white!important;
font-size:11px!important;font-family:-apple-system,'Segoe UI',sans-serif!important;
padding:6px 10px!important;border-radius:8px!important;
white-space:normal!important;max-width:200px!important;line-height:1.4!important;
opacity:0!important;pointer-events:none!important;
transition:opacity .15s!important;z-index:99999!important;text-align:center!important;
width:max-content!important}
.synapse-badge:hover .synapse-badge-tooltip{opacity:1!important}

/* FLOATING CARD */
.synapse-card{position:absolute!important;left:50%!important;
transform:translateX(-50%) translateY(-8px)!important;
width:min(480px,90vw)!important;background:${C.white}!important;
border:1px solid ${C.g200}!important;border-radius:18px!important;
z-index:${Z.card}!important;
box-shadow:0 16px 60px rgba(0,0,0,.14),0 4px 16px rgba(0,0,0,.07)!important;
overflow:hidden!important;opacity:0!important;
transition:opacity .22s ease,transform .28s cubic-bezier(.16,1,.3,1)!important;
pointer-events:none!important}
.synapse-card.s-visible{opacity:1!important;
transform:translateX(-50%) translateY(0)!important;pointer-events:all!important}
.synapse-card::after{content:''!important;position:absolute!important;
bottom:-8px!important;left:50%!important;transform:translateX(-50%)!important;
width:16px!important;height:8px!important;background:${C.white}!important;
clip-path:polygon(0 0,100% 0,50% 100%)!important;
filter:drop-shadow(0 2px 2px rgba(0,0,0,.06))!important;display:block!important}
.sc-topbar{display:flex!important;align-items:center!important;
justify-content:space-between!important;padding:13px 16px 11px!important;
border-bottom:1px solid ${C.g100}!important}
.sc-title{font-size:12px!important;font-weight:700!important;color:${C.green}!important;
display:flex!important;align-items:center!important;gap:6px!important;line-height:1!important}
.sc-title-dot{width:6px!important;height:6px!important;border-radius:50%!important;
background:${C.green}!important;display:inline-block!important;
animation:synapse-pulse 2s ease-in-out infinite!important}
@keyframes synapse-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.7)}}
.sc-section-name{font-size:11px!important;color:${C.g400}!important;
max-width:220px!important;overflow:hidden!important;text-overflow:ellipsis!important;
white-space:nowrap!important;display:block!important;line-height:1!important;margin-top:2px!important}
.sc-close{width:26px!important;height:26px!important;border-radius:50%!important;
border:none!important;background:${C.g100}!important;cursor:pointer!important;
font-size:14px!important;color:${C.g600}!important;display:flex!important;
align-items:center!important;justify-content:center!important;
transition:background .15s!important;flex-shrink:0!important;
font-family:inherit!important;line-height:1!important}
.sc-close:hover{background:${C.g200}!important}
.sc-loading{display:flex!important;align-items:center!important;
justify-content:center!important;flex-direction:column!important;
gap:12px!important;padding:36px 24px!important}
.sc-spinner{width:26px!important;height:26px!important;
border:3px solid ${C.greenLight}!important;border-top-color:${C.green}!important;
border-radius:50%!important;animation:synapse-spin .65s linear infinite!important;display:block!important}
@keyframes synapse-spin{to{transform:rotate(360deg)}}
.sc-loading-text{font-size:12px!important;color:${C.g400}!important;line-height:1!important}
.sc-body{padding:16px 18px 4px!important;max-height:340px!important;
overflow-y:auto!important;display:none!important;
scrollbar-width:thin!important;scrollbar-color:${C.greenMid} transparent!important}
.sc-body.s-ready{display:block!important}
.sc-body h1,.sc-body h2{font-size:1rem!important;font-weight:700!important;
color:${C.g900}!important;margin:0 0 10px!important;padding-bottom:6px!important;
border-bottom:2px solid ${C.green}!important;line-height:1.3!important}
.sc-body h3{font-size:.9rem!important;font-weight:600!important;color:#333!important;
margin:12px 0 5px!important;line-height:1.3!important}
.sc-body p{font-size:.88rem!important;color:#333!important;
margin-bottom:9px!important;line-height:1.7!important}
.sc-body ul,.sc-body ol{padding-left:1.2rem!important;margin-bottom:9px!important}
.sc-body li{font-size:.88rem!important;color:#333!important;
margin-bottom:5px!important;line-height:1.6!important}
.sc-body strong{color:${C.g900}!important;font-weight:600!important}
.sc-body mark{background:${C.greenLight}!important;color:${C.greenDeep}!important;
padding:1px 5px!important;border-radius:3px!important;font-weight:500!important}
.sc-body a{color:${C.green}!important}

/* FEEDBACK STRIP */
.sc-feedback{border-top:1px solid ${C.g100}!important;
padding:12px 18px 14px!important;display:flex!important;
flex-direction:column!important;gap:9px!important}
.sc-feedback-label{font-size:10px!important;font-weight:700!important;
letter-spacing:.08em!important;text-transform:uppercase!important;
color:${C.g400}!important;display:block!important;line-height:1!important}
.sc-feedback-reactions{display:flex!important;gap:6px!important}
.sc-reaction{flex:1!important;padding:7px 4px!important;border-radius:8px!important;
border:1.5px solid ${C.g200}!important;background:${C.white}!important;
font-size:11px!important;font-weight:600!important;cursor:pointer!important;
color:${C.g600}!important;transition:all .15s!important;text-align:center!important;
font-family:inherit!important;line-height:1.3!important}
.sc-reaction:hover{border-color:${C.greenMid}!important;
background:${C.greenLight}!important;color:${C.greenDeep}!important}
.sc-reaction.s-selected-good{background:${C.green}!important;
border-color:${C.green}!important;color:white!important}
.sc-reaction.s-selected-bad{background:#fff3f3!important;
border-color:#fca5a5!important;color:${C.red}!important}
.sc-reaction.s-selected-neutral{background:#fffbeb!important;
border-color:#fcd34d!important;color:#92400e!important}
.sc-feedback-input-row{display:flex!important;gap:6px!important;align-items:center!important}
.sc-feedback-input{flex:1!important;padding:7px 10px!important;
border-radius:8px!important;border:1.5px solid ${C.g200}!important;
background:${C.g50}!important;font-size:11.5px!important;
font-family:inherit!important;color:${C.g900}!important;outline:none!important;
transition:border-color .15s!important;line-height:1!important}
.sc-feedback-input:focus{border-color:${C.green}!important;background:white!important}
.sc-feedback-input::placeholder{color:${C.g400}!important}
.sc-feedback-send{width:30px!important;height:30px!important;border-radius:50%!important;
background:${C.green}!important;border:none!important;cursor:pointer!important;
display:flex!important;align-items:center!important;justify-content:center!important;
flex-shrink:0!important;transition:background .15s,transform .1s!important;font-family:inherit!important}
.sc-feedback-send:hover{background:${C.greenDark}!important}
.sc-feedback-send:active{transform:scale(.93)!important}
.sc-feedback-send svg{width:13px!important;height:13px!important;
fill:white!important;display:block!important}
.sc-feedback-thanks{font-size:11px!important;color:${C.green}!important;
font-weight:600!important;text-align:center!important;padding:4px 0!important;
display:none!important;line-height:1!important;animation:synapse-fadein .3s ease!important}
@keyframes synapse-fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}

/* DOCK */
#synapse-dock{position:fixed!important;bottom:0!important;left:50%!important;
transform:translateX(-50%) translateY(100%)!important;z-index:${Z.dock}!important;
background:rgba(255,255,255,.96)!important;
backdrop-filter:blur(12px)!important;-webkit-backdrop-filter:blur(12px)!important;
border-top:1px solid ${C.g200}!important;border-left:1px solid ${C.g200}!important;
border-right:1px solid ${C.g200}!important;border-radius:18px 18px 0 0!important;
padding:10px 16px 14px!important;display:flex!important;align-items:center!important;
gap:8px!important;transition:transform .32s cubic-bezier(.16,1,.3,1)!important;
max-width:calc(100vw - 120px)!important;box-shadow:0 -4px 24px rgba(0,0,0,.08)!important}
#synapse-dock.s-visible{transform:translateX(-50%) translateY(0)!important}
.dock-label{font-size:10px!important;font-weight:700!important;letter-spacing:.1em!important;
text-transform:uppercase!important;color:${C.green}!important;
white-space:nowrap!important;flex-shrink:0!important;line-height:1!important}
.dock-pills{display:flex!important;gap:5px!important;overflow-x:auto!important;
scrollbar-width:none!important;flex:1!important;padding:2px 0!important}
.dock-pills::-webkit-scrollbar{display:none!important}
.dock-pill{width:30px!important;height:30px!important;border-radius:50%!important;
background:${C.g100}!important;color:${C.g600}!important;font-size:11px!important;
font-weight:700!important;border:1.5px solid ${C.g200}!important;cursor:pointer!important;
display:flex!important;align-items:center!important;justify-content:center!important;
flex-shrink:0!important;transition:background .15s,border-color .15s,transform .15s!important;
font-family:inherit!important;line-height:1!important}
.dock-pill:hover{background:${C.greenLight}!important;border-color:${C.greenMid}!important;
color:${C.greenDeep}!important;transform:scale(1.1)!important}
.dock-pill.s-active{background:${C.green}!important;border-color:${C.green}!important;
color:white!important;transform:scale(1.12)!important}
.dock-pill.s-done{background:${C.greenLight}!important;
border-color:${C.greenMid}!important;color:${C.greenDeep}!important}
.dock-pill.s-loading{background:${C.greenLight}!important;
border-color:${C.greenMid}!important;color:${C.green}!important;
animation:synapse-dock-pulse 1s ease-in-out infinite!important}
@keyframes synapse-dock-pulse{0%,100%{opacity:1}50%{opacity:.5}}
.dock-arrow,.dock-close{width:30px!important;height:30px!important;
border-radius:50%!important;background:${C.g100}!important;
border:1.5px solid ${C.g200}!important;cursor:pointer!important;
display:flex!important;align-items:center!important;justify-content:center!important;
flex-shrink:0!important;color:${C.g600}!important;font-size:13px!important;
transition:background .15s!important;font-family:inherit!important;line-height:1!important}
.dock-arrow:hover{background:${C.greenLight}!important;
color:${C.greenDeep}!important;border-color:${C.greenMid}!important}
.dock-arrow:disabled{opacity:.35!important;cursor:not-allowed!important}
.dock-close:hover{background:#fee2e2!important;color:${C.red}!important;
border-color:#fca5a5!important}

/* FULL PAGE BAR */
#synapse-fullpage-bar{position:fixed!important;top:0!important;left:0!important;
right:0!important;height:42px!important;background:${C.green}!important;
color:white!important;display:flex!important;align-items:center!important;
justify-content:center!important;gap:16px!important;font-size:12.5px!important;
font-weight:600!important;z-index:${Z.panel}!important;
transform:translateY(-100%)!important;
transition:transform .28s cubic-bezier(.16,1,.3,1)!important;
letter-spacing:.01em!important}
#synapse-fullpage-bar.s-visible{transform:translateY(0)!important}
.sfb-dot{width:7px!important;height:7px!important;border-radius:50%!important;
background:${C.gold}!important;display:inline-block!important;
animation:synapse-pulse 2s ease-in-out infinite!important}
.sfb-revert{padding:5px 12px!important;border-radius:20px!important;
background:rgba(255,255,255,.2)!important;border:1px solid rgba(255,255,255,.4)!important;
color:white!important;font-size:11.5px!important;font-weight:600!important;
cursor:pointer!important;transition:background .15s!important;font-family:inherit!important}
.sfb-revert:hover{background:rgba(255,255,255,.3)!important}

/* FULL PAGE CONTENT */
.synapse-fp{font-family:'Segoe UI',system-ui,sans-serif!important;
max-width:760px!important;margin:0 auto!important;padding:32px!important;
line-height:1.8!important;color:${C.g900}!important}
.synapse-fp h1,.synapse-fp h2{font-size:1.2rem!important;font-weight:700!important;
color:${C.g900}!important;margin:2rem 0 .6rem!important;padding-bottom:6px!important;
border-bottom:2.5px solid ${C.green}!important}
.synapse-fp h2:first-child,.synapse-fp h1:first-child{margin-top:0!important}
.synapse-fp h3{font-size:1rem!important;font-weight:600!important;
color:#333!important;margin:1.4rem 0 .4rem!important}
.synapse-fp p{font-size:1rem!important;color:#333!important;margin-bottom:1rem!important}
.synapse-fp ul,.synapse-fp ol{padding-left:1.4rem!important;margin-bottom:1rem!important}
.synapse-fp li{margin-bottom:.5rem!important;font-size:1rem!important;color:#333!important}
.synapse-fp strong{color:${C.g900}!important;font-weight:700!important}
.synapse-fp mark{background:${C.greenLight}!important;color:${C.greenDeep}!important;
padding:1px 6px!important;border-radius:3px!important;font-weight:500!important}
.synapse-fp a{color:${C.green}!important}
.synapse-fp table{width:100%!important;border-collapse:collapse!important;margin-bottom:1.25rem!important}
.synapse-fp th{background:${C.greenLight}!important;color:${C.greenDeep}!important;
font-weight:700!important;padding:10px 14px!important;text-align:left!important;
border-bottom:2px solid ${C.green}!important}
.synapse-fp td{padding:10px 14px!important;border-bottom:1px solid #eee!important;color:#333!important}
.synapse-fp button,.synapse-fp input[type="submit"]{padding:10px 20px!important;
font-size:.95rem!important;font-weight:600!important;color:white!important;
background:${C.green}!important;border:none!important;border-radius:8px!important;
cursor:pointer!important;margin-bottom:8px!important;font-family:inherit!important}
.synapse-fp input[type="text"],.synapse-fp input[type="email"],
.synapse-fp textarea,.synapse-fp select{width:100%!important;
padding:10px 14px!important;font-size:1rem!important;
border:1.5px solid #ddd!important;border-radius:8px!important;
margin-bottom:12px!important;font-family:inherit!important;background:#fafafa!important}
.synapse-fp input:focus,.synapse-fp textarea:focus{
border-color:${C.green}!important;outline:none!important;background:white!important}
  `;
  document.head.appendChild(s);
}

// ================================================================
// TEXT EXTRACTION
// ================================================================
function extractFullPageText() {
  const main = document.querySelector(
    'main,article,[role="main"],.content,#content'
  ) || document.body;
  const clone = main.cloneNode(true);
  clone.querySelectorAll(
    'script,style,nav,footer,header,#synapse-fab,#synapse-panel,#synapse-dock'
  ).forEach(e => e.remove());
  return clone.innerText.trim().slice(0, 10000);
}

// ================================================================
// SECTION MODE — AI detects sections
// ================================================================
function activateSectionMode() {
  if (S.analysing) return;
  S.analysing = true;

  const pageText = extractFullPageText();
  const fab = document.getElementById('synapse-fab');
  fab?.classList.add('s-analysing', 's-active');

  const mainBtn = document.getElementById('sp-main-btn');
  if (mainBtn) { mainBtn.disabled = true; mainBtn.textContent = 'Reading page...'; }
  showPanelHint('Claude is identifying sections...');

  chrome.runtime.sendMessage(
    { type: 'ANALYSE_SECTIONS', pageText },
    (res) => {
      S.analysing = false;
      fab?.classList.remove('s-analysing');
      if (mainBtn) { mainBtn.disabled = false; mainBtn.textContent = 'Activate on this page'; }

      if (res?.error) {
        showPanelHint(res.error, true);
        fab?.classList.remove('s-active');
        return;
      }
      if (!res?.sections?.length) {
        showPanelHint('Could not identify sections on this page.', true);
        fab?.classList.remove('s-active');
        return;
      }

      renderAISections(res.sections);
    }
  );
}

// ── Dice similarity ───────────────────────────────────────────────
function diceSim(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bg = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const k = a.slice(i, i + 2);
    bg.set(k, (bg.get(k) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const k = b.slice(i, i + 2);
    const n = bg.get(k) || 0;
    if (n > 0) { bg.set(k, n - 1); hit++; }
  }
  return (2 * hit) / (a.length + b.length - 2);
}

// ── Render Claude's identified sections ──────────────────────────
function renderAISections(aiSections) {
  const allHeadings = Array.from(
    document.querySelectorAll('h1,h2,h3,h4')
  ).filter(h =>
    !h.closest('#synapse-panel') &&
    !h.closest('#synapse-dock') &&
    !h.id?.startsWith('synapse') &&
    h.offsetParent !== null
  );

  const allBlocks = Array.from(
    document.querySelectorAll('p,h2,h3,section,article>div')
  ).filter(el =>
    !el.id?.startsWith('synapse') && el.offsetParent !== null
  );

  S.sections = aiSections.map((aiSec, idx) => {
    // 1. Try heading match
    let anchor = allHeadings.find(h => {
      const ht = h.innerText.trim().toLowerCase();
      const st = aiSec.title.toLowerCase();
      return ht.includes(st) || st.includes(ht) || diceSim(ht, st) > 0.55;
    });

    // 2. Try paragraph snippet match
    if (!anchor) {
      const snippet = aiSec.content.slice(0, 50).toLowerCase();
      anchor = Array.from(document.querySelectorAll('p,div'))
        .find(el =>
          !el.id?.startsWith('synapse') &&
          el.offsetParent !== null &&
          el.innerText?.toLowerCase().includes(snippet.slice(0, 25))
        ) || null;
    }

    // 3. Distribute evenly
    if (!anchor) {
      const step = Math.floor(allBlocks.length / aiSections.length);
      anchor = allBlocks[idx * step] || document.body;
    }

    return {
      idx,
      heading: anchor,
      text: aiSec.content,
      title: aiSec.title,
      summary: aiSec.summary || '',
      cachedHTML: null,
      readProgress: 0,
    };
  });

  // Wrap and badge
  S.sections.forEach((sec, idx) => {
    let wrap;
    if (sec.heading.closest('.synapse-section-wrap')) {
      wrap = sec.heading.closest('.synapse-section-wrap');
    } else {
      wrap = document.createElement('div');
      wrap.className = 'synapse-section-wrap';
      wrap.dataset.synapseIdx = idx;
      wrap.style.cssText = 'position:relative;display:block;';
      sec.heading.parentNode.insertBefore(wrap, sec.heading);
      wrap.appendChild(sec.heading);
    }
    sec.wrap = wrap;

    // Badge
    const badge = document.createElement('div');
    badge.className = 'synapse-badge';
    badge.dataset.idx = idx;
    badge.innerHTML = `${idx + 1}
      <svg class="s-ring" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r="12"/>
      </svg>
      ${sec.summary
        ? `<div class="synapse-badge-tooltip">${sec.summary}</div>`
        : ''}`;
    badge.title = sec.title;
    wrap.appendChild(badge);
    sec.badge = badge;

    // Hover
    wrap.addEventListener('mouseenter', () => {
      if (S.activeCardIdx !== idx) wrap.classList.add('s-highlighted');
    });
    wrap.addEventListener('mouseleave', () => wrap.classList.remove('s-highlighted'));

    badge.addEventListener('click', (e) => { e.stopPropagation(); openCard(idx); });
  });

  buildDock();
  S.active = true;
  document.getElementById('synapse-fab')?.classList.add('s-active');
  showPanelHint(`${S.sections.length} sections identified by Claude.`);
  updatePanelState();
  setupScrollObserver();
}

// ================================================================
// FLOATING CARD
// ================================================================
function openCard(idx) {
  closeCard();
  const sec = S.sections[idx];
  if (!sec) return;

  S.activeCardIdx = idx;
  S.sections.forEach(s => s.wrap?.classList.remove('s-active'));
  sec.wrap?.classList.add('s-active');
  sec.badge?.classList.add('s-loading');
  updateDockActive(idx);

  const card = document.createElement('div');
  card.className = 'synapse-card';
  card.innerHTML = `
    <div class="sc-topbar">
      <div>
        <div class="sc-title">
          <span class="sc-title-dot"></span>Synapse 2.0
        </div>
        <span class="sc-section-name">${sec.title}</span>
      </div>
      <button class="sc-close">✕</button>
    </div>
    <div class="sc-loading">
      <div class="sc-spinner"></div>
      <span class="sc-loading-text">Rebuilding for your brain...</span>
    </div>
    <div class="sc-body"></div>`;

  sec.wrap.style.position = 'relative';
  sec.wrap.insertBefore(card, sec.wrap.firstChild);
  S.activeCard = card;

  requestAnimationFrame(() =>
    requestAnimationFrame(() => card.classList.add('s-visible'))
  );

  card.querySelector('.sc-close').addEventListener('click', closeCard);

  // Use cache
  if (sec.cachedHTML) {
    sec.badge?.classList.remove('s-loading');
    showCardContent(card, sec, sec.cachedHTML);
    return;
  }

  chrome.runtime.sendMessage(
    { type: 'CALL_LLM', pageText: sec.text },
    (res) => {
      sec.badge?.classList.remove('s-loading');
      if (res?.html) {
        sec.cachedHTML = res.html;
        sec.badge?.classList.add('s-done');
        showCardContent(card, sec, res.html);
        updateDockPill(idx, 's-done');
      } else {
        card.querySelector('.sc-loading').style.display = 'none';
        const body = card.querySelector('.sc-body');
        body.classList.add('s-ready');
        body.innerHTML = `<p style="color:${C.red};font-size:13px">
          ${res?.error || 'Something went wrong. Check your API key.'}</p>`;
        updateDockPill(idx, '');
      }
    }
  );

  setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
}

function showCardContent(card, sec, html) {
  card.querySelector('.sc-loading').style.display = 'none';
  const body = card.querySelector('.sc-body');
  body.classList.add('s-ready');
  body.innerHTML = html;

  body.addEventListener('scroll', () => {
    const p = body.scrollTop / (body.scrollHeight - body.clientHeight);
    sec.readProgress = Math.max(sec.readProgress, Math.min(1, p || 0));
    updateProgressRing(sec);
  });

  injectFeedbackStrip(card, sec);
}

function closeCard() {
  if (!S.activeCard) return;
  S.activeCard.classList.remove('s-visible');
  const card = S.activeCard;
  setTimeout(() => card.remove(), 280);
  S.activeCard = null;
  if (S.activeCardIdx !== null) {
    S.sections[S.activeCardIdx]?.wrap?.classList.remove('s-active');
    updateDockActive(null);
  }
  S.activeCardIdx = null;
}

function updateProgressRing(sec) {
  const circle = sec.badge?.querySelector('.s-ring circle');
  if (!circle) return;
  circle.style.strokeDashoffset = 75.4 - sec.readProgress * 75.4;
}

// ================================================================
// FEEDBACK STRIP
// ================================================================
function injectFeedbackStrip(card, sec) {
  card.querySelector('.sc-feedback')?.remove();
  const strip = document.createElement('div');
  strip.className = 'sc-feedback';
  strip.innerHTML = `
    <span class="sc-feedback-label">Did this help?</span>
    <div class="sc-feedback-reactions">
      <button class="sc-reaction" data-val="clearer">✓ Clearer</button>
      <button class="sc-reaction" data-val="complex">↑ Too complex</button>
      <button class="sc-reaction" data-val="simple">↓ Too simple</button>
    </div>
    <div class="sc-feedback-input-row">
      <input class="sc-feedback-input" type="text"
        placeholder="Anything specific? (optional)" maxlength="200"/>
      <button class="sc-feedback-send" title="Send">
        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
    <div class="sc-feedback-thanks">Got it — Synapse is learning your preferences.</div>`;
  card.appendChild(strip);

  let selected = null;
  const openTime = Date.now();

  strip.querySelectorAll('.sc-reaction').forEach(btn => {
    btn.addEventListener('click', () => {
      strip.querySelectorAll('.sc-reaction').forEach(b =>
        b.classList.remove('s-selected-good','s-selected-bad','s-selected-neutral')
      );
      selected = btn.dataset.val;
      if (selected === 'clearer') btn.classList.add('s-selected-good');
      else if (selected === 'complex') btn.classList.add('s-selected-bad');
      else btn.classList.add('s-selected-neutral');
      submitFeedback(sec, selected, '', openTime, strip);
    });
  });

  strip.querySelector('.sc-feedback-send').addEventListener('click', () => {
    const note = strip.querySelector('.sc-feedback-input').value.trim();
    if (note) submitFeedback(sec, selected, note, openTime, strip);
  });

  strip.querySelector('.sc-feedback-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const note = e.target.value.trim();
      if (note) submitFeedback(sec, selected, note, openTime, strip);
    }
  });
}

function submitFeedback(sec, reaction, note, openTime, strip) {
  const entry = {
    ts: Date.now(),
    sectionTitle: sec.title,
    reaction,
    note: note || '',
    timeSpentSeconds: Math.round((Date.now() - openTime) / 1000),
    readProgress: Math.round(sec.readProgress * 100),
  };

  chrome.storage.local.get('feedbackLog', (r) => {
    const log = (r.feedbackLog || []);
    log.push(entry);
    chrome.storage.local.set({ feedbackLog: log.slice(-50) });
  });

  chrome.runtime.sendMessage({ type: 'FEEDBACK', entry });

  // Show thanks in strip
  strip.querySelector('.sc-feedback-reactions').style.display = 'none';
  strip.querySelector('.sc-feedback-input-row').style.display = 'none';
  strip.querySelector('.sc-feedback-label').style.display = 'none';
  strip.querySelector('.sc-feedback-thanks').style.display = 'block';
}

// ================================================================
// DOCK
// ================================================================
function buildDock() {
  document.getElementById('synapse-dock')?.remove();
  const dock = document.createElement('div');
  dock.id = 'synapse-dock';
  dock.innerHTML = `
    <span class="dock-label">Sections</span>
    <button class="dock-arrow" id="dock-prev">&#8592;</button>
    <div class="dock-pills" id="dock-pills"></div>
    <button class="dock-arrow" id="dock-next">&#8594;</button>
    <button class="dock-close" id="dock-close-btn">&#10005;</button>`;
  document.body.appendChild(dock);

  const pillsEl = dock.querySelector('#dock-pills');
  S.sections.forEach((sec, idx) => {
    const pill = document.createElement('button');
    pill.className = 'dock-pill';
    pill.dataset.idx = idx;
    pill.textContent = idx + 1;
    pill.title = sec.title;
    pill.addEventListener('click', () => {
      sec.wrap?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      openCard(idx);
    });
    pillsEl.appendChild(pill);
    sec.pill = pill;
  });

  dock.querySelector('#dock-prev').addEventListener('click', () => {
    const prev = (S.activeCardIdx ?? 1) - 1;
    if (prev >= 0) {
      S.sections[prev]?.wrap?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      openCard(prev);
    }
  });

  dock.querySelector('#dock-next').addEventListener('click', () => {
    const next = (S.activeCardIdx ?? -1) + 1;
    if (next < S.sections.length) {
      S.sections[next]?.wrap?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      openCard(next);
    }
  });

  dock.querySelector('#dock-close-btn').addEventListener('click', deactivateSectionMode);

  requestAnimationFrame(() =>
    requestAnimationFrame(() => dock.classList.add('s-visible'))
  );
}

function updateDockActive(idx) {
  document.querySelectorAll('.dock-pill').forEach((p, i) =>
    p.classList.toggle('s-active', i === idx)
  );
}

function updateDockPill(idx, cls) {
  const pill = document.querySelector(`.dock-pill[data-idx="${idx}"]`);
  if (!pill) return;
  pill.classList.remove('s-loading','s-done','s-active');
  if (cls) pill.classList.add(cls);
}

// ================================================================
// SCROLL OBSERVER
// ================================================================
function setupScrollObserver() {
  S.observer?.disconnect();
  S.observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting && S.activeCardIdx === null) {
        const idx = parseInt(e.target.dataset.synapseIdx);
        if (!isNaN(idx)) { updateDockActive(idx); S.currentSection = idx; }
      }
    });
  }, { threshold: 0.3 });
  S.sections.forEach(sec => sec.wrap && S.observer.observe(sec.wrap));
}

// ================================================================
// DEACTIVATE SECTION MODE
// ================================================================
function deactivateSectionMode() {
  closeCard();
  S.sections.forEach(sec => {
    if (!sec.wrap?.parentNode) return;
    const parent = sec.wrap.parentNode;
    while (sec.wrap.firstChild) {
      const child = sec.wrap.firstChild;
      if (child.classList?.contains('synapse-badge') ||
          child.classList?.contains('synapse-card')) {
        child.remove();
      } else {
        parent.insertBefore(child, sec.wrap);
      }
    }
    sec.wrap.remove();
  });
  S.sections = [];
  S.active = false;
  S.activeCardIdx = null;

  const dock = document.getElementById('synapse-dock');
  if (dock) { dock.classList.remove('s-visible'); setTimeout(() => dock.remove(), 320); }
  S.observer?.disconnect();
  S.observer = null;
  document.getElementById('synapse-fab')?.classList.remove('s-active');
  updatePanelState();
}

// ================================================================
// FULL PAGE MODE
// ================================================================
function activateFullPage() {
  const main = document.querySelector(
    'main,article,[role="main"],.content,#content'
  ) || document.body;

  if (!S.originalHTML) S.originalHTML = main.innerHTML;

  const clone = main.cloneNode(true);
  clone.querySelectorAll('script,style,nav,footer,header').forEach(e => e.remove());
  const text = clone.innerText.slice(0, 8000);

  const btn = document.getElementById('sp-main-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Reformatting...'; }

  chrome.runtime.sendMessage({ type: 'CALL_LLM', pageText: text }, (res) => {
    if (btn) { btn.disabled = false; btn.textContent = 'Reformat full page'; }
    if (res?.html) {
      main.innerHTML = `<div class="synapse-fp">${res.html}</div>`;
      S.fullpageActive = true;
      showFullPageBar();
      document.getElementById('synapse-fab')?.classList.add('s-active');
      updatePanelState();
    } else {
      showPanelHint(res?.error || 'Something went wrong.', true);
    }
  });
}

function revertFullPage() {
  const main = document.querySelector(
    'main,article,[role="main"],.content,#content'
  ) || document.body;
  if (S.originalHTML) { main.innerHTML = S.originalHTML; S.originalHTML = null; }
  S.fullpageActive = false;
  hideFullPageBar();
  document.getElementById('synapse-fab')?.classList.remove('s-active');
  updatePanelState();
}

function showFullPageBar() {
  let bar = document.getElementById('synapse-fullpage-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'synapse-fullpage-bar';
    bar.innerHTML = `
      <span class="sfb-dot"></span>
      <span>Synapse 2.0 — Page reformatted for your brain</span>
      <button class="sfb-revert" id="sfb-revert-btn">Revert to original</button>`;
    document.body.appendChild(bar);
    bar.querySelector('#sfb-revert-btn').addEventListener('click', revertFullPage);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('s-visible')));
}

function hideFullPageBar() {
  const bar = document.getElementById('synapse-fullpage-bar');
  if (bar) { bar.classList.remove('s-visible'); setTimeout(() => bar.remove(), 300); }
}

// ================================================================
// FAB + PANEL
// ================================================================
function buildFloatingUI() {
  if (document.getElementById('synapse-fab')) return;
  injectStyles();

  const fab = document.createElement('button');
  fab.id = 'synapse-fab';
  fab.title = 'Synapse 2.0';
  fab.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14
        2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0
        1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/>
    </svg>
    <span class="s-dot"></span>`;

  const panel = document.createElement('div');
  panel.id = 'synapse-panel';
  panel.innerHTML = `
    <div class="sp-head">
      <div>
        <span class="sp-logo">Synapse 2.0</span>
        <span class="sp-sub">Cognitive layer</span>
      </div>
      <span class="sp-logo-dot"></span>
    </div>
    <div class="sp-mode-row">
      <span class="sp-mode-label">Mode</span>
      <div class="sp-mode-toggle">
        <button class="sp-mode-opt s-on" data-mode="cards">Section Cards</button>
        <button class="sp-mode-opt" data-mode="fullpage">Full Page</button>
      </div>
    </div>
    <div class="sp-actions">
      <span class="sp-hint" id="sp-hint">
        Claude reads the page and adds cards to each section.
      </span>
      <button class="sp-btn primary" id="sp-main-btn">Activate on this page</button>
      <button class="sp-btn ghost" id="sp-deactivate-btn" style="display:none">
        Deactivate
      </button>
    </div>`;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    S.panelOpen = !S.panelOpen;
    panel.classList.toggle('s-visible', S.panelOpen);
    fab.classList.toggle('open', S.panelOpen);
  });

  document.addEventListener('click', (e) => {
    if (!fab.contains(e.target) && !panel.contains(e.target)) {
      S.panelOpen = false;
      panel.classList.remove('s-visible');
      fab.classList.remove('open');
    }
  });

  panel.querySelectorAll('.sp-mode-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.sp-mode-opt').forEach(b => b.classList.remove('s-on'));
      btn.classList.add('s-on');
      S.mode = btn.dataset.mode;
      updatePanelState();
    });
  });

  document.getElementById('sp-main-btn').addEventListener('click', () => {
    S.panelOpen = false;
    panel.classList.remove('s-visible');
    fab.classList.remove('open');
    S.mode === 'cards' ? activateSectionMode() : activateFullPage();
  });

  document.getElementById('sp-deactivate-btn').addEventListener('click', () => {
    S.panelOpen = false;
    panel.classList.remove('s-visible');
    fab.classList.remove('open');
    S.mode === 'cards' ? deactivateSectionMode() : revertFullPage();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCard();
  });

  updatePanelState();
}

// ================================================================
// PANEL HELPERS
// ================================================================
function updatePanelState() {
  const hint    = document.getElementById('sp-hint');
  const mainBtn = document.getElementById('sp-main-btn');
  const deacBtn = document.getElementById('sp-deactivate-btn');
  if (!hint || !mainBtn || !deacBtn) return;

  hint.className = 'sp-hint';

  if (S.mode === 'cards') {
    if (S.active) {
      hint.textContent = `${S.sections.length} sections active. Click any badge to open a card.`;
      mainBtn.style.display = 'none';
      deacBtn.style.display = 'block';
      deacBtn.textContent = 'Remove section cards';
    } else {
      hint.textContent = 'Claude reads the page and adds cards to each section.';
      mainBtn.style.display = 'block';
      mainBtn.textContent = 'Activate on this page';
      deacBtn.style.display = 'none';
    }
  } else {
    if (S.fullpageActive) {
      hint.textContent = 'Full page restructured for your cognitive profile.';
      mainBtn.style.display = 'none';
      deacBtn.style.display = 'block';
      deacBtn.textContent = 'Revert to original';
    } else {
      hint.textContent = 'Rebuilds the entire page around your cognitive profile.';
      mainBtn.style.display = 'block';
      mainBtn.textContent = 'Reformat full page';
      deacBtn.style.display = 'none';
    }
  }
}

function showPanelHint(msg, isError = false) {
  const hint = document.getElementById('sp-hint');
  if (!hint) return;
  hint.textContent = msg;
  hint.className = isError ? 'sp-hint s-error' : 'sp-hint';
}

// ================================================================
// MESSAGE LISTENER
// ================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') sendResponse({ alive: true });
});

// ================================================================
// INIT
// ================================================================
buildFloatingUI();