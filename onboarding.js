// ── State ──────────────────────────────────────────────────────────
const state = {
  currentStep: 0,
  preferredFormat: 'bullet points',
  chunkSize: 'short',
  needsExamplesFirst: true,
  simplifyVocab: false,
  maxNestingDepth: 2,
  useHeaders: true,
  notes: '',
};

// ── Step navigation ────────────────────────────────────────────────
function showStep(n) {
  document.querySelectorAll('.step').forEach(s => delete s.dataset.active);
  const target = n === 'done'
    ? document.getElementById('step-done')
    : document.getElementById(`step-${n}`);
  if (target) target.dataset.active = 'true';
  state.currentStep = n;
  updateSidebarIndicators(n);
}

function updateSidebarIndicators(n) {
  // Steps 1, 2, 3 map to sidebar indicators data-step="1/2/3"
  document.querySelectorAll('.step-indicator').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.remove('active', 'done');
    if (s < n)       el.classList.add('done');
    else if (s === n) el.classList.add('active');
  });
}


// ── Generic segmented / card option pickers ─────────────────────────
function bindOptions(containerId, stateKey, isNumber = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('[data-val]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-val]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      let val = btn.dataset.val;
      if (val === 'true')  val = true;
      else if (val === 'false') val = false;
      else if (isNumber)   val = parseInt(val);
      state[stateKey] = val;
    });
  });
}

bindOptions('format-opts',   'preferredFormat');
bindOptions('chunk-opts',    'chunkSize');
bindOptions('examples-opts', 'needsExamplesFirst');
bindOptions('vocab-opts',    'simplifyVocab');
bindOptions('nesting-opts',  'maxNestingDepth', true);
bindOptions('headers-opts',  'useHeaders');

// ── Step 0: Welcome ────────────────────────────────────────────────
document.getElementById('welcome-next').addEventListener('click', () => showStep(1));

// ── Step 1: Reading style → Step 3: Fine-tune ─────────────────────

// ── Step 2: Reading style ──────────────────────────────────────────
document.getElementById('step2-next').addEventListener('click', () => showStep(3));
document.getElementById('step2-back').addEventListener('click', () => showStep(1));

// ── Step 3: Fine-tune + Save ───────────────────────────────────────
document.getElementById('step3-finish').addEventListener('click', () => {
  state.notes = document.getElementById('notes').value.trim();

  const profile = {
    preferredFormat:    state.preferredFormat,
    chunkSize:          state.chunkSize,
    needsExamplesFirst: state.needsExamplesFirst,
    simplifyVocab:      state.simplifyVocab,
    maxNestingDepth:    state.maxNestingDepth,
    useHeaders:         state.useHeaders,
    notes:              state.notes,
  };

  chrome.storage.local.set(
    { cognitiveProfile: profile, onboardingComplete: true },
    () => showStep('done')
  );
});

document.getElementById('step3-back').addEventListener('click', () => showStep(1));

// ── Done ───────────────────────────────────────────────────────────
document.getElementById('done-close').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://en.wikipedia.org/wiki/Special:Random' });
  window.close();
});

// ── Init ───────────────────────────────────────────────────────────
showStep(0);
