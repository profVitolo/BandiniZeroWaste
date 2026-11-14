import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

// 1. Disabilita i modelli locali e abilita quelli remoti via Hugging Face CDN
env.allowLocalModels = false;
env.allowRemoteModels = true;

const video = document.getElementById('webcam');
const btnClassify = document.getElementById('btn-classify');
const statusDiv = document.getElementById('status');
const resultDiv = document.getElementById('result');

// Variabile globale per gestire il timer di chiusura automatica dei bidoni
let closeTimer = null;

// 2. Stato centralizzato dell'applicazione
const STATE = {
  config: null,           // Caricato dall'API
  prompts: [],            // Array di oggetti prompt dinamici
  candidatePrompts: [],   // Array di stringhe dei prompt
  classifier: null,       // Modello CLIP
  currentStream: null,    // Stream webcam attivo
  currentFacingMode: 'user', // 'user' o 'environment'
  currentDeviceId: null,  // ID del dispositivo video corrente
  videoDevices: [],       // Array di dispositivi videoinput
  confidenceThreshold: 0.40, // Derivato da config.meta, default provvisorio
  classificationState: 'waiting' // 'waiting' | 'classifying' | 'recognized' | 'nc' | 'error'
};

// Helper: genera entry_id univoco da categoria e indice
function generateEntryId(category, index) {
  const slug = category.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  return `${slug}-${index}`;
}

// Helper: mappa categoria → bin_id da config
function categoryToBinId(category) {
  if (!STATE.config?.categories?.[category]) return null;
  return STATE.config.categories[category].bin_id || null;
}

// Helper: aggiorna visibilità del bottone help in base allo stato
function updateHelpButtonVisibility() {
  const btnHelp = document.getElementById('btn-help');
  if (!btnHelp) return;
  // Il bottone è visibile solo quando lo stato è 'nc' (non classificato)
  if (STATE.classificationState === 'nc') {
    btnHelp.classList.remove('hidden');
  } else {
    btnHelp.classList.add('hidden');
  }
}

// Helper: apre la modale di aiuto umano
function openHelpModal() {
  const modal = document.getElementById('modal-help');
  const feedback = document.getElementById('modal-feedback');
  const form = document.getElementById('help-form');
  if (modal) {
    modal.classList.remove('hidden');
  }
  // Reset feedback e form
  if (feedback) feedback.innerHTML = '';
  if (form) form.reset();
}

// Helper: chiude la modale di aiuto umano
function closeHelpModal() {
  const modal = document.getElementById('modal-help');
  if (modal) {
    modal.classList.add('hidden');
  }
  // Riattiva il pulsante di classificazione (sicurezza)
  btnClassify.disabled = false;
  btnClassify.textContent = "Classifica Rifiuto";
  // Resetta lo stato a 'waiting' se era 'nc' (chiusura senza inserimento)
  if (STATE.classificationState === 'nc') {
    STATE.classificationState = 'waiting';
    resultDiv.classList.remove('nc');
    resultDiv.innerText = 'In attesa di scansione...';
    updateHelpButtonVisibility();
  }
}

// Helper: popola il select delle categorie da STATE.config.categories
function populateCategorySelect() {
  const categorySelect = document.getElementById('help-category');
  if (!categorySelect || !STATE.config?.categories) return;

  // Rimuovi le opzioni esistenti (tranne la prima vuota)
  categorySelect.innerHTML = '<option value="">Seleziona...</option>';

  // Popola con le categorie dalla config
  for (const category of Object.keys(STATE.config.categories)) {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    categorySelect.appendChild(option);
  }
}

// Helper: mostra errore inline su un campo del form
function showFieldError(fieldId, message) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  // Usa il title per l'errore inline
  field.setCustomValidity(message);
  field.reportValidity();
}

// Helper: rileva se il dispositivo è mobile
function isMobile() {
  if (navigator.userAgentData?.mobile === true) {
    return true;
  }
  // Fallback regex su userAgent
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
  return mobileRegex.test(navigator.userAgent || '');
}

