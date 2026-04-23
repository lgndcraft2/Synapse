// ================================================================
// SYNAPSE 2.0 — COMPLETE CONTENT SCRIPT
// Three modes: Section Cards | Full Page | Explain This
// ================================================================

// ── State ────────────────────────────────────────────────────────
const S = {
  mode: 'cards',           // 'cards' | 'fullpage'
  active: false,           // synapse activated on this page
  sections: [],            // detected section objects
  currentSection: 0,       // active section index in dock
  originalHTML: null,      // saved for full-page revert
  fullpageActive: false,   // full page reformat applied
  panelOpen: false,        // FAB mini panel open
  activeCard: null,        // currently open floating card el
  activeCardIdx: null,     // index of open card
  observer: null,          // intersection observer
};

// ── Constants ────────────────────────────────────────────────────
const Z = {
  backdrop:  2147483640,
  dock:      2147483641,
  card:      2147483642,
  panel:     2147483643,
  fab:       2147483644,
};

const COLOR = {
  green:      '#1D9E75',
  greenDark:  '#0F6E56',
  greenLight: '#E1F5EE',
  greenMid:   '#9FE1CB',
  greenDeep:  '#085041',
  gold:       '#F5C842',
  white:      '#ffffff',
  gray50:     '#fafafa',
  gray100:    '#f4f4f4',
  gray200:    '#e8e8e8',
  gray400:    '#aaaaaa',
  gray600:    '#666666',
  gray900:    '#111111',
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

/* ── Reset for all synapse elements ── */
#synapse-fab, #synapse-panel, #synapse-dock,
.synapse-card, .synapse-badge, .synapse-section-wrap,
#synapse-fullpage-bar {
  all: initial;
  box-sizing: border-box;
  font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
}
*, *::before, *::after { box-sizing: inherit; }

/* ================================================================
   FAB
================================================================ */
#synapse-fab {
  position: fixed !important;
  bottom: 28px !important;
  right: 28px !important;
  width: 52px !important;
  height: 52px !important;
  border-radius: 50% !important;
  background: ${COLOR.green} !important;
  border: none !important;
  cursor: pointer !important;
  z-index: ${Z.fab} !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  transition: transform 0.22s cubic-bezier(0.16,1,0.3,1),
              background 0.18s !important;
  box-shadow: 0 4px 20px rgba(29,158,117,0.35) !important;
}
#synapse-fab:hover {
  background: ${COLOR.greenDark} !important;
  transform: scale(1.07) !important;
}
#synapse-fab.open {
  transform: rotate(45deg) scale(1.05) !important;
  background: ${COLOR.greenDark} !important;
}
#synapse-fab svg {
  width: 24px !important;
  height: 24px !important;
  fill: white !important;
  transition: transform 0.22s !important;
  display: block !important;
}
#synapse-fab .s-dot {
  position: absolute !important;
  top: 5px !important;
  right: 5px !important;
  width: 11px !important;
  height: 11px !important;
  border-radius: 50% !important;
  background: ${COLOR.gold} !important;
  border: 2px solid white !important;
  display: none !important;
}
#synapse-fab.s-active .s-dot { display: block !important; }

/* ================================================================
   MINI PANEL
================================================================ */
#synapse-panel {
  position: fixed !important;
  bottom: 92px !important;
  right: 28px !important;
  width: 272px !important;
  background: ${COLOR.white} !important;
  border: 1px solid ${COLOR.gray200} !important;
  border-radius: 18px !important;
  z-index: ${Z.panel} !important;
  overflow: hidden !important;
  transform: scale(0.88) translateY(16px) !important;
  opacity: 0 !important;
  pointer-events: none !important;
  transition: transform 0.24s cubic-bezier(0.16,1,0.3,1),
              opacity 0.18s ease !important;
  box-shadow: 0 8px 40px rgba(0,0,0,0.12) !important;
}
#synapse-panel.s-visible {
  transform: scale(1) translateY(0) !important;
  opacity: 1 !important;
  pointer-events: all !important;
}
.sp-head {
  padding: 16px 18px 12px !important;
  border-bottom: 1px solid ${COLOR.gray100} !important;
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
}
.sp-logo {
  font-size: 14px !important;
  font-weight: 700 !important;
  color: ${COLOR.green} !important;
  letter-spacing: -0.02em !important;
  display: block !important;
  line-height: 1 !important;
}
.sp-sub {
  font-size: 11px !important;
  color: ${COLOR.gray400} !important;
  display: block !important;
  margin-top: 2px !important;
  line-height: 1 !important;
}
.sp-logo-dot {
  width: 8px !important;
  height: 8px !important;
  border-radius: 50% !important;
  background: ${COLOR.green} !important;
  flex-shrink: 0 !important;
  display: block !important;
  margin-left: auto !important;
}

/* Mode toggle */
.sp-mode-row {
  padding: 12px 18px !important;
  border-bottom: 1px solid ${COLOR.gray100} !important;
}
.sp-mode-label {
  font-size: 10px !important;
  font-weight: 600 !important;
  letter-spacing: 0.08em !important;
  text-transform: uppercase !important;
  color: ${COLOR.gray400} !important;
  display: block !important;
  margin-bottom: 8px !important;
}
.sp-mode-toggle {
  display: flex !important;
  border: 1px solid ${COLOR.gray200} !important;
  border-radius: 10px !important;
  overflow: hidden !important;
}
.sp-mode-opt {
  flex: 1 !important;
  padding: 7px 6px !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  text-align: center !important;
  cursor: pointer !important;
  background: transparent !important;
  border: none !important;
  color: ${COLOR.gray600} !important;
  transition: background 0.15s, color 0.15s !important;
  line-height: 1.3 !important;
  font-family: inherit !important;
}
.sp-mode-opt.s-on {
  background: ${COLOR.green} !important;
  color: white !important;
}

/* Actions */
.sp-actions {
  padding: 12px 18px 16px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 7px !important;
}
.sp-hint {
  font-size: 11px !important;
  color: ${COLOR.gray400} !important;
  line-height: 1.5 !important;
  text-align: center !important;
  padding: 0 4px !important;
  display: block !important;
}
.sp-btn {
  width: 100% !important;
  padding: 10px 14px !important;
  border-radius: 10px !important;
  font-size: 12.5px !important;
  font-family: inherit !important;
  font-weight: 600 !important;
  cursor: pointer !important;
  border: none !important;
  transition: background 0.15s, transform 0.1s !important;
  text-align: center !important;
  display: block !important;
  line-height: 1 !important;
}
.sp-btn:active { transform: scale(0.97) !important; }
.sp-btn.primary {
  background: ${COLOR.green} !important;
  color: white !important;
}
.sp-btn.primary:hover { background: ${COLOR.greenDark} !important; }
.sp-btn.primary:disabled {
  background: ${COLOR.greenMid} !important;
  cursor: not-allowed !important;
}
.sp-btn.ghost {
  background: ${COLOR.gray100} !important;
  color: ${COLOR.gray600} !important;
}
.sp-btn.ghost:hover { background: ${COLOR.gray200} !important; }

/* ================================================================
   SECTION WRAPPERS & BADGES
================================================================ */
.synapse-section-wrap {
  position: relative !important;
  display: block !important;
  border-radius: 8px !important;
  transition: box-shadow 0.2s, outline 0.2s !important;
  outline: 2px solid transparent !important;
  outline-offset: 6px !important;
}
.synapse-section-wrap.s-highlighted {
  outline: 2px solid ${COLOR.greenMid} !important;
  box-shadow: 0 0 0 6px rgba(29,158,117,0.04) !important;
}
.synapse-section-wrap.s-active {
  outline: 2.5px solid ${COLOR.green} !important;
  box-shadow: 0 0 0 6px rgba(29,158,117,0.08) !important;
}

.synapse-badge {
  position: absolute !important;
  top: -10px !important;
  left: -10px !important;
  width: 24px !important;
  height: 24px !important;
  border-radius: 50% !important;
  background: ${COLOR.green} !important;
  color: white !important;
  font-size: 11px !important;
  font-weight: 700 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  cursor: pointer !important;
  z-index: 10 !important;
  border: 2px solid white !important;
  transition: transform 0.18s, background 0.15s !important;
  box-shadow: 0 2px 8px rgba(29,158,117,0.3) !important;
  line-height: 1 !important;
}
.synapse-badge:hover {
  transform: scale(1.18) !important;
  background: ${COLOR.greenDark} !important;
}
.synapse-badge.s-loading {
  background: ${COLOR.greenMid} !important;
}
.synapse-badge.s-done {
  background: ${COLOR.greenDark} !important;
}

/* Progress ring on badge */
.synapse-badge svg.s-ring {
  position: absolute !important;
  top: -3px !important;
  left: -3px !important;
  width: 30px !important;
  height: 30px !important;
  transform: rotate(-90deg) !important;
  display: block !important;
}
.s-ring circle {
  fill: none !important;
  stroke: ${COLOR.gold} !important;
  stroke-width: 2.5 !important;
  stroke-linecap: round !important;
  stroke-dasharray: 75.4 !important;
  stroke-dashoffset: 75.4 !important;
  transition: stroke-dashoffset 0.6s ease !important;
}

/* ================================================================
   FLOATING CARD
================================================================ */
.synapse-card {
  position: absolute !important;
  left: 50% !important;
  transform: translateX(-50%) translateY(-8px) !important;
  width: min(480px, 90vw) !important;
  background: ${COLOR.white} !important;
  border: 1px solid ${COLOR.gray200} !important;
  border-radius: 18px !important;
  z-index: ${Z.card} !important;
  box-shadow: 0 16px 60px rgba(0,0,0,0.14), 0 4px 16px rgba(0,0,0,0.07) !important;
  overflow: hidden !important;
  opacity: 0 !important;
  transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.16,1,0.3,1) !important;
  pointer-events: none !important;
}
.synapse-card.s-visible {
  opacity: 1 !important;
  transform: translateX(-50%) translateY(0) !important;
  pointer-events: all !important;
}

/* Arrow connector pointing down to section */
.synapse-card::after {
  content: '' !important;
  position: absolute !important;
  bottom: -8px !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  width: 16px !important;
  height: 8px !important;
  background: ${COLOR.white} !important;
  clip-path: polygon(0 0, 100% 0, 50% 100%) !important;
  filter: drop-shadow(0 2px 2px rgba(0,0,0,0.06)) !important;
  display: block !important;
}

.sc-topbar {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  padding: 13px 16px 11px !important;
  border-bottom: 1px solid ${COLOR.gray100} !important;
}
.sc-title {
  font-size: 12px !important;
  font-weight: 700 !important;
  color: ${COLOR.green} !important;
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  line-height: 1 !important;
}
.sc-title-dot {
  width: 6px !important;
  height: 6px !important;
  border-radius: 50% !important;
  background: ${COLOR.green} !important;
  display: inline-block !important;
  animation: synapse-pulse 2s ease-in-out infinite !important;
}
@keyframes synapse-pulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.5; transform: scale(0.7); }
}
.sc-section-name {
  font-size: 11px !important;
  color: ${COLOR.gray400} !important;
  max-width: 220px !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  display: block !important;
  line-height: 1 !important;
  margin-top: 2px !important;
}
.sc-close {
  width: 26px !important;
  height: 26px !important;
  border-radius: 50% !important;
  border: none !important;
  background: ${COLOR.gray100} !important;
  cursor: pointer !important;
  font-size: 14px !important;
  color: ${COLOR.gray600} !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  transition: background 0.15s !important;
  flex-shrink: 0 !important;
  font-family: inherit !important;
  line-height: 1 !important;
}
.sc-close:hover { background: ${COLOR.gray200} !important; }