// Helper: enumera i dispositivi videoinput
async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    STATE.videoDevices = devices.filter(d => d.kind === 'videoinput');
    console.log(`Dispositivi video trovati: ${STATE.videoDevices.length}`);
  } catch (err) {
    console.error('Errore enumerazione dispositivi:', err.message);
  }
}

// Helper: genera vincoli video in base al dispositivo
function getVideoConstraints() {
  const isMobileDevice = isMobile();
  if (isMobileDevice) {
    return {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };
  } else {
    return {
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };
  }
}

// Helper: rimuovi errore inline da un campo
function clearFieldError(fieldId) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  field.setCustomValidity('');
}

// Helper: gestisce l'invio del form di aiuto umano
async function handleFormSubmit(e) {
  e.preventDefault();

  const descriptionInput = document.getElementById('help-description');
  const categorySelect = document.getElementById('help-category');
  const feedback = document.getElementById('modal-feedback');

  if (!descriptionInput || !categorySelect || !feedback) return;

  const description = descriptionInput.value.trim();
  const category = categorySelect.value;

  // Validazione: campi non vuoti (CA5)
  let hasError = false;

  if (!description) {
    showFieldError('help-description', 'Inserisci una descrizione in inglese');
    hasError = true;
  } else {
    clearFieldError('help-description');
  }

  if (!category) {
    showFieldError('help-category', 'Seleziona una categoria');
    hasError = true;
  } else {
    clearFieldError('help-category');
  }

  if (hasError) return;

  // Disabilita il bottone di submit durante l'invio
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Invio in corso...';
  }

  try {
    // POST alla API add_entry
    const response = await fetch('api.php?action=add_entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, description })
    });

    const data = await response.json();

    if (response.status === 409) {
      // Duplicato (CA4)
      const errorMsg = data.message || 'Descrizione già presente';
      feedback.innerHTML = `<p class="feedback-error">⚠️ ${errorMsg}</p>`;
      // Mantieni la modale aperta
    } else if (response.ok && data.ok) {
      // Successo (CA3, CA7)
      feedback.innerHTML = `<p class="feedback-success">✅ Entry aggiunta con successo!</p>`;
      // Ricarica i prompt
      await reloadPrompts();
      // Chiudi la modale
      closeHelpModal();
      // Nascondi il bottone help (torna in stato waiting)
      STATE.classificationState = 'waiting';
      updateHelpButtonVisibility();
    } else {
      // Errore generico
      const errorMsg = data.message || 'Errore durante l\'aggiunta della entry';
      feedback.innerHTML = `<p class="feedback-error">❌ ${errorMsg}</p>`;
      // Mantieni la modale aperta
    }
  } catch (err) {
    // Errore di rete
    feedback.innerHTML = `<p class="feedback-error">❌ Errore di connessione: ${err.message}</p>`;
    // Mantieni la modale aperta
  } finally {
    // Riabilita il bottone
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Invia';
    }
  }
}

// 3. Avvio Webcam
async function startCamera(constraints) {
  try {
    // Ferma lo stream esistente se presente
    if (STATE.currentStream) {
      STATE.currentStream.getTracks().forEach(track => track.stop());
    }

    const stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
    video.srcObject = stream;
    STATE.currentStream = stream;

    // Estrai device info dallo stream
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      const settings = videoTrack.getSettings();
      // getSettings().deviceId può essere vuoto su alcuni browser mobile
      STATE.currentDeviceId = settings.deviceId || videoTrack.id;
      STATE.currentFacingMode = settings.facingMode || 'user';
      console.log(`Camera avviata: device=${STATE.currentDeviceId}, facing=${STATE.currentFacingMode}`);
    }

    // Aggiorna indicatore fotocamera
    updateCameraIndicator();
  } catch (err) {
    statusDiv.innerText = "Errore nell'accesso alla webcam: " + err.message;
  }
}