.sc-loading {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-direction: column !important;
  gap: 12px !important;
  padding: 36px 24px !important;
}
.sc-spinner {
  width: 26px !important;
  height: 26px !important;
  border: 3px solid ${COLOR.greenLight} !important;
  border-top-color: ${COLOR.green} !important;
  border-radius: 50% !important;
  animation: synapse-spin 0.65s linear infinite !important;
  display: block !important;
}
@keyframes synapse-spin { to { transform: rotate(360deg); } }
.sc-loading-text {
  font-size: 12px !important;
  color: ${COLOR.gray400} !important;
  line-height: 1 !important;
}

.sc-body {
  padding: 16px 18px 18px !important;
  max-height: 360px !important;
  overflow-y: auto !important;
  display: none !important;
  scrollbar-width: thin !important;
  scrollbar-color: ${COLOR.greenMid} transparent !important;
}
.sc-body.s-ready { display: block !important; }
.sc-body h1, .sc-body h2 {
  font-size: 1rem !important;
  font-weight: 700 !important;
  color: ${COLOR.gray900} !important;
  margin: 0 0 10px !important;
  padding-bottom: 6px !important;
  border-bottom: 2px solid ${COLOR.green} !important;
  line-height: 1.3 !important;
}
.sc-body h3 {
  font-size: 0.9rem !important;
  font-weight: 600 !important;
  color: #333 !important;
  margin: 12px 0 5px !important;
  line-height: 1.3 !important;
}
.sc-body p {
  font-size: 0.88rem !important;
  color: #333 !important;
  margin-bottom: 9px !important;
  line-height: 1.7 !important;
}
.sc-body ul, .sc-body ol {
  padding-left: 1.2rem !important;
  margin-bottom: 9px !important;
}
.sc-body li {
  font-size: 0.88rem !important;
  color: #333 !important;
  margin-bottom: 5px !important;
  line-height: 1.6 !important;
}
.sc-body strong { color: ${COLOR.gray900} !important; font-weight: 600 !important; }
.sc-body mark {
  background: ${COLOR.greenLight} !important;
  color: ${COLOR.greenDeep} !important;
  padding: 1px 5px !important;
  border-radius: 3px !important;
  font-weight: 500 !important;
}
.sc-body a { color: ${COLOR.green} !important; }

/* ================================================================
   FEEDBACK STRIP
================================================================ */
.sc-feedback {
  border-top: 1px solid ${COLOR.gray100} !important;
  padding: 12px 18px 14px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 9px !important;
}
.sc-feedback-label {
  font-size: 10px !important;
  font-weight: 700 !important;
  letter-spacing: 0.08em !important;
  text-transform: uppercase !important;
  color: ${COLOR.gray400} !important;
  display: block !important;
  line-height: 1 !important;
}
.sc-feedback-reactions {
  display: flex !important;
  gap: 6px !important;
}
.sc-reaction {
  flex: 1 !important;
  padding: 7px 6px !important;
  border-radius: 8px !important;
  border: 1.5px solid ${COLOR.gray200} !important;
  background: ${COLOR.white} !important;
  font-size: 11px !important;
  font-weight: 600 !important;
  cursor: pointer !important;
  color: ${COLOR.gray600} !important;
  transition: all 0.15s !important;
  text-align: center !important;
  font-family: inherit !important;
  line-height: 1.3 !important;
}
.sc-reaction:hover {
  border-color: ${COLOR.greenMid} !important;
  background: ${COLOR.greenLight} !important;
  color: ${COLOR.greenDeep} !important;
}
.sc-reaction.s-selected-good {
  background: ${COLOR.green} !important;
  border-color: ${COLOR.green} !important;
  color: white !important;
}
.sc-reaction.s-selected-bad {
  background: #fff3f3 !important;
  border-color: #fca5a5 !important;
  color: ${COLOR.red} !important;
}
.sc-reaction.s-selected-neutral {
  background: #fffbeb !important;
  border-color: #fcd34d !important;
  color: #92400e !important;
}
.sc-feedback-input-row {
  display: flex !important;
  gap: 6px !important;
  align-items: center !important;
}
.sc-feedback-input {
  flex: 1 !important;
  padding: 7px 10px !important;
  border-radius: 8px !important;
  border: 1.5px solid ${COLOR.gray200} !important;
  background: ${COLOR.gray50} !important;
  font-size: 11.5px !important;
  font-family: inherit !important;
  color: ${COLOR.gray900} !important;
  outline: none !important;
  transition: border-color 0.15s !important;
  line-height: 1 !important;
}
.sc-feedback-input:focus {
  border-color: ${COLOR.green} !important;
  background: white !important;
}
.sc-feedback-input::placeholder {
  color: ${COLOR.gray400} !important;
}
.sc-feedback-send {
  width: 30px !important;
  height: 30px !important;
  border-radius: 50% !important;
  background: ${COLOR.green} !important;
  border: none !important;
  cursor: pointer !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  transition: background 0.15s, transform 0.1s !important;
  font-family: inherit !important;
}
.sc-feedback-send:hover { background: ${COLOR.greenDark} !important; }
.sc-feedback-send:active { transform: scale(0.93) !important; }
.sc-feedback-send svg {
  width: 13px !important;
  height: 13px !important;
  fill: white !important;
  display: block !important;
}
.sc-feedback-thanks {
  font-size: 11px !important;
  color: ${COLOR.green} !important;
  font-weight: 600 !important;
  text-align: center !important;
  padding: 4px 0 !important;
  display: none !important;
  line-height: 1 !important;
  animation: synapse-fadein 0.3s ease !important;
}
@keyframes synapse-fadein {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ================================================================
   BOTTOM DOCK
================================================================ */
#synapse-dock {
  position: fixed !important;
  bottom: 0 !important;
  left: 50% !important;
  transform: translateX(-50%) translateY(100%) !important;
  z-index: ${Z.dock} !important;
  background: rgba(255,255,255,0.95) !important;
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
  border-top: 1px solid ${COLOR.gray200} !important;
  border-left: 1px solid ${COLOR.gray200} !important;
  border-right: 1px solid ${COLOR.gray200} !important;
  border-radius: 18px 18px 0 0 !important;
  padding: 10px 16px 14px !important;
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  transition: transform 0.32s cubic-bezier(0.16,1,0.3,1) !important;
  max-width: calc(100vw - 120px) !important;
  box-shadow: 0 -4px 24px rgba(0,0,0,0.08) !important;
}
#synapse-dock.s-visible {
  transform: translateX(-50%) translateY(0) !important;
}
.dock-label {
  font-size: 10px !important;
  font-weight: 700 !important;
  letter-spacing: 0.1em !important;
  text-transform: uppercase !important;
  color: ${COLOR.green} !important;
  white-space: nowrap !important;
  flex-shrink: 0 !important;
  line-height: 1 !important;
}
.dock-pills {
  display: flex !important;
  gap: 5px !important;
  overflow-x: auto !important;
  scrollbar-width: none !important;
  flex: 1 !important;
  padding: 2px 0 !important;
}
.dock-pills::-webkit-scrollbar { display: none !important; }
.dock-pill {
  width: 30px !important;
  height: 30px !important;
  border-radius: 50% !important;
  background: ${COLOR.gray100} !important;
  color: ${COLOR.gray600} !important;
  font-size: 11px !important;
  font-weight: 700 !important;
  border: 1.5px solid ${COLOR.gray200} !important;
  cursor: pointer !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  transition: background 0.15s, border-color 0.15s, transform 0.15s !important;
  font-family: inherit !important;
  line-height: 1 !important;
}
.dock-pill:hover {
  background: ${COLOR.greenLight} !important;
  border-color: ${COLOR.greenMid} !important;
  color: ${COLOR.greenDeep} !important;
  transform: scale(1.1) !important;
}
.dock-pill.s-active {
  background: ${COLOR.green} !important;
  border-color: ${COLOR.green} !important;
  color: white !important;
  transform: scale(1.12) !important;
}
.dock-pill.s-done {
  background: ${COLOR.greenLight} !important;
  border-color: ${COLOR.greenMid} !important;
  color: ${COLOR.greenDeep} !important;
}
.dock-pill.s-loading {
  background: ${COLOR.greenLight} !important;
  border-color: ${COLOR.greenMid} !important;
  color: ${COLOR.green} !important;
  animation: synapse-dock-pulse 1s ease-in-out infinite !important;
}
@keyframes synapse-dock-pulse {
  0%,100% { opacity: 1; }
  50%      { opacity: 0.5; }
}
.dock-arrow {
  width: 30px !important;
  height: 30px !important;
  border-radius: 50% !important;
  background: ${COLOR.gray100} !important;
  border: 1.5px solid ${COLOR.gray200} !important;
  cursor: pointer !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  color: ${COLOR.gray600} !important;
  font-size: 13px !important;
  transition: background 0.15s !important;
  font-family: inherit !important;
  line-height: 1 !important;
}
.dock-arrow:hover {
  background: ${COLOR.greenLight} !important;
  color: ${COLOR.greenDeep} !important;
  border-color: ${COLOR.greenMid} !important;
}
.dock-arrow:disabled {
  opacity: 0.35 !important;
  cursor: not-allowed !important;
}
.dock-close {
  width: 30px !important;
  height: 30px !important;
  border-radius: 50% !important;
  background: ${COLOR.gray100} !important;
  border: 1.5px solid ${COLOR.gray200} !important;
  cursor: pointer !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  color: ${COLOR.gray600} !important;
  font-size: 13px !important;
  transition: background 0.15s !important;
  font-family: inherit !important;
  line-height: 1 !important;
}
.dock-close:hover {
  background: #fee2e2 !important;
  color: ${COLOR.red} !important;
  border-color: #fca5a5 !important;
}

/* ================================================================
   FULL PAGE REFORMAT BAR
================================================================ */
#synapse-fullpage-bar {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  height: 42px !important;
  background: ${COLOR.green} !important;
  color: white !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 16px !important;
  font-size: 12.5px !important;
  font-weight: 600 !important;
  z-index: ${Z.panel} !important;
  transform: translateY(-100%) !important;
  transition: transform 0.28s cubic-bezier(0.16,1,0.3,1) !important;
  letter-spacing: 0.01em !important;
}
#synapse-fullpage-bar.s-visible {
  transform: translateY(0) !important;
}
.sfb-dot {
  width: 7px !important;
  height: 7px !important;
  border-radius: 50% !important;
  background: ${COLOR.gold} !important;
  display: inline-block !important;
  animation: synapse-pulse 2s ease-in-out infinite !important;
}
.sfb-revert {
  padding: 5px 12px !important;
  border-radius: 20px !important;
  background: rgba(255,255,255,0.2) !important;
  border: 1px solid rgba(255,255,255,0.4) !important;
  color: white !important;
  font-size: 11.5px !important;
  font-weight: 600 !important;
  cursor: pointer !important;
  transition: background 0.15s !important;
  font-family: inherit !important;
  line-height: 1 !important;
}
.sfb-revert:hover { background: rgba(255,255,255,0.3) !important; }