// Helper: avvia la webcam con i vincoli appropriati
async function setupWebcam() {
  const constraints = getVideoConstraints();
  await startCamera(constraints);

  // Enumera i dispositivi dopo il primo getUserMedia per avere le etichette
  await enumerateDevices();

  // Aggiorna visibilità pulsante switch camera
  updateSwitchCameraButton();
}

// Helper: aggiorna visibilità pulsante switch camera
function updateSwitchCameraButton() {
  const btnSwitch = document.getElementById('btn-switch-camera');
  if (!btnSwitch) return;

  const mobile = isMobile();
  if (mobile) {
    // Su mobile: sempre visibile
    btnSwitch.classList.remove('hidden');
  } else {
    // Su desktop: visibile solo se ci sono ≥ 2 dispositivi video
    if (STATE.videoDevices.length >= 2) {
      btnSwitch.classList.remove('hidden');
    } else {
      btnSwitch.classList.add('hidden');
    }
  }
}

// Helper: aggiorna indicatore fotocamera in #status
function updateCameraIndicator() {
  if (!statusDiv) return;

  const mobile = isMobile();
  if (mobile) {
    const facing = STATE.currentFacingMode || 'environment';
    const label = facing === 'environment' ? 'posteriore' : 'anteriore';
    statusDiv.innerText = `Fotocamera: ${label}`;
  } else {
    // Desktop: usa la label del dispositivo
    const currentDevice = STATE.videoDevices.find(d => d.deviceId === STATE.currentDeviceId);
    const label = currentDevice?.label || STATE.currentDeviceId || 'sconosciuta';
    statusDiv.innerText = `Fotocamera: ${label}`;
  }
}

// Helper: cambia fotocamera (mobile: facingMode, desktop: deviceId)
async function switchCamera() {
  const mobile = isMobile();
  const videoContainer = document.getElementById('video-container');

  // Salva lo stream corrente per ripristinarlo in caso di errore
  const previousStream = STATE.currentStream;

  // Avvia animazione feedback
  if (videoContainer) {
    videoContainer.classList.add('switching');
  }

  try {
    if (mobile) {
      // Mobile: cicla tra 'environment' e 'user'
      const current = STATE.currentFacingMode || 'environment';
      const newFacingMode = current === 'environment' ? 'user' : 'environment';
      const constraints = { facingMode: newFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } };
      await startCamera(constraints);
      STATE.currentFacingMode = newFacingMode;
      console.log(`Camera mobile switchata a: ${newFacingMode}`);
    } else {
      // Desktop: cicla attraverso i deviceId in STATE.videoDevices
      if (STATE.videoDevices.length < 2) {
        console.warn('Desktop: nessun dispositivo alternativo disponibile');
        return;
      }

      const currentId = STATE.currentDeviceId;
      const currentIndex = STATE.videoDevices.findIndex(d => d.deviceId === currentId);
      const nextIndex = (currentIndex + 1) % STATE.videoDevices.length;
      const nextDevice = STATE.videoDevices[nextIndex];

      const constraints = { deviceId: { exact: nextDevice.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } };
      await startCamera(constraints);
      STATE.currentDeviceId = nextDevice.deviceId;
      console.log(`Camera desktop switchata a: ${nextDevice.label} (${nextDevice.deviceId})`);
    }

    // Aggiorna visibilità pulsante (potrebbe cambiare se su desktop i dispositivi disponibili mutano)
    updateSwitchCameraButton();

    // Rimuovi animazione feedback dopo transizione
    if (videoContainer) {
      setTimeout(() => {
        videoContainer.classList.remove('switching');
      }, 300);
    }
  } catch (err) {
    // Ripristina lo stream precedente se disponibile
    if (previousStream) {
      video.srcObject = previousStream;
      console.warn(`Switch fallito, stream precedente ripristinato: ${err.message}`);
    }
    statusDiv.innerText = `Impossibile cambiare fotocamera: ${err.message}`;

    // Rimuovi animazione anche in caso di errore
    if (videoContainer) {
      setTimeout(() => {
        videoContainer.classList.remove('switching');
      }, 300);
    }
  }
}