/* ================================================================
   FULL PAGE CONTENT STYLES
================================================================ */
.synapse-fullpage-content {
  font-family: 'Segoe UI', system-ui, sans-serif !important;
  max-width: 760px !important;
  margin: 0 auto !important;
  padding: 32px 32px !important;
  line-height: 1.8 !important;
  color: ${COLOR.gray900} !important;
}
.synapse-fullpage-content h1,
.synapse-fullpage-content h2 {
  font-size: 1.2rem !important;
  font-weight: 700 !important;
  color: ${COLOR.gray900} !important;
  margin: 2rem 0 0.6rem !important;
  padding-bottom: 6px !important;
  border-bottom: 2.5px solid ${COLOR.green} !important;
}
.synapse-fullpage-content h2:first-child,
.synapse-fullpage-content h1:first-child { margin-top: 0 !important; }
.synapse-fullpage-content h3 {
  font-size: 1rem !important;
  font-weight: 600 !important;
  color: #333 !important;
  margin: 1.4rem 0 0.4rem !important;
}
.synapse-fullpage-content p {
  font-size: 1rem !important;
  color: #333 !important;
  margin-bottom: 1rem !important;
}
.synapse-fullpage-content ul,
.synapse-fullpage-content ol {
  padding-left: 1.4rem !important;
  margin-bottom: 1rem !important;
}
.synapse-fullpage-content li {
  margin-bottom: 0.5rem !important;
  font-size: 1rem !important;
  color: #333 !important;
}
.synapse-fullpage-content strong {
  color: ${COLOR.gray900} !important;
  font-weight: 700 !important;
}
.synapse-fullpage-content mark {
  background: ${COLOR.greenLight} !important;
  color: ${COLOR.greenDeep} !important;
  padding: 1px 6px !important;
  border-radius: 3px !important;
  font-weight: 500 !important;
}
.synapse-fullpage-content a { color: ${COLOR.green} !important; }
.synapse-fullpage-content table {
  width: 100% !important;
  border-collapse: collapse !important;
  margin-bottom: 1.25rem !important;
}
.synapse-fullpage-content th {
  background: ${COLOR.greenLight} !important;
  color: ${COLOR.greenDeep} !important;
  font-weight: 700 !important;
  padding: 10px 14px !important;
  text-align: left !important;
  border-bottom: 2px solid ${COLOR.green} !important;
}
.synapse-fullpage-content td {
  padding: 10px 14px !important;
  border-bottom: 1px solid #eee !important;
  color: #333 !important;
}
.synapse-fullpage-content button,
.synapse-fullpage-content input[type="submit"] {
  padding: 10px 20px !important;
  font-size: 0.95rem !important;
  font-weight: 600 !important;
  color: white !important;
  background: ${COLOR.green} !important;
  border: none !important;
  border-radius: 8px !important;
  cursor: pointer !important;
  margin-bottom: 8px !important;
  font-family: inherit !important;
}
.synapse-fullpage-content input[type="text"],
.synapse-fullpage-content input[type="email"],
.synapse-fullpage-content textarea,
.synapse-fullpage-content select {
  width: 100% !important;
  padding: 10px 14px !important;
  font-size: 1rem !important;
  border: 1.5px solid #ddd !important;
  border-radius: 8px !important;
  margin-bottom: 12px !important;
  font-family: inherit !important;
  background: #fafafa !important;
}
.synapse-fullpage-content input:focus,
.synapse-fullpage-content textarea:focus {
  border-color: ${COLOR.green} !important;
  outline: none !important;
  background: white !important;
}
  `;
  document.head.appendChild(s);
}

// ================================================================
// SECTION DETECTION
// ================================================================
function detectSections() {
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .filter(h =>
      !h.closest('#synapse-panel') &&
      !h.closest('#synapse-dock') &&
      !h.closest('.synapse-card') &&
      !h.id?.startsWith('synapse') &&
      h.offsetParent !== null &&
      h.innerText?.trim().length > 3
    )
    .slice(0, 18);

  return headings.map((heading, idx) => {
    let text = heading.innerText.trim() + '\n\n';
    let el = heading.nextElementSibling;
    let count = 0;
    while (el && count < 12) {
      const tag = el.tagName?.toLowerCase();
      if (['h1','h2','h3'].includes(tag)) break;
      if (!el.id?.startsWith('synapse') &&
          !el.classList?.contains('synapse-section-wrap') &&
          !el.classList?.contains('synapse-badge')) {
        text += (el.innerText || '') + '\n\n';
      }
      el = el.nextElementSibling;
      count++;
    }
    return {
      idx,
      heading,
      text: text.trim().slice(0, 4000),
      title: heading.innerText.trim().slice(0, 60),
      cachedHTML: null,
      readProgress: 0,
    };
  });
}

// ================================================================
// SECTION MODE — wrap sections and inject badges
// ================================================================
function activateSectionMode() {
  S.sections = detectSections();
  if (S.sections.length === 0) {
    showPanelHint('No sections detected on this page.');
    return;
  }

  S.sections.forEach((sec, idx) => {
    // Wrap heading + following siblings in a relative wrapper
    const wrap = document.createElement('div');
    wrap.className = 'synapse-section-wrap';
    wrap.dataset.synapseIdx = idx;
    wrap.style.cssText = 'position:relative;display:block;';

    sec.heading.parentNode.insertBefore(wrap, sec.heading);
    wrap.appendChild(sec.heading);

    // Move following siblings into wrap
    let el = wrap.nextElementSibling;
    let count = 0;
    while (el && count < 12) {
      const tag = el.tagName?.toLowerCase();
      if (['h1','h2','h3'].includes(tag)) break;
      const next = el.nextElementSibling;
      wrap.appendChild(el);
      el = next;
      count++;
    }

    // Badge
    const badge = document.createElement('div');
    badge.className = 'synapse-badge';
    badge.dataset.idx = idx;
    badge.innerHTML = `
      ${idx + 1}
      <svg class="s-ring" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r="12"/>
      </svg>
    `;
    badge.title = `Explain section ${idx + 1}: ${sec.title}`;
    wrap.appendChild(badge);

    // Hover highlight
    wrap.addEventListener('mouseenter', () => {
      if (S.activeCardIdx !== idx) wrap.classList.add('s-highlighted');
    });
    wrap.addEventListener('mouseleave', () => {
      wrap.classList.remove('s-highlighted');
    });

    // Badge click → open card
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      openCard(idx);
    });

    sec.wrap = wrap;
    sec.badge = badge;
  });

  buildDock();
  S.active = true;
  document.getElementById('synapse-fab')?.classList.add('s-active');
  updatePanelState();
  setupScrollObserver();
}

// ================================================================
// FLOATING CARD
// ================================================================
function openCard(idx) {
  closeCard(); // close any existing

  const sec = S.sections[idx];
  if (!sec) return;

  S.activeCardIdx = idx;

  // Mark section active
  S.sections.forEach(s => s.wrap?.classList.remove('s-active'));
  sec.wrap?.classList.add('s-active');
  sec.badge?.classList.add('s-loading');

  // Update dock
  updateDockActive(idx);

  // Build card element
  const card = document.createElement('div');
  card.className = 'synapse-card';
  card.innerHTML = `
    <div class="sc-topbar">
      <div>
        <div class="sc-title">
          <span class="sc-title-dot"></span>
          Synapse 2.0
        </div>
        <span class="sc-section-name">${sec.title}</span>
      </div>
      <button class="sc-close" title="Close">✕</button>
    </div>
    <div class="sc-loading">
      <div class="sc-spinner"></div>
      <span class="sc-loading-text">Rebuilding for your brain...</span>
    </div>
    <div class="sc-body"></div>
  `;

  // Position card above the section wrap
  sec.wrap.style.position = 'relative';
  sec.wrap.insertBefore(card, sec.wrap.firstChild);
  S.activeCard = card;

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => card.classList.add('s-visible'));
  });

  // Close button
  card.querySelector('.sc-close').addEventListener('click', closeCard);

  // If cached, use it
  if (sec.cachedHTML) {
    showCardContent(card, sec, sec.cachedHTML);
    return;
  }

  // Call Claude
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
        const body = card.querySelector('.sc-body');
        card.querySelector('.sc-loading').style.display = 'none';
        body.classList.add('s-ready');
        body.innerHTML = `<p style="color:${COLOR.red};font-size:13px">
          ${res?.error || 'Something went wrong. Check your API key.'}</p>`;
        updateDockPill(idx, '');
      }
    }
  );

  // Scroll card into view
  setTimeout(() => {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

function showCardContent(card, sec, html) {
  const loading = card.querySelector('.sc-loading');
  const body = card.querySelector('.sc-body');
  loading.style.display = 'none';
  body.classList.add('s-ready');
  body.innerHTML = html;

  // Track reading progress
  body.addEventListener('scroll', () => {
    const progress = body.scrollTop / (body.scrollHeight - body.clientHeight);
    sec.readProgress = Math.max(sec.readProgress, Math.min(1, progress || 0));
    updateProgressRing(sec);
  });

  // Inject feedback strip after content
  injectFeedbackStrip(card, sec);
}

// ── Feedback strip ────────────────────────────────────────────────
function injectFeedbackStrip(card, sec) {
  // Remove any existing strip
  card.querySelector('.sc-feedback')?.remove();

  const strip = document.createElement('div');
  strip.className = 'sc-feedback';
  strip.innerHTML = `
    <span class="sc-feedback-label">Did this help?</span>
    <div class="sc-feedback-reactions">
      <button class="sc-reaction" data-val="clearer" title="This was clearer">
        ✓ Clearer
      </button>
      <button class="sc-reaction" data-val="complex" title="Still too complex">
        ↑ Too complex
      </button>
      <button class="sc-reaction" data-val="simple" title="Too simplified">
        ↓ Too simple
      </button>
    </div>
    <div class="sc-feedback-input-row">
      <input
        class="sc-feedback-input"
        type="text"
        placeholder="Anything specific? (optional)"
        maxlength="200"
      />
      <button class="sc-feedback-send" title="Send feedback">
        <svg viewBox="0 0 24 24">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>
      </button>
    </div>
    <div class="sc-feedback-thanks">
      Got it — Synapse is learning your preferences.
    </div>
  `;

  card.appendChild(strip);

  let selectedReaction = null;
  const cardOpenTime = Date.now();

  // Reaction buttons
  strip.querySelectorAll('.sc-reaction').forEach(btn => {
    btn.addEventListener('click', () => {
      strip.querySelectorAll('.sc-reaction').forEach(b => {
        b.classList.remove('s-selected-good','s-selected-bad','s-selected-neutral');
      });
      selectedReaction = btn.dataset.val;
      if (selectedReaction === 'clearer') btn.classList.add('s-selected-good');
      else if (selectedReaction === 'complex') btn.classList.add('s-selected-bad');
      else btn.classList.add('s-selected-neutral');

      // Auto-submit reaction immediately (no note needed)
      submitFeedback(sec, selectedReaction, '', cardOpenTime);
    });
  });

  // Send button (for note)
  strip.querySelector('.sc-feedback-send').addEventListener('click', () => {
    const note = strip.querySelector('.sc-feedback-input').value.trim();
    if (!note && !selectedReaction) return;
    submitFeedback(sec, selectedReaction, note, cardOpenTime);
  });

  // Enter key in input
  strip.querySelector('.sc-feedback-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const note = e.target.value.trim();
      submitFeedback(sec, selectedReaction, note, cardOpenTime);
    }
  });
}

// ── Submit and store feedback ─────────────────────────────────────
function submitFeedback(sec, reaction, note, openTime) {
  const timeSpent = Math.round((Date.now() - openTime) / 1000);

  const entry = {
    ts: Date.now(),
    sectionTitle: sec.title,
    reaction,          // 'clearer' | 'complex' | 'simple' | null
    note: note || '',
    timeSpentSeconds: timeSpent,
    readProgress: Math.round(sec.readProgress * 100),
  };

  // Save to storage
  chrome.storage.local.get('feedbackLog', (result) => {
    const log = result.feedbackLog || [];
    log.push(entry);
    // Keep last 50 entries only
    const trimmed = log.slice(-50);
    chrome.storage.local.set({ feedbackLog: trimmed });
  });

  // Also send to background so it can update the profile summary
  chrome.runtime.sendMessage({ type: 'FEEDBACK', entry });

  // Show thanks
  showFeedbackThanks(sec);
}

// ── Show confirmation in card ─────────────────────────────────────
function showFeedbackThanks(sec) {
  // Find the card that's currently open for this section
  const card = sec.wrap?.querySelector('.synapse-card');
  if (!card) return;
  const strip = card.querySelector('.sc-feedback');
  if (!strip) return;

  strip.querySelector('.sc-feedback-reactions').style.display = 'none';
  strip.querySelector('.sc-feedback-input-row').style.display = 'none';
  strip.querySelector('.sc-feedback-label').style.display = 'none';
  const thanks = strip.querySelector('.sc-feedback-thanks');
  thanks.style.display = 'block';
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
  const circumference = 75.4;
  const offset = circumference - sec.readProgress * circumference;
  circle.style.strokeDashoffset = offset;
}

// ================================================================
// DOCK
// ================================================================
function buildDock() {
  let dock = document.getElementById('synapse-dock');
  if (dock) dock.remove();

  dock = document.createElement('div');
  dock.id = 'synapse-dock';
  dock.innerHTML = `
    <span class="dock-label">Sections</span>
    <button class="dock-arrow" id="dock-prev" title="Previous">&#8592;</button>
    <div class="dock-pills" id="dock-pills"></div>
    <button class="dock-arrow" id="dock-next" title="Next">&#8594;</button>
    <button class="dock-close" id="dock-close-btn" title="Close Synapse">&#10005;</button>
  `;
  document.body.appendChild(dock);

  const pillsEl = dock.querySelector('#dock-pills');
  S.sections.forEach((sec, idx) => {
    const pill = document.createElement('button');
    pill.className = 'dock-pill';
    pill.dataset.idx = idx;
    pill.textContent = idx + 1;
    pill.title = sec.title;
    pill.addEventListener('click', () => {
      openCard(idx);
      sec.wrap?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  requestAnimationFrame(() => {
    requestAnimationFrame(() => dock.classList.add('s-visible'));
  });
}

function updateDockActive(idx) {
  document.querySelectorAll('.dock-pill').forEach((p, i) => {
    p.classList.toggle('s-active', i === idx);
  });
}

function updateDockPill(idx, className) {
  const pill = document.querySelector(`.dock-pill[data-idx="${idx}"]`);
  if (!pill) return;
  pill.classList.remove('s-loading', 's-done', 's-active');
  if (className) pill.classList.add(className);
}

// ================================================================
// SCROLL OBSERVER — auto-update dock active pill
// ================================================================
function setupScrollObserver() {
  if (S.observer) S.observer.disconnect();
  S.observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx = parseInt(entry.target.dataset.synapseIdx);
        if (!isNaN(idx) && S.activeCardIdx === null) {
          updateDockActive(idx);
          S.currentSection = idx;
        }
      }
    });
  }, { threshold: 0.3 });

  S.sections.forEach(sec => {
    if (sec.wrap) S.observer.observe(sec.wrap);
  });
}

// ================================================================
// DEACTIVATE SECTION MODE
// ================================================================
function deactivateSectionMode() {
  closeCard();

  // Remove wraps — unwrap sections back to original DOM
  S.sections.forEach(sec => {
    if (sec.wrap && sec.wrap.parentNode) {
      const parent = sec.wrap.parentNode;
      while (sec.wrap.firstChild) {
        if (sec.wrap.firstChild.classList?.contains('synapse-badge') ||
            sec.wrap.firstChild.classList?.contains('synapse-card')) {
          sec.wrap.firstChild.remove();
        } else {
          parent.insertBefore(sec.wrap.firstChild, sec.wrap);
        }
      }
      sec.wrap.remove();
    }
  });

  S.sections = [];
  S.active = false;
  S.activeCardIdx = null;

  const dock = document.getElementById('synapse-dock');
  if (dock) {
    dock.classList.remove('s-visible');
    setTimeout(() => dock.remove(), 320);
  }

  if (S.observer) { S.observer.disconnect(); S.observer = null; }
  document.getElementById('synapse-fab')?.classList.remove('s-active');
  updatePanelState();
}

// ================================================================
// FULL PAGE MODE
// ================================================================
function activateFullPage() {
  const main = document.querySelector(
    'main, article, [role="main"], .content, #content'
  ) || document.body;

  if (!S.originalHTML) {
    S.originalHTML = main.innerHTML;
  }

  // Extract text
  const clone = main.cloneNode(true);
  clone.querySelectorAll('script,style,nav,footer,header').forEach(e => e.remove());
  const text = clone.innerText.slice(0, 8000);

  updatePanelBtn('fp-btn', true, 'Reformatting...');

  chrome.runtime.sendMessage({ type: 'CALL_LLM', pageText: text }, (res) => {
    updatePanelBtn('fp-btn', false, 'Reformat full page');
    if (res?.html) {
      main.innerHTML = `<div class="synapse-fullpage-content">${res.html}</div>`;
      S.fullpageActive = true;
      showFullPageBar();
      document.getElementById('synapse-fab')?.classList.add('s-active');
      updatePanelState();
    } else {
      showPanelHint(res?.error || 'Something went wrong.');
    }
  });
}

function revertFullPage() {
  const main = document.querySelector(
    'main, article, [role="main"], .content, #content'
  ) || document.body;
  if (S.originalHTML) {
    main.innerHTML = S.originalHTML;
    S.originalHTML = null;
  }
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
      <button class="sfb-revert" id="sfb-revert-btn">Revert to original</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#sfb-revert-btn').addEventListener('click', revertFullPage);
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => bar.classList.add('s-visible'));
  });
}

function hideFullPageBar() {
  const bar = document.getElementById('synapse-fullpage-bar');
  if (bar) {
    bar.classList.remove('s-visible');
    setTimeout(() => bar.remove(), 300);
  }
}

// ================================================================
// FAB + PANEL
// ================================================================
function buildFloatingUI() {
  if (document.getElementById('synapse-fab')) return;
  injectStyles();

  // FAB
  const fab = document.createElement('button');
  fab.id = 'synapse-fab';
  fab.title = 'Synapse 2.0';
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14
        2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0
        1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/>
    </svg>
    <span class="s-dot"></span>
  `;

  // Panel
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
        <button class="sp-mode-opt s-on" data-mode="cards">
          Section Cards
        </button>
        <button class="sp-mode-opt" data-mode="fullpage">
          Full Page
        </button>
      </div>
    </div>
    <div class="sp-actions">
      <span class="sp-hint" id="sp-hint">
        Adds floating cards to each section rebuilt for your brain.
      </span>
      <button class="sp-btn primary" id="fp-btn" data-action="activate">
        Activate on this page
      </button>
      <button class="sp-btn ghost" id="sp-revert-btn" style="display:none">
        Deactivate
      </button>
    </div>
  `;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  // FAB click
  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    S.panelOpen = !S.panelOpen;
    panel.classList.toggle('s-visible', S.panelOpen);
    fab.classList.toggle('open', S.panelOpen);
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!fab.contains(e.target) && !panel.contains(e.target)) {
      S.panelOpen = false;
      panel.classList.remove('s-visible');
      fab.classList.remove('open');
    }
  });

  // Mode toggle
  panel.querySelectorAll('.sp-mode-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.sp-mode-opt').forEach(b => b.classList.remove('s-on'));
      btn.classList.add('s-on');
      S.mode = btn.dataset.mode;
      updatePanelState();
    });
  });

  // Main action button
  panel.querySelector('#fp-btn').addEventListener('click', () => {
    S.panelOpen = false;
    panel.classList.remove('s-visible');
    fab.classList.remove('open');

    if (S.mode === 'cards') {
      if (S.active) {
        deactivateSectionMode();
      } else {
        activateSectionMode();
      }
    } else {
      if (S.fullpageActive) {
        revertFullPage();
      } else {
        activateFullPage();
      }
    }
  });

  // Revert button
  panel.querySelector('#sp-revert-btn').addEventListener('click', () => {
    S.panelOpen = false;
    panel.classList.remove('s-visible');
    fab.classList.remove('open');
    if (S.mode === 'cards') {
      deactivateSectionMode();
    } else {
      revertFullPage();
    }
  });

  updatePanelState();
}

// ================================================================
// PANEL STATE HELPERS
// ================================================================
function updatePanelState() {
  const hint = document.getElementById('sp-hint');
  const mainBtn = document.getElementById('fp-btn');
  const revertBtn = document.getElementById('sp-revert-btn');
  if (!hint || !mainBtn || !revertBtn) return;

  if (S.mode === 'cards') {
    if (S.active) {
      hint.textContent = 'Section cards are active. Click sections to explain them.';
      mainBtn.textContent = 'Deactivate';
      mainBtn.style.display = 'none';
      revertBtn.style.display = 'block';
      revertBtn.textContent = 'Remove section cards';
    } else {
      hint.textContent = 'Adds numbered cards to each section, rebuilt for your brain.';
      mainBtn.textContent = 'Activate on this page';
      mainBtn.style.display = 'block';
      revertBtn.style.display = 'none';
    }
  } else {
    if (S.fullpageActive) {
      hint.textContent = 'Full page has been restructured for your cognitive profile.';
      mainBtn.style.display = 'none';
      revertBtn.style.display = 'block';
      revertBtn.textContent = 'Revert to original';
    } else {
      hint.textContent = 'Rebuilds the entire page around your cognitive profile.';
      mainBtn.textContent = 'Reformat full page';
      mainBtn.style.display = 'block';
      revertBtn.style.display = 'none';
    }
  }
}

function updatePanelBtn(id, disabled, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = disabled;
  btn.textContent = text;
}

function showPanelHint(msg) {
  const hint = document.getElementById('sp-hint');
  if (hint) hint.textContent = msg;
}

// ================================================================
// MESSAGE LISTENER (from popup)
// ================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ alive: true });
  }
});

// ================================================================
// INIT
// ================================================================
buildFloatingUI();