// 4. Inizializzazione Modello CLIP da Hugging Face
async function initModel() {
  try {
    statusDiv.innerText = "Caricamento modello da Hugging Face (potrebbe impiegare qualche secondo)...";

    STATE.classifier = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch16');

    statusDiv.innerText = "Caricamento configurazione...";
    await loadConfig();
  } catch (err) {
    statusDiv.innerText = "Errore caricamento modello: " + err.message;
    console.error(err);
  }
}

// 4b. Caricamento configurazione dall'API
async function loadConfig() {
  try {
    const response = await fetch('api.php?action=get');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const json = await response.json();
    if (!json.ok || !json.data) {
      throw new Error('Risposta API non valida');
    }
    STATE.config = json.data;

    // Aggiorna confidenceThreshold dal config
    if (STATE.config.meta && STATE.config.meta.confidence_threshold != null) {
      STATE.confidenceThreshold = STATE.config.meta.confidence_threshold;
    }

    rebuildPromptArrays();

    statusDiv.innerText = `Modello pronto! (${STATE.prompts.length} prompt caricati). Inquadra il rifiuto.`;
    btnClassify.disabled = false;
    btnClassify.innerText = "Classifica Rifiuto";

    // Popola il select delle categorie nella modale
    populateCategorySelect();
  } catch (err) {
    statusDiv.innerText = "Errore caricamento configurazione: " + err.message;
    btnClassify.disabled = true;
    console.error('Config fetch failed:', err);
  }
}

// 4b. Ricarica prompt dopo aggiunta nuova entry (chiamabile esternamente)
async function reloadPrompts() {
  try {
    const response = await fetch('api.php?action=get');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const json = await response.json();
    if (!json.ok || !json.data) {
      throw new Error('Risposta API non valida');
    }
    STATE.config = json.data;

    // Aggiorna confidenceThreshold dal config
    if (STATE.config.meta && STATE.config.meta.confidence_threshold != null) {
      STATE.confidenceThreshold = STATE.config.meta.confidence_threshold;
    }

    rebuildPromptArrays();

    console.log(`Prompt ricaricati: ${STATE.prompts.length} prompt aggiornati`);
    statusDiv.innerText = `Prompt aggiornati (${STATE.prompts.length} prompt). Inquadra il rifiuto.`;

    // Ricontrolla visibilità bottone help dopo reload
    if (STATE.classificationState === 'nc') {
      updateHelpButtonVisibility();
    }

    // Emette evento custom per altri listener (es. UI update)
    window.dispatchEvent(new CustomEvent('promptsReloaded', { detail: { count: STATE.prompts.length } }));
  } catch (err) {
    console.error('Prompt reload failed:', err);
    statusDiv.innerText = 'Errore aggiornamento prompt: ' + err.message;
  }
}

// 4c. Ricostruzione array prompts e candidatePrompts
function rebuildPromptArrays() {
  if (!STATE.config || !STATE.config.meta || !STATE.config.categories) {
    return;
  }

  const prefix = STATE.config.meta.prompt_prefix || 'a photo of ';
  const prompts = [];

  for (const [category, catData] of Object.entries(STATE.config.categories)) {
    // Supporta nuova struttura: { bin_id, entries: [...] } e vecchia: [...]
    const entries = Array.isArray(catData) ? catData : (catData.entries || []);
    if (!Array.isArray(entries)) continue;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const promptText = prefix + entry.description;
      prompts.push({
        category: category,
        entry_id: generateEntryId(category, i),
        prompt_text: promptText
      });
    }
  }

  STATE.prompts = prompts;
  STATE.candidatePrompts = prompts.map(p => p.prompt_text);
}

// 5. Funzione di Classificazione con cattura fotogramma su Canvas
async function classifyFrame() {
  if (!STATE.classifier) return;

  try {
    // 1. Crea il canvas e disegna il fotogramma corrente della webcam
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 400;
    canvas.height = video.videoHeight || 300;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 2. Converte il canvas in un oggetto RawImage compatibile con Transformers.js
    const image = RawImage.fromCanvas(canvas);

    // 3. Passa STATE.candidatePrompts al modello CLIP
    const output = await STATE.classifier(image, STATE.candidatePrompts);

    console.log("Output CLIP:", output);

    const topMatch = output[0];
    const threshold = STATE.config?.meta?.confidence_threshold ?? STATE.confidenceThreshold;

    // 4. Decisione: RICONOSCIUTO vs NON CLASSIFICATO
    if (topMatch.score >= threshold) {
      // RICONOSCIUTO: trova il prompt corrispondente
      const matchedItem = STATE.prompts.find(p => p.prompt_text === topMatch.label);
      if (matchedItem) {
        const recognizedCategory = matchedItem.category;
        const recognizedEntryId = matchedItem.entry_id;

        console.log(`RICONOSCIUTO: ${recognizedCategory} (entry_id: ${recognizedEntryId}, score: ${(topMatch.score * 100).toFixed(1)}%)`);
        STATE.classificationState = 'recognized';
        resultDiv.classList.remove('nc');

        // Aggiorna UI
        resultDiv.innerText = recognizedCategory.toUpperCase();
        statusDiv.innerText = `Riconosciuto: ${recognizedCategory.toUpperCase()} (Confidenza: ${(topMatch.score * 100).toFixed(1)}%)`;

        // Apri il bidone corrispondente
        const targetBinId = categoryToBinId(recognizedCategory);
        if (targetBinId) {
          openBin(targetBinId);
        }

        // Incrementa hitpoint
        try {
          await fetch('api.php?action=hit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entry_id: recognizedEntryId })
          });
        } catch (hitErr) {
          console.warn('Hit failed (non-blocking):', hitErr.message);
        }
      } else {
        // Score >= threshold ma nessun prompt trovato → nc
        console.log(`NON CLASSIFICATO: score ${(topMatch.score * 100).toFixed(1)}% > threshold ${threshold * 100}% ma nessun match`);
        STATE.classificationState = 'nc';
        resultDiv.classList.add('nc');
        resultDiv.innerText = "NON CLASSIFICATO";
        statusDiv.innerText = `Non classificato (score: ${(topMatch.score * 100).toFixed(1)}%, label: ${topMatch.label})`;
      }
    } else {
      // NON CLASSIFICATO: score sotto soglia
      console.log(`NON CLASSIFICATO: score ${(topMatch.score * 100).toFixed(1)}% < threshold ${threshold * 100}%`);
      STATE.classificationState = 'nc';
      resultDiv.classList.add('nc');
      resultDiv.innerText = "NON CLASSIFICATO";
      statusDiv.innerText = `Non classificato (Confidenza: ${(topMatch.score * 100).toFixed(1)}%)`;
    }

    // Riattiva il pulsante di classificazione
    btnClassify.disabled = false;
    btnClassify.textContent = "Classifica Rifiuto";

    // Aggiorna visibilità bottone help dopo classificazione
    updateHelpButtonVisibility();

  } catch (err) {
    STATE.classificationState = 'error';
    btnClassify.disabled = false;
    btnClassify.textContent = "Classifica Rifiuto";
    resultDiv.innerText = "In attesa di scansione...";
    statusDiv.innerText = "Errore durante la classificazione: " + err.message;
    console.error(err);
    updateHelpButtonVisibility();
  }
}

// 6. Gestione apertura e chiusura temporizzata del bidone con countdown visivo
function openBin(targetBinId) {
  if (closeTimer) {
    clearInterval(closeTimer);
  }

  // Chiudi prima tutti i coperchi
  document.querySelectorAll('.bin-lid').forEach(lid => {
    lid.classList.remove('open');
    lid.classList.add('close');
  });

  // Apri il coperchio del bidone identificato
  if (targetBinId) {
    const binElement = document.getElementById(targetBinId);
    if (binElement) {
      const lid = binElement.querySelector('.bin-lid');
      if (lid) {
        lid.classList.remove('close');
        lid.classList.add('open');
      }
    }
  }

  // Gestione del countdown dinamico (5 secondi)
  let secondsLeft = 5;
  btnClassify.textContent = `Attendi ${secondsLeft} secondi...`;

  closeTimer = setInterval(() => {
    secondsLeft--;

    if (secondsLeft > 0) {
      btnClassify.textContent = `Attendi ${secondsLeft} second${secondsLeft === 1 ? 'o' : 'i'}...`;
    } else {
      clearInterval(closeTimer);

      document.querySelectorAll('.bin-lid').forEach(lid => {
        lid.classList.remove('open');
        lid.classList.add('close');
      });

      btnClassify.disabled = false;
      btnClassify.textContent = "Classifica Rifiuto";
      resultDiv.innerText = "In attesa di scansione...";
      statusDiv.innerText = "Pronto per una nuova scansione!";
      STATE.classificationState = 'waiting';
      updateHelpButtonVisibility();
    }
  }, 1000);
}

// Event Listeners e Avvio
btnClassify.addEventListener('click', async function() {
    btnClassify.disabled = true;
    btnClassify.textContent = "Analisi in corso...";
    resultDiv.innerText = "Elaborazione...";
    statusDiv.innerText = "Cattura fotogramma e analisi in corso...";
    STATE.classificationState = 'classifying';

    await new Promise(resolve => setTimeout(resolve, 20));
    classifyFrame();
});

// Bottone Aiutami a imparare
const btnHelp = document.getElementById('btn-help');
if (btnHelp) {
  btnHelp.addEventListener('click', openHelpModal);
}

// Form di aiuto umano
const helpForm = document.getElementById('help-form');
if (helpForm) {
  helpForm.addEventListener('submit', handleFormSubmit);
}

// Pulsante di chiusura modale
const modalCloseBtn = document.querySelector('#modal-help .modal-close-btn');
if (modalCloseBtn) {
  modalCloseBtn.addEventListener('click', closeHelpModal);
}

// Click sull'overlay chiude la modale
const modalOverlay = document.querySelector('#modal-help .modal-overlay');
if (modalOverlay) {
  modalOverlay.addEventListener('click', closeHelpModal);
}

// ESC key per chiudere la modale
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeHelpModal();
  }
});

// Keyboard shortcut: Ctrl+Shift+S (Windows/Linux) / Cmd+Shift+S (Mac) per cambiare fotocamera
document.addEventListener('keydown', (e) => {
  const isMac = navigator.userAgentData?.platform === 'macOS' || navigator.platform?.includes('Mac');
  const modifierPressed = isMac ? (e.metaKey && e.shiftKey && e.key === 'S') : (e.ctrlKey && e.shiftKey && e.key === 'S');

  // Ignora se non sono premuti i modifier corretti
  if (!modifierPressed) return;

  // Ignora su mobile (touch-only)
  if (isMobile()) return;

  // Ignora se un campo input è focalizzato (form di aiuto)
  const activeElement = document.activeElement;
  if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'SELECT' || activeElement.tagName === 'TEXTAREA')) {
    return;
  }

  // Previeni il comportamento default del browser (es. Ctrl+S save)
  e.preventDefault();

  // Trigger camera switch
  switchCamera();

  // Dopo lo switch, riporta il focus sul bottone
  setTimeout(() => {
    const btnSwitch = document.getElementById('btn-switch-camera');
    if (btnSwitch && !btnSwitch.classList.contains('hidden')) {
      btnSwitch.focus();
    }
  }, 350);
});

// Bottone cambia fotocamera
const btnSwitchCamera = document.getElementById('btn-switch-camera');
if (btnSwitchCamera) {
  btnSwitchCamera.addEventListener('click', switchCamera);
}

// Avvia webcam e modello
await setupWebcam();
await initModel();